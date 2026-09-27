/**
 * Skeleton templates: humanoid (Mixamo names, ./bones.ts), quadruped (dog,
 * cat, horse), bird, snake / free chain (tails, tentacles) and custom.
 *
 * Each animal template is built from a handful of key points (which the
 * automatic placement, ./autoAnimal.ts, finds on the mesh) into a full bone
 * hierarchy with roles (./types.ts BoneRole) — the procedural clips
 * (./animals.ts), IK chains and mirror tools read the roles, never the names,
 * so renamed or custom bones keep working as long as their role is set.
 * `proportionalSpec` places a template inside a bounding box with average
 * proportions (the fallback, and "custom from template").
 */
import { Box3, Vector3 } from 'three';
import type { I18nText } from '../core/types';
import { humanoidSpecFromLayout, plain, rootOf, sortParentsFirst, vec } from './spec';
import type { BoneRole, BoneSpec, JointLayout, SkeletonSpec, TemplateId, Vec3 } from './types';

export const TEMPLATE_INFO: Record<TemplateId, { name: I18nText; hint: I18nText }> = {
  humanoid: {
    name: { tr: 'İnsansı', en: 'Humanoid' },
    hint: { tr: 'İnsan ve karakterler (Mixamo kemik adları)', en: 'People and characters (Mixamo bone names)' },
  },
  quadruped: {
    name: { tr: 'Dört ayaklı', en: 'Quadruped' },
    hint: { tr: 'Köpek, kedi, at… omurga, boyun, baş, çene, kulaklar, 4 bacak, kuyruk', en: 'Dog, cat, horse… spine, neck, head, jaw, ears, 4 legs, tail' },
  },
  bird: {
    name: { tr: 'Kuş', en: 'Bird' },
    hint: { tr: '3 parçalı kanatlar, bacaklar, kuyruk, boyun', en: '3-segment wings, legs, tail, neck' },
  },
  snake: {
    name: { tr: 'Yılan / zincir', en: 'Snake / chain' },
    hint: { tr: 'Yılan, solucan, kuyruk, dokunaç: tek kemik zinciri', en: 'Snake, worm, tail, tentacle: one bone chain' },
  },
  custom: {
    name: { tr: 'Özel', en: 'Custom' },
    hint: { tr: 'Tek kök kemikten başlayın ya da bir şablonu düzenleyin', en: 'Start from a single root bone or edit a template' },
  },
};

/** Body frame for placing points: origin, forward, up, left (unit, orthogonal). */
export class BodyFrame {
  readonly f: Vector3;
  readonly up: Vector3;
  readonly left: Vector3;
  constructor(
    readonly origin: Vector3,
    forward: Vec3,
    up: Vec3 = { x: 0, y: 1, z: 0 },
  ) {
    this.up = vec(up).normalize();
    const f = vec(forward);
    f.addScaledVector(this.up, -f.dot(this.up));
    this.f = f.lengthSq() > 1e-12 ? f.normalize() : new Vector3(0, 0, 1);
    this.left = new Vector3().crossVectors(this.up, this.f).normalize();
  }
  /** origin + u·forward + y·up + w·left */
  at(u: number, y: number, w = 0): Vec3 {
    return plain(this.origin.clone().addScaledVector(this.f, u).addScaledVector(this.up, y).addScaledVector(this.left, w));
  }
  /** Local (u, y, w) of a model-frame point. */
  local(p: Vec3): { u: number; y: number; w: number } {
    const d = vec(p).sub(this.origin);
    return { u: d.dot(this.f), y: d.dot(this.up), w: d.dot(this.left) };
  }
  get frame(): SkeletonSpec['frame'] {
    return { forward: plain(this.f), up: plain(this.up) };
  }
}

const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
const add = (a: Vec3, d: Vector3): Vec3 => ({ x: a.x + d.x, y: a.y + d.y, z: a.z + d.z });

function bone(name: string, parent: string | null, head: Vec3, tail: Vec3, role?: BoneRole, deform = true): BoneSpec {
  return { name, parent, head: { ...head }, tail: { ...tail }, deform, role };
}

// ---------------------------------------------------------------------------
// Quadruped

export type LegKey = 'FL' | 'FR' | 'HL' | 'HR';
export const LEG_KEYS: LegKey[] = ['FL', 'FR', 'HL', 'HR'];

export interface QuadrupedKeys {
  frame: SkeletonSpec['frame'];
  hips: Vec3;
  chest: Vec3;
  neckBase: Vec3;
  head: Vec3;
  /** Snout / muzzle tip (the head bone's tail). */
  nose: Vec3;
  jaw: { head: Vec3; tail: Vec3 };
  ears: { L: { head: Vec3; tail: Vec3 }; R: { head: Vec3; tail: Vec3 } };
  /** Per leg: shoulder / hip, upper, lower, foot, toe joint positions. */
  legs: Record<LegKey, [Vec3, Vec3, Vec3, Vec3, Vec3]>;
  /** Tail points base → tip (n + 1 points for n bones, n = 3…6). */
  tail: Vec3[];
}

export function quadrupedSpec(k: QuadrupedKeys): SkeletonSpec {
  const bones: BoneSpec[] = [];
  const spine0 = lerp(k.hips, k.chest, 1 / 3), spine1 = lerp(k.hips, k.chest, 2 / 3);
  const neck1 = lerp(k.neckBase, k.head, 0.5);
  bones.push(bone('Hips', null, k.hips, spine0, { part: 'root' }));
  bones.push(bone('Spine', 'Hips', spine0, spine1, { part: 'spine', index: 0 }));
  bones.push(bone('Spine1', 'Spine', spine1, k.chest, { part: 'spine', index: 1 }));
  bones.push(bone('Chest', 'Spine1', k.chest, k.neckBase, { part: 'spine', index: 2 }));
  bones.push(bone('Neck', 'Chest', k.neckBase, neck1, { part: 'neck', index: 0 }));
  bones.push(bone('Neck1', 'Neck', neck1, k.head, { part: 'neck', index: 1 }));
  bones.push(bone('Head', 'Neck1', k.head, k.nose, { part: 'head' }));
  bones.push(bone('Jaw', 'Head', k.jaw.head, k.jaw.tail, { part: 'jaw' }));
  for (const s of ['L', 'R'] as const) {
    const S = s === 'L' ? 'Left' : 'Right';
    bones.push(bone(`${S}Ear`, 'Head', k.ears[s].head, k.ears[s].tail, { part: 'ear', side: s }));
  }
  const fwd = vec(k.frame.forward).normalize();
  for (const key of LEG_KEYS) {
    const front = key[0] === 'F';
    const s = key[1] as 'L' | 'R';
    const S = s === 'L' ? 'Left' : 'Right';
    const pre = `${S}${front ? 'Front' : 'Hind'}`;
    const names = front
      ? [`${pre}Shoulder`, `${pre}UpperLeg`, `${pre}LowerLeg`, `${pre}Foot`, `${pre}Toe`]
      : [`${pre}Hip`, `${pre}UpperLeg`, `${pre}LowerLeg`, `${pre}Foot`, `${pre}Toe`];
    const p = k.legs[key];
    const footLen = Math.max(vec(p[4]).distanceTo(vec(p[3])), 1e-3);
    const toeTail = add(p[4], fwd.clone().multiplyScalar(0.6 * footLen));
    names.forEach((n, i) => {
      const parent = i === 0 ? (front ? 'Chest' : 'Hips') : names[i - 1];
      bones.push(bone(n, parent, p[i], i < 4 ? p[i + 1] : toeTail, { part: 'leg', side: s, limb: front ? 'front' : 'hind', index: i }));
    });
  }
  const t = k.tail;
  for (let i = 0; i + 1 < t.length; i++) {
    bones.push(bone(i === 0 ? 'Tail' : `Tail${i}`, i === 0 ? 'Hips' : i === 1 ? 'Tail' : `Tail${i - 1}`, t[i], t[i + 1], { part: 'tail', index: i }));
  }
  return { template: 'quadruped', bones: sortParentsFirst(bones), frame: { forward: { ...k.frame.forward }, up: { ...k.frame.up } } };
}

/** Average quadruped proportions in a body frame (u along the body, 0 = middle; y from the ground). */
export function quadrupedKeysIn(F: BodyFrame, L: number, H: number, W: number, tailBones = 4): QuadrupedKeys {
  const w = Math.max(W, 0.12 * H);
  const leg = (u0: number, top: number, knee: number, hock: number, hind: boolean, side: 1 | -1): [Vec3, Vec3, Vec3, Vec3, Vec3] => {
    const lw = side * 0.28 * w;
    return [
      F.at(u0 + (hind ? 0.02 : -0.02) * L, top, side * 0.18 * w),
      F.at(u0, 0.5 * H, lw),
      F.at(u0 + knee * L, 0.28 * H, lw),
      F.at(u0 + hock * L, 0.08 * H, lw),
      F.at(u0 + hock * L + 0.04 * L, 0.02 * H, lw),
    ];
  };
  const tail: Vec3[] = [];
  for (let i = 0; i <= tailBones; i++) {
    const t = i / tailBones;
    tail.push(F.at(-0.4 * L - 0.12 * L * t, 0.66 * H - 0.18 * H * t * t, 0));
  }
  const head = F.at(0.38 * L, 0.86 * H);
  return {
    frame: F.frame,
    hips: F.at(-0.28 * L, 0.62 * H),
    chest: F.at(0.2 * L, 0.64 * H),
    neckBase: F.at(0.28 * L, 0.72 * H),
    head,
    nose: F.at(0.5 * L, 0.8 * H),
    jaw: { head: F.at(0.39 * L, 0.8 * H), tail: F.at(0.47 * L, 0.75 * H) },
    ears: {
      L: { head: F.at(0.36 * L, 0.92 * H, 0.1 * w), tail: F.at(0.34 * L, 1.0 * H, 0.14 * w) },
      R: { head: F.at(0.36 * L, 0.92 * H, -0.1 * w), tail: F.at(0.34 * L, 1.0 * H, -0.14 * w) },
    },
    legs: {
      FL: leg(0.24 * L, 0.66 * H, 0, -0.01, false, 1),
      FR: leg(0.24 * L, 0.66 * H, 0, -0.01, false, -1),
      HL: leg(-0.3 * L, 0.62 * H, 0.04, -0.03, true, 1),
      HR: leg(-0.3 * L, 0.62 * H, 0.04, -0.03, true, -1),
    },
    tail,
  };
}

// ---------------------------------------------------------------------------
// Bird

export interface BirdKeys {
  frame: SkeletonSpec['frame'];
  hips: Vec3;
  chest: Vec3;
  neck: [Vec3, Vec3];
  head: Vec3;
  beak: Vec3;
  /** Per side: thigh (hip), knee, ankle, toe. */
  legs: { L: [Vec3, Vec3, Vec3, Vec3]; R: [Vec3, Vec3, Vec3, Vec3] };
  /** Per side: shoulder, elbow, wrist, tip. */
  wings: { L: [Vec3, Vec3, Vec3, Vec3]; R: [Vec3, Vec3, Vec3, Vec3] };
  /** Tail points base → tip (2 bones). */
  tail: [Vec3, Vec3, Vec3];
}

export function birdSpec(k: BirdKeys): SkeletonSpec {
  const bones: BoneSpec[] = [];
  const fwd = vec(k.frame.forward).normalize();
  bones.push(bone('Hips', null, k.hips, k.chest, { part: 'root' }));
  bones.push(bone('Chest', 'Hips', k.chest, k.neck[0], { part: 'spine', index: 0 }));
  bones.push(bone('Neck', 'Chest', k.neck[0], k.neck[1], { part: 'neck', index: 0 }));
  bones.push(bone('Neck1', 'Neck', k.neck[1], k.head, { part: 'neck', index: 1 }));
  bones.push(bone('Head', 'Neck1', k.head, k.beak, { part: 'head' }));
  for (const s of ['L', 'R'] as const) {
    const S = s === 'L' ? 'Left' : 'Right';
    const g = k.legs[s];
    const toeLen = Math.max(vec(g[3]).distanceTo(vec(g[2])), 1e-3);
    const names = [`${S}Thigh`, `${S}Shin`, `${S}Foot`, `${S}Toe`];
    names.forEach((n, i) => {
      const tail = i < 3 ? g[i + 1] : add(g[3], fwd.clone().multiplyScalar(0.8 * toeLen));
      bones.push(bone(n, i === 0 ? 'Hips' : names[i - 1], g[i], tail, { part: 'leg', side: s, index: i + 1 }));
    });
    const w = k.wings[s];
    for (let i = 0; i < 3; i++) bones.push(bone(`${S}Wing${i + 1}`, i === 0 ? 'Chest' : `${S}Wing${i}`, w[i], w[i + 1], { part: 'wing', side: s, index: i }));
  }
  bones.push(bone('Tail', 'Hips', k.tail[0], k.tail[1], { part: 'tail', index: 0 }));
  bones.push(bone('Tail1', 'Tail', k.tail[1], k.tail[2], { part: 'tail', index: 1 }));
  return { template: 'bird', bones: sortParentsFirst(bones), frame: { forward: { ...k.frame.forward }, up: { ...k.frame.up } } };
}

/** Average bird proportions (wings folded along the back unless `spread`). */
export function birdKeysIn(F: BodyFrame, L: number, H: number, W: number, spread = false, span = 0): BirdKeys {
  const w = Math.max(W, 0.2 * H);
  const leg = (s: 1 | -1): [Vec3, Vec3, Vec3, Vec3] => [
    F.at(-0.05 * L, 0.42 * H, s * 0.15 * w),
    F.at(0.0 * L, 0.26 * H, s * 0.16 * w),
    F.at(-0.03 * L, 0.06 * H, s * 0.16 * w),
    F.at(0.06 * L, 0.01 * H, s * 0.16 * w),
  ];
  const wing = (s: 1 | -1): [Vec3, Vec3, Vec3, Vec3] => {
    if (spread) {
      const half = Math.max(span / 2, 0.6 * L);
      return [F.at(0.08 * L, 0.66 * H, s * 0.2 * w), F.at(0.06 * L, 0.68 * H, s * 0.4 * half), F.at(0.02 * L, 0.68 * H, s * 0.72 * half), F.at(-0.04 * L, 0.66 * H, s * half)];
    }
    return [F.at(0.12 * L, 0.66 * H, s * 0.35 * w), F.at(-0.05 * L, 0.64 * H, s * 0.45 * w), F.at(-0.22 * L, 0.6 * H, s * 0.42 * w), F.at(-0.42 * L, 0.52 * H, s * 0.3 * w)];
  };
  return {
    frame: F.frame,
    hips: F.at(-0.08 * L, 0.5 * H),
    chest: F.at(0.14 * L, 0.56 * H),
    neck: [F.at(0.22 * L, 0.68 * H), F.at(0.27 * L, 0.8 * H)],
    head: F.at(0.3 * L, 0.9 * H),
    beak: F.at(0.5 * L, 0.88 * H),
    legs: { L: leg(1), R: leg(-1) },
    wings: { L: wing(1), R: wing(-1) },
    tail: [F.at(-0.26 * L, 0.5 * H), F.at(-0.38 * L, 0.46 * H), F.at(-0.5 * L, 0.42 * H)],
  };
}

// ---------------------------------------------------------------------------
// Snake / chain

/**
 * A chain through `points` ordered head end → tail tip. The root sits at the
 * head end (`Chain0`), the `Head` bone points from it forwards to `headTip`.
 */
export function chainSpec(points: Vec3[], headTip: Vec3 | null, frame: SkeletonSpec['frame'], template: TemplateId = 'snake'): SkeletonSpec {
  if (points.length < 2) throw new Error('A chain needs at least 2 points');
  const bones: BoneSpec[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    bones.push(bone(`Chain${i}`, i === 0 ? null : `Chain${i - 1}`, points[i], points[i + 1], i === 0 ? { part: 'root', index: 0 } : { part: 'chain', index: i }));
  }
  if (headTip) bones.push(bone('Head', 'Chain0', points[0], headTip, { part: 'head' }));
  return { template, bones: sortParentsFirst(bones), frame: { forward: { ...frame.forward }, up: { ...frame.up } } };
}

// ---------------------------------------------------------------------------
// Defaults in a box

/** The body's forward axis for a box: its longer horizontal side (+X for side views), else +Z. */
export function boxForward(box: Box3): Vec3 {
  const s = box.getSize(new Vector3());
  return s.x >= s.z ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
}

/** A single root bone at the box centre (the "start empty" custom skeleton). */
export function emptySpec(box: Box3): SkeletonSpec {
  const c = box.isEmpty() ? new Vector3() : box.getCenter(new Vector3());
  const h = box.isEmpty() ? 1 : box.getSize(new Vector3()).y;
  return {
    template: 'custom',
    bones: [bone('Root', null, plain(c), { x: c.x, y: c.y + 0.25 * h, z: c.z }, { part: 'root' })],
    frame: { forward: boxForward(box), up: { x: 0, y: 1, z: 0 } },
  };
}

/** Proportional placement of a template inside `box` (forward = `forward` or the box's long horizontal side). */
export function proportionalSpec(template: Exclude<TemplateId, 'humanoid' | 'custom'>, box: Box3, forward?: Vec3): SkeletonSpec {
  const b = box.isEmpty() ? new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)) : box;
  const fwd = forward ?? boxForward(b);
  const c = b.getCenter(new Vector3());
  const F = new BodyFrame(new Vector3(c.x, b.min.y, c.z), fwd);
  const size = b.getSize(new Vector3());
  const ext = (d: Vector3) => Math.abs(d.x) * size.x + Math.abs(d.y) * size.y + Math.abs(d.z) * size.z;
  const L = Math.max(ext(F.f), 1e-3), H = Math.max(size.y, 1e-3), W = Math.max(ext(F.left), 1e-3);
  if (template === 'quadruped') return quadrupedSpec(quadrupedKeysIn(F, L, H, W));
  if (template === 'bird') return birdSpec(birdKeysIn(F, L, H, W));
  // Snake: a straight chain along the body, head at +forward, just above the ground.
  const n = 10, y = 0.5 * H;
  const pts: Vec3[] = [];
  for (let i = 0; i <= n; i++) pts.push(F.at(0.4 * L - (0.9 * L * i) / n, y));
  return chainSpec(pts, F.at(0.5 * L, y), F.frame);
}

/** A template's spec when the user asks for it explicitly without auto placement (humanoid: from a layout). */
export function templateSpec(template: TemplateId, box: Box3, humanoidLayout?: JointLayout): SkeletonSpec {
  if (template === 'humanoid') {
    if (!humanoidLayout) throw new Error('humanoid template needs a layout');
    return humanoidSpecFromLayout(humanoidLayout);
  }
  if (template === 'custom') return emptySpec(box);
  return proportionalSpec(template, box);
}

/** Tail tip of a leaf / the root of a spec, for UI summaries. */
export function specSummary(spec: SkeletonSpec): { bones: number; deform: number; root: string } {
  return { bones: spec.bones.length, deform: spec.bones.filter((b) => b.deform).length, root: rootOf(spec).name };
}
