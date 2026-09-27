/**
 * Main-thread client for the ML worker (src/workers/ml.worker.ts): a lazy
 * singleton worker, promise-based requests with progress callbacks and
 * AbortSignal support. The client class takes a worker factory so its logic
 * can be unit-tested with a fake worker.
 *
 * transformers.js queues every ONNX Runtime session create/run on
 * module-level promise chains without error handling, and ORT caches a failed
 * backend/wasm init: after one ORT failure every later job in that worker
 * fails the same way. So a worker that reported an error is replaced, and a
 * WebGPU failure is retried on WASM in a fresh worker.
 *
 * Model downloads have a stall timeout inside the worker (mlTasks.ts); as a
 * backstop the client also gives up on a job that stays silent in its
 * load/download stage, and remembers stalled models for a few minutes so
 * repeat runs (e.g. the fusion's depth pass) fail fast instead of waiting again.
 */
import { AbortError } from '../../core/types';
import { localizeMlError } from './errors';
import {
  DEFAULT_STALL_TIMEOUT_MS,
  deserializeError,
  MODEL_STALLED_ERROR,
  WEBGPU_FAILED_ERROR,
  type AlphaPayload,
  type BackgroundRemovalJob,
  type DepthJob,
  type DepthPayload,
  type MlDevice,
  type MlEnvConfig,
  type MlJob,
  type MlProgress,
  type MlRequest,
  type MlResponse,
  type MlResult,
  type MlStage,
} from '../../workers/mlProtocol';

/** The part of `Worker` the client uses. */
export interface WorkerLike {
  postMessage(msg: MlRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<MlResponse>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
export type MlJobInput = WithoutId<MlJob>;

export interface MlRequestOptions {
  signal?: AbortSignal;
  onProgress?: (p: MlProgress) => void;
}

interface Pending {
  resolve: (r: MlResult) => void;
  reject: (e: unknown) => void;
  onProgress?: (p: MlProgress) => void;
  /** The worker running the request. */
  worker: WorkerLike;
  model: string;
  /** Backstop timer while the job is in its load/download stage. */
  watchdog?: ReturnType<typeof setTimeout>;
  stage?: MlStage;
  device?: MlDevice;
  /** device 'auto' jobs: the same job on WASM with its own copy of the pixels (the posted ones are transferred). */
  wasmRetry?: MlJob;
  /** Model id, set while the job re-runs on WASM after WebGPU failed. */
  wasmFallback?: string;
}

/** How long a stalled model is failed fast (like the MediaPipe loader's failure memory). */
export const STALL_MEMORY_MS = 5 * 60_000;

function stalledError(model: string, detail: string): Error {
  const err = new Error(`${detail} (${model})`);
  err.name = MODEL_STALLED_ERROR;
  return err;
}

export class MlWorkerClient {
  private worker: WorkerLike | null = null;
  /** Replaced workers that still have requests in flight; terminated once those settle. */
  private retired = new Set<WorkerLike>();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  /** Models whose WebGPU path failed while WASM worked: later 'auto' jobs go straight to WASM. */
  private wasmOnly = new Set<string>();
  /** Model → Date.now() of its last stalled download. */
  private stalledAt = new Map<string, number>();

  constructor(
    private readonly factory: () => WorkerLike,
    private config: MlEnvConfig = {},
  ) {}

  /**
   * Send a job. The image buffer is transferred (the caller's array is
   * detached), so pass a freshly allocated image.
   * Rejects with AbortError when `signal` aborts; the worker may finish the
   * job anyway and its result is ignored. A job whose WebGPU attempt fails is
   * retried on WASM in a fresh worker.
   */
  run(input: MlJobInput, { signal, onProgress }: MlRequestOptions = {}): Promise<MlResult> {
    if (signal?.aborted) return Promise.reject(new AbortError());
    const stalled = this.stalledAt.get(input.model);
    if (stalled !== undefined) {
      if (Date.now() - stalled < STALL_MEMORY_MS) {
        return Promise.reject(stalledError(input.model, 'The download stopped responding moments ago'));
      }
      this.stalledAt.delete(input.model);
    }
    const job: MlJobInput = input.device === 'auto' && this.wasmOnly.has(input.model) ? { ...input, device: 'wasm' } : input;
    let worker: WorkerLike;
    try {
      worker = this.ensureWorker();
    } catch (e) {
      return Promise.reject(e);
    }
    const id = this.nextId++;
    return new Promise<MlResult>((resolve, reject) => {
      const onAbort = () => this.abort(id);
      const cleanup = () => {
        clearTimeout(p.watchdog);
        signal?.removeEventListener('abort', onAbort);
      };
      const p: Pending = {
        resolve: (r) => { cleanup(); resolve(r); },
        reject: (e) => { cleanup(); reject(e); },
        onProgress,
        worker,
        model: job.model,
      };
      this.pending.set(id, p);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const data = job.image.data;
        const whole = data.buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength;
        const pixels = whole ? data : data.slice();
        const msg = { ...job, id, image: { ...job.image, data: pixels } } as MlJob;
        if (job.device === 'auto') p.wasmRetry = { ...msg, device: 'wasm', image: { ...job.image, data: data.slice() } } as MlJob;
        worker.postMessage(msg, [pixels.buffer as ArrayBuffer]);
      } catch (e) {
        this.pending.delete(id);
        p.reject(e);
      }
    });
  }

  /** Merge transformers.js env overrides (applied now and whenever the worker is recreated). */
  configure(config: MlEnvConfig): void {
    this.config = { ...this.config, ...config };
    this.worker?.postMessage({ type: 'configure', config: this.config });
  }

  /** Free cached pipelines (GPU/WASM memory) but keep the worker alive. */
  release(): void {
    this.worker?.postMessage({ type: 'dispose' });
  }

  /** Kill the workers; pending requests reject with AbortError. */
  terminate(): void {
    this.fail(new AbortError());
    for (const w of [...this.retired]) this.kill(w);
    if (this.worker) this.kill(this.worker);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const w = this.factory();
    w.onmessage = (e) => this.onMessage(w, e.data);
    w.onerror = (e) => {
      e.preventDefault?.();
      this.kill(w);
      this.fail(new Error(`ML worker error: ${e.message || 'failed to start'}`), w);
    };
    if (Object.keys(this.config).length > 0) w.postMessage({ type: 'configure', config: this.config });
    this.worker = w;
    return w;
  }

  private onMessage(w: WorkerLike, msg: MlResponse): void {
    const found = this.pending.get(msg.id);
    const p = found?.worker === w ? found : undefined; // else aborted, or from a replaced worker
    if (msg.type === 'progress') {
      if (p) {
        p.stage = msg.stage;
        if (msg.device) p.device = msg.device;
        this.armWatchdog(msg.id, p);
        if (msg.device === 'wasm') p.wasmRetry = undefined; // past WebGPU: free the pixel copy
        p.onProgress?.(msg);
      }
      return;
    }
    // Any failure may have poisoned ORT in this worker (see the header), even
    // for an aborted job. Missing weight files are reported before ORT runs.
    if (msg.type === 'error' && msg.error.name !== 'ModelFileNotFoundError') this.retire(w);
    if (p) {
      if (msg.type === 'error' && msg.error.name === WEBGPU_FAILED_ERROR && p.wasmRetry) {
        this.retryOnWasm(msg.id, p);
      } else {
        this.pending.delete(msg.id);
        if (msg.type === 'result') {
          // Only blame WebGPU once WASM worked (a network error fails both).
          if (p.wasmFallback) this.wasmOnly.add(p.wasmFallback);
          p.resolve(msg.result);
        } else {
          if (msg.error.name === MODEL_STALLED_ERROR) this.stalledAt.set(p.model, Date.now());
          p.reject(deserializeError(msg.error));
        }
      }
    }
    this.reap(w);
  }

  /**
   * Silence in the load/download stage for twice the worker's stall timeout
   * (it misses stalls outside env.fetch, e.g. a hung ORT runtime import): kill
   * the worker and fail its jobs. Inference can legitimately be long and silent.
   */
  private armWatchdog(id: number, p: Pending): void {
    clearTimeout(p.watchdog);
    p.watchdog = undefined;
    const stallMs = this.config.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    if (!(stallMs > 0) || (p.stage !== 'load' && p.stage !== 'download')) return;
    p.watchdog = setTimeout(() => {
      if (this.pending.get(id) !== p) return;
      this.stalledAt.set(p.model, Date.now());
      const w = p.worker;
      this.kill(w);
      this.fail(stalledError(p.model, `The ML worker sent nothing for ${Math.round((2 * stallMs) / 1000)} s while loading the model`), w);
    }, 2 * stallMs);
  }

  /** Re-run a job whose WebGPU attempt failed on WASM in a fresh worker (same id, callbacks and abort handling). */
  private retryOnWasm(id: number, p: Pending): void {
    const job = p.wasmRetry!;
    p.wasmRetry = undefined;
    p.wasmFallback = job.model;
    p.stage = undefined;
    p.device = undefined;
    clearTimeout(p.watchdog);
    p.watchdog = undefined;
    try {
      p.worker = this.ensureWorker();
      p.worker.postMessage(job, [job.image.data.buffer as ArrayBuffer]);
    } catch (e) {
      this.pending.delete(id);
      p.reject(e);
    }
  }

  private abort(id: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.reject(new AbortError());
    // Neither a download nor WASM inference (synchronous on the worker thread)
    // can be interrupted, and the next job would silently queue behind it. If
    // nobody else is waiting, kill the worker. By the inference stage every
    // weight file is in the Cache API, so a new worker only re-creates the ORT
    // session. Not on 'load': it is also emitted while the last downloaded file
    // may still be written to the cache. WebGPU inference is fast: keep its
    // warm pipelines and let the worker drop the result.
    const killable = p.stage === 'download' || (p.stage === 'inference' && p.device === 'wasm');
    if (!this.busy(p.worker) && (killable || this.retired.has(p.worker))) this.kill(p.worker);
    else p.worker.postMessage({ type: 'cancel', id });
  }

  /** Reject pending requests (only those running on `w`, if given). */
  private fail(err: unknown, w?: WorkerLike): void {
    for (const [id, p] of [...this.pending]) {
      if (w && p.worker !== w) continue;
      this.pending.delete(id);
      p.reject(err);
    }
  }

  private busy(w: WorkerLike): boolean {
    for (const p of this.pending.values()) if (p.worker === w) return true;
    return false;
  }

  /** New requests go to a fresh worker; `w` is terminated once its in-flight requests settle. */
  private retire(w: WorkerLike): void {
    if (w !== this.worker) return;
    this.worker = null;
    this.retired.add(w);
  }

  private reap(w: WorkerLike): void {
    if (this.retired.has(w) && !this.busy(w)) this.kill(w);
  }

  private kill(w: WorkerLike): void {
    if (w === this.worker) this.worker = null;
    this.retired.delete(w);
    w.onmessage = null;
    w.onerror = null;
    w.terminate();
  }
}

/** transformers.js env overrides from Vite env vars (VITE_MODEL_HOST, VITE_ORT_WASM_PREFIX, VITE_MODEL_STALL_MS). */
export function mlEnvConfigFrom(vars: Record<string, unknown>): MlEnvConfig {
  const str = (k: string) => (typeof vars[k] === 'string' && vars[k] ? (vars[k] as string) : undefined);
  const config: MlEnvConfig = {};
  const host = str('VITE_MODEL_HOST');
  const wasm = str('VITE_ORT_WASM_PREFIX');
  if (host) config.remoteHost = host;
  if (wasm) config.wasmPrefix = wasm;
  const stall = Number(str('VITE_MODEL_STALL_MS'));
  if (Number.isFinite(stall) && stall >= 0 && str('VITE_MODEL_STALL_MS')) config.stallTimeoutMs = stall;
  return config;
}

/** Workers + WebAssembly are required by every ML driver. */
export function isMlSupported(): boolean {
  return typeof Worker !== 'undefined' && typeof WebAssembly === 'object';
}

let client: MlWorkerClient | null = null;

/** Lazy singleton; the worker starts on the first request. */
export function getMlClient(): MlWorkerClient {
  // Dev builds: tests may preset overrides (e.g. a short stall timeout) on window.__3dmarkerMlConfig.
  const dev = import.meta.env?.DEV ? (globalThis as { __3dmarkerMlConfig?: MlEnvConfig }).__3dmarkerMlConfig : undefined;
  client ??= new MlWorkerClient(
    () => new Worker(new URL('../../workers/ml.worker.ts', import.meta.url), { type: 'module' }),
    { ...mlEnvConfigFrom(import.meta.env ?? {}), ...dev },
  );
  return client;
}

export async function requestDepth(job: Omit<DepthJob, 'id' | 'type'>, opts: MlRequestOptions): Promise<DepthPayload> {
  const r = await getMlClient()
    .run({ ...job, type: 'depth' }, opts)
    .catch((e: unknown) => Promise.reject(localizeMlError(e, job.model)));
  if (r.kind !== 'depth') throw new Error(`Unexpected ML result kind '${r.kind}'`);
  return r;
}

export async function requestForegroundAlpha(
  job: Omit<BackgroundRemovalJob, 'id' | 'type'>,
  opts: MlRequestOptions,
): Promise<AlphaPayload> {
  const r = await getMlClient()
    .run({ ...job, type: 'background-removal' }, opts)
    .catch((e: unknown) => Promise.reject(localizeMlError(e, job.model)));
  if (r.kind !== 'alpha') throw new Error(`Unexpected ML result kind '${r.kind}'`);
  return r;
}
