/**
 * Pure input preparation for the ML depth drivers: flatten transparency onto a
 * neutral background and resize to the inference size.
 */
import type { RGBAImage } from '../../core/types';
import { resizeRGBA } from '../../core/image/ops';
import { compositeOver, NEUTRAL_GREY, type RGB } from '../../core/preprocess/composite';

/**
 * Inference size with the same pixel budget as a `side` × `side` square
 * (so cost stays predictable for any aspect ratio), aspect ratio preserved,
 * both sides rounded to a multiple of `multiple` (ViT patch size).
 */
export function inferenceSize(width: number, height: number, side: number, multiple = 1): { width: number; height: number } {
  const scale = side / Math.sqrt(width * height);
  const snap = (v: number) => Math.max(multiple, Math.round(v / multiple) * multiple);
  return { width: snap(width * scale), height: snap(height * scale) };
}

export interface PrepareOptions {
  /** Target square-equivalent side in pixels. */
  side: number;
  /** Both output sides are multiples of this (default 1). */
  multiple?: number;
  /** Colour transparent areas are composited onto (default neutral grey). */
  background?: RGB;
}

/** Opaque, freshly allocated image at the inference size (safe to transfer to a worker). */
export function prepareInferenceImage(img: RGBAImage, { side, multiple = 1, background = NEUTRAL_GREY }: PrepareOptions): RGBAImage {
  const flat = compositeOver(img, background);
  const size = inferenceSize(img.width, img.height, side, multiple);
  if (size.width === img.width && size.height === img.height) return flat;
  return resizeRGBA(flat, size.width, size.height);
}
