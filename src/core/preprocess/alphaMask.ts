/**
 * Turning a model's soft alpha matte into a binary foreground Mask.
 * Pure functions, unit-tested in Node.
 */
import type { Mask } from '../types';
import { resizeFloat } from '../image/ops';

/**
 * Extract the alpha channel of interleaved 8-bit pixels (RawImage layout).
 * 4 or 2 channels → last channel; 1 channel → the channel itself.
 */
export function alphaChannel(data: ArrayLike<number>, width: number, height: number, channels: number): Uint8Array {
  const n = width * height;
  if (data.length < n * channels) throw new Error(`alphaChannel: expected ${n * channels} values, got ${data.length}`);
  const out = new Uint8Array(n);
  if (channels === 1) {
    for (let i = 0; i < n; i++) out[i] = data[i];
  } else if (channels === 2 || channels === 4) {
    for (let i = 0, o = channels - 1; i < n; i++, o += channels) out[i] = data[o];
  } else {
    throw new Error(`alphaChannel: unsupported channel count ${channels}`);
  }
  return out;
}

/**
 * Upsample a soft 8-bit matte (bilinear, so edges stay smooth) to the target
 * size and threshold it: alpha / 255 >= threshold → foreground.
 */
export function alphaToMask(
  alpha: ArrayLike<number>,
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
  threshold = 0.5,
): Mask {
  const n = width * height;
  if (alpha.length !== n) throw new Error(`alphaToMask: expected ${n} values, got ${alpha.length}`);
  const soft = new Float32Array(n);
  for (let i = 0; i < n; i++) soft[i] = alpha[i] / 255;
  const up = resizeFloat(soft, width, height, targetWidth, targetHeight);
  const data = new Uint8Array(targetWidth * targetHeight);
  for (let i = 0; i < data.length; i++) data[i] = up[i] >= threshold ? 1 : 0;
  return { width: targetWidth, height: targetHeight, data };
}

/** Pixel-wise AND of two masks of the same size. */
export function intersectMasks(a: Mask, b: Mask): Mask {
  if (a.width !== b.width || a.height !== b.height) throw new Error('intersectMasks: size mismatch');
  const data = new Uint8Array(a.data.length);
  for (let i = 0; i < data.length; i++) data[i] = a.data[i] && b.data[i] ? 1 : 0;
  return { width: a.width, height: a.height, data };
}
