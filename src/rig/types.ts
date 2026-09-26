/**
 * Contracts for humanoid rigging and animation.
 *
 * Bone names follow the widespread Mixamo convention (without the
 * "mixamorig:" prefix) so animations exported from Mixamo / most BVH
 * libraries retarget by name. The rest pose is a T-pose: +Y up, the model
 * faces +Z, arms along ±X (the subject's left arm towards +X).
 */

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

/** World-space joint positions (in the model's frame) the skeleton is built from. */
export type JointLayout = Partial<Record<HumanoidBone, Vec3>>;

export type AnimationCategory = 'idle' | 'locomotion' | 'gesture' | 'dance' | 'action' | 'emote' | 'pose';

export interface AnimationInfo {
  id: string;
  name: { tr: string; en: string };
  category: AnimationCategory;
  loop: boolean;
  /** 'builtin' clips are generated procedurally; 'imported' come from a BVH / FBX / GLB file. */
  source: 'builtin' | 'imported';
  duration: number;
}
