/**
 * Edge-aware depth refinement: a mask-aware guided filter (He et al. 2010)
 * using the image luminance as guide. Upsampled network depth is blurry at
 * object boundaries; the guided filter snaps its edges to image edges while
 * leaving flat-depth textured areas alone (no texture copy where the depth
 * and the guide are uncorrelated). Pure, O(n) via summed-area tables.
 */
import type { DepthMap, Mask, RGBAImage } from '../../core/types';
import { luminance } from '../../core/image/ops';

export interface GuidedFilterOptions {
  /** Window radius in pixels. */
  radius: number;
  /** Regularisation; larger = smoother, smaller = follows guide edges more. Guide/depth are in [0, 1]. */
  eps: number;
}

/** Clipped-window box sums of `src` (row-major w × h) with radius r, via a summed-area table. */
export function boxSum(src: ArrayLike<number>, w: number, h: number, r: number): Float64Array {
  const W = w + 1;
  const sat = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      sat[(y + 1) * W + x + 1] = sat[y * W + x + 1] + row;
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      out[y * w + x] = sat[y1 * W + x1] - sat[y0 * W + x1] - sat[y1 * W + x0] + sat[y0 * W + x0];
    }
  }
  return out;
}

/**
 * Guided filter of `p` with guide `I` (both w × h, values ~[0, 1]). With a
 * mask, statistics use foreground pixels only (normalised convolution) and
 * background pixels are returned unchanged.
 */
export function guidedFilter(
  I: ArrayLike<number>,
  p: ArrayLike<number>,
  w: number,
  h: number,
  mask: Mask | null,
  { radius, eps }: GuidedFilterOptions,
): Float32Array {
  const n = w * h;
  const r = Math.max(1, Math.round(radius));
  const m = new Float64Array(n);
  for (let i = 0; i < n; i++) m[i] = mask ? mask.data[i] : 1;
  const prod = (f: (i: number) => number) => {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = m[i] ? f(i) * m[i] : 0;
    return a;
  };
  const N = boxSum(m, w, h, r);
  const sI = boxSum(prod((i) => I[i]), w, h, r);
  const sP = boxSum(prod((i) => p[i]), w, h, r);
  const sII = boxSum(prod((i) => I[i] * I[i]), w, h, r);
  const sIP = boxSum(prod((i) => I[i] * p[i]), w, h, r);
  const a = new Float64Array(n);
  const b = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (N[i] < 1e-9) continue;
    const mI = sI[i] / N[i], mP = sP[i] / N[i];
    const varI = sII[i] / N[i] - mI * mI;
    const covIP = sIP[i] / N[i] - mI * mP;
    a[i] = covIP / (varI + eps);
    b[i] = mP - a[i] * mI;
  }
  const sA = boxSum(prod((i) => a[i]), w, h, r);
  const sB = boxSum(prod((i) => b[i]), w, h, r);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = !m[i] || N[i] < 1e-9 ? p[i] : (sA[i] * I[i] + sB[i]) / N[i];
  }
  return out;
}

/**
 * Refine a normalised depth map ([0, 1]) against the RGBA image it was
 * estimated from. Output is clamped to [0, 1]; background stays as-is.
 */
export function refineDepthWithImage(
  depth: DepthMap,
  image: RGBAImage,
  mask: Mask | null,
  opts: GuidedFilterOptions,
): DepthMap {
  if (image.width !== depth.width || image.height !== depth.height) {
    throw new Error('refineDepthWithImage: image and depth sizes differ');
  }
  const guide = luminance(image);
  const q = guidedFilter(guide, depth.data, depth.width, depth.height, mask, opts);
  for (let i = 0; i < q.length; i++) q[i] = Math.min(1, Math.max(0, q[i]));
  return { width: depth.width, height: depth.height, data: q };
}
