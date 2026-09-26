import { describe, expect, it } from 'vitest';
import {
  convexHull,
  coverage,
  cropRGBA,
  domeProfile,
  featherWeights,
  heightBuffer,
  insidePolygon,
  rasterFan,
  rasterTriangle,
  regionAround,
  stampCapsule,
  stampEllipse,
} from './raster';

describe('raster', () => {
  it('clamps regions to the image', () => {
    expect(regionAround(-5, 2, 10, 8, 2, 20, 20)).toEqual({ x0: 0, y0: 0, width: 12, height: 10 });
    expect(regionAround(30, 30, 40, 40, 1, 20, 20)).toBeNull();
  });

  it('rasterises a triangle with interpolated height and max-combine', () => {
    const r = { x0: 10, y0: 10, width: 20, height: 20 };
    const buf = heightBuffer(r);
    rasterTriangle(r, buf, { x: 10, y: 10, h: 0 }, { x: 30, y: 10, h: 20 }, { x: 10, y: 30, h: 0 });
    // h = x - 10 on this triangle
    expect(buf[(12 - 10) * 20 + (15 - 10)]).toBeCloseTo(5.5, 5);
    expect(buf[(28 - 10) * 20 + (28 - 10)]).toBe(-Infinity); // outside the hypotenuse
    rasterTriangle(r, buf, { x: 10, y: 10, h: 100 }, { x: 30, y: 10, h: 100 }, { x: 10, y: 30, h: 100 });
    expect(buf[(12 - 10) * 20 + (15 - 10)]).toBe(100);
    rasterTriangle(r, buf, { x: 10, y: 10, h: -5 }, { x: 30, y: 10, h: -5 }, { x: 10, y: 30, h: -5 });
    expect(buf[(12 - 10) * 20 + (15 - 10)]).toBe(100);
  });

  it('fans a polygon without cracks', () => {
    const r = { x0: 0, y0: 0, width: 20, height: 20 };
    const buf = heightBuffer(r);
    const sq = [{ x: 2, y: 2, h: 1 }, { x: 18, y: 2, h: 1 }, { x: 18, y: 18, h: 1 }, { x: 2, y: 18, h: 1 }];
    rasterFan(r, buf, sq, { x: 10, y: 10, h: 1 });
    const cov = coverage(buf, r);
    let n = 0;
    for (const v of cov.data) n += v;
    expect(n).toBe(16 * 16);
  });

  it('stamps capsules with a round cross-section', () => {
    const r = { x0: 0, y0: 0, width: 40, height: 20 };
    const buf = heightBuffer(r);
    stampCapsule(r, buf, { x: 5, y: 10, h: 0 }, { x: 35, y: 10, h: 0 }, 5, 5);
    const at = (x: number, y: number) => buf[y * 40 + x];
    expect(at(20, 9)).toBeCloseTo(Math.sqrt(25 - 0.25), 5); // pixel centre 0.5 px off the axis
    expect(at(20, 12)).toBeCloseTo(Math.sqrt(25 - 2.5 ** 2), 5);
    expect(at(20, 9)).toBeGreaterThan(at(20, 12));
    expect(at(20, 16)).toBe(-Infinity);
  });

  it('stamps ellipses with a height function and coverage', () => {
    const r = { x0: 0, y0: 0, width: 30, height: 30 };
    const buf = heightBuffer(r);
    const cov = new Float32Array(900);
    stampEllipse(r, buf, { x: 15, y: 15 }, { x: 1, y: 0 }, 10, 5, (_u, _v, rho) => 1 - rho, cov, () => 0.5);
    expect(buf[14 * 30 + 14]).toBeGreaterThan(0.85);
    expect(buf[14 * 30 + 23]).toBeGreaterThan(0); // inside along the long axis
    expect(buf[21 * 30 + 14]).toBe(-Infinity); // outside along the short axis
    expect(cov[14 * 30 + 14]).toBe(0.5);
  });

  it('feathers coverage edges except at open image borders', () => {
    const cov = { width: 20, height: 20, data: new Uint8Array(400).fill(1) };
    const closed = featherWeights(cov, 4);
    expect(closed[0]).toBeLessThan(0.2);
    expect(closed[10 * 20 + 10]).toBe(1);
    const open = featherWeights(cov, 4, { left: true, top: true, right: false, bottom: false });
    expect(open[0]).toBe(1);
    expect(open[19 * 20 + 19]).toBeLessThan(0.2);
  });

  it('domes coverage from border to centre', () => {
    const cov = { width: 21, height: 21, data: new Uint8Array(441).fill(1) };
    const d = domeProfile(cov);
    expect(d[10 * 21 + 10]).toBeCloseTo(1, 5);
    expect(d[0]).toBeLessThan(d[10 * 21 + 5]);
  });

  it('computes convex hulls and point-in-polygon', () => {
    const hull = convexHull([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 1 }, { x: 4, y: 4 }, { x: 0, y: 4 }, { x: 2, y: 2 }]);
    expect(hull).toHaveLength(4);
    expect(insidePolygon(2, 2, hull)).toBe(true);
    expect(insidePolygon(5, 2, hull)).toBe(false);
  });

  it('crops RGBA regions', () => {
    const img = { width: 4, height: 3, data: new Uint8ClampedArray(48) };
    for (let i = 0; i < 12; i++) img.data[i * 4] = i;
    const c = cropRGBA(img, { x: 1, y: 1, width: 2, height: 2 });
    expect(c.width).toBe(2);
    expect([...c.data].filter((_, i) => i % 4 === 0)).toEqual([5, 6, 9, 10]);
  });
});
