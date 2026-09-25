/**
 * Silhouette outlines as polygons: marching-squares contour tracing of masks
 * and scalar fields, plus the polygon helpers the extrusion driver needs
 * (signed area, point-in-polygon, hole grouping, closed RDP simplification
 * and a topology-safe simplifier that never lets rings cross).
 *
 * Coordinates are image pixels, x right, y down. Pixel (i, j) covers
 * [i, i+1] × [j, j+1]; samples sit at pixel centres (i + 0.5, j + 0.5), so a
 * binary mask boundary passes through pixel-edge midpoints and a single pixel
 * becomes a diamond of area 0.5. Everything outside the image counts as
 * background, so every contour is closed and lies inside [0, w] × [0, h].
 *
 * Orientation: the foreground is always on the right of the direction of
 * travel (as seen on screen). Outer boundaries therefore run clockwise on
 * screen and have a positive shoelace area in these y-down coordinates;
 * holes run counter-clockwise and have a negative area. Flipping Y (to a
 * y-up frame) turns outers clockwise / holes counter-clockwise, which is the
 * winding three.js ExtrudeGeometry expects.
 *
 * Connectivity: foreground is 8-connected (diagonal neighbours join through a
 * thin neck), background 4-connected. For scalar fields the saddle cells are
 * decided by the cell-centre average, which reduces to the same rule for
 * 0/1 masks. Contours never cross or touch each other.
 */
import type { Mask } from '../types';

export type Point = [number, number];

export interface Contour {
  points: Point[];
  /** True for the boundary of a background region enclosed by foreground. */
  hole: boolean;
}

export interface ContourGroup {
  outer: Point[];
  holes: Point[][];
}

/** Contours of a binary mask (1 = foreground). */
export function traceContours(mask: Mask): Contour[] {
  return traceIsoContours(mask.data, mask.width, mask.height, 0.5);
}

// Marching-squares segment table. Cell corners in clockwise screen order:
// 0 = top-left, 1 = top-right, 2 = bottom-right, 3 = bottom-left; edge k joins
// corner k to corner k + 1 (0 top, 1 right, 2 bottom, 3 left). A segment runs
// from an edge crossed inside→outside (clockwise) to one crossed outside→inside,
// which keeps the inside on its right. In saddle cells, `joined` pairs each
// start with the next clockwise end (inside regions meet through the centre),
// otherwise with the previous one.
function buildTable(joined: boolean): number[][] {
  const table: number[][] = [];
  for (let c = 0; c < 16; c++) {
    const inside = (k: number) => (c >> (k & 3)) & 1;
    const segs: number[] = [];
    for (let k = 0; k < 4; k++) {
      if (!inside(k) || inside(k + 1)) continue;
      for (let m = 1; m < 4; m++) {
        const e = (k + (joined ? m : -m) + 4) & 3;
        if (!inside(e) && inside(e + 1)) {
          segs.push(k, e);
          break;
        }
      }
    }
    table.push(segs);
  }
  return table;
}
const TABLE_JOINED = buildTable(true);
const TABLE_SPLIT = buildTable(false);

/**
 * Iso-contours of a scalar field at `level` (samples >= level are inside),
 * with crossings linearly interpolated between samples (sub-pixel). Samples
 * outside the image are 0, so `level` must be > 0.
 */
export function traceIsoContours(field: ArrayLike<number>, width: number, height: number, level = 0.5): Contour[] {
  if (width <= 0 || height <= 0) return [];
  // Padded sample grid with a one-sample ring of zeros.
  const W = width + 2, H = height + 2;
  const f = new Float32Array(W * H);
  const inside = new Uint8Array(W * H);
  for (let y = 0; y < height; y++) {
    const src = y * width, dst = (y + 1) * W + 1;
    for (let x = 0; x < width; x++) {
      const v = field[src + x];
      f[dst + x] = v;
      inside[dst + x] = v >= level ? 1 : 0;
    }
  }

  // Grid edge ids: horizontal edge (sx, sy)→(sx + 1, sy) is sy·W + sx,
  // vertical edge (sx, sy)→(sx, sy + 1) is V + sy·W + sx. next[e] links each
  // crossing to the following one along its contour.
  const V = W * H;
  const next = new Int32Array(2 * V).fill(-1);
  for (let cy = 0; cy < H - 1; cy++) {
    for (let cx = 0; cx < W - 1; cx++) {
      const i = cy * W + cx;
      const c = inside[i] | (inside[i + 1] << 1) | (inside[i + W + 1] << 2) | (inside[i + W] << 3);
      if (c === 0 || c === 15) continue;
      let segs = TABLE_JOINED[c];
      if ((c === 5 || c === 10) && (f[i] + f[i + 1] + f[i + W] + f[i + W + 1]) * 0.25 < level) segs = TABLE_SPLIT[c];
      for (let s = 0; s < segs.length; s += 2) next[edgeId(segs[s], i, W, V)] = edgeId(segs[s + 1], i, W, V);
    }
  }

  const crossing = (e: number): Point => {
    const vertical = e >= V;
    const a = vertical ? e - V : e;
    const b = vertical ? a + W : a + 1;
    // Clamp away from the samples so crossings on different edges never coincide.
    const t = Math.min(0.999, Math.max(0.001, (level - f[a]) / (f[b] - f[a])));
    const sx = a % W, sy = (a - sx) / W;
    return vertical ? [sx - 0.5, sy - 0.5 + t] : [sx - 0.5 + t, sy - 0.5];
  };

  const out: Contour[] = [];
  for (let e = 0; e < next.length; e++) {
    if (next[e] < 0) continue;
    const points: Point[] = [];
    let cur = e;
    while (cur >= 0) {
      points.push(crossing(cur));
      const nx = next[cur];
      next[cur] = -1;
      cur = nx;
      if (cur === e) break;
    }
    if (points.length >= 3) out.push({ points, hole: polygonArea(points) < 0 });
  }
  return out;
}

function edgeId(edge: number, i: number, W: number, V: number): number {
  switch (edge) {
    case 0: return i; // top
    case 1: return V + i + 1; // right
    case 2: return i + W; // bottom
    default: return V + i; // left
  }
}

/** Signed shoelace area. In y-down image coordinates: > 0 for outer boundaries, < 0 for holes. */
export function polygonArea(points: Point[]): number {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return a / 2;
}

/** Even-odd point-in-polygon test (the result for points exactly on an edge is arbitrary). */
export function pointInPolygon(x: number, y: number, points: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Attach every hole to the smallest outer contour that contains it. Holes
 * without a container (not produced by traceContours) are dropped. Groups
 * keep the input order of their outer contours.
 */
export function groupContours(contours: Contour[]): ContourGroup[] {
  const outers = contours.filter((c) => !c.hole).map((c) => ({
    c, area: Math.abs(polygonArea(c.points)), box: bbox(c.points), group: { outer: c.points, holes: [] } as ContourGroup,
  }));
  const bySize = [...outers].sort((a, b) => a.area - b.area);
  for (const c of contours) {
    if (!c.hole) continue;
    const area = Math.abs(polygonArea(c.points));
    const [x, y] = c.points[0];
    const parent = bySize.find((o) => o.area > area && x > o.box[0] && x < o.box[2] && y > o.box[1] && y < o.box[3] &&
      pointInPolygon(x, y, o.c.points));
    parent?.group.holes.push(c.points);
  }
  return outers.map((o) => o.group);
}

function bbox(points: Point[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/** Squared distance from p to segment ab. */
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

/**
 * Ramer–Douglas–Peucker simplification of a CLOSED polyline (no repeated end
 * point): keeps a subset of the vertices, in order, such that every dropped
 * vertex is within `tolerance` of the simplified outline. Always returns at
 * least 3 points when the input has them. Does not by itself guarantee a
 * simple polygon — see simplifyGroups.
 */
export function simplifyPolyline(points: Point[], tolerance: number): Point[] {
  let n = points.length;
  if (n > 1 && points[0][0] === points[n - 1][0] && points[0][1] === points[n - 1][1]) n--;
  if (n <= 3) return points.slice(0, n);
  const tol2 = Math.max(0, tolerance) ** 2;

  // Anchors: the leftmost vertex (a true corner of the hull) and the vertex farthest from it.
  let a = 0;
  for (let i = 1; i < n; i++) if (points[i][0] < points[a][0] || (points[i][0] === points[a][0] && points[i][1] < points[a][1])) a = i;
  let b = a, far = -1;
  for (let i = 0; i < n; i++) {
    const d = (points[i][0] - points[a][0]) ** 2 + (points[i][1] - points[a][1]) ** 2;
    if (d > far) { far = d; b = i; }
  }
  if (b === a) return [points[a]];

  const keep = new Uint8Array(n);
  keep[a] = keep[b] = 1;
  const stack = [a, b, b, a];
  while (stack.length) {
    const e = stack.pop()!, s = stack.pop()!;
    const len = (e - s + n) % n;
    if (len < 2) continue;
    const [ax, ay] = points[s], [bx, by] = points[e];
    let maxD = -1, maxI = -1;
    for (let k = 1, i = (s + 1) % n; k < len; k++, i = i + 1 === n ? 0 : i + 1) {
      const d = segDist2(points[i][0], points[i][1], ax, ay, bx, by);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tol2) {
      keep[maxI] = 1;
      stack.push(s, maxI, maxI, e);
    }
  }

  let count = 0;
  for (let i = 0; i < n; i++) count += keep[i];
  if (count < 3) {
    // Collapsed to a segment: keep the vertex farthest from it as well.
    let maxD = -1, maxI = -1;
    for (let i = 0; i < n; i++) {
      if (keep[i]) continue;
      const d = segDist2(points[i][0], points[i][1], points[a][0], points[a][1], points[b][0], points[b][1]);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    keep[maxI] = 1;
  }
  const out: Point[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
  (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

const onSegment = (ax: number, ay: number, bx: number, by: number, px: number, py: number) =>
  Math.min(ax, bx) <= px && px <= Math.max(ax, bx) && Math.min(ay, by) <= py && py <= Math.max(ay, by);

/** True if segments ab and cd cross or touch. */
export function segmentsIntersect(
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d1 = orient(cx, cy, dx, dy, ax, ay), d2 = orient(cx, cy, dx, dy, bx, by);
  const d3 = orient(ax, ay, bx, by, cx, cy), d4 = orient(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (d1 === 0 && onSegment(cx, cy, dx, dy, ax, ay)) || (d2 === 0 && onSegment(cx, cy, dx, dy, bx, by)) ||
    (d3 === 0 && onSegment(ax, ay, bx, by, cx, cy)) || (d4 === 0 && onSegment(ax, ay, bx, by, dx, dy));
}

/**
 * Indices of the closed rings that cross or touch themselves or another ring
 * (edges sharing a vertex within a ring are not tested). Uniform-grid
 * broad phase, roughly linear in the total number of edges.
 */
export function findIntersectingRings(rings: Point[][]): Set<number> {
  const bad = new Set<number>();
  let total = 0;
  for (const r of rings) total += r.length;
  if (total === 0) return bad;

  const sx0 = new Float64Array(total), sy0 = new Float64Array(total), sx1 = new Float64Array(total), sy1 = new Float64Array(total);
  const segRing = new Int32Array(total), segIdx = new Int32Array(total), ringLen = new Int32Array(rings.length);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, sumLen = 0, s = 0;
  rings.forEach((r, ri) => {
    ringLen[ri] = r.length;
    for (let i = 0; i < r.length; i++, s++) {
      const p = r[i], q = r[(i + 1) % r.length];
      sx0[s] = p[0]; sy0[s] = p[1]; sx1[s] = q[0]; sy1[s] = q[1];
      segRing[s] = ri; segIdx[s] = i;
      sumLen += Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
  });

  const spanX = maxX - minX, spanY = maxY - minY;
  let cell = Math.max(sumLen / total, 1e-9);
  while (((spanX / cell) + 1) * ((spanY / cell) + 1) > 4 * total + 64) cell *= 2;
  const gx = Math.floor(spanX / cell) + 1, gy = Math.floor(spanY / cell) + 1;
  const cellOf = (v: number, lo: number, g: number) => Math.min(g - 1, Math.max(0, Math.floor((v - lo) / cell)));

  // Bucket segments per cell (CSR layout: count, prefix sum, fill).
  const start = new Int32Array(gx * gy + 1);
  const forCells = (k: number, fn: (c: number) => void) => {
    const cx0 = cellOf(Math.min(sx0[k], sx1[k]), minX, gx), cx1 = cellOf(Math.max(sx0[k], sx1[k]), minX, gx);
    const cy0 = cellOf(Math.min(sy0[k], sy1[k]), minY, gy), cy1 = cellOf(Math.max(sy0[k], sy1[k]), minY, gy);
    for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) fn(y * gx + x);
  };
  for (let k = 0; k < total; k++) forCells(k, (c) => start[c + 1]++);
  for (let c = 0; c < gx * gy; c++) start[c + 1] += start[c];
  const items = new Int32Array(start[gx * gy]);
  const fill = start.slice(0, gx * gy);
  for (let k = 0; k < total; k++) forCells(k, (c) => { items[fill[c]++] = k; });

  for (let c = 0; c < gx * gy; c++) {
    for (let p = start[c]; p < start[c + 1]; p++) {
      const i = items[p], ri = segRing[i];
      for (let q = p + 1; q < start[c + 1]; q++) {
        const j = items[q], rj = segRing[j];
        if (bad.has(ri) && bad.has(rj)) continue;
        if (ri === rj) {
          const len = ringLen[ri], d = Math.abs(segIdx[i] - segIdx[j]);
          if (d <= 1 || d === len - 1) continue; // neighbours share a vertex
        }
        if (segmentsIntersect(sx0[i], sy0[i], sx1[i], sy1[i], sx0[j], sy0[j], sx1[j], sy1[j])) {
          bad.add(ri);
          bad.add(rj);
        }
      }
    }
  }
  return bad;
}

export interface SimplifyGroupsOptions {
  /** Soft cap on the total vertex count; the tolerance grows until it is met. Default 20000. */
  maxPoints?: number;
}

/**
 * Simplify every ring of `groups` with RDP while keeping the result valid:
 * the tolerance is raised until the total vertex count fits `maxPoints`, then
 * rings that end up crossing (themselves or others) or flipping orientation
 * are re-simplified with a smaller tolerance, falling back to the original
 * ring (which traceContours guarantees to be simple and disjoint).
 */
export function simplifyGroups(groups: ContourGroup[], tolerance: number, opts: SimplifyGroupsOptions = {}): ContourGroup[] {
  const maxPoints = opts.maxPoints ?? 20000;
  const rings: Point[][] = [];
  for (const g of groups) rings.push(g.outer, ...g.holes);
  const areas = rings.map(polygonArea);

  let tol = Math.max(0, tolerance);
  let out = rings.map((r) => simplifyPolyline(r, tol));
  const count = () => out.reduce((n, r) => n + r.length, 0);
  if (count() > maxPoints) {
    // Past the largest ring's extent every ring is already at its minimum.
    const [x0, y0, x1, y1] = bbox(rings.flat());
    const span = Math.max(x1 - x0, y1 - y0);
    while (count() > maxPoints && tol < span) {
      tol = Math.max(tol * 1.5, 0.25);
      out = rings.map((r) => simplifyPolyline(r, tol));
    }
  }

  const ringTol = new Float64Array(rings.length).fill(tol);
  for (let iter = 0; iter < 8; iter++) {
    const found = findIntersectingRings(out);
    out.forEach((r, i) => {
      if (r.length < 3 || Math.sign(polygonArea(r)) !== Math.sign(areas[i])) found.add(i);
    });
    const bad = [...found].filter((i) => out[i] !== rings[i]);
    if (bad.length === 0) break;
    for (const i of bad) {
      ringTol[i] = iter >= 6 || ringTol[i] < 0.05 ? 0 : ringTol[i] / 2;
      out[i] = ringTol[i] > 0 ? simplifyPolyline(rings[i], ringTol[i]) : rings[i];
    }
  }

  let k = 0;
  return groups.map((g) => {
    const outer = out[k++];
    const holes = g.holes.map(() => out[k++]);
    return { outer, holes };
  });
}
