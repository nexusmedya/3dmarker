/**
 * Automatic skeleton placement for animals (quadruped, bird, snake / chain)
 * and the template suggestion.
 *
 * Animals are usually photographed from the side, so the mesh's body runs
 * along one horizontal axis:
 *
 *  1. Body axis: PCA of the vertices projected on the ground plane (XZ).
 *  2. Side profile: the mesh is rotated so that axis is +X and rasterised
 *     with the humanoid silhouette grid (./autoJoints.ts buildSilhouette):
 *     per cell the occupancy and the lateral extent (the grid's Z). When the
 *     body axis is the image's X, the front image mask (if given) is OR-ed in
 *     (thin legs a relief mesh lost still count).
 *  3. Slice analysis: columns that reach the ground are legs; contiguous
 *     runs of them are clustered and split into a front and a hind group at
 *     the largest gap. The belly is the median bottom of the columns between
 *     the groups. The head is at the end whose top is higher (a tail is low
 *     and thin; ties → more area above the belly).
 *  4. Joints: torso centre lines above the leg groups (hips / chest), the
 *     head / neck from the top-most runs towards the head tip, leg joints on
 *     the leg run centres at anatomical heights, the tail traced column by
 *     column (the run nearest the previous one) and resampled into 3–6 bones.
 *
 * Front-facing animals (body axis along the view, a left–right symmetric
 * silhouette not much wider than tall) get a proportional skeleton facing
 * +Z with the legs at the ground clusters. Snakes / chains follow the 3D
 * principal axis (vertex centroids of slices along it; the head is the
 * thicker end). Without legs the template is placed proportionally in the
 * body frame.
 */
import { Box3, Vector3 } from 'three';
import type { Mask } from '../core/types';
import { buildSilhouette, type JointMethod, type Silhouette } from './autoJoints';
import type { MeshData } from './meshData';
import { plain } from './spec';
import { BodyFrame, birdKeysIn, birdSpec, chainSpec, proportionalSpec, quadrupedKeysIn, quadrupedSpec, type BirdKeys, type QuadrupedKeys } from './templates';
import type { SkeletonSpec, TemplateId, Vec3 } from './types';

export type AnimalTemplate = 'quadruped' | 'bird' | 'snake';
export type AnimalMethod = 'side' | 'front' | 'chain' | 'proportional';

export interface AnimalAutoOptions {
  /** Front image mask (image pixels), used when the body axis is the image's horizontal. */
  imageMask?: Mask | null;
  /** Profile grid cells along the longest side (default 160). */
  resolution?: number;
}

export interface AnimalAutoResult {
  spec: SkeletonSpec;
  method: AnimalMethod;
  /** 0..1 how well the shape matched the template's expectations. */
  confidence: number;
  /** Leg groups found in the side profile (0, 1 or 2). */
  legGroups: number;
}

// ---------------------------------------------------------------------------
// Profile analysis

interface Group {
  i0: number;
  i1: number;
  /** Centre column (fractional). */
  c: number;
}

export interface Profile {
  /** Principal horizontal axis (unit, y = 0). */
  axis: Vector3;
  /** Lateral axis in the ground plane: axis × up. */
  lateral: Vector3;
  /** Horizontal centre of the vertices (y = 0). */
  mean: Vector3;
  /** λ1 / λ2 of the horizontal PCA. */
  elongation: number;
  s: Silhouette;
  /** Occupied bounds (cells). */
  iLo: number;
  iHi: number;
  jLo: number;
  jHi: number;
  /** Length along the axis and height (model units). */
  L: number;
  H: number;
  /** Lateral extent (model units). */
  W: number;
  groups: Group[];
  /** Belly height (y) above which the torso is. */
  belly: number;
  ground: number;
  /** +1: head at the high-u end, -1 at the low end. */
  headSign: 1 | -1;
  /** Left–right symmetry (IoU of the mirrored XY silhouette, original frame), 0..1. */
  symmetry: number;
  /** XY silhouette width / height (original frame). */
  aspectXY: number;
}

function horizontalPca(p: Float32Array): { mean: Vector3; axis: Vector3; ratio: number } {
  const n = p.length / 3;
  const step = Math.max(1, Math.floor(n / 40000));
  let mx = 0, mz = 0, k = 0;
  for (let i = 0; i < n; i += step) (mx += p[i * 3 + 0]), (mz += p[i * 3 + 2]), k++;
  mx /= Math.max(k, 1);
  mz /= Math.max(k, 1);
  let xx = 0, xz = 0, zz = 0;
  for (let i = 0; i < n; i += step) {
    const dx = p[i * 3] - mx, dz = p[i * 3 + 2] - mz;
    xx += dx * dx;
    xz += dx * dz;
    zz += dz * dz;
  }
  const th = 0.5 * Math.atan2(2 * xz, xx - zz);
  const axis = new Vector3(Math.cos(th), 0, Math.sin(th));
  const tr = xx + zz, det = xx * zz - xz * xz;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(tr / 2 - disc, 1e-12);
  // Prefer the image axes when the PCA is ambiguous or nearly aligned (depth meshes: X).
  if (Math.abs(axis.x) > 0.97) axis.set(Math.sign(axis.x) || 1, 0, 0);
  if (axis.x < -1e-9 || (Math.abs(axis.x) < 1e-9 && axis.z < 0)) axis.negate();
  return { mean: new Vector3(mx, 0, mz), axis, ratio: l1 / l2 };
}

/** XY silhouette symmetry about its bbox centre (original frame) and width / height. */
function xySymmetry(data: MeshData): { symmetry: number; aspect: number; s: Silhouette } {
  const s = buildSilhouette(data, 96);
  let iLo = s.nx, iHi = -1, jLo = s.ny, jHi = -1;
  for (let j = 0; j < s.ny; j++) for (let i = 0; i < s.nx; i++) if (s.occ[j * s.nx + i]) (iLo = Math.min(iLo, i)), (iHi = Math.max(iHi, i)), (jLo = Math.min(jLo, j)), (jHi = Math.max(jHi, j));
  if (iHi < 0) return { symmetry: 0, aspect: 1, s };
  let inter = 0, uni = 0;
  for (let j = jLo; j <= jHi; j++) {
    for (let i = iLo; i <= iHi; i++) {
      const a = s.occ[j * s.nx + i], b = s.occ[j * s.nx + (iLo + iHi - i)];
      if (a && b) inter++;
      if (a || b) uni++;
    }
  }
  return { symmetry: uni ? inter / uni : 0, aspect: (iHi - iLo + 1) / (jHi - jLo + 1), s };
}

function rotatedData(data: MeshData, mean: Vector3, axis: Vector3, lateral: Vector3): MeshData {
  const p = data.positions, n = p.length / 3;
  const out = new Float32Array(p.length);
  const box = new Box3();
  const v = new Vector3();
  for (let i = 0; i < n; i++) {
    const dx = p[i * 3] - mean.x, dz = p[i * 3 + 2] - mean.z;
    v.set(dx * axis.x + dz * axis.z, p[i * 3 + 1], dx * lateral.x + dz * lateral.z);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
    box.expandByPoint(v);
  }
  return { positions: out, index: data.index, ranges: [], box };
}

/** OR the front image mask into a profile whose axis is the image's ±X. */
function mergeMask(s: Silhouette, mask: Mask, data: MeshData, axisSign: number, mean: Vector3): void {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) if (mask.data[y * mask.width + x]) (x0 = Math.min(x0, x)), (x1 = Math.max(x1, x)), (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y));
  if (x1 < x0 || data.box.isEmpty()) return;
  const b = data.box;
  const bw = Math.max(b.max.x - b.min.x, 1e-9), bh = Math.max(b.max.y - b.min.y, 1e-9);
  for (let j = 0; j < s.ny; j++) {
    const y = s.y0 + (j + 0.5) * s.cell;
    const py = Math.floor(y0 + ((b.max.y - y) / bh) * (y1 - y0 + 1));
    if (py < y0 || py > y1) continue;
    for (let i = 0; i < s.nx; i++) {
      const k = j * s.nx + i;
      if (s.occ[k]) continue;
      const u = s.x0 + (i + 0.5) * s.cell;
      const x = mean.x + axisSign * u;
      const px = Math.floor(x0 + ((x - b.min.x) / bw) * (x1 - x0 + 1));
      if (px >= x0 && px <= x1 && mask.data[py * mask.width + px]) s.occ[k] = 1;
    }
  }
}

export function analyzeProfile(data: MeshData, opts: AnimalAutoOptions = {}): Profile {
  const { mean, axis, ratio } = horizontalPca(data.positions);
  const up = new Vector3(0, 1, 0);
  const lateral = new Vector3().crossVectors(axis, up).normalize();
  const rot = rotatedData(data, mean, axis, lateral);
  const s = buildSilhouette(rot, opts.resolution ?? 160);
  if (opts.imageMask && Math.abs(axis.x) > 0.97) mergeMask(s, opts.imageMask, data, Math.sign(axis.x), mean);
  const sym = xySymmetry(data);

  let iLo = s.nx, iHi = -1, jLo = s.ny, jHi = -1;
  for (let j = 0; j < s.ny; j++) for (let i = 0; i < s.nx; i++) if (s.occ[j * s.nx + i]) (iLo = Math.min(iLo, i)), (iHi = Math.max(iHi, i)), (jLo = Math.min(jLo, j)), (jHi = Math.max(jHi, j));
  if (iHi < 0) (iLo = 0), (iHi = s.nx - 1), (jLo = 0), (jHi = s.ny - 1);
  const cell = s.cell;
  const L = (iHi - iLo + 1) * cell, H = (jHi - jLo + 1) * cell;
  const W = rot.box.isEmpty() ? 0 : rot.box.max.z - rot.box.min.z;
  const ground = s.y0 + jLo * cell;

  // Per column: lowest / highest occupied row.
  const bottom = new Int32Array(s.nx).fill(-1), top = new Int32Array(s.nx).fill(-1);
  for (let i = 0; i < s.nx; i++) {
    for (let j = 0; j < s.ny; j++) {
      if (!s.occ[j * s.nx + i]) continue;
      if (bottom[i] < 0) bottom[i] = j;
      top[i] = j;
    }
  }
  // Ground-reaching columns → clusters (1-cell cracks bridged).
  const reach = Math.max(1, Math.round(0.08 * (jHi - jLo + 1)));
  const clusters: Group[] = [];
  let start = -1, lastOn = -10;
  for (let i = iLo; i <= iHi + 1; i++) {
    const on = i <= iHi && bottom[i] >= 0 && bottom[i] <= jLo + reach;
    if (on) {
      if (start < 0 || i - lastOn > 2) {
        if (start >= 0) clusters.push({ i0: start, i1: lastOn, c: (start + lastOn) / 2 });
        start = i;
      }
      lastOn = i;
    }
  }
  if (start >= 0) clusters.push({ i0: start, i1: lastOn, c: (start + lastOn) / 2 });
  const span = iHi - iLo + 1;
  let groups: Group[];
  if (!clusters.length || (clusters.length === 1 && clusters[0].i1 - clusters[0].i0 + 1 > 0.6 * span)) groups = [];
  else if (clusters.length === 1) groups = [clusters[0]];
  else {
    let gapAt = 0, gap = -1;
    for (let k = 0; k + 1 < clusters.length; k++) {
      const g = clusters[k + 1].i0 - clusters[k].i1;
      if (g > gap) (gap = g), (gapAt = k);
    }
    const a = clusters.slice(0, gapAt + 1), b = clusters.slice(gapAt + 1);
    const merge = (cs: Group[]): Group => ({ i0: cs[0].i0, i1: cs[cs.length - 1].i1, c: cs.reduce((t, x) => t + x.c * (x.i1 - x.i0 + 1), 0) / cs.reduce((t, x) => t + x.i1 - x.i0 + 1, 0) });
    groups = [merge(a), merge(b)];
  }

  // Belly: median bottom of the columns between the groups (or outside a single group).
  const ys: number[] = [];
  const pushCol = (i: number) => {
    if (bottom[i] >= 0 && bottom[i] > jLo + reach) ys.push(s.y0 + bottom[i] * cell);
  };
  if (groups.length === 2) for (let i = groups[0].i1 + 1; i < groups[1].i0; i++) pushCol(i);
  else if (groups.length === 1) for (let i = iLo; i <= iHi; i++) if (i < groups[0].i0 - 1 || i > groups[0].i1 + 1) pushCol(i);
  ys.sort((a, b) => a - b);
  let belly = ys.length ? ys[ys.length >> 1] : ground + 0.45 * H;
  belly = Math.min(Math.max(belly, ground + 0.15 * H), ground + 0.8 * H);

  // Head end: the higher top (ties: more area above the belly).
  const lowEnd = groups.length ? Math.round(groups[0].c) : iLo + Math.round(0.35 * span);
  const highEnd = groups.length ? Math.round(groups[groups.length - 1].c) : iHi - Math.round(0.35 * span);
  const bellyJ = Math.floor((belly - s.y0) / cell);
  const endStats = (a: number, b: number) => {
    let topMax = -1, area = 0;
    for (let i = Math.max(iLo, a); i <= Math.min(iHi, b); i++) {
      if (top[i] > topMax) topMax = top[i];
      for (let j = Math.max(bellyJ, 0); j <= jHi; j++) if (s.occ[j * s.nx + i]) area++;
    }
    return { topMax, area };
  };
  const lo = endStats(iLo, lowEnd), hi = endStats(highEnd, iHi);
  let headSign: 1 | -1;
  const tall = 0.06 * (jHi - jLo + 1);
  if (Math.abs(hi.topMax - lo.topMax) > tall) headSign = hi.topMax > lo.topMax ? 1 : -1;
  else headSign = hi.area >= lo.area ? 1 : -1;

  return {
    axis, lateral, mean, elongation: ratio, s, iLo, iHi, jLo, jHi, L, H, W,
    groups, belly, ground, headSign, symmetry: sym.symmetry, aspectXY: sym.aspect,
  };
}

// ---------------------------------------------------------------------------
// Profile helpers

class ProfileView {
  readonly s: Silhouette;
  readonly cell: number;
  readonly latMid: number;
  constructor(readonly p: Profile) {
    this.s = p.s;
    this.cell = p.s.cell;
    let sum = 0, n = 0;
    for (let k = 0; k < this.s.occ.length; k++) if (this.s.occ[k] && Number.isFinite(this.s.zMin[k])) (sum += (this.s.zMin[k] + this.s.zMax[k]) / 2), n++;
    this.latMid = n ? sum / n : 0;
  }
  u(i: number) {
    return this.s.x0 + (i + 0.5) * this.cell;
  }
  y(j: number) {
    return this.s.y0 + (j + 0.5) * this.cell;
  }
  col(u: number) {
    return Math.min(this.p.iHi, Math.max(this.p.iLo, Math.floor((u - this.s.x0) / this.cell)));
  }
  row(y: number) {
    return Math.min(this.s.ny - 1, Math.max(0, Math.floor((y - this.s.y0) / this.cell)));
  }
  occ(i: number, j: number) {
    return i >= 0 && i < this.s.nx && j >= 0 && j < this.s.ny && this.s.occ[j * this.s.nx + i] === 1;
  }
  runs(i: number): [number, number][] {
    const out: [number, number][] = [];
    let a = -1;
    for (let j = 0; j <= this.s.ny; j++) {
      const on = j < this.s.ny && this.occ(i, j);
      if (on && a < 0) a = j;
      else if (!on && a >= 0) (out.push([a, j - 1]), (a = -1));
    }
    return out;
  }
  /** The vertical run of column u containing (or nearest to) y, in model units [bottom, top]. */
  runAt(u: number, y: number): [number, number] | null {
    const i = this.col(u), j = this.row(y);
    let best: [number, number] | null = null, bestD = Infinity;
    for (const [a, b] of this.runs(i)) {
      const d = j < a ? a - j : j > b ? j - b : 0;
      if (d < bestD) (bestD = d), (best = [a, b]);
    }
    return best && [this.y(best[0]) - this.cell / 2, this.y(best[1]) + this.cell / 2];
  }
  /** Top of the top-most run of column u. */
  topAt(u: number): number | null {
    const r = this.runs(this.col(u));
    return r.length ? this.y(r[r.length - 1][1]) + this.cell / 2 : null;
  }
  /** Middle of the top-most run of column u. */
  crestMid(u: number): number | null {
    const r = this.runs(this.col(u));
    return r.length ? (this.y(r[r.length - 1][0]) + this.y(r[r.length - 1][1])) / 2 : null;
  }
  /** Torso span of column u above the belly: [max(runBottom, belly), runTop]. */
  torso(u: number): [number, number] {
    const b = this.p.belly;
    const r = this.runAt(u, b + 0.12 * this.p.H);
    if (!r) return [b, b + 0.3 * this.p.H];
    return [Math.max(r[0], b), Math.max(r[1], b + 2 * this.cell)];
  }
  /** Lateral middle / half extent of the cell nearest (u, y). */
  lateral(u: number, y: number): { mid: number; half: number } {
    const i = this.col(u), j = this.row(y);
    for (let r = 0; r <= 4; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          const ii = i + di, jj = j + dj;
          if (!this.occ(ii, jj)) continue;
          const k = jj * this.s.nx + ii;
          const lo = this.s.zMin[k], hi = this.s.zMax[k];
          if (Number.isFinite(lo) && Number.isFinite(hi)) return { mid: (lo + hi) / 2, half: (hi - lo) / 2 };
        }
      }
    }
    return { mid: this.latMid, half: 0 };
  }
  /** Centre (u) of the occupied run in row y within columns [i0, i1] closest to uc; uc when none. */
  legCenter(y: number, i0: number, i1: number, uc: number): number {
    const j = this.row(y);
    let best = uc, bestD = Infinity, a = -1;
    for (let i = Math.max(0, i0 - 2); i <= Math.min(this.s.nx - 1, i1 + 2) + 1; i++) {
      const on = i <= Math.min(this.s.nx - 1, i1 + 2) && this.occ(i, j);
      if (on && a < 0) a = i;
      else if (!on && a >= 0) {
        const c = (this.u(a) + this.u(i - 1)) / 2;
        if (Math.abs(c - uc) < bestD) (bestD = Math.abs(c - uc)), (best = c);
        a = -1;
      }
    }
    return best;
  }
  /** Farthest occupied column from `from` in direction `dir` with a cell above `minY`. */
  extreme(dir: 1 | -1, minY: number): number {
    const jMin = this.row(minY);
    let found = dir > 0 ? this.p.iLo : this.p.iHi;
    for (let i = this.p.iLo; i <= this.p.iHi; i++) {
      let ok = false;
      for (let j = jMin; j <= this.p.jHi && !ok; j++) ok = this.occ(i, j);
      if (ok && (dir > 0 ? i > found : i < found)) found = i;
    }
    return this.u(found);
  }
}

/** Resample a polyline into n + 1 evenly spaced points. */
function resample(pts: { u: number; y: number }[], n: number): { u: number; y: number }[] {
  const d = [0];
  for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + Math.hypot(pts[i].u - pts[i - 1].u, pts[i].y - pts[i - 1].y));
  const total = d[d.length - 1];
  const out: { u: number; y: number }[] = [];
  for (let k = 0; k <= n; k++) {
    const t = (total * k) / n;
    let i = 1;
    while (i < d.length - 1 && d[i] < t) i++;
    const f = d[i] - d[i - 1] > 1e-12 ? (t - d[i - 1]) / (d[i] - d[i - 1]) : 0;
    out.push({ u: pts[i - 1].u + (pts[i].u - pts[i - 1].u) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Placement

/** Map profile coordinates (u along the axis, y, w lateral) back to the model frame. */
function toModel(p: Profile, u: number, y: number, w: number): Vec3 {
  return plain(p.mean.clone().addScaledVector(p.axis, u).addScaledVector(p.lateral, w).setY(y));
}

function sideQuadruped(p: Profile, v: ProfileView): { keys: QuadrupedKeys; confidence: number } | null {
  if (p.groups.length === 0) return null;
  const s = p.headSign;
  const L = p.L, H = p.H, ground = p.ground, belly = p.belly;
  let front: Group, hind: Group;
  let confidence = 0.85;
  if (p.groups.length === 2) {
    [hind, front] = s > 0 ? [p.groups[0], p.groups[1]] : [p.groups[1], p.groups[0]];
  } else {
    // One ground cluster (legs overlapping in the view): split it.
    const g = p.groups[0];
    const w = g.i1 - g.i0;
    const a: Group = { i0: g.i0, i1: g.i0 + Math.floor(w / 3), c: g.i0 + w / 6 };
    const b: Group = { i0: g.i1 - Math.floor(w / 3), i1: g.i1, c: g.i1 - w / 6 };
    [hind, front] = s > 0 ? [a, b] : [b, a];
    confidence = 0.5;
  }
  const uf = v.u(Math.round(front.c)), uh = v.u(Math.round(hind.c));
  const center = (u: number) => {
    const [b, t] = v.torso(u);
    return { b, t, c: (b + t) / 2 };
  };
  const tf = center(uf), th = center(uh);
  const lat = (u: number, y: number) => v.lateral(u, y).mid;
  const P = (u: number, y: number, w = lat(u, y)) => toModel(p, u, y, w);

  const hipsU = uh + s * 0.05 * Math.abs(uf - uh);
  const hips = P(hipsU, th.c + 0.1 * (th.t - th.c));
  const chest = P(uf, tf.c + 0.1 * (tf.t - tf.c));

  // Head / neck from the crest towards the head tip.
  const uTip = v.extreme(s, belly + 0.05 * H);
  const reachHead = Math.abs(uTip - uf);
  const headLen = Math.min(Math.max(0.35 * reachHead, 0.08 * L), 0.25 * L);
  const uHead = uTip - s * headLen * 0.85;
  const crest = (u: number, fb: number) => v.crestMid(u) ?? fb;
  const headY = crest(uHead, tf.t);
  const head = P(uHead, headY);
  const uNose = uTip - s * 0.02 * L;
  const nose = P(uNose, crest(uNose, headY) - 0.1 * headLen);
  const neckBase = P(uf + s * 0.08 * reachHead, tf.c + 0.45 * (tf.t - tf.c));
  const hl = v.lateral(uHead, headY);
  const jawHead = P(uHead + s * 0.2 * headLen, headY - 0.22 * headLen);
  const jawTail = P(uNose - s * 0.1 * headLen, headY - 0.4 * headLen);
  const headTop = v.topAt(uHead) ?? headY + 0.3 * headLen;
  const earW = Math.max(0.6 * hl.half, 0.12 * headLen);
  const side = -s; // lateral sign of the subject's left
  const ear = (sg: 1 | -1) => ({
    head: P(uHead - s * 0.15 * headLen, headY + 0.55 * (headTop - headY), hl.mid + sg * side * earW),
    tail: P(uHead - s * 0.3 * headLen, Math.max(headTop, headY + 0.4 * headLen) + 0.05 * H, hl.mid + sg * side * earW * 1.4),
  });

  // Legs.
  const legs = {} as QuadrupedKeys['legs'];
  const legH = Math.max(belly - ground, 0.1 * H);
  for (const [g, isFront, t] of [[front, true, tf], [hind, false, th]] as const) {
    const uc = v.u(Math.round(g.c));
    const at = (y: number) => v.legCenter(y, g.i0, g.i1, uc);
    const torsoHalf = Math.max(v.lateral(uc, t.c).half, 0.04 * H);
    const lw = Math.min(Math.max(0.55 * torsoHalf, 0.04 * H), 0.3 * H);
    const y2 = isFront ? belly - 0.05 * legH : belly - 0.02 * legH;
    const y3 = ground + (isFront ? 0.24 : 0.34) * legH;
    const y4 = ground + 0.03 * legH;
    let u2 = at(y2), u3 = at(y3);
    // Hind stifle forward / hock back when the profile does not show it.
    if (!isFront && Math.abs(u2 - uc) < 0.01 * L) u2 = uc + s * 0.04 * L;
    if (!isFront && Math.abs(u3 - uc) < 0.01 * L) u3 = uc - s * 0.03 * L;
    const u4 = at(y4);
    for (const sg of [1, -1] as const) {
      const w0 = lat(uc, t.c) + sg * side * lw * 0.6;
      const w = lat(uc, t.c) + sg * side * lw;
      const key = `${isFront ? 'F' : 'H'}${sg > 0 ? 'L' : 'R'}` as keyof QuadrupedKeys['legs'];
      legs[key] = [
        P(uc - s * (isFront ? 0.03 : -0.02) * L, t.c + 0.3 * (t.t - t.c), w0),
        P(uc, t.b + 0.35 * (t.c - t.b), w),
        P(u2, y2, w),
        P(u3, y3, w),
        P(u4 + s * 0.035 * L, y4, w),
      ];
    }
  }

  // Tail: trace from the rear of the torso to the tip.
  const uRear = v.extreme(-s as 1 | -1, ground + 0.02 * H);
  const tailReach = Math.abs(uRear - uh);
  const tailPts: { u: number; y: number }[] = [];
  const baseU = uh - s * 0.12 * Math.abs(uf - uh);
  let prevY = th.c + 0.35 * (th.t - th.c);
  tailPts.push({ u: baseU, y: prevY });
  if (tailReach > 0.12 * L) {
    for (let i = v.col(baseU); s > 0 ? i >= v.col(uRear) : i <= v.col(uRear); i -= s) {
      const r = v.runAt(v.u(i), prevY);
      if (!r) continue;
      const mid = (r[0] + r[1]) / 2;
      if (Math.abs(mid - prevY) > 0.2 * H) continue; // jumped to a leg
      prevY = mid;
      tailPts.push({ u: v.u(i), y: mid });
    }
  }
  let tail: Vec3[];
  if (tailPts.length >= 4) {
    let len = 0;
    for (let i = 1; i < tailPts.length; i++) len += Math.hypot(tailPts[i].u - tailPts[i - 1].u, tailPts[i].y - tailPts[i - 1].y);
    const n = Math.min(6, Math.max(3, Math.round(len / (0.07 * L))));
    tail = resample(tailPts, n).map((q) => P(q.u, q.y));
  } else {
    // A stub pointing back and up.
    tail = [0, 1, 2, 3].map((k) => P(baseU - s * 0.05 * L * k, prevY + 0.03 * H * k));
    confidence = Math.min(confidence, 0.7);
  }
  if (p.groups.length === 2 && reachHead < 0.08 * L) confidence = 0.6;
  return {
    keys: {
      frame: { forward: plain(p.axis.clone().multiplyScalar(s)), up: { x: 0, y: 1, z: 0 } },
      hips, chest, neckBase, head, nose,
      jaw: { head: jawHead, tail: jawTail },
      ears: { L: ear(1), R: ear(-1) },
      legs,
      tail,
    },
    confidence,
  };
}

function sideBird(p: Profile, v: ProfileView): { keys: BirdKeys; confidence: number } {
  const s = p.headSign;
  const L = p.L, H = p.H, ground = p.ground;
  const g = p.groups.length ? p.groups.reduce((a, b) => (Math.abs(a.c - (p.iLo + p.iHi) / 2) < Math.abs(b.c - (p.iLo + p.iHi) / 2) ? a : b)) : null;
  const uLeg = g ? v.u(Math.round(g.c)) : v.u(Math.round((p.iLo + p.iHi) / 2));
  const belly = g ? p.belly : ground + 0.35 * H;
  const [tb, tt] = v.torso(uLeg);
  const tc = (tb + tt) / 2;
  const side = -s;
  const lat = (u: number, y: number) => v.lateral(u, y).mid;
  const P = (u: number, y: number, w = lat(u, y)) => toModel(p, u, y, w);
  const uTip = v.extreme(s, belly + 0.1 * H);
  const uTail = v.extreme(-s as 1 | -1, belly);
  const bodyHalf = Math.max(v.lateral(uLeg, tc).half, 0.05 * H);
  const hips = P(uLeg - s * 0.02 * L, tc);
  const chestU = uLeg + s * 0.25 * Math.abs(uTip - uLeg);
  const [cb, ct] = v.torso(chestU);
  const chest = P(chestU, (cb + ct) / 2);
  const headLen = Math.min(0.3 * Math.abs(uTip - uLeg), 0.2 * L);
  const uHead = uTip - s * headLen;
  const headY = v.crestMid(uHead) ?? tt;
  const head = P(uHead, headY);
  const beak = P(uTip - s * 0.01 * L, (v.crestMid(uTip - s * 0.01 * L) ?? headY) - 0.05 * headLen);
  const neck0 = P(chestU + s * 0.3 * Math.abs(uHead - chestU), ct - 0.15 * (ct - cb));
  const neck1 = P(chestU + s * 0.65 * Math.abs(uHead - chestU), (ct + headY) / 2);
  const legH = Math.max(belly - ground, 0.08 * H);
  const lw = Math.max(0.45 * bodyHalf, 0.03 * H);
  const leg = (sg: 1 | -1): [Vec3, Vec3, Vec3, Vec3] => {
    const w = lat(uLeg, tc) + sg * side * lw;
    const at = (y: number) => (g ? v.legCenter(y, g.i0, g.i1, uLeg) : uLeg);
    return [P(uLeg, tb + 0.3 * (tc - tb), w), P(at(belly - 0.1 * legH) + s * 0.02 * L, belly - 0.1 * legH, w), P(at(ground + 0.12 * legH), ground + 0.12 * legH, w), P(at(ground + 0.02 * legH) + s * 0.05 * L, ground + 0.02 * legH, w)];
  };
  const spread = p.W > 1.2 * L;
  const wing = (sg: 1 | -1): [Vec3, Vec3, Vec3, Vec3] => {
    const w0 = lat(chestU, ct) + sg * side * bodyHalf * 0.8;
    const y0 = ct - 0.15 * (ct - cb);
    if (spread) {
      const half = p.W / 2;
      return [P(chestU, y0, w0), P(chestU, y0, sg * side * 0.4 * half), P(chestU - s * 0.03 * L, y0, sg * side * 0.72 * half), P(chestU - s * 0.06 * L, y0, sg * side * 0.98 * half)];
    }
    const back = Math.abs(chestU - uTail);
    return [P(chestU, y0, w0), P(chestU - s * 0.35 * back, y0 - 0.02 * H, w0 + sg * side * 0.1 * bodyHalf), P(chestU - s * 0.65 * back, y0 - 0.05 * H, w0), P(chestU - s * 0.95 * back, y0 - 0.1 * H, w0 - sg * side * 0.2 * bodyHalf)];
  };
  const tailY = v.runAt(uTail + s * 0.02 * L, tc)?.reduce((a, b) => (a + b) / 2) ?? tc;
  const tail: [Vec3, Vec3, Vec3] = [P(uLeg - s * 0.3 * Math.abs(uLeg - uTail), tc), P(uLeg - s * 0.65 * Math.abs(uLeg - uTail), (tc + tailY) / 2), P(uTail + s * 0.01 * L, tailY)];
  return {
    keys: {
      frame: { forward: plain(p.axis.clone().multiplyScalar(s)), up: { x: 0, y: 1, z: 0 } },
      hips, chest, neck: [neck0, neck1], head, beak,
      legs: { L: leg(1), R: leg(-1) },
      wings: { L: wing(1), R: wing(-1) },
      tail,
    },
    confidence: g ? 0.8 : 0.5,
  };
}

/** Front view: proportional skeleton facing +Z, legs at the XY ground clusters. */
function frontFacing(template: 'quadruped' | 'bird', data: MeshData): SkeletonSpec {
  const b = data.box;
  const size = b.getSize(new Vector3());
  const c = b.getCenter(new Vector3());
  const F = new BodyFrame(new Vector3(c.x, b.min.y, c.z), { x: 0, y: 0, z: 1 });
  const W = size.x, H = size.y;
  const L = Math.max(size.z, 1.2 * Math.min(W, H));
  if (template === 'bird') return birdSpec(birdKeysIn(F, L, H, Math.min(W, 0.5 * H), W > 1.3 * H, W));
  const keys = quadrupedKeysIn(F, L, H, W);
  // Legs where the silhouette reaches the ground.
  const s = buildSilhouette(data, 96);
  let jLo = -1;
  for (let j = 0; j < s.ny && jLo < 0; j++) for (let i = 0; i < s.nx; i++) if (s.occ[j * s.nx + i]) (jLo = j);
  const j = Math.max(0, jLo + 1);
  const xs: number[] = [];
  for (let i = 0; i < s.nx; i++) if (s.occ[j * s.nx + i]) xs.push(s.x0 + (i + 0.5) * s.cell);
  if (xs.length >= 2) {
    const lx = Math.max(...xs) - 0.05 * W, rx = Math.min(...xs) + 0.05 * W;
    for (const key of ['FL', 'FR', 'HL', 'HR'] as const) {
      const x = key[1] === 'L' ? lx : rx; // facing +Z: the subject's left is +X
      keys.legs[key] = keys.legs[key].map((q, i) => (i === 0 ? q : { ...q, x: c.x + (x - c.x) * (i === 1 ? 0.8 : 1) })) as QuadrupedKeys['legs']['FL'];
    }
  }
  return quadrupedSpec(keys);
}

/** A chain along the 3D principal axis (snakes, tails, tentacles); head at the thicker end. */
export function autoChain(data: MeshData, bones = 10): { spec: SkeletonSpec; confidence: number } {
  const p = data.positions, n = p.length / 3;
  const step = Math.max(1, Math.floor(n / 30000));
  const m = new Vector3();
  let k = 0;
  for (let i = 0; i < n; i += step) (m.x += p[i * 3]), (m.y += p[i * 3 + 1]), (m.z += p[i * 3 + 2]), k++;
  m.multiplyScalar(1 / Math.max(k, 1));
  const C = [0, 0, 0, 0, 0, 0]; // xx xy xz yy yz zz
  for (let i = 0; i < n; i += step) {
    const x = p[i * 3] - m.x, y = p[i * 3 + 1] - m.y, z = p[i * 3 + 2] - m.z;
    C[0] += x * x; C[1] += x * y; C[2] += x * z; C[3] += y * y; C[4] += y * z; C[5] += z * z;
  }
  // Power iteration for the dominant axis (horizontal start: snakes lie flat).
  const a = new Vector3(1, 0.01, 0.3).normalize();
  for (let it = 0; it < 40; it++) {
    const x = C[0] * a.x + C[1] * a.y + C[2] * a.z, y = C[1] * a.x + C[3] * a.y + C[4] * a.z, z = C[2] * a.x + C[4] * a.y + C[5] * a.z;
    a.set(x, y, z);
    if (a.lengthSq() < 1e-24) (a.set(1, 0, 0));
    a.normalize();
  }
  let tMin = Infinity, tMax = -Infinity;
  for (let i = 0; i < n; i += step) {
    const t = (p[i * 3] - m.x) * a.x + (p[i * 3 + 1] - m.y) * a.y + (p[i * 3 + 2] - m.z) * a.z;
    tMin = Math.min(tMin, t);
    tMax = Math.max(tMax, t);
  }
  const bins = Math.max(bones + 1, 4);
  const sum = Array.from({ length: bins }, () => new Vector3());
  const cnt = new Int32Array(bins);
  for (let i = 0; i < n; i += step) {
    const t = (p[i * 3] - m.x) * a.x + (p[i * 3 + 1] - m.y) * a.y + (p[i * 3 + 2] - m.z) * a.z;
    const b = Math.min(bins - 1, Math.floor(((t - tMin) / Math.max(tMax - tMin, 1e-9)) * bins));
    sum[b].x += p[i * 3]; sum[b].y += p[i * 3 + 1]; sum[b].z += p[i * 3 + 2];
    cnt[b]++;
  }
  const cents: Vector3[] = [];
  for (let b = 0; b < bins; b++) if (cnt[b]) cents.push(sum[b].clone().multiplyScalar(1 / cnt[b]));
  // Thickness at each end (mean distance of the end bins' vertices to their centroid).
  const spreadAt = (lo: number, hi: number) => {
    let d = 0, c = 0;
    for (let i = 0; i < n; i += step) {
      const t = (p[i * 3] - m.x) * a.x + (p[i * 3 + 1] - m.y) * a.y + (p[i * 3 + 2] - m.z) * a.z;
      const u = (t - tMin) / Math.max(tMax - tMin, 1e-9);
      if (u < lo || u > hi) continue;
      const q = u < 0.5 ? cents[0] : cents[cents.length - 1];
      // Distance to the axis line through the end centroid (thickness, not length).
      const dx = p[i * 3] - q.x, dy = p[i * 3 + 1] - q.y, dz = p[i * 3 + 2] - q.z;
      const along = dx * a.x + dy * a.y + dz * a.z;
      d += Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - along * along));
      c++;
    }
    return c ? d / c : 0;
  };
  const headAtMax = spreadAt(0.85, 1) >= spreadAt(0, 0.15);
  if (headAtMax) cents.reverse();
  const tipT = headAtMax ? tMax : tMin, tailT = headAtMax ? tMin : tMax;
  const headTip = cents[0].clone().add(a.clone().multiplyScalar(tipT - (cents[0].clone().sub(m).dot(a))));
  const tailTip = cents[cents.length - 1].clone().add(a.clone().multiplyScalar(tailT - (cents[cents.length - 1].clone().sub(m).dot(a))));
  const pts = [...cents, tailTip];
  // Exactly `bones` bones: resample the polyline.
  const poly = pts.map((q) => ({ q }));
  const d = [0];
  for (let i = 1; i < poly.length; i++) d.push(d[i - 1] + poly[i].q.distanceTo(poly[i - 1].q));
  const total = d[d.length - 1] || 1;
  const out: Vec3[] = [];
  for (let kk = 0; kk <= bones; kk++) {
    const t = (total * kk) / bones;
    let i = 1;
    while (i < d.length - 1 && d[i] < t) i++;
    const f = d[i] - d[i - 1] > 1e-12 ? (t - d[i - 1]) / (d[i] - d[i - 1]) : 0;
    out.push(plain(poly[i - 1].q.clone().lerp(poly[i].q, f)));
  }
  const fwd = headTip.clone().sub(new Vector3(out[1].x, out[1].y, out[1].z)).setY(0);
  const forward = fwd.lengthSq() > 1e-12 ? plain(fwd.normalize()) : { x: 1, y: 0, z: 0 };
  return { spec: chainSpec(out, plain(headTip), { forward, up: { x: 0, y: 1, z: 0 } }), confidence: 0.7 };
}

/** Place an animal template's skeleton on the mesh (see the module comment). */
export function autoPlaceAnimal(data: MeshData, template: AnimalTemplate, opts: AnimalAutoOptions = {}): AnimalAutoResult {
  if (template === 'snake') {
    const r = autoChain(data);
    return { spec: r.spec, method: 'chain', confidence: r.confidence, legGroups: 0 };
  }
  const p = analyzeProfile(data, opts);
  const v = new ProfileView(p);
  // Front-facing: body axis along the view (a symmetric XY silhouette, not much wider than tall).
  const alongX = Math.abs(p.axis.x) > 0.97;
  if (alongX && p.symmetry > 0.8 && p.aspectXY < 1.25 && template === 'quadruped') {
    return { spec: frontFacing(template, data), method: 'front', confidence: 0.45, legGroups: p.groups.length };
  }
  if (alongX && p.symmetry > 0.8 && template === 'bird' && p.aspectXY > 1.3) {
    return { spec: frontFacing(template, data), method: 'front', confidence: 0.45, legGroups: p.groups.length };
  }
  if (template === 'quadruped') {
    const r = sideQuadruped(p, v);
    if (r) return { spec: quadrupedSpec(r.keys), method: 'side', confidence: r.confidence, legGroups: p.groups.length };
  } else {
    const r = sideBird(p, v);
    return { spec: birdSpec(r.keys), method: 'side', confidence: r.confidence, legGroups: p.groups.length };
  }
  // No legs: proportional in the body frame, head at the higher end.
  const fwd = plain(p.axis.clone().multiplyScalar(p.headSign));
  return { spec: proportionalSpec(template, data.box, fwd), method: 'proportional', confidence: 0.3, legGroups: 0 };
}

// ---------------------------------------------------------------------------
// Template suggestion

export interface TemplateSuggestion {
  template: TemplateId;
  /** Why: 'pose' (a person was detected), 'tpose' (T / A-pose silhouette), 'upright', 'legs', 'long', 'bird'. */
  reason: 'pose' | 'tpose' | 'upright' | 'legs' | 'long' | 'bird';
}

export interface SuggestInput {
  data: MeshData;
  /** The humanoid auto placement's method and plausibility. */
  humanoidMethod?: JointMethod;
  plausibility?: number;
  poseFound?: boolean;
  profile?: Profile;
}

/**
 * Humanoid when a person was detected or the silhouette reads as a T / A
 * pose; else from the side profile: long and legless → snake, one narrow
 * central leg cluster → bird, taller than long → humanoid, else quadruped.
 */
export function suggestTemplate(input: SuggestInput): TemplateSuggestion {
  if (input.poseFound) return { template: 'humanoid', reason: 'pose' };
  const p = input.profile ?? analyzeProfile(input.data, { resolution: 128 });
  // A side-view quadruped can read as a T-pose (the body as the arm band, front / hind legs as a crotch):
  // a body longer than tall standing on two leg groups far apart is an animal.
  const span = p.iHi - p.iLo + 1;
  const animalStance = p.groups.length === 2 && p.L > 1.15 * p.H && p.groups[1].c - p.groups[0].c > 0.3 * span;
  if ((input.humanoidMethod === 'silhouette' || input.humanoidMethod === 'arms-down') && (input.plausibility ?? 0) >= 0.5 && !animalStance) return { template: 'humanoid', reason: 'tpose' };
  if (p.L > 3.5 * p.H || (p.L > 2.6 * p.H && p.groups.length === 0)) return { template: 'snake', reason: 'long' };
  if (p.L < 0.9 * p.H) return { template: 'humanoid', reason: 'upright' };
  if (p.groups.length === 1) {
    const g = p.groups[0];
    const rel = (g.c - p.iLo) / span;
    if ((g.i1 - g.i0 + 1) < 0.2 * span && rel > 0.25 && rel < 0.75) return { template: 'bird', reason: 'bird' };
  }
  return { template: 'quadruped', reason: 'legs' };
}

/** Where a spec's feet are (lowest joint heights), for tests / UI checks. */
export function lowestJoint(spec: SkeletonSpec): number {
  return Math.min(...spec.bones.map((b) => Math.min(b.head.y, b.tail.y)));
}
