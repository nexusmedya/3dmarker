/**
 * Silhouette helpers for the visual hull: exact area coverage of rectangles
 * (summed-area table, bilinear between integer corners — exact for a
 * piecewise-constant mask) and Euclidean dilation.
 */
import type { Mask, RGBAImage } from '../types';
import { distanceTransform } from '../image/distance';

export class SummedArea {
  readonly width: number;
  readonly height: number;
  private readonly sat: Float64Array;

  constructor(mask: Mask) {
    const { width: w, height: h, data } = mask;
    this.width = w;
    this.height = h;
    const W = w + 1;
    const sat = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += data[y * w + x] ? 1 : 0;
        sat[(y + 1) * W + x + 1] = sat[y * W + x + 1] + row;
      }
    }
    this.sat = sat;
  }

  /** ∫∫ mask over [0, x] × [0, y] (continuous pixel-edge coords, clamped to the image). */
  integral(x: number, y: number): number {
    const { width: w, height: h, sat } = this;
    if (w === 0 || h === 0) return 0;
    const cx = x <= 0 ? 0 : x >= w ? w : x;
    const cy = y <= 0 ? 0 : y >= h ? h : y;
    const ix = Math.min(w - 1, Math.floor(cx)), iy = Math.min(h - 1, Math.floor(cy));
    const fx = cx - ix, fy = cy - iy;
    const W = w + 1;
    const o = iy * W + ix;
    const a = sat[o], b = sat[o + 1], c = sat[o + W], d = sat[o + W + 1];
    return a + fx * (b - a) + fy * (c - a) + fx * fy * (d - b - c + a);
  }

  /** Mean mask value over [x0, x1] × [y0, y1]; parts outside the image count as background. */
  coverage(x0: number, y0: number, x1: number, y1: number): number {
    const area = (x1 - x0) * (y1 - y0);
    if (!(area > 0)) return 0;
    const s = this.integral(x1, y1) - this.integral(x0, y1) - this.integral(x1, y0) + this.integral(x0, y0);
    const c = s / area;
    return c <= 0 ? 0 : c >= 1 ? 1 : c;
  }
}

/** Euclidean dilation by `radius` pixels (pixels within the radius of the foreground become foreground). */
export function dilateMask(mask: Mask, radius: number): Mask {
  const { width: w, height: h, data } = mask;
  if (!(radius > 0)) return { width: w, height: h, data: data.slice() };
  // Distance of every background pixel to the foreground = EDT of the
  // inverted mask. Pad with "foreground of the inverse" so the image border
  // does not count as original foreground.
  const pad = Math.ceil(radius) + 1;
  const W = w + 2 * pad, H = h + 2 * pad;
  const inv = new Uint8Array(W * H).fill(1);
  for (let y = 0; y < h; y++) {
    const src = y * w, dst = (y + pad) * W + pad;
    for (let x = 0; x < w; x++) inv[dst + x] = data[src + x] ? 0 : 1;
  }
  const dist = distanceTransform({ width: W, height: H, data: inv });
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const src = (y + pad) * W + pad, dst = y * w;
    for (let x = 0; x < w; x++) out[dst + x] = data[dst + x] || dist[src + x] <= radius ? 1 : 0;
  }
  return { width: w, height: h, data: out };
}

/**
 * Copy of `image` whose background pixels take the colour of the nearest
 * foreground pixel (multi-source BFS), so bilinear sampling near the
 * silhouette never mixes in background colour. Alpha is set to 255.
 */
export function bleedImage(image: RGBAImage, mask: Mask): RGBAImage {
  const { width: w, height: h } = image;
  const n = w * h;
  const src = image.data;
  const out = new Uint8ClampedArray(src);
  const filled = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    if (mask.data[i]) {
      filled[i] = 1;
      queue[tail++] = i;
    }
  }
  const visit = (from: number, j: number) => {
    if (filled[j]) return;
    filled[j] = 1;
    out[j * 4] = out[from * 4];
    out[j * 4 + 1] = out[from * 4 + 1];
    out[j * 4 + 2] = out[from * 4 + 2];
    queue[tail++] = j;
  };
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    if (x > 0) visit(i, i - 1);
    if (x < w - 1) visit(i, i + 1);
    if (i >= w) visit(i, i - w);
    if (i < n - w) visit(i, i + w);
  }
  for (let i = 0; i < n; i++) out[i * 4 + 3] = 255;
  return { width: w, height: h, data: out };
}
