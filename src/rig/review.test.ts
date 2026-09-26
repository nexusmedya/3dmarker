/**
 * Review checks for rigging / animation: deep GLB validation (skin, IBMs,
 * samplers) with a posed round trip, and known defects pinned with
 * `it.fails` (they start failing — i.e. passing their assertion — once fixed;
 * then drop the `.fails`).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { AnimationMixer, BoxGeometry, BufferGeometry, CapsuleGeometry, Mesh, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three';
import type { AnimationClip, Object3D, SkinnedMesh } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildGeometryModel } from '../app/pipeline';
import { exportObject } from '../core/export/exporters';
import { buildLibrary } from './animations';
import { autoPlaceJoints, autoPlaceJointsDetailed } from './autoJoints';
import { collectMeshData } from './meshData';
import { AnimationPlayer } from './player';
import { rigModel } from './rig';
import { boneSegments, buildSkeleton, describeRig } from './skeleton';
import { computeSkinWeights, prepareSkinning } from './skinning';
import { makeMannequin } from './testing';
import type { JointLayout } from './types';

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

const skinnedOf = (root: Object3D) => {
  const out: SkinnedMesh[] = [];
  root.traverse((o) => {
    if ((o as SkinnedMesh).isSkinnedMesh) out.push(o as SkinnedMesh);
  });
  return out;
};

describe('animated GLB export (structure + posed round trip)', () => {
  it('IBMs / joints / samplers are consistent and the loaded GLB deforms exactly like the live rig (scale 2, moved model)', async () => {
    const model = buildGeometryModel(makeMannequin(1).mesh.geometry, null);
    model.object.position.set(0.3, 0.2, -0.1);
    model.object.rotation.y = 0.4;
    const rig = await rigModel(null, model);
    const clips = buildLibrary(rig.descriptor).filter((c) => ['walk', 'jump', 'spin'].includes(c.info.id)).map((c) => c.clip);
    const buf = await (await exportObject(model.object, 'glb', { animations: clips, scale: 2 })).arrayBuffer();
    const len = new DataView(buf).getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len)));

    const skin = json.skins[0];
    const ibm = json.accessors[skin.inverseBindMatrices];
    expect(ibm.type).toBe('MAT4');
    expect(ibm.count).toBe(skin.joints.length);
    expect(new Set(skin.joints).size).toBe(skin.joints.length);
    const prim = json.meshes[0].primitives[0];
    expect(json.accessors[prim.attributes.JOINTS_0].count).toBe(json.accessors[prim.attributes.POSITION].count);
    expect(json.accessors[prim.attributes.WEIGHTS_0].count).toBe(json.accessors[prim.attributes.POSITION].count);
    for (const a of json.animations) {
      const clip = clips.find((c) => c.name === a.name)!;
      expect(a.channels.length).toBe(a.samplers.length);
      expect(a.channels.length).toBe(clip.tracks.length);
      const targets = a.channels.map((c: { target: { node: number; path: string } }) => `${c.target.node}.${c.target.path}`);
      expect(new Set(targets).size).toBe(targets.length);
      for (const s of a.samplers) {
        const input = json.accessors[s.input], output = json.accessors[s.output];
        expect(input.count).toBe(output.count);
        expect(input.max[0]).toBeCloseTo(clip.duration, 4);
      }
    }

    const gltf = await new GLTFLoader().parseAsync(buf, '');
    const [a] = skinnedOf(model.object), [b] = skinnedOf(gltf.scene);
    for (const name of ['walk', 'jump', 'spin']) {
      const m1 = new AnimationMixer(model.object), m2 = new AnimationMixer(gltf.scene);
      const c1 = clips.find((c) => c.name === name)!, c2 = gltf.animations.find((c) => c.name === name)!;
      m1.clipAction(c1).play();
      m2.clipAction(c2).play();
      for (const u of [0.1, 0.37, 0.61]) {
        m1.setTime(u * c1.duration);
        m2.setTime(u * c1.duration);
        model.object.updateMatrixWorld(true);
        gltf.scene.updateMatrixWorld(true);
        const p = new Vector3(), q = new Vector3();
        for (let i = 0; i < a.geometry.getAttribute('position').count; i += 41) {
          a.getVertexPosition(i, p).applyMatrix4(a.matrixWorld).multiplyScalar(2);
          b.getVertexPosition(i, q).applyMatrix4(b.matrixWorld);
          expect(p.distanceTo(q)).toBeLessThan(1e-4);
        }
      }
      m1.stopAllAction();
      m2.stopAllAction();
    }
    rig.unrig();
  });
});

describe('known defects', () => {
  it('player: a one-shot finishing while it fades out must not stop the clip that replaced it', async () => {
    const model = buildGeometryModel(makeMannequin(1).mesh.geometry, null);
    const rig = await rigModel(null, model);
    const lib = buildLibrary(rig.descriptor);
    const jump = lib.find((c) => c.info.id === 'jump')!.clip; // 1.2 s
    const wave = lib.find((c) => c.info.id === 'wave-right')!.clip;
    const player = new AnimationPlayer(null, model.object);
    player.play(jump, { loop: false });
    for (let i = 0; i < 30; i++) player.tick(1 / 30); // t = 1.0 s
    player.play(wave, { loop: false, crossFade: 0.3 });
    for (let i = 0; i < 9; i++) player.tick(1 / 30); // the jump ends at 1.2 s, mid-fade
    expect(player.isPlaying).toBe(true); // the jump's 'finished' event must not stop the wave
    const t = player.time;
    player.tick(1 / 30);
    expect(player.time).toBeGreaterThan(t);
    rig.unrig();
  });

  /** Mannequin with both arms hanging `deg` below horizontal (A-pose / relaxed). */
  function armsDownMannequin(deg: number): Mesh {
    const parts: BufferGeometry[] = [];
    const capsule = (r: number, len: number, x: number, y: number, rotZ = 0, scaleZ = 1) => {
      const g = new CapsuleGeometry(r, len, 6, 16, Math.round(len * 10));
      g.scale(1, 1, scaleZ);
      g.rotateZ(rotZ);
      g.translate(x, y, 0);
      parts.push(g);
    };
    const head = new SphereGeometry(0.12, 24, 16);
    head.translate(0, 0.88, 0);
    parts.push(head);
    capsule(0.05, 0.12, 0, 0.72);
    capsule(0.16, 0.5, 0, 0.36, 0, 0.65);
    const a = (deg * Math.PI) / 180, half = 0.4;
    for (const s of [1, -1]) capsule(0.045, 0.72, s * (0.16 + half * Math.cos(a)), 0.62 - half * Math.sin(a), s * (Math.PI / 2 - a));
    capsule(0.065, 0.9, 0.1, -0.47);
    capsule(0.065, 0.9, -0.1, -0.47);
    for (const x of [0.1, -0.1]) {
      const foot = new BoxGeometry(0.1, 0.05, 0.2, 2, 1, 4);
      foot.translate(x, -0.975, 0.06);
      parts.push(foot);
    }
    return new Mesh(mergeGeometries(parts, false)!, new MeshStandardMaterial());
  }

  it.each([
    [45, 'arms-down'],
    [60, 'arms-down'],
    [70, 'arms-down'],
    [88, 'proportional'], // arms touching the torso: the fallback hangs them too
  ] as const)('no pose landmarks, arms hanging %i° (relaxed / A-pose mesh): arm skin binds to the arm bones', async (deg, expectedMethod) => {
    const a = (deg * Math.PI) / 180;
    const mesh = armsDownMannequin(deg);
    const data = collectMeshData(mesh);
    const { layout, method } = autoPlaceJointsDetailed(mesh, { meshData: data });
    expect(method).toBe(expectedMethod);
    // Shoulder joint at the shoulder (0.62), the hand hanging well below it.
    expect(layout.LeftArm!.y).toBeGreaterThan(0.5);
    expect(layout.LeftHand!.y).toBeLessThan(layout.LeftArm!.y - 0.35);
    expect(layout.RightHand!.x).toBeCloseTo(-layout.LeftHand!.x, 1);
    const sk = buildSkeleton(layout);
    const w = await computeSkinWeights(prepareSkinning(data.positions, data.index), boneSegments(sk.names, layout));
    const arm = new Set(['LeftArm', 'LeftForeArm', 'LeftHand'].map((b) => sk.names.indexOf(b as never)));
    let total = 0, onArm = 0;
    for (let i = 0; i < data.positions.length / 3; i++) {
      const dx = data.positions[i * 3] - 0.16, dy = data.positions[i * 3 + 1] - 0.62;
      const along = dx * Math.cos(a) - dy * Math.sin(a), off = Math.abs(dx * Math.sin(a) + dy * Math.cos(a));
      if (dx > 0.06 && along > 0.2 && off < 0.06) {
        total++;
        let best = 0;
        for (let k = 1; k < 4; k++) if (w.skinWeight[i * 4 + k] > w.skinWeight[i * 4 + best]) best = k;
        if (arm.has(w.skinIndex[i * 4 + best])) onArm++;
      }
    }
    expect(total).toBeGreaterThan(deg > 80 ? 10 : 100); // (a near-vertical arm mostly lies inside the dx > 0.06 exclusion)
    // Was ~15% at 70°: the proportional fallback put horizontal arm bones at shoulder height, the hanging arm bound to the thigh.
    expect(onArm / total).toBeGreaterThan(0.8);
  });

  it('squat / jump: the feet never sink through the floor (sampled over the whole clip)', () => {
    const layout: JointLayout = autoPlaceJoints(makeMannequin(1).mesh);
    const rig = describeRig(layout);
    const lib = buildLibrary(rig);
    const H = layout.HeadTop_End!.y - Math.min(layout.LeftToeBase!.y, layout.RightToeBase!.y);
    const sink = (clip: AnimationClip) => {
      const sk = buildSkeleton(layout);
      const mixer = new AnimationMixer(sk.root);
      mixer.clipAction(clip).play();
      let worst = 0;
      for (let i = 0; i < 40; i++) {
        mixer.setTime((i / 40) * clip.duration);
        sk.root.updateMatrixWorld(true);
        for (const b of ['LeftFoot', 'LeftToeBase', 'RightFoot', 'RightToeBase'] as const) {
          const y = new Vector3().setFromMatrixPosition(sk.byName.get(b)!.matrixWorld).y;
          worst = Math.min(worst, y - layout[b]!.y);
        }
      }
      return worst / H;
    };
    // Were squat ≈ -9.6 %, jump ≈ -5 % of the body height (≈ 17 / 9 cm on a 1.8 m person).
    expect(sink(lib.find((c) => c.info.id === 'squat')!.clip)).toBeGreaterThan(-0.03);
    expect(sink(lib.find((c) => c.info.id === 'jump')!.clip)).toBeGreaterThan(-0.03);
  });
});
