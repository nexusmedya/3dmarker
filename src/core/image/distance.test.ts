import { describe, expect, it } from 'vitest';
import type { Mask } from '../types';
import { distanceTransform, unionOfSpheres } from './distance';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomMask(w: number, h: number, density: number, rand: () => number): Mask {
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = rand() < density ? 1 : 0;
  return { width: w, height: h, data };
}

/** O(n²) reference: background pixels plus the ring of pixels just outside the image. */
function bruteForce(mask: Mask): Float32Array {
  const { width: w, height: h, data } = mask;
  const bg: [number, number][] = [];
  for (let y = -1; y <= h; y++)
    for (let x = -1; x <= w; x++) {
      const outside = x < 0 || y < 0 || x >= w || y >= h;
      if (outside || !data[y * w + x]) bg.push([x, y]);
    }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!data[y * w + x]) continue;
      let best = Infinity;
      for (const [bx, by] of bg) best = Math.min(best, (bx - x) ** 2 + (by - y) ** 2);
      out[y * w + x] = Math.sqrt(best);
    }
  return out;
}

describe('distanceTransform', () => {
  it('matches brute force on random masks', () => {
    const rand = rng(42);
    const sizes: [number, number][] = [[1, 1], [1, 7], [9, 1], [5, 5], [13, 8], [8, 21], [32, 32], [40, 17]];
    for (const [w, h] of sizes) {
      for (const density of [0.3, 0.7, 0.95, 1]) {
        const mask = randomMask(w, h, density, rand);
        const got = distanceTransform(mask);
        const want = bruteForce(mask);
        for (let i = 0; i < got.length; i++) expect(got[i]).toBeCloseTo(want[i], 5);
      }
    }
  });

  it('treats pixels outside the image as background', () => {
    const mask: Mask = { width: 5, height: 5, data: new Uint8Array(25).fill(1) };
    const d = distanceTransform(mask);
    expect(d[0]).toBe(1);
    expect(d[2 * 5 + 2]).toBe(3);
    expect(d[1 * 5 + 1]).toBe(2);
  });

  it('returns zeros for an empty mask and 0 on background pixels', () => {
    const mask: Mask = { width: 6, height: 4, data: new Uint8Array(24) };
    expect(Array.from(distanceTransform(mask)).every((v) => v === 0)).toBe(true);
  });

  it('is exact for a disk (distance to the circular boundary)', () => {
    const w = 101, h = 101, cx = 50, cy = 50, R = 40;
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = (x - cx) ** 2 + (y - cy) ** 2 <= R * R ? 1 : 0;
    const d = distanceTransform({ width: w, height: h, data });
    expect(d[cy * w + cx]).toBeGreaterThan(R);
    expect(d[cy * w + cx]).toBeLessThan(R + 1.5);
    // Pixel on the rim is one step from the background.
    expect(d[cy * w + cx + R]).toBe(1);
  });

  it('is fast enough for 1024×1024', () => {
    const w = 1024, h = 1024;
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = (x - 512) ** 2 + (y - 512) ** 2 < 400 ** 2 ? 1 : 0;
    const t0 = performance.now();
    distanceTransform({ width: w, height: h, data });
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('unionOfSpheres', () => {
  it('turns a single radius into a hemisphere', () => {
    const w = 41, h = 41, c = 20, R = 15;
    const radius = new Float32Array(w * h);
    radius[c * w + c] = R;
    const out = unionOfSpheres(radius, w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const r2 = (x - c) ** 2 + (y - c) ** 2;
        expect(out[y * w + x]).toBeCloseTo(r2 < R * R ? Math.sqrt(R * R - r2) : 0, 4);
      }
  });

  it('matches brute force on random radii', () => {
    const rand = rng(7);
    const w = 23, h = 17;
    const radius = new Float32Array(w * h);
    for (let i = 0; i < radius.length; i++) radius[i] = rand() < 0.2 ? rand() * 8 : 0;
    const out = unionOfSpheres(radius, w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let best = 0;
        for (let cy = 0; cy < h; cy++)
          for (let cx = 0; cx < w; cx++) {
            const r = radius[cy * w + cx];
            best = Math.max(best, r * r - (x - cx) ** 2 - (y - cy) ** 2);
          }
        expect(out[y * w + x]).toBeCloseTo(Math.sqrt(best), 3);
      }
  });

  it('never rises above zero outside the silhouette when fed a distance transform', () => {
    const rand = rng(3);
    const mask = randomMask(30, 30, 0.8, rand);
    const d = distanceTransform(mask);
    const out = unionOfSpheres(d, 30, 30);
    for (let i = 0; i < out.length; i++) {
      if (!mask.data[i]) expect(out[i]).toBe(0);
      else expect(out[i]).toBeGreaterThanOrEqual(d[i] - 1e-4);
    }
  });
});
