/**
 * Procedural clips for generic skeletons (quadrupeds, birds, snakes /
 * chains, and custom skeletons whose bones carry roles).
 *
 * Clips read bone ROLES (./types.ts BoneRole), never names. A clip is a pose
 * function of the normalised time u ∈ [0, 1] that rotates bones about the
 * body-frame axes (pitch = forward × up: raises forward-pointing bones and
 * swings hanging legs forwards; yaw = up: turns to the subject's left;
 * roll = forward: raises the left side), offsets the root (in leg lengths)
 * and places the feet: every leg with an upper / lower / foot chain is solved
 * with two-bone IK (./editor/ik.ts) towards its foot target — planted at the
 * rest footprint by default, so stance feet stay on the ground — with the
 * knee / elbow bending the way it does at rest (hind stifles forwards, front
 * elbows backwards) and the paw kept level.
 *
 * Then, per frame (30 fps), the floor pass: the skinned contact sample of
 * the bound surface (./contact.ts; joints when unbound) is posed and the
 * root is raised wherever something would sink below the rest ground; a
 * grounded clip that never touches the floor is lowered as a whole. Gaits,
 * idles and wags are periodic in u with whole cycles, so loops are seamless
 * by construction; gait periods and strides scale with the leg length.
 */
import { AnimationClip, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack } from 'three';
import type { KeyframeTrack } from 'three';
import type { I18nText } from '../core/types';
import { applyWorldDelta, defaultPole, twoBoneIKRotations } from './editor/ik';
import { makeContinuous } from './retarget';
import { boneMap, leftAxis, poseFK, specSize, vec, type PoseFK, type SpecDescriptor } from './spec';
import type { AnimationCategory, AnimationInfo, RigClip, SkeletonSpec } from './types';

export const ANIMAL_FPS = 30;

// ---------------------------------------------------------------------------
// Roles

export interface LegChain {
  /** 'FL' | 'FR' | 'HL' | 'HR' for quadrupeds, 'L' | 'R' otherwise. */
  key: string;
  side: 'L' | 'R';
  front: boolean | null;
  upper: number;
  lower: number;
  foot: number;
  /** Rest head of the foot bone (the IK end effector). */
  restFoot: Vector3;
  /** Rest bend direction of the mid joint (unit). */
  bend: Vector3;
}

export interface RoleIndex {
  root: number;
  spine: number[];
  neck: number[];
  head: number | undefined;
  jaw: number | undefined;
  ears: number[];
  tail: number[];
  chain: number[];
  wings: { L: number[]; R: number[] };
  legs: LegChain[];
}

export function roleIndex(spec: SkeletonSpec): RoleIndex {
  const by = (part: string) =>
    spec.bones
      .map((b, i) => ({ b, i }))
      .filter((x) => x.b.role?.part === part)
      .sort((a, c) => (a.b.role?.index ?? 0) - (c.b.role?.index ?? 0))
      .map((x) => x.i);
  const rootIdx = Math.max(0, spec.bones.findIndex((b) => b.parent === null));
  const f = vec(spec.frame.forward).normalize();
  const legs: LegChain[] = [];
  const groups = new Map<string, Map<number, number>>();
  spec.bones.forEach((b, i) => {
    const r = b.role;
    if (!r || r.part !== 'leg' || !r.side || r.index === undefined) return;
    const key = r.limb ? `${r.limb === 'front' ? 'F' : 'H'}${r.side}` : r.side;
    if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key)!.set(r.index, i);
  });
  for (const [key, g] of groups) {
    const upper = g.get(1), lower = g.get(2), foot = g.get(3);
    if (upper === undefined || lower === undefined || foot === undefined) continue;
    const bu = spec.bones[upper], bl = spec.bones[lower], bf = spec.bones[foot];
    if (bl.parent !== bu.name || bf.parent !== bl.name) continue;
    const front = key.length === 2 ? key[0] === 'F' : null;
    const a = vec(bu.head), b = vec(bl.head), c = vec(bf.head);
    // Front elbows bend backwards, hind stifles / bird knees forwards.
    const fallback = front === true ? f.clone().negate() : f.clone();
    const bend = defaultPole(a, b, c, fallback).sub(b).normalize();
    legs.push({ key, side: key.endsWith('L') ? 'L' : 'R', front, upper, lower, foot, restFoot: c, bend });
  }
  legs.sort((x, y) => x.key.localeCompare(y.key));
  const chain = by('chain');
  // A chain hanging off the root (snakes: the root is the chain's first segment).
  if (chain.length && spec.bones[chain[0]].parent === spec.bones[rootIdx].name) chain.unshift(rootIdx);
  return {
    root: rootIdx,
    spine: by('spine'),
    neck: by('neck'),
    head: by('head')[0],
    jaw: by('jaw')[0],
    ears: by('ear'),
    tail: by('tail'),
    chain,
    wings: { L: by('wing').filter((i) => spec.bones[i].role?.side === 'L'), R: by('wing').filter((i) => spec.bones[i].role?.side === 'R') },
    legs,
  };
}

export interface Measures {
  /** Mean upper + lower leg length (the unit of root offsets and strides). */
  legLen: number;
  /** Root → chest (or the chain length). */
  bodyLen: number;
  size: number;
}

export function measure(spec: SkeletonSpec, r: RoleIndex): Measures {
  const size = specSize(spec);
  const d = (i: number, j: number) => vec(spec.bones[i].head).distanceTo(vec(spec.bones[j].head));
  const legs = r.legs.map((l) => d(l.upper, l.lower) + d(l.lower, l.foot));
  const legLen = legs.length ? legs.reduce((a, b) => a + b, 0) / legs.length : 0.25 * size;
  let bodyLen = 0;
  const chest = r.spine[r.spine.length - 1];
  if (chest !== undefined) bodyLen = d(r.root, chest);
  if (r.chain.length > 1) for (let k = 1; k < r.chain.length; k++) bodyLen += d(r.chain[k - 1], r.chain[k]);
  return { legLen: Math.max(legLen, 1e-3), bodyLen: Math.max(bodyLen, 0.3 * size, 1e-3), size };
}

// ---------------------------------------------------------------------------
// Pose context

type Axis = 'pitch' | 'yaw' | 'roll';

export interface PoseCtx {
  r: RoleIndex;
  m: Measures;
  spec: SkeletonSpec;
  /** Rotate bone `i` (no-op when undefined) about a body axis, degrees. */
  rot(i: number | undefined, axis: Axis, deg: number): void;
  /** Point bone `i`'s rest direction towards `dir` (body frame at rest), blended by `weight`. */
  aim(i: number | undefined, dir: Vector3, weight?: number): void;
  /** Root offset in leg lengths along forward / up / left. */
  root(du: number, dy: number, dw?: number): void;
  /**
   * Foot target offset from its rest footprint in leg lengths (forward, up, left).
   * `follow`: the target also moves with the root (a leg lifted with the body). `curl`: foot pitch, degrees.
   */
  foot(leg: LegChain, du: number, dy: number, dw?: number, opts?: { follow?: boolean; curl?: number }): void;
  /** Disable IK for a leg (its FK rotations stay). */
  free(leg: LegChain): void;
}

interface FootTarget {
  off: Vector3;
  follow: boolean;
  curl: number;
  free: boolean;
}

class PoseState implements PoseCtx {
  readonly local: Quaternion[];
  readonly rootOff = new Vector3();
  readonly feet = new Map<LegChain, FootTarget>();
  readonly axes: Record<Axis, Vector3>;
  readonly f: Vector3;
  readonly up: Vector3;
  readonly left: Vector3;
  constructor(
    readonly spec: SkeletonSpec,
    readonly r: RoleIndex,
    readonly m: Measures,
  ) {
    this.local = spec.bones.map(() => new Quaternion());
    this.f = vec(spec.frame.forward).normalize();
    this.up = vec(spec.frame.up).normalize();
    this.left = leftAxis(spec);
    this.axes = { pitch: this.f.clone().cross(this.up).normalize(), yaw: this.up.clone(), roll: this.f.clone() };
  }
  reset(): void {
    for (const q of this.local) q.identity();
    this.rootOff.set(0, 0, 0);
    this.feet.clear();
  }
  rot(i: number | undefined, axis: Axis, deg: number): void {
    if (i === undefined || !deg) return;
    this.local[i].premultiply(new Quaternion().setFromAxisAngle(this.axes[axis], (deg * Math.PI) / 180));
  }
  aim(i: number | undefined, dir: Vector3, weight = 1): void {
    if (i === undefined) return;
    const b = this.spec.bones[i];
    const rest = vec(b.tail).sub(vec(b.head));
    if (rest.lengthSq() < 1e-12 || dir.lengthSq() < 1e-12) return;
    const q = new Quaternion().setFromUnitVectors(rest.normalize(), dir.clone().normalize());
    this.local[i].premultiply(new Quaternion().slerp(q, weight));
  }
  root(du: number, dy: number, dw = 0): void {
    const u = this.m.legLen;
    this.rootOff.addScaledVector(this.f, du * u).addScaledVector(this.up, dy * u).addScaledVector(this.left, dw * u);
  }
  foot(leg: LegChain, du: number, dy: number, dw = 0, opts: { follow?: boolean; curl?: number } = {}): void {
    const u = this.m.legLen;
    this.feet.set(leg, {
      off: new Vector3().addScaledVector(this.f, du * u).addScaledVector(this.up, dy * u).addScaledVector(this.left, dw * u),
      follow: !!opts.follow,
      curl: opts.curl ?? 0,
      free: false,
    });
  }
  free(leg: LegChain): void {
    this.feet.set(leg, { off: new Vector3(), follow: false, curl: 0, free: true });
  }
  fk(): PoseFK {
    return poseFK(this.spec, (_n, i) => this.local[i], this.rootOff);
  }
  /** Solve every leg towards its foot target (planted at rest by default). */
  solveLegs(): void {
    const parentIdx = new Map(this.spec.bones.map((b, i) => [b.name, i]));
    for (const leg of this.r.legs) {
      const t = this.feet.get(leg) ?? { off: new Vector3(), follow: false, curl: 0, free: false };
      if (t.free) continue;
      const fk = this.fk();
      const a = fk.pos[leg.upper], b = fk.pos[leg.lower], c = fk.pos[leg.foot];
      const target = leg.restFoot.clone().add(t.off);
      if (t.follow) target.add(this.rootOff);
      const pUpper = this.spec.bones[leg.upper].parent;
      const pi = pUpper !== null ? parentIdx.get(pUpper) : undefined;
      const parentRot = pi !== undefined ? fk.rot[pi] : new Quaternion();
      const pole = b.clone().add(leg.bend.clone().applyQuaternion(parentRot).multiplyScalar(this.m.legLen));
      const s = twoBoneIKRotations(a, b, c, target, pole);
      const W1 = fk.rot[leg.upper], W2 = fk.rot[leg.lower];
      this.local[leg.upper] = applyWorldDelta(parentRot, this.local[leg.upper], s.upper);
      const W1n = s.upper.clone().multiply(W1);
      const W2n = s.lower.clone().multiply(W2);
      this.local[leg.lower] = W1n.clone().invert().multiply(W2n).normalize();
      // Paw level (rest orientation, pitched by `curl`).
      const want = new Quaternion().setFromAxisAngle(this.axes.pitch, (t.curl * Math.PI) / 180);
      this.local[leg.foot] = W2n.clone().invert().multiply(want).normalize();
    }
  }
}

// ---------------------------------------------------------------------------
// Clip definitions

export interface AnimalClipDef {
  id: string;
  name: I18nText;
  category: AnimationCategory;
  loop: boolean;
  /** Seconds at the reference leg length (scaled for gaits). */
  duration: number;
  /** Scale the duration with √(leg length) (gaits). */
  scaleWithLegs?: boolean;
  /** Feet stay on the floor (default true). */
  grounded?: boolean;
  requires: (r: RoleIndex) => boolean;
  pose: (c: PoseCtx, u: number) => void;
}

const TAU = Math.PI * 2;
const sin = (u: number, cycles = 1, phase = 0) => Math.sin(TAU * (cycles * u + phase));
const frac = (x: number) => x - Math.floor(x);
const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
/** Piecewise smoothstep through (t, v) keys (zero slope at keys; holds outside). */
function curve(u: number, keys: [number, number][]): number {
  if (u <= keys[0][0]) return keys[0][1];
  for (let k = 1; k < keys.length; k++) {
    if (u <= keys[k][0]) {
      const [t0, v0] = keys[k - 1], [t1, v1] = keys[k];
      return v0 + (v1 - v0) * smooth((u - t0) / Math.max(t1 - t0, 1e-9));
    }
  }
  return keys[keys.length - 1][1];
}

const isQuadruped = (r: RoleIndex) => r.legs.filter((l) => l.front !== null).length >= 4;
const isBird = (r: RoleIndex) => r.wings.L.length > 0 && r.wings.R.length > 0 && r.legs.length >= 2;
const isChain = (r: RoleIndex) => r.chain.length >= 4;

interface GaitOptions {
  /** Phase offset per leg key. */
  phase: Record<string, number>;
  /** Fraction of the cycle a foot is on the ground. */
  duty: number;
  /** Stride and lift in leg lengths. */
  stride: number;
  lift: number;
  /** Swing curl of the paw (degrees). */
  curl: number;
  cycles?: number;
}

function gait(c: PoseCtx, u: number, o: GaitOptions): void {
  for (const l of c.r.legs) {
    const ph = frac((o.cycles ?? 1) * u + (o.phase[l.key] ?? 0));
    if (ph < o.duty) {
      const s = ph / o.duty;
      c.foot(l, o.stride * (0.5 - s), 0);
    } else {
      const s = (ph - o.duty) / (1 - o.duty);
      c.foot(l, o.stride * (-0.5 + (1 - Math.cos(Math.PI * s)) / 2), o.lift * Math.sin(Math.PI * s), 0, { curl: (l.front ? -1 : 1) * o.curl * Math.sin(Math.PI * s) });
    }
  }
}

/** Tail chain swaying (yaw) with a travelling lag. */
function tailSway(c: PoseCtx, u: number, amp: number, cycles = 1, lift = 0): void {
  c.r.tail.forEach((i, k) => {
    c.rot(i, 'yaw', amp * (0.6 + 0.2 * k) * sin(u, cycles, -0.08 * k));
    if (lift) c.rot(i, 'pitch', k === 0 ? -lift : 0);
  });
}

const breathe = (c: PoseCtx, u: number, amt = 1) => {
  c.rot(c.r.spine[c.r.spine.length - 1], 'pitch', 1.2 * amt * sin(u));
  c.rot(c.r.spine[0], 'pitch', -0.8 * amt * sin(u));
};

const neckHead = (c: PoseCtx, pitch: number, yaw: number, roll = 0) => {
  const n = Math.max(1, c.r.neck.length);
  for (const i of c.r.neck) {
    c.rot(i, 'pitch', pitch / (n + 1));
    c.rot(i, 'yaw', yaw / (n + 1));
    c.rot(i, 'roll', roll / (n + 1));
  }
  c.rot(c.r.head, 'pitch', pitch / (n + 1));
  c.rot(c.r.head, 'yaw', yaw / (n + 1));
  c.rot(c.r.head, 'roll', roll / (n + 1));
};

const ears = (c: PoseCtx, deg: number) => c.r.ears.forEach((i) => c.rot(i, 'roll', (c.spec.bones[i].role?.side === 'R' ? -1 : 1) * deg));

/** Root pitch that drops the far end of the body by `drop` leg lengths. */
const pitchFor = (c: PoseCtx, drop: number) => (Math.asin(Math.min(0.9, (drop * c.m.legLen) / c.m.bodyLen)) * 180) / Math.PI;

const clip = (
  id: string, en: string, tr: string, category: AnimationCategory, duration: number, loop: boolean,
  requires: AnimalClipDef['requires'], pose: AnimalClipDef['pose'], extra: Partial<AnimalClipDef> = {},
): AnimalClipDef => ({ id, name: { en, tr }, category, duration, loop, requires, pose, ...extra });

export const ANIMAL_CLIPS: AnimalClipDef[] = [
  // ---- quadruped ----------------------------------------------------------
  clip('quad-idle', 'Idle (breathing)', 'Bekleme (nefes)', 'idle', 4, true, isQuadruped, (c, u) => {
    breathe(c, u);
    c.root(0, 0.006 * sin(u));
    neckHead(c, 2 * sin(u, 1, 0.2), 0);
    tailSway(c, u, 6);
    ears(c, 4 * Math.max(0, sin(u, 2, 0.1)) ** 8);
  }),
  clip('quad-walk', 'Walk (4-beat)', 'Yürüyüş (4 vuruşlu)', 'locomotion', 1.1, true, isQuadruped, (c, u) => {
    c.root(0, -0.05 + 0.015 * sin(u, 4, 0.1));
    gait(c, u, { phase: { HL: 0, FL: 0.25, HR: 0.5, FR: 0.75 }, duty: 0.65, stride: 0.42, lift: 0.14, curl: 30 });
    c.r.spine.forEach((i) => c.rot(i, 'yaw', 2.5 * sin(u, 1)));
    c.rot(c.r.root, 'roll', 2 * sin(u, 1, 0.25));
    neckHead(c, 3 * sin(u, 2), -2 * sin(u, 1));
    tailSway(c, u, 10);
  }, { scaleWithLegs: true }),
  clip('quad-trot', 'Trot', 'Tırıs', 'locomotion', 0.7, true, isQuadruped, (c, u) => {
    c.root(0, -0.06 + 0.025 * sin(u, 2, 0.2));
    gait(c, u, { phase: { FL: 0, HR: 0, FR: 0.5, HL: 0.5 }, duty: 0.45, stride: 0.55, lift: 0.2, curl: 45 });
    c.rot(c.r.root, 'roll', 3 * sin(u, 1));
    neckHead(c, 4 * sin(u, 2, 0.1), 0);
    tailSway(c, u, 8, 2);
  }, { scaleWithLegs: true }),
  clip('quad-gallop', 'Gallop', 'Dörtnala', 'locomotion', 0.5, true, isQuadruped, (c, u) => {
    c.root(0, -0.08 + 0.07 * sin(u, 1, 0.1));
    c.rot(c.r.root, 'pitch', 6 * sin(u, 1, 0.35));
    c.r.spine.forEach((i) => c.rot(i, 'pitch', -5 * sin(u, 1, 0.1)));
    gait(c, u, { phase: { HL: 0, HR: 0.08, FR: 0.45, FL: 0.53 }, duty: 0.32, stride: 0.75, lift: 0.26, curl: 60 });
    neckHead(c, -8 * sin(u, 1, 0.3), 0);
    c.r.tail.forEach((i, k) => c.rot(i, 'pitch', -8 - 6 * sin(u, 1, -0.1 * k)));
    ears(c, -15);
  }, { scaleWithLegs: true }),
  clip('quad-sit', 'Sit', 'Otur', 'pose', 2.4, false, isQuadruped, (c, u) => {
    const e = curve(u, [[0, 0], [0.5, 1], [1, 1]]);
    const drop = 0.38 * e;
    c.rot(c.r.root, 'pitch', pitchFor(c, drop));
    c.root(-0.05 * e, -drop);
    for (const l of c.r.legs) if (l.front === false) c.foot(l, 0.12 * e, 0);
    neckHead(c, -pitchFor(c, drop) * 0.7 + 4 * e, 0);
    c.r.tail.forEach((i) => c.rot(i, 'pitch', 10 * e));
    breathe(c, u, e);
  }),
  clip('quad-lie-down', 'Lie down', 'Yat', 'pose', 2.8, false, isQuadruped, (c, u) => {
    const e = curve(u, [[0, 0], [0.55, 1], [1, 1]]);
    c.root(0.05 * e, -0.78 * e);
    for (const l of c.r.legs) {
      if (l.front) c.foot(l, 0.45 * e, 0.02 * e);
      else c.foot(l, 0.2 * e, 0.02 * e, (l.side === 'L' ? 1 : -1) * 0.12 * e);
    }
    neckHead(c, 8 * e, 0);
    c.r.tail.forEach((i) => c.rot(i, 'pitch', 12 * e));
    breathe(c, u, 0.5 * e);
  }),
  clip('quad-jump', 'Jump', 'Zıpla', 'action', 1.4, false, isQuadruped, (c, u) => {
    const dy = curve(u, [[0, 0], [0.25, -0.22], [0.5, 0.7], [0.72, -0.18], [1, 0]]);
    c.root(0, dy);
    c.rot(c.r.root, 'pitch', curve(u, [[0, 0], [0.22, -4], [0.36, 16], [0.5, 0], [0.62, -12], [0.8, 0], [1, 0]]));
    const air = Math.max(0, dy);
    for (const l of c.r.legs) c.foot(l, 0, air * 1.0 - 0.2 * air, 0, { curl: (l.front ? -1 : 1) * 40 * air });
    neckHead(c, curve(u, [[0, 0], [0.3, 10], [0.55, -6], [1, 0]]), 0);
    c.r.tail.forEach((i) => c.rot(i, 'pitch', curve(u, [[0, 0], [0.4, -20], [0.7, 10], [1, 0]])));
  }),
  clip('quad-tail-wag', 'Tail wag', 'Kuyruk sallama', 'emote', 0.8, true, (r) => isQuadruped(r) && r.tail.length > 0, (c, u) => {
    tailSway(c, u, 26, 2, 18);
    c.rot(c.r.root, 'yaw', -3 * sin(u, 2));
    c.rot(c.r.root, 'roll', 2 * sin(u, 2, 0.25));
    neckHead(c, 6, 0, 4 * sin(u, 1));
    ears(c, 6);
  }),
  clip('quad-look-around', 'Look around', 'Etrafa bakma', 'idle', 6, true, isQuadruped, (c, u) => {
    const yaw = curve(u, [[0, 0], [0.15, 40], [0.35, 40], [0.5, -40], [0.7, -40], [0.85, 0], [1, 0]]);
    const pitch = curve(u, [[0, 0], [0.15, 6], [0.35, 10], [0.5, 0], [0.7, 12], [0.85, -6], [1, 0]]);
    neckHead(c, pitch, yaw, 0.15 * yaw);
    c.r.spine.forEach((i) => c.rot(i, 'yaw', 0.12 * yaw));
    ears(c, 0.2 * Math.abs(yaw));
    breathe(c, u);
    tailSway(c, u, 5);
  }),
  clip('quad-sniff', 'Sniff / eat', 'Koklama / yeme', 'action', 2.4, true, isQuadruped, (c, u) => {
    c.rot(c.r.root, 'pitch', -4);
    neckHead(c, -60 + 4 * sin(u, 6), 6 * sin(u, 1));
    c.rot(c.r.jaw, 'pitch', -6 * Math.max(0, sin(u, 3)));
    c.root(0, -0.03);
    tailSway(c, u, 7, 2);
    ears(c, 5);
  }),
  clip('quad-shake', 'Shake off', 'Silkinme', 'emote', 1.0, true, isQuadruped, (c, u) => {
    const amp = 24;
    c.rot(c.r.root, 'roll', 0.5 * amp * sin(u, 4, 0.1));
    c.r.spine.forEach((i, k) => c.rot(i, 'roll', amp * sin(u, 4, -0.06 * k) * 0.6));
    c.r.neck.forEach((i) => c.rot(i, 'roll', amp * sin(u, 4, -0.25)));
    c.rot(c.r.head, 'roll', amp * sin(u, 4, -0.3));
    c.r.ears.forEach((i) => c.rot(i, 'roll', 1.4 * amp * sin(u, 4, -0.35)));
    c.r.tail.forEach((i, k) => c.rot(i, 'yaw', amp * sin(u, 4, 0.1 + 0.08 * k)));
  }),
  clip('quad-play-bow', 'Play bow / stretch', 'Oyun reveransı / gerinme', 'emote', 2.6, false, isQuadruped, (c, u) => {
    const e = curve(u, [[0, 0], [0.3, 1], [0.7, 1], [1, 0]]);
    const drop = 0.4 * e;
    c.rot(c.r.root, 'pitch', -pitchFor(c, drop));
    for (const l of c.r.legs) if (l.front) c.foot(l, 0.35 * e, 0);
    neckHead(c, 0.7 * pitchFor(c, drop) + 10 * e, 0);
    c.r.tail.forEach((i, k) => {
      c.rot(i, 'pitch', k === 0 ? -35 * e : 0);
      c.rot(i, 'yaw', 20 * e * sin(u, 4, -0.08 * k));
    });
    ears(c, 10 * e);
  }),

  // ---- bird ------------------------------------------------------------------
  clip('bird-idle', 'Idle (bird)', 'Bekleme (kuş)', 'idle', 3, true, isBird, (c, u) => {
    breathe(c, u, 1.5);
    const yaw = curve(u, [[0, 0], [0.12, 30], [0.4, 30], [0.5, -25], [0.8, -25], [0.9, 0], [1, 0]]);
    neckHead(c, 4 * sin(u, 2), yaw);
    c.r.tail.forEach((i) => c.rot(i, 'pitch', 3 * sin(u, 1, 0.3)));
  }),
  clip('bird-fly', 'Fly (flap)', 'Uç (kanat çırpma)', 'locomotion', 0.5, true, isBird, (c, u) => {
    c.root(0, 0.9 + 0.06 * sin(u, 1, 0.25));
    c.rot(c.r.root, 'pitch', -8);
    for (const side of ['L', 'R'] as const) {
      const s = side === 'L' ? 1 : -1;
      const w = c.r.wings[side];
      const out = new Vector3().addScaledVector(vec(c.spec.frame.forward), -0.15).add(leftAxis(c.spec).multiplyScalar(s));
      c.aim(w[0], out, 0.9);
      c.rot(w[0], 'roll', s * 50 * sin(u));
      c.rot(w[1], 'roll', s * 22 * sin(u, 1, -0.1));
      c.rot(w[2], 'roll', s * 16 * sin(u, 1, -0.2));
    }
    for (const l of c.r.legs) c.foot(l, -0.25, 0.3, 0, { follow: true, curl: 40 });
    neckHead(c, 10, 0);
    c.r.tail.forEach((i) => c.rot(i, 'pitch', 4 * sin(u, 1, 0.3)));
  }, { grounded: false }),
  clip('bird-hop', 'Hop', 'Sekme', 'locomotion', 0.9, true, isBird, (c, u) => {
    const dy = curve(u, [[0, 0], [0.2, -0.12], [0.5, 0.45], [0.8, -0.08], [1, 0]]);
    c.root(0, dy);
    const air = Math.max(0, dy);
    for (const l of c.r.legs) c.foot(l, 0, 0.8 * air, 0, { curl: 30 * air });
    neckHead(c, curve(u, [[0, 0], [0.3, -6], [0.55, 8], [1, 0]]), 0);
    c.r.wings.L.slice(0, 1).forEach((i) => c.rot(i, 'roll', 12 * air));
    c.r.wings.R.slice(0, 1).forEach((i) => c.rot(i, 'roll', -12 * air));
    c.r.tail.forEach((i) => c.rot(i, 'pitch', -10 * air));
  }, { scaleWithLegs: true }),
  clip('bird-peck', 'Peck', 'Gagalama', 'action', 1.2, true, isBird, (c, u) => {
    const p = curve(u, [[0, 0], [0.25, -1], [0.33, -0.85], [0.41, -1], [0.6, 0], [1, 0]]);
    c.rot(c.r.root, 'pitch', 12 * p);
    neckHead(c, 70 * p, 0);
    c.r.tail.forEach((i) => c.rot(i, 'pitch', 14 * p));
  }),

  // ---- snake / chain -------------------------------------------------------------
  clip('snake-slither', 'Slither', 'Sürünme', 'locomotion', 1.6, true, isChain, (c, u) => {
    const n = c.r.chain.length;
    c.r.chain.forEach((i, k) => c.rot(i, 'yaw', (k === 0 ? 8 : 22) * sin(u, 1, -k / n)));
    c.rot(c.r.head, 'yaw', -10 * sin(u, 1));
  }),
  clip('snake-idle', 'Idle (raised head)', 'Bekleme (baş kalkık)', 'idle', 3, true, isChain, (c, u) => {
    const [a, b, d] = c.r.chain;
    c.rot(a, 'pitch', 28);
    c.rot(b, 'pitch', -16);
    c.rot(d, 'pitch', -10);
    c.rot(a, 'yaw', 10 * sin(u));
    c.rot(b, 'yaw', -6 * sin(u, 1, 0.1));
    c.rot(c.r.head, 'pitch', -12 + 3 * sin(u, 2));
  }),
  clip('snake-strike', 'Strike', 'Saldırı', 'action', 1.4, false, isChain, (c, u) => {
    const coil = curve(u, [[0, 0], [0.35, 1], [0.45, 1], [0.55, 0], [1, 0]]);
    const lunge = curve(u, [[0, 0], [0.4, -0.1], [0.55, 0.9], [0.7, 0.9], [1, 0]]);
    const [a, b, d, e] = c.r.chain;
    c.rot(a, 'pitch', 30 * coil + 12 * Math.max(0, lunge));
    c.rot(b, 'pitch', -18 * coil);
    c.rot(b, 'yaw', 35 * coil);
    c.rot(d, 'yaw', -40 * coil);
    c.rot(e, 'yaw', 25 * coil);
    c.root((lunge * 0.35 * c.m.bodyLen) / c.m.legLen, 0);
    c.rot(c.r.head, 'pitch', -15 * coil);
    c.rot(c.r.jaw, 'pitch', -25 * Math.max(0, lunge));
  }),
];

// ---------------------------------------------------------------------------
// Building

/** Reference leg length (model units) the gait durations are authored for. */
const REF_LEG = 0.6;

/** Lowest point of a pose: the skinned contact sample, else the joints (body joints lifted by a thickness). */
function lowest(desc: SpecDescriptor, fk: PoseFK, legLen: number): number {
  const spec = desc.spec;
  const c = desc.contact;
  let min = Infinity;
  if (c && c.positions.length) {
    const n = spec.bones.length;
    const ry = new Float64Array(n * 4);
    spec.bones.forEach((b, i) => {
      const { x, y, z, w } = fk.rot[i];
      const r0 = 2 * (x * y + w * z), r1 = 1 - 2 * (x * x + z * z), r2 = 2 * (y * z - w * x);
      ry[i * 4] = r0;
      ry[i * 4 + 1] = r1;
      ry[i * 4 + 2] = r2;
      ry[i * 4 + 3] = fk.pos[i].y - (r0 * b.head.x + r1 * b.head.y + r2 * b.head.z);
    });
    const P = c.positions, I = c.skinIndex, W = c.skinWeight;
    for (let v = 0, m = P.length / 3; v < m; v++) {
      const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
      let out = 0;
      for (let s = 0; s < 4; s++) {
        const w = W[v * 4 + s];
        if (!w) continue;
        const k = (I[v * 4 + s] % n) * 4;
        out += w * (ry[k] * x + ry[k + 1] * y + ry[k + 2] * z + ry[k + 3]);
      }
      if (out < min) min = out;
    }
    return min;
  }
  spec.bones.forEach((b, i) => {
    const part = b.role?.part;
    const lift = part === 'root' || part === 'spine' || part === 'neck' || part === 'head' ? 0.12 * legLen : 0;
    const tail = vec(b.tail).sub(vec(b.head)).applyQuaternion(fk.rot[i]).add(fk.pos[i]);
    min = Math.min(min, fk.pos[i].y - lift, tail.y - lift);
  });
  return min;
}

export function buildAnimalClip(def: AnimalClipDef, desc: SpecDescriptor, r = roleIndex(desc.spec), fps = ANIMAL_FPS): RigClip {
  const spec = desc.spec;
  const m = measure(spec, r);
  const scale = def.scaleWithLegs ? Math.min(1.6, Math.max(0.6, Math.sqrt(m.legLen / REF_LEG))) : 1;
  const duration = def.duration * scale;
  const frames = Math.max(2, Math.round(duration * fps) + 1);
  const times = new Float32Array(frames);
  const n = spec.bones.length;
  const quats = spec.bones.map(() => new Float32Array(frames * 4));
  const rootPos = new Float32Array(frames * 3);
  const state = new PoseState(spec, r, m);
  const grounded = def.grounded !== false;
  const restFk = poseFK(spec, () => null);
  const ground = lowest(desc, restFk, m.legLen);
  const root = spec.bones[r.root];
  const need = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const u = f / (frames - 1);
    times[f] = u * duration;
    state.reset();
    def.pose(state, u);
    state.solveLegs();
    for (let i = 0; i < n; i++) state.local[i].normalize().toArray(quats[i], f * 4);
    rootPos[f * 3] = root.head.x + state.rootOff.x;
    rootPos[f * 3 + 1] = root.head.y + state.rootOff.y;
    rootPos[f * 3 + 2] = root.head.z + state.rootOff.z;
    // Floor: how far the pose sinks below the rest ground (negative = clearance).
    if (grounded) need[f] = ground - lowest(desc, state.fk(), m.legLen);
  }
  if (grounded) {
    let clearance = Infinity;
    for (let f = 0; f < frames; f++) {
      const up = Math.max(0, need[f]);
      rootPos[f * 3 + 1] += up;
      clearance = Math.min(clearance, up - need[f]);
    }
    // Never touching the floor (e.g. an authored bounce too high): lower the whole clip.
    if (clearance > 1e-9 && Number.isFinite(clearance)) for (let f = 0; f < frames; f++) rootPos[f * 3 + 1] -= clearance;
  }
  const tracks: KeyframeTrack[] = [];
  spec.bones.forEach((b, i) => {
    const v = quats[i];
    makeContinuous(v);
    let moving = false;
    for (let k = 0; k < v.length && !moving; k += 4) moving = Math.abs(v[k + 3]) < 1 - 1e-7;
    if (!moving && i !== r.root) return;
    tracks.push(new QuaternionKeyframeTrack(`${b.name}.quaternion`, times, v));
  });
  tracks.push(new VectorKeyframeTrack(`${root.name}.position`, times, rootPos));
  const clipObj = new AnimationClip(def.id, duration, tracks);
  const info: AnimationInfo = { id: def.id, name: def.name, category: def.category, loop: def.loop, source: 'builtin', duration };
  clipObj.userData = { ...clipObj.userData, info };
  return { clip: clipObj, info };
}

/** The procedural clips that fit this skeleton's roles, built for it. */
export function buildAnimalLibrary(desc: SpecDescriptor): RigClip[] {
  const r = roleIndex(desc.spec);
  return ANIMAL_CLIPS.filter((d) => d.requires(r)).map((d) => buildAnimalClip(d, desc, r));
}

/** Names of the bones a role index covers (debug / UI). */
export function roleSummary(spec: SkeletonSpec): Record<string, number> {
  const r = roleIndex(spec);
  const m = boneMap(spec);
  return {
    bones: m.size,
    legs: r.legs.length,
    tail: r.tail.length,
    wings: r.wings.L.length + r.wings.R.length,
    chain: r.chain.length,
    neck: r.neck.length,
  };
}
