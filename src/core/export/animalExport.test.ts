/**
 * GLB export of non-humanoid rigs: a quadruped skeleton (auto-placed on the
 * procedural dog), its procedural clips and a custom keyframed clip.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BufferAttribute, Quaternion, Vector3 } from 'three';
import type { SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildGeometryModel } from '../../app/pipeline';
import { buildAnimalLibrary } from '../../rig/animals';
import { autoPlaceAnimal } from '../../rig/autoAnimal';
import { newClipDoc, setRotKey, toAnimationClip } from '../../rig/editor/keyframes';
import { addBone } from '../../rig/editor/ops';
import { collectMeshData } from '../../rig/meshData';
import { rigModel } from '../../rig/rig';
import { makeDog } from '../../rig/testing';
import { exportObject } from './exporters';

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

async function glb(blob: Blob) {
  const buf = await blob.arrayBuffer();
  const view = new DataView(buf);
  const len = view.getUint32(12, true);
  return { buf, json: JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len))) };
}

describe('GLB export of a quadruped rig', () => {
  it('writes the animal skeleton (with an editor-added bone), its clips and a custom clip; no editor attributes', async () => {
    const model = buildGeometryModel(makeDog().mesh.geometry, null);
    const data = collectMeshData(model.object);
    const { spec } = autoPlaceAnimal(data, 'quadruped');
    const rig = await rigModel(null, model, { spec, meshData: data });
    // A bone added in the editor (a structural edit keeps the weights by name).
    const added = addBone(rig.spec, 'Head', { name: 'Horn' });
    expect(await rig.setSpec(added.spec)).toBe(true);
    expect(rig.bones.has('Horn')).toBe(true);
    const n = rig.spec.bones.length;
    const lib = buildAnimalLibrary(rig.generic).filter((c) => ['quad-walk', 'quad-tail-wag'].includes(c.info.id));
    let doc = newClipDoc('Head Tilt', 1, 10, true);
    doc = setRotKey(doc, 'Head', 0, [0, 0, 0, 1]);
    doc = setRotKey(doc, 'Head', 0.5, new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.5).toArray() as [number, number, number, number]);
    const custom = toAnimationClip(doc);
    // A leftover heat-map attribute must not be exported.
    const sk = rig.meshes[0] as SkinnedMesh;
    sk.geometry.setAttribute('rigHeat', new BufferAttribute(new Float32Array(sk.geometry.getAttribute('position').count * 3), 3));
    const { buf, json } = await glb(await exportObject(model.object, 'glb', { animations: [...lib.map((c) => c.clip), custom.clip] }));
    expect(json.skins).toHaveLength(1);
    const joints: number[] = json.skins[0].joints;
    expect(joints).toHaveLength(n);
    const jointNames = joints.map((j) => json.nodes[j].name);
    expect(jointNames[0]).toBe('Hips');
    for (const b of ['LeftFrontFoot', 'RightHindToe', 'Tail', 'Jaw', 'LeftEar', 'Horn']) expect(jointNames).toContain(b);
    expect(json.animations.map((a: { name: string }) => a.name)).toEqual(['quad-walk', 'quad-tail-wag', 'Head Tilt']);
    for (const a of json.animations) for (const ch of a.channels) expect(joints).toContain(ch.target.node);
    expect(JSON.stringify(json.meshes)).not.toMatch(/RIGHEAT/i);
    const gltf = await new GLTFLoader().parseAsync(buf, '');
    const skinned: SkinnedMesh[] = [];
    gltf.scene.traverse((o) => (o as SkinnedMesh).isSkinnedMesh && skinned.push(o as SkinnedMesh));
    expect(skinned).toHaveLength(1);
    expect(skinned[0].skeleton.bones).toHaveLength(n);
    expect(gltf.animations).toHaveLength(3);
    // The live mesh still has its editor attribute (only the export dropped it).
    expect(sk.geometry.getAttribute('rigHeat')).toBeTruthy();
    rig.unrig();
  }, 60_000);
});
