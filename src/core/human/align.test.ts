import { describe, expect, it } from 'vitest';
import { boxFeather, fitAffine } from './align';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('fitAffine', () => {
  it('recovers an exact scale and offset', () => {
    const src = Float32Array.from({ length: 200 }, (_, i) => Math.sin(i * 0.1));
    const dst = src.map((v) => 2.5 * v - 0.3);
    const fit = fitAffine(src, dst, null)!;
    expect(fit.scale).toBeCloseTo(2.5, 5);
    expect(fit.offset).toBeCloseTo(-0.3, 5);
    expect(fit.rmse).toBeLessThan(1e-5);
  });

  it('is robust to outliers (trimmed refits)', () => {
    const r = rng(7);
    const n = 1000;
    const src = new Float32Array(n), dst = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      src[i] = r();
      dst[i] = 0.5 * src[i] + 0.2 + (r() - 0.5) * 0.01;
      if (i % 7 === 0) dst[i] = r() * 5; // ~14 % garbage (occluders)
    }
    const naive = fitAffine(src, dst, null, { iterations: 0 })!;
    const robust = fitAffine(src, dst, null)!;
    expect(Math.abs(naive.offset - 0.2)).toBeGreaterThan(0.2);
    expect(robust.scale).toBeCloseTo(0.5, 1);
    expect(robust.offset).toBeCloseTo(0.2, 1);
    expect(robust.count).toBeLessThan(n);
  });

  it('respects weights (zero = excluded) and rejects degenerate input', () => {
    const src = Float32Array.from({ length: 100 }, (_, i) => i / 100);
    const dst = src.map((v, i) => (i < 50 ? 3 * v : -9));
    const w = Float32Array.from({ length: 100 }, (_, i) => (i < 50 ? 1 : 0));
    const fit = fitAffine(src, dst, w)!;
    expect(fit.scale).toBeCloseTo(3, 5);
    expect(fitAffine(new Float32Array(100).fill(0.5), dst, null)).toBeNull();
    expect(fitAffine(src.subarray(0, 5), dst.subarray(0, 5), null)).toBeNull();
  });
});

describe('boxFeather', () => {
  it('is 1 inside and ramps to 0 at closed edges', () => {
    const w = boxFeather(20, 10, 4);
    expect(w[5 * 20 + 10]).toBe(1);
    expect(w[5 * 20]).toBeLessThan(0.1);
    expect(w[5 * 20 + 1]).toBeLessThan(w[5 * 20 + 2]);
    const open = boxFeather(20, 10, 4, { left: true, right: false, top: false, bottom: false });
    expect(open[5 * 20]).toBe(1);
    expect(open[5 * 20 + 19]).toBeLessThan(0.1);
  });
});
