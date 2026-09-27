/**
 * Automatic skin weights (Pinocchio-style heuristic, without the heat solve):
 *
 *  1. Vertices are welded by position (depth meshes duplicate every rim /
 *     wall vertex) and the triangle adjacency is built on welded ids.
 *  2. Per welded vertex, the distance to every bone segment (rest pose) is
 *     computed; bones within `ratio` × the nearest distance are candidates.
 *  3. Visibility: a candidate counts only when the segment from the vertex
 *     to its closest point on the bone stays inside the mesh (a BVH ray
 *     test, three-mesh-bvh) — this keeps e.g. torso vertices under the arm
 *     from binding to the arm, and the inner thigh from the other leg. No
 *     visible candidate → the nearest bone.
 *  4. Weight = 1 / d^power, then `iterations` rounds of Laplacian smoothing
 *     over the welded adjacency (sparse, ≤ 8 influences while smoothing),
 *     top 4 kept and normalised.
 *
 * Time-sliced (yields every ~25 ms). The app runs it in the geometry worker
 * (./weigher.ts, src/workers/geometry.worker.ts), else on the main thread.
 * 100k vertices take ~1–3 s.
 */
import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { AbortError } from '../core/types';
import type { BoneSegment } from './skeleton';

export interface SkinningOptions {
  /** Exponent k of the 1 / d^k falloff (default 4). */
  power: number;
  /** Bones farther than ratio × the nearest bone are ignored (default 2.2). */
  ratio: number;
  /** Visibility test (default true). */
  visibility: boolean;
  /** Laplacian smoothing iterations; null = automatic from the vertex count (3..12). */
  smoothIterations: number | null;
  /** 0..1 blend towards the neighbours' mean per iteration (default 0.5). */
  smoothFactor: number;
  signal?: AbortSignal;
  /** 0..1 */
  onProgress?: (ratio: number) => void;
}

export const DEFAULT_SKINNING: SkinningOptions = {
  power: 4,
  ratio: 2.2,
  visibility: true,
  smoothIterations: null,
  smoothFactor: 0.5,
};

export interface SkinWeights {
  /** 4 bone indices per input vertex. */
  skinIndex: Uint16Array;
  /** 4 weights per input vertex, summing to 1. */
  skinWeight: Float32Array;
}

/** Welding / adjacency / BVH of a triangle soup, reusable across re-weights (joint edits). */
export interface SkinPrep {
  /** Input vertex → welded vertex. */
  weld: Int32Array;
  /** Welded positions (xyz). */
  pos: Float32Array;
  count: number;
  /** CSR adjacency over welded vertices (edges appear once per adjacent triangle). */
  adjStart: Int32Array;
  adj: Int32Array;
  bvh: MeshBVH | null;
  diag: number;
}

export function prepareSkinning(positions: Float32Array, index: Uint32Array, withBvh = true): SkinPrep {
  const n = positions.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const diag = n ? Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1 : 1;
  const q = diag * 1e-6;

  // Weld with an open-addressing hash of the quantised coordinates.
  let size = 1;
  while (size < n * 2) size <<= 1;
  const table = new Int32Array(size).fill(-1);
  const keys = new Int32Array(n * 3);
  const weld = new Int32Array(n);
  const pos = new Float32Array(n * 3);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const qx = Math.round(positions[i * 3] / q) | 0, qy = Math.round(positions[i * 3 + 1] / q) | 0, qz = Math.round(positions[i * 3 + 2] / q) | 0;
    let h = (Math.imul(qx, 73856093) ^ Math.imul(qy, 19349663) ^ Math.imul(qz, 83492791)) & (size - 1);
    for (;;) {
      const w = table[h];
      if (w < 0) {
        table[h] = count;
        keys[count * 3] = qx;
        keys[count * 3 + 1] = qy;
        keys[count * 3 + 2] = qz;
        pos[count * 3] = positions[i * 3];
        pos[count * 3 + 1] = positions[i * 3 + 1];
        pos[count * 3 + 2] = positions[i * 3 + 2];
        weld[i] = count++;
        break;
      }
      if (keys[w * 3] === qx && keys[w * 3 + 1] === qy && keys[w * 3 + 2] === qz) {
        weld[i] = w;
        break;
      }
      h = (h + 1) & (size - 1);
    }
  }

  // Adjacency (CSR).
  const deg = new Int32Array(count + 1);
  const nt = Math.floor(index.length / 3);
  for (let t = 0; t < nt; t++) {
    const a = weld[index[t * 3]], b = weld[index[t * 3 + 1]], c = weld[index[t * 3 + 2]];
    if (a !== b) { deg[a]++; deg[b]++; }
    if (b !== c) { deg[b]++; deg[c]++; }
    if (c !== a) { deg[c]++; deg[a]++; }
  }
  const adjStart = new Int32Array(count + 1);
  for (let i = 0; i < count; i++) adjStart[i + 1] = adjStart[i] + deg[i];
  const fill = adjStart.slice(0, count);
  const adj = new Int32Array(adjStart[count]);
  const link = (a: number, b: number) => {
    adj[fill[a]++] = b;
    adj[fill[b]++] = a;
  };
  for (let t = 0; t < nt; t++) {
    const a = weld[index[t * 3]], b = weld[index[t * 3 + 1]], c = weld[index[t * 3 + 2]];
    if (a !== b) link(a, b);
    if (b !== c) link(b, c);
    if (c !== a) link(c, a);
  }

  let bvh: MeshBVH | null = null;
  if (withBvh && nt > 0) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions.slice(), 3));
    g.setIndex(new BufferAttribute(index.slice(0, nt * 3), 1));
    bvh = new MeshBVH(g, { targetLeafSize: 8 });
  }
  return { weld, pos, count, adjStart, adj, bvh, diag };
}

const K = 8; // influences kept while smoothing
const MAX_CANDIDATES = 6;

function makeYielder(signal?: AbortSignal) {
  let last = performance.now();
  return async () => {
    if (signal?.aborted) throw new AbortError();
    if (performance.now() - last < 25) return;
    await new Promise<void>((r) => setTimeout(r, 0));
    if (signal?.aborted) throw new AbortError();
    last = performance.now();
  };
}

export async function computeSkinWeights(
  prep: SkinPrep,
  segments: BoneSegment[],
  options: Partial<SkinningOptions> = {},
): Promise<SkinWeights> {
  const o = { ...DEFAULT_SKINNING, ...options };
  const { count, pos } = prep;
  const nS = segments.length;
  if (nS === 0) throw new Error('No bones to skin to');
  const maybeYield = makeYielder(o.signal);
  const report = (r: number) => o.onProgress?.(Math.min(1, Math.max(0, r)));

  // Segment data.
  const sa = new Float64Array(nS * 3), sab = new Float64Array(nS * 3), sInv = new Float64Array(nS);
  segments.forEach((s, k) => {
    sa[k * 3] = s.head.x; sa[k * 3 + 1] = s.head.y; sa[k * 3 + 2] = s.head.z;
    const dx = s.tail.x - s.head.x, dy = s.tail.y - s.head.y, dz = s.tail.z - s.head.z;
    sab[k * 3] = dx; sab[k * 3 + 1] = dy; sab[k * 3 + 2] = dz;
    const l2 = dx * dx + dy * dy + dz * dz;
    sInv[k] = l2 > 1e-18 ? 1 / l2 : 0;
  });

  let wIdx = new Int16Array(count * K).fill(-1);
  let wVal = new Float32Array(count * K);
  const dist = new Float64Array(nS), tPar = new Float64Array(nS);
  const cand: number[] = [];
  const ray = new Ray(), target = new Vector3();
  const eps = prep.diag * 2e-3;
  const bvh = o.visibility ? prep.bvh : null;
  const floorD = prep.diag * 1e-4;

  for (let v = 0; v < count; v++) {
    const px = pos[v * 3], py = pos[v * 3 + 1], pz = pos[v * 3 + 2];
    let dMin = Infinity, kMin = 0;
    for (let k = 0; k < nS; k++) {
      const ax = sa[k * 3], ay = sa[k * 3 + 1], az = sa[k * 3 + 2];
      const bx = sab[k * 3], by = sab[k * 3 + 1], bz = sab[k * 3 + 2];
      let t = ((px - ax) * bx + (py - ay) * by + (pz - az) * bz) * sInv[k];
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + bx * t - px, cy = ay + by * t - py, cz = az + bz * t - pz;
      const d = Math.sqrt(cx * cx + cy * cy + cz * cz);
      dist[k] = d;
      tPar[k] = t;
      if (d < dMin) {
        dMin = d;
        kMin = k;
      }
    }
    cand.length = 0;
    const limit = dMin * o.ratio + floorD;
    for (let k = 0; k < nS; k++) if (dist[k] <= limit) cand.push(k);
    cand.sort((a, b) => dist[a] - dist[b]);
    if (cand.length > MAX_CANDIDATES) cand.length = MAX_CANDIDATES;

    let slot = 0;
    const base = v * K;
    if (cand.length > 1 && bvh) {
      for (const k of cand) {
        const d = dist[k];
        if (d > eps * 2) {
          const t = tPar[k];
          target.set(sa[k * 3] + sab[k * 3] * t, sa[k * 3 + 1] + sab[k * 3 + 1] * t, sa[k * 3 + 2] + sab[k * 3 + 2] * t);
          ray.origin.set(px, py, pz);
          ray.direction.copy(target).sub(ray.origin).multiplyScalar(1 / d);
          if (bvh.raycastFirst(ray, DoubleSide, eps, d - eps)) continue;
        }
        wIdx[base + slot] = k;
        wVal[base + slot++] = 1 / Math.pow(Math.max(d, floorD), o.power);
      }
    } else {
      for (const k of cand) {
        wIdx[base + slot] = k;
        wVal[base + slot++] = 1 / Math.pow(Math.max(dist[k], floorD), o.power);
      }
    }
    if (slot === 0) {
      wIdx[base] = kMin;
      wVal[base] = 1;
      slot = 1;
    }
    let sum = 0;
    for (let s = 0; s < slot; s++) sum += wVal[base + s];
    for (let s = 0; s < slot; s++) wVal[base + s] /= sum;
    if ((v & 1023) === 1023) {
      report(0.7 * (v / count));
      await maybeYield();
    }
  }

  // Laplacian smoothing on the sparse weights.
  const iterations = o.smoothIterations ?? Math.min(12, Math.max(3, Math.round(Math.sqrt(count) / 25)));
  const lambda = Math.min(1, Math.max(0, o.smoothFactor));
  if (iterations > 0 && lambda > 0) {
    let outIdx = new Int16Array(count * K);
    let outVal = new Float32Array(count * K);
    const acc = new Float64Array(nS);
    const touched = new Int32Array(nS);
    const mark = new Uint8Array(nS);
    const { adjStart, adj } = prep;
    for (let it = 0; it < iterations; it++) {
      for (let v = 0; v < count; v++) {
        let nt = 0;
        const a0 = adjStart[v], a1 = adjStart[v + 1];
        const deg = a1 - a0;
        // Own weights (1 - λ), then each neighbour's (λ / degree).
        for (let e = a0 - 1; e < a1; e++) {
          const u = e < a0 ? v : adj[e];
          const f = e < a0 ? (deg ? 1 - lambda : 1) : lambda / deg;
          const ub = u * K;
          for (let s = 0; s < K; s++) {
            const k = wIdx[ub + s];
            if (k < 0) break;
            if (!mark[k]) {
              mark[k] = 1;
              touched[nt++] = k;
            }
            acc[k] += wVal[ub + s] * f;
          }
        }
        // Top K of the touched bones.
        const b = v * K;
        let n = 0;
        for (let q = 0; q < nt; q++) {
          const k = touched[q];
          const w = acc[k];
          acc[k] = 0;
          mark[k] = 0;
          if (w <= 1e-7) continue;
          if (n < K) {
            outIdx[b + n] = k;
            outVal[b + n++] = w;
          } else {
            let minS = 0;
            for (let s = 1; s < K; s++) if (outVal[b + s] < outVal[b + minS]) minS = s;
            if (w > outVal[b + minS]) {
              outIdx[b + minS] = k;
              outVal[b + minS] = w;
            }
          }
        }
        let sum = 0;
        for (let s = 0; s < n; s++) sum += outVal[b + s];
        for (let s = 0; s < n; s++) outVal[b + s] /= sum;
        for (let s = n; s < K; s++) {
          outIdx[b + s] = -1;
          outVal[b + s] = 0;
        }
        if ((v & 2047) === 2047) {
          report(0.7 + 0.28 * ((it + v / count) / iterations));
          await maybeYield();
        }
      }
      [wIdx, outIdx] = [outIdx, wIdx];
      [wVal, outVal] = [outVal, wVal];
    }
  }

  // Top 4 per welded vertex, scattered to every input vertex.
  const w4i = new Uint16Array(count * 4), w4v = new Float32Array(count * 4);
  for (let v = 0; v < count; v++) {
    const b = v * K;
    const order: number[] = [];
    for (let s = 0; s < K && wIdx[b + s] >= 0; s++) order.push(s);
    order.sort((x, y) => wVal[b + y] - wVal[b + x]);
    let sum = 0;
    for (let s = 0; s < 4 && s < order.length; s++) sum += wVal[b + order[s]];
    for (let s = 0; s < 4; s++) {
      if (s < order.length && sum > 0) {
        w4i[v * 4 + s] = segments[wIdx[b + order[s]]].index;
        w4v[v * 4 + s] = wVal[b + order[s]] / sum;
      }
    }
    if (sum <= 0) {
      w4i[v * 4] = segments[0].index;
      w4v[v * 4] = 1;
    }
  }
  const n = prep.weld.length;
  const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const w = prep.weld[i];
    for (let s = 0; s < 4; s++) {
      skinIndex[i * 4 + s] = w4i[w * 4 + s];
      skinWeight[i * 4 + s] = w4v[w * 4 + s];
    }
  }
  report(1);
  return { skinIndex, skinWeight };
}
