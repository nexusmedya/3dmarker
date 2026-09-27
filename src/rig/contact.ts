/**
 * Floor-contact sample of a skinned surface: a few hundred rest vertices
 * with their skin weights, enough for the clip builder to ground every pose
 * on the real surface (soles, toes, the back when lying) instead of on the
 * joints alone. Picked per bone: the vertices it dominates that are extreme
 * along 26 directions (the hull points one of them reaches the floor with in
 * any rotation), plus an even stride over the whole mesh.
 */
import type { SkinWeights } from './skinning';

export interface ContactSample {
  /** Rest positions (xyz, the layout's frame). */
  positions: Float32Array;
  /** 4 bone indices per vertex into the descriptor's `bones`. */
  skinIndex: Uint16Array;
  /** 4 weights per vertex (summing to 1). */
  skinWeight: Float32Array;
}

const DIRS: [number, number, number][] = [];
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) DIRS.push([x, y, z]);

export function buildContactSample(positions: Float32Array, weights: SkinWeights, stride = 1024): ContactSample {
  const n = positions.length / 3;
  const pick = new Set<number>();
  // Per dominant bone: the extreme vertex along each direction.
  const best = new Map<number, Float64Array>(), arg = new Map<number, Int32Array>();
  for (let i = 0; i < n; i++) {
    let dom = 0, wmax = -1;
    for (let s = 0; s < 4; s++) if (weights.skinWeight[i * 4 + s] > wmax) (wmax = weights.skinWeight[i * 4 + s]), (dom = weights.skinIndex[i * 4 + s]);
    let b = best.get(dom), a = arg.get(dom);
    if (!b || !a) {
      best.set(dom, (b = new Float64Array(DIRS.length).fill(-Infinity)));
      arg.set(dom, (a = new Int32Array(DIRS.length).fill(-1)));
    }
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    for (let d = 0; d < DIRS.length; d++) {
      const v = DIRS[d][0] * x + DIRS[d][1] * y + DIRS[d][2] * z;
      if (v > b[d]) (b[d] = v), (a[d] = i);
    }
  }
  for (const a of arg.values()) for (const i of a) if (i >= 0) pick.add(i);
  const step = Math.max(1, Math.floor(n / stride));
  for (let i = 0; i < n; i += step) pick.add(i);

  const idx = [...pick];
  const out: ContactSample = { positions: new Float32Array(idx.length * 3), skinIndex: new Uint16Array(idx.length * 4), skinWeight: new Float32Array(idx.length * 4) };
  idx.forEach((i, k) => {
    out.positions.set(positions.subarray(i * 3, i * 3 + 3), k * 3);
    out.skinIndex.set(weights.skinIndex.subarray(i * 4, i * 4 + 4), k * 4);
    out.skinWeight.set(weights.skinWeight.subarray(i * 4, i * 4 + 4), k * 4);
  });
  return out;
}
