/**
 * RigHandle with generic skeletons: rigging from a SkeletonSpec, editor
 * changes through setSpec (rest moves, structural edits, re-weighting all /
 * some bones, superseding), setWeights, and the humanoid view surviving
 * extra bones but not a broken hierarchy.
 */
import { describe, expect, it } from 'vitest';
import type { BufferAttribute, Object3D } from 'three';
import { buildGeometryModel } from '../app/pipeline';
import { buildLibrary } from './animations';
import { autoPlaceAnimal } from './autoAnimal';
import { addBone, deleteBone, moveJoint, renameBone } from './editor/ops';
import { collectMeshData } from './meshData';
import { mergeBoneWeights, rigModel, type RigViewer } from './rig';
import { makeDog, makeMannequin } from './testing';

function core(): RigViewer & { overlays: Set<Object3D> } {
  const overlays = new Set<Object3D>();
  return { overlays, addOverlay: (o) => void overlays.add(o), removeOverlay: (o) => void overlays.delete(o), invalidate: () => {}, refresh: () => {} };
}

async function dogRig(c: RigViewer | null = null) {
  const model = buildGeometryModel(makeDog().mesh.geometry, null);
  const data = collectMeshData(model.object);
  const { spec } = autoPlaceAnimal(data, 'quadruped');
  return { model, rig: await rigModel(c, model, { spec, meshData: data }) };
}

const weightOf = (w: { skinIndex: Uint16Array; skinWeight: Float32Array }, v: number, bone: number) => {
  let s = 0;
  for (let k = 0; k < 4; k++) if (w.skinIndex[v * 4 + k] === bone) s += w.skinWeight[v * 4 + k];
  return s;
};

describe('rigModel with a SkeletonSpec', () => {
  it('binds an animal skeleton: bones, template, generic descriptor; no humanoid view', async () => {
    const { rig } = await dogRig();
    expect(rig.template).toBe('quadruped');
    expect(rig.isHumanoid).toBe(false);
    expect(rig.layout).toEqual({});
    expect(() => rig.descriptor).toThrow();
    expect(rig.bones.size).toBe(rig.spec.bones.length);
    expect(rig.generic.contact!.positions.length).toBeGreaterThan(0);
    expect(rig.weights.skinIndex.length).toBe(rig.surface.positions.length / 3 * 4);
    rig.dispose();
  });

  it('rest moves re-bind in place; structural edits rebuild the bones and carry the weights; the helper follows', async () => {
    const c = core();
    const { rig } = await dogRig(c);
    rig.setSkeletonVisible(true);
    const oldBone = rig.bones.get('Head')!;
    const oldHelper = rig.helper;
    const v0 = rig.version;
    const head = rig.spec.bones.find((b) => b.name === 'Head')!;
    const moved = moveJoint(rig.spec, 'Head', 'head', { ...head.head, y: head.head.y + 0.05 });
    expect(await rig.setSpec(moved.spec)).toBe(true);
    expect(rig.bones.get('Head')).toBe(oldBone); // same topology: same bone objects
    expect(rig.version).toBe(v0 + 1);
    const before = rig.weights;
    const earIdx = rig.spec.bones.findIndex((b) => b.name === 'LeftEar');
    const renamed = renameBone(rig.spec, 'LeftEar', 'EarLeft');
    expect(await rig.setSpec(renamed.spec, { renamed: renamed.renamed })).toBe(true);
    expect(rig.bones.has('EarLeft')).toBe(true);
    expect(rig.bones.get('Head')).not.toBe(oldBone);
    expect(rig.helper).not.toBe(oldHelper);
    expect(c.overlays.has(rig.helper)).toBe(true);
    expect(c.overlays.has(oldHelper)).toBe(false);
    const newEar = rig.spec.bones.findIndex((b) => b.name === 'EarLeft');
    let same = 0;
    for (let v = 0; v < rig.weights.skinIndex.length / 4; v += 13) if (Math.abs(weightOf(before, v, earIdx) - weightOf(rig.weights, v, newEar)) < 1e-6) same++;
    expect(same).toBe(Math.ceil(rig.weights.skinIndex.length / 4 / 13));
    // Deleting a bone gives its vertices to the parent.
    const del = deleteBone(rig.spec, 'EarLeft');
    expect(await rig.setSpec(del.spec)).toBe(true);
    const headIdx = rig.spec.bones.findIndex((b) => b.name === 'Head');
    expect(rig.weights.skinIndex.every((b) => b < rig.spec.bones.length)).toBe(true);
    let toHead = 0;
    for (let v = 0; v < before.skinIndex.length / 4; v++) if (weightOf(before, v, earIdx) > 0.9 && weightOf(rig.weights, v, headIdx) > 0.9) toHead++;
    expect(toHead).toBeGreaterThan(0);
    // The skinned mesh attribute follows.
    const attr = rig.meshes[0].geometry.getAttribute('skinIndex') as BufferAttribute;
    expect(Array.from((attr.array as Uint16Array).subarray(0, 8))).toEqual(Array.from(rig.weights.skinIndex.subarray(0, 8)));
    rig.unrig();
  }, 60_000);

  it('re-weights all bones or only the selected ones, and a newer change supersedes', async () => {
    const { rig } = await dogRig();
    const added = addBone(rig.spec, 'Head', { name: 'Horn', head: rig.spec.bones.find((b) => b.name === 'Head')!.head });
    await rig.setSpec(added.spec);
    const horn = rig.spec.bones.findIndex((b) => b.name === 'Horn');
    const hornWeight = () => {
      let s = 0;
      for (let v = 0; v < rig.weights.skinIndex.length / 4; v++) s += weightOf(rig.weights, v, horn);
      return s;
    };
    expect(hornWeight()).toBe(0); // added without re-weighting
    const tailIdx = rig.spec.bones.findIndex((b) => b.name === 'Tail');
    const tailBefore = rig.weights.skinWeight.slice();
    expect(await rig.setSpec(rig.spec, { reweigh: ['Horn'] })).toBe(true);
    expect(hornWeight()).toBeGreaterThan(0);
    // Vertices far from the horn (the tail) keep their weights.
    let tailSame = true;
    for (let v = 0; v < rig.weights.skinIndex.length / 4; v++) if (weightOf(rig.weights, v, tailIdx) > 0.99 && Math.abs(tailBefore[v * 4] - rig.weights.skinWeight[v * 4]) > 1e-6) tailSame = false;
    expect(tailSame).toBe(true);
    const a = rig.setSpec(rig.spec, { reweigh: 'all' });
    const b = rig.setSpec(rig.spec, { reweigh: 'all' });
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    // setWeights applies painted weights directly.
    const w = { skinIndex: rig.weights.skinIndex.slice(), skinWeight: rig.weights.skinWeight.slice() };
    w.skinIndex[0] = horn;
    w.skinWeight.set([1, 0, 0, 0], 0);
    const v = rig.version;
    rig.setWeights(w);
    expect(rig.version).toBe(v + 1);
    expect((rig.meshes[0].geometry.getAttribute('skinIndex') as BufferAttribute).array[0]).toBe(horn);
    rig.dispose();
  }, 60_000);

  it('a humanoid keeps its humanoid view with extra bones (clips still build), loses it with a broken hierarchy', async () => {
    const model = buildGeometryModel(makeMannequin().mesh.geometry, null);
    const rig = await rigModel(null, model);
    expect(rig.isHumanoid).toBe(true);
    const tail = addBone(rig.spec, 'Hips', { name: 'Tail', head: rig.layout.Hips!, tail: { ...rig.layout.Hips!, z: rig.layout.Hips!.z - 0.3 } });
    await rig.setSpec(tail.spec, { reweigh: 'all' });
    expect(rig.isHumanoid).toBe(true);
    expect(rig.template).toBe('humanoid');
    const d = rig.descriptor;
    expect(d.bones).not.toContain('Tail');
    expect(d.contact!.skinIndex.every((i) => i < d.bones.length)).toBe(true);
    const walk = buildLibrary(d).find((c) => c.info.id === 'walk')!;
    for (const t of walk.clip.tracks) for (const x of t.values) expect(Number.isFinite(x)).toBe(true);
    // setJoints still works and keeps the extra bone.
    await rig.setJoint('LeftForeArm', { ...rig.layout.LeftForeArm!, y: rig.layout.LeftForeArm!.y + 0.02 });
    expect(rig.bones.has('Tail')).toBe(true);
    await rig.setSpec(deleteBone(rig.spec, 'Spine1').spec);
    expect(rig.isHumanoid).toBe(false);
    expect(rig.template).toBe('custom');
    rig.unrig();
  }, 60_000);

  it('mergeBoneWeights: the selected bones take their automatic weights, the rest share the remainder', () => {
    const cur = { skinIndex: new Uint16Array([0, 1, 0, 0]), skinWeight: new Float32Array([0.5, 0.5, 0, 0]) };
    const auto = { skinIndex: new Uint16Array([2, 0, 0, 0]), skinWeight: new Float32Array([0.6, 0.4, 0, 0]) };
    const out = mergeBoneWeights(cur, auto, new Set([2]));
    expect(weightOf(out, 0, 2)).toBeCloseTo(0.6, 6);
    expect(weightOf(out, 0, 0)).toBeCloseTo(0.2, 6);
    expect(weightOf(out, 0, 1)).toBeCloseTo(0.2, 6);
  });
});
