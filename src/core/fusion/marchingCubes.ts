/**
 * Marching cubes with tables generated at load time instead of the classic
 * hand-written 256-case table.
 *
 * For every corner configuration the surface boundary on each cube face is a
 * set of segments between sign-changing edges; on the ambiguous face (two
 * diagonal inside corners) the inside corners are always separated. The rule
 * depends only on the face's own corners, so neighbouring cubes agree and the
 * surface is crack-free. Segments are oriented (walking a face counter-
 * clockwise seen from outside the cube, from the edge that enters a run of
 * inside corners to the edge that leaves it), chained into loops through the
 * shared edges and fan-triangulated. Every mesh edge then has exactly two
 * triangles using it in opposite directions: with an empty grid border the
 * result is a closed, consistently oriented 2-manifold whose normals point
 * from inside (value > iso) to outside.
 *
 * Corner c of a cube sits at (c & 1, c >> 1 & 1, c >> 2 & 1); edges 0–3 run
 * along X, 4–7 along Y, 8–11 along Z.
 */

import { drain, type Steps } from './steps';

/** [lower corner, upper corner] per edge. */
export const EDGE_CORNERS: readonly (readonly [number, number])[] = (() => {
  const edges: [number, number][] = [];
  for (let axis = 0; axis < 3; axis++)
    for (let c = 0; c < 8; c++) if (!(c & (1 << axis))) edges.push([c, c | (1 << axis)]);
  return edges;
})();

const EDGE_AXIS = EDGE_CORNERS.map(([a, b]) => Math.log2(b - a));

function edgeBetween(a: number, b: number): number {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return EDGE_CORNERS.findIndex(([x, y]) => x === lo && y === hi);
}

/** The 6 faces as corner cycles, counter-clockwise seen from outside the cube. */
export const FACES: readonly (readonly number[])[] = (() => {
  const pos = (c: number) => [c & 1, (c >> 1) & 1, (c >> 2) & 1];
  const faces: number[][] = [];
  for (let axis = 0; axis < 3; axis++)
    for (let side = 0; side < 2; side++) {
      const [p, q] = [0, 1, 2].filter((a) => a !== axis);
      const cycle = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([bp, bq]) => (side << axis) | (bp << p) | (bq << q));
      // Orientation: (c1 − c0) × (c2 − c1) must point along the outward normal.
      const [c0, c1, c2] = cycle.map(pos);
      const e1 = [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]];
      const e2 = [c2[0] - c1[0], c2[1] - c1[1], c2[2] - c1[2]];
      const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const outward = side ? 1 : -1;
      faces.push(cross[axis] * outward > 0 ? cycle : cycle.reverse());
    }
  return faces;
})();

/** Oriented surface loops (edge index cycles) of one corner configuration (bit c set = corner c inside). */
export function caseLoops(config: number): number[][] {
  const inside = (c: number) => (config >> c) & 1;
  const next = new Int8Array(12).fill(-1);
  for (const face of FACES) {
    const b = face.map(inside);
    for (let k = 0; k < 4; k++) {
      if (!b[k] || b[(k + 1) % 4]) continue; // k = last inside corner of a run
      let m = k;
      while (b[(m + 3) % 4]) m = (m + 3) % 4; // first corner of the run (a run never covers the whole face here)
      const entry = edgeBetween(face[(m + 3) % 4], face[m]);
      const exit = edgeBetween(face[k], face[(k + 1) % 4]);
      next[entry] = exit;
    }
  }
  const loops: number[][] = [];
  const seen = new Uint8Array(12);
  for (let e = 0; e < 12; e++) {
    if (next[e] < 0 || seen[e]) continue;
    const loop: number[] = [];
    for (let x = e; !seen[x]; x = next[x]) {
      seen[x] = 1;
      loop.push(x);
    }
    loops.push(loop);
  }
  return loops;
}

/** True when two cube edges lie on a common face. */
const SAME_FACE: boolean[][] = (() => {
  const t = Array.from({ length: 12 }, () => new Array<boolean>(12).fill(false));
  for (const face of FACES) {
    const fe = face.map((c, k) => edgeBetween(c, face[(k + 1) % 4]));
    for (const a of fe) for (const b of fe) t[a][b] = true;
  }
  return t;
})();

/**
 * Triangulate a loop without diagonals between two vertices on the same cube
 * face: the neighbouring cube could use that diagonal too (its ambiguous face
 * has the same four vertices), and the edge would then have four triangles.
 * Returns flat edge triples, or null when no such triangulation exists.
 */
export function triangulateLoop(loop: number[]): number[] | null {
  const n = loop.length;
  const adjacent = (i: number, j: number) => (i - j + n) % n === 1 || (j - i + n) % n === 1;
  const allowed = (i: number, j: number) => adjacent(i, j) || !SAME_FACE[loop[i]][loop[j]];
  // Polygon of loop positions (in loop order): triangle (p0, p1, pk) splits it
  // into p1..pk and pk..p(m−1), p0, both still in loop order.
  const solve = (poly: number[]): number[] | null => {
    const m = poly.length;
    if (m < 3) return [];
    const [p0, p1] = poly;
    for (let k = 2; k < m; k++) {
      const pk = poly[k];
      if ((k > 2 && !allowed(p1, pk)) || (k < m - 1 && !allowed(pk, p0))) continue;
      const left = solve(poly.slice(1, k + 1));
      const right = left && solve([p0, ...poly.slice(k)]);
      if (left && right) return [p0, p1, pk, ...left, ...right];
    }
    return null;
  };
  // Prefer a fan (fewest long diagonals) from the first valid pivot.
  for (let pivot = 0; pivot < n; pivot++) {
    let ok = true;
    for (let i = 2; i < n - 1 && ok; i++) ok = allowed(pivot, (pivot + i) % n);
    if (!ok) continue;
    const tris: number[] = [];
    for (let i = 1; i + 1 < n; i++) tris.push(loop[pivot], loop[(pivot + i) % n], loop[(pivot + i + 1) % n]);
    return tris;
  }
  const order = solve(loop.map((_, i) => i));
  return order ? order.map((i) => loop[i]) : null;
}

/** Flattened triangle table: triangles of case c are TRI_EDGES[TRI_OFFSET[c] .. TRI_OFFSET[c + 1]). */
const { TRI_OFFSET, TRI_EDGES } = (() => {
  const offsets = new Int32Array(257);
  const edges: number[] = [];
  for (let c = 0; c < 256; c++) {
    offsets[c] = edges.length;
    for (const loop of caseLoops(c)) {
      const tris = triangulateLoop(loop);
      if (!tris) throw new Error(`marching cubes: no valid triangulation for case ${c}`);
      edges.push(...tris);
    }
  }
  offsets[256] = edges.length;
  return { TRI_OFFSET: offsets, TRI_EDGES: Int8Array.from(edges) };
})();

export { TRI_OFFSET, TRI_EDGES };

export interface IsoMesh {
  /** World positions, xyz per vertex. */
  positions: Float32Array;
  indices: Uint32Array;
}

class GrowF32 {
  data = new Float32Array(1 << 12);
  length = 0;
  push3(a: number, b: number, c: number): void {
    if (this.length + 3 > this.data.length) {
      const d = new Float32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
  }
}

class GrowU32 {
  data = new Uint32Array(1 << 12);
  length = 0;
  push(v: number): void {
    if (this.length === this.data.length) {
      const d = new Uint32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    this.data[this.length++] = v;
  }
}

/** Keep vertices off the grid corners so vertices of different edges never coincide. */
const T_EPS = 0.01;

/**
 * Extract the `iso` surface of a scalar field (index i + nx·(j + ny·k)).
 * Values > iso are inside. Keep the outermost layer ≤ iso for a closed mesh.
 */
export function marchingCubes(
  field: Float32Array,
  dims: readonly [number, number, number],
  iso = 0.5,
  origin: readonly [number, number, number] = [0, 0, 0],
  spacing = 1,
): IsoMesh {
  return drain(marchingCubesSteps(field, dims, iso, origin, spacing));
}

/** marchingCubes as cooperative steps (a yield per Z slab). */
export function* marchingCubesSteps(
  field: Float32Array,
  dims: readonly [number, number, number],
  iso = 0.5,
  origin: readonly [number, number, number] = [0, 0, 0],
  spacing = 1,
): Steps<IsoMesh> {
  const [nx, ny, nz] = dims;
  const nxy = nx * ny;
  const pos = new GrowF32();
  const idx = new GrowU32();
  if (nx < 2 || ny < 2 || nz < 2) return { positions: new Float32Array(0), indices: new Uint32Array(0) };
  // Vertex ids of the edges crossed so far: X / Y edges per slice parity, Z edges of the current slab.
  const cacheX = [new Int32Array(nxy).fill(-1), new Int32Array(nxy)];
  const cacheY = [new Int32Array(nxy).fill(-1), new Int32Array(nxy)];
  const cacheZ = new Int32Array(nxy);
  const vals = new Float64Array(8);
  const cornerOffset = [0, 1, nx, nx + 1, nxy, nxy + 1, nxy + nx, nxy + nx + 1];

  for (let k = 0; k < nz - 1; k++, yield) {
    const up = (k + 1) & 1;
    cacheX[up].fill(-1);
    cacheY[up].fill(-1);
    cacheZ.fill(-1);
    for (let j = 0; j < ny - 1; j++) {
      let p = nx * (j + ny * k);
      for (let i = 0; i < nx - 1; i++, p++) {
        let config = 0;
        for (let c = 0; c < 8; c++) {
          const v = field[p + cornerOffset[c]];
          vals[c] = v;
          if (v > iso) config |= 1 << c;
        }
        if (config === 0 || config === 255) continue;
        for (let t = TRI_OFFSET[config], end = TRI_OFFSET[config + 1]; t < end; t++) {
          const e = TRI_EDGES[t];
          const [ca, cb] = EDGE_CORNERS[e];
          const gi = i + (ca & 1), gj = j + ((ca >> 1) & 1), gk = k + ((ca >> 2) & 1);
          const axis = EDGE_AXIS[e];
          const cache = axis === 0 ? cacheX[gk & 1] : axis === 1 ? cacheY[gk & 1] : cacheZ;
          const key = gi + nx * gj;
          let id = cache[key];
          if (id < 0) {
            const fa = vals[ca], fb = vals[cb];
            let f = (iso - fa) / (fb - fa);
            f = f < T_EPS ? T_EPS : f > 1 - T_EPS ? 1 - T_EPS : f;
            id = pos.length / 3;
            pos.push3(
              origin[0] + (gi + (axis === 0 ? f : 0)) * spacing,
              origin[1] + (gj + (axis === 1 ? f : 0)) * spacing,
              origin[2] + (gk + (axis === 2 ? f : 0)) * spacing,
            );
            cache[key] = id;
          }
          idx.push(id);
        }
      }
    }
  }
  return { positions: pos.data.slice(0, pos.length), indices: idx.data.slice(0, idx.length) };
}
