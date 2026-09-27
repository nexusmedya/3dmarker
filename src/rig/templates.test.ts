import { describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three';
import { autoPlaceJoints } from './autoJoints';
import { bonesOfLayout } from './bones';
import { boneSegments } from './skeleton';
import {
  buildSkeletonFromSpec, findMirrorBone, humanoidLayoutOf, humanoidSpecFromLayout, mirrorBoneName, poseFK, sanitizeBoneName, segmentsOfSpec, sideOfName,
  uniqueBoneName, validateSpec,
} from './spec';
import { makeMannequin } from './testing';
import { emptySpec, proportionalSpec, TEMPLATE_INFO } from './templates';
import { TEMPLATE_IDS, type SkeletonSpec } from './types';

const box = new Box3(new Vector3(-1, -1, -0.3), new Vector3(1, 0.6, 0.3));
const parts = (s: SkeletonSpec, part: string) => s.bones.filter((b) => b.role?.part === part);

describe('templates', () => {
  it('every template has bilingual labels', () => {
    for (const id of TEMPLATE_IDS) {
      expect(TEMPLATE_INFO[id].name.tr).toBeTruthy();
      expect(TEMPLATE_INFO[id].name.en).toBeTruthy();
    }
  });

  it('quadruped: spine chain, neck / head / jaw, ears, 4 legs × shoulder / upper / lower / foot / toe, tail 3–6', () => {
    const s = proportionalSpec('quadruped', box);
    expect(validateSpec(s)).toEqual([]);
    expect(s.bones[0].name).toBe('Hips');
    expect(parts(s, 'spine').map((b) => b.name)).toEqual(['Spine', 'Spine1', 'Chest']);
    expect(parts(s, 'neck')).toHaveLength(2);
    expect(parts(s, 'head')).toHaveLength(1);
    expect(parts(s, 'jaw')[0].parent).toBe('Head');
    expect(parts(s, 'ear').map((b) => b.role!.side).sort()).toEqual(['L', 'R']);
    for (const limb of ['front', 'hind'] as const) {
      for (const side of ['L', 'R'] as const) {
        const leg = s.bones.filter((b) => b.role?.part === 'leg' && b.role.limb === limb && b.role.side === side);
        expect(leg.map((b) => b.role!.index)).toEqual([0, 1, 2, 3, 4]);
        expect(leg[0].parent).toBe(limb === 'front' ? 'Chest' : 'Hips');
        for (let i = 1; i < 5; i++) expect(leg[i].parent).toBe(leg[i - 1].name);
      }
    }
    const tail = parts(s, 'tail');
    expect(tail.length).toBeGreaterThanOrEqual(3);
    expect(tail.length).toBeLessThanOrEqual(6);
    expect(tail[0].parent).toBe('Hips');
    // Left legs are on the subject's left (+Z when facing +X is the right: left = up × forward = -Z).
    const lf = s.bones.find((b) => b.name === 'LeftFrontFoot')!, rf = s.bones.find((b) => b.name === 'RightFrontFoot')!;
    expect(lf.head.z).toBeLessThan(rf.head.z);
    // Feet near the ground, head up front.
    expect(s.bones.find((b) => b.name === 'LeftFrontToe')!.head.y).toBeLessThan(-0.9);
    expect(s.bones.find((b) => b.name === 'Head')!.head.x).toBeGreaterThan(0.5);
  });

  it('bird: 3-segment wings, legs, tail, neck; snake: one chain with a head; custom: a single root', () => {
    const b = proportionalSpec('bird', box);
    expect(validateSpec(b)).toEqual([]);
    for (const side of ['L', 'R']) {
      const w = b.bones.filter((x) => x.role?.part === 'wing' && x.role.side === side);
      expect(w.map((x) => x.role!.index)).toEqual([0, 1, 2]);
      expect(w[0].parent).toBe('Chest');
      expect(b.bones.filter((x) => x.role?.part === 'leg' && x.role.side === side).map((x) => x.role!.index)).toEqual([1, 2, 3, 4]);
    }
    expect(parts(b, 'tail').length).toBeGreaterThanOrEqual(1);
    expect(parts(b, 'neck').length).toBeGreaterThanOrEqual(1);
    const snake = proportionalSpec('snake', box);
    expect(validateSpec(snake)).toEqual([]);
    expect(parts(snake, 'chain').length).toBeGreaterThanOrEqual(8);
    expect(snake.bones[0].parent).toBeNull();
    expect(parts(snake, 'head')[0].parent).toBe(snake.bones[0].name);
    const empty = emptySpec(box);
    expect(empty.bones).toHaveLength(1);
    expect(empty.template).toBe('custom');
    expect(validateSpec(empty)).toEqual([]);
    // Every template builds a skeleton and poses (FK) without NaN.
    for (const spec of [b, snake, empty, proportionalSpec('quadruped', box)]) {
      const rig = buildSkeletonFromSpec(spec);
      expect(rig.bones).toHaveLength(spec.bones.length);
      const fk = poseFK(spec, () => null);
      spec.bones.forEach((x, i) => expect(fk.pos[i].distanceTo(new Vector3(x.head.x, x.head.y, x.head.z))).toBeLessThan(1e-9));
    }
  });

  it('humanoid spec round-trips its layout and skins exactly like the humanoid segments', () => {
    const layout = autoPlaceJoints(makeMannequin().mesh);
    const spec = humanoidSpecFromLayout(layout);
    expect(validateSpec(spec)).toEqual([]);
    expect(spec.bones.map((b) => b.name)).toEqual(bonesOfLayout(layout));
    expect(humanoidLayoutOf(spec)).toEqual(Object.fromEntries(bonesOfLayout(layout).map((n) => [n, layout[n]])));
    const a = segmentsOfSpec(spec), h = boneSegments(bonesOfLayout(layout), layout);
    expect(a.map((s) => [s.bone, s.index])).toEqual(h.map((s) => [s.bone, s.index]));
    a.forEach((s, i) => expect(s.tail.distanceTo(h[i].tail)).toBeLessThan(1e-12));
    expect(spec.bones.find((b) => b.name === 'LeftForeArm')!.role).toEqual({ part: 'arm', side: 'L', index: 2 });
  });

  it('names: sanitised, unique, mirrored by convention', () => {
    expect(sanitizeBoneName(' tail tip.1 ')).toBe('tail_tip1');
    expect(sanitizeBoneName('???')).toBe('Bone');
    const s = proportionalSpec('quadruped', box);
    expect(uniqueBoneName(s, 'Tail')).toBe('Tail_1');
    expect(mirrorBoneName('LeftFrontFoot')).toBe('RightFrontFoot');
    expect(mirrorBoneName('wing_L')).toBe('wing_R');
    expect(mirrorBoneName('R_ear')).toBe('L_ear');
    expect(mirrorBoneName('Leg')).toBeNull();
    expect(sideOfName('ear_l')).toBe('L');
    expect(findMirrorBone(s, 'LeftEar')).toBe('RightEar');
    expect(findMirrorBone(s, 'Head')).toBeNull();
  });
});
