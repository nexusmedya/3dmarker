/**
 * 2D depth painting (the depth map editor's pure logic): brushes on a
 * DepthMap ([0, 1], 1 = nearest) with falloff, an optional "inside the mask
 * only" lock, per-stroke sparse undo / redo and stroke spacing. Every edit
 * returns the dirty rectangle so the view can repaint just that part.
 */
import type { DepthMap, Mask } from '../core/types';
import type { Falloff } from './types';
import { falloffWeight } from './falloff';

export type DepthBrushId = 'raise' | 'lower' | 'smooth' | 'flatten' | 'erase';
export const DEPTH_BRUSH_IDS: DepthBrushId[] = ['raise', 'lower', 'smooth', 'flatten', 'erase'];

export function isDepthBrushId(v: unknown): v is DepthBrushId {
  return typeof v === 'string' && (DEPTH_BRUSH_IDS as string[]).includes(v);
}

/** Depth change per dab for raise / lower at strength 1, weight 1. */
export const DEPTH_RAISE_STEP = 0.02;

/** Highest working value (raising past the nearest point; rescaled into [0, 1] on output). */
export const DEPTH_HEADROOM = 2;

export interface DepthDab {
  /** Centre in depth-pixel coordinates (pixel i spans [i, i + 1)). */
  x: number;
  y: number;
  /** Radius in depth pixels. */
  radius: number;
  /** 0..1 */
  strength: number;
  brush: DepthBrushId;
  falloff: Falloff;
}

/** Half-open pixel rectangle [x0, x1) × [y0, y1). */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

interface DepthStroke {
  idx: Uint32Array;
  before: Float32Array;
  after: Float32Array;
  rect: Rect;
}

/** Nearest-neighbour resample of a mask to w × h (null stays null). */
export function maskForSize(mask: Mask | null, w: number, h: number): Uint8Array | null {
  if (!mask) return null;
  if (mask.width === w && mask.height === h) return mask.data;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(mask.height - 1, Math.floor(((y + 0.5) * mask.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(mask.width - 1, Math.floor(((x + 0.5) * mask.width) / w));
      out[y * w + x] = mask.data[sy * mask.width + sx];
    }
  }
  return out;
}

/**
 * Editable copy of a depth map. `original` never changes (erase brush,
 * before / after); `data` is the working copy handed back on Apply.
 * Values may be raised above 1 (up to DEPTH_HEADROOM) so the nearest
 * features (a nose, a belly) can still be pushed out; toDepthMap() then
 * rescales the whole map back into [0, 1], keeping the relief's proportions.
 */
export class DepthEditState {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
  readonly original: Float32Array;
  readonly mask: Uint8Array | null;
  /** Only paint inside the mask (when there is one). */
  maskOnly = true;

  private undoStack: DepthStroke[] = [];
  private redoStack: DepthStroke[] = [];
  private bytes = 0;
  private readonly stamp: Int32Array;
  private strokeId = 0;
  private recIdx: number[] | null = null;
  private recOld: number[] | null = null;
  private recRect: Rect | null = null;
  private applied = 0;

  constructor(
    depth: DepthMap,
    mask: Mask | null,
    readonly maxStrokes = 64,
    readonly maxBytes = 128 * 1024 * 1024,
  ) {
    this.width = depth.width;
    this.height = depth.height;
    this.original = new Float32Array(depth.data);
    this.data = new Float32Array(depth.data);
    this.mask = maskForSize(mask, depth.width, depth.height);
    this.stamp = new Int32Array(depth.width * depth.height);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Net number of strokes applied (0 = unchanged from the original, as far as history knows). */
  get strokes(): number {
    return this.applied;
  }

  /** True when some pixel differs from the original. */
  get edited(): boolean {
    const a = this.data, b = this.original;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
    return false;
  }

  /** The edited map in [0, 1]: a copy, divided by its maximum when raising went past 1. */
  toDepthMap(): DepthMap {
    const data = new Float32Array(this.data);
    let max = 0;
    for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i];
    if (max > 1) for (let i = 0; i < data.length; i++) data[i] /= max;
    return { width: this.width, height: this.height, data };
  }

  beginStroke(): void {
    if (this.recIdx) this.endStroke();
    if (++this.strokeId >= 0x7fffffff) {
      this.stamp.fill(0);
      this.strokeId = 1;
    }
    this.recIdx = [];
    this.recOld = [];
    this.recRect = null;
  }

  get stroking(): boolean {
    return this.recIdx !== null;
  }

  /** Finish the stroke (recorded for undo when something changed). */
  endStroke(): boolean {
    const idx = this.recIdx, old = this.recOld, rect = this.recRect;
    this.recIdx = this.recOld = null;
    this.recRect = null;
    if (!idx || !old || !rect || idx.length === 0) return false;
    let changed = false;
    for (let i = 0; i < idx.length; i++) {
      if (this.data[idx[i]] !== old[i]) {
        changed = true;
        break;
      }
    }
    if (!changed) return false;
    const ii = Uint32Array.from(idx);
    const after = new Float32Array(ii.length);
    for (let i = 0; i < ii.length; i++) after[i] = this.data[ii[i]];
    const rec: DepthStroke = { idx: ii, before: Float32Array.from(old), after, rect };
    this.redoStack = [];
    this.undoStack.push(rec);
    this.bytes = this.undoStack.reduce((s, r) => s + r.idx.byteLength * 3, 0);
    while (this.undoStack.length > 0 && (this.undoStack.length > this.maxStrokes || this.bytes > this.maxBytes)) {
      this.bytes -= this.undoStack.shift()!.idx.byteLength * 3;
    }
    this.applied++;
    return true;
  }

  undo(): Rect | null {
    if (this.recIdx) this.endStroke();
    const rec = this.undoStack.pop();
    if (!rec) return null;
    for (let i = 0; i < rec.idx.length; i++) this.data[rec.idx[i]] = rec.before[i];
    this.redoStack.push(rec);
    this.applied = Math.max(0, this.applied - 1);
    return rec.rect;
  }

  redo(): Rect | null {
    if (this.recIdx) this.endStroke();
    const rec = this.redoStack.pop();
    if (!rec) return null;
    for (let i = 0; i < rec.idx.length; i++) this.data[rec.idx[i]] = rec.after[i];
    this.undoStack.push(rec);
    this.applied++;
    return rec.rect;
  }

  private write(i: number, v: number): void {
    if (this.recIdx && this.stamp[i] !== this.strokeId) {
      this.stamp[i] = this.strokeId;
      this.recIdx.push(i);
      this.recOld!.push(this.data[i]);
    }
    this.data[i] = v < 0 ? 0 : v > DEPTH_HEADROOM ? DEPTH_HEADROOM : v;
  }

  private editable(i: number): boolean {
    return !(this.maskOnly && this.mask && !this.mask[i]);
  }

  /**
   * Apply one dab (records into the current stroke when one is open).
   * Returns the dirty rectangle, or null when nothing was inside the image.
   */
  dab(d: DepthDab): Rect | null {
    const { width: w, height: h, data } = this;
    const r = Math.max(0.5, d.radius);
    const x0 = Math.max(0, Math.floor(d.x - r)), x1 = Math.min(w, Math.ceil(d.x + r));
    const y0 = Math.max(0, Math.floor(d.y - r)), y1 = Math.min(h, Math.ceil(d.y + r));
    if (x0 >= x1 || y0 >= y1) return null;
    const s = Math.max(0, Math.min(1, d.strength));
    const rw = x1 - x0, rh = y1 - y0;
    const weights = new Float32Array(rw * rh);
    let any = false;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - d.x, dy = y + 0.5 - d.y;
        const wgt = falloffWeight(d.falloff, Math.sqrt(dx * dx + dy * dy) / r);
        if (wgt > 0 && this.editable(y * w + x)) {
          weights[(y - y0) * rw + (x - x0)] = wgt;
          any = true;
        }
      }
    }
    if (!any) return null;
    const rect: Rect = { x0, y0, x1, y1 };

    switch (d.brush) {
      case 'raise':
      case 'lower': {
        const step = (d.brush === 'raise' ? 1 : -1) * DEPTH_RAISE_STEP * s;
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const wgt = weights[(y - y0) * rw + (x - x0)];
            if (wgt > 0) this.write(y * w + x, data[y * w + x] + step * wgt);
          }
        break;
      }
      case 'erase': {
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const wgt = weights[(y - y0) * rw + (x - x0)];
            if (wgt <= 0) continue;
            const i = y * w + x;
            this.write(i, data[i] + (this.original[i] - data[i]) * Math.min(1, wgt * s));
          }
        break;
      }
      case 'flatten': {
        let sw = 0, sd = 0;
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const wgt = weights[(y - y0) * rw + (x - x0)];
            sw += wgt;
            sd += wgt * data[y * w + x];
          }
        const level = sd / sw;
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const wgt = weights[(y - y0) * rw + (x - x0)];
            if (wgt <= 0) continue;
            const i = y * w + x;
            this.write(i, data[i] + (level - data[i]) * Math.min(1, 0.5 * wgt * s));
          }
        break;
      }
      case 'smooth': {
        // Box blur (kernel grows with the brush), mask-aware so the
        // background never bleeds into the foreground edge. Jacobi: the
        // blurred values come from a copy taken before writing.
        const k = Math.max(1, Math.round(r / 6));
        const blurred = this.boxAverage(x0, y0, x1, y1, k);
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const j = (y - y0) * rw + (x - x0);
            const wgt = weights[j];
            if (wgt <= 0 || Number.isNaN(blurred[j])) continue;
            const i = y * w + x;
            this.write(i, data[i] + (blurred[j] - data[i]) * Math.min(1, wgt * s));
          }
        break;
      }
    }
    this.recRect = unionRect(this.recRect, rect);
    return rect;
  }

  /**
   * Mean over a (2k+1)² window of each pixel in the rect (masked-out pixels
   * ignored; NaN where the window has none). Running column sums slide down
   * the rows and prefix sums across them give each window in O(1): the cost
   * is O(area), independent of k.
   */
  private boxAverage(x0: number, y0: number, x1: number, y1: number, k: number): Float32Array {
    const { width: w, height: h, data } = this;
    const mask = this.maskOnly ? this.mask : null;
    const ex0 = Math.max(0, x0 - k), ex1 = Math.min(w, x1 + k);
    const ew = ex1 - ex0;
    const rw = x1 - x0, rh = y1 - y0;
    const out = new Float32Array(rw * rh);
    // Vertical sums over rows [y-k, y+k] for every column of the extended rect.
    const colSum = new Float64Array(ew), colCnt = new Float64Array(ew);
    const prefSum = new Float64Array(ew + 1), prefCnt = new Float64Array(ew + 1);
    const addRow = (yy: number, sign: 1 | -1) => {
      const row = yy * w + ex0;
      for (let c = 0; c < ew; c++) {
        const i = row + c;
        if (mask && !mask[i]) continue;
        colSum[c] += sign * data[i];
        colCnt[c] += sign;
      }
    };
    for (let yy = Math.max(0, y0 - k), end = Math.min(h - 1, y0 + k); yy <= end; yy++) addRow(yy, 1);
    for (let y = y0; y < y1; y++) {
      if (y > y0) {
        if (y + k <= h - 1) addRow(y + k, 1);
        if (y - k - 1 >= 0) addRow(y - k - 1, -1);
      }
      for (let c = 0; c < ew; c++) {
        prefSum[c + 1] = prefSum[c] + colSum[c];
        prefCnt[c + 1] = prefCnt[c] + colCnt[c];
      }
      for (let x = x0; x < x1; x++) {
        const c0 = Math.max(0, x - k) - ex0, c1 = Math.min(w - 1, x + k) - ex0 + 1;
        const cnt = prefCnt[c1] - prefCnt[c0];
        out[(y - y0) * rw + (x - x0)] = cnt > 0.5 ? (prefSum[c1] - prefSum[c0]) / cnt : Number.NaN;
      }
    }
    return out;
  }
}

/**
 * Points along a stroke segment every `spacing` pixels. `carry` is the
 * distance travelled since the last dab (returned updated for the next call).
 */
export function spacedPoints(
  from: { x: number; y: number },
  to: { x: number; y: number },
  spacing: number,
  carry: number,
  maxPoints = 512,
): { points: { x: number; y: number }[]; carry: number } {
  const step = Math.max(1e-6, spacing);
  const dx = to.x - from.x, dy = to.y - from.y;
  const total = Math.hypot(dx, dy);
  const points: { x: number; y: number }[] = [];
  let s = step - carry;
  let last = -1;
  while (s <= total && points.length < maxPoints) {
    const f = total > 0 ? s / total : 1;
    points.push({ x: from.x + dx * f, y: from.y + dy * f });
    last = s;
    s += step;
  }
  return { points, carry: points.length >= maxPoints ? 0 : last >= 0 ? total - last : carry + total };
}
