/**
 * "Depth + volume": a closed body from ONE image, for objects and characters.
 *
 * A monocular depth map alone gives a relief (a flat mask with bumps) and a
 * silhouette inflation alone gives a featureless balloon. This builder
 * combines them on a pixel grid:
 *
 *   body   H0 = T · inflate(silhouette) — the half-thickness of a plausible
 *          volume: a disk becomes a ball (Kirby), a limb a tube; "boxy"
 *          silhouettes (cars, boxes: well-filled, elongated bbox) get a flatter,
 *          steeper-sided profile so they become box-like volumes.
 *   front  Hf = H0 + depthScale · fade · r, where r is the ML depth's relief
 *          calibrated against the body (least-squares a·F + b ≈ H0, so the
 *          depth range is proportional to the object's width, not arbitrary),
 *          faded to 0 at the silhouette so the surfaces meet at the rim.
 *   back   Hb = (1 − backDetail) · H0 + backDetail · blur(Hf) — a mirrored,
 *          smoothed copy of the front (big shapes such as a nose or a car
 *          bonnet carry over, fine detail does not).
 *
 * Output: one watertight triangle mesh in the shared frame (+Y up, +Z front,
 * the image's longest side = 2 units): the front surface at z = +Hf, the back
 * at z = −Hb (same triangulation, reversed) and a thin rim wall along every
 * boundary loop, sharing vertices, so every edge is used by exactly two
 * triangles with opposite directions. Pinch vertices (two surface fans
 * touching at one grid vertex) are cut out first. UVs map the source image
 * onto the front; the back uses the same UVs (so it shows the mirrored front
 * image, like a back view of a symmetric subject). Groups: 0 front, 1 back,
 * 2 rim wall.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import type { DepthMap, Mask } from '../../core/types';
import { blurFloat } from '../../core/image/ops';
import { distanceTransform } from '../../core/image/distance';
import { inflateDepth } from '../heuristic/inflate';

export type VolumeShape = 'auto' | 'round' | 'boxy';

export interface VolumeOptions {
  /** Body profile: round (balloon), boxy (flatter top, steep sides) or auto from the silhouette. */
  shape: VolumeShape;
  /** Body thickness multiplier; 0 = auto (1 for round bodies, 0.85 for boxy ones). */
  thickness: number;
  /** 0..1: how much of the (smoothed) front relief is mirrored onto the back. */
  backDetail: number;
  /** Relief amplitude multiplier on the calibrated ML depth; 0 = auto (1). */
  depthScale: number;
}

export const DEFAULT_VOLUME_OPTIONS: VolumeOptions = { shape: 'auto', thickness: 0, backDetail: 0.5, depthScale: 0 };

export interface VolumeInfo {
  /** 0 = round, 1 = boxy (the profile blend actually used). */
  boxiness: number;
  thickness: number;
  depthScale: number;
  /** The ML depth contributed relief (false: inflation only). */
  usedDepth: boolean;
  /** Relief fit: scene units per unit of normalised depth (0 when unused). */
  reliefGain: number;
  vertices: number;
  triangles: number;
}

/** Silhouette statistics used by the auto settings. */
export function silhouetteStats(mask: Mask): { area: number; fill: number; aspect: number } {
  const { width: w, height: h, data } = mask;
  let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!data[y * w + x]) continue;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (area === 0) return { area: 0, fill: 0, aspect: 1 };
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  return { area, fill: area / (bw * bh), aspect: Math.max(bw, bh) / Math.min(bw, bh) };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * How box-like the silhouette is: a disk or any compact blob (aspect ≈ 1) → 0,
 * a thin-limbed standing character (fill ≲ 0.6) → 0, a well-filled elongated
 * shape (car side view fill ≈ 0.7–0.85, a box) → up to 1.
 */
export function autoBoxiness(stats: { fill: number; aspect: number }): number {
  return clamp01((stats.fill - 0.6) / 0.2) * clamp01((stats.aspect - 1.15) / 0.45);
}

/** Least-squares a·F + b ≈ target over the weighted pixels, with guards. */
export function fitRelief(F: Float32Array, target: Float32Array, weight: Float32Array): { a: number; b: number } {
  let sw = 0, sf = 0, st = 0;
  for (let i = 0; i < F.length; i++) {
    const w = weight[i];
    if (w <= 0) continue;
    sw += w;
    sf += w * F[i];
    st += w * target[i];
  }
  if (sw <= 0) return { a: 0, b: 0 };
  const mf = sf / sw, mt = st / sw;
  let cov = 0, varF = 0, tMax = 0;
  for (let i = 0; i < F.length; i++) {
    const w = weight[i];
    if (w <= 0) continue;
    const df = F[i] - mf;
    cov += w * df * (target[i] - mt);
    varF += w * df * df;
    if (target[i] > tMax) tMax = target[i];
  }
  if (varF / sw < 1e-6) return { a: 0, b: mt };
  let a = cov / varF;
  // Weakly / anti-correlated depth (e.g. an odd lighting guess): still use its
  // relief, scaled so its ±1σ spans about half the body's thickness.
  const aRange = (0.5 * tMax) / Math.max(1e-3, 2 * Math.sqrt(varF / sw));
  if (!(a > 0.25 * aRange)) a = aRange;
  return { a, b: mt - a * mf };
}

/**
 * Build the closed body. `mask` and `front` (if given) share the grid size;
 * `front` is a normalised depth (1 = nearest) or null for inflation only.
 */
export function buildDepthVolume(
  mask: Mask,
  front: DepthMap | null,
  opts: VolumeOptions = DEFAULT_VOLUME_OPTIONS,
): { geometry: BufferGeometry; info: VolumeInfo } {
  const { width: gw, height: gh, data: m } = mask;
  const n = gw * gh;
  const L = Math.max(gw, gh);
  const s = 2 / L; // scene units per grid pixel
  if (front && (front.width !== gw || front.height !== gh)) throw new Error('front depth and mask sizes differ');

  // --- body half-thickness H0 (scene units)
  const stats = silhouetteStats(mask);
  const boxiness = opts.shape === 'round' ? 0 : opts.shape === 'boxy' ? 1 : autoBoxiness(stats);
  const thickness = opts.thickness > 0 ? opts.thickness : 1 - 0.15 * boxiness;
  const dist = distanceTransform(mask);
  let rMax = 0;
  for (let i = 0; i < n; i++) if (dist[i] > rMax) rMax = dist[i];
  const inflated = inflateDepth(mask, null, { profile: 'round', thickness: 0, detail: 0, blur: 1 }).data;
  const power = 1 - 0.65 * boxiness; // < 1 lifts the dome's flanks: a flatter top with steep sides
  const H0 = new Float32Array(n);
  for (let i = 0; i < n; i++) if (m[i]) H0[i] = thickness * rMax * s * Math.pow(inflated[i], power);

  // --- front relief from the ML depth
  const minH = 0.35 * s;
  const Hf = new Float32Array(n);
  const ramp = Math.max(2, 0.05 * L);
  let usedDepth = false;
  let reliefGain = 0;
  const depthScale = opts.depthScale > 0 ? opts.depthScale : 1;
  if (front) {
    const weight = new Float32Array(n);
    for (let i = 0; i < n; i++) weight[i] = m[i] ? Math.min(1, dist[i] / ramp) : 0;
    const { a, b } = fitRelief(front.data, H0, weight);
    if (a > 0) {
      usedDepth = true;
      reliefGain = a * depthScale;
      for (let i = 0; i < n; i++) {
        if (!m[i]) continue;
        const r = a * front.data[i] + b - H0[i];
        const t = Math.min(1, dist[i] / ramp);
        const fade = t * t * (3 - 2 * t);
        Hf[i] = Math.max(minH, H0[i] + depthScale * fade * r);
      }
    }
  }
  if (!usedDepth) for (let i = 0; i < n; i++) if (m[i]) Hf[i] = Math.max(minH, H0[i]);

  // --- back: body blended with the smoothed front
  const beta = clamp01(opts.backDetail);
  const smooth = beta > 0 ? blurFloat(Hf, gw, gh, Math.max(2, 0.03 * L), 3, mask) : Hf;
  const Hb = new Float32Array(n);
  for (let i = 0; i < n; i++) if (m[i]) Hb[i] = Math.max(minH, (1 - beta) * H0[i] + beta * smooth[i]);

  const geometry = stitchClosedSurface(mask, Hf, Hb, s);
  const index = geometry.getIndex();
  const info: VolumeInfo = {
    boxiness,
    thickness,
    depthScale,
    usedDepth,
    reliefGain,
    vertices: geometry.getAttribute('position').count,
    triangles: index ? index.count / 3 : 0,
  };
  geometry.userData.depthVolume = info;
  return { geometry, info };
}

/**
 * Two height fields over the same mask → one closed, consistently oriented
 * mesh: front vertices at z = +front[i], back at z = −back[i] (both at the
 * foreground pixel centres), a wall joining their boundary loops.
 */
export function stitchClosedSurface(mask: Mask, front: Float32Array, back: Float32Array, s: number): BufferGeometry {
  const { width: gw, height: gh, data: m } = mask;
  const at = (i: number, j: number) => j * gw + i;

  // Triangles of the front (CCW seen from +Z), over cells between pixel centres.
  const tris: number[] = [];
  for (let j = 0; j + 1 < gh; j++) {
    for (let i = 0; i + 1 < gw; i++) {
      const v00 = at(i, j), v10 = at(i + 1, j), v01 = at(i, j + 1), v11 = at(i + 1, j + 1);
      const c = m[v00] + m[v10] + m[v01] + m[v11];
      if (c < 3) continue;
      if (c === 4) {
        // Split along the diagonal with the smaller height jump.
        if (Math.abs(front[v01] - front[v10]) <= Math.abs(front[v00] - front[v11])) tris.push(v01, v11, v10, v01, v10, v00);
        else tris.push(v01, v11, v00, v11, v10, v00);
      } else if (!m[v00]) tris.push(v01, v11, v10);
      else if (!m[v10]) tris.push(v01, v11, v00);
      else if (!m[v11]) tris.push(v01, v10, v00);
      else tris.push(v11, v10, v00);
    }
  }

  // Cut out pinch vertices (more than one boundary loop passing through them) until none remain.
  let alive = new Uint8Array(tris.length / 3).fill(1);
  for (let iter = 0; iter < 16; iter++) {
    const bcount = boundaryCount(tris, alive, gw * gh);
    const bad = new Uint8Array(gw * gh);
    let any = false;
    for (let v = 0; v < bcount.length; v++) if (bcount[v] > 2) { bad[v] = 1; any = true; }
    if (!any) break;
    for (let t = 0; t < alive.length; t++) {
      if (alive[t] && (bad[tris[3 * t]] || bad[tris[3 * t + 1]] || bad[tris[3 * t + 2]])) alive[t] = 0;
    }
  }
  const kept: number[] = [];
  for (let t = 0; t < alive.length; t++) if (alive[t]) kept.push(tris[3 * t], tris[3 * t + 1], tris[3 * t + 2]);
  alive = new Uint8Array(0);

  // Directed boundary edges (a → b of a triangle with no twin b → a).
  const edgeKey = (a: number, b: number) => a * (gw * gh) + b;
  const directed = new Set<number>();
  for (let t = 0; t < kept.length; t += 3) {
    for (let e = 0; e < 3; e++) directed.add(edgeKey(kept[t + e], kept[t + ((e + 1) % 3)]));
  }
  const bnext = new Map<number, number>(); // boundary a → b
  const bprev = new Map<number, number>();
  for (let t = 0; t < kept.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = kept[t + e], b = kept[t + ((e + 1) % 3)];
      if (!directed.has(edgeKey(b, a))) {
        bnext.set(a, b);
        bprev.set(b, a);
      }
    }
  }

  // Compact vertex numbering: front k, back k + nv.
  const remap = new Int32Array(gw * gh).fill(-1);
  let nv = 0;
  for (const v of kept) if (remap[v] < 0) remap[v] = nv++;
  const px = new Float32Array(nv), py = new Float32Array(nv);
  const orig = new Int32Array(nv);
  for (let v = 0; v < gw * gh; v++) {
    const k = remap[v];
    if (k < 0) continue;
    orig[k] = v;
    px[k] = (v % gw) + 0.5;
    py[k] = Math.floor(v / gw) + 0.5;
  }
  // Soften the pixel staircase of the outline: boundary vertices move halfway
  // towards the midpoint of their loop neighbours (twice; UVs follow).
  for (let pass = 0; pass < 2; pass++) {
    const nx = px.slice(), ny = py.slice();
    for (const [a, b] of bnext) {
      const p = bprev.get(a);
      if (p === undefined) continue;
      const ka = remap[a], kb = remap[b], kp = remap[p];
      nx[ka] = 0.5 * px[ka] + 0.25 * (px[kb] + px[kp]);
      ny[ka] = 0.5 * py[ka] + 0.25 * (py[kb] + py[kp]);
    }
    px.set(nx);
    py.set(ny);
  }

  const pos = new Float32Array(2 * nv * 3);
  const uv = new Float32Array(2 * nv * 2);
  for (let k = 0; k < nv; k++) {
    const X = (px[k] - gw / 2) * s, Y = (gh / 2 - py[k]) * s;
    const u = px[k] / gw, v = 1 - py[k] / gh;
    const zf = front[orig[k]], zb = -back[orig[k]];
    pos.set([X, Y, zf], 3 * k);
    pos.set([X, Y, zb], 3 * (k + nv));
    uv.set([u, v], 2 * k);
    uv.set([u, v], 2 * (k + nv));
  }

  const nf = kept.length;
  const nWall = bnext.size * 6;
  const total = 2 * nf + nWall;
  const idx = 2 * nv > 65535 ? new Uint32Array(total) : new Uint16Array(total);
  let o = 0;
  for (let t = 0; t < nf; t += 3) {
    idx[o++] = remap[kept[t]];
    idx[o++] = remap[kept[t + 1]];
    idx[o++] = remap[kept[t + 2]];
  }
  for (let t = 0; t < nf; t += 3) {
    idx[o++] = remap[kept[t]] + nv;
    idx[o++] = remap[kept[t + 2]] + nv;
    idx[o++] = remap[kept[t + 1]] + nv;
  }
  for (const [a0, b0] of bnext) {
    // Front edge a → b; back edge b' → a' (reversed): wall faces b → a → a' and b → a' → b'.
    const a = remap[a0], b = remap[b0], a2 = a + nv, b2 = b + nv;
    idx[o++] = b; idx[o++] = a; idx[o++] = a2;
    idx[o++] = b; idx[o++] = a2; idx[o++] = b2;
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setIndex(new BufferAttribute(idx, 1));
  g.addGroup(0, nf, 0);
  g.addGroup(nf, nf, 1);
  g.addGroup(2 * nf, nWall, 2);
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Per vertex: number of boundary edges (in + out) among the alive triangles. */
function boundaryCount(tris: number[], alive: Uint8Array, nVerts: number): Uint8Array {
  const key = (a: number, b: number) => a * nVerts + b;
  const directed = new Set<number>();
  for (let t = 0; t < alive.length; t++) {
    if (!alive[t]) continue;
    for (let e = 0; e < 3; e++) directed.add(key(tris[3 * t + e], tris[3 * t + ((e + 1) % 3)]));
  }
  const count = new Uint8Array(nVerts);
  for (let t = 0; t < alive.length; t++) {
    if (!alive[t]) continue;
    for (let e = 0; e < 3; e++) {
      const a = tris[3 * t + e], b = tris[3 * t + ((e + 1) % 3)];
      if (!directed.has(key(b, a))) {
        count[a] = Math.min(255, count[a] + 1);
        count[b] = Math.min(255, count[b] + 1);
      }
    }
  }
  return count;
}
