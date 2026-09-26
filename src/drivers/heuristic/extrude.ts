/**
 * Silhouette extrusion ("cookie cutter"), fully offline: the foreground
 * outline is traced into polygons (holes included), smoothed, simplified and
 * extruded into a closed slab with an optional rounded bevel. Ideal for
 * logos, icons, stickers and lettering. The image is projected onto the front
 * and back faces; the side walls pick up the colours at the edge.
 */
import { BufferAttribute, BufferGeometry, ExtrudeGeometry, Path, Shape, Vector2 } from 'three';
import type { Driver, DriverInput, DriverResult, I18nText, Mask, ParamSpec } from '../../core/types';
import { throwIfAborted } from '../../core/types';
import { yieldToPaint } from '../../core/yield';
import { blurFloat } from '../../core/image/ops';
import {
  findIntersectingRings, groupContours, pointInPolygon, polygonArea, simplifyGroups, traceIsoContours,
  type ContourGroup, type Point,
} from '../../core/image/contours';
import { LocalizedError } from '../../core/errors';
import { NO_SILHOUETTE, resolveSilhouette } from './inflate';

export interface ExtrudeOptions {
  /** Total thickness (front to back, bevel included), fraction of the longest image side. */
  thickness: number;
  /** Bevel width and height, fraction of the longest side. Limited automatically on thin strokes. */
  bevel: number;
  /** Bevel rounding steps; 0 = sharp edges. */
  bevelSegments: number;
  /** Outline blur radius in px at a 512 px working size (scaled with the image); 0 = exact pixel outline. */
  smooth: number;
  /** RDP tolerance in px at a 512 px working size. */
  simplify: number;
  /** Parts and holes smaller than this percentage of the image area are dropped (and all but the MAX_RINGS largest). */
  minArea: number;
  /** Soft cap on outline vertices; the tolerance grows until it fits. */
  maxPoints: number;
}

export const DEFAULT_EXTRUDE_OPTIONS: ExtrudeOptions = {
  thickness: 0.1,
  bevel: 0.01,
  bevelSegments: 3,
  smooth: 1,
  simplify: 0.5,
  minArea: 0.005,
  maxPoints: 20000,
};

export const NO_PARTS: I18nText = {
  tr: 'Katılaştırılacak kadar büyük bir parça bulunamadı. "En küçük parça" değerini düşürmeyi ya da "Kontur yumuşatma"yı azaltmayı deneyin.',
  en: 'No part is large enough to extrude. Try lowering "Min. part size" or "Outline smoothing".',
};

/**
 * At most this many outline rings (parts + holes) are extruded; beyond it the
 * smallest are dropped like parts under minArea. The cap triangulation's
 * hole bridging grows quadratically with the ring count and runs on the main
 * thread: dithered or noisy alpha masks can have tens of thousands of rings.
 */
export const MAX_RINGS = 1500;

/** Normals of neighbouring side faces closer than this are averaged (smooth bevels / curved walls). */
const CREASE_ANGLE = (40 * Math.PI) / 180;

/** Smooth, trace, filter, group and simplify the silhouette outline (image pixels, x right, y down). */
export function traceOutline(mask: Mask, opts: ExtrudeOptions): ContourGroup[] {
  const { width: w, height: h } = mask;
  const k = Math.max(w, h) / 512;
  const radius = Math.max(0, opts.smooth) * k;
  let field: ArrayLike<number> = mask.data;
  if (radius >= 0.5) {
    // Blurring the 0/1 mask and taking its 0.5 iso-line (interpolated)
    // replaces the pixel stair-steps with a smooth sub-pixel outline.
    const f = new Float32Array(w * h);
    for (let i = 0; i < f.length; i++) f[i] = mask.data[i];
    field = blurFloat(f, w, h, radius, 3);
  }
  const minAreaPx = (Math.max(0, opts.minArea) / 100) * w * h;
  const traced = traceIsoContours(field, w, h, 0.5).map((c) => ({ c, area: Math.abs(polygonArea(c.points)) }));
  let kept = traced.filter((t) => t.area >= minAreaPx);
  if (kept.length > MAX_RINGS) {
    // Keep the largest rings (ties: first traced), in their original order.
    // A ring's container is always larger than the ring, so nesting survives.
    const order = kept.map((_, i) => i).sort((a, b) => kept[b].area - kept[a].area || a - b);
    kept = order.slice(0, MAX_RINGS).sort((a, b) => a - b).map((i) => kept[i]);
  }
  const contours = kept.map((t) => t.c);
  return simplifyGroups(groupContours(contours), Math.max(0, opts.simplify) * k, { maxPoints: opts.maxPoints });
}

/**
 * Port of ExtrudeGeometry's getBevelVec (three r186): the direction a ring
 * vertex moves for a unit bevel offset (to the left of the travel direction,
 * i.e. outwards for clockwise outer rings / counter-clockwise holes in a y-up
 * frame; ExtrudeGeometry scales it by the negative bevelOffset to inset).
 * Must stay numerically identical so the inset can be predicted exactly.
 */
function bevelVec(px: number, py: number, ax: number, ay: number, bx: number, by: number): [number, number] {
  const vpx = px - ax, vpy = py - ay, vnx = bx - px, vny = by - py;
  const vpLenSq = vpx * vpx + vpy * vpy;
  const collinear = vpx * vny - vpy * vnx;
  let tx: number, ty: number, shrink: number;
  if (Math.abs(collinear) > Number.EPSILON) {
    const vpLen = Math.sqrt(vpLenSq), vnLen = Math.sqrt(vnx * vnx + vny * vny);
    const psx = ax - vpy / vpLen, psy = ay + vpx / vpLen;
    const nsx = bx - vny / vnLen, nsy = by + vnx / vnLen;
    const sf = ((nsx - psx) * vny - (nsy - psy) * vnx) / (vpx * vny - vpy * vnx);
    tx = psx + vpx * sf - px;
    ty = psy + vpy * sf - py;
    const lenSq = tx * tx + ty * ty;
    if (lenSq <= 2) return [tx, ty];
    shrink = Math.sqrt(lenSq / 2);
  } else {
    let same = false;
    if (vpx > Number.EPSILON) same = vnx > Number.EPSILON;
    else if (vpx < -Number.EPSILON) same = vnx < -Number.EPSILON;
    else same = Math.sign(vpy) === Math.sign(vny);
    if (same) {
      tx = -vpy; ty = vpx; shrink = Math.sqrt(vpLenSq);
    } else {
      tx = vpx; ty = vpy; shrink = Math.sqrt(vpLenSq / 2);
    }
  }
  return [tx / shrink, ty / shrink];
}

/** The ring as ExtrudeGeometry places it on the front/back face for a bevel of `size` (inset into the solid). */
export function insetRing(ring: Point[], size: number): Point[] {
  const n = ring.length;
  return ring.map((p, i) => {
    const a = ring[(i + n - 1) % n], b = ring[(i + 1) % n];
    const [vx, vy] = bevelVec(p[0], p[1], a[0], a[1], b[0], b[1]);
    return [p[0] - vx * size, p[1] - vy * size];
  });
}

/**
 * Collapse the short edges that would fold over when inset by `size` (pixel
 * chamfers, tightly rounded corners): an edge is replaced by the corner where
 * its neighbouring edges meet, or else loses its less significant vertex, as
 * long as the outline moves by at most `size`. Null if that is not enough.
 */
function removeFoldingEdges(ring: Point[], size: number): Point[] | null {
  let r = ring;
  for (let pass = 0; pass < 64; pass++) {
    const n = r.length;
    if (n < 3) return null;
    const q = insetRing(r, size);
    const out: (Point | null)[] = r.slice();
    const touched = new Uint8Array(n);
    let found = false;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ex = r[j][0] - r[i][0], ey = r[j][1] - r[i][1];
      const fx = q[j][0] - q[i][0], fy = q[j][1] - q[i][1];
      if (ex * fx + ey * fy > 1e-6 * (ex * ex + ey * ey)) continue;
      found = true;
      if (n <= 3) return null;
      const h = (i + n - 1) % n, k = (j + 1) % n;
      if (touched[h] || touched[i] || touched[j] || touched[k]) continue;
      // Corner where the neighbouring edges h→i and j→k meet.
      const corner = lineIntersection(r[h], r[i], r[j], r[k]);
      if (corner && segDist(corner, r[i], r[j]) <= size) {
        out[i] = corner;
        out[j] = null;
      } else {
        const m = vertexDeviation(r, i) <= vertexDeviation(r, j) ? i : j;
        if (vertexDeviation(r, m) > size) return null;
        out[m] = null;
      }
      touched[h] = touched[i] = touched[j] = touched[k] = 1;
    }
    if (!found) return r;
    r = out.filter((p): p is Point => p !== null);
  }
  return null;
}

/** Distance of vertex k from the chord joining its neighbours. */
function vertexDeviation(r: Point[], k: number): number {
  const n = r.length;
  return segDist(r[k], r[(k + n - 1) % n], r[(k + 1) % n]);
}

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

/** Intersection of the infinite lines ab and cd, or null if (nearly) parallel. */
function lineIntersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const ux = b[0] - a[0], uy = b[1] - a[1], vx = d[0] - c[0], vy = d[1] - c[1];
  const den = ux * vy - uy * vx;
  if (Math.abs(den) <= 1e-12 * Math.hypot(ux, uy) * Math.hypot(vx, vy)) return null;
  const t = ((c[0] - a[0]) * vy - (c[1] - a[1]) * vx) / den;
  return [a[0] + t * ux, a[1] + t * uy];
}

/**
 * Largest bevel ≤ `size` whose inset front face stays valid for this outer
 * ring + holes (no folds, no crossings), with the rings minimally cleaned up
 * for it. Falls back to no bevel.
 */
export function fitBevel(rings: Point[][], size: number): { rings: Point[][]; size: number } {
  for (let s = size, attempt = 0; s > 1e-6 && attempt < 8; s *= 0.6, attempt++) {
    const cleaned = rings.map((r) => removeFoldingEdges(r, s));
    if (cleaned.some((r) => !r)) continue;
    const ok = cleaned as Point[][];
    const inset = ok.map((r) => insetRing(r, s));
    if (inset.some((r, i) => Math.sign(polygonArea(r)) !== Math.sign(polygonArea(ok[i])))) continue;
    // Cleaned and inset rings must all be simple and mutually disjoint, every
    // inset ring must lie inside the solid, and the inset holes inside the
    // inset outer ring and outside each other. (A bevel wider than a stroke
    // can leave simple rings that overshot the outline or swapped nesting.)
    if (findIntersectingRings([...ok, ...inset]).size > 0) continue;
    // Point-in-ring tests with a bounding-box pre-check (thousands of holes).
    const okBox = ok.map(ringBox), insetBox = inset.map(ringBox);
    const inside = (rs: Point[][], boxes: Box[], i: number, [x, y]: Point) => {
      const b = boxes[i];
      return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && pointInPolygon(x, y, rs[i]);
    };
    const inSolid = (p: Point) => {
      if (!inside(ok, okBox, 0, p)) return false;
      for (let h = 1; h < ok.length; h++) if (inside(ok, okBox, h, p)) return false;
      return true;
    };
    if (!inset.every((r) => inSolid(r[0]))) continue;
    const holesOk = inset.every((h, i) => {
      if (i === 0) return true;
      if (!inside(inset, insetBox, 0, h[0])) return false;
      for (let j = 1; j < inset.length; j++) if (j !== i && inside(inset, insetBox, j, h[0])) return false;
      return true;
    });
    if (!holesOk) continue;
    return { rings: ok, size: s };
  }
  return { rings, size: 0 };
}

type Box = [number, number, number, number];

function ringBox(r: Point[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of r) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/**
 * Extrude outline groups (pixel coordinates of a `width` × `height` image)
 * into a closed, indexed BufferGeometry in the contract frame: +Y up, the
 * longest image side spans 2 units centred on the origin, the front face at
 * z = +T/2 facing +Z and the back at −T/2 (T = thickness · 2). The bevel is
 * reduced per part where it would not fit (thin strokes). UVs project the
 * image along Z onto every vertex.
 */
export function extrudeOutline(groups: ContourGroup[], width: number, height: number, opts: ExtrudeOptions): BufferGeometry {
  const L = Math.max(width, height), s = 2 / L;
  // Flipping Y turns outer rings clockwise and holes counter-clockwise, the
  // winding ExtrudeGeometry expects (it only re-orients holes when it has to
  // reverse the outer ring).
  const toUnits = (ring: Point[]): Point[] => ring.map(([x, y]) => [(x - width / 2) * s, (height / 2 - y) * s]);
  const T = Math.max(1e-4, opts.thickness * 2);
  const segments = Math.max(0, Math.round(opts.bevelSegments));
  const requested = segments > 0 ? Math.max(0, opts.bevel * 2) : 0;

  // Parts sharing a bevel size are extruded together.
  const bySize = new Map<number, Shape[]>();
  for (const g of groups) {
    const fit = fitBevel([g.outer, ...g.holes].map(toUnits), requested);
    const toV = (r: Point[]) => r.map(([x, y]) => new Vector2(x, y));
    const shape = new Shape(toV(fit.rings[0]));
    for (const hole of fit.rings.slice(1)) shape.holes.push(new Path(toV(hole)));
    const list = bySize.get(fit.size) ?? [];
    list.push(shape);
    bySize.set(fit.size, list);
  }

  const parts: { geometry: BufferGeometry; zShift: number }[] = [];
  for (const [size, shapes] of bySize) {
    const bt = Math.min(size, 0.4 * T);
    const bevelEnabled = size > 0 && bt > 0;
    const depth = bevelEnabled ? T - 2 * bt : T;
    const geometry = new ExtrudeGeometry(shapes, {
      depth,
      steps: 1,
      curveSegments: 1,
      bevelEnabled,
      bevelThickness: bt,
      bevelSize: size,
      // A negative offset of the full size keeps the widest outline on the
      // silhouette and insets the front/back faces instead of growing outwards.
      bevelOffset: -size,
      bevelSegments: Math.max(1, segments),
    });
    // ExtrudeGeometry spans z ∈ [−bt, depth + bt]; centre it.
    parts.push({ geometry, zShift: -depth / 2 });
  }
  const out = finalizeGeometry(parts, (width / 2) * s, (height / 2) * s);
  for (const p of parts) p.geometry.dispose();
  return out;
}

/** Mask → extruded geometry (the whole driver pipeline, synchronous). */
export function extrudeMask(mask: Mask, opts: ExtrudeOptions): BufferGeometry {
  const groups = traceOutline(mask, opts);
  if (groups.length === 0) throw new LocalizedError(NO_PARTS);
  return extrudeOutline(groups, mask.width, mask.height, opts);
}

/**
 * Turn ExtrudeGeometry's triangle soup into an indexed geometry: shift Z,
 * close the caps' T-junctions, flat front/back normals, crease-angle
 * smoothed side normals (angle weighted), planar UVs from X/Y, and vertices
 * shared wherever position and normal agree (hard edges stay split).
 */
function finalizeGeometry(parts: { geometry: BufferGeometry; zShift: number }[], halfW: number, halfH: number): BufferGeometry {
  let nv0 = 0;
  for (const { geometry } of parts) nv0 += geometry.getAttribute('position').count;
  const p0 = new Float64Array(nv0 * 3);
  // Groups with material 0 are the front/back caps, 1 the side walls.
  const cap0 = new Uint8Array(nv0 / 3);
  let base = 0;
  for (const { geometry, zShift } of parts) {
    const pos = geometry.getAttribute('position').array as Float32Array;
    for (let i = 0; i < pos.length; i += 3) {
      p0[3 * base + i] = pos[i];
      p0[3 * base + i + 1] = pos[i + 1];
      p0[3 * base + i + 2] = pos[i + 2] + zShift;
    }
    for (const g of geometry.groups) {
      if (g.materialIndex !== 0) continue;
      for (let f = (base + g.start) / 3; f < (base + g.start + g.count) / 3; f++) cap0[f] = 1;
    }
    base += pos.length / 3;
  }
  // Also welds corners that share a position (ExtrudeGeometry copies exact values).
  const { p, cap, posId, nPos } = repairCapTJunctions(p0, cap0);
  const nv = p.length / 3, nf = nv / 3;

  // Face normals, corner angles and a flag for (numerically) degenerate slivers,
  // whose normals are noise and must not leak into their neighbours.
  const fn = new Float64Array(nf * 3);
  const ang = new Float64Array(nv);
  const sliver = new Uint8Array(nf);
  for (let f = 0; f < nf; f++) {
    const a = 9 * f;
    const e1x = p[a + 3] - p[a], e1y = p[a + 4] - p[a + 1], e1z = p[a + 5] - p[a + 2];
    const e2x = p[a + 6] - p[a], e2y = p[a + 7] - p[a + 1], e2z = p[a + 8] - p[a + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      fn[3 * f] = nx / len;
      fn[3 * f + 1] = ny / len;
      fn[3 * f + 2] = nz / len;
    }
    sliver[f] = len <= 1e-5 * Math.hypot(e1x, e1y, e1z) * Math.hypot(e2x, e2y, e2z) ? 1 : 0;
    for (let c = 0; c < 3; c++) {
      const o = 3 * (3 * f + c), o1 = 3 * (3 * f + ((c + 1) % 3)), o2 = 3 * (3 * f + ((c + 2) % 3));
      const ux = p[o1] - p[o], uy = p[o1 + 1] - p[o + 1], uz = p[o1 + 2] - p[o + 2];
      const vx = p[o2] - p[o], vy = p[o2 + 1] - p[o + 1], vz = p[o2 + 2] - p[o + 2];
      const d = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz);
      ang[3 * f + c] = d > 0 ? Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy + uz * vz) / d))) : 0;
    }
  }

  // Corners around each welded position (CSR buckets).
  const start = new Int32Array(nPos + 1);
  for (let i = 0; i < nv; i++) start[posId[i] + 1]++;
  for (let i = 0; i < nPos; i++) start[i + 1] += start[i];
  const corners = new Int32Array(nv);
  const fill = start.slice(0, nPos);
  for (let i = 0; i < nv; i++) corners[fill[posId[i]]++] = i;

  const normal = new Float32Array(nv * 3);
  const creaseCos = Math.cos(CREASE_ANGLE);
  for (let i = 0; i < nv; i++) {
    const f = (i / 3) | 0;
    const fx = fn[3 * f], fy = fn[3 * f + 1], fz = fn[3 * f + 2];
    let sx = 0, sy = 0, sz = 0;
    if (cap[f]) {
      sz = p[9 * f + 2] >= 0 ? 1 : -1; // caps stay perfectly flat
    } else {
      for (let k = start[posId[i]]; k < start[posId[i] + 1]; k++) {
        const j = corners[k], g = (j / 3) | 0;
        if (sliver[g]) continue;
        const gx = fn[3 * g], gy = fn[3 * g + 1], gz = fn[3 * g + 2];
        if (!sliver[f] && fx * gx + fy * gy + fz * gz < creaseCos) continue;
        sx += gx * ang[j];
        sy += gy * ang[j];
        sz += gz * ang[j];
      }
      const len = Math.hypot(sx, sy, sz);
      if (len > 1e-12) {
        sx /= len; sy /= len; sz /= len;
      } else {
        sx = 0; sy = 0; sz = 1; // isolated sliver: any unit normal
      }
    }
    normal[3 * i] = sx;
    normal[3 * i + 1] = sy;
    normal[3 * i + 2] = sz;
  }

  // Share vertices with equal position and normal.
  const vid = new Int32Array(nv);
  const qn = (v: number) => Math.round(v * 1e4);
  const count = hashIds(nv, 4, (i, c) => (c === 0 ? posId[i] : qn(normal[3 * i + c - 1])), vid);
  const outPos = new Float32Array(count * 3), outNormal = new Float32Array(count * 3), outUv = new Float32Array(count * 2);
  const done = new Uint8Array(count);
  for (let i = 0; i < nv; i++) {
    const v = vid[i];
    if (done[v]) continue;
    done[v] = 1;
    const x = p[3 * i], y = p[3 * i + 1];
    for (let c = 0; c < 3; c++) {
      outPos[3 * v + c] = p[3 * i + c];
      outNormal[3 * v + c] = normal[3 * i + c];
    }
    outUv[2 * v] = Math.min(1, Math.max(0, (x + halfW) / (2 * halfW)));
    outUv[2 * v + 1] = Math.min(1, Math.max(0, (y + halfH) / (2 * halfH)));
  }

  const geometry = new BufferGeometry();
  geometry.setIndex(new BufferAttribute(count > 65535 ? Uint32Array.from(vid) : Uint16Array.from(vid), 1));
  geometry.setAttribute('position', new BufferAttribute(outPos, 3));
  geometry.setAttribute('normal', new BufferAttribute(outNormal, 3));
  geometry.setAttribute('uv', new BufferAttribute(outUv, 2));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * ExtrudeGeometry triangulates the caps with earcut, which drops ring
 * vertices lying exactly on the line through their neighbours (easily the
 * case for pixel-aligned outlines, e.g. across rings after hole bridging).
 * A cap triangle then spans A→C across vertex B while the side walls still
 * use A–B and B–C: a zero-width T-junction crack that leaves the mesh open.
 * Split such cap triangles at the skipped vertices (a fan from the opposite
 * corner), found by following the unmatched edges along the line. Triangle
 * soup in and out (9 coordinates and one cap flag per face), plus the ids of
 * the welded positions of the result.
 */
function repairCapTJunctions(p: Float64Array, cap: Uint8Array): { p: Float64Array; cap: Uint8Array; posId: Int32Array; nPos: number } {
  for (let pass = 0; ; pass++) {
    const nv = p.length / 3, nf = nv / 3;
    const id = new Int32Array(nv);
    const nPos = hashIds(nv, 3, (i, c) => Math.round(p[3 * i + c] * 1e6), id);
    const done = { p, cap, posId: id, nPos };
    if (pass === 4) return done;
    const next = (i: number) => i - (i % 3) + ((i + 1) % 3);
    // Ids for the directed edges a→b of all corners (items 0..nv-1) and their
    // reverses b→a (items nv..2nv-1): an edge is unmatched when its reverse
    // shares an id with no forward edge.
    const eid = new Int32Array(2 * nv);
    const nE = hashIds(2 * nv, 2, (k, c) => {
      const i = k < nv ? k : k - nv;
      return (k < nv) === (c === 0) ? id[i] : id[next(i)];
    }, eid);
    const used = new Uint8Array(nE);
    for (let i = 0; i < nv; i++) used[eid[i]] = 1;
    const open = (i: number) => used[eid[nv + i]] === 0;
    // Unmatched edges as an undirected adjacency, and one corner per position for its coordinates.
    const adj = new Map<number, number[]>();
    const link = (u: number, v: number) => {
      const list = adj.get(u);
      if (list) list.push(v);
      else adj.set(u, [v]);
    };
    const rep = new Int32Array(nPos);
    let anyOpenCap = false;
    for (let i = 0; i < nv; i++) {
      rep[id[i]] = i;
      if (!open(i)) continue;
      if (cap[(i / 3) | 0]) anyOpenCap = true;
      link(id[i], id[next(i)]);
      link(id[next(i)], id[i]);
    }
    if (!anyOpenCap) return done;

    // Positions strictly inside segment a→b (same cap plane) reachable from a
    // or b along unmatched edges that stay on the segment, ordered from a to
    // b; null if none. (Skipped vertices can chain, and spanning cap edges can
    // overlap each other along one line.)
    const chainOf = (a: number, b: number): number[] | null => {
      const ra = 3 * rep[a], rb = 3 * rep[b];
      const ax = p[ra], ay = p[ra + 1], az = p[ra + 2];
      const dx = p[rb] - ax, dy = p[rb + 1] - ay, len2 = dx * dx + dy * dy;
      if (!(len2 > 0)) return null;
      const len = Math.sqrt(len2);
      // Stored positions are Float32: allow for their rounding off the line.
      const tol = 1e-6 * len + 4e-7;
      const found = new Map<number, number>();
      const todo = [a, b];
      while (todo.length > 0) {
        for (const v of adj.get(todo.pop()!) ?? []) {
          if (v === a || v === b || found.has(v)) continue;
          const rv = 3 * rep[v];
          const x = p[rv] - ax, y = p[rv + 1] - ay;
          if (Math.abs(p[rv + 2] - az) > 1e-9) continue;
          const t = (x * dx + y * dy) / len2;
          if (!(t > 1e-9 && t < 1 - 1e-9) || Math.abs(x * dy - y * dx) / len > tol) continue;
          found.set(v, t);
          todo.push(v);
        }
      }
      if (found.size === 0) return null;
      return [...found.keys()].sort((u, v) => found.get(u)! - found.get(v)!);
    };

    // Per face: the corner starting the split edge and the inner vertices.
    const splits = new Map<number, { c: number; chain: number[] }>();
    let added = 0;
    for (let f = 0; f < nf; f++) {
      if (!cap[f]) continue;
      for (let c = 0; c < 3; c++) {
        const i = 3 * f + c;
        if (!open(i)) continue;
        const chain = chainOf(id[i], id[next(i)]);
        if (!chain) continue;
        splits.set(f, { c, chain });
        added += chain.length;
        break;
      }
    }
    if (splits.size === 0) return done;

    const np = new Float64Array(p.length + 9 * added);
    const ncap = new Uint8Array(nf + added);
    let o = 0;
    const put = (corner: number) => {
      np[o++] = p[3 * corner];
      np[o++] = p[3 * corner + 1];
      np[o++] = p[3 * corner + 2];
    };
    for (let f = 0; f < nf; f++) {
      const split = splits.get(f);
      if (!split) {
        ncap[o / 9] = cap[f];
        for (let c = 0; c < 3; c++) put(3 * f + c);
        continue;
      }
      // Face (a, b, opp) → fan (v_j, v_j+1, opp) along a = v_0 … v_k+1 = b, same winding.
      const a = 3 * f + split.c, b = 3 * f + ((split.c + 1) % 3), opp = 3 * f + ((split.c + 2) % 3);
      const path = [a, ...split.chain.map((v) => rep[v]), b];
      for (let j = 0; j + 1 < path.length; j++) {
        ncap[o / 9] = 1;
        put(path[j]);
        put(path[j + 1]);
        put(opp);
      }
    }
    p = np;
    cap = ncap;
  }
}

/**
 * Assign ids 0..count-1 to `n` items so that items with equal integer keys
 * (`dims` components from `key`) share an id. Open-addressing hash table.
 */
function hashIds(n: number, dims: number, key: (i: number, c: number) => number, out: Int32Array): number {
  let size = 1;
  while (size < n * 2) size <<= 1;
  const table = new Int32Array(size).fill(-1);
  const keys = new Int32Array(n * dims);
  const primes = [73856093, 19349663, 83492791, 50331653];
  let count = 0;
  const cur = new Int32Array(dims);
  for (let i = 0; i < n; i++) {
    let hsh = 0;
    for (let c = 0; c < dims; c++) {
      cur[c] = key(i, c);
      hsh ^= Math.imul(cur[c], primes[c]);
    }
    let slot = hsh & (size - 1);
    for (;;) {
      const id = table[slot];
      if (id < 0) {
        table[slot] = count;
        keys.set(cur, count * dims);
        out[i] = count++;
        break;
      }
      let same = true;
      for (let c = 0; c < dims && same; c++) same = keys[id * dims + c] === cur[c];
      if (same) {
        out[i] = id;
        break;
      }
      slot = (slot + 1) & (size - 1);
    }
  }
  return count;
}

/** Let queued input (Cancel / Esc) run between steps. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const PARAMS: ParamSpec[] = [
  {
    kind: 'number',
    key: 'thickness',
    label: { tr: 'Kalınlık', en: 'Thickness' },
    hint: { tr: 'Toplam kalınlık, uzun kenarın oranı olarak', en: 'Total thickness as a fraction of the longest side' },
    min: 0.01, max: 0.5, step: 0.01, default: DEFAULT_EXTRUDE_OPTIONS.thickness,
  },
  {
    kind: 'number',
    key: 'bevel',
    label: { tr: 'Kenar yuvarlatma', en: 'Bevel' },
    hint: {
      tr: 'Kenar pahı genişliği, uzun kenarın oranı olarak (ince çizgilerde otomatik sınırlanır)',
      en: 'Edge bevel width as a fraction of the longest side (limited automatically on thin strokes)',
    },
    min: 0, max: 0.05, step: 0.002, default: DEFAULT_EXTRUDE_OPTIONS.bevel,
  },
  {
    kind: 'number',
    key: 'bevelSegments',
    label: { tr: 'Yuvarlatma adımı', en: 'Bevel segments' },
    hint: { tr: '0 = keskin kenar; fazlası daha yumuşak ama daha çok üçgen', en: '0 = sharp edge; more = smoother but more triangles' },
    min: 0, max: 8, step: 1, default: DEFAULT_EXTRUDE_OPTIONS.bevelSegments,
  },
  {
    kind: 'number',
    key: 'smooth',
    label: { tr: 'Kontur yumuşatma', en: 'Outline smoothing' },
    hint: {
      tr: 'Piksel basamaklarını giderir (512 px ölçeğinde piksel); çok ince çizgileri yok edebilir',
      en: 'Removes pixel stair-steps (pixels at 512 px scale); may erase very thin lines',
    },
    min: 0, max: 8, step: 0.5, default: DEFAULT_EXTRUDE_OPTIONS.smooth,
  },
  {
    kind: 'number',
    key: 'simplify',
    label: { tr: 'Sadeleştirme', en: 'Simplification' },
    hint: {
      tr: 'Kontur toleransı (512 px ölçeğinde piksel); yüksek değer = daha az üçgen',
      en: 'Outline tolerance (pixels at 512 px scale); higher = fewer triangles',
    },
    min: 0, max: 4, step: 0.1, default: DEFAULT_EXTRUDE_OPTIONS.simplify,
  },
  {
    kind: 'number',
    key: 'minArea',
    label: { tr: 'En küçük parça (%)', en: 'Min. part size (%)' },
    hint: {
      tr: `Görsel alanının bu yüzdesinden küçük parçalar ve delikler atılır (en fazla ${MAX_RINGS} kontur; fazlasında en küçükler atılır)`,
      en: `Parts and holes smaller than this percentage of the image area are dropped (at most ${MAX_RINGS} outlines; beyond that the smallest go)`,
    },
    min: 0, max: 2, step: 0.005, default: DEFAULT_EXTRUDE_OPTIONS.minArea,
  },
];

export function extrudeOptionsFromParams(p: DriverInput['params']): ExtrudeOptions {
  const d = DEFAULT_EXTRUDE_OPTIONS;
  const num = (key: Exclude<keyof ExtrudeOptions, 'maxPoints'>) =>
    typeof p[key] === 'number' && Number.isFinite(p[key]) ? (p[key] as number) : d[key];
  return {
    thickness: num('thickness'),
    bevel: num('bevel'),
    bevelSegments: num('bevelSegments'),
    smooth: num('smooth'),
    simplify: num('simplify'),
    minArea: num('minArea'),
    maxPoints: d.maxPoints,
  };
}

export const extrudeDriver: Driver = {
  id: 'silhouette-extrude',
  name: { tr: 'Siluet kalıplama (ekstrüzyon)', en: 'Silhouette extrude' },
  description: {
    tr: 'Siluetin dış hatlarını kurabiye kalıbı gibi keserek yuvarlatılmış kenarlı, kapalı bir levhaya dönüştürür. Logolar, ikonlar, çıkartmalar ve yazılar için idealdir; 3D baskıya hazırdır. Saydam PNG ya da düz arka plan gerekir.',
    en: 'Cuts the silhouette out like a cookie cutter and turns it into a closed slab with rounded edges. Ideal for logos, icons, stickers and lettering; ready for 3D printing. Needs a transparent PNG or a plain background.',
  },
  category: 'heuristic',
  badges: ['offline', 'closed-mesh'],
  params: PARAMS,
  producesDepth: false,
  async run(input: DriverInput): Promise<DriverResult> {
    const { image, signal, onProgress } = input;
    throwIfAborted(signal);
    onProgress({ label: { tr: 'Siluet hazırlanıyor', en: 'Preparing silhouette' }, ratio: 0.05 });
    const mask = resolveSilhouette(image, input.mask);
    if (!mask) throw new LocalizedError(NO_SILHOUETTE);
    const opts = extrudeOptionsFromParams(input.params);
    await tick();
    throwIfAborted(signal);

    onProgress({ label: { tr: 'Kontur çıkarılıyor', en: 'Tracing outline' }, ratio: 0.2 });
    await yieldToPaint(); // show the label during the synchronous step
    throwIfAborted(signal);
    const groups = traceOutline(mask, opts);
    if (groups.length === 0) throw new LocalizedError(NO_PARTS);
    await tick();
    throwIfAborted(signal);

    onProgress({ label: { tr: 'Katılaştırılıyor', en: 'Extruding' }, ratio: 0.55 });
    await yieldToPaint();
    throwIfAborted(signal);
    const geometry = extrudeOutline(groups, mask.width, mask.height, opts);
    if (signal.aborted) {
      geometry.dispose();
      throwIfAborted(signal);
    }
    onProgress({ label: { tr: 'Tamamlandı', en: 'Done' }, ratio: 1 });
    return { kind: 'geometry', geometry };
  },
};
