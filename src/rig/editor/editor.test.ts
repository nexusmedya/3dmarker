import { describe, expect, it, vi } from 'vitest';
import { AnimationMixer, Bone, Quaternion, Vector3 } from 'three';
import { autoPlaceJoints } from '../autoJoints';
import { humanoidLayoutOf, humanoidSpecFromLayout, mirrorPoint, remapWeights, validateSpec } from '../spec';
import { makeMannequin } from '../testing';
import { proportionalSpec } from '../templates';
import type { SkinWeights } from '../skinning';
import { EditHistory } from './history';
import { applyWorldDelta, twoBoneIK, twoBoneIKRotations } from './ik';
import {
  deleteKeys, keyTimes, mirrorPose, mirrorQuat, moveKeys, newClipDoc, renameDocBones, samplePose, setDocProps, setInterp, setPosKey, setRotKey, toAnimationClip,
} from './keyframes';
import { addBone, deleteBone, interiorMidpoint, mirrorSide, moveJoint, renameBone, reparentBone } from './ops';
import { falloffWeight, heat, WeightPainter } from './weightPaint';
import { Box3 } from 'three';

const humanSpec = () => humanoidSpecFromLayout(autoPlaceJoints(makeMannequin().mesh));
const dogSpec = () => proportionalSpec('quadruped', new Box3(new Vector3(-1, -1, -0.3), new Vector3(1, 0.5, 0.3)), { x: 1, y: 0, z: 0 });
const names = (s: { bones: { name: string }[] }) => s.bones.map((b) => b.name);

describe('skeleton editing operations', () => {
  it('adds a child at the parent tail, and its mirror under the mirror parent with symmetry', () => {
    const spec = humanSpec();
    const r = addBone(spec, 'LeftHand', { symmetric: true });
    expect(r.changed).toBe(true);
    expect(validateSpec(r.spec)).toEqual([]);
    const added = r.spec.bones.find((b) => b.name === r.select)!;
    expect(added.parent).toBe('LeftHand');
    expect(added.name).toBe('LeftBone');
    const hand = spec.bones.find((b) => b.name === 'LeftHand')!;
    expect(added.head).toEqual(hand.tail);
    const twin = r.spec.bones.find((b) => b.name === 'RightBone')!;
    expect(twin.parent).toBe('RightHand');
    const m = mirrorPoint(spec, added.head);
    expect(twin.head.x).toBeCloseTo(m.x, 9);
    // Extra bones keep the skeleton a humanoid.
    expect(humanoidLayoutOf(r.spec)).not.toBeNull();
    expect(spec.bones.length).toBe(humanSpec().bones.length); // input untouched
  });

  it('deletes a bone and reparents its children; deleting the root promotes a child; the last bone stays', () => {
    const spec = dogSpec();
    const r = deleteBone(spec, 'Neck1');
    expect(validateSpec(r.spec)).toEqual([]);
    expect(names(r.spec)).not.toContain('Neck1');
    expect(r.spec.bones.find((b) => b.name === 'Head')!.parent).toBe('Neck');
    const sym = deleteBone(spec, 'LeftEar', { symmetric: true });
    expect(names(sym.spec)).not.toContain('RightEar');
    const root = deleteBone(spec, 'Hips');
    expect(validateSpec(root.spec)).toEqual([]);
    expect(root.spec.bones.filter((b) => b.parent === null)).toHaveLength(1);
    let one = { spec: { ...spec, bones: [spec.bones[0]] }, changed: true };
    one = deleteBone(one.spec, 'Hips');
    expect(one.changed).toBe(false);
    // A humanoid missing a core bone is no humanoid any more.
    expect(humanoidLayoutOf(deleteBone(humanSpec(), 'Spine1').spec)).toBeNull();
  });

  it('renames (sanitised, unique, mirrored with symmetry) and reparents without cycles', () => {
    const spec = dogSpec();
    const r = renameBone(spec, 'LeftEar', 'Left Ear.tip!', { symmetric: true });
    expect(r.renamed).toEqual({ LeftEar: 'Left_Eartip', RightEar: 'Right_Eartip' });
    expect(validateSpec(r.spec)).toEqual([]);
    expect(renameBone(spec, 'Tail', 'Hips').renamed).toEqual({ Tail: 'Hips_1' });
    const rp = reparentBone(spec, 'Tail', 'Chest');
    expect(rp.spec.bones.find((b) => b.name === 'Tail')!.parent).toBe('Chest');
    expect(reparentBone(spec, 'Spine', 'Head').changed).toBe(false); // Head is below Spine
    expect(reparentBone(spec, 'Hips', 'Tail').changed).toBe(false); // root
  });

  it('moves joints keeping connected neighbours, mirrored with symmetry; mirrors a side', () => {
    const spec = dogSpec();
    const knee = spec.bones.find((b) => b.name === 'LeftFrontLowerLeg')!;
    const p = { x: knee.head.x + 0.05, y: knee.head.y, z: knee.head.z + 0.02 };
    const r = moveJoint(spec, 'LeftFrontLowerLeg', 'head', p, { symmetric: true });
    const b = (n: string) => r.spec.bones.find((x) => x.name === n)!;
    expect(b('LeftFrontLowerLeg').head).toEqual(p);
    expect(b('LeftFrontUpperLeg').tail).toEqual(p); // connected parent tail
    const m = mirrorPoint(spec, p);
    expect(b('RightFrontLowerLeg').head.z).toBeCloseTo(m.z, 9);
    // Mirror the left side onto the right after an asymmetric edit.
    const asym = moveJoint(spec, 'LeftEar', 'tail', { x: 0.9, y: 0.9, z: 0.2 }).spec;
    const mir = mirrorSide(asym, 'L');
    expect(mir.changed).toBe(true);
    const rt = mir.spec.bones.find((x) => x.name === 'RightEar')!.tail;
    expect(rt.z).toBeCloseTo(mirrorPoint(asym, { x: 0.9, y: 0.9, z: 0.2 }).z, 9);
  });

  it('snaps to the mesh interior: the midpoint of the first two ray hits', () => {
    expect(interiorMidpoint([3, 1, 5], { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 })).toEqual({ x: 0, y: 0, z: -2 });
    expect(interiorMidpoint([1], { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBeNull();
  });

  it('carries weights over structural edits by name (deleted bone → parent)', () => {
    const spec = dogSpec();
    const idx = (n: string) => spec.bones.findIndex((b) => b.name === n);
    const w: SkinWeights = { skinIndex: new Uint16Array([idx('Neck1'), idx('Head'), 0, 0, idx('LeftEar'), 0, 0, 0]), skinWeight: new Float32Array([0.6, 0.4, 0, 0, 1, 0, 0, 0]) };
    const del = deleteBone(spec, 'Neck1');
    const ren = renameBone(del.spec, 'LeftEar', 'EarL');
    const out = remapWeights(remapWeights(w, spec, del.spec), del.spec, ren.spec, ren.renamed);
    const n2 = (n: string) => ren.spec.bones.findIndex((b) => b.name === n);
    expect(out.skinIndex[0]).toBe(n2('Neck'));
    expect(out.skinWeight[0]).toBeCloseTo(0.6, 6);
    expect(out.skinIndex[1]).toBe(n2('Head'));
    expect(out.skinIndex[4]).toBe(n2('EarL'));
  });
});

describe('EditHistory', () => {
  it('undoes / redoes in order (async entries queue), clears redo on a new edit, honours its limit', async () => {
    const h = new EditHistory(3);
    const log: string[] = [];
    let value = 0;
    const entry = (from: number, to: number) => ({
      label: `${from}→${to}`,
      undo: async () => {
        await new Promise((r) => setTimeout(r, 5));
        value = from;
        log.push(`undo ${to}`);
      },
      redo: () => {
        value = to;
        log.push(`redo ${to}`);
      },
    });
    const onChange = vi.fn();
    h.onChange = onChange;
    for (let k = 1; k <= 4; k++) {
      value = k;
      h.push(entry(k - 1, k));
    }
    expect(h.state.undo).toBe(3); // limit
    await Promise.all([h.undo(), h.undo()]);
    expect(value).toBe(2);
    expect(log).toEqual(['undo 4', 'undo 3']);
    await h.redo();
    expect(value).toBe(3);
    h.push(entry(3, 9));
    expect(h.state.redo).toBe(0);
    expect(await h.redo()).toBe(false);
    expect(onChange).toHaveBeenCalled();
  });
});

describe('weight painting', () => {
  // A strip of 11 vertex pairs along x (0..1), welded duplicates at x = 0.5, two bones.
  function strip() {
    const pos: number[] = [], idx: number[] = [];
    for (let i = 0; i <= 10; i++) pos.push(i / 10, 0, 0, i / 10, 0.1, 0);
    for (let i = 0; i < 10; i++) idx.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
    pos.push(0.5, 0, 0); // duplicate of vertex 10
    const n = pos.length / 3;
    const w: SkinWeights = { skinIndex: new Uint16Array(n * 4), skinWeight: new Float32Array(n * 4) };
    for (let v = 0; v < n; v++) {
      const x = pos[v * 3];
      w.skinIndex[v * 4] = 0;
      w.skinIndex[v * 4 + 1] = 1;
      w.skinWeight[v * 4] = 1 - x;
      w.skinWeight[v * 4 + 1] = x;
    }
    return new WeightPainter(new Float32Array(pos), new Uint32Array(idx), w, new Int32Array([-1, 0]));
  }
  const sums = (w: SkinWeights) => {
    for (let v = 0; v < w.skinWeight.length / 4; v++) expect(w.skinWeight[v * 4] + w.skinWeight[v * 4 + 1] + w.skinWeight[v * 4 + 2] + w.skinWeight[v * 4 + 3]).toBeCloseTo(1, 5);
  };

  it('falloff curves and the heat ramp', () => {
    expect(falloffWeight(0, 1, 'smooth')).toBe(1);
    expect(falloffWeight(0.5, 1, 'linear')).toBeCloseTo(0.5, 9);
    expect(falloffWeight(0.99, 1, 'constant')).toBe(1);
    expect(falloffWeight(1.2, 1, 'smooth')).toBe(0);
    expect(heat(1)[0]).toBeGreaterThan(0.9);
    expect(heat(0)[2]).toBeGreaterThan(heat(0)[0]);
  });

  it('add / subtract / replace / smooth keep the weights normalised, welded twins identical, and diff for undo', () => {
    const p = strip();
    const v5 = p.weld[10];
    expect(p.weld[p.weld.length - 1]).toBe(v5); // the duplicate is welded
    p.beginStroke();
    expect(p.dab({ x: 0.5, y: 0, z: 0 }, { mode: 'add', radius: 0.12, strength: 0.3, falloff: 'constant', bone: 1 })).toBeGreaterThan(0);
    expect(p.weightOf(v5, 1)).toBeCloseTo(0.8, 5);
    expect(p.weightOf(v5, 0)).toBeCloseTo(0.2, 5);
    const diff = p.endStroke()!;
    let w = p.weights();
    sums(w);
    const dup = w.skinWeight.length / 4 - 1;
    expect([...w.skinWeight.slice(dup * 4, dup * 4 + 4)]).toEqual([...w.skinWeight.slice(10 * 4, 10 * 4 + 4)]);
    p.applyDiff(diff, 'before');
    expect(p.weightOf(v5, 1)).toBeCloseTo(0.5, 5);
    p.applyDiff(diff, 'after');
    expect(p.weightOf(v5, 1)).toBeCloseTo(0.8, 5);
    // Subtracting everything from a vertex fully owned by the root: the weight goes to a neighbour's bone.
    const v0 = p.weld[0];
    p.dab({ x: 0, y: 0, z: 0 }, { mode: 'subtract', radius: 0.02, strength: 1, falloff: 'constant', bone: 0 });
    expect(p.weightOf(v0, 0)).toBe(0);
    expect(p.weightOf(v0, 1)).toBeCloseTo(1, 5);
    // Replace towards 0.25.
    p.dab({ x: 1, y: 0, z: 0 }, { mode: 'replace', value: 0.25, radius: 0.02, strength: 1, falloff: 'constant', bone: 1 });
    expect(p.weightOf(p.weld[20], 1)).toBeCloseTo(0.25, 5);
    // Smooth pulls a spike towards its neighbours.
    const q = strip();
    q.setWeight(q.weld[10], 1, 1);
    const before = q.weightOf(q.weld[10], 1);
    q.dab({ x: 0.5, y: 0, z: 0 }, { mode: 'smooth', radius: 0.01, strength: 1, falloff: 'constant', bone: 1 });
    expect(q.weightOf(q.weld[10], 1)).toBeLessThan(before);
    w = q.weights();
    sums(w);
  });

  it('mirrors weights across a plane with the bones swapped; normalises', () => {
    // Left / right halves around x = 0.5; bone 0 ↔ bone 1.
    const p = strip();
    const n = p.mirror({ x: 0.5, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, (b) => 1 - b, true, 0.02);
    expect(n).toBeGreaterThan(0);
    // Vertex at x = 0.2 takes x = 0.8's weights (0.2 / 0.8) with bones swapped → bone 0: 0.8.
    expect(p.weightOf(p.weld[4], 0)).toBeCloseTo(0.8, 5);
    p.w[0] = 3;
    expect(p.normalizeAll()).toBeGreaterThan(0);
    sums(p.weights());
  });
});

describe('two-bone IK', () => {
  it('reaches a target in range keeping the segment lengths, bending towards the pole', () => {
    const a = new Vector3(0, 1, 0), b = new Vector3(0, 0.5, 0), c = new Vector3(0, 0, 0);
    const target = new Vector3(0.3, 0.3, 0), pole = new Vector3(0, 0.5, 1);
    const s = twoBoneIK(a, b, c, target, pole);
    expect(s.reached).toBe(true);
    expect(s.c.distanceTo(target)).toBeLessThan(1e-9);
    expect(s.b.distanceTo(a)).toBeCloseTo(0.5, 9);
    expect(s.b.distanceTo(s.c)).toBeCloseTo(0.5, 9);
    expect(s.b.z).toBeGreaterThan(0);
    // Out of reach: straight towards the target.
    const far = twoBoneIK(a, b, c, new Vector3(0, -2, 0), pole);
    expect(far.reached).toBe(false);
    expect(far.c.distanceTo(new Vector3(0, 0, 0))).toBeLessThan(1e-5);
  });

  it('rotations applied to a bone chain put the end on the target', () => {
    const upper = new Bone(), lower = new Bone(), end = new Bone();
    upper.position.set(0, 1, 0);
    lower.position.set(0, -0.5, 0);
    end.position.set(0, -0.5, 0);
    upper.add(lower);
    lower.add(end);
    upper.updateMatrixWorld(true);
    const w = (o: Bone) => o.getWorldPosition(new Vector3());
    const target = new Vector3(0.4, 0.4, 0.1);
    const r = twoBoneIKRotations(w(upper), w(lower), w(end), target, new Vector3(0, 0.5, 1));
    const W1 = upper.getWorldQuaternion(new Quaternion()), W2 = lower.getWorldQuaternion(new Quaternion());
    upper.quaternion.copy(applyWorldDelta(new Quaternion(), upper.quaternion, r.upper));
    const W1n = r.upper.clone().multiply(W1);
    lower.quaternion.copy(W1n.clone().invert().multiply(r.lower.clone().multiply(W2)));
    upper.updateMatrixWorld(true);
    expect(w(end).distanceTo(target)).toBeLessThan(1e-6);
  });
});

describe('keyframe authoring', () => {
  const qz = (deg: number): [number, number, number, number] => new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (deg * Math.PI) / 180).toArray() as [number, number, number, number];

  it('sets / moves / deletes keys, samples linear / step / smooth, bakes a looping clip', () => {
    let d = newClipDoc('Wave', 1, 10, true);
    d = setRotKey(d, 'LeftArm', 0, qz(0), 'linear');
    d = setRotKey(d, 'LeftArm', 0.5, qz(90), 'linear');
    d = setPosKey(d, 'Hips', 0.5, [0, 0.1, 0]);
    expect(keyTimes(d)).toEqual([0, 0.5]);
    const angle = (t: number) => (2 * Math.acos(Math.min(1, Math.abs(samplePose(d, t).rot.get('LeftArm')!.w))) * 180) / Math.PI;
    expect(angle(0.25)).toBeCloseTo(45, 4);
    // Loop: 0.5 → 1.0 goes back to the first key across the seam.
    expect(angle(0.75)).toBeCloseTo(45, 4);
    d = setInterp(d, 0, 'step', 'LeftArm');
    expect(angle(0.25)).toBeCloseTo(0, 4);
    d = setInterp(d, 0, 'smooth');
    expect(angle(0.25)).toBeGreaterThan(20);
    d = moveKeys(d, 0.5, 0.63, 'LeftArm'); // snaps to the 10 fps grid
    expect(keyTimes(d, 'LeftArm')).toEqual([0, 0.6]);
    const clip = toAnimationClip(d);
    expect(clip.info.source).toBe('custom');
    expect(clip.info.id).toBe('custom-wave');
    const arm = clip.clip.tracks.find((t) => t.name === 'LeftArm.quaternion')!;
    expect(arm.times.length).toBe(11);
    for (let c = 0; c < 4; c++) expect(arm.values[c]).toBeCloseTo(arm.values[40 + c], 6); // seamless
    expect(clip.clip.tracks.some((t) => t.name === 'Hips.position')).toBe(true);
    // The clip drives bones by name.
    const bone = new Bone();
    bone.name = 'LeftArm';
    const mixer = new AnimationMixer(bone);
    mixer.clipAction(clip.clip).play();
    mixer.setTime(0.6);
    expect(Math.abs(bone.quaternion.z)).toBeGreaterThan(0.6);
    // Bone renames carry the tracks along.
    expect(Object.keys(renameDocBones(d, { LeftArm: 'ArmL' }).rot)).toEqual(['ArmL']);
    d = deleteKeys(d, 0.6);
    expect(keyTimes(d)).toEqual([0, 0.5]);
    d = setDocProps(d, { duration: 0.3 });
    expect(keyTimes(d)).toEqual([0]);
  });

  it('mirrors a pose: left rotations go to the right bone reflected across the symmetry plane', () => {
    const spec = humanSpec();
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -1).toArray() as [number, number, number, number];
    const m = mirrorPose({ rot: { LeftArm: q }, pos: {} }, spec);
    expect(Object.keys(m.rot)).toEqual(['RightArm']);
    // Lowering the left arm (about -Z) mirrors to lowering the right arm (about +Z).
    expect(m.rot.RightArm[2]).toBeCloseTo(-q[2], 9);
    expect(mirrorQuat([0.1, 0.2, 0.3, 0.9], new Vector3(1, 0, 0))).toEqual([0.1, -0.2, -0.3, 0.9]);
  });
});
