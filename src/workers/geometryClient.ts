/**
 * Main-thread client of the geometry worker (./geometry.worker.ts): a lazy
 * singleton running multi-view fusion and rig skin weights off the main
 * thread, with progress, AbortSignal (the worker job is cancelled, its late
 * answer ignored) and the fusion's depth-model runs relayed to the ML worker
 * (driven from the main thread; the worker prepares the pixels).
 *
 * Callers fall back to running the same code on the main thread when
 * `getGeometryClient()` is null (no Worker: Node tests, old browsers) or a
 * call rejects with GeometryWorkerUnavailableError (the module worker could
 * not start, e.g. a browser without module-worker support).
 */
import { BufferAttribute, BufferGeometry } from 'three';
import { LocalizedError } from '../core/errors';
import { AbortError, type I18nText, type Progress } from '../core/types';
import type { FusionOptions, FusionResult, FusionViewInput } from '../core/fusion/types';
import type { SkinWeights } from '../rig/skinning';
import {
  buffersOf,
  deserializeError,
  serializeError,
  type GeometryRequest,
  type GeometryResponse,
  type SegmentPayload,
  type SkinOptionsPayload,
} from './geometryProtocol';
import type { DepthInfer, FusionDepthSpec } from './fusionDepth';

export const GEOMETRY_TEXT = {
  crashed: {
    tr: 'Arka plan hesaplaması beklenmedik biçimde durdu (bellek yetmemiş olabilir). Daha düşük bir çözünürlükle yeniden deneyin.',
    en: 'The background computation stopped unexpectedly (it may have run out of memory). Try again with a lower resolution.',
  },
  unavailable: {
    tr: 'Arka plan hesaplaması bu tarayıcıda başlatılamadı; işlem sayfada çalışacak.',
    en: 'The background computation could not start in this browser; the work runs on the page instead.',
  },
} satisfies Record<string, I18nText>;

/** The module worker could not start: run the work on the main thread instead. */
export class GeometryWorkerUnavailableError extends LocalizedError {
  constructor() {
    super(GEOMETRY_TEXT.unavailable);
    this.name = 'GeometryWorkerUnavailableError';
  }
}

/** The part of `Worker` the client uses. */
export interface GeometryWorkerLike {
  postMessage(msg: GeometryRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<GeometryResponse>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

interface Pending {
  resolve: (v: never) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  onProgress?: (p: Progress) => void;
  onRatio?: (r: number) => void;
  infer?: DepthInfer | null;
}

export interface FuseContext {
  signal: AbortSignal;
  onProgress: (p: Progress) => void;
  /** Depth refinement: the model and how to run it here (the ML worker request); null = silhouettes only. */
  depth?: { spec: FusionDepthSpec; infer: DepthInfer } | null;
}

export class GeometryWorkerClient {
  private worker: GeometryWorkerLike | null = null;
  private ready = false;
  /** The worker never started: every call rejects with GeometryWorkerUnavailableError. */
  private broken = false;
  private seq = 0;
  private keySeq = 0;
  /** Skin meshes prepared by the current worker (a replaced worker has none). */
  private readonly keys = new Set<number>();
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly factory: () => GeometryWorkerLike) {}

  /** False once the worker failed to start (callers then stay on the main thread). */
  get usable(): boolean {
    return !this.broken;
  }

  fuse(inputs: FusionViewInput[], options: Partial<FusionOptions>, ctx: FuseContext): Promise<FusionResult> {
    // Inputs are the app's images: copied (structured clone), never transferred.
    return this.request<FusionResult>(
      (id) => ({ type: 'fuse', id, inputs, options, depth: ctx.depth?.spec ?? null }),
      [],
      { signal: ctx.signal, onProgress: ctx.onProgress, infer: ctx.depth?.infer ?? null },
    );
  }

  /**
   * Weld / adjacency / BVH of a mesh in the worker, kept under the returned
   * key for skinWeigh. The arrays are copied and the copies transferred.
   */
  async skinPrepare(positions: Float32Array, index: Uint32Array, signal?: AbortSignal): Promise<number> {
    const key = ++this.keySeq;
    const p = positions.slice(), ix = index.slice();
    await this.request<number>((id) => ({ type: 'skin-prepare', id, key, positions: p, index: ix }), buffersOf(p, ix), { signal });
    this.keys.add(key);
    return key;
  }

  /** True while `key` is prepared in the running worker. */
  hasSkin(key: number): boolean {
    return this.keys.has(key);
  }

  skinWeigh(
    key: number,
    segments: SegmentPayload[],
    options: SkinOptionsPayload,
    o: { signal?: AbortSignal; onProgress?: (ratio: number) => void } = {},
  ): Promise<SkinWeights> {
    if (!this.keys.has(key)) return Promise.reject(new Error(`Skinning mesh ${key} is not prepared`));
    return this.request<SkinWeights>((id) => ({ type: 'skin-weigh', id, key, segments, options }), [], { signal: o.signal, onRatio: o.onProgress });
  }

  skinRelease(key: number): void {
    if (!this.keys.delete(key)) return;
    this.worker?.postMessage({ type: 'skin-release', key });
  }

  /** Stop the worker; running requests reject with AbortError. */
  dispose(): void {
    this.drop(() => new AbortError());
  }

  private ensureWorker(): GeometryWorkerLike {
    if (this.worker) return this.worker;
    let w: GeometryWorkerLike;
    try {
      w = this.factory();
    } catch {
      this.broken = true;
      throw new GeometryWorkerUnavailableError();
    }
    this.ready = false;
    w.onmessage = (e) => this.onMessage(e.data);
    w.onerror = (e) => {
      e.preventDefault?.();
      // Before 'ready' the script itself failed (no module workers, blocked URL): stay on the main thread.
      if (!this.ready) {
        this.broken = true;
        this.drop(() => new GeometryWorkerUnavailableError());
      } else {
        console.error('geometry worker crashed', e.message);
        this.drop(() => new LocalizedError(GEOMETRY_TEXT.crashed));
      }
    };
    this.worker = w;
    return w;
  }

  /** Terminate the worker and reject everything in flight. */
  private drop(err: () => unknown): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.keys.clear();
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) {
      if (p.onAbort) p.signal?.removeEventListener('abort', p.onAbort);
      p.reject(err());
    }
  }

  private request<T>(make: (id: number) => GeometryRequest, transfer: Transferable[], extra: Omit<Pending, 'resolve' | 'reject'>): Promise<T> {
    if (this.broken) return Promise.reject(new GeometryWorkerUnavailableError());
    if (extra.signal?.aborted) return Promise.reject(new AbortError());
    let worker: GeometryWorkerLike;
    try {
      worker = this.ensureWorker();
    } catch (e) {
      return Promise.reject(e);
    }
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { ...extra, resolve: resolve as (v: never) => void, reject };
      if (extra.signal) {
        p.onAbort = () => {
          if (!this.pending.delete(id)) return;
          this.worker?.postMessage({ type: 'cancel', id });
          reject(new AbortError());
        };
        extra.signal.addEventListener('abort', p.onAbort, { once: true });
      }
      this.pending.set(id, p);
      worker.postMessage(make(id), transfer);
    });
  }

  private settle(id: number): Pending | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    this.pending.delete(id);
    if (p.onAbort) p.signal?.removeEventListener('abort', p.onAbort);
    return p;
  }

  private onMessage(msg: GeometryResponse): void {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        return;
      case 'progress':
        this.pending.get(msg.id)?.onProgress?.(msg.progress);
        return;
      case 'skin-progress':
        this.pending.get(msg.id)?.onRatio?.(msg.ratio);
        return;
      case 'infer':
        this.relayInfer(msg.id, msg.req, msg.job);
        return;
      case 'fused': {
        const p = this.settle(msg.id);
        if (!p) return;
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(msg.geometry.position, 3));
        g.setAttribute('normal', new BufferAttribute(msg.geometry.normal, 3));
        g.setAttribute('color', new BufferAttribute(msg.geometry.color, 3));
        g.setIndex(new BufferAttribute(msg.geometry.index, 1));
        g.computeBoundingSphere();
        g.userData.multiview = msg.info;
        g.userData.fusion = msg.info.report;
        (p.resolve as (v: FusionResult) => void)({ geometry: g, info: msg.info });
        return;
      }
      case 'skin-prepared':
        (this.settle(msg.id)?.resolve as ((v: number) => void) | undefined)?.(msg.key);
        return;
      case 'skin-weights':
        (this.settle(msg.id)?.resolve as ((v: SkinWeights) => void) | undefined)?.(msg.weights);
        return;
      case 'error':
        this.settle(msg.id)?.reject(deserializeError(msg.error, { AbortError: () => new AbortError() }));
        return;
    }
  }

  /** Run the model for the worker's fusion job and pass the raw output back (transferred). */
  private relayInfer(id: number, req: number, job: Extract<GeometryResponse, { type: 'infer' }>['job']): void {
    const p = this.pending.get(id);
    const post = (m: GeometryRequest, t: Transferable[] = []) => {
      if (this.pending.has(id)) this.worker?.postMessage(m, t);
    };
    if (!p?.infer || !p.signal) {
      post({ type: 'infer-error', id, req, error: serializeError(new Error('No depth model')) });
      return;
    }
    p.infer(job, { signal: p.signal, onProgress: (progress) => post({ type: 'infer-progress', id, req, progress }) }).then(
      (raw) => {
        const data = raw.data instanceof Float32Array ? raw.data : Float32Array.from(raw.data);
        post({ type: 'infer-result', id, req, raw: { data, dims: [...raw.dims] } }, buffersOf(data));
      },
      (e: unknown) => post({ type: 'infer-error', id, req, error: serializeError(e) }),
    );
  }
}

/** Module workers exist here (not in Node / very old browsers). */
export function geometryWorkerSupported(): boolean {
  if (typeof Worker === 'undefined') return false;
  // Diagnostics / kill switch: `window.__3dmarkerGeometryWorker = false` keeps the work on the main thread.
  if ((globalThis as { __3dmarkerGeometryWorker?: boolean }).__3dmarkerGeometryWorker === false) return false;
  return true;
}

let client: GeometryWorkerClient | null = null;

/** Lazy singleton (the worker starts on the first request); null = run on the main thread. */
export function getGeometryClient(): GeometryWorkerClient | null {
  if (!geometryWorkerSupported()) return null;
  client ??= new GeometryWorkerClient(
    () => new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' }) as unknown as GeometryWorkerLike,
  );
  return client.usable ? client : null;
}
