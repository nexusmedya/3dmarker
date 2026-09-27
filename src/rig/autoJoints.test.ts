import { describe, expect, it } from 'vitest';
import { BoxGeometry, ExtrudeGeometry, Mesh, PlaneGeometry, Shape, SphereGeometry } from 'three';
import type { HandResult, Landmark } from '../core/human/types';
import { autoPlaceJoints, autoPlaceJointsDetailed, clampToSilhouette, completeLayout } from './autoJoints';
import { bonesOfLayout, CORE_BONES } from './bones';
import { collectMeshData } from './meshData';
import { FAKE_IMAGE, fakeMask, fakePose, makeGroupedMannequin, makeMannequin, toPixel } from './testing';
import { POSE } from '../core/human/types';
import type { CoreBone, JointLayout, Vec3 } from './types';

const m = makeMannequin(1);
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function expectSymmetric(l: JointLayout, tol = 0.02) {
  for (const b of CORE_BONES) {
    if (!b.startsWith('Left')) continue;
    const r = l[('Right' + b.slice(4)) as CoreBone]!, p = l[b]!;
    expect(Math.abs(p.x + r.x - 2 * l.Hips!.x), b).toBeLessThan(tol);
    expect(Math.abs(p.y - r.y), b).toBeLessThan(tol);
  }
}

describe('autoPlaceJoints – silhouette heuristic (no pose)', () => {
  const res = autoPlaceJointsDetailed(m.mesh);
  const l = res.layout;

  it('recognises the T-pose and places every core joint', () => {
    expect(res.method).toBe('silhouette');
    for (const b of CORE_BONES) expect(l[b], b).toBeTruthy();
    expectSymmetric(l);
  });

  it('puts the joints where the mannequin has them', () => {
    const t = m.joints;
    expect(Math.abs(l.Hips!.y - t.Hips.y)).toBeLessThan(0.08);
    expect(Math.abs(l.LeftArm!.y - t.LeftArm.y)).toBeLessThan(0.04);
    expect(l.LeftArm!.x).toBeGreaterThan(0.08);
    expect(l.LeftArm!.x).toBeLessThan(0.25);
    expect(l.LeftHand!.x).toBeGreaterThan(0.65);
    expect(l.LeftHand!.x).toBeLessThan(0.93);
    expect(l.LeftForeArm!.x).toBeGreaterThan(l.LeftArm!.x + 0.2);
    expect(l.LeftForeArm!.x).toBeLessThan(l.LeftHand!.x - 0.1);
    expect(Math.abs(l.LeftUpLeg!.x - t.LeftUpLeg.x)).toBeLessThan(0.03);
    expect(Math.abs(l.LeftLeg!.y - t.LeftLeg.y)).toBeLessThan(0.08);
    expect(Math.abs(l.LeftFoot!.y - t.LeftFoot.y)).toBeLessThan(0.05);
    expect(l.LeftToeBase!.z).toBeGreaterThan(l.LeftFoot!.z + 0.03); // toes point forward
    expect(Math.abs(l.HeadTop_End!.y - 1)).toBeLessThan(0.03);
    expect(l.Neck!.y).toBeGreaterThan(l.Spine2!.y);
    expect(l.Head!.y).toBeGreaterThan(l.Neck!.y);
    expect(l.Head!.y).toBeLessThan(0.86);
    // Inside the body: the mannequin is centred on z = 0.
    for (const b of CORE_BONES) if (!b.endsWith('ToeBase')) expect(Math.abs(l[b]!.z), b).toBeLessThan(0.02);
  });

  it('works in the frame of a scaled / offset model root', () => {
    const { root, mannequin } = makeGroupedMannequin(1);
    const g = autoPlaceJoints(root);
    // Root-local = inner group offset + mannequin coordinates.
    const off = { x: 0.3, y: 0.1, z: -0.2 };
    expect(Math.abs(g.Hips!.x - off.x)).toBeLessThan(0.01);
    expect(Math.abs(g.HeadTop_End!.y - (1 + off.y))).toBeLessThan(0.03);
    expect(Math.abs(g.LeftHand!.x - (l.LeftHand!.x + off.x))).toBeLessThan(0.02);
    expect(Math.abs(g.LeftArm!.z - off.z)).toBeLessThan(0.02);
    void mannequin;
  });

  it('non-humanoid shapes get a symmetric proportional skeleton inside their bounds', () => {
    const blob = new Mesh(new SphereGeometry(0.8, 32, 16));
    const r = autoPlaceJointsDetailed(blob);
    expect(r.method).toBe('proportional');
    for (const b of CORE_BONES) {
      expect(r.layout[b], b).toBeTruthy();
      expect(Math.abs(r.layout[b]!.x)).toBeLessThanOrEqual(0.81);
      expect(r.layout[b]!.y).toBeGreaterThanOrEqual(-0.81);
      expect(r.layout[b]!.y).toBeLessThanOrEqual(0.81);
    }
    expectSymmetric(r.layout);
    // Arms hang along the sides (relaxed pose), not horizontal.
    expect(r.layout.LeftHand!.y).toBeLessThan(r.layout.LeftArm!.y - 0.2);
    expect(r.layout.LeftHand!.x).toBeGreaterThan(r.layout.LeftArm!.x);
    const box = autoPlaceJointsDetailed(new Mesh(new BoxGeometry(0.6, 2, 0.4)));
    expect(box.method).toBe('proportional');
    expect(box.layout.HeadTop_End!.y).toBeCloseTo(1, 1);
  });

  it('rates how human the shape looks: the mannequin (solid or as a flat relief) is plausible, an extruded star or a blob is not', () => {
    expect(res.plausibility).toBeGreaterThanOrEqual(0.7);
    expect(res.reasons).toEqual([]);
    // The same figure squashed to a relief keeps its head and legs.
    const relief = makeMannequin(1).mesh;
    relief.geometry.scale(1, 1, 0.3);
    expect(autoPlaceJointsDetailed(relief).plausibility).toBeGreaterThanOrEqual(0.5);
    for (const inner of [0.38, 0.45, 0.5]) {
      const star = new Shape();
      for (let k = 0; k < 10; k++) {
        const a = Math.PI / 2 + (k * Math.PI) / 5, r = k % 2 ? inner : 1;
        if (k === 0) star.moveTo(r * Math.cos(a), r * Math.sin(a));
        else star.lineTo(r * Math.cos(a), r * Math.sin(a));
      }
      const r = autoPlaceJointsDetailed(new Mesh(new ExtrudeGeometry(star, { depth: 0.1, bevelEnabled: false })));
      expect(r.plausibility, `star ${inner}`).toBeLessThan(0.5);
      expect(r.reasons, `star ${inner}`).toContain('no-head');
    }
    const blob = autoPlaceJointsDetailed(new Mesh(new SphereGeometry(0.8, 32, 16)));
    expect(blob.plausibility).toBeLessThan(0.5);
  });

  it('clampToSilhouette keeps a dragged joint inside the body', () => {
    const sil = res.silhouette;
    const elbow = l.LeftForeArm!;
    expect(clampToSilhouette(sil, elbow)).toBe(elbow); // inside: untouched
    // Dragged 0.17 above the arm and out in depth: back onto the arm, depth inside it.
    const off = clampToSilhouette(sil, { x: elbow.x, y: elbow.y + 0.17, z: elbow.z - 0.3 });
    expect(Math.abs(off.x - elbow.x)).toBeLessThan(0.03);
    expect(off.y - elbow.y).toBeLessThan(0.08);
    expect(Math.abs(off.z - elbow.z)).toBeLessThan(0.05);
  });

  it('a single surface (relief) puts joints slightly behind it', () => {
    const plane = new Mesh(new PlaneGeometry(1, 2, 20, 40).translate(0, 0, 0.3)); // root-local frame: geometry, not the root's own transform
    const r = autoPlaceJoints(plane);
    expect(r.Hips!.z).toBeLessThan(0.3);
    expect(r.Hips!.z).toBeGreaterThan(0.2);
  });
});

describe('autoPlaceJoints – pose landmarks', () => {
  const opts = { imageSize: FAKE_IMAGE, imageMask: fakeMask() };

  it('maps landmarks through the mask bounding box onto the model', () => {
    const r = autoPlaceJointsDetailed(m.mesh, { ...opts, pose: fakePose(m.joints) });
    expect(r.method).toBe('pose');
    const l = r.layout;
    for (const b of ['LeftArm', 'RightArm', 'LeftForeArm', 'LeftHand', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightFoot'] as CoreBone[]) {
      expect(dist(l[b]!, m.joints[b]), b).toBeLessThan(0.02);
    }
    expect(Math.abs(l.Hips!.y - (m.joints.LeftUpLeg.y + m.joints.RightUpLeg.y) / 2)).toBeLessThan(0.01);
    expect(l.Neck!.y).toBeGreaterThan(m.joints.LeftArm.y);
    expect(l.Neck!.y).toBeLessThan(l.Head!.y);
    expect(Math.abs(l.HeadTop_End!.y - 1)).toBeLessThan(0.03); // the mesh's crown
    expect(l.Spine!.y).toBeGreaterThan(l.Hips!.y);
    expect(l.Spine2!.y).toBeLessThan(l.Neck!.y);
  });

  it('pose joints override the silhouette (e.g. a lowered elbow)', () => {
    const pose = fakePose(m.joints, { [POSE.leftElbow]: { x: 0.5, y: 0.55 } });
    const l = autoPlaceJoints(m.mesh, { ...opts, pose });
    expect(Math.abs(l.LeftForeArm!.y - 0.55)).toBeLessThan(0.01);
  });

  it('invisible landmarks are grafted from the heuristic relative to their parent', () => {
    const pose = fakePose(m.joints);
    for (const i of [POSE.leftKnee, POSE.rightKnee, POSE.leftAnkle, POSE.rightAnkle, POSE.leftFootIndex, POSE.rightFootIndex]) {
      pose.landmarks[i] = { ...pose.landmarks[i], visibility: 0.1 };
    }
    const l = autoPlaceJoints(m.mesh, { ...opts, pose });
    for (const b of CORE_BONES) expect(l[b], b).toBeTruthy();
    expect(Math.abs(l.LeftFoot!.y - m.joints.LeftFoot.y)).toBeLessThan(0.06);
    expect(l.LeftLeg!.y).toBeLessThan(l.LeftUpLeg!.y);
  });

  it('a pose without shoulders or hips is ignored', () => {
    const pose = fakePose({});
    const r = autoPlaceJointsDetailed(m.mesh, { ...opts, pose });
    expect(r.method).toBe('silhouette');
  });

  it('adds finger joints from hand landmarks (handedness checked against the wrist)', () => {
    const w = m.joints.LeftHand;
    const lm: Landmark[] = [];
    const add = (x: number, y: number) => {
      const p = toPixel({ x, y });
      lm.push({ x: p.x, y: p.y, z: 0 });
    };
    add(w.x, w.y); // wrist
    for (let f = 0; f < 5; f++) for (let j = 1; j <= 4; j++) add(w.x + 0.015 * j, w.y + 0.03 - 0.015 * f);
    // Labelled "Right" but sitting on the left wrist → treated as the left hand.
    const hand: HandResult = { landmarks: lm, handedness: 'Right', box: { x: 0, y: 0, width: 1, height: 1 } };
    const l = autoPlaceJoints(m.mesh, { ...opts, pose: fakePose(m.joints), hands: [hand] });
    const names = bonesOfLayout(l);
    expect(names).toContain('LeftHandIndex3');
    expect(names).toContain('LeftHandThumb1');
    expect(names).not.toContain('RightHandIndex1');
    expect(l.LeftHandMiddle1!.x).toBeGreaterThan(l.LeftHand!.x);
  });
});

describe('completeLayout', () => {
  it('grafts missing joints keeping their offset to the parent', () => {
    const base: JointLayout = { ...m.joints };
    const partial: JointLayout = { Hips: { x: 1, y: 1, z: 1 }, Spine: { x: 1, y: 1.1, z: 1 } };
    const out = completeLayout(partial, base);
    expect(out.Spine).toEqual(partial.Spine);
    expect(out.Spine1!.y - out.Spine!.y).toBeCloseTo(base.Spine1!.y - base.Spine!.y, 9);
    expect(out.LeftUpLeg!.x - 1).toBeCloseTo(base.LeftUpLeg!.x - base.Hips!.x, 9);
  });
});

describe('collectMeshData', () => {
  it('merges meshes in the root frame', () => {
    const { root } = makeGroupedMannequin(1);
    const d = collectMeshData(root);
    expect(d.ranges).toHaveLength(1);
    expect(d.box.max.y).toBeCloseTo(1.1, 2);
    expect(d.index.length % 3).toBe(0);
  });
});
