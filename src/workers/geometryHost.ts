/**
 * Worker side of the geometry protocol (./geometryProtocol.ts), independent of
 * the worker global so tests can drive it directly: multi-view fusion
 * (reconstructFromViews, its depth requests answered by the main thread) and
 * rig skin weights on meshes prepared once and cached by key (joint edits
 * re-weigh without re-sending or re-welding the mesh).
 */
import { Vector3 } from 'three';
import { AbortError } from '../core/types';
import { DepthOfflineError, reconstructFromViews } from '../core/fusion';
import type { RawDepth } from '../drivers/ml/postprocess';
import { computeSkinWeights, prepareSkinning, type SkinPrep } from '../rig/skinning';
import type { BoneSegment } from '../rig/skeleton';
import {
  buffersOf,
  deserializeError,
  serializeError,
  type GeometryRequest,
  type GeometryResponse,
  type SegmentPayload,
} from './geometryProtocol';
import { createFusionDepthEstimator, type DepthInfer } from './fusionDepth';
import type { MlProgress } from './mlProtocol';

export type Post = (msg: GeometryResponse, transfer?: Transferable[]) => void;

interface InferWait {
  resolve: (d: RawDepth) => void;
  reject: (e: unknown) => void;
  onProgress: (p: MlProgress) => void;
}

/** Errors the fusion tells apart by class (DepthOfflineError is rebuilt here too, should a relay ever send one). */
const ERROR_CLASSES = {
  DepthOfflineError: () => new DepthOfflineError(),
  AbortError: () => new AbortError(),
};

const toSegments = (s: SegmentPayload[]): BoneSegment[] =>
  s.map((x) => ({ bone: x.bone, index: x.index, head: new Vector3(x.head.x, x.head.y, x.head.z), tail: new Vector3(x.tail.x, x.tail.y, x.tail.z) }));

export class GeometryHost {
  private readonly jobs = new Map<number, AbortController>();
  private readonly inferWaits = new Map<string, InferWait>();
  private readonly preps = new Map<number, SkinPrep>();
  private inferSeq = 0;

  constructor(private readonly post: Post) {}

  handle(msg: GeometryRequest): void {
    switch (msg.type) {
      case 'fuse':
      case 'skin-prepare':
      case 'skin-weigh': {
        const ac = new AbortController();
        this.jobs.set(msg.id, ac);
        void this.run(msg, ac.signal).finally(() => this.jobs.delete(msg.id));
        return;
      }
      case 'cancel':
        this.jobs.get(msg.id)?.abort();
        return;
      case 'skin-release':
        this.preps.delete(msg.key);
        return;
      case 'infer-result':
      case 'infer-error':
      case 'infer-progress': {
        const k = `${msg.id}:${msg.req}`;
        const w = this.inferWaits.get(k);
        if (!w) return;
        if (msg.type === 'infer-progress') return w.onProgress(msg.progress);
        this.inferWaits.delete(k);
        if (msg.type === 'infer-result') w.resolve(msg.raw);
        else w.reject(deserializeError(msg.error, ERROR_CLASSES));
        return;
      }
    }
  }

  /** Jobs in flight (tests). */
  get busy(): number {
    return this.jobs.size;
  }

  private async run(msg: Extract<GeometryRequest, { id: number; type: 'fuse' | 'skin-prepare' | 'skin-weigh' }>, signal: AbortSignal): Promise<void> {
    try {
      if (msg.type === 'fuse') {
        const { geometry, info } = await reconstructFromViews(msg.inputs, msg.options, {
          signal,
          onProgress: (progress) => this.post({ type: 'progress', id: msg.id, progress }),
          estimateDepth: msg.depth ? createFusionDepthEstimator(msg.depth, this.inferProxy(msg.id)) : null,
        });
        const attr = (name: string) => geometry.getAttribute(name).array as Float32Array;
        const payload = {
          position: attr('position'),
          normal: attr('normal'),
          color: attr('color'),
          index: geometry.getIndex()!.array as Uint32Array,
        };
        if (signal.aborted) return;
        this.post({ type: 'fused', id: msg.id, geometry: payload, info }, buffersOf(payload.position, payload.normal, payload.color, payload.index));
      } else if (msg.type === 'skin-prepare') {
        this.preps.set(msg.key, prepareSkinning(msg.positions, msg.index));
        this.post({ type: 'skin-prepared', id: msg.id, key: msg.key });
      } else {
        const prep = this.preps.get(msg.key);
        if (!prep) throw new Error(`Unknown skinning mesh ${msg.key}`);
        const weights = await computeSkinWeights(prep, toSegments(msg.segments), {
          ...msg.options,
          signal,
          onProgress: (ratio) => this.post({ type: 'skin-progress', id: msg.id, ratio }),
        });
        if (signal.aborted) return;
        this.post({ type: 'skin-weights', id: msg.id, weights }, buffersOf(weights.skinIndex, weights.skinWeight));
      }
    } catch (e) {
      // A cancelled job's client has already given up.
      if (!signal.aborted) this.post({ type: 'error', id: msg.id, error: serializeError(e) });
    }
  }

  /** Model runs by the main thread (it drives the ML worker): ask with the prepared image, wait for the raw output. */
  private inferProxy(id: number): DepthInfer {
    return (job, o) =>
      new Promise<RawDepth>((resolve, reject) => {
        if (o.signal.aborted) return reject(new AbortError());
        const req = ++this.inferSeq;
        const key = `${id}:${req}`;
        const onAbort = () => {
          this.inferWaits.delete(key);
          reject(new AbortError());
        };
        o.signal.addEventListener('abort', onAbort, { once: true });
        const done = <T>(f: (v: T) => void) => (v: T) => {
          o.signal.removeEventListener('abort', onAbort);
          f(v);
        };
        this.inferWaits.set(key, { resolve: done(resolve), reject: done(reject), onProgress: o.onProgress });
        this.post({ type: 'infer', id, req, job }, buffersOf(job.image.data));
      });
  }
}
