/**
 * Depth map → RGBA for the depth map editor view: grayscale or a turbo
 * colormap, an optional image overlay and dimmed pixels outside the mask.
 * Region-based so a brush dab repaints only its rectangle.
 */
import type { RGBAImage } from '../core/types';
import type { Rect } from './depthBrush';

export type DepthColormap = 'gray' | 'turbo';

export interface DepthViewOptions {
  colormap: DepthColormap;
  /** Image resampled to the depth size (see imageForSize), or null. */
  image: Uint8ClampedArray | null;
  /** 0..1 */
  imageOpacity: number;
  /** Mask at the depth size; pixels outside are dimmed. */
  mask: Uint8Array | null;
}

/** Polynomial approximation of Google's Turbo colormap (x in [0, 1]) → 0..255 RGB. */
export function turbo(x: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  const t2 = t * t, t3 = t2 * t, t4 = t3 * t, t5 = t4 * t;
  const r = 0.13572138 + 4.6153926 * t - 42.66032258 * t2 + 132.13108234 * t3 - 152.94239396 * t4 + 59.28637943 * t5;
  const g = 0.09140261 + 2.19418839 * t + 4.84296658 * t2 - 14.18503333 * t3 + 4.27729857 * t4 + 2.82956604 * t5;
  const b = 0.1066733 + 12.64194608 * t - 60.58204836 * t2 + 110.36276771 * t3 - 89.90310912 * t4 + 27.34824973 * t5;
  out[0] = Math.round(Math.min(1, Math.max(0, r)) * 255);
  out[1] = Math.round(Math.min(1, Math.max(0, g)) * 255);
  out[2] = Math.round(Math.min(1, Math.max(0, b)) * 255);
  return out;
}

/** Nearest-neighbour resample of an RGBA image to w × h (RGBA bytes). */
export function imageForSize(img: RGBAImage | null, w: number, h: number): Uint8ClampedArray | null {
  if (!img) return null;
  if (img.width === w && img.height === h) return img.data;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / w));
      const s = (sy * img.width + sx) * 4, o = (y * w + x) * 4;
      out[o] = img.data[s];
      out[o + 1] = img.data[s + 1];
      out[o + 2] = img.data[s + 2];
      out[o + 3] = img.data[s + 3];
    }
  }
  return out;
}

const DIM = 0.35;

/** Paint `rect` (default: everything) of `depth` into `out` (RGBA, w × h). */
export function renderDepthRegion(
  out: Uint8ClampedArray,
  depth: Float32Array,
  w: number,
  h: number,
  o: DepthViewOptions,
  rect: Rect = { x0: 0, y0: 0, x1: w, y1: h },
): void {
  const rgb: [number, number, number] = [0, 0, 0];
  const a = Math.max(0, Math.min(1, o.imageOpacity));
  const x0 = Math.max(0, rect.x0), x1 = Math.min(w, rect.x1);
  const y0 = Math.max(0, rect.y0), y1 = Math.min(h, rect.y1);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      const v = depth[i];
      if (o.colormap === 'turbo') turbo(v, rgb);
      else rgb[0] = rgb[1] = rgb[2] = Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255);
      let r = rgb[0], g = rgb[1], b = rgb[2];
      if (o.image && a > 0) {
        const k = a * (o.image[i * 4 + 3] / 255);
        r += (o.image[i * 4] - r) * k;
        g += (o.image[i * 4 + 1] - g) * k;
        b += (o.image[i * 4 + 2] - b) * k;
      }
      if (o.mask && !o.mask[i]) {
        r *= DIM;
        g *= DIM;
        b *= DIM;
      }
      const p = i * 4;
      out[p] = r;
      out[p + 1] = g;
      out[p + 2] = b;
      out[p + 3] = 255;
    }
  }
}
