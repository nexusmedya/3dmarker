import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import type { DepthMap, Mask } from '../types';
import { LocalizedError } from '../errors';
import { buildGeometryFromDepth, EMPTY_MESH, gridSize, MIN_THICKNESS, sampleDepthGrid } from './buildFromDepth';
import { DEFAULT_MESH_OPTIONS, type MeshMode, type MeshOptions } from './options';
import { computeMeshStats } from './stats';

const opts = (o: Partial<MeshOptions> = {}): MeshOptions => ({ ...DEFAULT_MESH_OPTIONS, resolution: 48, smoothing: 0, ...o });

function maskOf(w: number, h: number, inside: (x: number, y: number) => boolean): Mask {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = inside(x + 0.5, y + 0.5) ? 1 : 0;
  return { width: w, height: h, data };
}

function depthOf(w: number, h: number, f: (x: number, y: number) => number): DepthMap {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f(x + 0.5, y + 0.5);
  return { width: w, height: h, data };
}

// Shapes on a 96×96 image (centre C).
const N = 96, C = N / 2;
const r2 = (x: number, y: number) => (x - C) ** 2 + (y - C) ** 2;
const SHAPES: Record<string, Mask | null> = {
  rect: null,
  circle: maskOf(N, N, (x, y) => r2(x, y) <= 36 ** 2),
  ring: maskOf(N, N, (x, y) => r2(x, y) <= 40 ** 2 && r2(x, y) >= 18 ** 2),
  islands: maskOf(N, N, (x, y) => (x - 25) ** 2 + (y - C) ** 2 <= 16 ** 2 || (x - 71) ** 2 + (y - C) ** 2 <= 16 ** 2),
};
// Dome: 1 at the centre, 0 at radius 48.
const dome = depthOf(N, N, (x, y) => Math.max(0, 1 - r2(x, y) / 48 ** 2));
const MODES: MeshMode[] = ['relief', 'solid', 'double'];

const attr = (g: BufferGeometry, name: string) => g.getAttribute(name).array as Float32Array;
const tris = (g: BufferGeometry) => g.getIndex()!.count / 3;

/** Signed volume (divergence theorem); > 0 for a closed mesh with outward (CCW) winding. */
function signedVolume(g: BufferGeometry): number {
  const p = attr(g, 'position'), idx = g.getIndex()!.array;
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

function expectClean(g: BufferGeometry): void {
  for (const name of ['position', 'normal', 'uv']) for (const v of attr(g, name)) expect(Number.isFinite(v)).toBe(true);
  const n = attr(g, 'normal');
  for (let i = 0; i < n.length; i += 3) expect(Math.hypot(n[i], n[i + 1], n[i + 2])).toBeCloseTo(1, 4);
  // compaction: every vertex is referenced
  const used = new Uint8Array(g.getAttribute('position').count);
  for (const i of g.getIndex()!.array) used[i] = 1;
  expect(used.every((u) => u === 1)).toBe(true);
}

describe('gridSize', () => {
  it('gives the longest side `resolution` vertices and keeps the aspect', () => {
    expect(gridSize(200, 100, 64)).toEqual([64, 33]);
    expect(gridSize(100, 200, 64)).toEqual([33, 64]);
    expect(gridSize(1000, 1, 64)).toEqual([64, 2]);
    expect(gridSize(10, 10, 1)).toEqual([2, 2]);
  });
});

describe('buildGeometryFromDepth', () => {
  for (const [shape, mask] of Object.entries(SHAPES)) {
    for (const mode of MODES) {
      it(`${mode} / ${shape}: clean, in frame, watertight iff closed`, () => {
        const o = opts({ mode });
        const g = buildGeometryFromDepth(dome, mask, o);
        expect(tris(g)).toBeGreaterThan(0);
        expectClean(g);
        const S = o.depthScale * 2, gap = o.baseThickness * 2;
        const box = g.boundingBox!;
        expect(box.min.x).toBeGreaterThanOrEqual(-1 - 1e-6);
        expect(box.max.x).toBeLessThanOrEqual(1 + 1e-6);
        expect(box.min.y).toBeGreaterThanOrEqual(-1 - 1e-6);
        expect(box.max.y).toBeLessThanOrEqual(1 + 1e-6);
        const zMax = mode === 'double' ? S + gap / 2 : S;
        const zMin = mode === 'relief' ? 0 : mode === 'solid' ? -gap : -zMax;
        expect(box.max.z).toBeLessThanOrEqual(zMax + 1e-5);
        expect(box.min.z).toBeGreaterThanOrEqual(zMin - 1e-5);
        if (mode === 'solid') expect(box.min.z).toBeCloseTo(-gap, 6);

        const stats = computeMeshStats(g);
        expect(stats.triangles).toBe(tris(g));
        expect(stats.watertight).toBe(mode !== 'relief');
        if (mode !== 'relief') expect(signedVolume(g)).toBeGreaterThan(0);
        expect(g.userData).toEqual({ mode, gridWidth: 48, gridHeight: 48 });
      });
    }
  }

  it('relief of a full rectangle is the whole grid with UVs matching the image position', () => {
    const g = buildGeometryFromDepth(dome, null, opts());
    expect(tris(g)).toBe(2 * 47 * 47);
    expect(g.getAttribute('position').count).toBe(48 * 48);
    expect(g.groups).toEqual([{ start: 0, count: 3 * tris(g), materialIndex: 0 }]);
    const p = attr(g, 'position'), uv = attr(g, 'uv'), n = attr(g, 'normal');
    for (let v = 0; v < p.length / 3; v++) {
      expect(uv[v * 2]).toBeCloseTo((p[v * 3] + 1) / 2, 5);
      expect(uv[v * 2 + 1]).toBeCloseTo((p[v * 3 + 1] + 1) / 2, 5);
      expect(n[v * 3 + 2]).toBeGreaterThan(0); // front faces the viewer
    }
    const box = g.boundingBox!;
    expect([box.min.x, box.max.x, box.min.y, box.max.y]).toEqual([-1, 1, -1, 1]);
  });

  it('solid of a constant slab has the exact expected volume and a flat back', () => {
    const flat = depthOf(32, 32, () => 0.5);
    const o = opts({ mode: 'solid', depthScale: 0.25, baseThickness: 0.02 });
    const g = buildGeometryFromDepth(flat, null, o);
    // area 2×2, height 0.5·0.5 + 0.04
    expect(signedVolume(g)).toBeCloseTo(4 * (0.25 + 0.04), 5);
    expect(g.groups.map((gr) => gr.materialIndex)).toEqual([0, 1, 2]);
    const [front, back, walls] = g.groups;
    expect(back.count).toBe(front.count);
    expect(walls.count).toBe(6 * 4 * 47); // one wall quad per boundary edge
  });

  it('double mode is mirror-symmetric in z with a rim of baseThickness·2', () => {
    const disk = SHAPES.circle!;
    const inflate = depthOf(N, N, (x, y) => Math.sqrt(Math.max(0, 1 - r2(x, y) / 36 ** 2)));
    const o = opts({ mode: 'double', baseThickness: 0.01 });
    const g = buildGeometryFromDepth(inflate, disk, o);
    const box = g.boundingBox!;
    expect(box.max.z).toBeCloseTo(-box.min.z, 6);
    const p = attr(g, 'position');
    let minFrontZ = Infinity;
    for (let i = 2; i < p.length; i += 3) if (p[i] > 0) minFrontZ = Math.min(minFrontZ, p[i]);
    expect(minFrontZ).toBeGreaterThanOrEqual(0.01 - 1e-6);
    expect(computeMeshStats(g).watertight).toBe(true);
  });

  it('wall normals are smooth along a round outline and hard at real corners', () => {
    const wallNormals = (g: BufferGeometry) => {
      const walls = g.groups[2];
      const idx = g.getIndex()!.array, n = attr(g, 'normal'), p = attr(g, 'position');
      const out: { n: [number, number, number]; p: [number, number] }[] = [];
      for (let t = walls.start; t < walls.start + walls.count; t++) {
        const v = idx[t];
        out.push({ n: [n[v * 3], n[v * 3 + 1], n[v * 3 + 2]], p: [p[v * 3], p[v * 3 + 1]] });
      }
      return out;
    };
    // Disk: every wall normal is horizontal and close to the radial direction (flat facets deviate up to 45°).
    const disk = buildGeometryFromDepth(dome, SHAPES.circle, opts({ mode: 'solid' }));
    for (const { n, p } of wallNormals(disk)) {
      expect(n[2]).toBe(0);
      const r = Math.hypot(p[0], p[1]);
      expect((n[0] * p[0] + n[1] * p[1]) / r).toBeGreaterThan(Math.cos((25 * Math.PI) / 180));
    }
    // Full rectangle: corners stay sharp, so every wall normal is axis-aligned.
    const rect = buildGeometryFromDepth(dome, null, opts({ mode: 'solid' }));
    for (const { n } of wallNormals(rect)) expect(Math.abs(n[0]) + Math.abs(n[1])).toBeCloseTo(1, 6);
  });

  it('rounds the outline staircase without flipping any front triangle', () => {
    const flat = depthOf(N, N, () => 0.5);
    const noisy = maskOf(N, N, (x, y) => r2(x, y) <= 36 ** 2 && ((x * 7 + y * 13) % 11 !== 0 || r2(x, y) < 30 ** 2));
    for (const mask of [SHAPES.circle!, SHAPES.ring!, noisy]) {
      for (const mode of MODES) {
        const g = buildGeometryFromDepth(flat, mask, opts({ mode }));
        const p = attr(g, 'position'), idx = g.getIndex()!.array;
        const front = g.groups[0];
        for (let t = front.start; t < front.start + front.count; t += 3) {
          const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
          const z = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
          expect(z).toBeGreaterThan(0); // still CCW seen from +Z
        }
        if (mode !== 'relief') expect(computeMeshStats(g).watertight).toBe(true);
      }
    }
    // Circle outline: vertices leave the grid and their radius varies less than the raw staircase's (~0.33 cell).
    const g = buildGeometryFromDepth(flat, SHAPES.circle, opts({ mode: 'solid' }));
    const walls = g.groups[2], idx = g.getIndex()!.array, p = attr(g, 'position');
    const cell = 2 / 47;
    const radii: number[] = [];
    let offGrid = 0;
    for (let t = walls.start; t < walls.start + walls.count; t++) {
      const v = idx[t] * 3;
      const gi = (p[v] + 1) / cell, gj = (1 - p[v + 1]) / cell;
      if (Math.abs(gi - Math.round(gi)) > 1e-3 || Math.abs(gj - Math.round(gj)) > 1e-3) offGrid++;
      radii.push(Math.hypot(p[v], p[v + 1]));
    }
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
    const std = Math.sqrt(radii.reduce((a, r) => a + (r - mean) ** 2, 0) / radii.length);
    expect(offGrid / radii.length).toBeGreaterThan(0.5);
    expect(std).toBeLessThan(0.27 * cell);
    expect(Math.abs(mean - 0.75)).toBeLessThan(cell);
  });

  it('closed modes keep a minimum thickness when baseThickness = 0', () => {
    for (const mode of ['solid', 'double'] as const) {
      const g = buildGeometryFromDepth(depthOf(16, 16, () => 0), null, opts({ mode, baseThickness: 0 }));
      expect(g.boundingBox!.max.z - g.boundingBox!.min.z).toBeCloseTo(MIN_THICKNESS, 6);
      expect(computeMeshStats(g).watertight).toBe(true);
    }
  });

  it('cuts the hole of a ring and keeps islands separate', () => {
    const ring = buildGeometryFromDepth(dome, SHAPES.ring, opts({ mode: 'solid' }));
    const p = attr(ring, 'position');
    const cell = 2 / 47;
    const inner = (18 / N) * 2, gapLeft = ((25 + 16) / N) * 2 - 1, gapRight = ((71 - 16) / N) * 2 - 1;
    for (let i = 0; i < p.length; i += 3) expect(Math.hypot(p[i], p[i + 1])).toBeGreaterThan(inner - cell);
    const isl = attr(buildGeometryFromDepth(dome, SHAPES.islands, opts({ mode: 'double' })), 'position');
    for (let i = 0; i < isl.length; i += 3) expect(isl[i] < gapLeft + cell || isl[i] > gapRight - cell).toBe(true);
  });

  it('stays watertight on noisy masks (pinch vertices are cut out)', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let trial = 0; trial < 4; trial++) {
      const noise = maskOf(40, 40, () => rnd() < 0.6);
      for (const mode of ['solid', 'double'] as const) {
        const g = buildGeometryFromDepth(depthOf(40, 40, () => rnd()), noise, opts({ mode, resolution: 40 }));
        if (tris(g) === 0) continue;
        expectClean(g);
        expect(computeMeshStats(g).watertight).toBe(true);
        expect(signedVolume(g)).toBeGreaterThan(0);
      }
    }
  });

  it('drops triangles across depth steps when discontinuity > 0 (relief only)', () => {
    const step = depthOf(64, 64, (x) => (x < 32 ? 0.1 : 0.9));
    const o = opts({ resolution: 64 });
    const full = buildGeometryFromDepth(step, null, o);
    const torn = buildGeometryFromDepth(step, null, { ...o, discontinuity: 0.3 });
    expect(tris(torn)).toBeLessThan(tris(full));
    expect(tris(torn)).toBeGreaterThan(0.9 * tris(full));
    const p = attr(torn, 'position'), idx = torn.getIndex()!.array, S = o.depthScale * 2;
    for (let t = 0; t < idx.length; t += 3) {
      const z = [p[idx[t] * 3 + 2], p[idx[t + 1] * 3 + 2], p[idx[t + 2] * 3 + 2]];
      expect(Math.max(...z) - Math.min(...z)).toBeLessThanOrEqual(0.3 * S + 1e-6);
    }
    expectClean(torn);
    // ignored in closed modes
    const solid = buildGeometryFromDepth(step, null, { ...o, mode: 'solid', discontinuity: 0.3 });
    expect(solid.groups[0].count / 3).toBe(tris(full));
  });

  it('never lets background depth bleed into the rim (shrinking, enlarging, smoothing)', () => {
    for (const size of [24, 192]) {
      const c = size / 2;
      const mask = maskOf(size, size, (x, y) => (x - c) ** 2 + (y - c) ** 2 <= (0.4 * size) ** 2);
      const depth = depthOf(size, size, (x, y) => ((x - c) ** 2 + (y - c) ** 2 <= (0.4 * size) ** 2 ? 0.8 : 0));
      for (const smoothing of [0, 3]) {
        const o = opts({ resolution: 64, smoothing });
        const p = attr(buildGeometryFromDepth(depth, mask, o), 'position');
        for (let i = 2; i < p.length; i += 3) expect(p[i]).toBeCloseTo(0.8 * o.depthScale * 2, 5);
      }
    }
  });

  it('applies invert and gamma', () => {
    const flat = depthOf(8, 8, () => 0.25);
    const z = (o: Partial<MeshOptions>) => buildGeometryFromDepth(flat, null, opts({ resolution: 8, ...o })).boundingBox!.max.z;
    const S = DEFAULT_MESH_OPTIONS.depthScale * 2;
    expect(z({})).toBeCloseTo(0.25 * S, 6);
    expect(z({ invert: true })).toBeCloseTo(0.75 * S, 6);
    expect(z({ gamma: 2 })).toBeCloseTo(0.0625 * S, 6);
  });

  it('handles landscape images, masks of another size, useMask = false and empty masks', () => {
    const wide = depthOf(200, 100, () => 0.5);
    const g = buildGeometryFromDepth(wide, null, opts({ resolution: 64 }));
    expect(g.userData).toMatchObject({ gridWidth: 64, gridHeight: 33 });
    expect(g.boundingBox!.min.y).toBeCloseTo(-0.5, 6);
    expect(g.boundingBox!.max.x).toBeCloseTo(1, 6);

    const smallMask = maskOf(50, 25, (x) => x < 25); // left half, at quarter resolution
    const half = buildGeometryFromDepth(wide, smallMask, opts({ resolution: 64 }));
    expect(half.boundingBox!.max.x).toBeLessThan(0.05);
    expect(half.boundingBox!.max.x).toBeGreaterThan(-0.1);
    expect(tris(buildGeometryFromDepth(wide, smallMask, opts({ resolution: 64, useMask: false })))).toBe(tris(g));

    const empty = buildGeometryFromDepth(wide, maskOf(50, 25, () => false), opts({ mode: 'solid' }));
    expect(empty.getAttribute('position').count).toBe(0);
    expect(computeMeshStats(empty)).toEqual({ vertices: 0, triangles: 0, watertight: false });
  });

  it('explains (instead of returning an empty mesh) when the silhouette vanishes on the grid', () => {
    const flat = depthOf(1024, 1024, () => 0.5);
    const dot = maskOf(1024, 1024, (x, y) => x > 500 && x < 504 && y > 500 && y < 504); // 4×4 px
    const line = maskOf(1024, 1024, (x, y) => x > 100 && x < 900 && y > 511 && y < 512); // 800×1 px
    for (const mode of MODES) {
      for (const mask of [dot, line]) {
        const err = (() => {
          try {
            buildGeometryFromDepth(flat, mask, opts({ mode, resolution: 256 }));
          } catch (e) {
            return e;
          }
        })();
        expect(err).toBeInstanceOf(LocalizedError);
        expect((err as LocalizedError).i18n).toBe(EMPTY_MESH);
      }
      // A finer grid catches the dot; without the mask the full frame is meshed.
      expect(tris(buildGeometryFromDepth(flat, dot, opts({ mode, resolution: 512 })))).toBeGreaterThan(0);
      expect(tris(buildGeometryFromDepth(flat, line, opts({ mode, resolution: 256, useMask: false })))).toBeGreaterThan(0);
    }
    expect(EMPTY_MESH.en).toMatch(/Resolution/);
  });

  it('builds a 512² solid quickly', () => {
    const S = 512;
    const depth = depthOf(S, S, (x, y) => Math.max(0, 1 - ((x - 256) ** 2 + (y - 256) ** 2) / 256 ** 2));
    const mask = maskOf(S, S, (x, y) => (x - 256) ** 2 + (y - 256) ** 2 <= 250 ** 2);
    const t0 = performance.now();
    const g = buildGeometryFromDepth(depth, mask, opts({ mode: 'solid', resolution: 512, smoothing: 2 }));
    const ms = performance.now() - t0;
    expect(tris(g)).toBeGreaterThan(700_000);
    expect(ms).toBeLessThan(1500); // typically a few hundred ms
    expect(computeMeshStats(g).watertight).toBe(true);
  });
});

describe('sampleDepthGrid', () => {
  it('majority-votes the mask and averages depth over the footprint', () => {
    const depth = depthOf(100, 100, (x) => x / 100);
    const mask = maskOf(100, 100, (x) => x < 50);
    const { fg, depth: d } = sampleDepthGrid(depth, mask, 11, 11);
    expect(Array.from(fg!.subarray(0, 11))).toEqual([1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
    expect(d[2]).toBeCloseTo(0.2, 2);
  });
});
