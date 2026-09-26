/**
 * Editable view of one BufferGeometry for sculpting: welded topology, a BVH
 * (three-mesh-bvh, indirect so the index is never reordered), sphere
 * queries that also collect the BVH nodes to refit, welded moves, normal
 * updates for the touched region only, GPU update ranges and per-stroke
 * change recording (sparse old / new values for undo / redo).
 *
 * Everything works in the geometry's local frame and runs in Node (tests).
 */
import { BufferAttribute, Sphere, type Box3, type BufferGeometry, type Vector3 } from 'three';
import { CONTAINED, INTERSECTED, MeshBVH, NOT_INTERSECTED, type GeometryBVH } from 'three-mesh-bvh';
import { buildTopology, type SculptTopology, type TopologyOptions } from './topology';

/** Result of a sphere query: welded groups inside it and their normalised distance t = d / r. */
export class Gathered {
  groups = new Int32Array(256);
  t = new Float32Array(256);
  count = 0;
  /** BVH node ids whose bounds may change when these groups move (paths to the touched leaves). */
  readonly nodes = new Set<number>();

  push(g: number, t: number): void {
    if (this.count === this.groups.length) {
      const groups = new Int32Array(this.count * 2);
      groups.set(this.groups);
      this.groups = groups;
      const tt = new Float32Array(this.count * 2);
      tt.set(this.t);
      this.t = tt;
    }
    this.groups[this.count] = g;
    this.t[this.count++] = t;
  }

  reset(): void {
    this.count = 0;
    this.nodes.clear();
  }
}

/** Sparse change of one mesh over one stroke (vertex indices + old / new xyz). */
export interface MeshDelta {
  mesh: SculptMesh;
  posIdx: Uint32Array;
  posOld: Float32Array;
  posNew: Float32Array;
  nrmIdx: Uint32Array;
  nrmOld: Float32Array;
  nrmNew: Float32Array;
}

export function deltaBytes(d: MeshDelta): number {
  return d.posIdx.byteLength + d.posOld.byteLength + d.posNew.byteLength + d.nrmIdx.byteLength + d.nrmOld.byteLength + d.nrmNew.byteLength;
}

/** Growable list of vertex indices with their saved xyz. */
class Track {
  idx = new Uint32Array(64);
  xyz = new Float32Array(192);
  count = 0;

  push(v: number, src: Float32Array): void {
    if (this.count === this.idx.length) {
      const idx = new Uint32Array(this.count * 2);
      idx.set(this.idx);
      this.idx = idx;
      const xyz = new Float32Array(this.count * 6);
      xyz.set(this.xyz);
      this.xyz = xyz;
    }
    const o = this.count * 3;
    this.idx[this.count++] = v;
    this.xyz[o] = src[v * 3];
    this.xyz[o + 1] = src[v * 3 + 1];
    this.xyz[o + 2] = src[v * 3 + 2];
  }
}

/**
 * Make `name` a plain, non-normalised Float32 xyz attribute (interleaved or
 * quantised glTF attributes are copied out once, values unchanged).
 */
function plainFloat3(geometry: BufferGeometry, name: 'position' | 'normal'): BufferAttribute | null {
  const attr = geometry.getAttribute(name);
  if (!attr) return null;
  const plain =
    attr instanceof BufferAttribute && attr.array instanceof Float32Array && attr.itemSize === 3 && !attr.normalized;
  if (plain) return attr;
  const arr = new Float32Array(attr.count * 3);
  for (let i = 0; i < attr.count; i++) {
    arr[i * 3] = attr.getX(i);
    arr[i * 3 + 1] = attr.getY(i);
    arr[i * 3 + 2] = attr.getZ(i);
  }
  const out = new BufferAttribute(arr, 3);
  out.name = attr.name;
  geometry.setAttribute(name, out);
  return out;
}

/** True when `geometry` has at least one triangle to sculpt. */
export function isSculptable(geometry: BufferGeometry): boolean {
  const pos = geometry.getAttribute('position');
  if (!pos || pos.count < 3) return false;
  const index = geometry.getIndex();
  return (index ? index.count : pos.count) >= 3;
}

export class SculptMesh {
  readonly topo: SculptTopology;
  readonly bvh: MeshBVH;
  readonly posAttr: BufferAttribute;
  readonly nrmAttr: BufferAttribute;
  /** Positions / normals at session start (reset). */
  readonly originalPos: Float32Array;
  readonly originalNrm: Float32Array;

  private readonly prevBoundsTree: GeometryBVH | undefined;
  private readonly sphere = new Sphere();
  private readonly path: number[] = [];
  private readonly stamp: Int32Array;
  private readonly inside: Uint8Array;
  private stampId = 0;
  private readonly nStamp: Int32Array;
  private nStampId = 0;
  private readonly strokeStampPos: Int32Array;
  private readonly strokeStampNrm: Int32Array;
  private strokeId = 0;
  private posTrack: Track | null = null;
  private nrmTrack: Track | null = null;
  private dirtyPos: [number, number] = [Infinity, -Infinity];
  private dirtyNrm: [number, number] = [Infinity, -Infinity];
  private disposed = false;

  constructor(
    readonly geometry: BufferGeometry,
    opts: TopologyOptions = {},
  ) {
    const pos = plainFloat3(geometry, 'position');
    if (!pos) throw new Error('SculptMesh: geometry has no position attribute');
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const nrm = plainFloat3(geometry, 'normal')!;
    this.posAttr = pos;
    this.nrmAttr = nrm;
    const index = geometry.getIndex();
    this.topo = buildTopology(pos.array as Float32Array, index ? index.array : null, nrm.array as Float32Array, opts);
    this.originalPos = new Float32Array(pos.array as Float32Array);
    this.originalNrm = new Float32Array(nrm.array as Float32Array);
    const g = this.topo.groupCount;
    this.stamp = new Int32Array(g);
    this.inside = new Uint8Array(g);
    this.nStamp = new Int32Array(g);
    this.strokeStampPos = new Int32Array(this.topo.vertexCount);
    this.strokeStampNrm = new Int32Array(this.topo.vertexCount);
    // Indirect: the BVH sorts its own triangle list and leaves the index as is.
    this.prevBoundsTree = geometry.boundsTree;
    this.bvh = new MeshBVH(geometry, { indirect: true, setBoundingBox: false });
    geometry.boundsTree = this.bvh;
  }

  get pos(): Float32Array {
    return this.posAttr.array as Float32Array;
  }

  get nrm(): Float32Array {
    return this.nrmAttr.array as Float32Array;
  }

  /** Representative (first) vertex of group g. */
  rep(g: number): number {
    return this.topo.gVerts[this.topo.gStart[g]];
  }

  /**
   * Groups whose position lies inside the sphere (c, r), with t = d / r.
   * Also collects the BVH node ids on the paths to every leaf holding a
   * triangle that touches one of them (for a partial refit after moving).
   */
  gather(c: Vector3, r: number, out: Gathered): void {
    out.reset();
    if (!(r > 0)) return;
    if (++this.stampId >= 0x7fffffff) {
      this.stamp.fill(0);
      this.stampId = 1;
    }
    const id = this.stampId;
    const { stamp, inside, path, bvh } = this;
    const { tris, gid, gStart, gVerts } = this.topo;
    const pos = this.pos;
    const cx = c.x, cy = c.y, cz = c.z, r2 = r * r;
    const sphere = this.sphere.set(c, r);
    bvh.shapecast({
      intersectsBounds: (box: Box3, _leaf: boolean, _score: number | undefined, depth: number, node: number) => {
        path[depth] = node;
        if (!sphere.intersectsBox(box)) return NOT_INTERSECTED;
        return boxInSphere(box, cx, cy, cz, r2) ? CONTAINED : INTERSECTED;
      },
      intersectsRange: (offset: number, count: number, _contained: boolean, depth: number, node: number) => {
        let touched = false;
        for (let i = offset, end = offset + count; i < end; i++) {
          const t3 = bvh.resolveTriangleIndex(i) * 3;
          for (let k = 0; k < 3; k++) {
            const g = gid[tris[t3 + k]];
            if (stamp[g] !== id) {
              stamp[g] = id;
              const v = gVerts[gStart[g]] * 3;
              const dx = pos[v] - cx, dy = pos[v + 1] - cy, dz = pos[v + 2] - cz;
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 < r2) {
                inside[g] = 1;
                out.push(g, Math.sqrt(d2) / r);
              } else inside[g] = 0;
            }
            if (inside[g]) touched = true;
          }
        }
        if (touched) {
          for (let d = 1; d < depth; d++) out.nodes.add(path[d]);
          out.nodes.add(node);
        }
        return false;
      },
    });
  }

  /** Move every member of group g by (dx, dy, dz). */
  moveGroup(g: number, dx: number, dy: number, dz: number): void {
    const { gStart, gVerts } = this.topo;
    const pos = this.pos;
    for (let k = gStart[g], e = gStart[g + 1]; k < e; k++) {
      const v = gVerts[k];
      this.recordPos(v);
      const o = v * 3;
      pos[o] += dx;
      pos[o + 1] += dy;
      pos[o + 2] += dz;
      this.markPos(v);
    }
  }

  /** Move group g to (x, y, z) (its representative lands there; members keep their offsets). */
  setGroup(g: number, x: number, y: number, z: number): void {
    const o = this.rep(g) * 3;
    const pos = this.pos;
    this.moveGroup(g, x - pos[o], y - pos[o + 1], z - pos[o + 2]);
  }

  /**
   * Recompute the normals of `groups` and their welded neighbours (their
   * face normals changed): per normal class, the area-weighted sum of the
   * face normals of the triangles around its members.
   */
  updateNormals(groups: ArrayLike<number>, count = groups.length): void {
    if (++this.nStampId >= 0x7fffffff) {
      this.nStamp.fill(0);
      this.nStampId = 1;
    }
    const id = this.nStampId;
    const { adjStart, adj } = this.topo;
    const stamp = this.nStamp;
    for (let i = 0; i < count; i++) {
      const g = groups[i];
      if (stamp[g] !== id) {
        stamp[g] = id;
        this.updateGroupNormal(g);
      }
      for (let k = adjStart[g], e = adjStart[g + 1]; k < e; k++) {
        const h = adj[k];
        if (stamp[h] !== id) {
          stamp[h] = id;
          this.updateGroupNormal(h);
        }
      }
    }
  }

  private updateGroupNormal(g: number): void {
    const { gClass, cStart, gVerts, vtStart, vtTris, tris } = this.topo;
    const pos = this.pos, nrm = this.nrm;
    for (let c = gClass[g], ce = gClass[g + 1]; c < ce; c++) {
      let sx = 0, sy = 0, sz = 0;
      for (let k = cStart[c], ke = cStart[c + 1]; k < ke; k++) {
        const v = gVerts[k];
        for (let j = vtStart[v], je = vtStart[v + 1]; j < je; j++) {
          const t3 = vtTris[j] * 3;
          const a = tris[t3] * 3, b = tris[t3 + 1] * 3, cc = tris[t3 + 2] * 3;
          const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
          const vx = pos[cc] - pos[a], vy = pos[cc + 1] - pos[a + 1], vz = pos[cc + 2] - pos[a + 2];
          sx += uy * vz - uz * vy;
          sy += uz * vx - ux * vz;
          sz += ux * vy - uy * vx;
        }
      }
      const len = Math.hypot(sx, sy, sz);
      if (!(len > 1e-20)) continue; // degenerate: keep the old normal
      sx /= len;
      sy /= len;
      sz /= len;
      for (let k = cStart[c], ke = cStart[c + 1]; k < ke; k++) {
        const v = gVerts[k];
        const o = v * 3;
        if (nrm[o] === sx && nrm[o + 1] === sy && nrm[o + 2] === sz) continue;
        this.recordNrm(v);
        nrm[o] = sx;
        nrm[o + 1] = sy;
        nrm[o + 2] = sz;
        this.markNrm(v);
      }
    }
  }

  /** Current normal of group g's representative. */
  groupNormal(g: number, out: Vector3): Vector3 {
    const o = this.rep(g) * 3;
    const n = this.nrm;
    return out.set(n[o], n[o + 1], n[o + 2]);
  }

  groupPosition(g: number, out: Vector3): Vector3 {
    const o = this.rep(g) * 3;
    const p = this.pos;
    return out.set(p[o], p[o + 1], p[o + 2]);
  }

  /** Refit the BVH: only `nodes` (from gather) when given, else everything. */
  refit(nodes?: Set<number>): void {
    if (nodes && nodes.size === 0) return;
    this.bvh.refit(nodes);
  }

  // ---- stroke recording ----

  beginStroke(): void {
    if (++this.strokeId >= 0x7fffffff) {
      this.strokeStampPos.fill(0);
      this.strokeStampNrm.fill(0);
      this.strokeId = 1;
    }
    this.posTrack = new Track();
    this.nrmTrack = new Track();
  }

  get recording(): boolean {
    return this.posTrack !== null;
  }

  /** Finish recording: the sparse change of this stroke (null when nothing moved). */
  endStroke(): MeshDelta | null {
    const pt = this.posTrack, nt = this.nrmTrack;
    this.posTrack = this.nrmTrack = null;
    this.finishEdit();
    if (!pt || !nt) return null;
    const pos = this.pos, nrm = this.nrm;
    // Keep only vertices that really changed.
    let moved = 0;
    for (let i = 0; i < pt.count; i++) {
      const o = pt.idx[i] * 3;
      if (pos[o] !== pt.xyz[i * 3] || pos[o + 1] !== pt.xyz[i * 3 + 1] || pos[o + 2] !== pt.xyz[i * 3 + 2]) moved++;
    }
    if (moved === 0) return null;
    const pack = (t: Track, src: Float32Array) => {
      const idx = t.idx.slice(0, t.count);
      const oldXyz = t.xyz.slice(0, t.count * 3);
      const newXyz = new Float32Array(t.count * 3);
      for (let i = 0; i < t.count; i++) {
        const o = idx[i] * 3;
        newXyz[i * 3] = src[o];
        newXyz[i * 3 + 1] = src[o + 1];
        newXyz[i * 3 + 2] = src[o + 2];
      }
      return { idx, oldXyz, newXyz };
    };
    const p = pack(pt, pos), n = pack(nt, nrm);
    return { mesh: this, posIdx: p.idx, posOld: p.oldXyz, posNew: p.newXyz, nrmIdx: n.idx, nrmOld: n.oldXyz, nrmNew: n.newXyz };
  }

  /** Write one side of a delta back (undo: 'old', redo: 'new'). */
  applyDelta(d: MeshDelta, side: 'old' | 'new'): void {
    const pos = this.pos, nrm = this.nrm;
    const pv = side === 'old' ? d.posOld : d.posNew;
    const nv = side === 'old' ? d.nrmOld : d.nrmNew;
    for (let i = 0; i < d.posIdx.length; i++) {
      const v = d.posIdx[i], o = v * 3;
      pos[o] = pv[i * 3];
      pos[o + 1] = pv[i * 3 + 1];
      pos[o + 2] = pv[i * 3 + 2];
      this.markPos(v);
    }
    for (let i = 0; i < d.nrmIdx.length; i++) {
      const v = d.nrmIdx[i], o = v * 3;
      nrm[o] = nv[i * 3];
      nrm[o + 1] = nv[i * 3 + 1];
      nrm[o + 2] = nv[i * 3 + 2];
      this.markNrm(v);
    }
    this.refit();
    this.finishEdit();
  }

  /** Difference between the current state and the session start (for an undoable reset). */
  diffToOriginal(): MeshDelta | null {
    const pos = this.pos, nrm = this.nrm;
    const collect = (cur: Float32Array, orig: Float32Array) => {
      const idx: number[] = [];
      for (let v = 0, n = cur.length / 3; v < n; v++) {
        const o = v * 3;
        if (cur[o] !== orig[o] || cur[o + 1] !== orig[o + 1] || cur[o + 2] !== orig[o + 2]) idx.push(v);
      }
      const ii = Uint32Array.from(idx);
      const a = new Float32Array(ii.length * 3), b = new Float32Array(ii.length * 3);
      for (let i = 0; i < ii.length; i++) {
        const o = ii[i] * 3;
        a.set(cur.subarray(o, o + 3), i * 3);
        b.set(orig.subarray(o, o + 3), i * 3);
      }
      return { ii, a, b };
    };
    const p = collect(pos, this.originalPos);
    const n = collect(nrm, this.originalNrm);
    if (p.ii.length === 0 && n.ii.length === 0) return null;
    return { mesh: this, posIdx: p.ii, posOld: p.a, posNew: p.b, nrmIdx: n.ii, nrmOld: n.a, nrmNew: n.b };
  }

  private recordPos(v: number): void {
    if (this.posTrack && this.strokeStampPos[v] !== this.strokeId) {
      this.strokeStampPos[v] = this.strokeId;
      this.posTrack.push(v, this.pos);
    }
  }

  private recordNrm(v: number): void {
    if (this.nrmTrack && this.strokeStampNrm[v] !== this.strokeId) {
      this.strokeStampNrm[v] = this.strokeId;
      this.nrmTrack.push(v, this.nrm);
    }
  }

  private markPos(v: number): void {
    if (v < this.dirtyPos[0]) this.dirtyPos[0] = v;
    if (v > this.dirtyPos[1]) this.dirtyPos[1] = v;
  }

  private markNrm(v: number): void {
    if (v < this.dirtyNrm[0]) this.dirtyNrm[0] = v;
    if (v > this.dirtyNrm[1]) this.dirtyNrm[1] = v;
  }

  /** Push pending changes to the GPU (update ranges over the touched vertex span). Returns true if anything changed. */
  flush(): boolean {
    let changed = false;
    for (const [attr, range] of [
      [this.posAttr, this.dirtyPos],
      [this.nrmAttr, this.dirtyNrm],
    ] as const) {
      if (range[1] < range[0]) continue;
      attr.addUpdateRange(range[0] * 3, (range[1] - range[0] + 1) * 3);
      attr.needsUpdate = true;
      range[0] = Infinity;
      range[1] = -Infinity;
      changed = true;
    }
    return changed;
  }

  /** After a stroke / undo: flush and refresh the bounds used for culling and raycasting. */
  finishEdit(): void {
    this.flush();
    const g = this.geometry;
    if (g.boundingBox) g.computeBoundingBox();
    g.computeBoundingSphere();
  }

  /** Detach from the geometry (keeps the edited positions; restores a previous boundsTree, refitted). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.flush();
    const g = this.geometry;
    if (g.boundsTree === this.bvh) {
      const prev = this.prevBoundsTree;
      if (prev) {
        prev.refit();
        g.boundsTree = prev;
      } else delete g.boundsTree;
    }
  }
}

function boxInSphere(box: Box3, cx: number, cy: number, cz: number, r2: number): boolean {
  const dx = Math.max(Math.abs(box.min.x - cx), Math.abs(box.max.x - cx));
  const dy = Math.max(Math.abs(box.min.y - cy), Math.abs(box.max.y - cy));
  const dz = Math.max(Math.abs(box.min.z - cz), Math.abs(box.max.z - cz));
  return dx * dx + dy * dy + dz * dz < r2;
}
