import { describe, expect, it } from 'vitest';
import type { RGBAImage } from '../../core/types';
import { inferenceSize, prepareInferenceImage } from './prepare';

const solid = (w: number, h: number, rgba: [number, number, number, number]): RGBAImage => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
};

describe('inferenceSize', () => {
  it('keeps a square at the target side', () => {
    expect(inferenceSize(1000, 1000, 518, 14)).toEqual({ width: 518, height: 518 });
  });

  it('keeps the pixel budget and aspect ratio, snapping to the patch multiple', () => {
    const s = inferenceSize(2000, 1000, 518, 14);
    expect(s.width % 14).toBe(0);
    expect(s.height % 14).toBe(0);
    expect(s.width / s.height).toBeCloseTo(2, 1);
    expect((s.width * s.height) / (518 * 518)).toBeGreaterThan(0.9);
    expect((s.width * s.height) / (518 * 518)).toBeLessThan(1.1);
  });

  it('upscales small images and never returns less than one patch', () => {
    expect(inferenceSize(100, 100, 392, 14)).toEqual({ width: 392, height: 392 });
    const thin = inferenceSize(4000, 1, 518, 14);
    expect(thin.height).toBe(14);
  });
});

describe('prepareInferenceImage', () => {
  it('composites transparency onto the background and resizes', () => {
    const img = solid(100, 50, [255, 0, 0, 0]); // fully transparent red
    const out = prepareInferenceImage(img, { side: 70, multiple: 14, background: [10, 20, 30] });
    expect(out.width % 14).toBe(0);
    expect(out.height % 14).toBe(0);
    expect(Array.from(out.data.slice(0, 4))).toEqual([10, 20, 30, 255]);
  });

  it('always returns a fresh buffer (safe to transfer)', () => {
    const img = solid(14, 14, [1, 2, 3, 255]);
    const out = prepareInferenceImage(img, { side: 14, multiple: 14 });
    expect(out.width).toBe(14);
    expect(out.data).not.toBe(img.data);
    expect(out.data.buffer).not.toBe(img.data.buffer);
    expect(Array.from(out.data.slice(0, 4))).toEqual([1, 2, 3, 255]);
  });
});
