/**
 * Turn a DSL clip definition into an AnimationClip for one rig.
 *
 * The definition is evaluated on the canonical T-pose skeleton (forward
 * kinematics of the per-bone Euler angles) and transferred onto the rig with
 * the rest-pose-aware solver (../retarget.ts), so rigs whose rest pose is not
 * an exact T-pose (arms a bit down, legs apart — e.g. joints from a photo)
 * still get the intended pose. Output: 30 fps QuaternionKeyframeTracks named
 * `<Bone>.quaternion` for the bones that move (constant tracks collapsed to
 * two keys) + a `Hips.position` track (rest + offset × hip height). Tracks
 * bind by name from the model root, so one clip drives every skinned mesh.
 *
 * Grounded clips (the default; not fly / swim) get a floor pass: per frame,
 * forward kinematics of the rig (Hips rotation included) gives the Hips
 * height at which the pose just touches the rest ground: the bound surface
 * (the descriptor's skinned contact sample: soles, toes, the back when lying)
 * or, for a bare layout, the foot / toe joints plus the torso, head, knees,
 * elbows and hands lifted by their approximate thickness;
 * the authored Hips height is raised to at least that (no sinking between
 * keys or through pitched hips), and a clip that never touches the floor
 * (e.g. a run whose authored bounce is too high) is lowered as a whole until
 * it does, keeping its airborne phases.
 */
import { AnimationClip, Euler, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack } from 'three';
import type { KeyframeTrack } from 'three';
import { END_BONES, parentOf } from '../bones';
import { computeAlignment, makeContinuous, solveFrame } from '../retarget';
import type { RigDescriptor } from '../skeleton';
import type { AnimationInfo, HumanoidBone, RigClip } from '../types';
import { clipSampler, eulerOrder, type ClipDef } from './dsl';

export const CLIP_FPS = 30;

/** Rest direction of each bone in the canonical T-pose (others inherit their parent's alignment). */
const CANONICAL_DIRS: Partial<Record<HumanoidBone, [number, number, number]>> = {
  Spine: [0, 1, 0],
  Spine1: [0, 1, 0],
  Spine2: [0, 1, 0],
  Neck: [0, 1, 0],
  Head: [0, 1, 0],
  LeftArm: [1, 0, 0],
  LeftForeArm: [1, 0, 0],
  RightArm: [-1, 0, 0],
  RightForeArm: [-1, 0, 0],
  LeftUpLeg: [0, -1, 0],
  LeftLeg: [0, -1, 0],
  RightUpLeg: [0, -1, 0],
  RightLeg: [0, -1, 0],
};

/**
 * Bones within this angle of their canonical direction keep their own rest
 * direction (a near-T-pose layout plays the clips unchanged); farther ones
 * (an A-posed layout's arms) are aligned to the canonical T-pose.
 */
const ALIGN_MIN_ANGLE = (12 * Math.PI) / 180;

export function canonicalAlignment(rig: RigDescriptor): Map<HumanoidBone, Quaternion> {
  return computeAlignment(
    rig,
    (bone) => {
      const d = CANONICAL_DIRS[bone];
      return d ? new Vector3(d[0], d[1], d[2]) : null;
    },
    ALIGN_MIN_ANGLE,
  );
}

const DEG = Math.PI / 180;

export function buildClip(def: ClipDef, rig: RigDescriptor, align = canonicalAlignment(rig), fps = CLIP_FPS): RigClip {
  const sampler = clipSampler(def);
  const frames = Math.max(2, Math.round(def.duration * fps) + 1);
  const times = new Float32Array(frames);
  const tracks = new Map<HumanoidBone, Float32Array>();
  const animated = rig.bones.filter((b) => !END_BONES.has(b));
  for (const b of animated) tracks.set(b, new Float32Array(frames * 4));
  const hipsPos = new Float32Array(frames * 3);
  const keyed = new Set(sampler.bones);

  const canonical = new Map<HumanoidBone, Quaternion>();
  const local = new Map<HumanoidBone, Quaternion>();
  const e = [0, 0, 0], h = [0, 0, 0];
  const euler = new Euler(), q = new Quaternion();
  const rest = rig.layout.Hips!;
  const grounded = def.grounded !== false;
  /** Per frame: the Hips height at which the pose just touches the rest ground. */
  const floorY = new Float64Array(frames);
  const ground = grounded ? restGround(rig) : 0;
  for (let f = 0; f < frames; f++) {
    const u = f / (frames - 1);
    times[f] = u * def.duration;
    // Canonical forward kinematics (rest rotations are identity).
    for (const b of rig.bones) {
      const parent = parentOf(b);
      const s = canonical.get(b) ?? new Quaternion();
      s.copy((parent && canonical.get(parent)) || q.identity());
      if (keyed.has(b)) {
        sampler.euler(b, u, e);
        s.multiply(new Quaternion().setFromEuler(euler.set(e[0] * DEG, e[1] * DEG, e[2] * DEG, eulerOrder(b))));
      }
      canonical.set(b, s);
    }
    solveFrame(rig, (b) => canonical.get(b) ?? null, align, local);
    for (const b of animated) local.get(b)!.toArray(tracks.get(b)!, f * 4);
    sampler.hips(u, h);
    hipsPos[f * 3] = rest.x + h[0] * rig.hipHeight;
    hipsPos[f * 3 + 1] = rest.y + h[1] * rig.hipHeight;
    hipsPos[f * 3 + 2] = rest.z + h[2] * rig.hipHeight;
    if (grounded) floorY[f] = floorHipsY(rig, local, ground);
  }
  if (grounded) {
    let clearance = Infinity;
    for (let f = 0; f < frames; f++) {
      hipsPos[f * 3 + 1] = Math.max(hipsPos[f * 3 + 1], floorY[f]);
      clearance = Math.min(clearance, hipsPos[f * 3 + 1] - floorY[f]);
    }
    if (clearance > 1e-9 && Number.isFinite(clearance)) for (let f = 0; f < frames; f++) hipsPos[f * 3 + 1] -= clearance;
  }

  const out: KeyframeTrack[] = [];
  for (const b of animated) {
    const values = tracks.get(b)!;
    makeContinuous(values);
    if (b !== 'Hips' && isConstant(values, 4) && Math.abs(values[3]) > 1 - 1e-7) continue; // never leaves the rest pose
    out.push(compact(new QuaternionKeyframeTrack(`${b}.quaternion`, times, values), 4));
  }
  out.push(compact(new VectorKeyframeTrack('Hips.position', times, hipsPos), 3));
  const clip = new AnimationClip(def.id, def.duration, out);
  const info: AnimationInfo = { id: def.id, name: def.name, category: def.category, loop: def.loop, source: 'builtin', duration: def.duration };
  clip.userData = { ...clip.userData, info };
  return { clip, info };
}

/**
 * Contact points without a bound surface: joint → how far the body reaches
 * below it (× hipHeight). Feet / toes stay at their own rest height; the
 * torso, head, knees, elbows and hands keep their thickness off the floor
 * (lying, kneeling, crawling).
 */
const JOINT_RADII: Partial<Record<HumanoidBone, number>> = {
  Hips: 0.1, Spine: 0.1, Spine1: 0.1, Spine2: 0.1, Neck: 0.06, Head: 0.1, HeadTop_End: 0.06,
  LeftLeg: 0.05, RightLeg: 0.05, LeftForeArm: 0.04, RightForeArm: 0.04, LeftHand: 0.03, RightHand: 0.03,
};

/** Rest ground of a rig: its lowest surface point (the sample), else the lowest foot / toe joint. */
function restGround(rig: RigDescriptor): number {
  const c = rig.contact;
  if (c && c.positions.length) {
    let min = Infinity;
    for (let i = 1; i < c.positions.length; i += 3) min = Math.min(min, c.positions[i]);
    return min;
  }
  const L = rig.layout;
  return Math.min(...(['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'] as const).map((b) => L[b]?.y ?? Infinity));
}

/**
 * Hips Y (rig frame) at which the pose given by the local rotations `local`
 * just touches the rest ground: the skinned contact sample when the rig has
 * one (linear blend skinning of the sampled vertices), else the contact
 * joints lifted by their radius.
 */
function floorHipsY(rig: RigDescriptor, local: Map<HumanoidBone, Quaternion>, ground: number): number {
  const L = rig.layout;
  const hips = L.Hips!;
  // Forward kinematics relative to the Hips joint (bones are parents first).
  const rot = new Map<HumanoidBone, Quaternion>(), pos = new Map<HumanoidBone, Vector3>();
  for (const b of rig.bones) {
    const parent = parentOf(b);
    const p = L[b]!;
    if (!parent || !rot.has(parent)) {
      rot.set(b, (local.get(b) ?? IDENTITY).clone());
      pos.set(b, new Vector3(p.x - hips.x, p.y - hips.y, p.z - hips.z));
      continue;
    }
    const pp = L[parent]!, pq = rot.get(parent)!;
    pos.set(b, new Vector3(p.x - pp.x, p.y - pp.y, p.z - pp.z).applyQuaternion(pq).add(pos.get(parent)!));
    rot.set(b, pq.clone().multiply(local.get(b) ?? IDENTITY));
  }
  let lowest = Infinity;
  const c = rig.contact;
  if (c && c.positions.length) {
    // Only the y row of each bone's rotation matrix is needed: y' = Σ w (R (v − L) + P).y.
    const n = rig.bones.length;
    const ry = new Float64Array(n * 4);
    rig.bones.forEach((b, i) => {
      const q = rot.get(b)!, l = L[b]!;
      const { x, y, z, w } = q;
      const r0 = 2 * (x * y + w * z), r1 = 1 - 2 * (x * x + z * z), r2 = 2 * (y * z - w * x);
      ry[i * 4] = r0;
      ry[i * 4 + 1] = r1;
      ry[i * 4 + 2] = r2;
      ry[i * 4 + 3] = pos.get(b)!.y - (r0 * l.x + r1 * l.y + r2 * l.z);
    });
    const P = c.positions, I = c.skinIndex, W = c.skinWeight;
    for (let v = 0, m = P.length / 3; v < m; v++) {
      const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
      let out = 0;
      for (let s = 0; s < 4; s++) {
        const w = W[v * 4 + s];
        if (!w) continue;
        const k = I[v * 4 + s] * 4;
        out += w * (ry[k] * x + ry[k + 1] * y + ry[k + 2] * z + ry[k + 3]);
      }
      if (out < lowest) lowest = out;
    }
  } else {
    for (const [b, r] of Object.entries(JOINT_RADII) as [HumanoidBone, number][]) {
      const p = pos.get(b);
      if (p) lowest = Math.min(lowest, p.y - r * rig.hipHeight);
    }
    for (const b of ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'] as const) {
      const p = pos.get(b);
      if (p) lowest = Math.min(lowest, p.y - (L[b]!.y - ground));
    }
  }
  return Number.isFinite(lowest) ? ground - lowest : hips.y;
}

const IDENTITY = new Quaternion();

function isConstant(values: Float32Array, stride: number): boolean {
  for (let i = stride; i < values.length; i++) if (Math.abs(values[i] - values[i % stride]) > 1e-6) return false;
  return true;
}

/** A track whose values never change keeps only its first and last key. */
function compact<T extends KeyframeTrack>(track: T, stride: number): T {
  if (track.times.length <= 2 || !isConstant(track.values as Float32Array, stride)) return track;
  const n = track.times.length;
  const Ctor = track.constructor as new (name: string, times: ArrayLike<number>, values: ArrayLike<number>) => T;
  return new Ctor(track.name, [track.times[0], track.times[n - 1]], [...track.values.slice(0, stride), ...track.values.slice(0, stride)]);
}
