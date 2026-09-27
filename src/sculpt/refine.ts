/**
 * Adaptive refinement for sculpting: brushes only move existing vertices,
 * so a coarse mesh (an extruded logo's earcut caps, a low-poly GLB) has
 * nothing under the brush. Edges longer than a target length are bisected
 * (red-green: 1, 2 or 3 split edges per triangle) until every edge fits or
 * the triangle budget is reached.
 *
 * Splits are decided per welded edge (by position), so both triangles on an
 * edge split it even across UV / normal seams: no T-junctions, no cracks.
 * Every vertex attribute is interpolated (normals renormalised; integer and
 * skin attributes copied from one end), groups are remapped, winding kept.
 * The geometry is changed in place (same object), so references held by the
 * app / export stay valid.
 */
import { BufferAttribute, type BufferGeometry, type TypedArray } from 'three';

export interface RefineOptions {
  /** Target: split edges longer than this (geometry units). */
  maxEdge: number;
  /** Stop before the triangle count would exceed this (default 300k). */
  maxTriangles?: number;
  /** At most this many bisection passes (default 12). */
  maxPasses?: number;
}

export interface RefineResult {
  trianglesBefore: number;
  trianglesAfter: number;
  passes: number;
}

export const REFINE_MAX_TRIANGLES = 300_000;

/** Key of an unordered pair of non-negative ints (< 2^26 each). */
const PAIR = 67108864;
const pairKey = (a: number, b: number) => (a < b ? a * PAIR + b : b * PAIR + a);

/** Triangle vertex indices of a geometry (identity for non-indexed). */
function triangleIndex(geometry: BufferGeometry): Uint32Array {
  const index = geometry.getIndex();
  if (index) return Uint32Array.from(index.array as ArrayLike<number>);
  const n = geometry.getAttribute('position').count;
  const out = new Uint32Array(n - (n % 3));
  for (let i = 0; i < out.length; i++) out[i] = i;
  return out;
}

/** Longest and median edge length (sampled on large meshes), geometry units. */
export function edgeLengths(geometry: BufferGeometry, maxSamples = 30000): { max: number; median: number } {
  const pos = geometry.getAttribute('position');
  if (!pos) return { max: 0, median: 0 };
  const tris = triangleIndex(geometry);
  const nt = tris.length / 3;
  if (nt === 0) return { max: 0, median: 0 };
  const step = Math.max(1, Math.floor(nt / Math.max(1, Math.floor(maxSamples / 3))));
  const lens: number[] = [];
  let max = 0;
  const len = (a: number, b: number) =>
    Math.hypot(pos.getX(a) - pos.getX(b), pos.getY(a) - pos.getY(b), pos.getZ(a) - pos.getZ(b));
  for (let t = 0; t < nt; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    const l0 = len(a, b), l1 = len(b, c), l2 = len(c, a);
    max = Math.max(max, l0, l1, l2);
    if (t % step === 0) lens.push(l0, l1, l2);
  }
  lens.sort((x, y) => x - y);
  return { max, median: lens[lens.length >> 1] ?? 0 };
}

interface AttrData {
  name: string;
  itemSize: number;
  normalized: boolean;
  ctor: new (n: number) => TypedArray;
  /** Values (denormalised), grown as vertices are added. */
  v: number[];
  /** Midpoints copy the first end instead of averaging (indices, skin data). */
  copy: boolean;
  unit: boolean;
}

/**
 * Bisect the edges of `geometry` longer than `maxEdge`, in place. Returns
 * null (geometry untouched) when nothing needs splitting or it can't be
 * refined safely (morph targets, a partial draw range).
 */
export function refineGeometry(geometry: BufferGeometry, opts: RefineOptions): RefineResult | null {
  const posAttr = geometry.getAttribute('position');
  if (!posAttr || posAttr.count < 3) return null;
  if (Object.keys(geometry.morphAttributes).length > 0) return null;
  if (geometry.drawRange.start !== 0 || Number.isFinite(geometry.drawRange.count)) return null;
  const maxTriangles = opts.maxTriangles ?? REFINE_MAX_TRIANGLES;
  const maxPasses = opts.maxPasses ?? 12;
  let tris = triangleIndex(geometry);
  const before = tris.length / 3;
  if (before === 0 || before >= maxTriangles) return null;

  // Attributes as plain number lists (works for interleaved / normalised ones too).
  const attrs: AttrData[] = [];
  for (const [name, a] of Object.entries(geometry.attributes)) {
    const src = a.array as TypedArray;
    const isFloat = src instanceof Float32Array || src instanceof Float64Array;
    const v = new Array<number>(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) v[i * a.itemSize + k] = a.getComponent(i, k);
    attrs.push({
      name,
      itemSize: a.itemSize,
      normalized: a.normalized,
      ctor: src.constructor as AttrData['ctor'],
      v,
      copy: name.startsWith('skin') || (!isFloat && !a.normalized),
      unit: name === 'normal' || name === 'tangent',
    });
  }
  const P = attrs.find((a) => a.name === 'position')!.v;

  // Weld by exact position: splits are decided per welded edge.
  const weld: number[] = new Array(posAttr.count);
  {
    const ids = new Map<string, number>();
    for (let i = 0; i < posAttr.count; i++) {
      const key = `${P[i * 3]},${P[i * 3 + 1]},${P[i * 3 + 2]}`;
      let id = ids.get(key);
      if (id === undefined) ids.set(key, (id = ids.size));
      weld[i] = id;
    }
  }
  let weldCount = new Set(weld).size;

  // Keep the result near the budget: coarser target on large surfaces.
  let area = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  const maxEdge = Math.max(opts.maxEdge, Math.sqrt((4 * area) / maxTriangles));
  if (!(maxEdge > 0)) return null;
  const max2 = maxEdge * maxEdge;
  const len2 = (a: number, b: number) => {
    const dx = P[a * 3] - P[b * 3], dy = P[a * 3 + 1] - P[b * 3 + 1], dz = P[a * 3 + 2] - P[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };

  // Groups as triangle ranges, remapped after each pass.
  let groups = geometry.groups.map((g) => ({ ...g, t0: Math.floor(g.start / 3), t1: Math.floor((g.start + g.count) / 3) }));
  let vertexCount = posAttr.count;
  let passes = 0;

  const addMid = (a: number, b: number): number => {
    const v = vertexCount++;
    for (const at of attrs) {
      const s = at.itemSize, o = v * s;
      if (at.copy) {
        for (let k = 0; k < s; k++) at.v[o + k] = at.v[a * s + k];
        continue;
      }
      for (let k = 0; k < s; k++) at.v[o + k] = (at.v[a * s + k] + at.v[b * s + k]) / 2;
      if (!at.unit) continue;
      // Unit xyz (a tangent's w is its handedness: taken from one end).
      if (s === 4) at.v[o + 3] = at.v[a * s + 3];
      const l = Math.hypot(at.v[o], at.v[o + 1], at.v[o + 2]);
      if (l > 1e-10) for (let k = 0; k < 3; k++) at.v[o + k] /= l;
      else for (let k = 0; k < 3; k++) at.v[o + k] = at.v[a * s + k];
    }
    return v;
  };

  while (passes < maxPasses) {
    const nt = tris.length / 3;
    // Welded edges to split this pass → the weld id of their midpoint.
    const split = new Map<number, number>();
    const marks = new Uint8Array(nt);
    let added = 0;
    for (let t = 0; t < nt; t++) {
      let m = 0;
      for (let e = 0; e < 3; e++) {
        const a = tris[t * 3 + e], b = tris[t * 3 + ((e + 1) % 3)];
        if (len2(a, b) <= max2) continue;
        m |= 1 << e;
        added++;
        const wk = pairKey(weld[a], weld[b]);
        if (!split.has(wk)) split.set(wk, -1);
      }
      marks[t] = m;
    }
    if (split.size === 0 || nt + added > maxTriangles || vertexCount + 2 * split.size >= PAIR) break;
    passes++;
    const mids = new Map<number, number>();
    const mid = (a: number, b: number): number => {
      const k = pairKey(a, b);
      let v = mids.get(k);
      if (v === undefined) {
        v = addMid(a, b);
        mids.set(k, v);
        const wk = pairKey(weld[a], weld[b]);
        let w = split.get(wk)!;
        if (w < 0) split.set(wk, (w = weldCount++));
        weld[v] = w;
      }
      return v;
    };
    const out: number[] = [];
    const first = new Uint32Array(nt + 1); // first child of each old triangle
    const push = (a: number, b: number, c: number) => out.push(a, b, c);
    for (let t = 0; t < nt; t++) {
      first[t] = out.length / 3;
      let a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
      const m = marks[t];
      if (m === 0) {
        push(a, b, c);
        continue;
      }
      if (m === 7) {
        const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
        push(a, ab, ca);
        push(ab, b, bc);
        push(ca, bc, c);
        push(ab, bc, ca);
        continue;
      }
      // Rotate so edge a-b is split (and, with two, b-c too); winding kept.
      const two = m === 3 || m === 5 || m === 6;
      const lead = two ? (m === 3 ? 0 : m === 6 ? 1 : 2) : m === 1 ? 0 : m === 2 ? 1 : 2;
      for (let r = 0; r < lead; r++) {
        const x = a;
        a = b;
        b = c;
        c = x;
      }
      const ab = mid(a, b);
      if (!two) {
        push(a, ab, c);
        push(ab, b, c);
        continue;
      }
      const bc = mid(b, c);
      push(ab, b, bc);
      // Quad a, ab, bc, c: cut along the shorter diagonal.
      if (len2(a, bc) <= len2(ab, c)) {
        push(a, ab, bc);
        push(a, bc, c);
      } else {
        push(a, ab, c);
        push(ab, bc, c);
      }
    }
    first[nt] = out.length / 3;
    groups = groups.map((g) => ({ ...g, t0: first[Math.min(nt, g.t0)], t1: first[Math.min(nt, g.t1)] }));
    tris = Uint32Array.from(out);
  }
  if (passes === 0) return null;

  // Write back in place (release the old GPU buffers first).
  geometry.dispose();
  for (const at of attrs) {
    const arr = new at.ctor(vertexCount * at.itemSize);
    const attr = new BufferAttribute(arr, at.itemSize, at.normalized);
    if (at.normalized) {
      for (let i = 0; i < vertexCount; i++) for (let k = 0; k < at.itemSize; k++) attr.setComponent(i, k, at.v[i * at.itemSize + k]);
    } else if (at.ctor === Float32Array || at.ctor === Float64Array) arr.set(at.v);
    else for (let i = 0; i < arr.length; i++) arr[i] = Math.round(at.v[i]);
    attr.name = geometry.getAttribute(at.name).name;
    geometry.setAttribute(at.name, attr);
  }
  geometry.setIndex(new BufferAttribute(vertexCount > 65535 ? tris : Uint16Array.from(tris), 1));
  geometry.clearGroups();
  for (const g of groups) if (g.t1 > g.t0) geometry.addGroup(g.t0 * 3, (g.t1 - g.t0) * 3, g.materialIndex);
  delete geometry.boundsTree; // built for the old index
  if (geometry.boundingBox) geometry.computeBoundingBox();
  if (geometry.boundingSphere) geometry.computeBoundingSphere();
  return { trianglesBefore: before, trianglesAfter: tris.length / 3, passes };
}
