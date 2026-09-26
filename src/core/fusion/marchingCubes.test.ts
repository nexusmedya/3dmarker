import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry } from 'three';
import { computeMeshStats } from '../mesh/stats';
import { caseLoops, EDGE_CORNERS, FACES, marchingCubes, triangulateLoop, TRI_EDGES, TRI_OFFSET, type IsoMesh } from './marchingCubes';

function geometryOf(m: IsoMesh): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(m.positions, 3));
  g.setIndex(new BufferAttribute(m.indices, 1));
  return g;
}

/** Signed volume (divergence theorem); positive for outward-facing triangles. */
function signedVolume(m: IsoMesh): number {
  const p = m.positions;
  let v = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t] * 3, b = m.indices[t + 1] * 3, c = m.indices[t + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

function field(n: number, f: (x: number, y: number, z: number) => number): Float32Array {
  const out = new Float32Array(n * n * n);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) out[i + n * (j + n * k)] = f(i, j, k);
  return out;
}

/** Tiny deterministic PRNG. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('marching cubes tables', () => {
  it('lists 12 edges and 6 faces oriented counter-clockwise from outside', () => {
    expect(EDGE_CORNERS).toHaveLength(12);
    expect(FACES).toHaveLength(6);
    // Face x = 0 seen from −X: 0 → 4 → 6 → 2 (Z right, Y up), up to rotation.
    const f0 = FACES[0];
    const r = f0.indexOf(0);
    expect([...f0.slice(r), ...f0.slice(0, r)]).toEqual([0, 4, 6, 2]);
  });

  it('uses every sign-changing edge exactly once per case and no other edge', () => {
    for (let c = 0; c < 256; c++) {
      const crossing = EDGE_CORNERS.map(([a, b]) => ((c >> a) & 1) !== ((c >> b) & 1));
      const used = caseLoops(c).flat();
      expect(new Set(used).size).toBe(used.length);
      expect(used.sort((a, b) => a - b)).toEqual(crossing.flatMap((x, e) => (x ? [e] : [])));
    }
  });

  it('has the expected loop structure for classic cases', () => {
    expect(caseLoops(0)).toEqual([]);
    expect(caseLoops(255)).toEqual([]);
    // One corner: a triangle. Two diagonal corners on a face: separated (two triangles).
    expect(caseLoops(0b1).map((l) => l.length)).toEqual([3]);
    expect(caseLoops(0b1001).map((l) => l.length)).toEqual([3, 3]);
    // Half the cube: a quad. Corners 0,1,2 (an L on a face): a pentagon.
    expect(caseLoops(0b1111).map((l) => l.length)).toEqual([4]);
    expect(caseLoops(0b0111).map((l) => l.length)).toEqual([5]);
    // Triangles are complementary in count between a case and its inverse.
    for (let c = 1; c < 255; c++) {
      const tris = (TRI_OFFSET[c + 1] - TRI_OFFSET[c]) / 3;
      expect(tris).toBeGreaterThan(0);
      expect(tris).toBeLessThanOrEqual(8);
    }
    expect(TRI_EDGES.every((e) => e >= 0 && e < 12)).toBe(true);
  });

  it('never triangulates across a diagonal between two vertices on the same cube face', () => {
    const faceEdges = FACES.map((f) => f.map((c, k) => {
      const a = Math.min(c, f[(k + 1) % 4]), b = Math.max(c, f[(k + 1) % 4]);
      return EDGE_CORNERS.findIndex(([x, y]) => x === a && y === b);
    }));
    const sameFace = (a: number, b: number) => faceEdges.some((fe) => fe.includes(a) && fe.includes(b));
    for (let c = 0; c < 256; c++)
      for (const loop of caseLoops(c)) {
        const tris = triangulateLoop(loop);
        expect(tris).not.toBeNull();
        expect(tris!.length).toBe(3 * (loop.length - 2));
        const isLoopEdge = (a: number, b: number) => {
          const i = loop.indexOf(a), j = loop.indexOf(b);
          return Math.abs(i - j) === 1 || Math.abs(i - j) === loop.length - 1;
        };
        for (let t = 0; t < tris!.length; t += 3)
          for (let e = 0; e < 3; e++) {
            const a = tris![t + e], b = tris![t + ((e + 1) % 3)];
            if (!isLoopEdge(a, b)) expect(sameFace(a, b), `case ${c}`).toBe(false);
          }
      }
  });

  it('orients a single-corner triangle away from the inside corner', () => {
    const m = marchingCubes(field(2, (i, j, k) => (i + j + k === 0 ? 1 : 0)), [2, 2, 2]);
    expect(m.indices.length).toBe(3);
    const p = m.positions;
    const [a, b, c] = [0, 1, 2].map((q) => [p[m.indices[q] * 3], p[m.indices[q] * 3 + 1], p[m.indices[q] * 3 + 2]]);
    const u = b.map((v, i) => v - a[i]), v = c.map((x, i) => x - a[i]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    expect(n[0]).toBeGreaterThan(0);
    expect(n[1]).toBeGreaterThan(0);
    expect(n[2]).toBeGreaterThan(0);
  });
});

describe('marchingCubes', () => {
  it('extracts a closed, outward-facing sphere with accurate radius and volume', () => {
    const n = 40, c = 19.5, R = 14;
    const f = field(n, (i, j, k) => Math.min(1, Math.max(0, 0.5 + (R - Math.hypot(i - c, j - c, k - c)) / 2)));
    const m = marchingCubes(f, [n, n, n], 0.5, [-c, -c, -c], 1);
    const stats = computeMeshStats(geometryOf(m));
    expect(stats.watertight).toBe(true);
    let maxErr = 0;
    for (let v = 0; v < m.positions.length; v += 3) {
      maxErr = Math.max(maxErr, Math.abs(Math.hypot(m.positions[v], m.positions[v + 1], m.positions[v + 2]) - R));
    }
    expect(maxErr).toBeLessThan(0.05);
    const vol = signedVolume(m);
    expect(vol / ((4 / 3) * Math.PI * R ** 3)).toBeCloseTo(1, 1);
    expect(vol).toBeGreaterThan(0);
  });

  it('keeps shared vertices (indexed) and produces no degenerate welded triangles', () => {
    const n = 12;
    const f = field(n, (i, j, k) => (i > 2 && i < 9 && j > 2 && j < 9 && k > 2 && k < 9 ? 0.5 : 0)); // corners exactly at iso
    const m = marchingCubes(f, [n, n, n], 0.4999);
    const stats = computeMeshStats(geometryOf(m));
    expect(stats.watertight).toBe(true);
    expect(stats.vertices).toBe(m.positions.length / 3);
  });

  it('is watertight and consistently oriented for random fields (fuzz)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const n = 6 + (seed % 7);
      const binary = seed % 3 === 0; // binary fields hit every ambiguous configuration often
      const f = field(n, (i, j, k) => {
        if (i === 0 || j === 0 || k === 0 || i === n - 1 || j === n - 1 || k === n - 1) return 0;
        return binary ? (r() > 0.5 ? 1 : 0) : r();
      });
      const m = marchingCubes(f, [n, n, n], binary ? 0.5 : 0.3 + 0.4 * r());
      if (m.indices.length === 0) continue;
      const stats = computeMeshStats(geometryOf(m));
      expect(stats.watertight, `seed ${seed}`).toBe(true);
      expect(signedVolume(m), `seed ${seed}`).toBeGreaterThan(0);
    }
  });

  it('handles non-cubic dims, origin and spacing', () => {
    const [nx, ny, nz] = [10, 6, 8];
    const f = new Float32Array(nx * ny * nz);
    for (let k = 2; k < nz - 2; k++) for (let j = 2; j < ny - 2; j++) for (let i = 2; i < nx - 2; i++) f[i + nx * (j + ny * k)] = 1;
    const m = marchingCubes(f, [nx, ny, nz], 0.5, [10, 20, 30], 2);
    expect(computeMeshStats(geometryOf(m)).watertight).toBe(true);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < m.positions.length; v += 3)
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], m.positions[v + a]);
        max[a] = Math.max(max[a], m.positions[v + a]);
      }
    // Occupied voxels 2..n−3 → surface at 1.5 .. n−2.5 voxels.
    expect(min[0]).toBeCloseTo(10 + 1.5 * 2, 5);
    expect(max[0]).toBeCloseTo(10 + (nx - 2.5) * 2, 5);
    expect(min[1]).toBeCloseTo(20 + 1.5 * 2, 5);
    expect(max[2]).toBeCloseTo(30 + (nz - 2.5) * 2, 5);
  });

  it('returns an empty mesh for empty, full or degenerate grids', () => {
    expect(marchingCubes(new Float32Array(27), [3, 3, 3]).indices.length).toBe(0);
    expect(marchingCubes(new Float32Array(27).fill(1), [3, 3, 3]).indices.length).toBe(0);
    expect(marchingCubes(new Float32Array(3), [3, 1, 1]).indices.length).toBe(0);
  });
});
