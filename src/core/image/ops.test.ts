import { describe, expect, it } from 'vitest';
import type { DepthMap, Mask } from '../types';
import { normalizeDepth } from './ops';

/** The straightforward definition: sort the foreground values, take the 1st/99th percentiles. */
function reference(depth: DepthMap, mask: Mask | null, robust: boolean): Float32Array {
  const vals: number[] = [];
  for (let i = 0; i < depth.data.length; i++) if (!mask || mask.data[i]) vals.push(depth.data[i]);
  const out = new Float32Array(depth.data.length);
  if (vals.length === 0) return out;
  vals.sort((a, b) => a - b);
  const [lo, hi] = robust && vals.length > 100
    ? [vals[Math.floor(vals.length * 0.01)], vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.99))]]
    : [vals[0], vals[vals.length - 1]];
  const span = hi - lo > 1e-12 ? hi - lo : 1;
  for (let i = 0; i < out.length; i++) if (!mask || mask.data[i]) out[i] = Math.min(1, Math.max(0, (depth.data[i] - lo) / span));
  return out;
}

describe('normalizeDepth', () => {
  let s = 12345;
  const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const W = 173, H = 121;
  const data = new Float32Array(W * H);
  for (let i = 0; i < data.length; i++) data[i] = rnd() < 0.005 ? (rnd() - 0.5) * 1e4 : 3 + 7 * rnd(); // with outliers
  const depth: DepthMap = { width: W, height: H, data };
  const mask: Mask = { width: W, height: H, data: Uint8Array.from(data, () => (rnd() < 0.7 ? 1 : 0)) };
  const tiny: Mask = { width: W, height: H, data: new Uint8Array(W * H) };
  tiny.data.fill(1, 0, 50);

  it('matches the sort-based percentile definition, with and without a mask', () => {
    for (const m of [null, mask, tiny]) {
      for (const robust of [true, false]) {
        const out = normalizeDepth(depth, m, robust);
        expect(out.width).toBe(W);
        expect(out.height).toBe(H);
        expect(Array.from(out.data)).toEqual(Array.from(reference(depth, m, robust)));
      }
    }
  });

  it('ignores outliers when robust and zeroes the background', () => {
    const out = normalizeDepth(depth, mask).data;
    const fg = Array.from(out).filter((_, i) => mask.data[i]);
    expect(fg.filter((v) => v > 0 && v < 1).length / fg.length).toBeGreaterThan(0.9);
    for (let i = 0; i < out.length; i++) if (!mask.data[i]) expect(out[i]).toBe(0);
    expect(Array.from(normalizeDepth(depth, { width: W, height: H, data: new Uint8Array(W * H) }).data).every((v) => v === 0)).toBe(true);
  });
});
