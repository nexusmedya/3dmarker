/**
 * Rest-pose-aware rotation transfer onto our skeleton, shared by the
 * built-in clips (source = the canonical T-pose skeleton) and imported
 * animations (source = the file's skeleton).
 *
 * For each target bone b with a source rotation, the source provides
 * S_b(t): its world rotation relative to its own rest pose, expressed in the
 * canonical frame (+X subject's left, +Y up, +Z forward). A_b maps our rest
 * bone direction onto the source's rest bone direction (minimal arc), so a
 * source whose rest pose differs from ours (an A-pose file, an A-posed
 * layout) still points each bone where the source points it:
 *
 *   W_b(t) = S_b(t) · A_b         (target world rotation; our rest world = identity)
 *   L_b(t) = W_parent(t)⁻¹ · W_b(t)   (the local rotation written to the track)
 *
 * Bones without a source rotation keep their rest local rotation (identity)
 * and bones without a usable direction inherit their parent's A (they keep
 * their rest relation to the parent).
 */
import { Quaternion, Vector3 } from 'three';
import { parentOf, primaryChild } from './bones';
import type { RigDescriptor } from './skeleton';
import type { HumanoidBone } from './types';

const IDENTITY = new Quaternion();

/**
 * A_b per rig bone. `sourceDir(b, child)` returns the source's rest direction
 * (canonical frame) of the bone b → child segment, or null when unknown.
 */
export function computeAlignment(
  rig: RigDescriptor,
  sourceDir: (bone: HumanoidBone, child: HumanoidBone) => Vector3 | null,
  /** Directions closer than this (radians) are treated as equal (the bone keeps its rest relation). */
  minAngle = 0,
): Map<HumanoidBone, Quaternion> {
  const present = new Set(rig.bones);
  const out = new Map<HumanoidBone, Quaternion>();
  const a = new Vector3(), b = new Vector3();
  for (const bone of rig.bones) {
    const parent = parentOf(bone);
    const inherited = (parent && out.get(parent)) || IDENTITY;
    const child = primaryChild(bone, present);
    const p = rig.layout[bone], c = child ? rig.layout[child] : undefined;
    const src = child ? sourceDir(bone, child) : null;
    if (!p || !c || !src || src.lengthSq() < 1e-12) {
      out.set(bone, inherited.clone());
      continue;
    }
    a.set(c.x - p.x, c.y - p.y, c.z - p.z);
    if (a.lengthSq() < 1e-12) {
      out.set(bone, inherited.clone());
      continue;
    }
    b.copy(src).normalize();
    a.normalize();
    if (minAngle > 0) {
      // Compare with the direction the inherited alignment already produces.
      const moved = a.clone().applyQuaternion(inherited);
      if (moved.angleTo(b) < minAngle) {
        out.set(bone, inherited.clone());
        continue;
      }
    }
    out.set(bone, new Quaternion().setFromUnitVectors(a, b));
  }
  return out;
}

/** Local rotations of one frame (see the module comment). `source(b)` null = no source for b. */
export function solveFrame(
  rig: RigDescriptor,
  source: (bone: HumanoidBone) => Quaternion | null,
  align: Map<HumanoidBone, Quaternion>,
  out: Map<HumanoidBone, Quaternion>,
): Map<HumanoidBone, Quaternion> {
  const world = new Map<HumanoidBone, Quaternion>();
  const inv = new Quaternion();
  for (const bone of rig.bones) {
    const parent = parentOf(bone);
    const wp = (parent && world.get(parent)) || IDENTITY;
    const s = source(bone);
    const w = s ? s.clone().multiply(align.get(bone) ?? IDENTITY) : wp.clone();
    world.set(bone, w);
    const local = out.get(bone) ?? new Quaternion();
    local.copy(inv.copy(wp).invert().multiply(w));
    out.set(bone, local.normalize());
  }
  return out;
}

/** Keep consecutive quaternion samples on the same hemisphere (no 360° flips when interpolating). */
export function makeContinuous(values: Float32Array | number[]): void {
  for (let i = 4; i < values.length; i += 4) {
    const dot = values[i] * values[i - 4] + values[i + 1] * values[i - 3] + values[i + 2] * values[i - 2] + values[i + 3] * values[i - 1];
    if (dot < 0) for (let c = 0; c < 4; c++) values[i + c] = -values[i + c];
  }
}
