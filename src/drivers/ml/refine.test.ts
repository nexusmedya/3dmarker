import { describe, expect, it } from 'vitest';
import type { Mask } from '../../core/types';
import { boxSum, guidedFilter } from './refine';

describe('boxSum', () => {
  it('matches a brute-force clipped window sum', () => {
    const w = 7, h = 5, r = 2;
    const src = Array.from({ length: w * h }, (_, i) => (i * 37) % 11);
    const out = boxSum(src, w, h, r);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++)
          for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) s += src[yy * w + xx];
        expect(out[y * w + x]).toBe(s);
      }
    }
  });
});

describe('guidedFilter', () => {
  const w = 40, h = 4;
  // Guide: sharp step at x = 20. Depth: the same step, but blurred over ±6 px.
  const guide = new Float32Array(w * h);
  const blurry = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      guide[y * w + x] = x < 20 ? 0.1 : 0.9;
      blurry[y * w + x] = Math.min(1, Math.max(0, (x - 13.5) / 12));
    }
  }
  const jumpAtEdge = (d: ArrayLike<number>) => d[w + 20] - d[w + 19];

  it('restores a depth discontinuity at the guide edge', () => {
    const q = guidedFilter(guide, blurry, w, h, null, { radius: 4, eps: 1e-3 });
    expect(jumpAtEdge(blurry)).toBeLessThan(0.1);
    expect(jumpAtEdge(q)).toBeGreaterThan(0.35);
    // still monotonic, no overshoot
    for (let x = 1; x < w; x++) expect(q[w + x]).toBeGreaterThanOrEqual(q[w + x - 1] - 1e-6);
  });

  it('does not copy guide texture into flat depth', () => {
    const tex = new Float32Array(w * h).map((_, i) => ((i * 7919) % 13) / 13);
    const flat = new Float32Array(w * h).fill(0.5);
    const q = guidedFilter(tex, flat, w, h, null, { radius: 3, eps: 1e-3 });
    for (const v of q) expect(v).toBeCloseTo(0.5, 5);
  });

  it('leaves background untouched and ignores it for statistics', () => {
    const m: Mask = { width: w, height: h, data: new Uint8Array(w * h) };
    for (let i = 0; i < w * h; i++) m.data[i] = i % w < 20 ? 1 : 0;
    const p = new Float32Array(w * h).map((_, i) => (i % w < 20 ? 0.3 : 99));
    const q = guidedFilter(guide, p, w, h, m, { radius: 5, eps: 1e-3 });
    for (let i = 0; i < w * h; i++) {
      if (m.data[i]) expect(q[i]).toBeCloseTo(0.3, 5); // no bleeding of the 99s
      else expect(q[i]).toBe(99);
    }
  });
});
