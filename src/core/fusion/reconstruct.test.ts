import { describe, expect, it, vi } from 'vitest';
import type { BufferGeometry } from 'three';
import type { Progress, ViewId } from '../types';
import { AbortError } from '../types';
import { LocalizedError } from '../errors';
import { computeMeshStats } from '../mesh/stats';
import { distanceTransform } from '../image/distance';
import { FUSION_TEXT, reconstructFromViews, sanitizeFusionOptions } from './reconstruct';
import type { DepthEstimator, FusionContext, FusionOptions, FusionViewInput } from './types';
import { box, cylinderY, fakeDepthEstimator, renderView, renderViews, sphere, VIEW_COLORS, type Solid } from './testing';

const ALL: ViewId[] = ['front', 'back', 'left', 'right', 'top', 'bottom'];

function ctx(over: Partial<FusionContext> = {}): FusionContext & { progress: Progress[] } {
  const progress: Progress[] = [];
  return { signal: new AbortController().signal, onProgress: (p) => progress.push(p), yieldControl: async () => {}, progress, ...over };
}

const attr = (g: BufferGeometry, name: string) => g.getAttribute(name).array as Float32Array;

function bounds(g: BufferGeometry): { min: number[]; max: number[]; size: number[] } {
  const p = attr(g, 'position');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], p[i + a]);
      max[a] = Math.max(max[a], p[i + a]);
    }
  return { min, max, size: max.map((v, a) => v - min[a]) };
}

/** Ray-parity point-in-mesh test (closed mesh), ray along a slightly skewed +X. */
function inside(g: BufferGeometry, q: [number, number, number]): boolean {
  const p = attr(g, 'position');
  const idx = g.getIndex()!.array;
  const d = [1, 0.00131, 0.00071];
  let hits = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
    if (Math.abs(det) < 1e-12) continue;
    const s = [q[0] - p[a], q[1] - p[a + 1], q[2] - p[a + 2]];
    const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det;
    if (u < 0 || u > 1) continue;
    const qq = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (d[0] * qq[0] + d[1] * qq[1] + d[2] * qq[2]) / det;
    if (v < 0 || u + v > 1) continue;
    if ((e2[0] * qq[0] + e2[1] * qq[1] + e2[2] * qq[2]) / det > 0) hits++;
  }
  return hits % 2 === 1;
}

function volume(g: BufferGeometry): number {
  const p = attr(g, 'position');
  const idx = g.getIndex()!.array;
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

async function run(solid: Solid, views: ViewId[], opts: Partial<FusionOptions> = {}, depth = false, size = 128) {
  const { inputs, renders } = renderViews(solid, views, { width: size, height: size, scale: size * 0.4 });
  const c = ctx({ estimateDepth: depth ? fakeDepthEstimator(renders) : null });
  const result = await reconstructFromViews(inputs, opts, c);
  return { ...result, progress: c.progress };
}

describe('reconstructFromViews: shapes', () => {
  it('recovers a sphere from six views with depth, as a closed mesh in the shared frame', async () => {
    const { geometry: g, info } = await run([sphere([0, 0, 0], 1)], ALL, { hull: 'strict', depthStrength: 1, resolution: 96 }, true, 160);
    expect(computeMeshStats(g).watertight).toBe(true);
    expect(g.getAttribute('position').itemSize).toBe(3);
    expect(g.getAttribute('normal').itemSize).toBe(3);
    expect(g.getAttribute('color').itemSize).toBe(3);
    const b = bounds(g);
    expect(Math.max(...b.size)).toBeCloseTo(2, 5);
    for (let a = 0; a < 3; a++) expect(b.min[a] + b.max[a]).toBeCloseTo(0, 5);
    const p = attr(g, 'position');
    let sum = 0, worst = 0;
    for (let i = 0; i < p.length; i += 3) {
      const err = Math.abs(Math.hypot(p[i], p[i + 1], p[i + 2]) - 1);
      sum += err;
      worst = Math.max(worst, err);
    }
    expect(sum / (p.length / 3)).toBeLessThan(0.02);
    expect(worst).toBeLessThan(0.07);
    expect(info.depth).toEqual({ front: 'model', back: 'model', left: 'model', right: 'model', top: 'model', bottom: 'model' });
    expect(info.box.depthFrom).toBe('side');
  });

  it('without depth gives the visual hull of a sphere (Steinmetz solid: between the sphere and its corners)', async () => {
    const { geometry: g, info } = await run([sphere([0, 0, 0], 1)], ALL, { hull: 'strict', resolution: 80 });
    expect(computeMeshStats(g).watertight).toBe(true);
    const p = attr(g, 'position');
    let min = Infinity, max = 0;
    for (let i = 0; i < p.length; i += 3) {
      const r = Math.hypot(p[i], p[i + 1], p[i + 2]);
      min = Math.min(min, r);
      max = Math.max(max, r);
    }
    expect(min).toBeGreaterThan(0.95);
    expect(max).toBeGreaterThan(1.12); // rounded corners of the tricylinder (sqrt(1.5) ≈ 1.22 sharp)
    expect(max).toBeLessThan(1.25);
    expect(Object.values(info.depth).every((s) => s === 'none')).toBe(true);
  });

  it('keeps a box\'s proportions from views of different scale and framing', async () => {
    const solid = [box([-1, -0.5, -0.25], [1, 0.5, 0.25])];
    const framing: Record<string, { scale: number; offset: [number, number] }> = {
      front: { scale: 50, offset: [0, 0] },
      left: { scale: 90, offset: [12, -7] },
      top: { scale: 35, offset: [-9, 20] },
    };
    const inputs: FusionViewInput[] = (['front', 'left', 'top'] as ViewId[]).map((id) => {
      const r = renderView(solid, id, { width: 140, height: 140, ...framing[id] });
      return { id, image: r.image, mask: null };
    });
    const { geometry: g, info } = await reconstructFromViews(inputs, { resolution: 96 }, ctx());
    expect(computeMeshStats(g).watertight).toBe(true);
    const { size } = bounds(g);
    expect(size[0]).toBeCloseTo(2, 5);
    expect(size[1]).toBeGreaterThan(0.97);
    expect(size[1]).toBeLessThan(1.03);
    expect(size[2]).toBeGreaterThan(0.47);
    expect(size[2]).toBeLessThan(0.53);
    expect(info.box.depthFrom).toBe('side');
    // Flat faces stay flat: a box's volume is nearly its bbox volume.
    expect(volume(g) / (size[0] * size[1] * size[2])).toBeGreaterThan(0.93);
  });

  it('recovers a cylinder: depth from the top view, round cross-section', async () => {
    const { geometry: g, info } = await run([cylinderY(0, 0, 0.5, -1, 1)], ['front', 'top'], { hull: 'strict', resolution: 96 });
    expect(computeMeshStats(g).watertight).toBe(true);
    expect(info.box.depthFrom).toBe('top-bottom');
    const { size } = bounds(g);
    expect(size[1]).toBeCloseTo(2, 5);
    expect(size[0]).toBeGreaterThan(0.95);
    expect(size[0]).toBeLessThan(1.05);
    expect(size[2]).toBeGreaterThan(0.95);
    expect(size[2]).toBeLessThan(1.05);
    // Mid-height ring: radius ≈ 0.5 in every direction.
    const p = attr(g, 'position');
    for (let i = 0; i < p.length; i += 3) {
      if (Math.abs(p[i + 1]) > 0.5) continue;
      expect(Math.abs(Math.hypot(p[i], p[i + 2]) - 0.5)).toBeLessThan(0.04);
    }
  });

  it('uses defaultDepth and rounds a front/back-only set like a balloon', async () => {
    const r = await run([sphere([0, 0, 0], 1)], ['front', 'back'], { defaultDepth: 0.6, depthStrength: 1, resolution: 80 });
    expect(computeMeshStats(r.geometry).watertight).toBe(true);
    expect(r.info.box.depthFrom).toBe('default');
    expect(r.info.depth).toEqual({ front: 'silhouette', back: 'silhouette' });
    const { size } = bounds(r.geometry);
    expect(size[2] / size[0]).toBeGreaterThan(0.55);
    expect(size[2] / size[0]).toBeLessThan(0.62);
    // Rounded, not a slab: an oblate spheroid with semi-axes 1, 1, 0.6 (z = 0.235 at x = 0.92).
    expect(inside(r.geometry, [0, 0, 0.5])).toBe(true);
    expect(inside(r.geometry, [0.92, 0, 0.35])).toBe(false);
    expect(inside(r.geometry, [0.85, 0, 0])).toBe(true);
  });

  it('caps the triangle count by coarsening the voxel step', async () => {
    const r = await run([sphere([0, 0, 0], 1)], ['front', 'left'], { maxTriangles: 8000, resolution: 128 });
    expect(r.info.step).toBeGreaterThan(1);
    expect(r.info.triangles).toBeLessThanOrEqual(8000);
    expect(r.geometry.getIndex()!.count / 3).toBe(r.info.triangles);
    expect(computeMeshStats(r.geometry).watertight).toBe(true);
    expect(Math.max(...bounds(r.geometry).size)).toBeCloseTo(2, 5);
  });
});

describe('reconstructFromViews: depth calibration on non-spherical subjects', () => {
  // Torso (half-width 0.3, depth 0.36) with arms; exact rendered depth, 4 views, default strength.
  const torso = box([-0.3, -1, -0.18], [0.3, 0.6, 0.18]);
  const H = 1.6;
  /** Mesh positions back in world units (the result is rescaled to a longest side of 2 and centred). */
  function toWorld(g: BufferGeometry) {
    const b = bounds(g);
    const s = b.size[1] / H;
    const c = [(b.max[0] + b.min[0]) / 2, b.min[1], (b.max[2] + b.min[2]) / 2];
    return { s, at: (p: Float32Array, i: number) => [(p[i] - c[0]) / s, (p[i + 1] - c[1]) / s - 1, (p[i + 2] - c[2]) / s] };
  }
  const voxel = H / 144;

  it('keeps the torso side face under side arms and the full Z extent', async () => {
    const solid: Solid = [torso, cylinderY(0.42, 0, 0.08, -0.6, 0.55), cylinderY(-0.42, 0, 0.08, -0.6, 0.55)];
    const { inputs, renders } = renderViews(solid, ['front', 'back', 'left', 'right'], { width: 400, height: 400, scale: 190 });
    const { geometry: g } = await reconstructFromViews(inputs, { resolution: 144 }, ctx({ estimateDepth: fakeDepthEstimator(renders) }));
    const { s, at } = toWorld(g);
    const p = attr(g, 'position'), n = attr(g, 'normal');
    const xs: number[] = [];
    for (let i = 0; i < p.length; i += 3) {
      const [x, y, z] = at(p, i);
      // The torso's +X face beside the arm (z outside the arm's radius).
      if (Math.abs(y) < 0.3 && z > 0.1 && z < 0.15 && x > 0 && x < 0.34 && n[i] > 0.8) xs.push(x);
    }
    expect(xs.length).toBeGreaterThan(20);
    xs.sort((a, b) => a - b);
    expect(Math.abs(xs[xs.length >> 1] - 0.3)).toBeLessThan(2 * voxel);
    expect(Math.abs(bounds(g).size[2] / s - 0.36)).toBeLessThan(2 * voxel);
  });

  it('keeps an arm lying in front of the torso', async () => {
    const solid: Solid = [torso, cylinderY(0.12, 0.26, 0.08, -0.6, 0.4)];
    const { inputs, renders } = renderViews(solid, ['front', 'back', 'left', 'right'], { width: 400, height: 400, scale: 190 });
    const { geometry: g } = await reconstructFromViews(inputs, { resolution: 144 }, ctx({ estimateDepth: fakeDepthEstimator(renders) }));
    const { s, at } = toWorld(g);
    expect(Math.abs(bounds(g).size[2] / s - 0.52)).toBeLessThan(2 * voxel);
    // Torso front (away from the arm) and the arm's front stay where they are.
    const p = attr(g, 'position'), n = attr(g, 'normal');
    const torsoFront: number[] = [], armFront: number[] = [];
    for (let i = 0; i < p.length; i += 3) {
      const [x, y, z] = at(p, i);
      if (n[i + 2] < 0.9 || y < -0.5 || y > 0.3) continue;
      if (x < -0.1 && x > -0.25) torsoFront.push(z);
      if (Math.abs(x - 0.12) < 0.02) armFront.push(z);
    }
    const median = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1];
    expect(torsoFront.length).toBeGreaterThan(20);
    expect(armFront.length).toBeGreaterThan(5);
    // World Z is centred on the box: torso front at 0.18 − 0.08, arm front at 0.34 − 0.08.
    expect(Math.abs(median(torsoFront) - 0.1)).toBeLessThan(2 * voxel);
    expect(Math.abs(median(armFront) - 0.26)).toBeLessThan(2 * voxel);
  });
});

describe('reconstructFromViews: view conventions', () => {
  // Base slab + a pillar at the subject's left (+X) rear (Z < 0).
  const pillar: Solid = [box([-1, -1, -0.5], [1, -0.6, 0.5]), box([0.4, -0.6, -0.5], [1, 1, 0])];
  const IN: [number, number, number] = [0.7, 0.5, -0.25];
  const MIRROR_X: [number, number, number] = [-0.7, 0.5, -0.25];
  const MIRROR_Z: [number, number, number] = [0.7, 0.5, 0.25];

  it.each([
    [['front', 'left']],
    [['front', 'right']],
    [['back', 'left']],
    [['back', 'right']],
    [['front', 'back', 'left', 'right']],
  ] as ViewId[][][])('places the pillar correctly from %j', async (views) => {
    const set: ViewId[] = views.includes('front') ? views : ['front', ...views];
    // Views other than the listed pair are dropped, except the front (always required): test back/right alone
    // by giving the front as a featureless silhouette of the bbox.
    const inputs: FusionViewInput[] = set.map((id) => {
      const solid = id === 'front' && !views.includes('front') ? [box([-1, -1, -0.5], [1, 1, 0.5])] : pillar;
      const r = renderView(solid, id, { width: 120, height: 120, scale: 50 });
      return { id, image: r.image, mask: null };
    });
    const { geometry: g } = await reconstructFromViews(inputs, { hull: 'strict', resolution: 64 }, ctx());
    expect(computeMeshStats(g).watertight).toBe(true);
    expect(inside(g, IN)).toBe(true);
    expect(inside(g, [0, -0.8, 0])).toBe(true);
    if (views.includes('front') || views.includes('back')) expect(inside(g, MIRROR_X)).toBe(false);
    if (views.includes('left') || views.includes('right')) expect(inside(g, MIRROR_Z)).toBe(false);
  });

  // An L in the XZ plane: a front strip plus a block at the subject's left rear.
  const ell: Solid = [box([-1, -0.5, 0], [1, 0.5, 0.5]), box([0.4, -0.5, -0.5], [1, 0.5, 0])];

  it.each([['top'], ['bottom']] as ViewId[][])('maps the %s view onto X and Z', async (cap) => {
    const { geometry: g, info } = await run(ell, ['front', cap], { hull: 'strict', resolution: 64 });
    expect(info.box.depthFrom).toBe('top-bottom');
    expect(computeMeshStats(g).watertight).toBe(true);
    expect(inside(g, [0.7, 0, -0.25])).toBe(true);
    expect(inside(g, [-0.7, 0, 0.25])).toBe(true);
    expect(inside(g, [-0.7, 0, -0.25])).toBe(false);
  });

  it('colours each side from the view that faces it', async () => {
    const { geometry: g } = await run([sphere([0, 0, 0], 1)], ALL, { resolution: 64 }, true);
    const p = attr(g, 'position'), n = attr(g, 'normal'), c = attr(g, 'color');
    const dirs: Record<ViewId, [number, number, number]> = {
      front: [0, 0, 1], back: [0, 0, -1], left: [1, 0, 0], right: [-1, 0, 0], top: [0, 1, 0], bottom: [0, -1, 0],
    };
    let checked = 0;
    for (let i = 0; i < p.length; i += 3) {
      for (const id of ALL) {
        const d = dirs[id];
        if (n[i] * d[0] + n[i + 1] * d[1] + n[i + 2] * d[2] < 0.9) continue;
        const want = VIEW_COLORS[id].map((v) => v / 255);
        for (let k = 0; k < 3; k++) expect(Math.abs(c[i + k] - want[k])).toBeLessThan(0.1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
    for (const v of c) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('colours +Z red and −Z blue from front/back only, filling unseen sides', async () => {
    const { geometry: g } = await run([sphere([0, 0, 0], 1)], ['front', 'back'], { resolution: 64 });
    const p = attr(g, 'position'), n = attr(g, 'normal'), c = attr(g, 'color');
    for (let i = 0; i < p.length; i += 3) {
      if (n[i + 2] > 0.5) expect([c[i], c[i + 1], c[i + 2]].map((v) => Math.round(v * 10) / 10)).toEqual([1, 0, 0]);
      if (n[i + 2] < -0.5) expect([c[i], c[i + 1], c[i + 2]].map((v) => Math.round(v * 10) / 10)).toEqual([0, 0, 1]);
    }
  });

  it.each([[['front', 'back']], [['front', 'back', 'left', 'right']]] as ViewId[][][])(
    'does not paint a matting fringe onto the rim (%j)',
    async (views) => {
      const skin: [number, number, number] = [230, 180, 150];
      const { inputs } = renderViews([cylinderY(0, 0, 0.15, -1, 1)], views, { width: 300, height: 300, scale: 140, color: () => skin });
      // A 2 px blue fringe inside every alpha mask, as matting on a blue backdrop leaves it.
      for (const inp of inputs) {
        const { width: w, height: h, data } = inp.image;
        const m = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) m[i] = data[i * 4 + 3] > 0 ? 1 : 0;
        const d = distanceTransform({ width: w, height: h, data: m });
        for (let i = 0; i < w * h; i++) if (m[i] && d[i] <= 2) data.set([30, 60, 220, 255], i * 4);
      }
      const { geometry: g } = await reconstructFromViews(inputs, { resolution: 96 }, ctx());
      const c = attr(g, 'color');
      let blue = 0;
      for (let i = 0; i < c.length; i += 3) if (c[i + 2] > c[i]) blue++;
      expect(blue / (c.length / 3)).toBeLessThan(0.02);
    },
  );

  it('respects occlusion: a colour is not painted through the object', async () => {
    // A small box in front of a big one; the front view sees red on the small box, green on the big one.
    const solid: Solid = [box([-1, -1, -0.5], [1, 1, 0]), box([-0.3, -0.3, 0], [0.3, 0.3, 0.5])];
    const color = (q: [number, number, number], view: ViewId): [number, number, number] =>
      view === 'front' ? (q[2] > 0.25 ? [255, 0, 0] : [0, 255, 0]) : [0, 0, 255];
    const { inputs, renders } = renderViews(solid, ['front', 'left', 'top'], { width: 120, height: 120, scale: 50, color });
    const { geometry: g } = await reconstructFromViews(inputs, { hull: 'strict', resolution: 80 }, ctx({ estimateDepth: fakeDepthEstimator(renders) }));
    const p = attr(g, 'position'), n = attr(g, 'normal'), c = attr(g, 'color');
    let big = 0;
    for (let i = 0; i < p.length; i += 3) {
      // Front face of the big box, outside the small one's shadow.
      if (n[i + 2] > 0.9 && p[i + 2] < 0.1 && Math.max(Math.abs(p[i]), Math.abs(p[i + 1])) > 0.5) {
        expect(c[i + 1]).toBeGreaterThan(0.8);
        expect(c[i]).toBeLessThan(0.2);
        big++;
      }
    }
    expect(big).toBeGreaterThan(50);
  });
});

describe('reconstructFromViews: robustness', () => {
  it('keeps a small detached part that every view shows', async () => {
    // Body box plus a ball of radius 0.05 (about 320 px of a 512² render).
    const solid: Solid = [box([-0.25, -0.6, -0.15], [0.25, 0.6, 0.15]), sphere([0.45, 0.2, 0], 0.05)];
    const { inputs } = renderViews(solid, ['front', 'back', 'left', 'right'], { width: 512, height: 512, scale: 204.8 });
    const { geometry: g } = await reconstructFromViews(inputs, { resolution: 144, hull: 'strict' }, ctx());
    const { size } = bounds(g);
    // World 0.75 × 1.2, rescaled to a longest side of 2 (without the ball: 0.5 × 1.2 → 0.83).
    expect(size[1]).toBeCloseTo(2, 5);
    expect(size[0]).toBeGreaterThan(1.2);
    expect(size[0]).toBeLessThan(1.3);
  });

  it('tolerant mode survives a misaligned extra view better than strict mode', async () => {
    const front = renderView([sphere([0, 0, 0], 1)], 'front', { width: 128, height: 128, scale: 50 });
    // The back view carries a bump that shifts / squeezes the sphere after bbox normalisation.
    const back = renderView([sphere([0, 0, 0], 1), sphere([1.05, 0.3, 0], 0.12)], 'back', { width: 128, height: 128, scale: 50 });
    const aligned = renderView([sphere([0, 0, 0], 1)], 'back', { width: 128, height: 128, scale: 50 });
    const inputs = (b: typeof back): FusionViewInput[] => [
      { id: 'front', image: front.image, mask: null },
      { id: 'back', image: b.image, mask: null },
    ];
    const opts = { resolution: 72, defaultDepth: 1 };
    const ref = volume((await reconstructFromViews(inputs(aligned), { ...opts, hull: 'strict' }, ctx())).geometry);
    const strict = volume((await reconstructFromViews(inputs(back), { ...opts, hull: 'strict' }, ctx())).geometry);
    const tolerant = volume((await reconstructFromViews(inputs(back), { ...opts, hull: 'tolerant', tolerance: 0.06 }, ctx())).geometry);
    expect(strict).toBeLessThan(ref * 0.97);
    expect(tolerant).toBeGreaterThan(strict);
    expect(tolerant).toBeGreaterThan(ref * 0.97);
  });

  it('falls back to the hull with a bilingual warning when the depth model fails', async () => {
    const { inputs } = renderViews([sphere([0, 0, 0], 1)], ['front', 'left', 'top'], { width: 96, height: 96, scale: 40 });
    const estimateDepth = vi.fn<DepthEstimator>(async () => {
      throw new LocalizedError({ tr: 'Model indirilemedi', en: 'Could not download the model' });
    });
    const c = ctx({ estimateDepth });
    const r = await reconstructFromViews(inputs, { resolution: 64 }, c);
    expect(computeMeshStats(r.geometry).watertight).toBe(true);
    expect(estimateDepth).toHaveBeenCalledTimes(1); // no retry for every view
    expect(r.info.warnings[0]).toEqual(FUSION_TEXT.depthUnavailable);
    expect(r.info.warnings[1]).toEqual({ tr: 'Model indirilemedi', en: 'Could not download the model' });
    expect(Object.values(r.info.depth).every((s) => s === 'none')).toBe(true);
    const after = c.progress.slice(c.progress.findIndex((p) => p.label.en.includes(FUSION_TEXT.depthUnavailable.en)));
    expect(after.length).toBeGreaterThan(3);
    for (const p of after) {
      expect(p.label.tr).toContain(FUSION_TEXT.depthUnavailable.tr);
      expect(p.label.en).toContain(FUSION_TEXT.depthUnavailable.en);
    }
  });

  it('reports monotonic progress with ratios and passes depth progress through', async () => {
    const { inputs, renders } = renderViews([sphere([0, 0, 0], 1)], ['front', 'back'], { width: 64, height: 64, scale: 25 });
    const fake = fakeDepthEstimator(renders);
    const c = ctx({
      estimateDepth: async (req, dctx) => {
        dctx.onProgress({ label: { tr: 'Model yükleniyor', en: 'Loading model' }, ratio: 0.5 });
        return fake(req, dctx);
      },
    });
    await reconstructFromViews(inputs, { resolution: 48 }, c);
    const ratios = c.progress.map((p) => p.ratio ?? 0);
    for (let i = 1; i < ratios.length; i++) expect(ratios[i]).toBeGreaterThanOrEqual(ratios[i - 1]);
    expect(c.progress.some((p) => p.label.en.startsWith('Depth: back (2/2) · Loading model'))).toBe(true);
    expect(c.progress.every((p) => p.label.tr && p.label.en)).toBe(true);
  });

  it('aborts before starting, between stages and during depth estimation', async () => {
    const { inputs } = renderViews([sphere([0, 0, 0], 1)], ['front', 'back'], { width: 64, height: 64, scale: 25 });
    const pre = new AbortController();
    pre.abort();
    await expect(reconstructFromViews(inputs, {}, ctx({ signal: pre.signal }))).rejects.toBeInstanceOf(AbortError);

    const mid = new AbortController();
    let calls = 0;
    const between = reconstructFromViews(inputs, { resolution: 48 }, ctx({
      signal: mid.signal,
      yieldControl: async () => {
        if (++calls === 3) mid.abort();
      },
    }));
    await expect(between).rejects.toBeInstanceOf(AbortError);

    const during = new AbortController();
    const estimateDepth: DepthEstimator = (_req, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new AbortError()));
      during.abort();
    });
    await expect(reconstructFromViews(inputs, {}, ctx({ signal: during.signal, estimateDepth }))).rejects.toBeInstanceOf(AbortError);
  });

  it('yields inside long stages and aborts there, before the stage ends', async () => {
    const { inputs } = renderViews([sphere([0, 0, 0], 1)], ['front', 'left'], { width: 96, height: 96, scale: 40 });
    const ac = new AbortController();
    const labels: string[] = [];
    let inBlur = 0;
    const c = ctx({
      signal: ac.signal,
      sliceMs: 0,
      onProgress: (p) => labels.push(p.label.en),
      yieldControl: async () => {
        // The stage's own yield is the first one after its label; abort at the third slice inside it.
        if (labels.at(-1) === FUSION_TEXT.smoothVolume.en && ++inBlur === 4) ac.abort();
      },
    });
    await expect(reconstructFromViews(inputs, { resolution: 64 }, c)).rejects.toBeInstanceOf(AbortError);
    expect(inBlur).toBe(4);
    expect(labels.at(-1)).toBe(FUSION_TEXT.smoothVolume.en);

    // Without an abort, every stage yields many times at sliceMs 0.
    let ticks = 0;
    const done = await reconstructFromViews(inputs, { resolution: 64 }, ctx({ sliceMs: 0, yieldControl: async () => void ticks++ }));
    expect(done.info.triangles).toBeGreaterThan(0);
    expect(ticks).toBeGreaterThan(200);
  });

  it('rejects a missing front, a lone front and views that do not overlap', async () => {
    const s = [sphere([0, 0, 0], 1)];
    const back = renderView(s, 'back');
    await expect(reconstructFromViews([{ id: 'back', image: back.image, mask: null }], {}, ctx())).rejects.toMatchObject({ i18n: FUSION_TEXT.noFront });
    const front = renderView(s, 'front');
    await expect(reconstructFromViews([{ id: 'front', image: front.image, mask: null }], {}, ctx())).rejects.toMatchObject({ i18n: FUSION_TEXT.needViews });
    // Front: blobs at world (−X, +Y) and (+X, −Y); back (mirrored): at world (+X, +Y) and (−X, −Y).
    const blobs: Solid = [box([-1, 0.6, -0.2], [-0.6, 1, 0.2]), box([0.6, -1, -0.2], [1, -0.6, 0.2])];
    const f = renderView(blobs, 'front', { width: 96, height: 96, scale: 40 });
    const b = renderView(blobs, 'front', { width: 96, height: 96, scale: 40 }); // same picture used as the back
    await expect(reconstructFromViews(
      [{ id: 'front', image: f.image, mask: null }, { id: 'back', image: b.image, mask: null }],
      { hull: 'strict' },
      ctx(),
    )).rejects.toMatchObject({ i18n: FUSION_TEXT.empty });
  });

  it('accepts explicit masks and opaque images on a plain background', async () => {
    const s = [sphere([0, 0, 0], 1)];
    const f = renderView(s, 'front', { width: 96, height: 96, scale: 40, background: [255, 255, 255] });
    const l = renderView(s, 'left', { width: 96, height: 96, scale: 40, background: [255, 255, 255] });
    const r = await reconstructFromViews(
      [{ id: 'front', image: f.image, mask: f.mask }, { id: 'left', image: l.image, mask: null }],
      { resolution: 64 },
      ctx(),
    );
    expect(computeMeshStats(r.geometry).watertight).toBe(true);
    const { size } = bounds(r.geometry);
    expect(size[2]).toBeGreaterThan(1.9); // the border-flood mask of the left view found the disk
  });

  it('runs 144³ in a few seconds', async () => {
    const t0 = performance.now();
    const r = await run([box([-1, -1, -1], [1, 1, 1])], ['front', 'left', 'top'], { resolution: 144 }, false, 400);
    const ms = performance.now() - t0;
    expect(r.info.grid[0]).toBeGreaterThanOrEqual(144);
    expect(computeMeshStats(r.geometry).watertight).toBe(true);
    expect(ms).toBeLessThan(8000);
  }, 20000);
});

describe('sanitizeFusionOptions', () => {
  it('fills defaults and clamps ranges', () => {
    const o = sanitizeFusionOptions({ resolution: 9999, tolerance: -1, depthStrength: 3, hull: 'x' as never, smoothIterations: 2.6 });
    expect(o.resolution).toBe(320);
    expect(o.tolerance).toBe(0);
    expect(o.depthStrength).toBe(1);
    expect(o.hull).toBe('tolerant');
    expect(o.smoothIterations).toBe(3);
    expect(sanitizeFusionOptions({ resolution: NaN }).resolution).toBe(144);
  });
});
