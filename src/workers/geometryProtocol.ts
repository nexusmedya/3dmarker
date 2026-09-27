/**
 * Message protocol between the main thread (./geometryClient.ts) and the
 * geometry worker (./geometry.worker.ts, logic in ./geometryHost.ts): the
 * multi-view fusion (src/core/fusion) and rig skin weights
 * (src/rig/skinning.ts) run there so the page stays responsive.
 *
 * Big arrays travel as transferred buffers: the result's geometry, the skin
 * weights and the mesh sent for skinning (copies the caller owns). Errors
 * cross the boundary with their name and bilingual text (LocalizedError.i18n).
 */
import { LocalizedError } from '../core/errors';
import type { I18nText, Progress } from '../core/types';
import type { FusionInfo, FusionOptions, FusionViewInput } from '../core/fusion/types';
import type { SkinningOptions, SkinWeights } from '../rig/skinning';
import type { HumanoidBone } from '../rig/types';
import type { FusionDepthSpec, InferJob } from './fusionDepth';
import type { MlProgress } from './mlProtocol';

/** Error on the wire: name + message, and the bilingual text when it had one. */
export interface SerializedError {
  name: string;
  message: string;
  i18n?: I18nText;
  stack?: string;
}

/** Plain bone segment (BoneSegment without three's Vector3). */
export interface SegmentPayload {
  bone: HumanoidBone;
  index: number;
  head: { x: number; y: number; z: number };
  tail: { x: number; y: number; z: number };
}

/** Skinning options that cross the boundary (the signal / progress callback are the message's own). */
export type SkinOptionsPayload = Partial<Omit<SkinningOptions, 'signal' | 'onProgress'>>;

/** Fused geometry as flat arrays (indexed, linear RGB colours). */
export interface GeometryPayload {
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  index: Uint32Array;
}

// ---- main → worker ---------------------------------------------------------

export interface FuseRequest {
  type: 'fuse';
  id: number;
  inputs: FusionViewInput[];
  options: Partial<FusionOptions>;
  /**
   * Depth refinement model, null = silhouettes only. The worker prepares each
   * crop and post-processes the output; the model runs via 'infer' requests
   * the main thread relays to the ML worker.
   */
  depth: FusionDepthSpec | null;
}

export interface SkinPrepareRequest {
  type: 'skin-prepare';
  id: number;
  /** Cache key of the prepared mesh (welding, adjacency, BVH) for later 'skin-weigh' requests. */
  key: number;
  positions: Float32Array;
  index: Uint32Array;
}

export interface SkinWeighRequest {
  type: 'skin-weigh';
  id: number;
  key: number;
  segments: SegmentPayload[];
  options: SkinOptionsPayload;
}

export type GeometryRequest =
  | FuseRequest
  | SkinPrepareRequest
  | SkinWeighRequest
  | { type: 'skin-release'; key: number }
  | { type: 'cancel'; id: number }
  /** Answers to a worker 'infer' request. */
  | { type: 'infer-result'; id: number; req: number; raw: { data: Float32Array; dims: number[] } }
  | { type: 'infer-error'; id: number; req: number; error: SerializedError }
  | { type: 'infer-progress'; id: number; req: number; progress: MlProgress };

// ---- worker → main ---------------------------------------------------------

export type GeometryResponse =
  /** Posted once when the worker script has loaded (a module worker the browser cannot run never sends it). */
  | { type: 'ready' }
  | { type: 'progress'; id: number; progress: Progress }
  /** Skin-weight progress, 0..1. */
  | { type: 'skin-progress'; id: number; ratio: number }
  /** Run the depth model on a prepared image (transferred). */
  | { type: 'infer'; id: number; req: number; job: InferJob }
  | { type: 'fused'; id: number; geometry: GeometryPayload; info: FusionInfo }
  | { type: 'skin-prepared'; id: number; key: number }
  | { type: 'skin-weights'; id: number; weights: SkinWeights }
  | { type: 'error'; id: number; error: SerializedError };

// ---- helpers ---------------------------------------------------------------

export function serializeError(e: unknown): SerializedError {
  if (e && typeof e === 'object') {
    const o = e as { name?: unknown; message?: unknown; i18n?: Partial<I18nText>; stack?: unknown };
    const out: SerializedError = {
      name: typeof o.name === 'string' ? o.name : 'Error',
      message: typeof o.message === 'string' ? o.message : String(e),
    };
    if (o.i18n && typeof o.i18n.tr === 'string' && typeof o.i18n.en === 'string') out.i18n = { tr: o.i18n.tr, en: o.i18n.en };
    if (typeof o.stack === 'string') out.stack = o.stack;
    return out;
  }
  return { name: 'Error', message: String(e) };
}

/**
 * Back to an Error: `make[name]` when given (e.g. the worker rebuilds
 * DepthOfflineError, which the fusion tells apart by class), else a
 * LocalizedError when it had bilingual text, else a plain Error; the name
 * (AbortError, ModelStalledError…) and stack are kept.
 */
export function deserializeError(s: SerializedError, make: Record<string, (s: SerializedError) => Error> = {}): Error {
  const custom = make[s.name];
  if (custom) return custom(s);
  const err = s.i18n ? new LocalizedError(s.i18n) : new Error(s.message);
  err.name = s.name;
  if (s.stack) err.stack = s.stack;
  return err;
}

/**
 * The buffers of `arrays`, once each, for postMessage's transfer list. Only
 * arrays spanning their whole buffer: a view into a bigger buffer is copied
 * instead (transferring would detach whatever else lives in it).
 */
export function buffersOf(...arrays: ArrayBufferView[]): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const a of arrays)
    if (a.buffer instanceof ArrayBuffer && a.byteOffset === 0 && a.byteLength === a.buffer.byteLength) out.add(a.buffer);
  return [...out];
}
