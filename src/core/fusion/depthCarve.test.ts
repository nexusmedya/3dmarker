import { describe, expect, it } from 'vitest';
import type { DepthMap, Mask, RGBAImage } from '../types';
import { maskBBox, VIEW_FRAMES, viewProjection, type PreparedView } from './frame';
import { applyCarve, carveTargets, silhouetteDepth } from './depthCarve';
import { buildHull, createGrid, rayCrossings, rayTToWorld } from './volume';

function maskOf(w: number, h: number, inside: (x: number, y: number) => boolean): Mask {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = inside(x + 0.5, y + 0.5) ? 1 : 0;
  return { width: w, height: h, data };
}

const constant = (w: number, h: number, v: number): DepthMap => ({ width: w, height: h, data: new Float32Array(w * h).fill(v) });
const blank = (w: number, h: number): RGBAImage => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });

function view(id: PreparedView['id'], mask: Mask): PreparedView {
  return { id, frame: VIEW_FRAMES[id], image: blank(mask.width, mask.height), mask, maskSource: 'given', bbox: maskBBox(mask)! };
}

/** 20³ cube box seen from the front (full square), plus an optional side view. */
function setup(side?: Mask) {
  const full = maskOf(20, 20, () => true);
  const views = [view('front', full), ...(side ? [view('left', side)] : [])];
  const size: [number, number, number] = [20, 20, 20];
  const grid = createGrid(size, 20, 2);
  const field = buildHull(views, { size, depthFrom: side ? 'side' : 'default' }, grid, { hull: 'strict', tolerance: 0 });
  const proj = viewProjection(views[0], size);
  return { field, grid, proj, mask: full, rect: { x0: 0, y0: 0, x1: 20, y1: 20 } };
}

/** World Z of the first surface along the central front ray. */
function frontSurfaceZ(field: Float32Array, grid: ReturnType<typeof createGrid>, proj: ReturnType<typeof setup>['proj']): number {
  const [nx, ny, nz] = grid.dims;
  const a = Math.floor(nx / 2), b = Math.floor(ny / 2);
  const start = a + nx * (b + ny * (nz - 1));
  const out = new Float64Array(2);
  expect(rayCrossings(field, start, -nx * ny, nz, 0.5, out)).toBe(true);
  return rayTToWorld(grid, proj, out[0]);
}

describe('depth carving', () => {
  it("'object' fit: d = 0.5 at strength 1 puts the surface halfway between the box face and the centre", () => {
    const { field, grid, proj, mask, rect } = setup();
    expect(frontSurfaceZ(field, grid, proj)).toBeCloseTo(10, 1);
    const t = carveTargets(field, grid, proj, mask, { depth: constant(20, 20, 0.5), rect }, { strength: 1, fit: 'object', halfExtent: 10 });
    applyCarve(field, grid, proj, t);
    expect(frontSurfaceZ(field, grid, proj)).toBeCloseTo(5, 1);
  });

  it("'ray' fit scales to the ray's own interval; 'object' fit stops at its middle", () => {
    // Side (left) view: full depth in the upper half, only the front half (z > 0, image x < 10) in the lower half.
    const side = maskOf(20, 20, (x, y) => y < 10 || x < 10);
    const full = maskOf(20, 20, () => true);
    const size: [number, number, number] = [20, 20, 20];
    const views = [view('front', full), view('left', side)];
    const grid = createGrid(size, 20, 2);
    const proj = viewProjection(views[0], size);
    const hull = () => buildHull(views, { size, depthFrom: 'side' }, grid, { hull: 'strict', tolerance: 0 });
    // World Z of the first surface on the front ray through world (0, y).
    const surfaceAt = (field: Float32Array, y: number) => {
      const [nx, ny, nz] = grid.dims;
      const a = Math.floor(nx / 2), b = Math.round((y - grid.origin[1]) / grid.spacing);
      const out = new Float64Array(2);
      expect(rayCrossings(field, a + nx * (b + ny * (nz - 1)), -nx * ny, nz, 0.5, out)).toBe(true);
      return rayTToWorld(grid, proj, out[0]);
    };
    const carve = (fit: 'ray' | 'object') => {
      const f = hull();
      applyCarve(f, grid, proj, carveTargets(f, grid, proj, full, { depth: constant(20, 20, 0), rect: { x0: 0, y0: 0, x1: 20, y1: 20 } }, { strength: 1, fit, halfExtent: 10 }));
      return f;
    };
    const ray = carve('ray'), obj = carve('object');
    // Lower half (y = −5): the interval is z ∈ [0, 10]; upper half (y = 5): z ∈ [−10, 10].
    expect(surfaceAt(ray, -5.5)).toBeCloseTo(5, 0);
    expect(surfaceAt(ray, 5.5)).toBeCloseTo(0, 0);
    expect(surfaceAt(obj, -5.5)).toBeCloseTo(5, 0); // capped at the middle of [0, 10] (uncapped: 0 = erased)
    expect(surfaceAt(obj, 5.5)).toBeCloseTo(0, 0);
  });

  it('never adds material, and leaves rays outside the view silhouette alone', () => {
    const { field, grid, proj, rect } = setup();
    const before = field.slice();
    const near = carveTargets(field, grid, proj, maskOf(20, 20, () => true), { depth: constant(20, 20, 1), rect }, { strength: 1, fit: 'object', halfExtent: 10 });
    applyCarve(field, grid, proj, near);
    expect(field).toEqual(before);
    const off = carveTargets(field, grid, proj, maskOf(20, 20, () => false), { depth: constant(20, 20, 0), rect }, { strength: 1, fit: 'object', halfExtent: 10 });
    expect(off.every((v) => Number.isNaN(v))).toBe(true);
    const zero = carveTargets(field, grid, proj, maskOf(20, 20, () => true), { depth: constant(20, 20, 0), rect }, { strength: 0, fit: 'object', halfExtent: 10 });
    expect(zero.every((v) => Number.isNaN(v))).toBe(true);
  });

  it('reads depth maps of another resolution through the crop rectangle', () => {
    const { field, grid, proj, mask } = setup();
    // A 5×5 map for the right half of the image only: d = 0 there.
    const t = carveTargets(field, grid, proj, mask, { depth: constant(5, 5, 0), rect: { x0: 10, y0: 0, x1: 20, y1: 20 } }, { strength: 1, fit: 'object', halfExtent: 10 });
    const nu = grid.dims[0];
    const row = Math.floor(grid.dims[1] / 2);
    expect(Number.isNaN(t[4 + nu * row])).toBe(true); // left half: outside the rect
    expect(t[nu - 5 + nu * row]).toBeGreaterThan(0);
  });
});

describe('silhouetteDepth', () => {
  it('inflates a disk into a hemisphere profile', () => {
    const R = 30, S = 2 * R + 10, C = S / 2;
    const d = silhouetteDepth(maskOf(S, S, (x, y) => (x - C) ** 2 + (y - C) ** 2 <= R * R));
    const at = (x: number, y: number) => d.data[Math.floor(y) * S + Math.floor(x)];
    expect(at(C, C)).toBeCloseTo(1, 1);
    for (const r of [10, 20]) expect(Math.abs(at(C + r, C) - Math.sqrt(1 - (r / R) ** 2))).toBeLessThan(0.05);
    expect(at(1, 1)).toBe(0);
  });
});
