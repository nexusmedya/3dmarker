import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { bonesOfLayout, CORE_BONES, FINGER_BONES, isHumanoidBone, mirrorBone, parentOf, primaryChild } from './bones';
import { applyLayout, boneSegments, buildSkeleton, describeRig, layoutOf, missingBones, resetToRest } from './skeleton';
import { makeMannequin } from './testing';
import { CORE_PARENT, type HumanoidBone, type JointLayout } from './types';

const truth = makeMannequin(1).joints;
const layout: JointLayout = { ...truth };

describe('bones', () => {
  it('core bones are ordered parents first, with the Mixamo names', () => {
    expect(CORE_BONES).toHaveLength(23);
    CORE_BONES.forEach((b, i) => {
      const p = CORE_PARENT[b];
      if (p) expect(CORE_BONES.indexOf(p)).toBeLessThan(i);
    });
    expect(FINGER_BONES).toHaveLength(30);
    expect(parentOf('LeftHandIndex1')).toBe('LeftHand');
    expect(parentOf('RightHandThumb3')).toBe('RightHandThumb2');
    expect(mirrorBone('LeftHandPinky2')).toBe('RightHandPinky2');
    expect(mirrorBone('Spine1')).toBe('Spine1');
    expect(isHumanoidBone('LeftToeBase') && isHumanoidBone('RightHandRing3') && !isHumanoidBone('LeftHandRing4')).toBe(true);
  });

  it('a finger is kept only when all three joints exist', () => {
    const l: JointLayout = { ...layout, LeftHandIndex1: truth.LeftHand, LeftHandIndex2: truth.LeftHand, LeftHandIndex3: truth.LeftHand, LeftHandThumb1: truth.LeftHand };
    const names = bonesOfLayout(l);
    expect(names).toContain('LeftHandIndex3');
    expect(names).not.toContain('LeftHandThumb1');
    expect(primaryChild('LeftHand', new Set(names))).toBe(null);
  });
});

describe('buildSkeleton', () => {
  it('builds the hierarchy with identity rest rotations and offsets as positions', () => {
    const rig = buildSkeleton(layout);
    expect(rig.names).toEqual(CORE_BONES);
    expect(rig.root.name).toBe('Hips');
    expect(rig.skeleton.bones).toHaveLength(23);
    for (const b of CORE_BONES) {
      const bone = rig.byName.get(b)!;
      expect(bone.name).toBe(b);
      expect(bone.parent?.name ?? null).toBe(CORE_PARENT[b]);
      expect(bone.quaternion.equals(bone.quaternion.clone().identity())).toBe(true);
      const world = new Vector3().setFromMatrixPosition(bone.matrixWorld);
      const t = layout[b]!;
      expect(world.distanceTo(new Vector3(t.x, t.y, t.z))).toBeLessThan(1e-6);
      expect(bone.userData.rest.quaternion).toEqual([0, 0, 0, 1]);
    }
    // Bind matrices: inverse of each bone's rest world matrix.
    rig.skeleton.bones.forEach((bone, i) => {
      const m = bone.matrixWorld.clone().multiply(rig.skeleton.boneInverses[i]);
      expect(m.equals(m.clone().identity()) || m.elements.every((v, k) => Math.abs(v - (k % 5 === 0 ? 1 : 0)) < 1e-6)).toBe(true);
    });
  });

  it('includes complete finger chains after the core bones', () => {
    const l: JointLayout = { ...layout };
    for (const n of [1, 2, 3] as const) l[`LeftHandMiddle${n}`] = { x: 0.84 + 0.03 * n, y: 0.62, z: 0 };
    const rig = buildSkeleton(l);
    expect(rig.names.slice(23)).toEqual(['LeftHandMiddle1', 'LeftHandMiddle2', 'LeftHandMiddle3']);
    expect(rig.byName.get('LeftHandMiddle1')!.parent!.name).toBe('LeftHand');
  });

  it('throws when a core joint is missing', () => {
    const l: JointLayout = { ...layout };
    delete l.LeftLeg;
    expect(missingBones(l)).toEqual(['LeftLeg']);
    expect(() => buildSkeleton(l)).toThrow(/LeftLeg/);
  });

  it('applyLayout / layoutOf / resetToRest', () => {
    const rig = buildSkeleton(layout);
    const moved: JointLayout = { ...layout, LeftForeArm: { x: 0.5, y: 0.7, z: 0.05 } };
    applyLayout(rig, moved);
    const back = layoutOf(rig);
    for (const b of CORE_BONES) expect(new Vector3(back[b]!.x, back[b]!.y, back[b]!.z).distanceTo(new Vector3(moved[b]!.x, moved[b]!.y, moved[b]!.z))).toBeLessThan(1e-6);
    rig.byName.get('LeftArm')!.rotation.set(0.3, 0.2, 0.1);
    rig.byName.get('Hips')!.position.y += 1;
    resetToRest(rig.root);
    expect(rig.byName.get('LeftArm')!.quaternion.w).toBeCloseTo(1, 9);
    expect(rig.byName.get('Hips')!.position.y).toBeCloseTo(moved.Hips!.y, 9);
  });

  it('describeRig: hip height above the soles and leg length', () => {
    const d = describeRig(layout);
    expect(d.hipHeight).toBeGreaterThan(0.95);
    expect(d.hipHeight).toBeLessThan(1.1);
    expect(d.legLength).toBeCloseTo(0.92, 2);
  });

  it('boneSegments: joint → child, end bones skipped, leaf bones extended', () => {
    const names = bonesOfLayout(layout);
    const segs = boneSegments(names, layout);
    const by = new Map(segs.map((s) => [s.bone, s] as [HumanoidBone, (typeof segs)[number]]));
    expect(by.has('HeadTop_End')).toBe(false);
    expect(by.get('LeftArm')!.tail.x).toBeCloseTo(layout.LeftForeArm!.x, 6);
    const hand = by.get('LeftHand')!;
    expect(hand.tail.x).toBeGreaterThan(hand.head.x); // continues along the forearm
    const toe = by.get('LeftToeBase')!;
    expect(toe.tail.z).toBeGreaterThan(toe.head.z);
    for (const s of segs) expect(names[s.index]).toBe(s.bone);
  });
});
