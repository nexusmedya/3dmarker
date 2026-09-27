import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import type { DepthMap, Mask } from '../../core/types';
import { autoBoxiness, buildDepthVolume, fitRelief, silhouetteStats, stitchClosedSurface } from './volume';

function maskFrom(w: number, h: number, inside: (x: number, y: number) => boolean): Mask {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = inside(x + 0.5, y + 0.5) ? 1 : 0;
  return { width: w, height: h, data };
}

const disk = (w: number, h: number, cx: number, cy: number, r: number) => maskFrom(w, h, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r);

/** A "car" side silhouette: a long body, a cabin on top, wheels below. */
const car = (w: number, h: number) =>
  maskFrom(w, h, (x, y) => {
    const body = x > 0.06 * w && x < 0.94 * w && y > 0.45 * h && y < 0.8 * h;
    const cabin = x > 0.3 * w && x < 0.72 * w && y > 0.25 * h && y <= 0.45 * h;
    const wheel = (cx: number) => (x - cx) ** 2 + (y - 0.8 * h) ** 2 < (0.1 * h) ** 2;
    return body || cabin || wheel(0.25 * w) || wheel(0.75 * w);
  });

function depthFrom(mask: Mask, f: (x: number, y: number) => number): DepthMap {
  const { width: w, height: h } = mask;
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask.data[y * w + x]) data[y * w + x] = f(x + 0.5, y + 0.5);
  return { width: w, height: h, data };
}

/** Every directed edge appears once and its reverse once: closed, consistently oriented 2-manifold. */
function expectWatertight(g: BufferGeometry) {
  const idx = g.getIndex()!.array;
  const n = g.getAttribute('position').count;
  const edges = new Map<number, number>();
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e], b = idx[t + ((e + 1) % 3)];
      expect(a).not.toBe(b);
      const k = a * n + b;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const [k, c] of edges) {
    const a = Math.floor(k / n), b = k % n;
    if (c !== 1 || edges.get(b * n + a) !== 1) bad++;
  }
  expect(bad).toBe(0);
}

/** Signed volume (divergence theorem); > 0 = outward-facing triangles. */
function signedVolume(g: BufferGeometry): number {
  const p = g.getAttribute('position');
  const idx = g.getIndex()!.array;
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
    const ax = p.getX(a), ay = p.getY(a), az = p.getZ(a);
    const bx = p.getX(b), by = p.getY(b), bz = p.getZ(b);
    const cx = p.getX(c), cy = p.getY(c), cz = p.getZ(c);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

const size = (g: BufferGeometry) => {
  g.computeBoundingBox();
  const b = g.boundingBox!;
  return { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z, minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z };
};

/** Largest front-surface z (group 0) near image point (x, y) in grid pixels. */
function zNear(g: BufferGeometry, mask: Mask, x: number, y: number, group: 0 | 1): number {
  const L = Math.max(mask.width, mask.height), s = 2 / L;
  const X = (x - mask.width / 2) * s, Y = (mask.height / 2 - y) * s;
  const p = g.getAttribute('position');
  const grp = g.groups[group];
  const idx = g.getIndex()!.array;
  let best = Infinity, z = 0;
  for (let i = grp.start; i < grp.start + grp.count; i++) {
    const v = idx[i];
    const d = (p.getX(v) - X) ** 2 + (p.getY(v) - Y) ** 2;
    if (d < best) {
      best = d;
      z = p.getZ(v);
    }
  }
  return z;
}

describe('silhouette statistics', () => {
  it('a disk is round, a car side view is boxy', () => {
    const d = silhouetteStats(disk(64, 64, 32, 32, 28));
    expect(d.fill).toBeCloseTo(Math.PI / 4, 1);
    expect(autoBoxiness(d)).toBe(0);
    const c = silhouetteStats(car(192, 80));
    expect(c.aspect).toBeGreaterThan(2);
    expect(autoBoxiness(c)).toBeGreaterThan(0.3);
  });

  it('fitRelief: recovers an affine map and keeps a positive gain for anti-correlated depth', () => {
    const F = new Float32Array([0, 0.25, 0.5, 0.75, 1]);
    const t = new Float32Array([1, 1.5, 2, 2.5, 3]);
    const w = new Float32Array(5).fill(1);
    const { a, b } = fitRelief(F, t, w);
    expect(a).toBeCloseTo(2, 5);
    expect(b).toBeCloseTo(1, 5);
    const anti = fitRelief(F, new Float32Array([3, 2.5, 2, 1.5, 1]), w);
    expect(anti.a).toBeGreaterThan(0);
    expect(fitRelief(new Float32Array(5).fill(0.5), t, w).a).toBe(0);
  });
});

describe('buildDepthVolume', () => {
  it('a round silhouette without depth becomes a closed ball (depth ≈ width)', () => {
    const mask = disk(96, 96, 48, 48, 40);
    const { geometry, info } = buildDepthVolume(mask, null);
    expectWatertight(geometry);
    expect(signedVolume(geometry)).toBeGreaterThan(0);
    const b = size(geometry);
    expect(b.z / b.x).toBeGreaterThan(0.8);
    expect(b.z / b.x).toBeLessThan(1.2);
    expect(Math.abs(b.maxZ + b.minZ)).toBeLessThan(0.05); // symmetric about z = 0
    // Shared frame: the 96 px image spans 2 units, the 80 px disk ~1.67.
    expect(b.x).toBeGreaterThan(1.55);
    expect(b.x).toBeLessThan(1.72);
    expect(info.usedDepth).toBe(false);
    const volume = signedVolume(geometry);
    const r = 40 * (2 / 96);
    expect(volume / ((4 / 3) * Math.PI * r ** 3)).toBeGreaterThan(0.75); // close to a sphere
    expect(geometry.getAttribute('uv').count).toBe(geometry.getAttribute('position').count);
    expect(geometry.groups.map((g) => g.materialIndex)).toEqual([0, 1, 2]);
  });

  it('adds the ML relief to the front (calibrated) and a smoothed share of it to the back', () => {
    const mask = disk(96, 96, 48, 48, 40);
    // Dome plus a sharp "nose" bump at (48, 40).
    const nose = (x: number, y: number) => 0.35 * Math.exp(-((x - 48) ** 2 + (y - 40) ** 2) / 18);
    const dome = (x: number, y: number) => Math.sqrt(Math.max(0, 1 - ((x - 48) ** 2 + (y - 48) ** 2) / 1600));
    const depth = depthFrom(mask, (x, y) => (0.6 * dome(x, y) + nose(x, y)) / 0.95);
    const plain = buildDepthVolume(mask, null).geometry;
    const { geometry, info } = buildDepthVolume(mask, depth, { shape: 'auto', thickness: 0, backDetail: 0.5, depthScale: 0 });
    expectWatertight(geometry);
    expect(info.usedDepth).toBe(true);
    expect(info.reliefGain).toBeGreaterThan(0);
    const frontNose = zNear(geometry, mask, 48, 40, 0) - zNear(plain, mask, 48, 40, 0);
    const backNose = -zNear(geometry, mask, 48, 40, 1) - -zNear(plain, mask, 48, 40, 1);
    expect(frontNose).toBeGreaterThan(0.03); // the nose sticks out
    expect(Math.abs(backNose)).toBeLessThan(frontNose); // mirrored, smoothed and halved
    // Relief amplitude is proportional to the body: the depth is not wider than ~1.5× the width.
    const b = size(geometry);
    expect(b.z / b.x).toBeLessThan(1.5);

    const opts0 = { shape: 'auto' as const, thickness: 0, backDetail: 0, depthScale: 0 };
    const flatBack = buildDepthVolume(mask, depth, opts0).geometry;
    const plainFlat = buildDepthVolume(mask, null, opts0).geometry;
    expect(Math.abs(zNear(flatBack, mask, 48, 40, 1) - zNear(plainFlat, mask, 48, 40, 1))).toBeLessThan(1e-6);
    const strong = buildDepthVolume(mask, depth, { shape: 'auto', thickness: 0, backDetail: 0.5, depthScale: 2 }).geometry;
    expect(zNear(strong, mask, 48, 40, 0)).toBeGreaterThan(zNear(geometry, mask, 48, 40, 0));
  });

  it('a car silhouette becomes a boxy volume (steeper sides than a balloon)', () => {
    const mask = car(192, 80);
    const round = buildDepthVolume(mask, null, { shape: 'round', thickness: 1, backDetail: 0.5, depthScale: 0 }).geometry;
    const auto = buildDepthVolume(mask, null);
    expectWatertight(auto.geometry);
    expect(auto.info.boxiness).toBeGreaterThan(0.3);
    // Near the bottom edge of the body the boxy profile is already much thicker (relative to its centre).
    const ratio = (g: BufferGeometry) => zNear(g, mask, 96, 0.76 * 80, 0) / zNear(g, mask, 96, 0.6 * 80, 0);
    expect(ratio(auto.geometry)).toBeGreaterThan(ratio(round) + 0.05);
    const b = size(auto.geometry);
    expect(b.x).toBeGreaterThan(1.7); // longest side of the image = 2
    expect(b.z).toBeGreaterThan(0.2 * b.x);
  });

  it('stays watertight with holes, diagonal pinches, islands and single pixels', () => {
    const mask = maskFrom(40, 30, (x, y) => {
      const ring = (x - 12) ** 2 + (y - 12) ** 2 < 81 && (x - 12) ** 2 + (y - 12) ** 2 > 16;
      const a = x > 24 && x < 30 && y > 4 && y < 10;
      const bq = x > 30 && x < 36 && y > 10 && y < 16; // touches `a` only at a corner
      const dot = Math.floor(x) === 5 && Math.floor(y) === 26;
      const line = Math.floor(y) === 24 && x > 20 && x < 38;
      return ring || a || bq || dot || line;
    });
    const depth = depthFrom(mask, (x, y) => ((x * 7 + y * 13) % 10) / 10);
    const { geometry } = buildDepthVolume(mask, depth);
    expectWatertight(geometry);
    expect(signedVolume(geometry)).toBeGreaterThan(0);
  });

  it('stitchClosedSurface: a flat slab has the expected thickness and outward orientation', () => {
    const mask = maskFrom(10, 10, (x, y) => x > 2 && x < 8 && y > 2 && y < 8);
    const f = new Float32Array(100).fill(0.1), b = new Float32Array(100).fill(0.2);
    const g = stitchClosedSurface(mask, f, b, 0.2);
    expectWatertight(g);
    const s = size(g);
    expect(s.maxZ).toBeCloseTo(0.1, 5);
    expect(s.minZ).toBeCloseTo(-0.2, 5);
    expect(signedVolume(g)).toBeGreaterThan(0);
  });
});
