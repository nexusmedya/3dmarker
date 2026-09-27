import { describe, expect, it, vi } from 'vitest';
import type { BufferGeometry } from 'three';
import type { Progress, ViewId } from '../types';
import { AbortError } from '../types';
import { LocalizedError } from '../errors';
import { computeMeshStats } from '../mesh/stats';
import { distanceTransform } from '../image/distance';
import { estimateObjectBox, viewProjection } from './frame';
import { DepthOfflineError, FUSION_TEXT, reconstructFromViews, sanitizeFusionOptions, viewWarning } from './reconstruct';
import { SRGB_TO_LINEAR } from './color';
import { LEGACY_FUSION_OPTIONS, type DepthEstimator, type FusionContext, type FusionOptions, type FusionViewInput } from './types';
import {
  box,
  characterTruth,
  containsPoint,
  cylinderX,
  cylinderY,
  fakeDepthEstimator,
  fieldIoU,
  independentArtistViews,
  measureField,
  reconstructWithField,
  renderCharacterViews,
  renderView,
  renderViews,
  sphere,
  VIEW_COLORS,
  CHARACTER_COLORS,
  type CharacterViews,
  type Solid,
  type ViewPerturbation,
} from './testing';

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
    // The back's silhouette only carves with hullBack: 'intersect' (excluded by default: it mirrors the front).
    const { geometry: g } = await reconstructFromViews(inputs, { hull: 'strict', resolution: 64, hullBack: 'intersect' }, ctx());
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
    // The dilation mechanism is what is tested: the back has to enter the hull (hullBack: 'intersect'),
    // which the default 'exclude' (the back mirrors the front) never lets it do.
    const opts: Partial<FusionOptions> = { resolution: 72, defaultDepth: 1, hullBack: 'intersect' };
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
    // The failure shows once on the depth line; later stage labels stay plain (the report carries it).
    const at = c.progress.findIndex((p) => p.label.en.includes(FUSION_TEXT.depthUnavailable.en));
    expect(c.progress[at].label.tr).toContain(FUSION_TEXT.depthUnavailable.tr);
    const after = c.progress.slice(at + 1);
    expect(after.length).toBeGreaterThan(3);
    const stages = Object.values(FUSION_TEXT).map((t) => t.en);
    for (const p of after) expect(stages).toContain(p.label.en);
  });

  it('says the depth model could not be downloaded in its own words, without the drivers\' advice', async () => {
    const { inputs } = renderViews([sphere([0, 0, 0], 1)], ['front', 'left', 'top'], { width: 96, height: 96, scale: 40 });
    const offline = await reconstructFromViews(inputs, { resolution: 48 }, ctx({ estimateDepth: async () => { throw new DepthOfflineError(); } }));
    expect(offline.info.warnings).toEqual([FUSION_TEXT.depthOffline]);
    for (const w of offline.info.warnings) {
      expect(w.tr).not.toMatch(/Siluet şişirme|\[/);
      expect(w.en).not.toMatch(/Silhouette inflate|\[/);
    }
    // A raw (unlocalised) error stays in the console: only the generic line.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = await reconstructFromViews(inputs, { resolution: 48 }, ctx({ estimateDepth: async () => { throw new Error('worker crashed'); } }));
    expect(raw.info.warnings).toEqual([FUSION_TEXT.depthUnavailable]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
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

  it('yields between the views while preparing and aligning them, and while building their colour sources', async () => {
    const set = renderCharacterViews(['front', 'back', 'left', 'right'], { size: 128 });
    const labels: string[] = [];
    const ticksIn: Record<string, number> = {};
    await reconstructFromViews(set.inputs, { resolution: 32 }, ctx({
      sliceMs: 0,
      onProgress: (p) => labels.push(p.label.en),
      yieldControl: async () => {
        const l = labels.at(-1)!;
        ticksIn[l] = (ticksIn[l] ?? 0) + 1;
      },
    }));
    // 4 preparations + the front's reference + 3 registrations, each with its profile searches.
    expect(ticksIn[FUSION_TEXT.prepare.en]).toBeGreaterThanOrEqual(4 + 1 + 3 * 3);
    expect(ticksIn[FUSION_TEXT.color.en]).toBeGreaterThanOrEqual(4 * 3);
  });

  it('rejects a missing front, a lone front and views that do not overlap', async () => {
    const s = [sphere([0, 0, 0], 1)];
    const back = renderView(s, 'back');
    await expect(reconstructFromViews([{ id: 'back', image: back.image, mask: null }], {}, ctx())).rejects.toMatchObject({ i18n: FUSION_TEXT.noFront });
    const front = renderView(s, 'front');
    await expect(reconstructFromViews([{ id: 'front', image: front.image, mask: null }], {}, ctx())).rejects.toMatchObject({ i18n: FUSION_TEXT.needViews });
    // Front: blobs at world (−X, +Y) and (+X, −Y); back (mirrored): at world (+X, +Y) and (−X, −Y).
    // The back only carves with hullBack: 'intersect'; by default it mirrors the front and is excluded.
    const blobs: Solid = [box([-1, 0.6, -0.2], [-0.6, 1, 0.2]), box([0.6, -1, -0.2], [1, -0.6, 0.2])];
    const f = renderView(blobs, 'front', { width: 96, height: 96, scale: 40 });
    const b = renderView(blobs, 'front', { width: 96, height: 96, scale: 40 }); // same picture used as the back
    await expect(reconstructFromViews(
      [{ id: 'front', image: f.image, mask: null }, { id: 'back', image: b.image, mask: null }],
      { hull: 'strict', hullBack: 'intersect', align: 'bbox' },
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
    const d = sanitizeFusionOptions({});
    expect([d.hullBack, d.calibration, d.guard, d.align]).toEqual(['exclude', 'anchored', 0.06, 'auto']);
    const n = sanitizeFusionOptions({ hullBack: 'x' as never, calibration: 'envelope', guard: 0.9, align: 'bbox' });
    expect([n.hullBack, n.calibration, n.guard, n.align]).toEqual(['exclude', 'envelope', 0.15, 'bbox']);
    expect(sanitizeFusionOptions({ guard: -1 }).guard).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Robust fusion of hand-made views: views drawn with their own framing,
// crops and proportions (src/core/fusion/testing.ts character fixtures),
// measured on the voxel grid against the analytic truth of the front's figure.

describe('robust fusion of hand-made views (integration)', () => {
  const V4: ViewId[] = ['front', 'back', 'left', 'right'];
  const SIZE = 512;
  type Fused = Awaited<ReturnType<typeof fuse>>;
  async function fuse(set: CharacterViews, opts: Partial<FusionOptions> = {}, depth = false) {
    const r = await reconstructWithField(set.inputs, opts, { estimateDepth: depth ? fakeDepthEstimator(set.renders) : null });
    const box = estimateObjectBox(r.views.filter((v) => v.trust === 'full'), sanitizeFusionOptions(opts).defaultDepth);
    const m = measureField(r.field, r.grid, characterTruth(set, r.views[0], box, r.grid));
    return { ...r, m };
  }
  const others = (p: ViewPerturbation, views: ViewId[] = V4) => Object.fromEntries(views.filter((v) => v !== 'front').map((v) => [v, p]));
  const consistent = () => renderCharacterViews(V4, { size: SIZE });
  const REPORTED = { back: { dy: 0.03, scale: 0.95, proportions: { armHeight: -0.03 } }, left: { dy: 0.03, scale: 0.95, proportions: { armHeight: -0.03 } } };
  const memo = new Map<string, Promise<Fused>>();
  const cached = (key: string, make: () => Promise<Fused>) => {
    if (!memo.has(key)) memo.set(key, make());
    return memo.get(key)!;
  };
  const A1 = () => cached('a1', () => fuse(consistent()));
  const A1_LEGACY = () => cached('a1-legacy', () => fuse(consistent(), LEGACY_FUSION_OPTIONS));
  const D1 = () => cached('d1', () => fuse(consistent(), {}, true));
  const warningsOf = (r: Fused) => r.info.warnings.map((w) => w.en);
  const sane = (r: Fused) => {
    expect(computeMeshStats(r.geometry).watertight).toBe(true);
    expect(r.info.report.views.length).toBe(r.info.views.length);
    expect(r.geometry.userData.fusion).toBe(r.info.report);
    expect(r.geometry.userData.multiview).toBe(r.info);
  };

  /** Share of a's occupied voxels that b occupies too. */
  const within = (a: Float32Array, b: Float32Array) => {
    let n = 0, k = 0;
    for (let i = 0; i < a.length; i++) if (a[i] > 0.5) {
      n++;
      if (b[i] > 0.5) k++;
    }
    return k / Math.max(1, n);
  };

  it('A1: keeps a consistent set as it was, with the guard armed but idle', async () => {
    const r = await A1(), legacy = await A1_LEGACY();
    sane(r);
    for (const k of ['arm', 'leg', 'torso', 'head'] as const) expect(r.m[k]).toBeGreaterThanOrEqual(0.99);
    // Without depth maps the arms, which the side views see end-on in front of the chest, are rounded
    // (GuardField.capHidden) instead of keeping the chest's depth: the one change, and it only removes.
    expect(within(r.field, legacy.field)).toBeGreaterThanOrEqual(0.99);
    expect(r.m.bloat).toBeLessThan(legacy.m.bloat - 0.2);
    expect(r.info.guardColumns).toBeGreaterThan(0);
    expect(r.info.warnings).toEqual([]);
    expect(r.info.alignment.map((a) => a.status)).toEqual(['bbox', 'aligned', 'aligned', 'aligned']);
    expect(r.info.alignment.every((a) => a.score >= 90)).toBe(true);
    expect(r.info.report.views.map((v) => v.trust)).toEqual(['full', 'full', 'full', 'full']);
    // Legacy options switch every new mechanism off.
    expect(legacy.info.alignment.every((a) => a.status === 'bbox')).toBe(true);
    expect(legacy.info.guardColumns).toBe(0);
    const strict = await fuse(consistent(), { hull: 'strict' }), strictLegacy = await fuse(consistent(), { ...LEGACY_FUSION_OPTIONS, hull: 'strict' });
    expect(within(strict.field, strictLegacy.field)).toBeGreaterThanOrEqual(0.99);
    // With depth maps nothing is capped: the consistent set is the legacy hull.
    const guardOff = await fuse(consistent(), { guard: 0 });
    expect(fieldIoU(guardOff.field, legacy.field)).toBeGreaterThanOrEqual(0.99);
  }, 60000);

  it('A7: without depth maps, T-pose arms seen end-on by the side views come out round, not as deep as the chest', async () => {
    const r = await A1(), legacy = await A1_LEGACY();
    const set = consistent(), ch = set.character;
    const armDepth = (f: Fused) => {
      const box = estimateObjectBox(f.views.filter((v) => v.trust === 'full'), 0.5);
      const t = characterTruth(set, f.views[0], box, f.grid);
      let z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < f.field.length; i++) {
        if (f.field[i] <= 0.5 || Math.abs(t.wx[i] - 0.37) > 0.01 || Math.abs(t.wy[i] - ch.armY) > 0.005) continue;
        z0 = Math.min(z0, t.wz[i]);
        z1 = Math.max(z1, t.wz[i]);
      }
      return z1 - z0;
    };
    const diameter = 2 * ch.proportions.armRadius;
    expect(armDepth(legacy)).toBeGreaterThan(2 * diameter); // ≈ 0.16: the chest's depth
    expect(armDepth(r)).toBeLessThanOrEqual(1.6 * diameter);
    expect(r.m.arm).toBeGreaterThanOrEqual(0.99);
    // A top view measures the arms itself: nothing to cap there.
    const withTop = await fuse(renderCharacterViews([...V4, 'top'], { size: SIZE }));
    expect(withTop.m.arm).toBeGreaterThanOrEqual(0.99);
  }, 60000);

  it('A2: knee-up back and side views keep the arms, the shoulders and the chest depth', async () => {
    const r = await fuse(renderCharacterViews(V4, { size: SIZE, perturb: others({ cropBottom: 0.28 }) }));
    const a1 = await A1();
    sane(r);
    expect(r.m.arm).toBeGreaterThanOrEqual(0.95);
    expect(Math.abs(r.m.widths[0] - a1.m.widths[0])).toBeLessThanOrEqual(0.02);
    expect(r.m.depths[0]).toBeLessThanOrEqual(0.16); // legacy: 0.21
    for (const id of ['back', 'left', 'right']) expect(warningsOf(r)).toContain(viewWarning(FUSION_TEXT.viewCropped, id as ViewId).en);
    expect(r.info.alignment.slice(1).every((a) => a.cut.bottom && a.status === 'aligned')).toBe(true);
  }, 30000);

  it('A3 / A6: lowered arms in the back, cut heads everywhere', async () => {
    const a3 = await fuse(renderCharacterViews(V4, { size: SIZE, perturb: { back: { proportions: { armHeight: -0.06 } } } }));
    expect(a3.m.arm).toBeGreaterThanOrEqual(0.98);
    const a6 = await fuse(renderCharacterViews(V4, { size: SIZE, perturb: others({ cropTop: 0.08 }) }));
    sane(a6);
    expect(a6.m.arm).toBeGreaterThanOrEqual(0.95);
    expect(a6.info.alignment.slice(1).every((a) => a.cut.top)).toBe(true);
  }, 30000);

  it.each([[1], [2], [3], [4], [5]])('A4: independent artists ±8 % seed %s keep their arms and at least the legacy IoU', async (seed) => {
    const r = await fuse(independentArtistViews(V4, seed, { size: SIZE }));
    const legacy = await fuse(independentArtistViews(V4, seed, { size: SIZE }), LEGACY_FUSION_OPTIONS);
    expect(r.m.arm).toBeGreaterThanOrEqual(0.98);
    expect(r.m.iou).toBeGreaterThanOrEqual(legacy.m.iou - 0.02);
  }, 30000);

  it('A5: the reported case (back + left, and + a shifted, scaled, cropped right)', async () => {
    const a = await fuse(renderCharacterViews(['front', 'back', 'left'], { size: SIZE, perturb: REPORTED }));
    const b = await fuse(renderCharacterViews(V4, { size: SIZE, perturb: { ...REPORTED, right: { dx: 0.03, scale: 1.05, cropBottom: 0.05 } } }));
    for (const r of [a, b]) {
      sane(r);
      expect(r.m.arm).toBeGreaterThanOrEqual(0.98);
      expect(r.m.leg).toBeGreaterThanOrEqual(0.98);
      expect(r.m.torso).toBeGreaterThanOrEqual(0.98);
    }
    expect(b.info.alignment.find((v) => v.id === 'right')!.cut.bottom).toBe(true);
    // Legacy loses most of the arms here with depth on (the reported failure).
    const legacy = await fuse(renderCharacterViews(V4, { size: SIZE, perturb: { ...REPORTED, right: { dx: 0.03, scale: 1.05, cropBottom: 0.05 } } }), LEGACY_FUSION_OPTIONS, true);
    expect(legacy.m.arm).toBeLessThan(0.5);
  }, 40000);

  it('D1 / D2: exact depth on consistent four and six views', async () => {
    const d1 = await D1();
    sane(d1);
    expect(d1.m.iou).toBeGreaterThanOrEqual(0.85);
    expect(d1.m.arm).toBeGreaterThanOrEqual(0.97);
    expect(d1.m.bloat).toBeLessThanOrEqual(0.18);
    expect(warningsOf(d1).some((w) => w.includes('does not quite match'))).toBe(false);
    expect(Object.values(d1.info.consistency).every((c) => c! < 0.25)).toBe(true);
    const d2 = await fuse(renderCharacterViews([...V4, 'top', 'bottom'], { size: SIZE }), {}, true);
    expect(d2.m.head).toBeGreaterThanOrEqual(0.95);
    expect(d2.m.leg).toBeGreaterThanOrEqual(0.95);
    expect(d2.m.iou).toBeGreaterThanOrEqual(0.9);
    // A consistent set is consistent whatever the number of views: no view's carve runs into the guard.
    expect(warningsOf(d2)).toEqual([]);
    expect(Object.values(d2.info.consistency).every((c) => c! < 0.1)).toBe(true);
    // Consistent sides stay consistent when only the caps are reframed (cut at both sides, scaled).
    const d2b = await fuse(renderCharacterViews([...V4, 'top', 'bottom'], { size: SIZE, perturb: { top: { scale: 0.8, dx: 0.04 }, bottom: { scale: 1.2, dy: 0.03 } } }), {}, true);
    expect(warningsOf(d2b).some((w) => w.includes('does not quite match'))).toBe(false);
    expect(Object.values(d2b.info.consistency).every((c) => c! < 0.1)).toBe(true);
  }, 60000);

  it('consistency and the carved field do not depend on the order of the views', async () => {
    const set = renderCharacterViews([...V4, 'top', 'bottom'], { size: SIZE, perturb: { left: { proportions: { armHeight: -0.06 } } } });
    const a = await fuse(set, {}, true);
    const shuffled: CharacterViews = { ...set, inputs: [set.inputs[0], ...set.inputs.slice(1).reverse()] };
    const b = await fuse(shuffled, {}, true);
    for (const id of Object.keys(a.info.consistency) as ViewId[]) expect(b.info.consistency[id]).toBeCloseTo(a.info.consistency[id]!, 12);
    expect(a.info.consistency.left).toBeGreaterThanOrEqual(0.25);
    expect(a.info.consistency.right).toBeLessThan(0.1);
    let maxDiff = 0;
    for (let i = 0; i < a.field.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a.field[i] - b.field[i]));
    expect(maxDiff).toBeLessThan(1e-6);
  }, 60000);

  it.each([[0.03], [0.08], [0.28]])('D3: cropBottom %s with depth keeps the arms', async (crop) => {
    const r = await fuse(renderCharacterViews(V4, { size: SIZE, perturb: others({ cropBottom: crop }) }), {}, true);
    expect(r.m.arm).toBeGreaterThanOrEqual(0.9);
    expect(r.m.iou).toBeGreaterThanOrEqual(0.75);
    // Registered crops are consistent with the front (the guard has nothing to block).
    expect(warningsOf(r).some((w) => w.includes('does not quite match'))).toBe(false);
  }, 30000);

  it.each([[-0.03], [-0.06], [-0.08]])('D4: arms %s everywhere but the front, with depth', async (armHeight) => {
    const r = await fuse(renderCharacterViews(V4, { size: SIZE, perturb: others({ proportions: { armHeight } }) }), {}, true);
    expect(r.m.arm).toBeGreaterThanOrEqual(0.85);
    expect(r.m.leg).toBeGreaterThanOrEqual(0.95);
    expect(r.m.torso).toBeGreaterThanOrEqual(0.95);
    expect(r.m.head).toBeGreaterThanOrEqual(0.95);
  }, 30000);

  it('D5 / D6: one lowered side, longer legs', async () => {
    const d5 = await fuse(renderCharacterViews(V4, { size: SIZE, perturb: { left: { proportions: { armHeight: -0.06 } } } }), {}, true);
    expect(d5.m.arm).toBeGreaterThanOrEqual(0.9);
    expect(d5.info.consistency.left).toBeGreaterThanOrEqual(0.25);
    expect(d5.info.consistency.right).toBeLessThan(0.25);
    expect(warningsOf(d5)).toEqual([viewWarning(FUSION_TEXT.viewInconsistent, 'left').en]);
    expect(d5.info.report.views.find((v) => v.id === 'left')!.notes.map((n) => n.code)).toContain('inconsistent');
    expect(d5.info.report.views.find((v) => v.id === 'right')!.notes.map((n) => n.code)).not.toContain('inconsistent');
    const d6 = await fuse(renderCharacterViews(V4, { size: SIZE, perturb: others({ proportions: { legLength: 1.08 } }) }), {}, true);
    expect(d6.m.arm).toBeGreaterThanOrEqual(0.9);
  }, 30000);

  it.each([[1, 0.08], [2, 0.08], [3, 0.08], [4, 0.08], [5, 0.08], [1, 0.12], [2, 0.12]])('D7: independent artists seed %s ±%s with depth', async (seed, spread) => {
    const r = await fuse(independentArtistViews(V4, seed, { size: SIZE, spread }), {}, true);
    expect(r.m.arm).toBeGreaterThanOrEqual(0.85);
    if (spread === 0.08) {
      expect(r.m.leg).toBeGreaterThanOrEqual(0.95);
      expect(r.m.iou).toBeGreaterThanOrEqual(0.8);
    }
  }, 30000);

  it('D8: the reported case with depth', async () => {
    for (const set of [
      renderCharacterViews(['front', 'back', 'left'], { size: SIZE, perturb: REPORTED }),
      renderCharacterViews(V4, { size: SIZE, perturb: { ...REPORTED, right: { dx: 0.03, scale: 1.05, cropBottom: 0.05 } } }),
    ]) {
      const r = await fuse(set, {}, true);
      sane(r);
      expect(r.m.arm).toBeGreaterThanOrEqual(0.85);
      expect(r.m.torso).toBeGreaterThanOrEqual(0.95);
      expect(r.m.leg).toBeGreaterThanOrEqual(0.95);
      expect(r.m.head).toBeGreaterThanOrEqual(0.95);
    }
  }, 40000);

  it('A1 costs at most a little more than the legacy pipeline', async () => {
    const set = consistent();
    const time = async (opts: Partial<FusionOptions>) => {
      let best = Infinity;
      for (let i = 0; i < 2; i++) {
        const t0 = performance.now();
        await reconstructFromViews(set.inputs, opts, ctx());
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    const legacy = await time(LEGACY_FUSION_OPTIONS);
    const current = await time({});
    expect(current).toBeLessThan(1.5 * legacy + 100);
  }, 60000);
});

describe('robust fusion: non-character subjects with depth', () => {
  const ALL6: ViewId[] = ['front', 'back', 'left', 'right', 'top', 'bottom'];
  const S = 256, SCALE = S * 0.38;

  /** IoU of the occupancy with an analytic solid drawn centred at SCALE px per unit (front frame = object frame here). */
  function solidIoU(solid: Solid, r: Awaited<ReturnType<typeof reconstructWithField>>, keep?: (p: [number, number, number]) => boolean): { iou: number; kept: number } {
    const front = r.views[0];
    const box = estimateObjectBox(r.views.filter((v) => v.trust === 'full'), 0.5);
    const proj = viewProjection(front, box.size);
    const [nx, ny, nz] = r.grid.dims;
    let inter = 0, truth = 0, occ = 0, keepTrue = 0, keepHit = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const X = r.grid.origin[0] + i * r.grid.spacing, Y = r.grid.origin[1] + j * r.grid.spacing, Z = r.grid.origin[2] + k * r.grid.spacing;
          const u = proj.ou + proj.su * X, v = proj.ov + proj.sv * Y;
          const p: [number, number, number] = [(u - S / 2) / SCALE, -(v - S / 2) / SCALE, Z / SCALE];
          const t = containsPoint(solid, p), o = r.field[i + nx * (j + ny * k)] > 0.5;
          if (t) truth++;
          if (o) occ++;
          if (t && o) inter++;
          if (keep && t && keep(p)) { keepTrue++; if (o) keepHit++; }
        }
    return { iou: inter / (truth + occ - inter), kept: keepTrue ? keepHit / keepTrue : 1 };
  }
  const run = (solid: Solid, views: ViewId[], opts: Partial<FusionOptions> = {}, depth = true) => {
    const { inputs, renders } = renderViews(solid, views, { width: S, height: S, scale: SCALE });
    return reconstructWithField(inputs, opts, { estimateDepth: depth ? fakeDepthEstimator(renders) : null });
  };

  it('sphere, mug handle, U-block cavity, plate', async () => {
    const sphereR = await run([sphere([0, 0, 0], 1)], ALL6);
    expect(solidIoU([sphere([0, 0, 0], 1)], sphereR).iou).toBeGreaterThanOrEqual(0.95); // legacy 0.92
    expect(sphereR.info.guardColumns).toBe(0);
    const mug: Solid = [cylinderY(0, 0, 0.55, -0.8, 0.8), cylinderX(0.3, 0, 0.07, 0.55, 0.95), cylinderX(-0.3, 0, 0.07, 0.55, 0.95), box([0.88, -0.37, -0.07], [1.02, 0.37, 0.07])];
    const mugR = await run(mug, ALL6), mugLegacy = await run(mug, ALL6, LEGACY_FUSION_OPTIONS);
    // The thin handle: its tubes survive whole; the 0.14-thick bar keeps ≥ 90 % (the guard tube is ρ = 0.9 of
    // its depth, and a thin plate has many surface voxels). Legacy calibration carves most of it away (≈ 0.28).
    expect(solidIoU(mug, mugR, (p) => p[0] > 0.6 && p[0] < 0.86).kept).toBeGreaterThanOrEqual(0.95);
    const handle = solidIoU(mug, mugR, (p) => p[0] > 0.6).kept;
    expect(handle).toBeGreaterThanOrEqual(0.9);
    expect(handle).toBeGreaterThanOrEqual(solidIoU(mug, mugLegacy, (p) => p[0] > 0.6).kept + 0.3);
    expect(computeMeshStats(mugR.geometry).watertight).toBe(true);
    const u: Solid = [box([-1, -0.6, -0.6], [-0.7, 0.6, 0.6]), box([0.7, -0.6, -0.6], [1, 0.6, 0.6]), box([-1, -0.6, -0.6], [1, 0.6, -0.3])];
    const uR = await run(u, ALL6);
    expect(solidIoU(u, uR).iou).toBeGreaterThanOrEqual(0.85); // the cavity is still carved
    const plate: Solid = [box([-1, -0.6, -0.03], [1, 0.6, 0.03])];
    const plateR = await run(plate, ALL6), plateLegacy = await run(plate, ALL6, LEGACY_FUSION_OPTIONS);
    expect(Math.abs(solidIoU(plate, plateR).iou - solidIoU(plate, plateLegacy).iou)).toBeLessThanOrEqual(0.01);
  }, 60000);

  it('front + back only: the balloon path is untouched', async () => {
    const a = await run([sphere([0, 0, 0], 1)], ['front', 'back'], {}, false);
    const b = await run([sphere([0, 0, 0], 1)], ['front', 'back'], LEGACY_FUSION_OPTIONS, false);
    expect(Math.abs(a.info.triangles / b.info.triangles - 1)).toBeLessThanOrEqual(0.05);
    expect(a.info.depth).toEqual({ front: 'silhouette', back: 'silhouette' });
  }, 30000);
});

describe('colour of thin parts seen end-on (visual-hull bleed)', () => {
  const V4: ViewId[] = ['front', 'back', 'left', 'right'];
  /** Shirt blue in linear RGB: the torso colour a side / top view shows behind the arm or the head. */
  const isBlue = (c: Float32Array, i: number) => c[i + 2] > 0.3 && c[i + 2] > 2 * c[i];
  async function blueShares(set: CharacterViews) {
    const { geometry: g } = await reconstructFromViews(set.inputs, {}, ctx());
    const p = attr(g, 'position'), c = attr(g, 'color');
    let maxX = 0, top = -Infinity, bottom = Infinity;
    for (let i = 0; i < p.length; i += 3) {
      maxX = Math.max(maxX, Math.abs(p[i]));
      top = Math.max(top, p[i + 1]);
      bottom = Math.min(bottom, p[i + 1]);
    }
    let hands = 0, handsBlue = 0, crown = 0, crownBlue = 0;
    for (let i = 0; i < p.length; i += 3) {
      if (Math.abs(p[i]) > 0.85 * maxX) {
        hands++;
        if (isBlue(c, i)) handsBlue++;
      }
      if (p[i + 1] > top - 0.08 * (top - bottom)) {
        crown++;
        if (isBlue(c, i)) crownBlue++;
      }
    }
    expect(hands).toBeGreaterThan(200);
    expect(crown).toBeGreaterThan(200);
    return { hands: handsBlue / hands, crown: crownBlue / crown };
  }

  it('keeps the hands skin-coloured with left / right views (arms seen end-on in front of the torso)', async () => {
    // Before: ≈ 39 % of the hand vertices took the shirt blue behind them in the side views.
    expect((await blueShares(renderCharacterViews(V4))).hands).toBeLessThan(0.05);
    const thicker = renderCharacterViews(V4, {
      perturb: { left: { proportions: { armRadius: 0.04, armHeight: 0.01 } }, right: { proportions: { armRadius: 0.04, armHeight: -0.01 } } },
    });
    expect((await blueShares(thicker)).hands).toBeLessThan(0.05);
  }, 60000);

  it('keeps the crown free of the shoulders a top view shows around the head, on hand-made sets too', async () => {
    // Before: front + back + top ≈ 19 % of the crown blue; five independent views ≈ 22 % hands, 6 % crown.
    const fbt = await blueShares(renderCharacterViews(['front', 'back', 'top']));
    expect(fbt.crown).toBeLessThan(0.02);
    const artists = await blueShares(independentArtistViews([...V4, 'top'], 7));
    expect(artists.hands).toBeLessThan(0.02);
    expect(artists.crown).toBeLessThan(0.02);
  }, 60000);
});

describe('colour across views that disagree (exposure, photo-consistency)', () => {
  const V4: ViewId[] = ['front', 'back', 'left', 'right'];
  const lin = (c: readonly number[]) => c.map((v) => SRGB_TO_LINEAR[v]);
  const SKIN = [lin(CHARACTER_COLORS.arm), lin(CHARACTER_COLORS.hand)];
  const BLUE = lin(CHARACTER_COLORS.torso);
  const near = (c: Float32Array, i: number, refs: number[][], tol = 0.08) => refs.some((r) => Math.hypot(c[i] - r[0], c[i + 1] - r[1], c[i + 2] - r[2]) < tol);
  /** Shares of the arm + hand vertices (|x| > 0.4 of the span) in the front's skin colours and of the mid-torso ones in its shirt blue. */
  async function shares(set: CharacterViews) {
    const { geometry: g } = await reconstructFromViews(set.inputs, {}, ctx());
    const p = attr(g, 'position'), c = attr(g, 'color');
    const { min, max } = bounds(g);
    const maxX = Math.max(-min[0], max[0]), H = max[1] - min[1];
    let arm = 0, armOk = 0, torso = 0, torsoOk = 0;
    for (let i = 0; i < p.length; i += 3) {
      const x = Math.abs(p[i]), y = (p[i + 1] - min[1]) / H;
      if (x > 0.4 * maxX) {
        arm++;
        if (near(c, i, SKIN)) armOk++;
      } else if (x < 0.12 * maxX && y > 0.5 && y < 0.7) {
        torso++;
        if (near(c, i, [BLUE])) torsoOk++;
      }
    }
    expect(arm).toBeGreaterThan(300);
    return { arm: armOk / arm, torso: torsoOk / torso };
  }

  it('matches every view\'s exposure / white balance to the front (independent artists, ±15 % per channel)', async () => {
    // Before: 40–57 % of the arm vertices and ≈ 50 % of the torso (its back half) off the front's colours.
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = await shares(independentArtistViews(V4, seed, { size: 512, tint: 0.15 }));
      expect(r.arm).toBeGreaterThanOrEqual(0.95);
    }
    const top = await shares(independentArtistViews([...V4, 'top'], 3, { size: 512, tint: 0.15 }));
    expect(top.arm).toBeGreaterThanOrEqual(0.95);
    expect(top.torso).toBeGreaterThanOrEqual(0.95);
  }, 120000);

  it('leaves consistent and untinted hand-made sets as they were', async () => {
    const c = await shares(renderCharacterViews(V4, { size: 512 }));
    expect(c.arm).toBeGreaterThanOrEqual(0.98);
    expect(c.torso).toBe(1);
    for (const seed of [1, 4]) {
      const r = await shares(independentArtistViews(V4, seed, { size: 512 }));
      expect(r.arm).toBeGreaterThanOrEqual(0.98);
      expect(r.torso).toBe(1);
    }
  }, 60000);

  it('drops a view\'s colour where the better-supported views contradict it, and keeps it where only it sees', async () => {
    // A grey sphere from all six sides, but the top view is painted red all over.
    const grey: [number, number, number] = [150, 150, 150];
    const { inputs, renders } = renderViews([sphere([0, 0, 0], 1)], ALL, { width: 160, height: 160, scale: 60, color: (_q, v) => (v === 'top' ? [220, 30, 30] : grey) });
    const redness = async () => {
      const { geometry: g } = await reconstructFromViews(inputs, { resolution: 64 }, ctx({ estimateDepth: fakeDepthEstimator(renders) }));
      const n = attr(g, 'normal'), c = attr(g, 'color');
      let diag = 0, diagRed = 0, pole = 0, poleRed = 0;
      for (let i = 0; i < n.length; i += 3) {
        const red = c[i] > 2 * c[i + 1];
        // The upper corners, where two grey views (front / back and a side) see the surface as well as the red top.
        if (n[i + 1] > 0.45 && Math.abs(n[i]) > 0.45 && Math.abs(n[i + 2]) > 0.45) {
          diag++;
          if (red) diagRed++;
        }
        if (n[i + 1] > 0.95) {
          pole++;
          if (red) poleRed++;
        }
      }
      return { diag: diagRed / diag, pole: poleRed / pole };
    };
    // Before: ≈ 47 % of those corners red (the views blended); now the two grey views outvote the top.
    const r = await redness();
    expect(r.diag).toBeLessThan(0.05);
    // Where only the top sees the surface, its colour stands.
    expect(r.pole).toBeGreaterThan(0.9);
  }, 30000);
});

describe('warnings for views in the wrong slot', () => {
  const V4: ViewId[] = ['front', 'back', 'left', 'right'];
  const set = renderCharacterViews(V4, { size: 256, withMask: true });
  const byId = (id: ViewId) => set.inputs.find((i) => i.id === id)!;
  const codesOf = (r: Awaited<ReturnType<typeof reconstructFromViews>>, id: ViewId) => r.info.report.views.find((v) => v.id === id)!.notes.map((n) => n.code);

  it('names a poor view and what to do about it (a side view placed far off by hand)', async () => {
    const off = { ...byId('left'), align: { mode: 'manual' as const, dx: 0, dy: 0.2, scale: 1, flipX: false, trust: 'full' as const } };
    const r = await reconstructFromViews([byId('front'), byId('back'), off, byId('right')], { resolution: 64 }, ctx());
    const left = r.info.alignment.find((a) => a.id === 'left')!;
    expect(left.level).toBe('poor');
    expect(r.info.warnings).toContainEqual(viewWarning(FUSION_TEXT.viewPoor, 'left', { score: String(left.score) }));
    expect(r.info.warnings.find((w) => w.tr.startsWith('Sol'))!.tr).toMatch(new RegExp(`%${left.score}.*Hizala`));
    expect(codesOf(r, 'left')[0]).toBe('poor');
    // Consistent views get neither.
    const ok = await reconstructFromViews(set.inputs, { resolution: 64 }, ctx());
    expect(ok.info.warnings).toEqual([]);
    expect(ok.info.report.views.every((v) => !v.notes.some((n) => n.code === 'poor'))).toBe(true);
  }, 30000);

  it('says why a side view in the top slot is poor: its proportions, and the same image as the left', async () => {
    const r = await reconstructFromViews([...set.inputs, { ...byId('left'), id: 'top' }], { resolution: 64 }, ctx());
    const top = r.info.alignment.find((a) => a.id === 'top')!;
    expect(top.level).toBe('poor');
    expect(top.trust).toBe('color');
    expect(codesOf(r, 'top').slice(0, 2).sort()).toEqual(['extent', 'sameImage']);
    const en = r.info.warnings.map((w) => w.en);
    expect(en).toContain(viewWarning(FUSION_TEXT.viewSameImage, 'top').en);
    expect(en).toContain(viewWarning(FUSION_TEXT.viewExtent, 'top').en);
    // Specific warnings replace the generic one, and the colour-only line.
    expect(en).not.toContain(viewWarning(FUSION_TEXT.viewPoor, 'top', { score: String(top.score) }).en);
    expect(en).not.toContain(viewWarning(FUSION_TEXT.viewColorOnly, 'top').en);
    // The left view it copies is untouched.
    expect(r.info.alignment.find((a) => a.id === 'left')!.level).toBe('good');
  }, 30000);

  it('warns about a front/back image in a side slot, a side view facing the wrong way and a duplicated front', async () => {
    const back = byId('back'), front = byId('front');
    const r = await reconstructFromViews([front, { ...front, id: 'back' }, { ...back, id: 'left' }, { ...byId('left'), id: 'right' }], { resolution: 64 }, ctx());
    const en = r.info.warnings.map((w) => w.en);
    expect(en).toContain(viewWarning(FUSION_TEXT.viewWrongSlot, 'left').en);
    expect(en).toContain(viewWarning(FUSION_TEXT.viewFacing, 'right').en);
    expect(en).toContain(viewWarning(FUSION_TEXT.viewDuplicate, 'back').en);
    expect(en).not.toContain(viewWarning(FUSION_TEXT.viewColorOnly, 'left').en); // the wrong-slot line says so
    expect(r.info.trust.left).toBe('color');
    expect(codesOf(r, 'left')[0]).toBe('wrongSlot');
  }, 30000);
});
