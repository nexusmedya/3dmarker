import { describe, expect, it } from 'vitest';
import { autoPlaceJoints } from './autoJoints';
import { collectMeshData } from './meshData';
import { boneSegments, buildSkeleton } from './skeleton';
import { computeSkinWeights, prepareSkinning } from './skinning';
import { makeMannequin } from './testing';

async function skin(detail: number, opts = {}) {
  const m = makeMannequin(detail);
  const data = collectMeshData(m.mesh);
  const layout = autoPlaceJoints(m.mesh, { meshData: data });
  const rig = buildSkeleton(layout);
  const prep = prepareSkinning(data.positions, data.index);
  const w = await computeSkinWeights(prep, boneSegments(rig.names, layout), opts);
  return { m, data, rig, prep, w };
}

const topBone = (names: string[], w: { skinIndex: Uint16Array; skinWeight: Float32Array }, i: number) => {
  let best = 0;
  for (let s = 1; s < 4; s++) if (w.skinWeight[i * 4 + s] > w.skinWeight[i * 4 + best]) best = s;
  return names[w.skinIndex[i * 4 + best]];
};

describe('computeSkinWeights on a T-pose mannequin', async () => {
  const { data, rig, prep, w } = await skin(1);
  const names = rig.names as string[];
  const n = data.positions.length / 3;
  const P = (i: number) => ({ x: data.positions[i * 3], y: data.positions[i * 3 + 1], z: data.positions[i * 3 + 2] });

  it('4 influences per vertex, valid indices, weights normalised', () => {
    expect(w.skinIndex).toHaveLength(n * 4);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let s = 0; s < 4; s++) {
        expect(w.skinIndex[i * 4 + s]).toBeLessThan(names.length);
        expect(w.skinWeight[i * 4 + s]).toBeGreaterThanOrEqual(0);
        sum += w.skinWeight[i * 4 + s];
      }
      expect(sum).toBeCloseTo(1, 5);
    }
    expect(names.includes('HeadTop_End')).toBe(true);
    const end = names.indexOf('HeadTop_End');
    for (let i = 0; i < n * 4; i++) if (w.skinWeight[i] > 0) expect(w.skinIndex[i]).not.toBe(end);
  });

  it('arm vertices bind to the arm bones', () => {
    let arm = 0, ok = 0;
    for (let i = 0; i < n; i++) {
      const p = P(i);
      if (p.x < 0.3 || p.y < 0.5) continue;
      arm++;
      if (/^Left(Arm|ForeArm|Hand)$/.test(topBone(names, w, i))) ok++;
    }
    expect(arm).toBeGreaterThan(100);
    expect(ok / arm).toBeGreaterThan(0.97);
  });

  it('elbow region blends upper arm and forearm', () => {
    const elbow = rig.byName.get('LeftForeArm')!.getWorldPosition(rig.byName.get('LeftForeArm')!.position.clone());
    let blended = 0, near = 0;
    for (let i = 0; i < n; i++) {
      const p = P(i);
      if (Math.abs(p.x - elbow.x) > 0.02 || p.y < 0.5) continue;
      near++;
      const bones = new Set<string>();
      for (let s = 0; s < 4; s++) if (w.skinWeight[i * 4 + s] > 0.15) bones.add(names[w.skinIndex[i * 4 + s]]);
      if (bones.has('LeftArm') && bones.has('LeftForeArm')) blended++;
    }
    expect(near).toBeGreaterThan(5);
    expect(blended / near).toBeGreaterThan(0.5);
  });

  it('legs do not bleed into the other leg', () => {
    for (let i = 0; i < n; i++) {
      const p = P(i);
      if (p.y > -0.2 || Math.abs(p.x) < 0.04) continue;
      const own = p.x > 0 ? 'Left' : 'Right', other = p.x > 0 ? 'Right' : 'Left';
      for (let s = 0; s < 4; s++) {
        const b = names[w.skinIndex[i * 4 + s]];
        if (w.skinWeight[i * 4 + s] > 0.01) expect(b.startsWith(other), `${b} on ${own} leg`).toBe(false);
      }
    }
  });

  it('visibility: the torso side under the arm is not bound to the arm', () => {
    let side = 0, arm = 0;
    for (let i = 0; i < n; i++) {
      const p = P(i);
      if (p.x < 0.1 || p.x > 0.17 || p.y < 0.3 || p.y > 0.5) continue;
      side++;
      if (/Arm|Hand/.test(topBone(names, w, i))) arm++;
    }
    expect(side).toBeGreaterThan(5);
    expect(arm / side).toBeLessThan(0.1);
  });

  it('welded duplicates get identical weights', () => {
    expect(prep.count).toBeLessThan(n);
    const first = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const wv = prep.weld[i];
      if (!first.has(wv)) first.set(wv, i);
      const j = first.get(wv)!;
      for (let s = 0; s < 4; s++) expect(w.skinWeight[i * 4 + s]).toBe(w.skinWeight[j * 4 + s]);
    }
  });

  it('honours abort signals', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(computeSkinWeights(prep, [], { signal: ac.signal })).rejects.toThrow();
  });
});

describe('performance', () => {
  it('skins ~100k vertices in a few seconds', async () => {
    const t0 = performance.now();
    const { data, w } = await skin(7);
    const ms = performance.now() - t0;
    const n = data.positions.length / 3;
    expect(n).toBeGreaterThan(90_000);
    expect(w.skinWeight.length).toBe(n * 4);
    console.info(`skinning ${n} vertices: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(20_000);
  }, 60_000);
});
