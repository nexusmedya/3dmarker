/**
 * Skeleton construction from a joint layout.
 *
 * Convention (every animation in this project assumes it): the rest pose is
 * the layout itself with every bone's local rotation = identity, local scale
 * = 1 and local position = the offset from its parent joint (Hips: its
 * position in the frame of the object the Hips bone is added to, i.e.
 * `model.object`). So in the rest pose a bone's local axes coincide with the
 * model axes (+X subject's left, +Y up, +Z forward) and a clip's quaternion
 * values are directly the rotations relative to the T-pose. Rest transforms
 * are also stored in `bone.userData.rest` (JSON-safe, survives clone()) so
 * the player and the exporters can put any copy of the skeleton back into
 * its bind pose.
 */
import { Bone, Skeleton, Vector3 } from 'three';
import type { Object3D } from 'three';
import { bonesOfLayout, END_BONES, parentOf, primaryChild } from './bones';
import type { HumanoidBone, JointLayout, Vec3 } from './types';

export interface RestTransform {
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

export interface RigSkeleton {
  /** The Hips bone (root of the hierarchy). */
  root: Bone;
  /** Bones in skeleton order (parents first); index = skin index. */
  bones: Bone[];
  names: HumanoidBone[];
  byName: Map<HumanoidBone, Bone>;
  skeleton: Skeleton;
}

/** What clip builders / retargeting need to know about a rig (pure data). */
export interface RigDescriptor {
  /** Bones present, parents first. */
  bones: HumanoidBone[];
  /** Rest joint positions (complete for `bones`). */
  layout: JointLayout;
  /** Hips height above the feet (the unit of the clips' hips offsets). */
  hipHeight: number;
  /** Sum of the thigh + shin lengths (averaged over both legs). */
  legLength: number;
}

const v = (p: Vec3) => new Vector3(p.x, p.y, p.z);

export function missingBones(layout: JointLayout): HumanoidBone[] {
  return bonesOfLayout(layout).filter((b) => !layout[b]);
}

export function describeRig(layout: JointLayout): RigDescriptor {
  const missing = missingBones(layout);
  if (missing.length) throw new Error(`Joint layout is missing: ${missing.join(', ')}`);
  const bones = bonesOfLayout(layout);
  const d = (a: HumanoidBone, b: HumanoidBone) => v(layout[a]!).distanceTo(v(layout[b]!));
  const legLength = (d('LeftUpLeg', 'LeftLeg') + d('LeftLeg', 'LeftFoot') + d('RightUpLeg', 'RightLeg') + d('RightLeg', 'RightFoot')) / 2;
  const feet = Math.min(layout.LeftFoot!.y, layout.RightFoot!.y, layout.LeftToeBase!.y, layout.RightToeBase!.y);
  // The ankle sits a little above the sole: ~ a third of the ankle–toe drop, at least 4% of the leg.
  const toeDrop = Math.max(0, Math.min(layout.LeftFoot!.y, layout.RightFoot!.y) - feet);
  const sole = feet - Math.max(toeDrop * 0.5, 0.04 * legLength);
  const hipHeight = Math.max(layout.Hips!.y - sole, 1e-3);
  return { bones, layout, hipHeight, legLength: Math.max(legLength, 1e-3) };
}

/** Build the bone hierarchy in its rest pose (see the module comment). Throws if a core joint is missing. */
export function buildSkeleton(layout: JointLayout): RigSkeleton {
  const missing = missingBones(layout);
  if (missing.length) throw new Error(`Joint layout is missing: ${missing.join(', ')}`);
  const names = bonesOfLayout(layout);
  const byName = new Map<HumanoidBone, Bone>();
  const bones: Bone[] = [];
  for (const name of names) {
    const bone = new Bone();
    bone.name = name;
    const p = layout[name]!;
    const parent = parentOf(name);
    const pp = parent ? layout[parent]! : { x: 0, y: 0, z: 0 };
    bone.position.set(p.x - pp.x, p.y - pp.y, p.z - pp.z);
    storeRest(bone);
    if (parent) byName.get(parent)!.add(bone);
    byName.set(name, bone);
    bones.push(bone);
  }
  const root = byName.get('Hips')!;
  root.updateMatrixWorld(true);
  return { root, bones, names, byName, skeleton: new Skeleton(bones) };
}

/** Move the joints of an existing skeleton to a new layout (rest pose), keeping the bone objects. */
export function applyLayout(rig: RigSkeleton, layout: JointLayout): void {
  for (const name of rig.names) {
    const p = layout[name];
    if (!p) continue;
    const parent = parentOf(name);
    const pp = parent ? layout[parent] ?? { x: 0, y: 0, z: 0 } : { x: 0, y: 0, z: 0 };
    const bone = rig.byName.get(name)!;
    bone.position.set(p.x - pp.x, p.y - pp.y, p.z - pp.z);
    bone.quaternion.identity();
    bone.scale.set(1, 1, 1);
    storeRest(bone);
  }
}

function storeRest(bone: Bone): void {
  const rest: RestTransform = { position: bone.position.toArray() as RestTransform['position'], quaternion: [0, 0, 0, 1] };
  bone.userData.rest = rest;
}

/** Put every bone under `root` that carries a stored rest transform back into it. */
export function resetToRest(root: Object3D): void {
  root.traverse((o) => {
    const rest = (o.userData as { rest?: RestTransform }).rest;
    if (!(o as Bone).isBone || !rest) return;
    o.position.fromArray(rest.position);
    o.quaternion.fromArray(rest.quaternion);
    o.scale.set(1, 1, 1);
  });
}

/** The layout a skeleton currently has (from its rest transforms). */
export function layoutOf(rig: RigSkeleton): JointLayout {
  const out: JointLayout = {};
  for (const name of rig.names) {
    const rest = (rig.byName.get(name)!.userData as { rest: RestTransform }).rest;
    const parent = parentOf(name);
    const base = parent ? out[parent]! : { x: 0, y: 0, z: 0 };
    out[name] = { x: base.x + rest.position[0], y: base.y + rest.position[1], z: base.z + rest.position[2] };
  }
  return out;
}

export interface BoneSegment {
  bone: HumanoidBone;
  /** Skin index (position in the skeleton's bone list). */
  index: number;
  head: Vector3;
  tail: Vector3;
}

/**
 * The line segment each deforming bone occupies in the rest pose (joint →
 * primary child). End bones have none; bones without a child (hands without
 * fingers, toes, last finger joints) extend their parent's direction.
 */
export function boneSegments(names: HumanoidBone[], layout: JointLayout): BoneSegment[] {
  const present = new Set(names);
  const out: BoneSegment[] = [];
  const height = Math.max(1e-3, (layout.HeadTop_End?.y ?? 1) - Math.min(layout.LeftFoot?.y ?? 0, layout.RightFoot?.y ?? 0));
  names.forEach((name, index) => {
    if (END_BONES.has(name)) return;
    const head = v(layout[name]!);
    const child = primaryChild(name, present);
    let tail: Vector3;
    if (child) tail = v(layout[child]!);
    else {
      const parent = parentOf(name);
      const dir = parent ? head.clone().sub(v(layout[parent]!)) : new Vector3(0, 1, 0);
      const len = dir.length();
      if (len < 1e-9) dir.set(0, 1, 0);
      const ext = /ToeBase$/.test(name) ? 0.05 * height : /Hand$/.test(name) ? Math.min(0.09 * height, 0.8 * len) : 0.7 * len;
      tail = head.clone().addScaledVector(dir.normalize(), Math.max(ext, 1e-4));
      if (/ToeBase$/.test(name)) tail = head.clone().add(new Vector3(0, 0, 1).multiplyScalar(0.05 * height));
    }
    out.push({ bone: name, index, head, tail });
  });
  return out;
}
