/**
 * The triangles of every (non-skinned) mesh under a model root, merged into
 * one soup in the root's local frame — the frame joints, bones and skin
 * weights live in. Shared by auto joint placement and skinning.
 */
import { Box3, Matrix4, Vector3 } from 'three';
import type { BufferGeometry, Mesh, Object3D } from 'three';

export interface MeshRange {
  mesh: Mesh;
  /** First vertex of this mesh in the merged arrays. */
  start: number;
  count: number;
}

export interface MeshData {
  /** xyz per vertex, root-local. */
  positions: Float32Array;
  /** Triangle vertex indices into `positions`. */
  index: Uint32Array;
  ranges: MeshRange[];
  box: Box3;
}

/** Set on a mesh whose geometry was moved to a skinned child by the rig (it renders nothing). */
export const RIG_PLACEHOLDER = 'rigPlaceholder';

export function isRigPlaceholder(o: Object3D): boolean {
  return !!(o.userData as Record<string, unknown>)[RIG_PLACEHOLDER];
}

/** Meshes the rig skins: plain meshes with positions (not skinned, not rig placeholders). */
export function skinnableMeshes(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh || (m as { isSkinnedMesh?: boolean }).isSkinnedMesh || isRigPlaceholder(m)) return;
    const pos = (m.geometry as BufferGeometry | undefined)?.getAttribute('position');
    if (pos && pos.count > 0) out.push(m);
  });
  return out;
}

export function collectMeshData(root: Object3D, meshes: Mesh[] = skinnableMeshes(root)): MeshData {
  root.updateWorldMatrix(true, true);
  const toRoot = new Matrix4().copy(root.matrixWorld).invert();
  let nV = 0, nI = 0;
  for (const m of meshes) {
    const g = m.geometry;
    nV += g.getAttribute('position').count;
    nI += g.getIndex()?.count ?? g.getAttribute('position').count;
  }
  const positions = new Float32Array(nV * 3);
  const index = new Uint32Array(nI - (nI % 3));
  const ranges: MeshRange[] = [];
  const box = new Box3();
  const v = new Vector3(), mat = new Matrix4();
  let vOff = 0, iOff = 0;
  for (const m of meshes) {
    const g = m.geometry;
    const pos = g.getAttribute('position');
    mat.multiplyMatrices(toRoot, m.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mat);
      positions[(vOff + i) * 3] = v.x;
      positions[(vOff + i) * 3 + 1] = v.y;
      positions[(vOff + i) * 3 + 2] = v.z;
      box.expandByPoint(v);
    }
    const idx = g.getIndex();
    const count = (idx ? idx.count : pos.count) - ((idx ? idx.count : pos.count) % 3);
    for (let k = 0; k < count && iOff < index.length; k++) index[iOff++] = vOff + (idx ? idx.getX(k) : k);
    ranges.push({ mesh: m, start: vOff, count: pos.count });
    vOff += pos.count;
  }
  return { positions, index: iOff === index.length ? index : index.slice(0, iOff), ranges, box };
}
