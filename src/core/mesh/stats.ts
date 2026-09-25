/**
 * Mesh statistics for the UI (and tests): vertex / triangle counts and a
 * watertightness check that works on welded positions, so meshes that split
 * vertices for hard edges or UV seams (or are not indexed at all) still count
 * as closed when their surface is.
 */
import type { BufferGeometry } from 'three';

export interface MeshStats {
  /** Distinct vertex positions used by triangles (after welding; what STL tools / slicers report). */
  vertices: number;
  triangles: number;
  /** Closed, consistently oriented 2-manifold: every welded edge is used by exactly two triangles, once in each direction. */
  watertight: boolean;
}

/** Positions closer than this fraction of the bounding-box diagonal are welded. */
const WELD_TOLERANCE = 1e-6;

export function computeMeshStats(g: BufferGeometry): MeshStats {
  const pos = g.getAttribute('position');
  if (!pos || pos.count === 0) return { vertices: 0, triangles: 0, watertight: false };
  const index = g.getIndex();
  const nCorners = index ? index.count - (index.count % 3) : pos.count - (pos.count % 3);
  const triangles = nCorners / 3;
  const corner = (k: number) => (index ? index.getX(k) : k);

  // Bounding box of all positions → quantisation step.
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let finite = true;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (!Number.isFinite(x + y + z)) { finite = false; continue; }
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  const inv = 1 / Math.max(diag * WELD_TOLERANCE, 1e-12);

  // Weld referenced vertices with an open-addressing hash on quantised coordinates.
  const weld = new Int32Array(pos.count).fill(-1);
  const vCap = pow2(pos.count * 2);
  const vSlots = new Int32Array(vCap).fill(-1);
  const keys = new Int32Array(pos.count * 3);
  let nWelded = 0;
  const weldOf = (v: number): number => {
    const cached = weld[v];
    if (cached >= 0) return cached;
    const qx = Math.round((pos.getX(v) - minX) * inv) | 0;
    const qy = Math.round((pos.getY(v) - minY) * inv) | 0;
    const qz = Math.round((pos.getZ(v) - minZ) * inv) | 0;
    let h = (Math.imul(qx, 73856093) ^ Math.imul(qy, 19349663) ^ Math.imul(qz, 83492791)) & (vCap - 1);
    for (;;) {
      const id = vSlots[h];
      if (id < 0) {
        vSlots[h] = nWelded;
        keys[nWelded * 3] = qx; keys[nWelded * 3 + 1] = qy; keys[nWelded * 3 + 2] = qz;
        return (weld[v] = nWelded++);
      }
      if (keys[id * 3] === qx && keys[id * 3 + 1] === qy && keys[id * 3 + 2] === qz) return (weld[v] = id);
      h = (h + 1) & (vCap - 1);
    }
  };

  // Directed edge counts per undirected welded edge.
  const eCap = pow2(triangles * 4);
  const eSlots = new Int32Array(eCap).fill(-1);
  const eLo = new Int32Array(triangles * 3), eHi = new Int32Array(triangles * 3);
  const fwd = new Uint8Array(triangles * 3), bwd = new Uint8Array(triangles * 3);
  let nEdges = 0, nFaces = 0;
  const addEdge = (a: number, b: number) => {
    const lo = a < b ? a : b, hi = a < b ? b : a;
    let h = (Math.imul(lo, 73856093) ^ Math.imul(hi, 19349663)) & (eCap - 1);
    for (;;) {
      let id = eSlots[h];
      if (id < 0) {
        id = eSlots[h] = nEdges++;
        eLo[id] = lo; eHi[id] = hi;
      } else if (eLo[id] !== lo || eHi[id] !== hi) {
        h = (h + 1) & (eCap - 1);
        continue;
      }
      if (a < b) { if (fwd[id] < 255) fwd[id]++; } else if (bwd[id] < 255) bwd[id]++;
      return;
    }
  };

  for (let k = 0; k < nCorners; k += 3) {
    const a = weldOf(corner(k)), b = weldOf(corner(k + 1)), c = weldOf(corner(k + 2));
    if (a === b || b === c || c === a) continue; // degenerate after welding: no surface
    nFaces++;
    addEdge(a, b); addEdge(b, c); addEdge(c, a);
  }

  let watertight = finite && nFaces > 0;
  for (let e = 0; watertight && e < nEdges; e++) if (fwd[e] !== 1 || bwd[e] !== 1) watertight = false;
  return { vertices: nWelded, triangles, watertight };
}

function pow2(n: number): number {
  let c = 16;
  while (c < n) c *= 2;
  return c;
}
