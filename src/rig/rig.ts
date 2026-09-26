/**
 * Rig a built model in place: every plain mesh under `model.object` is
 * swapped for a SkinnedMesh sharing a CLONED geometry (plus skinIndex /
 * skinWeight) and the original material, the Hips bone is added to
 * `model.object`, and the viewer is told to rescan. When `model.object` is
 * itself a mesh (depth / geometry models) it cannot be swapped (the viewer
 * and the shell hold it), so it keeps its place with an empty placeholder
 * geometry (flagged `userData.rigPlaceholder`; renders nothing, skipped by
 * the exporters) and the skinned copy becomes its child.
 *
 * `unrig()` restores the original meshes / geometry and disposes the skinned
 * clones; `dispose()` is for a model the viewer already dropped (it only
 * frees what the rig still holds). While rigged, `model.remesh` is disabled
 * (re-meshing would replace the skinned surface) and restored on unrig.
 */
import { BufferAttribute, BufferGeometry, SkeletonHelper, SkinnedMesh, Vector3 } from 'three';
import type { Bone, Material, Mesh, Object3D, Skeleton } from 'three';
import type { BuiltModel } from '../app/pipeline';
import { LocalizedError } from '../core/errors';
import { AbortError, type I18nText, type Progress } from '../core/types';
import { yieldToPaint } from '../core/yield';
import { autoPlaceJointsDetailed, completeLayout } from './autoJoints';
import { collectMeshData, isRigPlaceholder, RIG_PLACEHOLDER, skinnableMeshes, type MeshData } from './meshData';
import { applyLayout, boneSegments, buildSkeleton, describeRig, missingBones, resetToRest, type RigDescriptor, type RigSkeleton } from './skeleton';
import { computeSkinWeights, prepareSkinning, type SkinningOptions, type SkinPrep } from './skinning';
import type { HumanoidBone, JointLayout, Vec3 } from './types';

/** The part of ViewerCore the rig uses (structural, so tests can pass a fake). */
export interface RigViewer {
  addOverlay(obj: Object3D): void;
  removeOverlay(obj: Object3D): void;
  invalidate(): void;
  refresh(): void;
  /** Re-collect the object's meshes after they were swapped (newer viewers). */
  rescanObject?: () => void;
  /** Clone carrying the pristine materials (whatever the display mode). */
  getExportObject?: () => Object3D | null;
}

export const RIG_TEXT = {
  alreadySkinned: {
    tr: 'Bu model zaten kendi iskeletine sahip (kemikli GLB); yeniden kemiklendirilemez.',
    en: 'This model already has its own skeleton (skinned GLB); it cannot be rigged again.',
  },
  noMesh: { tr: 'Kemiklendirilecek bir yüzey yok.', en: 'There is no surface to rig.' },
  weights: { tr: 'Deri ağırlıkları hesaplanıyor…', en: 'Computing skin weights…' },
  preparing: { tr: 'Mesh hazırlanıyor…', en: 'Preparing the mesh…' },
  binding: { tr: 'İskelet bağlanıyor…', en: 'Binding the skeleton…' },
} satisfies Record<string, I18nText>;

export interface RigOptions {
  /** Joint positions (model.object's frame); default: autoPlaceJoints heuristic. */
  layout?: JointLayout;
  /** Triangles of the model collected beforehand (e.g. by autoPlaceJoints). */
  meshData?: MeshData;
  skinning?: Partial<SkinningOptions>;
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
}

export interface RigHandle {
  readonly root: Object3D;
  readonly skeleton: Skeleton;
  readonly bones: Map<HumanoidBone, Bone>;
  readonly helper: SkeletonHelper;
  readonly meshes: SkinnedMesh[];
  /** Current rest layout. */
  readonly layout: JointLayout;
  readonly descriptor: RigDescriptor;
  readonly disposed: boolean;
  setSkeletonVisible(visible: boolean): void;
  readonly skeletonVisible: boolean;
  /** Back to the bind (T-) pose. */
  restPose(): void;
  /** Move one joint (model frame) and re-bind + re-weight. Children keep their positions. */
  setJoint(bone: HumanoidBone, pos: Vec3, opts?: { signal?: AbortSignal; onProgress?: (p: Progress) => void }): Promise<void>;
  setJoints(patch: JointLayout, opts?: { signal?: AbortSignal; onProgress?: (p: Progress) => void }): Promise<void>;
  /** Restore the original meshes and free the rig. */
  unrig(): void;
  /** Free what the rig holds without touching the (already discarded) model. */
  dispose(): void;
}

/** True when the model already carries skinned meshes (e.g. a rigged GLB). */
export function hasSkinnedMeshes(root: Object3D): boolean {
  let found = false;
  root.traverse((o) => {
    if ((o as SkinnedMesh).isSkinnedMesh && !(o.userData as { rigOwned?: boolean }).rigOwned) found = true;
  });
  return found;
}

interface Swap {
  original: Mesh;
  skinned: SkinnedMesh;
  /** Pristine material of the original (display modes may have replaced `original.material`). */
  material: Material | Material[];
  /** The root mesh kept its place with a placeholder geometry. */
  inPlace: boolean;
  placeholder: BufferGeometry | null;
  originalGeometry: BufferGeometry;
  start: number;
  count: number;
}

function pristineMaterials(core: RigViewer | null, root: Object3D, meshes: Mesh[]): Map<Mesh, Material | Material[]> {
  const out = new Map<Mesh, Material | Material[]>();
  const clone = core?.getExportObject?.();
  if (clone) {
    const src: Mesh[] = [], dst: Mesh[] = [];
    root.traverse((o) => { if ((o as Mesh).isMesh) src.push(o as Mesh); });
    clone.traverse((o) => { if ((o as Mesh).isMesh) dst.push(o as Mesh); });
    if (src.length === dst.length) src.forEach((m, i) => out.set(m, dst[i].material));
  }
  for (const m of meshes) if (!out.has(m)) out.set(m, m.material);
  return out;
}

const emptyGeometry = () => {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(0), 3));
  g.name = 'rig-placeholder';
  return g;
};

export async function rigModel(core: RigViewer | null, model: BuiltModel, opts: RigOptions = {}): Promise<RigHandle> {
  const { signal, onProgress } = opts;
  const root = model.object;
  if (hasSkinnedMeshes(root)) throw new LocalizedError(RIG_TEXT.alreadySkinned);
  const meshes = skinnableMeshes(root);
  if (!meshes.length) throw new LocalizedError(RIG_TEXT.noMesh);
  const check = () => {
    if (signal?.aborted) throw new AbortError();
  };

  onProgress?.({ label: RIG_TEXT.preparing });
  await yieldToPaint();
  check();
  const data = opts.meshData && opts.meshData.ranges.length === meshes.length ? opts.meshData : collectMeshData(root, meshes);
  let layout = opts.layout;
  if (!layout || missingBones(layout).length) {
    const auto = autoPlaceJointsDetailed(root, { meshData: data });
    layout = layout ? completeLayout(layout, auto.heuristic) : auto.layout;
  }
  const rig = buildSkeleton(layout);
  const prep = prepareSkinning(data.positions, data.index);
  check();

  const weigh = async (lay: JointLayout, sig?: AbortSignal, prog?: (p: Progress) => void) => {
    const segs = boneSegments(rig.names, lay);
    return computeSkinWeights(prep, segs, {
      ...opts.skinning,
      signal: sig,
      onProgress: (r) => prog?.({ label: RIG_TEXT.weights, ratio: r }),
    });
  };
  const weights = await weigh(layout, signal, onProgress);
  check();
  onProgress?.({ label: RIG_TEXT.binding });

  // Swap meshes for skinned copies.
  const materials = pristineMaterials(core, root, meshes);
  const swaps: Swap[] = [];
  for (const range of data.ranges) {
    const original = range.mesh;
    const originalGeometry = original.geometry;
    const geometry = originalGeometry.clone();
    const n = range.count;
    geometry.setAttribute('skinIndex', new BufferAttribute(weights.skinIndex.slice(range.start * 4, (range.start + n) * 4), 4));
    geometry.setAttribute('skinWeight', new BufferAttribute(weights.skinWeight.slice(range.start * 4, (range.start + n) * 4), 4));
    const material = materials.get(original) ?? original.material;
    const skinned = new SkinnedMesh(geometry, material);
    skinned.name = original.name;
    skinned.castShadow = original.castShadow;
    skinned.receiveShadow = original.receiveShadow;
    skinned.renderOrder = original.renderOrder;
    skinned.frustumCulled = false; // animated poses leave the bind-pose bounds
    skinned.userData = { ...original.userData, rigOwned: true };
    const inPlace = original === root;
    let placeholder: BufferGeometry | null = null;
    if (inPlace) {
      placeholder = emptyGeometry();
      original.geometry = placeholder;
      original.userData[RIG_PLACEHOLDER] = true;
      root.add(skinned);
    } else {
      const parent = original.parent!;
      skinned.position.copy(original.position);
      skinned.quaternion.copy(original.quaternion);
      skinned.scale.copy(original.scale);
      skinned.visible = original.visible;
      replaceChild(parent, original, skinned);
    }
    swaps.push({ original, skinned, material, inPlace, placeholder, originalGeometry, start: range.start, count: n });
  }

  // Bones first among the root's children: name lookups (animation binding) find them before any same-named node.
  root.add(rig.root);
  root.children.splice(root.children.indexOf(rig.root), 1);
  root.children.unshift(rig.root);
  root.updateMatrixWorld(true);
  rig.skeleton.calculateInverses();
  for (const s of swaps) s.skinned.bind(rig.skeleton, s.skinned.matrixWorld);

  const helper = new SkeletonHelper(root);
  helper.name = 'rig-skeleton';
  const mat = helper.material as Material & { depthTest: boolean; linewidth?: number };
  mat.depthTest = false;
  helper.renderOrder = 998;
  const savedRemesh = model.remesh;
  model.remesh = null;
  core?.rescanObject ? core.rescanObject() : core?.refresh();
  core?.invalidate();

  return createHandle(core, model, rig, swaps, helper, prep, weigh, layout, savedRemesh);
}

/** Put `next` where `prev` is among its parent's children (same index). */
function replaceChild(parent: Object3D, prev: Object3D, next: Object3D): void {
  const i = parent.children.indexOf(prev);
  parent.remove(prev);
  parent.add(next);
  parent.children.splice(parent.children.indexOf(next), 1);
  parent.children.splice(Math.max(0, i), 0, next);
}

function createHandle(
  core: RigViewer | null,
  model: BuiltModel,
  rig: RigSkeleton,
  swaps: Swap[],
  helper: SkeletonHelper,
  prep: SkinPrep,
  weigh: (layout: JointLayout, signal?: AbortSignal, onProgress?: (p: Progress) => void) => ReturnType<typeof computeSkinWeights>,
  initialLayout: JointLayout,
  savedRemesh: BuiltModel['remesh'],
): RigHandle {
  const root = model.object;
  let layout: JointLayout = structuredCloneLayout(initialLayout);
  let descriptor = describeRig(layout);
  let visible = false;
  let disposed = false;
  let seq = 0;

  const rebind = () => {
    resetToRest(root);
    root.updateMatrixWorld(true);
    rig.skeleton.calculateInverses();
    for (const s of swaps) {
      s.skinned.bind(rig.skeleton, s.skinned.matrixWorld);
      // Recomputed lazily by three (bounds / raycasts) for the new bind.
      (s.skinned as unknown as { boundingBox: null; boundingSphere: null }).boundingBox = null;
      (s.skinned as unknown as { boundingBox: null; boundingSphere: null }).boundingSphere = null;
    }
  };

  const setJoints = async (patch: JointLayout, o: { signal?: AbortSignal; onProgress?: (p: Progress) => void } = {}) => {
    if (disposed) return;
    const my = ++seq;
    const next = structuredCloneLayout(layout);
    for (const [b, p] of Object.entries(patch) as [HumanoidBone, Vec3][]) if (next[b] && p) next[b] = { x: p.x, y: p.y, z: p.z };
    const w = await weigh(next, o.signal, o.onProgress);
    if (disposed || my !== seq) return; // superseded by a newer edit
    layout = next;
    descriptor = describeRig(layout);
    applyLayout(rig, layout);
    rebind();
    for (const s of swaps) {
      const si = s.skinned.geometry.getAttribute('skinIndex') as BufferAttribute;
      const sw = s.skinned.geometry.getAttribute('skinWeight') as BufferAttribute;
      (si.array as Uint16Array).set(w.skinIndex.subarray(s.start * 4, (s.start + s.count) * 4));
      (sw.array as Float32Array).set(w.skinWeight.subarray(s.start * 4, (s.start + s.count) * 4));
      si.needsUpdate = true;
      sw.needsUpdate = true;
    }
    helper.updateMatrixWorld(true);
    core?.invalidate();
  };

  const releaseHelper = () => {
    if (visible) core?.removeOverlay(helper);
    visible = false;
    helper.dispose();
  };

  const handle: RigHandle = {
    root,
    skeleton: rig.skeleton,
    bones: rig.byName,
    helper,
    meshes: swaps.map((s) => s.skinned),
    get layout() {
      return layout;
    },
    get descriptor() {
      return descriptor;
    },
    get disposed() {
      return disposed;
    },
    get skeletonVisible() {
      return visible;
    },
    setSkeletonVisible(v) {
      if (disposed || v === visible) return;
      visible = v;
      if (v) core?.addOverlay(helper);
      else core?.removeOverlay(helper);
      core?.invalidate();
    },
    restPose() {
      if (disposed) return;
      resetToRest(root);
      root.updateMatrixWorld(true);
      core?.invalidate();
    },
    setJoint(bone, pos, o) {
      // Moving one joint keeps its children where they are.
      return setJoints({ [bone]: pos }, o);
    },
    setJoints,
    unrig() {
      if (disposed) return;
      disposed = true;
      seq++;
      releaseHelper();
      resetToRest(root);
      root.remove(rig.root);
      for (const s of swaps) {
        s.original.material = s.material;
        if (s.inPlace) {
          root.remove(s.skinned);
          s.original.geometry = s.originalGeometry;
          delete s.original.userData[RIG_PLACEHOLDER];
          s.placeholder?.dispose();
        } else {
          if (s.skinned.parent) replaceChild(s.skinned.parent, s.skinned, s.original);
        }
        s.skinned.geometry.dispose();
      }
      rig.skeleton.dispose();
      model.remesh = savedRemesh;
      prep.bvh = null;
      core?.rescanObject ? core.rescanObject() : core?.refresh();
      core?.invalidate();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      seq++;
      releaseHelper();
      for (const s of swaps) {
        s.originalGeometry.dispose();
        s.skinned.geometry.dispose();
      }
      rig.skeleton.dispose();
      prep.bvh = null;
    },
  };
  return handle;
}

function structuredCloneLayout(l: JointLayout): JointLayout {
  const out: JointLayout = {};
  for (const [b, p] of Object.entries(l) as [HumanoidBone, Vec3][]) if (p) out[b] = { x: p.x, y: p.y, z: p.z };
  return out;
}

/** World position of a bone's joint (for markers / the joint editor). */
export function jointWorldPosition(handle: RigHandle, bone: HumanoidBone, target = new Vector3()): Vector3 {
  const b = handle.bones.get(bone);
  if (!b) return target.set(0, 0, 0);
  b.updateWorldMatrix(true, false);
  return target.setFromMatrixPosition(b.matrixWorld);
}

export { isRigPlaceholder };
