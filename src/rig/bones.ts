/**
 * Humanoid bone topology helpers on top of the contract in types.ts: bone
 * order (parents first), finger bones, parents, mirroring and the "primary
 * child" each bone points at (its direction in the rest pose).
 */
import { CORE_PARENT, type CoreBone, type FingerBone, type HumanoidBone, type JointLayout } from './types';

export type Side = 'Left' | 'Right';
export type FingerName = 'Thumb' | 'Index' | 'Middle' | 'Ring' | 'Pinky';

export const SIDES: Side[] = ['Left', 'Right'];
export const FINGER_NAMES: FingerName[] = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];

/** Core bones, parents before children (the order of CORE_PARENT). */
export const CORE_BONES = Object.keys(CORE_PARENT) as CoreBone[];

/** Bones that only mark an end point (no skin weights, no animation). */
export const END_BONES: ReadonlySet<HumanoidBone> = new Set<HumanoidBone>(['HeadTop_End']);

export function fingerBone(side: Side, finger: FingerName, n: 1 | 2 | 3): FingerBone {
  return `${side}Hand${finger}${n}`;
}

/** All 30 finger bones (per side, per finger, 1..3). */
export const FINGER_BONES: FingerBone[] = SIDES.flatMap((s) =>
  FINGER_NAMES.flatMap((f) => [fingerBone(s, f, 1), fingerBone(s, f, 2), fingerBone(s, f, 3)]),
);

const FINGER_RE = /^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)([123])$/;

export function isFingerBone(b: string): b is FingerBone {
  return FINGER_RE.test(b);
}

export function isHumanoidBone(b: string): b is HumanoidBone {
  return b in CORE_PARENT || isFingerBone(b);
}

export function parentOf(b: HumanoidBone): HumanoidBone | null {
  const m = FINGER_RE.exec(b);
  if (!m) return CORE_PARENT[b as CoreBone];
  const n = Number(m[3]);
  return n === 1 ? (`${m[1]}Hand` as CoreBone) : fingerBone(m[1] as Side, m[2] as FingerName, (n - 1) as 1 | 2);
}

export function sideOf(b: string): Side | null {
  return b.startsWith('Left') ? 'Left' : b.startsWith('Right') ? 'Right' : null;
}

/** LeftArm ↔ RightArm; unsided bones map to themselves. */
export function mirrorBone<B extends HumanoidBone>(b: B): B {
  if (b.startsWith('Left')) return ('Right' + b.slice(4)) as B;
  if (b.startsWith('Right')) return ('Left' + b.slice(5)) as B;
  return b;
}

/**
 * The bones of a layout in skeleton order: every core bone, then the finger
 * chains whose three joints are all present (a finger is all or nothing).
 */
export function bonesOfLayout(layout: JointLayout): HumanoidBone[] {
  const out: HumanoidBone[] = [...CORE_BONES];
  for (const s of SIDES) {
    for (const f of FINGER_NAMES) {
      const chain = [fingerBone(s, f, 1), fingerBone(s, f, 2), fingerBone(s, f, 3)];
      if (chain.every((b) => layout[b])) out.push(...chain);
    }
  }
  return out;
}

/**
 * The child a bone points at in the rest pose (defines its direction and its
 * skinning segment). Hands point at the middle finger when it exists.
 */
export function primaryChild(b: HumanoidBone, present: ReadonlySet<HumanoidBone>): HumanoidBone | null {
  const pick = (c: HumanoidBone) => (present.has(c) ? c : null);
  const m = FINGER_RE.exec(b);
  if (m) {
    const n = Number(m[3]);
    return n < 3 ? pick(fingerBone(m[1] as Side, m[2] as FingerName, (n + 1) as 2 | 3)) : null;
  }
  switch (b as CoreBone) {
    case 'Hips': return pick('Spine');
    case 'Spine': return pick('Spine1');
    case 'Spine1': return pick('Spine2');
    case 'Spine2': return pick('Neck');
    case 'Neck': return pick('Head');
    case 'Head': return pick('HeadTop_End');
    case 'HeadTop_End': return null;
    case 'LeftShoulder': return pick('LeftArm');
    case 'LeftArm': return pick('LeftForeArm');
    case 'LeftForeArm': return pick('LeftHand');
    case 'LeftHand': return pick('LeftHandMiddle1');
    case 'RightShoulder': return pick('RightArm');
    case 'RightArm': return pick('RightForeArm');
    case 'RightForeArm': return pick('RightHand');
    case 'RightHand': return pick('RightHandMiddle1');
    case 'LeftUpLeg': return pick('LeftLeg');
    case 'LeftLeg': return pick('LeftFoot');
    case 'LeftFoot': return pick('LeftToeBase');
    case 'LeftToeBase': return null;
    case 'RightUpLeg': return pick('RightLeg');
    case 'RightLeg': return pick('RightFoot');
    case 'RightFoot': return pick('RightToeBase');
    case 'RightToeBase': return null;
  }
}

/** Bilingual display names of the core bones (joint editor). */
export const BONE_LABELS: Record<CoreBone, { tr: string; en: string }> = {
  Hips: { tr: 'Kalça (kök)', en: 'Hips (root)' },
  Spine: { tr: 'Bel', en: 'Spine' },
  Spine1: { tr: 'Göğüs altı', en: 'Spine 1' },
  Spine2: { tr: 'Göğüs', en: 'Chest' },
  Neck: { tr: 'Boyun', en: 'Neck' },
  Head: { tr: 'Baş', en: 'Head' },
  HeadTop_End: { tr: 'Baş üstü', en: 'Head top' },
  LeftShoulder: { tr: 'Sol köprücük', en: 'Left clavicle' },
  LeftArm: { tr: 'Sol omuz', en: 'Left shoulder' },
  LeftForeArm: { tr: 'Sol dirsek', en: 'Left elbow' },
  LeftHand: { tr: 'Sol bilek', en: 'Left wrist' },
  RightShoulder: { tr: 'Sağ köprücük', en: 'Right clavicle' },
  RightArm: { tr: 'Sağ omuz', en: 'Right shoulder' },
  RightForeArm: { tr: 'Sağ dirsek', en: 'Right elbow' },
  RightHand: { tr: 'Sağ bilek', en: 'Right wrist' },
  LeftUpLeg: { tr: 'Sol kalça eklemi', en: 'Left hip' },
  LeftLeg: { tr: 'Sol diz', en: 'Left knee' },
  LeftFoot: { tr: 'Sol ayak bileği', en: 'Left ankle' },
  LeftToeBase: { tr: 'Sol ayak parmakları', en: 'Left toes' },
  RightUpLeg: { tr: 'Sağ kalça eklemi', en: 'Right hip' },
  RightLeg: { tr: 'Sağ diz', en: 'Right knee' },
  RightFoot: { tr: 'Sağ ayak bileği', en: 'Right ankle' },
  RightToeBase: { tr: 'Sağ ayak parmakları', en: 'Right toes' },
};

const FINGER_LABELS: Record<FingerName, { tr: string; en: string }> = {
  Thumb: { tr: 'başparmak', en: 'thumb' },
  Index: { tr: 'işaret', en: 'index' },
  Middle: { tr: 'orta', en: 'middle' },
  Ring: { tr: 'yüzük', en: 'ring' },
  Pinky: { tr: 'serçe', en: 'pinky' },
};

export function boneLabel(b: HumanoidBone): { tr: string; en: string } {
  const m = FINGER_RE.exec(b);
  if (!m) return BONE_LABELS[b as CoreBone];
  const f = FINGER_LABELS[m[2] as FingerName];
  const left = m[1] === 'Left';
  return { tr: `${left ? 'Sol' : 'Sağ'} ${f.tr} ${m[3]}`, en: `${left ? 'Left' : 'Right'} ${f.en} ${m[3]}` };
}
