/**
 * Contracts for humanoid rigging and animation.
 *
 * Bone names follow the widespread Mixamo convention (without the
 * "mixamorig:" prefix) so animations exported from Mixamo / most BVH
 * libraries retarget by name. The rest pose is a T-pose: +Y up, the model
 * faces +Z, arms along ±X (the subject's left arm towards +X).
 */
import type { AnimationClip } from 'three';

export type CoreBone =
  | 'Hips'
  | 'Spine'
  | 'Spine1'
  | 'Spine2'
  | 'Neck'
  | 'Head'
  | 'HeadTop_End'
  | 'LeftShoulder'
  | 'LeftArm'
  | 'LeftForeArm'
  | 'LeftHand'
  | 'RightShoulder'
  | 'RightArm'
  | 'RightForeArm'
  | 'RightHand'
  | 'LeftUpLeg'
  | 'LeftLeg'
  | 'LeftFoot'
  | 'LeftToeBase'
  | 'RightUpLeg'
  | 'RightLeg'
  | 'RightFoot'
  | 'RightToeBase';

type Side = 'Left' | 'Right';
type Finger = 'Thumb' | 'Index' | 'Middle' | 'Ring' | 'Pinky';
/** Optional finger bones, e.g. LeftHandIndex1..3 (Mixamo naming). */
export type FingerBone = `${Side}Hand${Finger}${1 | 2 | 3}`;

export type HumanoidBone = CoreBone | FingerBone;

/** Parent of every core bone (Hips is the root). */
export const CORE_PARENT: Record<CoreBone, CoreBone | null> = {
  Hips: null,
  Spine: 'Hips',
  Spine1: 'Spine',
  Spine2: 'Spine1',
  Neck: 'Spine2',
  Head: 'Neck',
  HeadTop_End: 'Head',
  LeftShoulder: 'Spine2',
  LeftArm: 'LeftShoulder',
  LeftForeArm: 'LeftArm',
  LeftHand: 'LeftForeArm',
  RightShoulder: 'Spine2',
  RightArm: 'RightShoulder',
  RightForeArm: 'RightArm',
  RightHand: 'RightForeArm',
  LeftUpLeg: 'Hips',
  LeftLeg: 'LeftUpLeg',
  LeftFoot: 'LeftLeg',
  LeftToeBase: 'LeftFoot',
  RightUpLeg: 'Hips',
  RightLeg: 'RightUpLeg',
  RightFoot: 'RightLeg',
  RightToeBase: 'RightFoot',
};

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * World-space joint positions (in the model's frame) the skeleton is built from.
 * Precisely: positions in the local frame of `model.object` (the bones are
 * its descendants), which is the shared world frame for depth / geometry
 * models and the GLB's own units for normalised GLB models.
 */
export type JointLayout = Partial<Record<HumanoidBone, Vec3>>;

/*
 * Rest-pose convention every animation assumes (src/rig/skeleton.ts):
 * each bone's local rotation is identity and its local position is the
 * offset from its parent joint (Hips: its position in the model frame). A
 * bone's local axes are therefore the model axes at rest: +X = the subject's
 * left, +Y up, +Z forward (towards the viewer). Examples: LeftArm rotated
 * about -Z lowers the left arm, an UpLeg rotated about -X swings the leg
 * forward, Spine about +X bends forward, Head about +Y looks to the left.
 * Hips position tracks hold absolute positions (rest + offset scaled by the
 * rig's hip height), so clips are built per rig (animations/build.ts).
 */

export type AnimationCategory = 'idle' | 'locomotion' | 'gesture' | 'dance' | 'action' | 'emote' | 'pose';

export const ANIMATION_CATEGORIES: { id: AnimationCategory; name: { tr: string; en: string } }[] = [
  { id: 'idle', name: { tr: 'Bekleme', en: 'Idle' } },
  { id: 'locomotion', name: { tr: 'Hareket', en: 'Locomotion' } },
  { id: 'gesture', name: { tr: 'Jest', en: 'Gestures' } },
  { id: 'emote', name: { tr: 'Duygu', en: 'Emotes' } },
  { id: 'dance', name: { tr: 'Dans', en: 'Dance' } },
  { id: 'action', name: { tr: 'Aksiyon', en: 'Action' } },
  { id: 'pose', name: { tr: 'Poz', en: 'Poses' } },
];

export interface AnimationInfo {
  id: string;
  name: { tr: string; en: string };
  category: AnimationCategory;
  loop: boolean;
  /**
   * 'builtin' clips are generated procedurally; 'imported' come from a BVH / FBX / GLB file;
   * 'custom' were authored in the rig editor's timeline.
   */
  source: 'builtin' | 'imported' | 'custom';
  duration: number;
}

/** A clip built for one rig, with its catalogue entry. */
export interface RigClip {
  clip: AnimationClip;
  info: AnimationInfo;
}

// ---------------------------------------------------------------------------
// Generic skeletons (templates: humanoid, quadruped, bird, snake / chain, custom)

/** Skeleton families the rig can build and animate. */
export type TemplateId = 'humanoid' | 'quadruped' | 'bird' | 'snake' | 'custom';

export const TEMPLATE_IDS: TemplateId[] = ['humanoid', 'quadruped', 'bird', 'snake', 'custom'];

/** What a bone is for (procedural clips, IK chains and mirroring use it; free-form bones have none). */
export type RolePart =
  | 'root'
  | 'spine'
  | 'neck'
  | 'head'
  | 'jaw'
  | 'ear'
  | 'tail'
  | 'leg'
  | 'arm'
  | 'wing'
  | 'chain'
  | 'end';

export interface BoneRole {
  part: RolePart;
  /** Subject's left / right. */
  side?: 'L' | 'R';
  /** Quadrupeds: front or hind leg. */
  limb?: 'front' | 'hind';
  /**
   * Position in its chain. Legs / arms: 0 shoulder / hip, 1 upper, 2 lower,
   * 3 foot / hand, 4 toe (IK chains are 1 → 2 with the end effector at 3).
   * Spine / neck / tail / wing / chain: 0 at the body end.
   */
  index?: number;
}

/**
 * One bone of a generic skeleton, in the rest pose (root-local frame, the
 * frame of `model.object` — see JointLayout). `head` is the joint the bone
 * rotates about; `tail` its far end (a connected child's head, or a free end
 * for leaves). Bone names are unique and animation-binding safe
 * ([A-Za-z0-9_-]).
 */
export interface BoneSpec {
  name: string;
  parent: string | null;
  head: Vec3;
  tail: Vec3;
  /** Gets skin weights (false for end markers such as HeadTop_End). */
  deform: boolean;
  role?: BoneRole;
}

/**
 * A skeleton of any shape: bones parents-first with exactly one root, and
 * the body frame the procedural clips and the mirror tools use: `forward`
 * (where the head / face points) and `up`; the subject's left is
 * up × forward and the symmetry plane passes through the root's head.
 */
export interface SkeletonSpec {
  template: TemplateId;
  bones: BoneSpec[];
  frame: { forward: Vec3; up: Vec3 };
}
