/**
 * Library-agnostic core of the ML worker: pipeline cache, device/dtype
 * selection with fallbacks, and a serial job queue. transformers.js is
 * injected (see ml.worker.ts) so this logic is unit-testable in Node.
 */
import type { MlDevice, MlDevicePref, MlPrecision, MlProgress, MlTask } from './mlProtocol';
import { DownloadProgressTracker, type LoadProgressEvent } from '../drivers/ml/postprocess';

export interface GpuInfo {
  available: boolean;
  /** Adapter supports 'shader-f16' (required for fp16 models on WebGPU). */
  fp16: boolean;
}

export interface LoadRequest {
  task: MlTask;
  model: string;
  device: MlDevice;
  dtype: string;
  onLoadProgress: (e: LoadProgressEvent) => void;
}

export interface EngineDeps<P> {
  load(req: LoadRequest): Promise<P>;
  dispose(pipe: P): Promise<unknown> | void;
  detectGpu(): Promise<GpuInfo>;
  /** Max pipelines kept in memory (LRU). Default 2. */
  maxCached?: number;
}

export interface RunSpec {
  task: MlTask;
  model: string;
  device: MlDevicePref;
  precision: MlPrecision;
}

/**
 * dtype candidates in order of preference. transformers.js maps them to ONNX
 * file suffixes (utils/dtypes.js): fp32 → model.onnx, fp16 → model_fp16.onnx,
 * q8 → model_quantized.onnx. A later candidate is tried when a file is missing.
 */
export function dtypeCandidates(device: MlDevice, precision: MlPrecision, gpuFp16: boolean): string[] {
  if (precision === 'fp32') return ['fp32'];
  if (device === 'webgpu') return gpuFp16 ? ['fp16', 'fp32'] : ['fp32'];
  return ['q8', 'fp32'];
}

/** A missing ONNX weight file for the requested dtype (transformers.js throws ModelFileNotFoundError on 401/403/404). */
export function isMissingWeightsError(e: unknown): boolean {
  return e instanceof Error && e.name === 'ModelFileNotFoundError' && /\.onnx/.test(e.message);
}

export class MlEngine<P> {
  private cache = new Map<string, P>();
  /** (task, model, device, precision) → cache key of the dtype that loaded. */
  private resolved = new Map<string, string>();
  /** Models whose WebGPU path failed while WASM worked; they go straight to WASM. */
  private webgpuBroken = new Set<string>();
  private gpu: Promise<GpuInfo> | null = null;

  constructor(private deps: EngineDeps<P>) {}

  /**
   * Run `fn` with a (cached) pipeline. Tries WebGPU first when allowed and
   * available, and retries once on WASM if WebGPU loading/inference throws.
   */
  async run<R>(
    spec: RunSpec,
    emit: (p: MlProgress) => void,
    fn: (pipe: P, device: MlDevice) => Promise<R>,
  ): Promise<{ result: R; device: MlDevice; dtype: string }> {
    this.gpu ??= this.deps.detectGpu().catch(() => ({ available: false, fp16: false }));
    const gpu = await this.gpu;
    const useGpu = spec.device === 'auto' && gpu.available && !this.webgpuBroken.has(spec.model);
    const devices: MlDevice[] = useGpu ? ['webgpu', 'wasm'] : ['wasm'];
    let webgpuFailed = false;
    for (const device of devices) {
      try {
        const { pipe, dtype } = await this.acquire(spec, device, gpu.fp16, emit);
        emit({ stage: 'inference', device });
        const result = await fn(pipe, device);
        // Only blame WebGPU if WASM worked (a network error would fail both).
        if (webgpuFailed) this.webgpuBroken.add(spec.model);
        return { result, device, dtype };
      } catch (e) {
        if (device === 'wasm') throw e;
        console.warn(`[ml] WebGPU failed for ${spec.model}, retrying on WASM:`, e);
        webgpuFailed = true;
        await this.drop(`${spec.task}|${spec.model}|webgpu|`);
      }
    }
    throw new Error('unreachable: the WASM attempt either returns or throws');
  }

  private async acquire(
    spec: RunSpec,
    device: MlDevice,
    gpuFp16: boolean,
    emit: (p: MlProgress) => void,
  ): Promise<{ pipe: P; dtype: string }> {
    const resolvedKey = `${spec.task}|${spec.model}|${device}|${spec.precision}`;
    const known = this.resolved.get(resolvedKey);
    if (known) {
      const pipe = this.touch(known);
      if (pipe) return { pipe, dtype: known.split('|')[3] };
    }
    const candidates = dtypeCandidates(device, spec.precision, gpuFp16);
    for (let i = 0; i < candidates.length; i++) {
      const dtype = candidates[i];
      const key = `${spec.task}|${spec.model}|${device}|${dtype}`;
      const hit = this.touch(key);
      if (hit) {
        this.resolved.set(resolvedKey, key);
        return { pipe: hit, dtype };
      }
      await this.evict(this.maxCached() - 1);
      emit({ stage: 'load', device });
      const tracker = new DownloadProgressTracker();
      try {
        const pipe = await this.deps.load({
          task: spec.task,
          model: spec.model,
          device,
          dtype,
          onLoadProgress: (ev) => {
            const s = tracker.update(ev);
            if (!s) return;
            if (s.ratio !== undefined && s.ratio >= 1) emit({ stage: 'load', device });
            else emit({ stage: 'download', ratio: s.ratio, loadedBytes: s.loadedBytes, totalBytes: s.totalBytes, device });
          },
        });
        this.cache.set(key, pipe);
        this.resolved.set(resolvedKey, key);
        return { pipe, dtype };
      } catch (e) {
        if (isMissingWeightsError(e) && i < candidates.length - 1) continue;
        throw e;
      }
    }
    throw new Error('No dtype candidates'); // unreachable: candidates is never empty
  }

  private maxCached(): number {
    return Math.max(1, this.deps.maxCached ?? 2);
  }

  /** LRU lookup: move a hit to the most-recent position. */
  private touch(key: string): P | undefined {
    const pipe = this.cache.get(key);
    if (pipe !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, pipe);
    }
    return pipe;
  }

  /** Dispose least-recently-used pipelines until at most `keep` remain. */
  private async evict(keep: number): Promise<void> {
    while (this.cache.size > keep) await this.remove(this.cache.keys().next().value as string);
  }

  /** Dispose every cached pipeline whose key starts with `prefix`. */
  private async drop(prefix: string): Promise<void> {
    for (const key of [...this.cache.keys()]) if (key.startsWith(prefix)) await this.remove(key);
  }

  private async remove(key: string): Promise<void> {
    const pipe = this.cache.get(key);
    if (pipe === undefined) return;
    this.cache.delete(key);
    for (const [k, v] of this.resolved) if (v === key) this.resolved.delete(k);
    try {
      await this.deps.dispose(pipe);
    } catch (e) {
      console.warn('[ml] dispose failed:', e);
    }
  }

  /** Release every cached pipeline (frees WASM/GPU memory). */
  async disposeAll(): Promise<void> {
    await this.evict(0);
  }

  /** Number of cached pipelines (for tests / diagnostics). */
  get cachedCount(): number {
    return this.cache.size;
  }
}

/**
 * Runs jobs one at a time (ONNX Runtime Web serialises sessions anyway, and
 * the depth job mutates the shared image processor). Jobs cancelled while
 * still queued are skipped; a running job cannot be interrupted.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private queued = new Set<number>();
  private cancelled = new Set<number>();

  /** Resolves with the job's result, or `undefined` if it was cancelled before starting (id null = not cancellable). */
  run<T>(id: number | null, job: () => Promise<T>): Promise<T | undefined> {
    if (id !== null) this.queued.add(id);
    const next = this.tail.then(async () => {
      if (id !== null) {
        this.queued.delete(id);
        if (this.cancelled.delete(id)) return undefined;
      }
      return job();
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  cancel(id: number): void {
    if (this.queued.has(id)) this.cancelled.add(id);
  }
}
