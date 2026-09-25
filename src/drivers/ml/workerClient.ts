/**
 * Main-thread client for the ML worker (src/workers/ml.worker.ts): a lazy
 * singleton worker, promise-based requests with progress callbacks and
 * AbortSignal support. The client class takes a worker factory so its logic
 * can be unit-tested with a fake worker.
 */
import { AbortError } from '../../core/types';
import { localizeMlError } from './errors';
import {
  deserializeError,
  type AlphaPayload,
  type BackgroundRemovalJob,
  type DepthJob,
  type DepthPayload,
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
  stage?: MlStage;
}

export class MlWorkerClient {
  private worker: WorkerLike | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(
    private readonly factory: () => WorkerLike,
    private config: MlEnvConfig = {},
  ) {}

  /**
   * Send a job. The image buffer is transferred (the caller's array is
   * detached), so pass a freshly allocated image.
   * Rejects with AbortError when `signal` aborts; the worker may finish the
   * job anyway and its result is ignored.
   */
  run(job: MlJobInput, { signal, onProgress }: MlRequestOptions = {}): Promise<MlResult> {
    if (signal?.aborted) return Promise.reject(new AbortError());
    let worker: WorkerLike;
    try {
      worker = this.ensureWorker();
    } catch (e) {
      return Promise.reject(e);
    }
    const id = this.nextId++;
    return new Promise<MlResult>((resolve, reject) => {
      const onAbort = () => this.abort(id);
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      this.pending.set(id, {
        resolve: (r) => { cleanup(); resolve(r); },
        reject: (e) => { cleanup(); reject(e); },
        onProgress,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const data = job.image.data;
        const whole = data.buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength;
        const pixels = whole ? data : data.slice();
        worker.postMessage({ ...job, id, image: { ...job.image, data: pixels } } as MlJob, [pixels.buffer as ArrayBuffer]);
      } catch (e) {
        const p = this.pending.get(id);
        this.pending.delete(id);
        p?.reject(e);
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

  /** Kill the worker; pending requests reject with AbortError. */
  terminate(): void {
    this.failAll(new AbortError());
    this.reset();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const w = this.factory();
    w.onmessage = (e) => this.onMessage(e.data);
    w.onerror = (e) => {
      e.preventDefault?.();
      this.failAll(new Error(`ML worker error: ${e.message || 'failed to start'}`));
      this.reset();
    };
    if (Object.keys(this.config).length > 0) w.postMessage({ type: 'configure', config: this.config });
    this.worker = w;
    return w;
  }

  private onMessage(msg: MlResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return; // aborted, or from a terminated generation
    if (msg.type === 'progress') {
      p.stage = msg.stage;
      p.onProgress?.(msg);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.type === 'result') p.resolve(msg.result);
    else p.reject(deserializeError(msg.error));
  }

  private abort(id: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.reject(new AbortError());
    if (p.stage === 'download' && this.pending.size === 0) {
      // Nobody else is waiting: kill the worker to stop the download
      // (transformers.js caches files only once fully read).
      this.reset();
    } else {
      this.worker?.postMessage({ type: 'cancel', id });
    }
  }

  private failAll(err: unknown): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(err);
  }

  private reset(): void {
    const w = this.worker;
    this.worker = null;
    if (w) {
      w.onmessage = null;
      w.onerror = null;
      w.terminate();
    }
  }
}

/** transformers.js env overrides from Vite env vars (VITE_MODEL_HOST, VITE_ORT_WASM_PREFIX). */
export function mlEnvConfigFrom(vars: Record<string, unknown>): MlEnvConfig {
  const str = (k: string) => (typeof vars[k] === 'string' && vars[k] ? (vars[k] as string) : undefined);
  const config: MlEnvConfig = {};
  const host = str('VITE_MODEL_HOST');
  const wasm = str('VITE_ORT_WASM_PREFIX');
  if (host) config.remoteHost = host;
  if (wasm) config.wasmPrefix = wasm;
  return config;
}

/** Workers + WebAssembly are required by every ML driver. */
export function isMlSupported(): boolean {
  return typeof Worker !== 'undefined' && typeof WebAssembly === 'object';
}

let client: MlWorkerClient | null = null;

/** Lazy singleton; the worker starts on the first request. */
export function getMlClient(): MlWorkerClient {
  client ??= new MlWorkerClient(
    () => new Worker(new URL('../../workers/ml.worker.ts', import.meta.url), { type: 'module' }),
    mlEnvConfigFrom(import.meta.env ?? {}),
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
