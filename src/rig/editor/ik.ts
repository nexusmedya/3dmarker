/**
 * Analytic two-bone IK (upper + lower limb), pure three.js math.
 *
 * `twoBoneIK(a, b, c, target, pole)`: a = root joint (shoulder / hip), b =
 * mid joint (elbow / knee), c = end effector (wrist / ankle). The segment
 * lengths are kept; the end lands on the target when it is in reach (else as
 * far towards it as the straight limb goes, never past the minimum fold);
 * the mid joint lies in the plane through a, the target and the pole, on the
 * pole's side (law of cosines).
 *
 * `twoBoneIKRotations` turns the solution into world-space rotation deltas
 * for the upper and the lower bone; `applyWorldDelta` converts such a delta
 * into a bone's new local rotation given its parent's world rotation.
 */
import { Quaternion, Vector3 } from 'three';

export interface TwoBoneSolution {
  /** New mid joint. */
  b: Vector3;
  /** New end joint. */
  c: Vector3;
  /** True when the target was within reach (the end is on it). */
  reached: boolean;
}

export function twoBoneIK(a: Vector3, b: Vector3, c: Vector3, target: Vector3, pole: Vector3): TwoBoneSolution {
  const l1 = a.distanceTo(b), l2 = b.distanceTo(c);
  const toT = target.clone().sub(a);
  let d = toT.length();
  const maxR = l1 + l2, minR = Math.abs(l1 - l2);
  const eps = 1e-6 * Math.max(maxR, 1e-9);
  const dir = d > 1e-12 ? toT.clone().divideScalar(d) : c.clone().sub(a).normalize();
  if (dir.lengthSq() < 1e-12) dir.set(0, -1, 0);
  const reached = d <= maxR + eps && d >= minR - eps;
  d = Math.min(Math.max(d, minR + eps), maxR - eps);
  // Bend direction: the pole's component perpendicular to a → target.
  const bend = pole.clone().sub(a);
  bend.addScaledVector(dir, -bend.dot(dir));
  if (bend.lengthSq() < 1e-12) {
    // Pole on the line: keep the current bend, else any perpendicular.
    bend.copy(b).sub(a).addScaledVector(dir, -b.clone().sub(a).dot(dir));
    if (bend.lengthSq() < 1e-12) {
      bend.set(dir.y, -dir.x, 0);
      if (bend.lengthSq() < 1e-12) bend.set(0, dir.z, -dir.y);
    }
  }
  bend.normalize();
  // Law of cosines: angle at a between a → target and a → b.
  const cosA = Math.min(1, Math.max(-1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const nb = a.clone().addScaledVector(dir, l1 * cosA).addScaledVector(bend, l1 * sinA);
  const nc = a.clone().addScaledVector(dir, d);
  return { b: nb, c: nc, reached };
}

export interface TwoBoneRotations extends TwoBoneSolution {
  /** World rotation delta of the upper bone (about a). */
  upper: Quaternion;
  /** World rotation delta of the lower bone (total, including the upper's). */
  lower: Quaternion;
}

export function twoBoneIKRotations(a: Vector3, b: Vector3, c: Vector3, target: Vector3, pole: Vector3): TwoBoneRotations {
  const s = twoBoneIK(a, b, c, target, pole);
  const u0 = b.clone().sub(a).normalize(), u1 = s.b.clone().sub(a).normalize();
  const upper = new Quaternion().setFromUnitVectors(u0, u1);
  // Carry the upper's twist-free swing into the pole plane: rotate about a → b' so the old bend plane matches.
  const lowerDir = c.clone().sub(b).applyQuaternion(upper).normalize();
  const want = s.c.clone().sub(s.b).normalize();
  const lower = new Quaternion().setFromUnitVectors(lowerDir, want).multiply(upper);
  return { ...s, upper, lower };
}

/**
 * New local rotation of a bone whose world rotation W = P · L is turned by
 * the world delta D: L' = P⁻¹ · D · P · L.
 */
export function applyWorldDelta(parentWorld: Quaternion, local: Quaternion, delta: Quaternion, out = new Quaternion()): Quaternion {
  const pInv = parentWorld.clone().invert();
  return out.copy(pInv).multiply(delta).multiply(parentWorld).multiply(local).normalize();
}

/**
 * A default pole for a limb: the mid joint pushed away from the a → c line
 * (its current bend), or `fallback` (a direction) when the limb is straight.
 */
export function defaultPole(a: Vector3, b: Vector3, c: Vector3, fallback: Vector3): Vector3 {
  const len = a.distanceTo(b) + b.distanceTo(c);
  const ac = c.clone().sub(a);
  const t = ac.lengthSq() > 1e-12 ? b.clone().sub(a).dot(ac) / ac.lengthSq() : 0;
  const off = b.clone().sub(a.clone().addScaledVector(ac, t));
  if (off.length() > 0.02 * len) return b.clone().addScaledVector(off.normalize(), len);
  return b.clone().addScaledVector(fallback.clone().normalize(), len);
}
