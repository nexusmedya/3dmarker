/**
 * Sculpt topology of one geometry, built once per session and never written
 * back: vertices that share a position are welded into one "group" (they
 * always move together, so UV / normal seams and the depth mesh's wall
 * vertices stay attached while the index and attributes are left untouched),
 * plus the welded 1-ring adjacency (smoothing), open-boundary flags (lock
 * boundary) and per-vertex triangle lists (normal updates).
 *
 * Normal classes: inside a group, members whose original normals agree
 * (UV seams, smoothed walls) share one recomputed normal; members that
 * differ (hard edges, e.g. a solid depth mesh's front / wall split) keep
 * separate normals, so the model's shading style survives sculpting.
 */

export interface SculptTopology {
  vertexCount: number;
  triCount: number;
  /** Vertex indices of the triangles (3 per triangle; a copy of the index, or identity). */
  tris: Uint32Array;
  /** Vertex → welded group id. */
  gid: Int32Array;
  groupCount: number;
  /** Group g's member vertices are gVerts[gStart[g] .. gStart[g + 1]) (sorted by normal class). */
  gStart: Int32Array;
  gVerts: Int32Array;
  /** Group g's normal classes are the ids gClass[g] .. gClass[g + 1] - 1. */
  gClass: Int32Array;
  /** Class c's members are gVerts[cStart[c] .. cStart[c + 1]). */
  cStart: Int32Array;
  classCount: number;
  /** Triangles using vertex v: vtTris[vtStart[v] .. vtStart[v + 1]). */
  vtStart: Int32Array;
  vtTris: Int32Array;
  /** Welded neighbours of group g: adj[adjStart[g] .. adjStart[g + 1]). */
  adjStart: Int32Array;
  adj: Int32Array;
  /** 1 when group g lies on an open (single-triangle) welded edge. */
  boundary: Uint8Array;
}

export interface TopologyOptions {
  /** Positions closer than this fraction of the bounding-box diagonal are welded (default 1e-6). */
  weldTolerance?: number;
  /** Members of a group share a normal when their original normals' cosine exceeds this (default 0.95 ≈ 18°). */
  normalCos?: number;
}

export function buildTopology(
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null,
  normals: ArrayLike<number> | null,
  opts: TopologyOptions = {},
): SculptTopology {
  const n = Math.floor(positions.length / 3);
  const cornerCount = index ? index.length - (index.length % 3) : n - (n % 3);
  const triCount = cornerCount / 3;
  const tris = new Uint32Array(cornerCount);
  for (let k = 0; k < cornerCount; k++) tris[k] = index ? index[k] : k;

  const gid = weldPositions(positions, n, opts.weldTolerance ?? 1e-6);
  let groupCount = 0;
  for (let v = 0; v < n; v++) if (gid[v] + 1 > groupCount) groupCount = gid[v] + 1;

  // Group CSR (counting sort by group id).
  const gStart = new Int32Array(groupCount + 1);
  for (let v = 0; v < n; v++) gStart[gid[v] + 1]++;
  for (let g = 0; g < groupCount; g++) gStart[g + 1] += gStart[g];
  const gVerts = new Int32Array(n);
  const fill = gStart.slice(0, groupCount);
  for (let v = 0; v < n; v++) gVerts[fill[gid[v]]++] = v;

  // Normal classes: greedy clustering of each group's members by original normal.
  const cosT = opts.normalCos ?? 0.95;
  const gClass = new Int32Array(groupCount + 1);
  const cStartList: number[] = [];
  const cls = new Int32Array(n);
  let classCount = 0;
  const scratch: number[] = [];
  for (let g = 0; g < groupCount; g++) {
    gClass[g] = classCount;
    const s = gStart[g], e = gStart[g + 1];
    if (e - s === 1 || !normals) {
      cStartList.push(s);
      for (let k = s; k < e; k++) cls[gVerts[k]] = classCount;
      classCount++;
      continue;
    }
    // Assign local class ids, then reorder the members so classes are contiguous.
    const reps: number[] = [];
    const local: number[] = [];
    for (let k = s; k < e; k++) {
      const v = gVerts[k];
      let found = -1;
      for (let c = 0; c < reps.length; c++) {
        const r = reps[c];
        const d = normals[v * 3] * normals[r * 3] + normals[v * 3 + 1] * normals[r * 3 + 1] + normals[v * 3 + 2] * normals[r * 3 + 2];
        if (d >= cosT) {
          found = c;
          break;
        }
      }
      if (found < 0) {
        found = reps.length;
        reps.push(v);
      }
      local.push(found);
    }
    scratch.length = 0;
    for (let c = 0, k = s; c < reps.length; c++) {
      cStartList.push(k);
      for (let m = 0; m < local.length; m++) {
        if (local[m] !== c) continue;
        const v = gVerts[s + m];
        scratch.push(v);
        cls[v] = classCount + c;
        k++;
      }
    }
    for (let m = 0; m < scratch.length; m++) gVerts[s + m] = scratch[m];
    classCount += reps.length;
  }
  gClass[groupCount] = classCount;
  const cStart = new Int32Array(classCount + 1);
  for (let c = 0; c < classCount; c++) cStart[c] = cStartList[c];
  cStart[classCount] = n;

  // Vertex → triangles.
  const vtStart = new Int32Array(n + 1);
  for (let k = 0; k < cornerCount; k++) vtStart[tris[k] + 1]++;
  for (let v = 0; v < n; v++) vtStart[v + 1] += vtStart[v];
  const vtTris = new Int32Array(cornerCount);
  const vtFill = vtStart.slice(0, n);
  for (let k = 0; k < cornerCount; k++) vtTris[vtFill[tris[k]]++] = (k / 3) | 0;

  // Welded edges: use counts (boundary = used once) and adjacency.
  const edges = new EdgeTable(Math.max(16, triCount * 3));
  for (let t = 0; t < triCount; t++) {
    const a = gid[tris[t * 3]], b = gid[tris[t * 3 + 1]], c = gid[tris[t * 3 + 2]];
    if (a === b || b === c || c === a) continue; // degenerate after welding
    edges.add(a, b);
    edges.add(b, c);
    edges.add(c, a);
  }
  const boundary = new Uint8Array(groupCount);
  const adjStart = new Int32Array(groupCount + 1);
  for (let e = 0; e < edges.size; e++) {
    adjStart[edges.lo[e] + 1]++;
    adjStart[edges.hi[e] + 1]++;
    if (edges.count[e] === 1) boundary[edges.lo[e]] = boundary[edges.hi[e]] = 1;
  }
  for (let g = 0; g < groupCount; g++) adjStart[g + 1] += adjStart[g];
  const adj = new Int32Array(adjStart[groupCount]);
  const adjFill = adjStart.slice(0, groupCount);
  for (let e = 0; e < edges.size; e++) {
    adj[adjFill[edges.lo[e]]++] = edges.hi[e];
    adj[adjFill[edges.hi[e]]++] = edges.lo[e];
  }

  return {
    vertexCount: n,
    triCount,
    tris,
    gid,
    groupCount,
    gStart,
    gVerts,
    gClass,
    cStart,
    classCount,
    vtStart,
    vtTris,
    adjStart,
    adj,
    boundary,
  };
}

/** Vertex → group id: positions within `tolerance`·diagonal share an id (quantised hash). */
export function weldPositions(positions: ArrayLike<number>, n: number, tolerance: number): Int32Array {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < n; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    if (!Number.isFinite(x + y + z)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  const inv = 1 / Math.max(diag * tolerance, 1e-12);
  const out = new Int32Array(n);
  const cap = pow2(n * 2);
  const slots = new Int32Array(cap).fill(-1);
  const keys = new Int32Array(n * 3);
  let next = 0;
  for (let v = 0; v < n; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    if (!Number.isFinite(x + y + z)) {
      out[v] = next++; // never welded
      continue;
    }
    const qx = Math.round((x - minX) * inv) | 0;
    const qy = Math.round((y - minY) * inv) | 0;
    const qz = Math.round((z - minZ) * inv) | 0;
    let h = (Math.imul(qx, 73856093) ^ Math.imul(qy, 19349663) ^ Math.imul(qz, 83492791)) & (cap - 1);
    for (;;) {
      const id = slots[h];
      if (id < 0) {
        slots[h] = v;
        keys[v * 3] = qx;
        keys[v * 3 + 1] = qy;
        keys[v * 3 + 2] = qz;
        out[v] = next++;
        break;
      }
      if (keys[id * 3] === qx && keys[id * 3 + 1] === qy && keys[id * 3 + 2] === qz) {
        out[v] = out[id];
        break;
      }
      h = (h + 1) & (cap - 1);
    }
  }
  return out;
}

/** Open-addressing table of undirected edges (lo < hi) with use counts. */
class EdgeTable {
  lo: Int32Array;
  hi: Int32Array;
  count: Uint8Array;
  size = 0;
  private slots: Int32Array;

  constructor(capacity: number) {
    this.lo = new Int32Array(capacity);
    this.hi = new Int32Array(capacity);
    this.count = new Uint8Array(capacity);
    this.slots = new Int32Array(pow2(capacity * 2)).fill(-1);
  }

  add(a: number, b: number): void {
    const lo = a < b ? a : b, hi = a < b ? b : a;
    const mask = this.slots.length - 1;
    let h = (Math.imul(lo, 73856093) ^ Math.imul(hi, 19349663)) & mask;
    for (;;) {
      const id = this.slots[h];
      if (id < 0) {
        const e = this.size++;
        this.slots[h] = e;
        this.lo[e] = lo;
        this.hi[e] = hi;
        this.count[e] = 1;
        return;
      }
      if (this.lo[id] === lo && this.hi[id] === hi) {
        if (this.count[id] < 255) this.count[id]++;
        return;
      }
      h = (h + 1) & mask;
    }
  }
}

function pow2(n: number): number {
  let c = 16;
  while (c < n) c *= 2;
  return c;
}
