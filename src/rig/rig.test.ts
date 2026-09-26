import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Box3, Group, Mesh, Vector3 } from 'three';
import type { BufferGeometry, Object3D, SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { buildGeometryModel, type BuiltModel } from '../app/pipeline';
import { LocalizedError } from '../core/errors';
import { exportObject } from '../core/export/exporters';
import { buildLibrary } from './animations';
import { autoPlaceJoints } from './autoJoints';
import { isRigPlaceholder } from './meshData';
import { hasSkinnedMeshes, rigModel, type RigViewer } from './rig';
import { makeMannequin } from './testing';

// GLTFExporter reads its Blob parts back with FileReader, which Node lacks.
beforeAll(() => {
  if (typeof globalThis.FileReader !== 'undefined') return;
  class NodeFileReader {
    result: ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob) {
      void blob.arrayBuffer().then((b) => {
        this.result = b;
        this.onloadend?.();
      });
    }
  }
  (globalThis as unknown as { FileReader: unknown }).FileReader = NodeFileReader;
});

function fakeCore(model: () => BuiltModel) {
  const overlays = new Set<Object3D>();
  const core: RigViewer & { overlays: Set<Object3D>; rescans: number } = {
    overlays,
    rescans: 0,
    addOverlay: (o) => void overlays.add(o),
    removeOverlay: (o) => void overlays.delete(o),
    invalidate: () => {},
    refresh: () => {},
    rescanObject() {
      core.rescans++;
    },
    getExportObject: () => model().object.clone(true),
  };
  return core;
}

function meshModel(detail = 1): BuiltModel {
  const { mesh } = makeMannequin(detail);
  const model = buildGeometryModel(mesh.geometry, null);
  model.remesh = () => model.stats; // pretend it is re-meshable
  return model;
}

function groupModel(): { model: BuiltModel; inner: Mesh } {
  const { mesh } = makeMannequin(1);
  const root = new Group();
  root.name = 'model';
  const inner = new Group();
  inner.position.set(0.2, 0, 0);
  const other = new Group();
  inner.add(other, mesh);
  root.add(inner);
  root.scale.setScalar(1.3);
  return { model: { kind: 'model', object: root, stats: { vertices: 0, triangles: 0, watertight: true }, depth: null, mask: null, meshKey: null, remesh: null }, inner: mesh };
}

const skinnedOf = (root: Object3D) => {
  const out: SkinnedMesh[] = [];
  root.traverse((o) => {
    if ((o as SkinnedMesh).isSkinnedMesh) out.push(o as SkinnedMesh);
  });
  return out;
};

describe('rigModel (model.object is the mesh: depth / geometry models)', () => {
  it('keeps the root in place with a placeholder, skins a child copy, and unrig restores it', async () => {
    const model = meshModel();
    const root = model.object as Mesh;
    const geometry = root.geometry;
    const material = root.material;
    const remesh = model.remesh;
    const core = fakeCore(() => model);
    const progress = vi.fn();
    const rig = await rigModel(core, model, { onProgress: progress });

    expect(model.object).toBe(root);
    expect(isRigPlaceholder(root)).toBe(true);
    expect((root.geometry as BufferGeometry).getAttribute('position').count).toBe(0);
    expect(root.children[0].name).toBe('Hips');
    const [sk] = skinnedOf(root);
    expect(sk).toBeTruthy();
    expect(sk.geometry).not.toBe(geometry);
    expect(sk.material).toBe(material);
    expect(sk.geometry.getAttribute('skinIndex').count).toBe(geometry.getAttribute('position').count);
    expect(sk.skeleton).toBe(rig.skeleton);
    expect(model.remesh).toBe(null);
    expect(core.rescans).toBe(1);
    expect(progress).toHaveBeenCalled();
    expect(rig.bones.size).toBe(23);
    expect(hasSkinnedMeshes(root)).toBe(false); // our own skins do not count as "already rigged"

    rig.setSkeletonVisible(true);
    expect(core.overlays.has(rig.helper)).toBe(true);

    rig.unrig();
    expect(root.geometry).toBe(geometry);
    expect(root.material).toBe(material);
    expect(root.children).toHaveLength(0);
    expect(isRigPlaceholder(root)).toBe(false);
    expect(model.remesh).toBe(remesh);
    expect(core.overlays.size).toBe(0);
    expect(core.rescans).toBe(2);
    expect(rig.disposed).toBe(true);
  });

  it('bones deform the skin: raising the left arm moves arm vertices only', async () => {
    const model = meshModel();
    const rig = await rigModel(null, model);
    const [sk] = skinnedOf(model.object);
    const pos = sk.geometry.getAttribute('position');
    const v = new Vector3();
    const arm: number[] = [], torso: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (v.x > 0.5 && v.y > 0.55) arm.push(i);
      else if (Math.abs(v.x) < 0.08 && v.y < 0.4 && v.y > 0.1) torso.push(i);
    }
    rig.bones.get('LeftArm')!.rotation.z = Math.PI / 3;
    model.object.updateMatrixWorld(true);
    const moved = (i: number) => sk.getVertexPosition(i, new Vector3()).distanceTo(v.fromBufferAttribute(pos, i));
    expect(arm.every((i) => moved(i) > 0.1)).toBe(true);
    expect(torso.every((i) => moved(i) < 1e-4)).toBe(true);
    rig.restPose();
    expect(arm.every((i) => moved(i) < 1e-4)).toBe(true);
    rig.unrig();
  });

  it('refuses skinned models and models without surfaces', async () => {
    const model = meshModel();
    const rig = await rigModel(null, model);
    const copy: BuiltModel = { ...model, object: model.object.clone(true) };
    copy.object.traverse((o) => {
      if ((o as SkinnedMesh).isSkinnedMesh) o.userData = {};
    });
    await expect(rigModel(null, copy)).rejects.toBeInstanceOf(LocalizedError);
    rig.unrig();
    const empty: BuiltModel = { ...model, object: new Group() };
    await expect(rigModel(null, empty)).rejects.toBeInstanceOf(LocalizedError);
  });

  it('setJoint re-binds and re-weights in place', async () => {
    const model = meshModel();
    const rig = await rigModel(null, model);
    const [sk] = skinnedOf(model.object);
    const weights = Float32Array.from(sk.geometry.getAttribute('skinWeight').array as Float32Array);
    const elbow = rig.layout.LeftForeArm!;
    await rig.setJoint('LeftForeArm', { x: elbow.x - 0.15, y: elbow.y, z: elbow.z });
    expect(rig.layout.LeftForeArm!.x).toBeCloseTo(elbow.x - 0.15, 9);
    const fore = rig.bones.get('LeftForeArm')!;
    expect(new Vector3().setFromMatrixPosition(fore.matrixWorld).x).toBeCloseTo(elbow.x - 0.15, 6);
    const now = sk.geometry.getAttribute('skinWeight').array as Float32Array;
    expect(now.some((w, i) => Math.abs(w - weights[i]) > 1e-3)).toBe(true);
    // Still the bind pose: vertices where they were.
    const p = new Vector3();
    for (let i = 0; i < 200; i++) expect(sk.getVertexPosition(i, p).distanceTo(new Vector3().fromBufferAttribute(sk.geometry.getAttribute('position'), i))).toBeLessThan(1e-4);
    rig.unrig();
  });
});

describe('rigModel (GLB-like group root)', () => {
  it('swaps nested meshes at the same index and restores the same objects', async () => {
    const { model, inner } = groupModel();
    const parent = inner.parent!;
    const index = parent.children.indexOf(inner);
    const rig = await rigModel(null, model, { layout: autoPlaceJoints(model.object) });
    const swapped = parent.children[index] as SkinnedMesh;
    expect(swapped.isSkinnedMesh).toBe(true);
    expect(swapped.name).toBe(inner.name);
    expect(inner.parent).toBe(null);
    expect(model.object.children[0].name).toBe('Hips');
    // The skin follows the bones in world space despite the scaled / offset parents.
    const before = new Box3().setFromObject(model.object);
    rig.bones.get('Hips')!.position.y += 0.5;
    model.object.updateMatrixWorld(true);
    swapped.computeBoundingBox();
    const after = new Box3().setFromObject(model.object, true);
    expect(after.max.y - before.max.y).toBeCloseTo(0.5 * 1.3, 2);
    rig.unrig();
    expect(parent.children[index]).toBe(inner);
    expect(model.object.children.some((c) => c.name === 'Hips')).toBe(false);
  });

  it('dispose() frees what the rig holds when the model was discarded', async () => {
    const { model, inner } = groupModel();
    const spy = vi.fn();
    inner.geometry.addEventListener('dispose', spy);
    const rig = await rigModel(null, model);
    rig.dispose();
    expect(spy).toHaveBeenCalled();
    expect(rig.disposed).toBe(true);
  });
});

describe('export of rigged models', () => {
  async function glbJson(blob: Blob) {
    const buf = await blob.arrayBuffer();
    const view = new DataView(buf);
    expect(view.getUint32(0, true)).toBe(0x46546c67);
    const len = view.getUint32(12, true);
    expect(view.getUint32(16, true)).toBe(0x4e4f534a); // JSON chunk
    return { buf, json: JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len))) };
  }

  it('GLB: skin, joints, bind pose and animations (also from a viewer-style clone)', async () => {
    const model = meshModel();
    const rig = await rigModel(null, model);
    const clips = buildLibrary(rig.descriptor).filter((c) => ['walk', 'wave-right', 'jump'].includes(c.info.id)).map((c) => c.clip);
    // Pose the live skeleton: the export must still carry the bind pose.
    rig.bones.get('LeftArm')!.rotation.z = 1;
    model.object.updateMatrixWorld(true);
    for (const obj of [model.object, model.object.clone(true)]) {
      const { buf, json } = await glbJson(await exportObject(obj, 'glb', { animations: clips }));
      expect(json.skins).toHaveLength(1);
      const joints: number[] = json.skins[0].joints;
      expect(joints).toHaveLength(23);
      expect(joints.every((j) => typeof j === 'number' && json.nodes[j])).toBe(true);
      expect(json.nodes[joints[0]].name).toBe('Hips');
      expect(json.animations.map((a: { name: string }) => a.name)).toEqual(['walk', 'wave-right', 'jump']);
      for (const a of json.animations) {
        expect(a.channels.length).toBeGreaterThan(3);
        for (const ch of a.channels) expect(joints).toContain(ch.target.node);
      }
      // Animated nodes carry TRS (glTF forbids matrices on them); the bind pose is the rest.
      const leftArm = json.nodes.find((n: { name?: string }) => n.name === 'LeftArm');
      expect(leftArm.matrix).toBeUndefined();
      expect(leftArm.rotation ?? [0, 0, 0, 1]).toEqual([0, 0, 0, 1]);
      // No empty placeholder mesh.
      expect(json.meshes).toHaveLength(1);
      const gltf = await new GLTFLoader().parseAsync(buf, '');
      expect(gltf.animations).toHaveLength(3);
      expect(skinnedOf(gltf.scene)).toHaveLength(1);
      expect(skinnedOf(gltf.scene)[0].skeleton.bones).toHaveLength(23);
    }
    // The live skeleton is untouched by the export.
    expect(rig.bones.get('LeftArm')!.rotation.z).toBeCloseTo(1, 9);
    rig.unrig();
  });

  it('STL / OBJ: current pose by default, bind pose on request', async () => {
    const model = meshModel();
    const rig = await rigModel(null, model);
    const width = async (opts: Parameters<typeof exportObject>[2]) => {
      const g = new STLLoader().parse(await (await exportObject(model.object, 'stl', opts)).arrayBuffer());
      g.computeBoundingBox();
      return g.boundingBox!.max.x - g.boundingBox!.min.x;
    };
    const rest = await width({});
    rig.bones.get('LeftArm')!.rotation.z = -1.2; // arm down
    rig.bones.get('RightArm')!.rotation.z = 1.2;
    model.object.updateMatrixWorld(true);
    const posed = await width({});
    expect(posed).toBeLessThan(rest - 0.5);
    expect(await width({ pose: 'rest' })).toBeCloseTo(rest, 4);
    const obj = await (await exportObject(model.object, 'obj')).text();
    expect(obj.split('\n').filter((l) => l.startsWith('v ')).length).toBe((skinnedOf(model.object)[0].geometry.getAttribute('position')).count);
    rig.unrig();
  });
});
