import { describe, expect, it } from 'vitest';
import type { Mask, RGBAImage } from '../types';
import { maskBBox, VIEW_FRAMES, viewProjection, type PreparedView } from './frame';
import { bleedImage, dilateMask, SummedArea } from './silhouette';
import {
  buildHull,
  clearBorder,
  countSurfaceCells,
  coverageTable,
  createGrid,
  downsample,
  forEachRay,
  gaussianBlur3D,
  gaussianKernel,
  rayCrossings,
  rayTToWorld,
  worldToRayT,
  type Grid,
} from './volume';

function maskOf(w: number, h: number, inside: (x: number, y: number) => boolean): Mask {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = inside(x + 0.5, y + 0.5) ? 1 : 0;
  return { width: w, height: h, data };
}

const blank = (w: number, h: number): RGBAImage => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });

function view(id: PreparedView['id'], mask: Mask): PreparedView {
  return { id, frame: VIEW_FRAMES[id], image: blank(mask.width, mask.height), mask, maskSource: 'given', bbox: maskBBox(mask)! };
}

const sum = (a: ArrayLike<number>) => Array.from(a).reduce((s, v) => s + v, 0);

describe('SummedArea', () => {
  const m = maskOf(4, 4, (x, y) => x > 2 && y > 2); // bottom-right 2×2 block

  it('integrates exactly over fractional rectangles', () => {
    const s = new SummedArea(m);
    expect(s.integral(4, 4)).toBe(4);
    expect(s.integral(2.5, 2.5)).toBeCloseTo(0.25, 10);
    expect(s.coverage(2, 2, 4, 4)).toBe(1);
    expect(s.coverage(0, 0, 2, 2)).toBe(0);
    expect(s.coverage(1.5, 1.5, 2.5, 2.5)).toBeCloseTo(0.25, 10);
    expect(s.coverage(3, 3, 5, 5)).toBeCloseTo(0.25, 10); // outside the image counts as background
    expect(s.coverage(1, 1, 1, 3)).toBe(0); // zero area
  });
});

describe('dilateMask', () => {
  it('grows a single pixel into a disk of the given radius, not leaking from the image border', () => {
    const m = maskOf(21, 21, (x, y) => Math.floor(x) === 10 && Math.floor(y) === 10);
    const d = dilateMask(m, 3);
    expect(d.data[10 * 21 + 13]).toBe(1);
    expect(d.data[10 * 21 + 14]).toBe(0);
    expect(d.data[12 * 21 + 12]).toBe(1); // √8 ≤ 3
    expect(d.data[13 * 21 + 13]).toBe(0); // √18 > 3
    expect(d.data[0]).toBe(0);
    expect(sum(dilateMask(m, 0).data)).toBe(1);
  });
});

describe('bleedImage', () => {
  it('fills the background with the nearest foreground colour, opaque', () => {
    const img: RGBAImage = { width: 3, height: 1, data: new Uint8ClampedArray([0, 0, 0, 0, 200, 10, 20, 255, 0, 0, 0, 0]) };
    const out = bleedImage(img, { width: 3, height: 1, data: new Uint8Array([0, 1, 0]) });
    expect(Array.from(out.data)).toEqual([200, 10, 20, 255, 200, 10, 20, 255, 200, 10, 20, 255]);
  });
});

describe('grid', () => {
  it('centres the grid on the box with padding and the requested resolution on the longest side', () => {
    const g = createGrid([100, 50, 25], 40, 3);
    expect(g.spacing).toBe(2.5);
    expect(g.dims).toEqual([46, 26, 16]);
    for (let a = 0; a < 3; a++) expect(g.origin[a] + ((g.dims[a] - 1) / 2) * g.spacing).toBeCloseTo(0, 10);
  });

  it('converts between ray t and world coordinates in both camera directions', () => {
    const g = createGrid([10, 10, 10], 10, 1);
    const fromPlus = { wa: 2 as const, ws: 1 as const }, fromMinus = { wa: 2 as const, ws: -1 as const };
    expect(rayTToWorld(g, fromPlus, 0)).toBeCloseTo(g.origin[2] + (g.dims[2] - 1) * g.spacing);
    expect(rayTToWorld(g, fromMinus, 0)).toBeCloseTo(g.origin[2]);
    expect(worldToRayT(g, fromPlus, rayTToWorld(g, fromPlus, 3.25))).toBeCloseTo(3.25);
    expect(worldToRayT(g, fromMinus, rayTToWorld(g, fromMinus, 7.5))).toBeCloseTo(7.5);
  });

  it('walks every ray from the camera side', () => {
    const g: Grid = { dims: [3, 4, 5], spacing: 1, origin: [0, 0, 0] };
    const starts: number[] = [];
    forEachRay(g, { ua: 0, va: 1, wa: 2, ws: 1 }, (a, b, start, step, n) => {
      expect(n).toBe(5);
      expect(step).toBe(-12);
      expect(start).toBe(a + 3 * b + 4 * 12);
      starts.push(start);
    });
    expect(starts).toHaveLength(12);
  });
});

describe('visual hull', () => {
  it('computes voxel coverage of a view', () => {
    const front = view('front', maskOf(40, 40, (x) => x < 20)); // the left half of a 40×40 view
    // Box 40 × 40 × 40, one voxel per 10 px.
    const g = createGrid([40, 40, 40], 4, 0);
    const t = coverageTable(viewProjection(front, [40, 40, 40]), g, new SummedArea(front.mask));
    expect(Array.from(t.slice(0, 4))).toEqual([1, 1, 1, 1]); // bbox = the silhouette → the whole face
  });

  it('intersects the silhouettes of front, side and top views', () => {
    // A disk from the front, squares from the side and top: a cylinder along Z.
    const disk = maskOf(40, 40, (x, y) => (x - 20) ** 2 + (y - 20) ** 2 <= 400);
    const square = maskOf(40, 40, () => true);
    const views = [view('front', disk), view('left', square), view('top', square)];
    const g = createGrid([40, 40, 40], 40, 2);
    const f = buildHull(views, { size: [40, 40, 40], depthFrom: 'side' }, g, { hull: 'strict', tolerance: 0 });
    const vol = sum(f) * g.spacing ** 3;
    expect(vol / (Math.PI * 400 * 40)).toBeCloseTo(1, 1);
    // The border stays empty.
    expect(f[0]).toBe(0);
    expect(f[f.length - 1]).toBe(0);
  });

  it('bounds Z by the box when only front/back are given, and dilates non-front views in tolerant mode', () => {
    const sq = maskOf(20, 20, () => true);
    const g = createGrid([20, 20, 10], 20, 2);
    const f = buildHull([view('front', sq), view('back', sq)], { size: [20, 20, 10], depthFrom: 'default' }, g, { hull: 'strict', tolerance: 0 });
    expect(sum(f)).toBeCloseTo(20 * 20 * 10, 0);
    // A back view with a notch: strict carves it, tolerant (dilation) fills it back in.
    const notched = maskOf(40, 40, (x, y) => !(x > 18 && x < 22 && y > 18 && y < 22));
    const full = maskOf(40, 40, () => true);
    const g2 = createGrid([40, 40, 20], 40, 2);
    const box = { size: [40, 40, 20] as [number, number, number], depthFrom: 'default' as const };
    const strict = sum(buildHull([view('front', full), view('back', notched)], box, g2, { hull: 'strict', tolerance: 0.05 }));
    const tolerant = sum(buildHull([view('front', full), view('back', notched)], box, g2, { hull: 'tolerant', tolerance: 0.05 }));
    expect(tolerant).toBeCloseTo(40 * 40 * 20, 0);
    expect(strict).toBeLessThan(tolerant - 200);
  });
});

describe('volume filters', () => {
  it('builds a normalised Gaussian kernel', () => {
    const k = gaussianKernel(1);
    expect(k.length).toBe(7);
    expect(sum(k)).toBeCloseTo(1, 6);
    expect(k[3]).toBeGreaterThan(k[2]);
  });

  it('blurs in place, preserving mass and symmetry', () => {
    const n = 15, dims: [number, number, number] = [n, n, n];
    const f = new Float32Array(n ** 3);
    const c = 7 + n * (7 + n * 7);
    f[c] = 1;
    gaussianBlur3D(f, dims, 1.2);
    expect(sum(f)).toBeCloseTo(1, 5);
    expect(f[c + 1]).toBeCloseTo(f[c - 1], 7);
    expect(f[c + n]).toBeCloseTo(f[c + 1], 7);
    expect(f[c + n * n]).toBeCloseTo(f[c + 1], 7);
    const before = f.slice();
    gaussianBlur3D(f, dims, 0);
    expect(f).toEqual(before);
  });

  it('downsamples with a zero border, keeping world positions', () => {
    const g: Grid = { dims: [8, 8, 8], spacing: 1, origin: [-3.5, -3.5, -3.5] };
    const f = new Float32Array(512);
    // Fine voxels 4..5 have centres at world 0.5 and 1.5: the coarse cell's centre is 1.
    for (let k = 4; k < 6; k++) for (let j = 4; j < 6; j++) for (let i = 4; i < 6; i++) f[i + 8 * (j + 8 * k)] = 1;
    const d = downsample(f, g, 2);
    expect(d.grid.dims).toEqual([6, 6, 6]);
    expect(d.grid.spacing).toBe(2);
    const at = d.field.findIndex((v) => v === 1);
    const I = at % 6;
    expect(d.grid.origin[0] + I * d.grid.spacing).toBeCloseTo(1, 10);
    expect(sum(d.field)).toBe(1);
    expect(downsample(f, g, 1).field).toBe(f);
  });

  it('counts surface cells and clears borders', () => {
    const f = new Float32Array(64).fill(1);
    clearBorder(f, [4, 4, 4]);
    expect(sum(f)).toBe(8);
    expect(countSurfaceCells(f, [4, 4, 4])).toBe(26); // all but the fully inside centre cube
  });

  it('finds ray crossings with sub-voxel accuracy', () => {
    const f = new Float32Array([0, 0.25, 0.75, 1, 1, 0.5, 0, 0]);
    const out = new Float64Array(2);
    expect(rayCrossings(f, 0, 1, 8, 0.5, out)).toBe(true);
    expect(out[0]).toBeCloseTo(1.5);
    expect(out[1]).toBeCloseTo(5);
    expect(rayCrossings(f, 7, -1, 8, 0.5, out)).toBe(true); // reversed walk: t from the other end
    expect(out[0]).toBeCloseTo(2);
    expect(rayCrossings(new Float32Array(4), 0, 1, 4, 0.5, out)).toBe(false);
  });
});
