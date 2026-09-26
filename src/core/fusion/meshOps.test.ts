import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry } from 'three';
import { computeMeshStats } from '../mesh/stats';
import { marchingCubes } from './marchingCubes';
import { buildAdjacency, fitToFrame, taubinSmooth, vertexNormals } from './meshOps';
import { propagateColors, SRGB_TO_LINEAR } from './color';

/** Outward tetrahedron. */
const TET_POS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
const TET_IDX = new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);

function sphereMesh(n = 32, R = 12) {
  const c = (n - 1) / 2;
  const f = new Float32Array(n ** 3);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    f[i + n * (j + n * k)] = Math.hypot(i - c, j - c, k - c) <= R ? 1 : 0; // binary: staircase surface
  }
  return marchingCubes(f, [n, n, n], 0.5, [-c, -c, -c], 1);
}

function radii(p: Float32Array): { mean: number; sd: number } {
  const r: number[] = [];
  for (let i = 0; i < p.length; i += 3) r.push(Math.hypot(p[i], p[i + 1], p[i + 2]));
  const mean = r.reduce((s, v) => s + v, 0) / r.length;
  return { mean, sd: Math.sqrt(r.reduce((s, v) => s + (v - mean) ** 2, 0) / r.length) };
}

describe('mesh ops', () => {
  it('builds one-ring adjacency', () => {
    const adj = buildAdjacency(4, TET_IDX);
    for (let v = 0; v < 4; v++) {
      const ring = Array.from(adj.neighbors.slice(adj.offsets[v], adj.offsets[v + 1])).sort();
      expect(ring).toEqual([0, 1, 2, 3].filter((u) => u !== v));
    }
  });

  it('Taubin smoothing removes voxel steps without shrinking, and keeps the mesh closed', () => {
    const m = sphereMesh();
    const before = radii(m.positions);
    taubinSmooth(m.positions, buildAdjacency(m.positions.length / 3, m.indices), 10);
    const after = radii(m.positions);
    expect(after.sd).toBeLessThan(before.sd * 0.6);
    expect(Math.abs(after.mean - before.mean)).toBeLessThan(0.1);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(m.positions, 3));
    g.setIndex(new BufferAttribute(m.indices, 1));
    expect(computeMeshStats(g).watertight).toBe(true);
  });

  it('computes outward unit normals', () => {
    const m = sphereMesh(24, 8);
    const n = vertexNormals(m.positions, m.indices);
    for (let i = 0; i < n.length; i += 3) {
      expect(Math.hypot(n[i], n[i + 1], n[i + 2])).toBeCloseTo(1, 4);
      const p = [m.positions[i], m.positions[i + 1], m.positions[i + 2]];
      expect((n[i] * p[0] + n[i + 1] * p[1] + n[i + 2] * p[2]) / Math.hypot(...p)).toBeGreaterThan(0.7);
    }
    const t = vertexNormals(TET_POS, TET_IDX);
    expect(t[3 * 3 + 2]).toBeGreaterThan(0.5); // apex (0, 0, 1) points up
  });

  it('fits positions into the shared frame', () => {
    const p = new Float32Array([10, 20, 30, 14, 21, 31, 12, 22, 30]);
    fitToFrame(p);
    expect(Array.from(p).map((v) => v + 0)).toEqual([-1, -0.5, -0.25, 1, 0, 0.25, 0, 0.5, -0.25]);
    fitToFrame(new Float32Array(0));
  });
});

describe('colour helpers', () => {
  it('decodes sRGB', () => {
    expect(SRGB_TO_LINEAR[0]).toBe(0);
    expect(SRGB_TO_LINEAR[255]).toBeCloseTo(1, 6);
    expect(SRGB_TO_LINEAR[128]).toBeCloseTo(0.2158, 3);
  });

  it('propagates colours to unseen vertices from the nearest coloured ones', () => {
    // Path 0 − 1 − 2 − 3 − 4 as a strip of triangles (adjacency is what matters).
    const adj = { offsets: new Int32Array([0, 1, 3, 5, 7, 8]), neighbors: new Int32Array([1, 0, 2, 1, 3, 2, 4, 3]) };
    const colors = new Float32Array(15);
    colors.set([1, 0, 0], 0);
    colors.set([0, 0, 1], 12);
    const done = new Uint8Array([1, 0, 0, 0, 1]);
    propagateColors(colors, done, adj);
    expect(Array.from(colors.slice(3, 6))).toEqual([1, 0, 0]);
    expect(Array.from(colors.slice(9, 12))).toEqual([0, 0, 1]);
    expect(done.every((d) => d === 1)).toBe(true);
    // Nothing coloured: grey.
    const grey = new Float32Array(6);
    propagateColors(grey, new Uint8Array(2), { offsets: new Int32Array([0, 1, 2]), neighbors: new Int32Array([1, 0]) });
    expect(Array.from(grey)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  });
});
