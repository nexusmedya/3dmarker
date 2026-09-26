import { describe, expect, it } from 'vitest';
import type { ViewId } from '../types';
import { estimateObjectBox, prepareView } from './frame';
import { registerViews } from './align';
import { buildGuard, GUARD_FILL, GuardField, localThickness } from './guard';
import { buildHullPlanesSteps, createGrid } from './volume';
import { drain } from './steps';
import { renderCharacterViews, renderViews, sphere } from './testing';
import { distanceTransform, unionOfSpheres } from '../image/distance';

function hullOf(inputs: ReturnType<typeof renderCharacterViews>['inputs'], resolution = 144) {
  const views = inputs.map((i) => prepareView(i)!);
  registerViews(views, { mode: 'auto' });
  const box = estimateObjectBox(views, 0.5);
  const grid = createGrid(box.size, resolution, 6);
  const { field, planes } = drain(buildHullPlanesSteps(views, box, grid, { hull: 'tolerant', tolerance: 0.02 }));
  return { views, box, grid, field, planes };
}

describe('localThickness', () => {
  it('is the diameter of a disc everywhere on it, rim included, and the width of a bar', () => {
    const w = 64, h = 64, R = 12;
    const disc = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x + 0.5 - 32) ** 2 + (y + 0.5 - 32) ** 2 <= R * R) disc[y * w + x] = 1;
    const t = localThickness(disc, w, h);
    let min = Infinity, max = 0;
    for (let i = 0; i < t.length; i++) if (disc[i]) { min = Math.min(min, t[i]); max = Math.max(max, t[i]); }
    expect(max).toBeGreaterThan(2 * R - 2);
    expect(max).toBeLessThanOrEqual(2 * R + 1);
    expect(min).toBeGreaterThan(2 * R - 3); // the rim is painted by the centre's disc
    const bar = new Uint8Array(w * h);
    for (let y = 20; y < 26; y++) for (let x = 4; x < 60; x++) bar[y * w + x] = 1;
    const tb = localThickness(bar, w, h);
    for (let y = 20; y < 26; y++) for (let x = 10; x < 54; x++) expect(Math.abs(tb[y * w + x] - 6)).toBeLessThanOrEqual(1);
    expect(tb[0]).toBe(0);
  });
});

describe('thin-part guard', () => {
  const V4: ViewId[] = ['front', 'back', 'left', 'right'];

  it('adds nothing to a consistent character hull nor to a sphere, guards only thin columns', () => {
    const { box, grid, field, planes } = hullOf(renderCharacterViews(V4, { size: 512 }).inputs);
    const guard = buildGuard(planes, box, grid, { delta: 0.06, rho: GUARD_FILL });
    expect(guard.columns).toBeGreaterThan(1000);
    expect(guard.center.length).toBe(grid.dims[0] * grid.dims[1]); // two floats per column, no 3D buffer
    expect(guard.half.length).toBe(grid.dims[0] * grid.dims[1]);
    const before = field.slice();
    expect(guard.applyFloor(field)).toBe(0);
    let changed = 0;
    for (let i = 0; i < field.length; i++) if (field[i] !== before[i] && (field[i] > 0.5) !== (before[i] > 0.5)) changed++;
    expect(changed).toBe(0);
    // Bounds: half ≤ ρ·h3 and the tube lies inside the profile interval of its row.
    const [nx, ny, nz] = grid.dims;
    const bin = new Uint8Array(nx * ny);
    for (let c = 0; c < bin.length; c++) bin[c] = planes.xy[c] >= 0.5 ? 1 : 0;
    const h3 = unionOfSpheres(distanceTransform({ width: nx, height: ny, data: bin }), nx, ny);
    for (let j = 0; j < ny; j++) {
      let k0 = -1, k1 = -1;
      for (let k = 0; k < nz; k++) if (planes.zy[k + nz * j] >= 0.5) { if (k0 < 0) k0 = k; k1 = k; }
      for (let i = 0; i < nx; i++) {
        const c = i + nx * j;
        if (guard.half[c] <= 0) continue;
        expect(guard.half[c]).toBeLessThanOrEqual(GUARD_FILL * h3[c] + 1e-6);
        expect(guard.center[c] - guard.half[c]).toBeGreaterThanOrEqual(k0 - 0.5);
        expect(guard.center[c] + guard.half[c]).toBeLessThanOrEqual(k1 + 0.5);
      }
    }
    const s = renderViews([sphere([0, 0, 0], 1)], V4, { width: 160, height: 160, scale: 64 });
    const sph = hullOf(s.inputs, 96);
    const g2 = buildGuard(sph.planes, sph.box, sph.grid, { delta: 0.06, rho: GUARD_FILL });
    expect(g2.columns).toBe(0);
    expect(g2.applyFloor(sph.field)).toBe(0);
  });

  it('restores the arms a misregistered side view carved away', () => {
    const set = renderCharacterViews(V4, { size: 512, perturb: { left: { proportions: { armHeight: -0.06 } }, right: { proportions: { armHeight: -0.06 } } } });
    const { box, grid, field, planes } = hullOf(set.inputs);
    const guard = buildGuard(planes, box, grid, { delta: 0.06, rho: GUARD_FILL });
    // Any voxel the floor adds is within the front silhouette's thin columns.
    const added = guard.applyFloor(field);
    expect(added).toBeGreaterThanOrEqual(0);
    expect(guard.value(0, 0, 0)).toBe(0);
    const [nx, ny] = grid.dims;
    let inside = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (guard.half[i + nx * j] > 0) { expect(planes.xy[i + nx * j]).toBeGreaterThanOrEqual(0.5); inside++; }
    expect(inside).toBe(guard.columns);
  });

  it('places the tube by the other plane, or the box, where a plane says empty at a front part', () => {
    // A bar thin in Y across the front; the side plane puts it at k ∈ [8, 15]; the cap plane says nothing is there.
    const size: [number, number, number] = [40, 40, 20];
    const grid = createGrid(size, 40, 2);
    const [nx, ny, nz] = grid.dims;
    const xy = new Float32Array(nx * ny), zy = new Float32Array(nz * ny), xz = new Float32Array(nx * nz);
    for (let j = 20; j < 24; j++) for (let i = 6; i < 38; i++) xy[i + nx * j] = 1;
    for (let j = 20; j < 24; j++) for (let k = 8; k <= 15; k++) zy[k + nz * j] = 1;
    const box = { size, depthFrom: 'side' as const };
    const o = { delta: 0.1, rho: GUARD_FILL };
    const g = buildGuard({ xy, zy, xz, hasZY: true, hasXZ: true }, box, grid, o);
    expect(g.columns).toBeGreaterThan(0);
    const c = 20 + nx * 21;
    expect(g.half[c]).toBeGreaterThan(0);
    expect(g.center[c]).toBeCloseTo(11.5, 6); // the side plane's interval, not the cap's emptiness
    expect(g.center[c] - g.half[c]).toBeGreaterThanOrEqual(8 - 0.5);
    expect(g.center[c] + g.half[c]).toBeLessThanOrEqual(15 + 0.5);
    // Both planes empty: the box places it (the front shows the part, the profiles only say where along Z).
    const g2 = buildGuard({ xy, zy: new Float32Array(nz * ny), xz, hasZY: true, hasXZ: true }, box, grid, o);
    expect(g2.half[c]).toBeGreaterThan(0);
    expect(g2.center[c]).toBeCloseTo((nz - 1) / 2, 6);
    // The cap plane alone, empty: the box as well; present and non-empty: its interval.
    const g3 = buildGuard({ xy, zy, xz, hasZY: false, hasXZ: true }, box, grid, o);
    expect(g3.center[c]).toBeCloseTo((nz - 1) / 2, 6);
    for (let i = 6; i < 38; i++) for (let k = 4; k <= 6; k++) xz[i + nx * k] = 1;
    const g4 = buildGuard({ xy, zy, xz, hasZY: false, hasXZ: true }, box, grid, o);
    expect(g4.center[c]).toBeCloseTo(5, 6);
    // Disjoint planes: the side views decide.
    const g5 = buildGuard({ xy, zy, xz, hasZY: true, hasXZ: true }, box, grid, o);
    expect(g5.center[c]).toBeCloseTo(11.5, 6);
  });

  it('value() is a unit ramp around the centre, clipped by the box', () => {
    const grid = createGrid([10, 10, 10], 10, 1);
    const nx = grid.dims[0], ny = grid.dims[1];
    const center = new Float32Array(nx * ny), half = new Float32Array(nx * ny);
    const c = 3 + nx * 4;
    center[c] = 5.5;
    half[c] = 2;
    const zBox = new Float32Array(grid.dims[2]).fill(1);
    zBox[4] = 0.5;
    const g = new GuardField(grid, center, half, zBox, 1);
    expect(g.value(3, 4, 5)).toBe(1);
    expect(g.value(3, 4, 6)).toBe(1);
    expect(g.value(3, 4, 7)).toBe(1); // |7 − 5.5| = 1.5 → 2 − 1.5 + 0.5 = 1
    expect(g.value(3, 4, 8)).toBe(0); // 2 − 2.5 + 0.5 = 0
    expect(g.value(3, 4, 3)).toBe(0);
    expect(g.value(3, 4, 4)).toBe(0.5); // clipped by zBox
    expect(g.value(2, 4, 5)).toBe(0);
    const field = new Float32Array(nx * ny * grid.dims[2]);
    expect(g.applyFloor(field)).toBe(3); // k = 5..7 cross 0.5 (k = 4 only reaches 0.5)
    expect(field[3 + nx * (4 + ny * 4)]).toBe(0.5);
  });

  it('builds quickly', () => {
    const { box, grid, planes } = hullOf(renderCharacterViews(V4, { size: 512 }).inputs);
    buildGuard(planes, box, grid, { delta: 0.06, rho: GUARD_FILL });
    const t0 = performance.now();
    buildGuard(planes, box, grid, { delta: 0.06, rho: GUARD_FILL });
    expect(performance.now() - t0).toBeLessThan(150);
    const big = hullOf(renderCharacterViews(V4, { size: 512 }).inputs, 256);
    const t1 = performance.now();
    buildGuard(big.planes, big.box, big.grid, { delta: 0.06, rho: GUARD_FILL });
    expect(performance.now() - t1).toBeLessThan(500);
  }, 30000);
});
