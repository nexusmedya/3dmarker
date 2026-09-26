import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import type { DriverInput, Mask, RGBAImage } from '../../core/types';
import { AbortError, defaultParams } from '../../core/types';
import { findIntersectingRings, pointInPolygon, polygonArea } from '../../core/image/contours';
import { computeMeshStats } from '../../core/mesh/stats';
import type { Point } from '../../core/image/contours';
import {
  DEFAULT_EXTRUDE_OPTIONS, extrudeDriver, extrudeMask, extrudeOutline, fitBevel, insetRing, MAX_RINGS, traceOutline,
  type ExtrudeOptions,
} from './extrude';
import { LocalizedError } from './inflate';

function maskOf(w: number, h: number, inside: (x: number, y: number) => boolean): Mask {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = inside(x + 0.5, y + 0.5) ? 1 : 0;
  return { width: w, height: h, data };
}

function imageOf(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(px(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}

const opts = (o: Partial<ExtrudeOptions> = {}): ExtrudeOptions => ({ ...DEFAULT_EXTRUDE_OPTIONS, ...o });

function input(image: RGBAImage, mask: Mask | null, params = {}, signal = new AbortController().signal): DriverInput {
  return {
    image, mask, file: new Blob(), views: {}, signal, onProgress: () => {},
    params: { ...defaultParams(extrudeDriver.params), ...params },
  };
}

type V3 = [number, number, number];
interface Tri { a: V3; b: V3; c: V3; n: V3[] }

function triangles(g: BufferGeometry): Tri[] {
  const idx = g.index!.array, pos = g.getAttribute('position'), nrm = g.getAttribute('normal');
  const v = (i: number): V3 => [pos.getX(i), pos.getY(i), pos.getZ(i)];
  const n = (i: number): V3 => [nrm.getX(i), nrm.getY(i), nrm.getZ(i)];
  const out: Tri[] = [];
  for (let t = 0; t < idx.length; t += 3) out.push({ a: v(idx[t]), b: v(idx[t + 1]), c: v(idx[t + 2]), n: [n(idx[t]), n(idx[t + 1]), n(idx[t + 2])] });
  return out;
}

const cross = (t: Tri): V3 => {
  const u = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]], v = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]];
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
};

/** Point-in-triangle test in XY. */
function coversXY(t: Tri, x: number, y: number): boolean {
  const s = (p: V3, q: V3) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
  const d1 = s(t.a, t.b), d2 = s(t.b, t.c), d3 = s(t.c, t.a);
  return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
}

/** Every edge (welded by exact position) is used by exactly two triangles, once in each direction. */
function isClosedManifold(g: BufferGeometry): boolean {
  const key = (v: V3) => v.join(',');
  const edges = new Map<string, number>();
  for (const t of triangles(g)) {
    const vs = [key(t.a), key(t.b), key(t.c)];
    for (let i = 0; i < 3; i++) {
      const e = vs[i] + '|' + vs[(i + 1) % 3];
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
  }
  for (const [e, n] of edges) {
    const [a, b] = e.split('|');
    if (n !== 1 || edges.get(b + '|' + a) !== 1) return false;
  }
  return true;
}

const signedVolume = (g: BufferGeometry) => triangles(g).reduce((s, t) =>
  s + (t.a[0] * (t.b[1] * t.c[2] - t.b[2] * t.c[1]) - t.a[1] * (t.b[0] * t.c[2] - t.b[2] * t.c[0]) + t.a[2] * (t.b[0] * t.c[1] - t.b[1] * t.c[0])) / 6, 0);

// Annulus: outer radius 50 px, inner 25 px, in a 128² image (1 unit = 64 px).
const S = 128, C = 64, RO = 50, RI = 25;
const ring = maskOf(S, S, (x, y) => Math.hypot(x - C, y - C) < RO && Math.hypot(x - C, y - C) > RI);
const ringArea = Math.PI * ((RO / 64) ** 2 - (RI / 64) ** 2);

describe('extrudeMask', () => {
  for (const bevel of [0, 0.01]) {
    describe(bevel ? 'with bevel' : 'without bevel', () => {
      const o = opts({ bevel, thickness: 0.1 });
      const g = extrudeMask(ring, o);
      const T = 0.2;
      const tris = triangles(g);

      it('builds a valid indexed geometry within the frame', () => {
        expect(g.index).not.toBeNull();
        expect(tris.length).toBeGreaterThan(100);
        const box = g.boundingBox!;
        expect(box.min.z).toBeCloseTo(-T / 2, 5);
        expect(box.max.z).toBeCloseTo(T / 2, 5);
        for (const v of [box.max.x, box.max.y, -box.min.x, -box.min.y]) expect(Math.abs(v - RO / 64)).toBeLessThan(0.02);
        const uv = g.getAttribute('uv'), pos = g.getAttribute('position');
        for (let i = 0; i < uv.count; i++) {
          expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
          expect(uv.getX(i)).toBeLessThanOrEqual(1);
          // Square image: u = (x + 1) / 2, v = (y + 1) / 2.
          expect(uv.getX(i)).toBeCloseTo((pos.getX(i) + 1) / 2, 5);
          expect(uv.getY(i)).toBeCloseTo((pos.getY(i) + 1) / 2, 5);
        }
      });

      it('is closed, outward-facing and has the expected volume', () => {
        expect(isClosedManifold(g)).toBe(true);
        const vol = signedVolume(g);
        expect(vol).toBeGreaterThan(0);
        expect(vol / (ringArea * T)).toBeGreaterThan(bevel ? 0.8 : 0.97);
        expect(vol / (ringArea * T)).toBeLessThan(1.01);
      });

      it('has unit normals that agree with the winding; flat front/back faces', () => {
        for (const t of tris) {
          const f = cross(t);
          for (const n of t.n) {
            expect(Math.hypot(...n)).toBeCloseTo(1, 4);
            expect(n[0] * f[0] + n[1] * f[1] + n[2] * f[2]).toBeGreaterThanOrEqual(-1e-12);
          }
        }
        const front = tris.filter((t) => [t.a, t.b, t.c].every((v) => Math.abs(v[2] - T / 2) < 1e-6));
        expect(front.length).toBeGreaterThan(10);
        for (const t of front) {
          expect(cross(t)[2]).toBeGreaterThan(0);
          for (const n of t.n) expect(n[2]).toBe(1);
        }
      });

      it('keeps the hole open', () => {
        const caps = tris.filter((t) => [t.a, t.b, t.c].every((v) => Math.abs(Math.abs(v[2]) - T / 2) < 1e-6));
        expect(caps.some((t) => coversXY(t, 0, 0))).toBe(false);
        const mid = (RO + RI) / 2 / 64;
        expect(caps.filter((t) => coversXY(t, mid, 0.01))).toHaveLength(2); // front + back
      });
    });
  }

  it('reduces the bevel only on thin parts, and the front face never folds', () => {
    // A big block next to 5 px wide letter-like strokes; bevel = 10 px.
    const m = maskOf(200, 100, (x, y) => (x > 10 && x < 90 && y > 10 && y < 90) || (x > 120 && x < 125 && y > 10 && y < 90) ||
      (x > 120 && x < 190 && y > 45 && y < 50));
    for (const smooth of [0, 1]) {
      const g = extrudeMask(m, opts({ smooth, bevel: 0.05, thickness: 0.2 }));
      const T = 0.4;
      const front = triangles(g).filter((t) => [t.a, t.b, t.c].every((v) => Math.abs(v[2] - T / 2) < 1e-6));
      for (const t of front) expect(cross(t)[2]).toBeGreaterThanOrEqual(0);
      expect(isClosedManifold(g)).toBe(true);
      // The block (x ∈ [−0.9, −0.1]) keeps the full 0.1 inset on its front face.
      const blockX = front.flatMap((t) => [t.a[0], t.b[0], t.c[0]]).filter((x) => x < 0);
      expect(Math.min(...blockX)).toBeGreaterThan(-0.81);
      expect(Math.min(...blockX)).toBeLessThan(-0.79);
    }
  });

  it('stays closed when the bevel is wider than a thin ring (inset rings would swap nesting)', () => {
    for (const width of [2, 5, 8]) {
      const thin = maskOf(128, 128, (x, y) => Math.hypot(x - 64, y - 64) < 50 && Math.hypot(x - 64, y - 64) > 50 - width);
      for (const smooth of [0, 1]) {
        const g = extrudeMask(thin, opts({ smooth, bevel: 0.04, bevelSegments: 2 }));
        expect(isClosedManifold(g)).toBe(true);
        expect(signedVolume(g)).toBeGreaterThan(0);
      }
    }
  });

  it('fits the bevel: removes folding pixel chamfers, shrinks it for thin strokes', () => {
    // 20×20 square with 0.5 px corner cuts (y-up, clockwise).
    const sq: Point[] = [[0, 0.5], [0, 19.5], [0.5, 20], [19.5, 20], [20, 19.5], [20, 0.5], [19.5, 0], [0.5, 0]];
    const cut = fitBevel([sq], 3);
    expect(cut.size).toBe(3);
    // Each chamfer collapses back into the true corner.
    expect(cut.rings[0].map((p) => p.join(',')).sort()).toEqual(['0,0', '0,20', '20,0', '20,20']);
    expect(Math.abs(polygonArea(insetRing(cut.rings[0], 3)))).toBeCloseTo(14 * 14, 6);
    // 4 units wide bar: a bevel of 3 would cross over, so it shrinks below 2.
    const bar: Point[] = [[0, 0], [0, 4], [40, 4], [40, 0]];
    const thin = fitBevel([bar], 3);
    expect(thin.size).toBeGreaterThan(0);
    expect(thin.size).toBeLessThan(2);
  });

  it('keeps landscape images in the frame and drops small specks', () => {
    const m = maskOf(200, 100, (x, y) => (x > 20 && x < 180 && y > 20 && y < 80) || Math.hypot(x - 5, y - 5) < 2);
    const groups = traceOutline(m, opts({ smooth: 0, minArea: 0.1 }));
    expect(groups).toHaveLength(1);
    expect(findIntersectingRings(groups.map((g) => g.outer)).size).toBe(0);
    expect(polygonArea(groups[0].outer)).toBeGreaterThan(0);
    const box = extrudeMask(m, opts({ minArea: 0.1 })).boundingBox!;
    expect(box.min.x).toBeCloseTo(-0.8, 1);
    expect(box.max.x).toBeCloseTo(0.8, 1);
    expect(box.max.y).toBeCloseTo(0.3, 1);
  });

  it('handles shapes touching the image border', () => {
    const g = extrudeMask(maskOf(64, 64, () => true), opts({ bevel: 0 }));
    const box = g.boundingBox!;
    expect(box.min.x).toBeCloseTo(-1, 5);
    expect(box.max.y).toBeCloseTo(1, 5);
    expect(isClosedManifold(g)).toBe(true);
  });

  it('smooths pixel stair-steps', () => {
    const disk = maskOf(256, 256, (x, y) => Math.hypot(x - 128, y - 128) < 100);
    const rough = traceOutline(disk, opts({ smooth: 0, simplify: 0 }))[0].outer;
    const smooth = traceOutline(disk, opts({ smooth: 2, simplify: 0 }))[0].outer;
    const dev = (pts: [number, number][]) => Math.max(...pts.map(([x, y]) => Math.abs(Math.hypot(x - 128, y - 128) - 100)));
    expect(dev(smooth)).toBeLessThan(dev(rough));
    expect(dev(smooth)).toBeLessThan(0.3);
  });

  it('stays watertight on pixel art with exact outlines (cap T-junctions are split)', () => {
    // Pixel-aligned cells give ring vertices exactly collinear with other rings'
    // edges, where earcut skips a vertex that the side walls still use.
    let s = 1994;
    const r = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const cells = 12 + Math.floor(r() * 30);
    const on: boolean[] = [];
    for (let i = 0; i < cells * cells; i++) on.push(r() < 0.5);
    const cs = 1024 / cells;
    const m = maskOf(1024, 1024, (x, y) => on[Math.floor(y / cs) * cells + Math.floor(x / cs)]);
    const area = m.data.reduce((n, v) => n + v, 0) * (2 / 1024) ** 2;
    for (const bevel of [0.01, 0]) {
      const g = extrudeMask(m, opts({ smooth: 0, bevel }));
      expect(computeMeshStats(g).watertight).toBe(true);
      expect(isClosedManifold(g)).toBe(true);
      // Splitting cap triangles adds no area and flips nothing.
      const vol = signedVolume(g) / (area * 0.2);
      expect(vol).toBeGreaterThan(bevel ? 0.9 : 0.99);
      expect(vol).toBeLessThan(1.001);
      for (const t of triangles(g)) if ([t.a, t.b, t.c].every((v) => v[2] > 0.1 - 1e-6)) expect(cross(t)[2]).toBeGreaterThan(0);
    }
  });

  it('caps the ring count so noisy masks cannot hang the tab (keeps the largest rings)', () => {
    // Vitest's default 5s per-test timeout has no headroom over the 15s
    // assertion below on a loaded/shared CI runner; give it real slack (see
    // the explicit timeout argument at the end of this test).
    // Dithered 55 % alpha, no smoothing, no minimum size: ~20k rings before the cap
    // (the earcut hole bridging then ran for minutes).
    let s = 7;
    const r = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const S2 = 512;
    const data = new Uint8Array(S2 * S2);
    for (let i = 0; i < data.length; i++) data[i] = r() < 0.55 ? 1 : 0;
    const m: Mask = { width: S2, height: S2, data };
    const o = opts({ smooth: 0, minArea: 0 });
    const t0 = performance.now();
    const groups = traceOutline(m, o);
    expect(groups.reduce((n, g) => n + 1 + g.holes.length, 0)).toBe(MAX_RINGS);
    for (const g of groups) for (const h of g.holes) expect(pointInPolygon(h[0][0], h[0][1], g.outer)).toBe(true);
    const g = extrudeMask(m, o);
    expect(performance.now() - t0).toBeLessThan(15000); // ~1.5 s
    expect(computeMeshStats(g).watertight).toBe(true);
  }, 20000);

  it('keeps holes inside their part when the point cap forces coarse outlines', () => {
    // 32² checker of 4 px squares: 1 part with 18 holes. A tiny maxPoints used
    // to collapse the part to a triangle leaving half of the holes outside it.
    const m = maskOf(32, 32, (x, y) => (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 1);
    for (const maxPoints of [10, 57]) {
      const o = opts({ smooth: 16, maxPoints });
      const groups = traceOutline(m, o);
      expect(groups.reduce((n, g) => n + g.holes.length, 0)).toBe(18);
      for (const g of groups) for (const h of g.holes) expect(pointInPolygon(h[0][0], h[0][1], g.outer)).toBe(true);
      expect(computeMeshStats(extrudeOutline(groups, 32, 32, o)).watertight).toBe(true);
    }
  });

  it('fits the bevel quickly on a part with thousands of holes', () => {
    const outer: Point[] = [[0, 0], [0, 100], [100, 100], [100, 0]];
    const holes: Point[][] = [];
    for (let j = 0; j < 45; j++) for (let i = 0; i < 45; i++) {
      const x = 1 + i * 2.2, y = 1 + j * 2.2;
      holes.push([[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]]);
    }
    const t0 = performance.now();
    const fit = fitBevel([outer, ...holes], 0.3);
    expect(performance.now() - t0).toBeLessThan(600); // ~70 ms; all-pairs point-in-polygon took ~1.6 s
    expect(fit.size).toBe(0.3);
    expect(fitBevel([outer, ...holes], 1).size).toBeLessThan(0.6); // 1.2 wide bars
  });

  it('is fast enough on 1024²', () => {
    const m = maskOf(1024, 1024, (x, y) => {
      const r = Math.hypot(x - 512, y - 512);
      return r < 450 && !(Math.abs(x - 512) < 60 && Math.abs(y - 300) < 120) && Math.hypot(x - 700, y - 650) > 80;
    });
    const t0 = performance.now();
    const g = extrudeMask(m, opts());
    expect(g.index!.count).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(5000); // typically well under 1 s
  }, 20000); // vitest's default 5s test timeout left no headroom over the assertion above
});

describe('extrudeDriver', () => {
  it('declares the contract fields', () => {
    expect(extrudeDriver.id).toBe('silhouette-extrude');
    expect(extrudeDriver.category).toBe('heuristic');
    expect(extrudeDriver.producesDepth).toBe(false);
    expect(extrudeDriver.badges).toEqual(['offline', 'closed-mesh']);
    for (const p of extrudeDriver.params) {
      expect(p.label.tr).toBeTruthy();
      expect(p.label.en).toBeTruthy();
    }
  });

  it('extrudes an opaque logo on a plain background (auto mask)', async () => {
    const img = imageOf(96, 96, (x, y) => {
      const r = Math.hypot(x + 0.5 - 48, y + 0.5 - 48);
      return r < 36 && r > 16 ? [20, 60, 200, 255] : [255, 255, 255, 255];
    });
    const labels: string[] = [];
    const res = await extrudeDriver.run({ ...input(img, null), onProgress: (p) => labels.push(p.label.en) });
    expect(res.kind).toBe('geometry');
    if (res.kind !== 'geometry') return;
    expect(res.geometry.index!.count).toBeGreaterThan(0);
    expect(isClosedManifold(res.geometry)).toBe(true);
    expect(labels.at(-1)).toBe('Done');
  });

  it('uses the given mask (resized to the image)', async () => {
    const img = imageOf(64, 64, () => [0, 0, 0, 255]);
    const res = await extrudeDriver.run(input(img, maskOf(32, 32, (x, y) => x > 8 && x < 24 && y > 8 && y < 24)));
    expect(res.kind).toBe('geometry');
    if (res.kind !== 'geometry') return;
    expect(res.geometry.boundingBox!.max.x).toBeCloseTo(0.5, 1);
  });

  it('explains missing silhouettes and missing parts', async () => {
    const busy = imageOf(64, 64, (x, y) => [x * 4, y * 4, (x * y) % 256, 255]);
    const err = await extrudeDriver.run(input(busy, null)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalizedError);
    const tiny = maskOf(64, 64, (x, y) => Math.hypot(x - 32, y - 32) < 2);
    const err2 = await extrudeDriver.run(input(busy, tiny, { minArea: 1 })).catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(LocalizedError);
    expect((err2 as LocalizedError).i18n.en).toMatch(/Min\. part size/);
  });

  it('honours abort', async () => {
    const ac = new AbortController();
    ac.abort();
    const img = imageOf(8, 8, () => [0, 0, 0, 255]);
    await expect(extrudeDriver.run(input(img, maskOf(8, 8, () => true), {}, ac.signal))).rejects.toBeInstanceOf(AbortError);
  });
});
