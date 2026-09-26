/**
 * A tiny keyframe DSL for procedural humanoid clips.
 *
 * A clip is a list of keys at normalised times (0..1) holding poses: Euler
 * angles in DEGREES per bone, relative to the T-pose rest (see the
 * convention in ../types.ts), plus an optional Hips offset in units of the
 * rig's hip height (so clips fit any body size). Angles are interpolated per
 * channel with a monotone cubic Hermite spline (no overshoot at holds,
 * smooth velocity through the keys; cyclic for loops, eased in / out for
 * one-shots). Loop clips get their first key repeated at t = 1 when they do
 * not end on one, so they are seamless by construction.
 *
 * Euler orders: arm chains use 'YZX' ([twist x, swing y, elevation z]: z < 0
 * lowers the left arm, y < 0 brings it forward); everything else 'YXZ'
 * (x > 0 bends forward / flexes the knee, y > 0 turns to the subject's
 * left, z > 0 leans to the subject's right). Right-side values are usually
 * produced with `sym` / `mirrorPose` (mirror across X = 0: (x, -y, -z)).
 */
import type { I18nText } from '../../core/types';
import { FINGER_NAMES, isFingerBone, mirrorBone } from '../bones';
import type { AnimationCategory, HumanoidBone } from '../types';

export type Deg3 = readonly [number, number, number];
export type Pose = Partial<Record<HumanoidBone, Deg3>>;

export interface KeyDef {
  /** 0..1 */
  t: number;
  pose: Pose;
  /** Hips offset from rest, in hip heights. */
  hips?: Deg3;
}

export interface ClipDef {
  id: string;
  name: I18nText;
  category: AnimationCategory;
  loop: boolean;
  /** Seconds. */
  duration: number;
  keys: KeyDef[];
}

export function eulerOrder(bone: HumanoidBone): 'YZX' | 'YXZ' {
  return /Shoulder|Arm|Hand/.test(bone) || isFingerBone(bone) ? 'YZX' : 'YXZ';
}

export function mirrorPose(p: Pose): Pose {
  const out: Pose = {};
  for (const [b, v] of Object.entries(p) as [HumanoidBone, Deg3][]) out[mirrorBone(b)] = [v[0], -v[1], -v[2]];
  return out;
}

export function mirrorHips(h: Deg3 | undefined): Deg3 | undefined {
  return h && [-h[0], h[1], h[2]];
}

/** Add the mirrored counterpart of every sided bone that has none. */
export function sym(p: Pose): Pose {
  const out: Pose = { ...p };
  for (const [b, v] of Object.entries(p) as [HumanoidBone, Deg3][]) {
    const m = mirrorBone(b);
    if (m !== b && !(m in p)) out[m] = [v[0], -v[1], -v[2]];
  }
  return out;
}

/** Later poses win per bone. */
export function merge(...poses: Pose[]): Pose {
  return Object.assign({}, ...poses) as Pose;
}

/**
 * Finger curl for the left hand (0 = straight, 1 = fist); `sym()` it for
 * both hands. Curling rotates each finger about -Z (towards the palm, which
 * faces down in the T-pose).
 */
export function curl(amount: number, fingers = FINGER_NAMES, side: 'Left' | 'Right' = 'Left'): Pose {
  const out: Pose = {};
  const s = side === 'Left' ? 1 : -1;
  for (const f of fingers) {
    if (f === 'Thumb') {
      out[`${side}HandThumb1`] = [0, -s * 25 * amount, -s * 10 * amount];
      out[`${side}HandThumb2`] = [0, 0, -s * 30 * amount];
      out[`${side}HandThumb3`] = [0, 0, -s * 40 * amount];
    } else {
      out[`${side}Hand${f}1`] = [0, 0, -s * 70 * amount];
      out[`${side}Hand${f}2`] = [0, 0, -s * 95 * amount];
      out[`${side}Hand${f}3`] = [0, 0, -s * 60 * amount];
    }
  }
  return out;
}

/** Proportions of a leg in hip heights (thigh, shin, ankle-to-sole). */
const THIGH = 0.47, SHIN = 0.45, ANKLE = 0.08;

/**
 * Both legs bent with flat feet: thighs `a`° forward, knees `b`°. Returns the
 * pose and the Hips drop (hip heights) that keeps the soles on the ground.
 */
export function stance(a: number, b: number, abduct = 0): { pose: Pose; dy: number } {
  const r = Math.PI / 180;
  const h = ANKLE + (THIGH * Math.cos(a * r) + SHIN * Math.cos((b - a) * r)) * Math.cos(abduct * r);
  return {
    pose: sym({ LeftUpLeg: [-a, 0, abduct], LeftLeg: [b, 0, 0], LeftFoot: [a - b, 0, -abduct] }),
    dy: h - 1,
  };
}

/**
 * A symmetric cycle from its first half: keys in [0, 0.5) are repeated
 * mirrored half a period later (walks, runs…); the first key closes the loop.
 */
export function cycle(half: KeyDef[]): KeyDef[] {
  const out: KeyDef[] = [...half];
  for (const k of half) out.push({ t: k.t + 0.5, pose: mirrorPose(k.pose), hips: mirrorHips(k.hips) });
  out.push({ ...half[0], t: 1 });
  return out;
}

/** Mirror a whole clip (e.g. wave with the left hand → with the right). */
export function mirrorClip(def: ClipDef, id: string, name: I18nText): ClipDef {
  return { ...def, id, name, keys: def.keys.map((k) => ({ t: k.t, pose: mirrorPose(k.pose), hips: mirrorHips(k.hips) })) };
}

export function key(t: number, pose: Pose, hips?: Deg3): KeyDef {
  return { t, pose, hips };
}

// ---------------------------------------------------------------------------
// Evaluation

export interface Channel {
  times: number[];
  values: number[];
  loop: boolean;
}

/** Keys sorted, loop closed (first key repeated at t = 1 when needed). */
export function normalizedKeys(def: ClipDef): KeyDef[] {
  const keys = [...def.keys].sort((a, b) => a.t - b.t);
  if (!keys.length) return [{ t: 0, pose: {} }];
  if (def.loop && keys[keys.length - 1].t < 1 - 1e-9) keys.push({ ...keys[0], t: 1 });
  return keys;
}

/** Monotone cubic Hermite tangents (Fritsch–Carlson), cyclic for loops. */
function tangents(ch: Channel): number[] {
  const { times: t, values: v } = ch;
  const n = t.length;
  const m = new Array<number>(n).fill(0);
  if (n < 2) return m;
  const secant = (i: number) => (v[i + 1] - v[i]) / Math.max(t[i + 1] - t[i], 1e-9);
  for (let i = 0; i < n; i++) {
    let d0: number, d1: number;
    if (i === 0 || i === n - 1) {
      if (!ch.loop || n < 3) continue; // one-shots ease in / out
      // Periodic extension: the key before t = 0 is key n-2 one period earlier, shifted by the
      // channel's net change (v[n-1] - v[0], e.g. 360° for a spin), so its secant is secant(n-2).
      d0 = secant(n - 2);
      d1 = secant(0);
    } else {
      d0 = secant(i - 1);
      d1 = secant(i);
    }
    if (d0 * d1 <= 0) continue;
    let mi = (d0 + d1) / 2;
    const lim = 3 * Math.min(Math.abs(d0), Math.abs(d1));
    if (Math.abs(mi) > lim) mi = Math.sign(mi) * lim;
    m[i] = mi;
  }
  if (ch.loop && n >= 3) m[n - 1] = m[0];
  return m;
}

/** Sampler for one channel: value at normalised time u ∈ [0, 1]. */
export function channelSampler(ch: Channel): (u: number) => number {
  const { times: t, values: v } = ch;
  const m = tangents(ch);
  const n = t.length;
  return (u: number) => {
    if (n === 1 || u <= t[0]) return v[0];
    if (u >= t[n - 1]) return v[n - 1];
    let i = 0;
    while (i < n - 2 && u > t[i + 1]) i++;
    const h = t[i + 1] - t[i];
    if (h <= 1e-9) return v[i + 1];
    const s = (u - t[i]) / h, s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * v[i] + (s3 - 2 * s2 + s) * h * m[i] + (-2 * s3 + 3 * s2) * v[i + 1] + (s3 - s2) * h * m[i + 1];
  };
}

export interface ClipSampler {
  bones: HumanoidBone[];
  /** Euler degrees of `bone` at u (only for `bones`). */
  euler(bone: HumanoidBone, u: number, out: number[]): number[];
  hips(u: number, out: number[]): number[];
}

export function clipSampler(def: ClipDef): ClipSampler {
  const keys = normalizedKeys(def);
  const bones = [...new Set(keys.flatMap((k) => Object.keys(k.pose) as HumanoidBone[]))];
  const times = keys.map((k) => k.t);
  const make = (get: (k: KeyDef) => number) => channelSampler({ times, values: keys.map(get), loop: def.loop });
  const samplers = new Map<HumanoidBone, ((u: number) => number)[]>();
  for (const b of bones) samplers.set(b, [0, 1, 2].map((c) => make((k) => k.pose[b]?.[c] ?? 0)));
  const hips = [0, 1, 2].map((c) => make((k) => k.hips?.[c] ?? 0));
  return {
    bones,
    euler(bone, u, out) {
      const s = samplers.get(bone);
      out[0] = s ? s[0](u) : 0;
      out[1] = s ? s[1](u) : 0;
      out[2] = s ? s[2](u) : 0;
      return out;
    },
    hips(u, out) {
      out[0] = hips[0](u);
      out[1] = hips[1](u);
      out[2] = hips[2](u);
      return out;
    },
  };
}

