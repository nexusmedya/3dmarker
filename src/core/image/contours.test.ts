import { describe, expect, it } from 'vitest';
import type { Mask } from '../types';
import {
  findIntersectingRings, groupContours, pointInPolygon, polygonArea, segmentsIntersect, simplifyGroups,
  simplifyPolyline, traceContours, traceIsoContours, type Contour, type Point,
} from './contours';

function maskOf(w: number, h: number, inside: (x: number, y: number) => boolean): Mask {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = inside(x, y) ? 1 : 0;
  return { width: w, height: h, data };
}

const rect = (x0: number, y0: number, x1: number, y1: number) => (x: number, y: number) => x >= x0 && x < x1 && y >= y0 && y < y1;

/** Nesting depth of contour i = number of other contours containing its first point. */
function depthOf(cs: Contour[], i: number): number {
  const [x, y] = cs[i].points[0];
  return cs.reduce((d, c, j) => d + (j !== i && pointInPolygon(x, y, c.points) ? 1 : 0), 0);
}

function expectValid(cs: Contour[], w: number, h: number) {
  // Closed, simple, mutually disjoint, inside the image, hole flag = nesting parity.
  expect(findIntersectingRings(cs.map((c) => c.points)).size).toBe(0);
  cs.forEach((c, i) => {
    expect(c.points.length).toBeGreaterThanOrEqual(3);
    for (const [x, y] of c.points) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(w);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(h);
    }
    expect(c.hole).toBe(polygonArea(c.points) < 0);
    expect(c.hole).toBe(depthOf(cs, i) % 2 === 1);
  });
}

describe('traceContours', () => {
  it('traces a filled square clockwise with cut corners', () => {
    const m = maskOf(12, 12, rect(1, 1, 11, 11));
    const cs = traceContours(m);
    expect(cs).toHaveLength(1);
    expect(cs[0].hole).toBe(false);
    // Boundary through pixel-edge midpoints; each corner loses a 0.125 px² triangle.
    expect(polygonArea(cs[0].points)).toBeCloseTo(100 - 0.5, 6);
    expect(simplifyPolyline(cs[0].points, 0)).toHaveLength(8);
    expectValid(cs, 12, 12);
  });

  it('traces a ring as one outer boundary and one hole', () => {
    const m = maskOf(20, 20, (x, y) => rect(2, 2, 18, 18)(x, y) && !rect(6, 6, 14, 14)(x, y));
    const cs = traceContours(m);
    expect(cs).toHaveLength(2);
    const outer = cs.find((c) => !c.hole)!, hole = cs.find((c) => c.hole)!;
    expect(polygonArea(outer.points)).toBeCloseTo(256 - 0.5, 6);
    // The hole's corners are cut as well (8-connected foreground): 64 − 0.5.
    expect(polygonArea(hole.points)).toBeCloseTo(-(64 - 0.5), 6);
    expectValid(cs, 20, 20);
    const groups = groupContours(cs);
    expect(groups).toHaveLength(1);
    expect(groups[0].holes).toHaveLength(1);
  });

  it('separates two blobs', () => {
    const m = maskOf(30, 10, (x, y) => rect(1, 1, 9, 9)(x, y) || rect(15, 2, 28, 8)(x, y));
    const cs = traceContours(m);
    expect(cs.filter((c) => !c.hole)).toHaveLength(2);
    expect(cs.filter((c) => c.hole)).toHaveLength(0);
    expectValid(cs, 30, 10);
    expect(groupContours(cs)).toHaveLength(2);
  });

  it('nests an island inside a hole', () => {
    const m = maskOf(24, 24, (x, y) =>
      (rect(1, 1, 23, 23)(x, y) && !rect(5, 5, 19, 19)(x, y)) || rect(9, 9, 15, 15)(x, y));
    const cs = traceContours(m);
    expect(cs).toHaveLength(3);
    expectValid(cs, 24, 24);
    const groups = groupContours(cs);
    expect(groups).toHaveLength(2);
    const big = groups.find((g) => polygonArea(g.outer) > 400)!;
    const island = groups.find((g) => polygonArea(g.outer) < 50)!;
    expect(big.holes).toHaveLength(1);
    expect(island.holes).toHaveLength(0);
    expect(polygonArea(island.outer)).toBeCloseTo(36 - 0.5, 6);
  });

  it('closes shapes touching the image border along the border', () => {
    const cs = traceContours(maskOf(4, 3, () => true));
    expect(cs).toHaveLength(1);
    expect(polygonArea(cs[0].points)).toBeCloseTo(12 - 0.5, 6);
    const xs = cs[0].points.map((p) => p[0]), ys = cs[0].points.map((p) => p[1]);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(4);
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(3);
    expectValid(cs, 4, 3);
  });

  it('keeps 1-pixel features as diamonds', () => {
    const m = maskOf(5, 5, (x, y) => x === 2 && y === 2);
    const cs = traceContours(m);
    expect(cs).toHaveLength(1);
    expect(cs[0].points).toHaveLength(4);
    expect(polygonArea(cs[0].points)).toBeCloseTo(0.5, 6);
    // A 1-pixel hole is a (negative) diamond as well.
    const hole = traceContours(maskOf(5, 5, (x, y) => !(x === 2 && y === 2)));
    expect(hole).toHaveLength(2);
    expect(polygonArea(hole.find((c) => c.hole)!.points)).toBeCloseTo(-0.5, 6);
  });

  it('joins diagonal neighbours (8-connected foreground)', () => {
    const cs = traceContours(maskOf(2, 2, (x, y) => x === y));
    expect(cs).toHaveLength(1);
    expect(cs[0].hole).toBe(false);
    // Two diamonds (0.5 each) plus the saddle cell's neck (0.75 − 2 · 0.125).
    expect(polygonArea(cs[0].points)).toBeCloseTo(1.5, 6);
  });

  it('handles a checkerboard: one outer boundary, enclosed background pixels are holes', () => {
    const cs = traceContours(maskOf(5, 5, (x, y) => (x + y) % 2 === 0));
    expect(cs.filter((c) => !c.hole)).toHaveLength(1);
    // Odd cells not on the border: (1,2), (2,1), (2,3), (3,2).
    expect(cs.filter((c) => c.hole)).toHaveLength(4);
    expectValid(cs, 5, 5);
    const big = traceContours(maskOf(40, 40, (x, y) => (x + y) % 2 === 0 || (x * 7 + y * 3) % 5 === 0));
    expectValid(big, 40, 40);
  });

  it('produces valid contours for random masks', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let t = 0; t < 5; t++) {
      const cs = traceContours(maskOf(24, 18, () => rnd() < 0.5));
      expectValid(cs, 24, 18);
    }
  });

  it('interpolates scalar fields to sub-pixel positions', () => {
    const S = 64, C = 32, R = 40;
    const field = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) field[y * S + x] = Math.max(0, 1 - Math.hypot(x + 0.5 - C, y + 0.5 - C) / R);
    const cs = traceIsoContours(field, S, S, 0.5);
    expect(cs).toHaveLength(1);
    for (const [x, y] of cs[0].points) expect(Math.abs(Math.hypot(x - C, y - C) - R / 2)).toBeLessThan(0.05);
  });

  it('is fast on 1024²', () => {
    const S = 1024;
    const m = maskOf(S, S, (x, y) => Math.hypot(x - 512, y - 512) < 400 && Math.hypot(x - 512, y - 512) > 150 && ((x >> 4) + (y >> 4)) % 7 !== 0);
    const t0 = performance.now();
    const cs = traceContours(m);
    const dt = performance.now() - t0;
    expect(cs.length).toBeGreaterThan(10);
    expect(dt).toBeLessThan(1500);
  });
});

describe('polygon helpers', () => {
  it('signs areas by orientation (y-down: clockwise on screen is positive)', () => {
    const cw: Point[] = [[0, 0], [2, 0], [2, 1], [0, 1]];
    expect(polygonArea(cw)).toBe(2);
    expect(polygonArea([...cw].reverse())).toBe(-2);
  });

  it('tests point containment', () => {
    const sq: Point[] = [[0, 0], [4, 0], [4, 4], [0, 4]];
    expect(pointInPolygon(2, 2, sq)).toBe(true);
    expect(pointInPolygon(5, 2, sq)).toBe(false);
  });

  it('detects segment intersections, including touching', () => {
    expect(segmentsIntersect(0, 0, 2, 2, 0, 2, 2, 0)).toBe(true);
    expect(segmentsIntersect(0, 0, 1, 0, 0, 1, 1, 1)).toBe(false);
    expect(segmentsIntersect(0, 0, 2, 0, 1, 0, 1, 1)).toBe(true);
  });

  it('finds crossing rings', () => {
    const a: Point[] = [[0, 0], [4, 0], [4, 4], [0, 4]];
    const b: Point[] = [[10, 0], [14, 0], [14, 4], [10, 4]];
    const c: Point[] = [[2, 2], [6, 2], [6, 6], [2, 6]];
    const bowtie: Point[] = [[20, 0], [24, 4], [24, 0], [20, 4]];
    expect([...findIntersectingRings([a, b])]).toEqual([]);
    expect([...findIntersectingRings([a, b, c])].sort()).toEqual([0, 2]);
    expect([...findIntersectingRings([b, bowtie])]).toEqual([1]);
  });
});

describe('simplifyPolyline', () => {
  const circle = (n: number, r: number): Point[] =>
    Array.from({ length: n }, (_, i) => [r * Math.cos((i / n) * 2 * Math.PI), r * Math.sin((i / n) * 2 * Math.PI)] as Point);

  it('keeps every dropped vertex within tolerance', () => {
    const pts = circle(2000, 100);
    const s = simplifyPolyline(pts, 0.5);
    expect(s.length).toBeLessThan(200);
    expect(s.length).toBeGreaterThan(20);
    for (const [x, y] of pts) {
      let best = Infinity;
      for (let i = 0; i < s.length; i++) {
        const [ax, ay] = s[i], [bx, by] = s[(i + 1) % s.length];
        const dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
        best = Math.min(best, Math.hypot(ax + t * dx - x, ay + t * dy - y));
      }
      expect(best).toBeLessThanOrEqual(0.5 + 1e-9);
    }
    expect(Math.sign(polygonArea(s))).toBe(Math.sign(polygonArea(pts)));
  });

  it('drops collinear points and a repeated end point', () => {
    const sq: Point[] = [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1], [0, 0]];
    const s = simplifyPolyline(sq, 0.01);
    expect(s).toHaveLength(4);
    expect(polygonArea(s)).toBe(4);
  });

  it('never returns fewer than 3 points', () => {
    expect(simplifyPolyline(circle(50, 1), 100)).toHaveLength(3);
  });
});

describe('simplifyGroups', () => {
  it('keeps rings disjoint even with a large tolerance', () => {
    // A thin 1 px wall between a wavy outer boundary and its hole.
    const m = maskOf(80, 80, (x, y) => {
      const r = Math.hypot(x + 0.5 - 40, y + 0.5 - 40), a = Math.atan2(y - 40, x - 40);
      return r < 30 + 3 * Math.sin(a * 9) && r > 28 + 3 * Math.sin(a * 9);
    });
    const groups = groupContours(traceContours(m));
    const out = simplifyGroups(groups, 6);
    const rings = out.flatMap((g) => [g.outer, ...g.holes]);
    expect(findIntersectingRings(rings).size).toBe(0);
    for (const g of out) {
      expect(polygonArea(g.outer)).toBeGreaterThan(0);
      for (const h of g.holes) expect(polygonArea(h)).toBeLessThan(0);
    }
  });

  it('raises the tolerance to respect maxPoints', () => {
    const m = maskOf(300, 300, (x, y) => Math.hypot(x - 150, y - 150) < 140);
    const groups = groupContours(traceContours(m));
    const out = simplifyGroups(groups, 0, { maxPoints: 40 });
    expect(out[0].outer.length).toBeLessThanOrEqual(40);
    expect(out[0].outer.length).toBeGreaterThanOrEqual(8);
  });
});
