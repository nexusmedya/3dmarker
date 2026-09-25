/**
 * Pure post-processing for the ML drivers: raw `predicted_depth` tensors →
 * DepthMap, plus model-download progress aggregation and progress labels.
 * No DOM / Worker usage; unit-tested in Node.
 */
import type { DepthMap, I18nText, Mask, Progress, RGBAImage } from '../../core/types';
import { normalizeDepth, resizeFloat, resizeMask } from '../../core/image/ops';
import type { MlProgress } from '../../workers/mlProtocol';
import { refineDepthWithImage } from './refine';

/**
 * What larger raw values mean:
 *  - 'disparity': relative inverse depth, larger = nearer (Depth Anything, DPT/MiDaS).
 *  - 'metric':    distance, larger = farther (GLPN, Depth Pro, Metric3D).
 */
export type DepthConvention = 'disparity' | 'metric';

/** Spatial size of a depth tensor with dims [h, w], [1, h, w] or [1, 1, h, w]. */
export function depthDims(dims: readonly number[]): { width: number; height: number } {
  if (dims.length < 2) throw new Error(`Depth tensor must have at least 2 dims, got [${dims.join(', ')}]`);
  const lead = dims.slice(0, -2);
  if (lead.some((d) => d !== 1)) throw new Error(`Batched depth tensors are not supported: [${dims.join(', ')}]`);
  const [height, width] = dims.slice(-2);
  if (!(width > 0 && height > 0)) throw new Error(`Invalid depth tensor dims [${dims.join(', ')}]`);
  return { width, height };
}

/**
 * Copy raw values into a Float32Array where larger = nearer. Non-finite
 * values (e.g. fp16 overflow) are replaced by the farthest finite value.
 */
export function orientDepth(data: ArrayLike<number>, convention: DepthConvention): Float32Array {
  const out = new Float32Array(data.length);
  const sign = convention === 'metric' ? -1 : 1;
  let far = Infinity;
  let bad = false;
  for (let i = 0; i < data.length; i++) {
    const v = sign * data[i];
    out[i] = v;
    if (Number.isFinite(v)) { if (v < far) far = v; } else bad = true;
  }
  if (bad) {
    const fill = Number.isFinite(far) ? far : 0;
    for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i])) out[i] = fill;
  }
  return out;
}

export interface RawDepth {
  data: ArrayLike<number>;
  dims: readonly number[];
}

export interface ProcessDepthOptions {
  /** Output size (the driver's input image size). */
  width: number;
  height: number;
  convention: DepthConvention;
  /** Foreground mask; normalisation statistics use it and background is set to 0. Resized if needed. */
  mask: Mask | null;
  /** Percentile (1–99 %) instead of min-max normalisation. Default true. */
  robust?: boolean;
  /** Edge-aware refinement against the input image (must be width × height). */
  refine?: { image: RGBAImage; radius?: number; eps?: number } | null;
}

/** Default guided-filter eps for refinement (depth and guide in [0, 1]). */
export const REFINE_EPS = 1e-3;

/** Radius that covers the blur introduced by upsampling from the inference size. */
export function refineRadius(srcW: number, srcH: number, dstW: number, dstH: number): number {
  const scale = Math.max(dstW / srcW, dstH / srcH);
  return Math.min(16, Math.max(2, Math.round(scale * 2)));
}

/** Raw model output → DepthMap at the requested size, 1 = nearest, normalised to [0, 1]. */
export function processDepth(raw: RawDepth, opts: ProcessDepthOptions): DepthMap {
  const { width, height } = opts;
  const src = depthDims(raw.dims);
  if (raw.data.length !== src.width * src.height) {
    throw new Error(`Depth data length ${raw.data.length} does not match dims [${raw.dims.join(', ')}]`);
  }
  const oriented = orientDepth(raw.data, opts.convention);
  const resized = resizeFloat(oriented, src.width, src.height, width, height);
  const mask = opts.mask && (opts.mask.width !== width || opts.mask.height !== height)
    ? resizeMask(opts.mask, width, height)
    : opts.mask;
  let depth = normalizeDepth({ width, height, data: resized }, mask, opts.robust ?? true);
  if (opts.refine) {
    const radius = opts.refine.radius ?? refineRadius(src.width, src.height, width, height);
    depth = refineDepthWithImage(depth, opts.refine.image, mask, { radius, eps: opts.refine.eps ?? REFINE_EPS });
  }
  return depth;
}

// ---------------------------------------------------------------------------
// Download progress aggregation

/**
 * Subset of transformers.js `ProgressInfo` (utils/core.js) we consume:
 * 'initiate' | 'download' | 'progress' | 'done' carry `file`; 'progress' and
 * 'progress_total' carry byte counts; 'ready' ends pipeline construction.
 */
export interface LoadProgressEvent {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}

export interface DownloadState {
  ratio?: number;
  loadedBytes: number;
  totalBytes: number;
  /** True once every file that started loading has finished. */
  done: boolean;
}

/**
 * Aggregates per-file load events into one ratio. Prefers the library's own
 * 'progress_total' (which knows file sizes up front from HEAD requests) and
 * falls back to summing per-file 'progress' events.
 */
export class DownloadProgressTracker {
  private files = new Map<string, { loaded: number; total: number; done: boolean }>();
  private total: { loaded: number; total: number } | null = null;

  /** Feed one event; returns the new aggregate state, or null if the event carries no byte/file info. */
  update(e: LoadProgressEvent): DownloadState | null {
    switch (e.status) {
      case 'initiate':
      case 'download':
        if (e.file && !this.files.has(e.file)) this.files.set(e.file, { loaded: 0, total: 0, done: false });
        break;
      case 'progress': {
        if (!e.file) return null;
        const f = this.files.get(e.file) ?? { loaded: 0, total: 0, done: false };
        f.loaded = Math.max(f.loaded, e.loaded ?? 0);
        f.total = Math.max(f.total, e.total ?? 0, f.loaded);
        this.files.set(e.file, f);
        break;
      }
      case 'progress_total':
        if ((e.total ?? 0) > 0) this.total = { loaded: e.loaded ?? 0, total: e.total ?? 0 };
        break;
      case 'done': {
        if (!e.file) return null;
        const f = this.files.get(e.file) ?? { loaded: 0, total: 0, done: false };
        f.done = true;
        if (f.total > 0) f.loaded = f.total;
        this.files.set(e.file, f);
        break;
      }
      default:
        return null;
    }
    return this.state();
  }

  state(): DownloadState {
    let loaded = 0, total = 0, done = this.files.size > 0;
    for (const f of this.files.values()) {
      loaded += f.done ? Math.max(f.loaded, f.total) : f.loaded;
      total += f.total;
      if (!f.done) done = false;
    }
    if (this.total && this.total.total >= total) {
      // Library aggregate includes files whose size is known before they start.
      loaded = Math.max(Math.min(this.total.loaded, this.total.total), done ? this.total.total : 0);
      total = this.total.total;
    }
    const ratio = total > 0 ? Math.min(1, loaded / total) : done ? 1 : undefined;
    return { ratio, loadedBytes: loaded, totalBytes: total, done };
  }
}

// ---------------------------------------------------------------------------
// Progress labels

const MB = 1024 * 1024;

function mbText(p: MlProgress): string {
  if (!p.totalBytes) return '';
  const fmt = (b: number) => (b / MB).toFixed(b < 10 * MB ? 1 : 0);
  return ` ${fmt(p.loadedBytes ?? 0)} / ${fmt(p.totalBytes)} MB`;
}

const DEVICE_NAME = { webgpu: 'WebGPU', wasm: 'WASM' } as const;

/**
 * Worker progress → UI Progress. `action` names what inference does
 * (e.g. { tr: 'Derinlik hesaplanıyor', en: 'Estimating depth' }).
 */
export function mlProgressToProgress(p: MlProgress, action: I18nText): Progress {
  const dev = p.device ? ` (${DEVICE_NAME[p.device]})` : '';
  switch (p.stage) {
    case 'download': {
      const mb = mbText(p);
      return {
        label: {
          tr: `Model dosyaları yükleniyor (ilk kullanımda indirilir)…${mb}`,
          en: `Loading model files (downloaded on first use)…${mb}`,
        },
        ratio: p.ratio,
      };
    }
    case 'load':
      return { label: { tr: `Model başlatılıyor${dev}…`, en: `Initialising model${dev}…` } };
    case 'inference':
      return { label: { tr: `${action.tr}${dev}…`, en: `${action.en}${dev}…` } };
  }
}
