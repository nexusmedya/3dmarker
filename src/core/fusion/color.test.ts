import { describe, expect, it } from 'vitest';
import { buildAdjacency } from './meshOps';
import { meshDepthBuffer, meshVisibility, SRGB_TO_LINEAR, viewGains, type ColorSource } from './color';
import type { ViewProjection } from './frame';

/** A source looking along +Z (the front): image x = world X, image y = −world Y, 1 px per world unit, 64² crop at the origin. */
function frontSource(over: Partial<ColorSource> = {}, proj: Partial<ViewProjection> = {}): ColorSource {
  return {
    proj: { ua: 0, va: 1, wa: 2, su: 1, ou: 32, sv: -1, ov: 32, ws: 1, ...proj },
    image: { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) },
    x0: 0,
    y0: 0,
    weight: new Float32Array(64 * 64).fill(1),
    edge: 2,
    dir: [0, 0, 1],
    priority: 1,
    hits: null,
    ...over,
  };
}

/** Two squares facing +Z: a small one at z = 5 in front of a big one at z = 0. */
function stacked() {
  const quad = (x0: number, y0: number, x1: number, y1: number, z: number) => [x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z];
  const positions = new Float32Array([...quad(-20, -20, 20, 20, 0), ...quad(-5, -5, 5, 5, 5)]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return { positions, indices };
}

describe('mesh depth buffers', () => {
  it('rasterises the nearest surface per cell and hides what lies behind it', () => {
    const { positions, indices } = stacked();
    const src = frontSource();
    const db = meshDepthBuffer(positions, indices, src);
    expect(db.cell).toBe(1);
    // Centre: the small square; beside it the big one; outside both nothing.
    expect(db.depth[32 + 64 * 32]).toBeCloseTo(5, 5);
    expect(db.depth[45 + 64 * 32]).toBeCloseTo(0, 5);
    expect(db.depth[60 + 64 * 32]).toBe(-Infinity);
    const at = (x: number, y: number, z: number) => meshVisibility(src, db, new Float64Array([x, y, z]), 1, 1);
    expect(at(0, 0, 5)).toBe(1); // the small square itself
    expect(at(0, 0, 0)).toBe(0); // the big square behind it
    expect(at(15, 0, 0)).toBe(1); // the big square where nothing covers it
    // Right next to the small square's outline its pixels may show the small square: hidden (edge radius 2 px).
    expect(at(6.5, 0, 0)).toBe(0);
    expect(at(9, 0, 0)).toBe(1);
  });

  it('gives a slanted surface its own depth span as tolerance', () => {
    // One big triangle strip rising 0.8 per unit along X (facing ≈ 0.78): every point of it is visible.
    const positions = new Float32Array([-20, -20, -16, 20, -20, 16, 20, 20, 16, -20, 20, -16]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const src = frontSource();
    const db = meshDepthBuffer(positions, indices, src);
    const f = 1 / Math.hypot(1, 0.8);
    for (const x of [-15.3, -2.7, 0.1, 9.9, 14.5]) expect(meshVisibility(src, db, new Float64Array([x, 3.3, 0.8 * x]), f, 1)).toBe(1);
  });
});

describe('viewGains (per-view exposure)', () => {
  /** A chain of n vertices (a path graph). */
  const chain = (n: number) => {
    const idx: number[] = [];
    for (let v = 0; v + 2 < n; v++) idx.push(v, v + 1, v + 2);
    return buildAdjacency(n, new Uint32Array(idx));
  };
  const sources = [frontSource(), frontSource({ dir: [1, 0, 0], priority: 0.8 }, { ua: 2, wa: 0, su: -1 })];
  const toLinear = (c: number) => SRGB_TO_LINEAR[Math.max(0, Math.min(255, Math.round(c)))];

  /** Front sees vertices 0..139, the side 100..219; the side's pixels are the front's times `gain` (sRGB), or `other`. */
  function setup(gain: [number, number, number], other?: (v: number) => [number, number, number]) {
    const n = 220, S = 2;
    const smp = new Float32Array(n * S * 3), qual = new Float32Array(n * S);
    const base = (v: number): [number, number, number] => [120 + (v % 7) * 12, 90 + (v % 5) * 20, 60 + (v % 3) * 30];
    for (let v = 0; v < n; v++) {
      const c = base(v);
      if (v < 140) {
        qual[v * S] = 0.9;
        for (let k = 0; k < 3; k++) smp[3 * (v * S) + k] = toLinear(c[k]);
      }
      if (v >= 100) {
        qual[v * S + 1] = 0.9;
        const d = other ? other(v) : c.map((x, k) => x * gain[k]);
        for (let k = 0; k < 3; k++) smp[3 * (v * S + 1) + k] = toLinear(d[k]);
      }
    }
    return viewGains(smp, qual, sources, chain(n));
  }

  it('recovers another exposure / white balance of a view', () => {
    const g = setup([1.12, 0.9, 1.05]);
    expect(g[0]).toEqual([1, 1, 1]);
    expect(g[1][0]).toBeCloseTo(1 / 1.12, 2);
    expect(g[1][1]).toBeCloseTo(1 / 0.9, 2);
    expect(g[1][2]).toBeCloseTo(1 / 1.05, 2);
  });

  it('leaves a view alone that shows other colours, not another exposure', () => {
    expect(setup([1, 1, 1], () => [200, 30, 30])[1]).toEqual([1, 1, 1]);
    expect(setup([1, 1, 1])[1]).toEqual([1, 1, 1]); // and one that matches already
  });
});
