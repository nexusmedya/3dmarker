/**
 * Rig a built model in place: every plain mesh under `model.object` is
 * swapped for a SkinnedMesh sharing a CLONED geometry (plus skinIndex /
 * skinWeight) and the original material, the root bone is added to
 * `model.object`, and the viewer is told to rescan. When `model.object` is
 * itself a mesh (depth / geometry models) it cannot be swapped (the viewer
 * and the shell hold it), so it keeps its place with an empty placeholder
 * geometry (flagged `userData.rigPlaceholder`; renders nothing, skipped by
 * the exporters) and the skinned copy becomes its child.
 *
 * Any skeleton works (a SkeletonSpec: humanoid, quadruped, bird, snake,
 * custom — ./templates.ts); a humanoid JointLayout is turned into its spec.
 * The handle keeps the spec, the current skin weights and the humanoid
 * view (`layout` / `descriptor`) while the spec still is a humanoid.
 * `setSpec` applies editor changes: rest moves re-bind in place, structural
 * edits (add / delete / rename / reparent) rebuild the bones and carry the
 * weights over by name; re-weighting (all bones or some) runs in the
 * geometry worker and a newer change supersedes an older one.
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
import { bonesOfLayout } from './bones';
import { buildContactSample } from './contact';
import { collectMeshData, isRigPlaceholder, RIG_PLACEHOLDER, skinnableMeshes, type MeshData } from './meshData';
import { describeRig, missingBones, resetToRest, type RigDescriptor, type RigSkeleton } from './skeleton';
import type { SkinningOptions, SkinWeights } from './skinning';
import {
  applySpecRest, buildSkeletonFromSpec, cloneSpec, effectiveTemplate, humanoidLayoutOf, humanoidSpecFromLayout, remapContact, remapWeights,
  sameTopology, segmentsOfSpec, validateSpec, type SpecDescriptor,
} from './spec';
import { createSkinWeigher, type SkinWeigher } from './weigher';
import type { HumanoidBone, JointLayout, SkeletonSpec, TemplateId, Vec3 } from './types';

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
  notHumanoid: { tr: 'Bu iskelet insansı değil.', en: 'This skeleton is not a humanoid.' },
  invalid: { tr: 'İskelet geçersiz: {why}', en: 'Invalid skeleton: {why}' },
} satisfies Record<string, I18nText>;

export interface RigOptions {
  /** Any skeleton (wins over `layout`). */
  spec?: SkeletonSpec;
  /** Humanoid joint positions (model.object's frame); default: autoPlaceJoints heuristic. */
  layout?: JointLayout;
  /** Triangles of the model collected beforehand (e.g. by autoPlaceJoints). */
  meshData?: MeshData;
  skinning?: Partial<SkinningOptions>;
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
}

export interface EditOptions {
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
}

export interface SpecUpdateOptions extends EditOptions {
  /**
   * 'none' (default): keep the weights (carried over by name after
   * structural edits; re-bind only); 'all': recompute every weight; a list
   * of bone names: automatic weights for those bones only, the others keep
   * theirs (scaled to fill the rest).
   */
  reweigh?: 'all' | 'none' | string[];
  /** Old name → new name of renamed bones (keeps their weights). */
  renamed?: Record<string, string>;
  /** Weights to apply with the spec (undo / redo); wins over `reweigh`. */
  weights?: SkinWeights;
}

export interface RigHandle {
  readonly root: Object3D;
  /** Current skeleton / bones / helper (replaced by structural edits). */
  readonly skeleton: Skeleton;
  readonly bones: Map<string, Bone>;
  readonly helper: SkeletonHelper;
  readonly meshes: SkinnedMesh[];
  /** Template of the current skeleton (a humanoid edited out of shape becomes 'custom'). */
  readonly template: TemplateId;
  /** Current skeleton (rest pose). */
  readonly spec: SkeletonSpec;
  /** True while the skeleton still is a humanoid (humanoid clips, imports, joint editor). */
  readonly isHumanoid: boolean;
  /** Current humanoid rest layout ({} for other skeletons). */
  readonly layout: JointLayout;
  /** Humanoid clip-building data; throws for a non-humanoid skeleton (check `isHumanoid`). */
  readonly descriptor: RigDescriptor;
  /** Generic clip-building data (any skeleton). */
  readonly generic: SpecDescriptor;
  /** Current skin weights (input vertex order of `surface`). */
  readonly weights: SkinWeights;
  /** The skinned surface in the rest pose (root frame): positions and triangles. */
  readonly surface: { positions: Float32Array; index: Uint32Array };
  /** Increments on every applied change of the skeleton or the weights. */
  readonly version: number;
  readonly disposed: boolean;
  setSkeletonVisible(visible: boolean): void;
  readonly skeletonVisible: boolean;
  /** Back to the bind (T-) pose. */
  restPose(): void;
  /**
   * Move one humanoid joint (model frame) and re-bind + re-weight. Children keep their positions.
   * Resolves true when this edit was applied, false when a newer edit superseded it (the
   * newer one includes this patch: edits accumulate until one is applied). Rejects with
   * AbortError when `signal` aborts.
   */
  setJoint(bone: HumanoidBone, pos: Vec3, opts?: EditOptions): Promise<boolean>;
  setJoints(patch: JointLayout, opts?: EditOptions): Promise<boolean>;
  /** Apply an edited skeleton (see SpecUpdateOptions). Resolves false when superseded. */
  setSpec(spec: SkeletonSpec, opts?: SpecUpdateOptions): Promise<boolean>;
  /** Replace the skin weights (weight painting). */
  setWeights(weights: SkinWeights): void;
  /** Automatic weights for a spec (default: the current one) without applying them. */
  autoWeights(spec?: SkeletonSpec, opts?: EditOptions): Promise<SkinWeights>;
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

function invalid(spec: SkeletonSpec): LocalizedError | null {
  const errs = validateSpec(spec);
  if (!errs.length) return null;
  const why = errs.slice(0, 3).join('; ');
  return new LocalizedError({ tr: RIG_TEXT.invalid.tr.replace('{why}', why), en: RIG_TEXT.invalid.en.replace('{why}', why) });
}

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
  // Yield between the heavy synchronous steps so the page paints and cancel takes effect.
  await yieldToPaint();
  check();
  let spec: SkeletonSpec;
  if (opts.spec) {
    const bad = invalid(opts.spec);
    if (bad) throw bad;
    spec = cloneSpec(opts.spec);
    spec.template = effectiveTemplate(spec);
  } else {
    let layout = opts.layout;
    if (!layout || missingBones(layout).length) {
      const auto = autoPlaceJointsDetailed(root, { meshData: data });
      layout = layout ? completeLayout(layout, auto.heuristic) : auto.layout;
      await yieldToPaint();
      check();
    }
    spec = humanoidSpecFromLayout(layout);
  }
  const rig = buildSkeletonFromSpec(spec);
  // Welding, adjacency, BVH and the weights run in the geometry worker when there is one.
  const weigher = await createSkinWeigher(data.positions, data.index, signal);

  const weigh = (s: SkeletonSpec, sig?: AbortSignal, prog?: (p: Progress) => void) =>
    weigher.weigh(segmentsOfSpec(s), {
      ...opts.skinning,
      signal: sig,
      onProgress: (r) => prog?.({ label: RIG_TEXT.weights, ratio: r }),
    });
  let weights: SkinWeights;
  try {
    check();
    weights = await weigh(spec, signal, onProgress);
    check();
  } catch (e) {
    weigher.dispose();
    throw e;
  }
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

  attachBones(root, rig.root);
  root.updateMatrixWorld(true);
  rig.skeleton.calculateInverses();
  for (const s of swaps) s.skinned.bind(rig.skeleton, s.skinned.matrixWorld);

  const helper = makeHelper(root);
  const savedRemesh = model.remesh;
  model.remesh = null;
  core?.rescanObject ? core.rescanObject() : core?.refresh();
  core?.invalidate();

  return createHandle({ core, model, rig, swaps, helper, weigher, weigh, spec, savedRemesh, data, weights });
}

/** Bones first among the root's children: name lookups (animation binding) find them before any same-named node. */
function attachBones(root: Object3D, bone: Bone): void {
  root.add(bone);
  root.children.splice(root.children.indexOf(bone), 1);
  root.children.unshift(bone);
}

function makeHelper(root: Object3D): SkeletonHelper {
  const helper = new SkeletonHelper(root);
  helper.name = 'rig-skeleton';
  const mat = helper.material as Material & { depthTest: boolean; linewidth?: number };
  mat.depthTest = false;
  helper.renderOrder = 998;
  return helper;
}

/** Put `next` where `prev` is among its parent's children (same index). */
function replaceChild(parent: Object3D, prev: Object3D, next: Object3D): void {
  const i = parent.children.indexOf(prev);
  parent.remove(prev);
  parent.add(next);
  parent.children.splice(parent.children.indexOf(next), 1);
  parent.children.splice(Math.max(0, i), 0, next);
}

interface HandleInit {
  core: RigViewer | null;
  model: BuiltModel;
  rig: RigSkeleton;
  swaps: Swap[];
  helper: SkeletonHelper;
  weigher: SkinWeigher;
  weigh: (spec: SkeletonSpec, signal?: AbortSignal, onProgress?: (p: Progress) => void) => Promise<SkinWeights>;
  spec: SkeletonSpec;
  savedRemesh: BuiltModel['remesh'];
  data: MeshData;
  weights: SkinWeights;
}

/**
 * Automatic weights for `bones` only, blended into `current`: per vertex the
 * listed bones take their automatic weights, the other bones share what is
 * left in their current proportions.
 */
export function mergeBoneWeights(current: SkinWeights, auto: SkinWeights, boneIdx: ReadonlySet<number>): SkinWeights {
  const n = current.skinIndex.length / 4;
  const out: SkinWeights = { skinIndex: new Uint16Array(n * 4), skinWeight: new Float32Array(n * 4) };
  const acc = new Map<number, number>();
  for (let v = 0; v < n; v++) {
    acc.clear();
    let sel = 0, rest = 0;
    for (let s = 0; s < 4; s++) {
      const b = auto.skinIndex[v * 4 + s], w = auto.skinWeight[v * 4 + s];
      if (w > 0 && boneIdx.has(b)) (acc.set(b, (acc.get(b) ?? 0) + w), (sel += w));
    }
    for (let s = 0; s < 4; s++) {
      const b = current.skinIndex[v * 4 + s], w = current.skinWeight[v * 4 + s];
      if (w > 0 && !boneIdx.has(b)) rest += w;
    }
    const scale = rest > 1e-9 ? (1 - sel) / rest : 0;
    if (rest > 1e-9) {
      for (let s = 0; s < 4; s++) {
        const b = current.skinIndex[v * 4 + s], w = current.skinWeight[v * 4 + s];
        if (w > 0 && !boneIdx.has(b)) acc.set(b, (acc.get(b) ?? 0) + w * scale);
      }
    }
    if (!acc.size) {
      // Nothing left (a vertex owned by the listed bones that the auto weights moved elsewhere): take auto as is.
      for (let s = 0; s < 4; s++) {
        const b = auto.skinIndex[v * 4 + s], w = auto.skinWeight[v * 4 + s];
        if (w > 0) acc.set(b, (acc.get(b) ?? 0) + w);
      }
    }
    const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((t, e) => t + e[1], 0) || 1;
    top.forEach(([b, w], s) => {
      out.skinIndex[v * 4 + s] = b;
      out.skinWeight[v * 4 + s] = w / sum;
    });
    if (!top.length) out.skinWeight[v * 4] = 1;
  }
  return out;
}

function createHandle(init: HandleInit): RigHandle {
  const { core, model, swaps, weigher, weigh, savedRemesh, data } = init;
  const root = model.object;
  let rig = init.rig;
  let helper = init.helper;
  let spec: SkeletonSpec = cloneSpec(init.spec);
  let weights: SkinWeights = init.weights;
  let generic: SpecDescriptor = { spec, contact: buildContactSample(data.positions, weights) };
  let humanLayout: JointLayout | null = humanoidLayoutOf(spec);
  let descriptor: RigDescriptor | null = null;
  let visible = false;
  let disposed = false;
  let seq = 0;
  let version = 0;
  /** Humanoid joint edits requested since the last applied one (partial patches accumulate). */
  let pending: JointLayout | null = null;

  const describeHuman = (): RigDescriptor | null => {
    if (!humanLayout || spec.template !== 'humanoid') return null;
    const d = describeRig(humanLayout);
    return { ...d, contact: generic.contact ? remapContact(generic.contact, spec, d.bones) : undefined };
  };
  descriptor = describeHuman();

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

  const writeWeights = (w: SkinWeights) => {
    for (const s of swaps) {
      const si = s.skinned.geometry.getAttribute('skinIndex') as BufferAttribute;
      const sw = s.skinned.geometry.getAttribute('skinWeight') as BufferAttribute;
      (si.array as Uint16Array).set(w.skinIndex.subarray(s.start * 4, (s.start + s.count) * 4));
      (sw.array as Float32Array).set(w.skinWeight.subarray(s.start * 4, (s.start + s.count) * 4));
      si.needsUpdate = true;
      sw.needsUpdate = true;
    }
  };

  /** Make `next` (+ its weights) the rig's state: re-bind in place or rebuild the bones. */
  const apply = (next: SkeletonSpec, w: SkinWeights) => {
    next.template = effectiveTemplate(next);
    if (sameTopology(spec, next)) {
      applySpecRest(rig, next);
    } else {
      resetToRest(root);
      const old = rig;
      root.remove(old.root);
      rig = buildSkeletonFromSpec(next);
      attachBones(root, rig.root);
      old.skeleton.dispose();
      if (visible) core?.removeOverlay(helper);
      helper.dispose();
      helper = makeHelper(root);
      if (visible) core?.addOverlay(helper);
    }
    spec = next;
    weights = w;
    rebind();
    writeWeights(w);
    humanLayout = humanoidLayoutOf(spec);
    generic = { spec, contact: buildContactSample(data.positions, w) };
    descriptor = describeHuman();
    version++;
    helper.updateMatrixWorld(true);
    core?.invalidate();
  };

  const setJoints = async (patch: JointLayout, o: EditOptions = {}): Promise<boolean> => {
    if (disposed) return false;
    if (!humanLayout) throw new LocalizedError(RIG_TEXT.notHumanoid);
    const my = ++seq;
    // Merge onto the not-yet-applied edits, so superseding one does not drop them.
    const next = cloneLayout(pending ?? humanLayout);
    for (const [b, p] of Object.entries(patch) as [HumanoidBone, Vec3][]) if (next[b] && p) next[b] = { x: p.x, y: p.y, z: p.z };
    pending = next;
    const humanNames = new Set<string>(bonesOfLayout(next));
    const nextSpec = humanoidSpecFromLayout(next, spec.bones.filter((b) => !humanNames.has(b.name)));
    let w: SkinWeights;
    try {
      w = await weigh(nextSpec, o.signal, o.onProgress);
    } catch (e) {
      if (my === seq) pending = null; // the latest edit was cancelled: forget the unapplied edits
      throw e;
    }
    if (disposed || my !== seq) return false; // superseded by a newer edit (which includes this patch)
    pending = null;
    apply(nextSpec, w);
    return true;
  };

  const setSpec = async (nextIn: SkeletonSpec, o: SpecUpdateOptions = {}): Promise<boolean> => {
    if (disposed) return false;
    const bad = invalid(nextIn);
    if (bad) throw bad;
    const next = cloneSpec(nextIn);
    const my = ++seq;
    pending = null;
    const mode = o.weights ? 'given' : o.reweigh ?? 'none';
    let w: SkinWeights;
    if (o.weights) w = o.weights;
    else {
      const carried = sameTopology(spec, next) && !o.renamed ? weights : remapWeights(weights, spec, next, o.renamed);
      if (mode === 'none') w = carried;
      else {
        const auto = await weigh(next, o.signal, o.onProgress);
        if (disposed || my !== seq) return false;
        if (mode === 'all') w = auto;
        else {
          const names = new Set(mode as string[]);
          const idx = new Set<number>();
          next.bones.forEach((b, i) => names.has(b.name) && idx.add(i));
          w = mergeBoneWeights(carried, auto, idx);
        }
      }
    }
    if (disposed || my !== seq) return false;
    apply(next, w);
    return true;
  };

  const releaseHelper = () => {
    if (visible) core?.removeOverlay(helper);
    visible = false;
    helper.dispose();
  };

  const handle: RigHandle = {
    root,
    get skeleton() {
      return rig.skeleton;
    },
    get bones() {
      return rig.byName;
    },
    get helper() {
      return helper;
    },
    meshes: swaps.map((s) => s.skinned),
    get template() {
      return spec.template;
    },
    get spec() {
      return spec;
    },
    get isHumanoid() {
      return !!descriptor;
    },
    get layout() {
      return descriptor && humanLayout ? humanLayout : {};
    },
    get descriptor() {
      if (!descriptor) throw new LocalizedError(RIG_TEXT.notHumanoid);
      return descriptor;
    },
    get generic() {
      return generic;
    },
    get weights() {
      return weights;
    },
    surface: { positions: data.positions, index: data.index },
    get version() {
      return version;
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
    setSpec,
    setWeights(w) {
      if (disposed) return;
      if (w.skinIndex.length !== weights.skinIndex.length) throw new Error('Weight count does not match the mesh');
      weights = w;
      writeWeights(w);
      generic = { spec, contact: buildContactSample(data.positions, w) };
      descriptor = describeHuman();
      version++;
      core?.invalidate();
    },
    autoWeights(s = spec, o = {}) {
      if (disposed) return Promise.reject(new Error('Rig disposed'));
      return weigh(s, o.signal, o.onProgress);
    },
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
      weigher.dispose();
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
      weigher.dispose();
    },
  };
  return handle;
}

function cloneLayout(l: JointLayout): JointLayout {
  const out: JointLayout = {};
  for (const [b, p] of Object.entries(l) as [HumanoidBone, Vec3][]) if (p) out[b] = { x: p.x, y: p.y, z: p.z };
  return out;
}

/** World position of a bone's joint (for markers / the joint editor). */
export function jointWorldPosition(handle: RigHandle, bone: string, target = new Vector3()): Vector3 {
  const b = handle.bones.get(bone);
  if (!b) return target.set(0, 0, 0);
  b.updateWorldMatrix(true, false);
  return target.setFromMatrixPosition(b.matrixWorld);
}

export { isRigPlaceholder };
