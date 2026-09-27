/**
 * Alpha handling around the AI upscaler, which only sees RGB: transparent
 * pixels get the colour of the nearest visible pixel first (no dark halos),
 * and the matte is upscaled separately with a smooth filter and put back.
 */
import type { RGBAImage } from '../types';
import { resizeChannel } from './resize';

/** True when any pixel is not fully opaque. */
export function hasAlpha(img: RGBAImage): boolean {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  return false;
}

/** The alpha channel as its own plane. */
export function alphaPlane(img: RGBAImage): Uint8Array {
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = img.data[i * 4 + 3];
  return out;
}

/**
 * Opaque copy where pixels with alpha below `threshold` take the colour of
 * the nearest visible pixel (multi-source BFS); an image with no visible
 * pixel becomes mid grey.
 */
export function bleedColors(img: RGBAImage, threshold = 16): RGBAImage {
  const { width: w, height: h, data: src } = img;
  const n = w * h;
  const out = new Uint8ClampedArray(src);
  const filled = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    if (src[i * 4 + 3] >= threshold) {
      filled[i] = 1;
      queue[tail++] = i;
    }
  }
  if (tail === 0) {
    for (let i = 0; i < n; i++) out.set([128, 128, 128, 255], i * 4);
    return { width: w, height: h, data: out };
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

/**
 * Put `alpha` (w × h) back onto `rgb` (any size): the matte is resized with
 * Catmull-Rom (smooth, no blocky edges); fully transparent / opaque areas stay exact.
 */
export function applyAlpha(rgb: RGBAImage, alpha: Uint8Array, w: number, h: number): RGBAImage {
  const W = rgb.width, H = rgb.height;
  const a = W === w && H === h ? alpha : resizeChannel(alpha, w, h, W, H, 'bicubic');
  const out = new Uint8ClampedArray(rgb.data);
  for (let i = 0; i < W * H; i++) out[i * 4 + 3] = a[i];
  return { width: W, height: H, data: out };
}
