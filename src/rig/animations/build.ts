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
