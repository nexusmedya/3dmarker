import { describe, expect, it } from 'vitest';
import { Box3, BoxGeometry, Mesh, Vector3 } from 'three';
import { analyzeProfile, autoPlaceAnimal, suggestTemplate } from './autoAnimal';
import { autoPlaceJointsDetailed } from './autoJoints';
import { collectMeshData } from './meshData';
import { boneMap, leftAxis, validateSpec } from './spec';
import { makeBird, makeDog, makeMannequin, makeSnake } from './testing';
import type { SkeletonSpec, Vec3 } from './types';

const head = (spec: SkeletonSpec, name: string): Vec3 => boneMap(spec).get(name)!.head;
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('autoPlaceAnimal: quadruped (side view)', () => {
  for (const facing of [1, -1] as const) {
    it(`finds the body axis, head, legs and tail of a dog facing ${facing > 0 ? '+X' : '-X'}`, () => {
      const dog = makeDog(1, facing);
      const data = collectMeshData(dog.mesh);
      const r = autoPlaceAnimal(data, 'quadruped');
      expect(validateSpec(r.spec)).toEqual([]);
      expect(r.method).toBe('side');
      expect(r.legGroups).toBe(2);
      expect(r.confidence).toBeGreaterThan(0.7);
      expect(r.spec.frame.forward.x).toBeCloseTo(facing, 5);
      const t = dog.truth;
      // Head near the head, hips over the hind legs, chest over the front legs.
      expect(dist(head(r.spec, 'Head'), t.head)).toBeLessThan(0.2);
      expect(Math.abs(head(r.spec, 'Hips').x - t.hips.x)).toBeLessThan(0.15);
      expect(Math.abs(head(r.spec, 'Chest').x - t.chest.x)).toBeLessThan(0.15);
      expect(dist(boneMap(r.spec).get('Head')!.tail, t.nose)).toBeLessThan(0.2);
      // Feet on the ground under the legs; left legs on the subject's left.
      const left = leftAxis(r.spec);
      for (const [leg, truth] of [['LeftFrontToe', t.frontFoot], ['RightHindToe', t.hindFoot]] as const) {
        const p = head(r.spec, leg);
        expect(p.y).toBeLessThan(-0.85);
        expect(Math.abs(p.x - truth.x)).toBeLessThan(0.15);
      }
      const lf = head(r.spec, 'LeftFrontLowerLeg'), rf = head(r.spec, 'RightFrontLowerLeg');
      expect((lf.x - rf.x) * left.x + (lf.z - rf.z) * left.z).toBeGreaterThan(0);
      // Tail: 3–6 bones reaching back towards the tip.
      const tail = r.spec.bones.filter((b) => b.role?.part === 'tail');
      expect(tail.length).toBeGreaterThanOrEqual(3);
      expect(tail.length).toBeLessThanOrEqual(6);
      expect(dist(tail[tail.length - 1].tail, t.tailTip)).toBeLessThan(0.25);
      // Every joint inside the mesh's bounds.
      const box = data.box.clone().expandByScalar(0.05);
      for (const b of r.spec.bones) expect(box.containsPoint(new Vector3(b.head.x, b.head.y, b.head.z))).toBe(true);
    });
  }

  it('front-facing animals get a skeleton facing +Z', () => {
    // A symmetric front view: two legs, a body, a head in the middle.
    const parts = [new BoxGeometry(0.8, 0.5, 0.2).translate(0, 0, 0), new BoxGeometry(0.15, 0.6, 0.2).translate(0.28, -0.55, 0), new BoxGeometry(0.15, 0.6, 0.2).translate(-0.28, -0.55, 0), new BoxGeometry(0.4, 0.4, 0.2).translate(0, 0.45, 0)];
    const meshes = parts.map((g) => new Mesh(g));
    const root = new Mesh();
    meshes.forEach((m) => root.add(m));
    const r = autoPlaceAnimal(collectMeshData(root), 'quadruped');
    expect(r.method).toBe('front');
    expect(r.spec.frame.forward.z).toBeCloseTo(1, 5);
    expect(validateSpec(r.spec)).toEqual([]);
  });
});

describe('autoPlaceAnimal: bird and snake', () => {
  it('places a bird: legs down to the ground, head up front, folded wings along the back', () => {
    const bird = makeBird();
    const r = autoPlaceAnimal(collectMeshData(bird.mesh), 'bird');
    expect(validateSpec(r.spec)).toEqual([]);
    expect(r.spec.frame.forward.x).toBeCloseTo(1, 5);
    expect(dist(head(r.spec, 'Head'), bird.truth.head)).toBeLessThan(0.25);
    expect(head(r.spec, 'LeftToe').y).toBeLessThan(-0.85);
    expect(r.spec.bones.filter((b) => b.role?.part === 'wing')).toHaveLength(6);
    // Folded wing tips point backwards.
    expect(boneMap(r.spec).get('LeftWing3')!.tail.x).toBeLessThan(head(r.spec, 'LeftWing1').x);
  });

  it('follows a snake from its thick head to the tail tip', () => {
    const snake = makeSnake();
    const r = autoPlaceAnimal(collectMeshData(snake.mesh), 'snake');
    expect(r.method).toBe('chain');
    expect(validateSpec(r.spec)).toEqual([]);
    const chain = r.spec.bones.filter((b) => b.name.startsWith('Chain'));
    expect(chain.length).toBe(10);
    expect(chain[0].head.x).toBeGreaterThan(0.6);
    expect(chain[chain.length - 1].tail.x).toBeLessThan(-1);
    expect(r.spec.frame.forward.x).toBeGreaterThan(0.9);
  });
});

describe('suggestTemplate', () => {
  it('humanoid for a T-pose mannequin, quadruped for a dog, bird, snake, humanoid for a tall box', () => {
    const man = makeMannequin().mesh;
    const hum = autoPlaceJointsDetailed(man);
    expect(suggestTemplate({ data: collectMeshData(man), humanoidMethod: hum.method, plausibility: hum.plausibility }).template).toBe('humanoid');
    const dog = collectMeshData(makeDog().mesh);
    const hd = autoPlaceJointsDetailed(makeDog().mesh);
    expect(suggestTemplate({ data: dog, humanoidMethod: hd.method, plausibility: hd.plausibility }).template).toBe('quadruped');
    expect(suggestTemplate({ data: collectMeshData(makeBird().mesh) }).template).toBe('bird');
    expect(suggestTemplate({ data: collectMeshData(makeSnake().mesh) }).template).toBe('snake');
    expect(suggestTemplate({ data: collectMeshData(new Mesh(new BoxGeometry(0.6, 2, 0.4))) }).template).toBe('humanoid');
    expect(suggestTemplate({ data: dog, poseFound: true }).template).toBe('humanoid');
  });

  it('profile analysis measures the dog', () => {
    const p = analyzeProfile(collectMeshData(makeDog().mesh));
    expect(p.groups).toHaveLength(2);
    expect(p.headSign).toBe(1);
    expect(p.belly).toBeGreaterThan(-0.55);
    expect(p.belly).toBeLessThan(-0.25);
    expect(new Box3().isEmpty()).toBe(true);
  });
});
