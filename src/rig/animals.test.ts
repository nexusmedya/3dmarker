import { describe, expect, it } from 'vitest';
import { AnimationMixer, LoopOnce, Vector3 } from 'three';
import type { AnimationClip, SkinnedMesh } from 'three';
import { buildGeometryModel } from '../app/pipeline';
import { ANIMAL_CLIPS, buildAnimalLibrary, measure, roleIndex } from './animals';
import { autoPlaceAnimal } from './autoAnimal';
import { collectMeshData } from './meshData';
import { rigModel, type RigHandle } from './rig';
import { makeBird, makeDog, makeSnake, type AnimalFixture } from './testing';
import type { AnimalTemplate } from './autoAnimal';

async function rigAnimal(fx: AnimalFixture, template: AnimalTemplate): Promise<RigHandle> {
  const model = buildGeometryModel(fx.mesh.geometry, null);
  const data = collectMeshData(model.object);
  const { spec } = autoPlaceAnimal(data, template);
  return rigModel(null, model, { spec, meshData: data });
}

/** Lowest skinned vertex (every `stride`-th) of the rig at time t of a clip. */
function lowestAt(rig: RigHandle, clip: AnimationClip, t: number, stride = 7): number {
  const mixer = new AnimationMixer(rig.root);
  const a = mixer.clipAction(clip);
  a.setLoop(LoopOnce, 1);
  a.clampWhenFinished = true;
  a.play();
  mixer.setTime(Math.min(t, clip.duration - 1e-4));
  rig.root.updateMatrixWorld(true);
  let min = Infinity;
  const v = new Vector3();
  for (const mesh of rig.meshes as SkinnedMesh[]) {
    const pos = mesh.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i += stride) {
      mesh.applyBoneTransform(i, v.fromBufferAttribute(pos, i));
      v.applyMatrix4(mesh.matrixWorld);
      min = Math.min(min, v.y);
    }
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(rig.root);
  rig.restPose();
  return min;
}

function checkClip(rig: RigHandle, clip: AnimationClip, loop: boolean, grounded: boolean, ground: number, tol: number) {
  for (const t of clip.tracks) {
    for (const x of t.values) expect(Number.isFinite(x)).toBe(true);
    expect(t.times.length).toBeGreaterThanOrEqual(2);
    if (loop) {
      const n = t.times.length, s = t.getValueSize();
      for (let c = 0; c < s; c++) expect(Math.abs(t.values[c] - t.values[(n - 1) * s + c])).toBeLessThan(1e-4);
    }
  }
  if (!grounded) return;
  let minAll = Infinity;
  for (let k = 0; k <= 8; k++) {
    const y = lowestAt(rig, clip, (clip.duration * k) / 8);
    // Feet (and everything else) stay on or above the floor…
    expect(y).toBeGreaterThan(ground - tol);
    minAll = Math.min(minAll, y);
  }
  // …and the clip does touch it.
  expect(minAll).toBeLessThan(ground + 6 * tol);
}

describe('animal clips', () => {
  it('there are at least 16 procedural animal clips with unique ids', () => {
    expect(ANIMAL_CLIPS.length).toBeGreaterThanOrEqual(16);
    expect(new Set(ANIMAL_CLIPS.map((c) => c.id)).size).toBe(ANIMAL_CLIPS.length);
  });

  it('quadruped: 12 clips, valid, seamless loops, feet never below the floor', async () => {
    const rig = await rigAnimal(makeDog(), 'quadruped');
    const r = roleIndex(rig.spec);
    expect(r.legs.map((l) => l.key)).toEqual(['FL', 'FR', 'HL', 'HR']);
    const lib = buildAnimalLibrary(rig.generic);
    const ids = lib.map((c) => c.info.id);
    for (const id of ['quad-idle', 'quad-walk', 'quad-trot', 'quad-gallop', 'quad-sit', 'quad-lie-down', 'quad-jump', 'quad-tail-wag', 'quad-look-around', 'quad-sniff', 'quad-shake', 'quad-play-bow']) expect(ids).toContain(id);
    expect(ids.some((id) => id.startsWith('bird-') || id.startsWith('snake-'))).toBe(false);
    const ground = lowestAt(rig, lib[0].clip, 0);
    const tol = 0.02 * measure(rig.spec, r).legLen + 1e-3;
    for (const c of lib) {
      const def = ANIMAL_CLIPS.find((d) => d.id === c.info.id)!;
      checkClip(rig, c.clip, def.loop, def.grounded !== false, ground, tol);
    }
    rig.dispose();
  }, 60_000);

  it('walk keeps a planted foot still on the ground and scales its period with the legs', async () => {
    const rig = await rigAnimal(makeDog(), 'quadruped');
    const lib = buildAnimalLibrary(rig.generic);
    const walk = lib.find((c) => c.info.id === 'quad-walk')!;
    // The left hind foot is planted at u = 0.1 (stance phase 0 .. 0.65).
    const foot = rig.bones.get('LeftHindToe')!;
    const at = (t: number) => {
      const mixer = new AnimationMixer(rig.root);
      mixer.clipAction(walk.clip).play();
      mixer.setTime(t);
      rig.root.updateMatrixWorld(true);
      const p = foot.getWorldPosition(new Vector3());
      mixer.stopAllAction();
      mixer.uncacheRoot(rig.root);
      return p;
    };
    const p0 = at(0.1 * walk.clip.duration), rest = rig.spec.bones.find((b) => b.name === 'LeftHindToe')!.head;
    expect(Math.abs(p0.y - rest.y)).toBeLessThan(0.05);
    const legLen = measure(rig.spec, roleIndex(rig.spec)).legLen;
    expect(walk.info.duration).toBeCloseTo(1.1 * Math.min(1.6, Math.max(0.6, Math.sqrt(legLen / 0.6))), 5);
    rig.dispose();
  }, 60_000);

  it('bird (4 clips) and snake (3 clips) are valid, grounded and seamless', async () => {
    for (const [fx, template, prefix, count] of [[makeBird(), 'bird', 'bird-', 4], [makeSnake(), 'snake', 'snake-', 3]] as const) {
      const rig = await rigAnimal(fx, template);
      const lib = buildAnimalLibrary(rig.generic);
      expect(lib.map((c) => c.info.id).filter((id) => id.startsWith(prefix))).toHaveLength(count);
      const ground = lowestAt(rig, lib[0].clip, 0);
      const tol = 0.03 * measure(rig.spec, roleIndex(rig.spec)).legLen + 2e-3;
      for (const c of lib) {
        const def = ANIMAL_CLIPS.find((d) => d.id === c.info.id)!;
        checkClip(rig, c.clip, def.loop, def.grounded !== false, ground, tol);
      }
      if (template === 'bird') {
        // Flying lifts the whole bird off the ground.
        const fly = lib.find((c) => c.info.id === 'bird-fly')!;
        expect(lowestAt(rig, fly.clip, 0.1)).toBeGreaterThan(ground + 0.1);
      }
      rig.dispose();
    }
  }, 60_000);
});
