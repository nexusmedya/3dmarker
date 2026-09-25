/**
 * Alpha compositing helpers. Pure functions (main thread, workers, Node tests).
 */
import type { RGBAImage } from '../types';

export type RGB = readonly [number, number, number];

/** Neutral mid-grey: keeps contrast for both dark and light subjects. */
export const NEUTRAL_GREY: RGB = [128, 128, 128];
export const WHITE: RGB = [255, 255, 255];

/**
 * Composite an RGBA image over a solid colour and return an opaque copy
 * (alpha = 255 everywhere). Always allocates, so the result can be
 * transferred to a worker without detaching the caller's pixels.
 */
export function compositeOver(img: RGBAImage, bg: RGB = NEUTRAL_GREY): RGBAImage {
  const src = img.data;
  const out = new Uint8ClampedArray(src.length);
  for (let o = 0; o < src.length; o += 4) {
    const a = src[o + 3] / 255;
    const ia = 1 - a;
    out[o] = src[o] * a + bg[0] * ia;
    out[o + 1] = src[o + 1] * a + bg[1] * ia;
    out[o + 2] = src[o + 2] * a + bg[2] * ia;
    out[o + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}
