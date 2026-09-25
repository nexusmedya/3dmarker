/** Preview overlay: background (mask = 0) tinted, foreground left clear. */
import type { Mask, RGBAImage } from '../core/types';

export function maskOverlay(mask: Mask, rgba: [number, number, number, number] = [236, 72, 153, 150]): RGBAImage {
  const n = mask.width * mask.height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    if (mask.data[i]) continue;
    out[i * 4] = rgba[0];
    out[i * 4 + 1] = rgba[1];
    out[i * 4 + 2] = rgba[2];
    out[i * 4 + 3] = rgba[3];
  }
  return { width: mask.width, height: mask.height, data: out };
}

/** Foreground share in percent (0..100, one decimal below 10 %). */
export function coveragePercent(mask: Mask): number {
  let a = 0;
  for (let i = 0; i < mask.data.length; i++) a += mask.data[i] ? 1 : 0;
  const pct = (100 * a) / Math.max(1, mask.data.length);
  return pct < 10 ? Math.round(pct * 10) / 10 : Math.round(pct);
}
