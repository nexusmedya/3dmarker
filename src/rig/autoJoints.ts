/**
 * Automatic joint placement for the humanoid rig.
 *
 *  - Silhouette: the model's triangles are rasterised onto an XY grid (the
 *    front view) keeping, per cell, the nearest and farthest surface Z —
 *    exactly the first / last hits of a ray along Z through the cell centre.
 *    A joint's Z is the midpoint of those hits (inside the body); a single
 *    surface (relief meshes) puts it slightly behind that surface; no hit
 *    nearby falls back to the bounding-box centre.
 *  - With pose landmarks (BlazePose, src/core/human) the image pixels map to
 *    model XY by aligning the front image's mask bounding box with the
 *    model's XY bounding box. Hips = mid-hips, Neck = mid-shoulders raised
 *    towards the ears, spine interpolated, limbs from shoulders / elbows /
 *    wrists / hips / knees / ankles / feet, fingers from hand landmarks.
 *    Landmarks that are missing, off-image or not visible are grafted from
 *    the heuristic layout relative to their parent joint.
 *  - Without pose: a T-pose heuristic from the silhouette (arm band = widest
 *    rows, neck = narrowest row above it, crotch = first row below the torso
 *    whose centre is empty, feet = lowest rows); then an arms-down / A-pose
 *    reading (a line fitted through the outer limb runs beside the torso);
 *    anything else gets a symmetric proportional skeleton in its bounds, its
 *    arms hanging along the torso sides (the most common real-world pose).
 */
import { Box3, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { Mask } from '../core/types';
import { POSE, type HandResult, type Landmark, type PoseResult } from '../core/human/types';
import { CORE_BONES, fingerBone, FINGER_NAMES, mirrorBone, parentOf, SIDES, type FingerName } from './bones';
import { collectMeshData, type MeshData } from './meshData';
import type { CoreBone, HumanoidBone, JointLayout, Vec3 } from './types';

export interface AutoJointOptions {
  pose?: PoseResult | null;
  hands?: HandResult[];
  imageSize?: { width: number; height: number };
  imageMask?: Mask | null;
  /** Pre-collected triangles of `root` (rigModel shares them with skinning). */
  meshData?: MeshData;
  /** Silhouette grid cells along the longest XY side (default 192). */
  resolution?: number;
}

export type JointMethod = 'pose' | 'silhouette' | 'arms-down' | 'proportional';

export interface AutoJointResult {
  layout: JointLayout;
  method: JointMethod;
  /** Heuristic layout the pose was completed from. */
  heuristic: JointLayout;
  silhouette: Silhouette;
}

// ---------------------------------------------------------------------------
// Silhouette grid

export interface Silhouette {
  nx: number;
  ny: number;
  /** Cell size (square cells). Cell (i, j) is centred at (x0 + (i + .5)·cell, y0 + (j + .5)·cell); j = 0 is the bottom row. */
  cell: number;
  x0: number;
  y0: number;
  occ: Uint8Array;
  zMin: Float32Array;
  zMax: Float32Array;
  box: Box3;
}

export function buildSilhouette(data: MeshData, resolution = 192): Silhouette {
  const box = data.box.clone();
  const size = box.isEmpty() ? new Vector3(2, 2, 2) : box.getSize(new Vector3());
  const longest = Math.max(size.x, size.y, 1e-6);
  const cell = longest / resolution;
  const nx = Math.max(1, Math.ceil(size.x / cell) + 1);
  const ny = Math.max(1, Math.ceil(size.y / cell) + 1);
  const x0 = (box.isEmpty() ? -1 : box.min.x) - (nx * cell - size.x) / 2;
  const y0 = (box.isEmpty() ? -1 : box.min.y) - (ny * cell - size.y) / 2;
  const n = nx * ny;
  const occ = new Uint8Array(n);
  const zMin = new Float32Array(n).fill(Infinity);
  const zMax = new Float32Array(n).fill(-Infinity);
  const { positions: p, index } = data;
  const put = (k: number, z: number) => {
    occ[k] = 1;
    if (z < zMin[k]) zMin[k] = z;
    if (z > zMax[k]) zMax[k] = z;
  };
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    const ax = p[a], ay = p[a + 1], bx = p[b], by = p[b + 1], cx = p[c], cy = p[c + 1];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-14) continue; // edge-on (walls): the front / back faces cover it
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / cell - 0.5));
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) - x0) / cell - 0.5));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - y0) / cell - 0.5));
    const j1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by, cy) - y0) / cell - 0.5));
    const eps = -1e-9;
    for (let j = j0; j <= j1; j++) {
      const py = y0 + (j + 0.5) * cell;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * cell;
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
        if (w0 < eps) continue;
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
        if (w1 < eps) continue;
        const w2 = 1 - w0 - w1;
        if (w2 < eps) continue;
        put(j * nx + i, w0 * p[a + 2] + w1 * p[b + 2] + w2 * p[c + 2]);
      }
    }
  }
  // Vertices too: features thinner than a cell (fingers, wire-like parts) still show up.
  for (let v = 0; v < p.length; v += 3) {
    const i = Math.floor((p[v] - x0) / cell), j = Math.floor((p[v + 1] - y0) / cell);
    if (i >= 0 && i < nx && j >= 0 && j < ny) put(j * nx + i, p[v + 2]);
  }
  return { nx, ny, cell, x0, y0, occ, zMin, zMax, box };
}

const cellX = (s: Silhouette, i: number) => s.x0 + (i + 0.5) * s.cell;
const cellY = (s: Silhouette, j: number) => s.y0 + (j + 0.5) * s.cell;
const colOf = (s: Silhouette, x: number) => Math.min(s.nx - 1, Math.max(0, Math.floor((x - s.x0) / s.cell)));
const rowOf = (s: Silhouette, y: number) => Math.min(s.ny - 1, Math.max(0, Math.floor((y - s.y0) / s.cell)));

/**
 * Z of a joint at (x, y): midpoint of the nearest occupied cell's first and
 * last hits (searching up to `radius` cells away); one surface → `behind`
 * units behind it; nothing nearby → bounding-box centre.
 */
export function jointZ(s: Silhouette, x: number, y: number, behind: number, radius = 4): number {
  const ci = colOf(s, x), cj = rowOf(s, y);
  let best = -1, bestD = Infinity;
  for (let dj = -radius; dj <= radius; dj++) {
    const j = cj + dj;
    if (j < 0 || j >= s.ny) continue;
    for (let di = -radius; di <= radius; di++) {
      const i = ci + di;
      if (i < 0 || i >= s.nx) continue;
      const k = j * s.nx + i;
      if (!s.occ[k]) continue;
      const d = di * di + dj * dj;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
  }
  if (best < 0) return s.box.isEmpty() ? 0 : (s.box.min.z + s.box.max.z) / 2;
  const lo = s.zMin[best], hi = s.zMax[best];
  return hi - lo > behind * 0.5 ? (lo + hi) / 2 : hi - behind;
}

interface Run {
  i0: number;
  i1: number;
}

function runsOf(s: Silhouette, j: number): Run[] {
  const out: Run[] = [];
  let start = -1;
  for (let i = 0; i <= s.nx; i++) {
    const on = i < s.nx && s.occ[j * s.nx + i] === 1;
    if (on && start < 0) start = i;
    else if (!on && start >= 0) {
      out.push({ i0: start, i1: i - 1 });
      start = -1;
    }
  }
  return out;
}

/** Runs with gaps of up to `gap` cells merged (1-cell cracks between parts). */
function mergedRuns(s: Silhouette, j: number, gap = 1): Run[] {
  const out: Run[] = [];
  for (const r of runsOf(s, j)) {
    const last = out[out.length - 1];
    if (last && r.i0 - last.i1 - 1 <= gap) last.i1 = r.i1;
    else out.push({ ...r });
  }
  return out;
}

const runCenter = (s: Silhouette, r: Run) => (cellX(s, r.i0) + cellX(s, r.i1)) / 2;
const runWidth = (s: Silhouette, r: Run) => (r.i1 - r.i0 + 1) * s.cell;

/** The run of row j closest to x (containing it if any), or null. */
function runNear(s: Silhouette, j: number, x: number): Run | null {
  let best: Run | null = null, bestD = Infinity;
  for (const r of mergedRuns(s, j)) {
    const d = x < cellX(s, r.i0) ? cellX(s, r.i0) - x : x > cellX(s, r.i1) ? x - cellX(s, r.i1) : 0;
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

/** Mean Y of the occupied cells of column x within [yLo, yHi] (arm axis height), or null. */
function columnMeanY(s: Silhouette, x: number, yLo: number, yHi: number): number | null {
  const i = colOf(s, x);
  let sum = 0, n = 0;
  for (let j = rowOf(s, yLo); j <= rowOf(s, yHi); j++) {
    if (s.occ[j * s.nx + i]) {
      sum += cellY(s, j);
      n++;
    }
  }
  return n ? sum / n : null;
}

// ---------------------------------------------------------------------------
// Heuristics

type XY = { x: number; y: number };

interface Frame2D {
  cx: number;
  bottom: number;
  top: number;
  H: number;
  halfW: number;
}

function occupiedFrame(s: Silhouette): Frame2D | null {
  let jLo = -1, jHi = -1, iLo = s.nx, iHi = -1;
  for (let j = 0; j < s.ny; j++) {
    for (let i = 0; i < s.nx; i++) {
      if (!s.occ[j * s.nx + i]) continue;
      if (jLo < 0) jLo = j;
      jHi = j;
      if (i < iLo) iLo = i;
      if (i > iHi) iHi = i;
    }
  }
  if (jLo < 0) return null;
  const bottom = s.y0 + jLo * s.cell, top = s.y0 + (jHi + 1) * s.cell;
  const left = s.x0 + iLo * s.cell, right = s.x0 + (iHi + 1) * s.cell;
  return { cx: (left + right) / 2, bottom, top, H: Math.max(top - bottom, s.cell), halfW: (right - left) / 2 };
}

/** Arms hang this far below horizontal in the proportional fallback (relaxed pose). */
const HANGING_ARM_DEG = 75;

/** Symmetric skeleton with average human proportions inside the model's bounds (arms hanging along the torso sides). */
function proportionalLayout(f: Frame2D): Record<CoreBone, XY> {
  const { cx, bottom: y0, H } = f;
  const reach = Math.max(Math.min(f.halfW * 0.95, 0.47 * H), 0.2 * H);
  const armX = Math.min(0.1 * H, 0.45 * reach);
  // Upper arm + forearm ≈ 0.34 H, hanging HANGING_ARM_DEG below horizontal (wrist ≈ 0.48 H).
  const a = (HANGING_ARM_DEG * Math.PI) / 180, len = 0.34 * H;
  const legX = Math.min(0.09 * H, Math.max(0.3 * f.halfW, 0.04 * H));
  const armY = y0 + 0.81 * H;
  const out = {} as Record<CoreBone, XY>;
  const set = (b: CoreBone, x: number, y: number) => (out[b] = { x, y });
  set('Hips', cx, y0 + 0.53 * H);
  set('Neck', cx, y0 + 0.84 * H);
  set('Head', cx, y0 + 0.89 * H);
  set('HeadTop_End', cx, y0 + H);
  spineFrom(out);
  for (const sgn of [1, -1]) {
    const S = sgn > 0 ? 'Left' : 'Right';
    set(`${S}Shoulder` as CoreBone, cx + sgn * 0.3 * armX, armY + 0.02 * H);
    set(`${S}Arm` as CoreBone, cx + sgn * armX, armY);
    set(`${S}ForeArm` as CoreBone, cx + sgn * (armX + 0.55 * len * Math.cos(a)), armY - 0.55 * len * Math.sin(a));
    set(`${S}Hand` as CoreBone, cx + sgn * (armX + len * Math.cos(a)), armY - len * Math.sin(a));
    set(`${S}UpLeg` as CoreBone, cx + sgn * legX, y0 + 0.51 * H);
    set(`${S}Leg` as CoreBone, cx + sgn * legX, y0 + 0.28 * H);
    set(`${S}Foot` as CoreBone, cx + sgn * legX, y0 + 0.045 * H);
    set(`${S}ToeBase` as CoreBone, cx + sgn * legX, y0 + 0.015 * H);
  }
  return out;
}

function spineFrom(out: Record<string, XY>): void {
  const h = out.Hips, n = out.Neck;
  const at = (t: number) => ({ x: h.x + (n.x - h.x) * t, y: h.y + (n.y - h.y) * t });
  out.Spine = at(0.18);
  out.Spine1 = at(0.42);
  out.Spine2 = at(0.68);
}

/** T-pose reading of the silhouette, or null when it does not look like one. */
function tposeLayout(s: Silhouette, f: Frame2D): Record<CoreBone, XY> | null {
  const { H } = f;
  const widths = new Float32Array(s.ny);
  let maxW = 0, maxJ = -1;
  for (let j = 0; j < s.ny; j++) {
    const runs = runsOf(s, j);
    if (!runs.length) continue;
    widths[j] = (runs[runs.length - 1].i1 - runs[0].i0 + 1) * s.cell;
    if (widths[j] > maxW) {
      maxW = widths[j];
      maxJ = j;
    }
  }
  if (maxJ < 0 || maxW < 0.55 * H) return null;
  // Contiguous band of wide rows around the widest one.
  let jb = maxJ, jt = maxJ;
  while (jb > 0 && widths[jb - 1] >= 0.8 * maxW) jb--;
  while (jt < s.ny - 1 && widths[jt + 1] >= 0.8 * maxW) jt++;
  const bandBot = cellY(s, jb), bandTop = cellY(s, jt);
  const armY = (bandBot + bandTop) / 2;
  if (armY < f.bottom + 0.55 * H || bandTop - bandBot > 0.3 * H) return null;
  // Below the arms the body must be clearly narrower than the span.
  const chestJ = rowOf(s, armY - 0.14 * H);
  if (widths[chestJ] > 0.7 * maxW) return null;

  // Torso centre / width: chest rows.
  const xs: number[] = [];
  for (let j = rowOf(s, armY - 0.25 * H); j <= chestJ; j++) {
    for (let i = 0; i < s.nx; i++) if (s.occ[j * s.nx + i]) xs.push(cellX(s, i));
  }
  if (!xs.length) return null;
  xs.sort((a, b) => a - b);
  let cx = xs[xs.length >> 1];
  const chest = runNear(s, chestJ, cx);
  let torsoHalf = 0.1 * H;
  if (chest) {
    cx = runCenter(s, chest);
    torsoHalf = runWidth(s, chest) / 2;
  }
  torsoHalf = Math.min(Math.max(torsoHalf, 0.05 * H), 0.2 * H);

  // Hand tips: extreme occupied columns of the band.
  let tipL = -Infinity, tipR = Infinity;
  for (let j = jb; j <= jt; j++) {
    const runs = runsOf(s, j);
    if (!runs.length) continue;
    tipL = Math.max(tipL, cellX(s, runs[runs.length - 1].i1) + s.cell / 2);
    tipR = Math.min(tipR, cellX(s, runs[0].i0) - s.cell / 2);
  }
  const out = {} as Record<CoreBone, XY>;
  const armYAt = (x: number) => columnMeanY(s, x, armY - 0.12 * H, armY + 0.08 * H) ?? armY;
  for (const sgn of [1, -1]) {
    const S = sgn > 0 ? 'Left' : 'Right';
    const tip = sgn > 0 ? tipL : tipR;
    const span = Math.abs(tip - cx);
    const armX = cx + sgn * Math.min(Math.max(torsoHalf * 0.85, 0.06 * H), 0.4 * span);
    const handX = tip - sgn * Math.min(0.09 * H, 0.3 * span);
    // Upper arm ≈ 0.19 H, forearm ≈ 0.15 H.
    const elbowX = armX + (handX - armX) * 0.55;
    const shoulderY = armYAt(armX + sgn * 0.04 * H);
    out[`${S}Arm` as CoreBone] = { x: armX, y: shoulderY };
    out[`${S}ForeArm` as CoreBone] = { x: elbowX, y: armYAt(elbowX) };
    out[`${S}Hand` as CoreBone] = { x: handX, y: armYAt(handX) };
    out[`${S}Shoulder` as CoreBone] = { x: cx + sgn * 0.3 * Math.abs(armX - cx), y: shoulderY + 0.02 * H };
  }

  // Neck: narrowest row between the band top and the head top.
  let neckJ = -1, neckW = Infinity;
  const jTop = rowOf(s, f.top - 0.04 * H);
  for (let j = jt + 1; j < jTop; j++) {
    const r = runNear(s, j, cx);
    if (!r) continue;
    const w = runWidth(s, r);
    if (w < neckW) {
      neckW = w;
      neckJ = j;
    }
  }
  const neckBase = Math.min(bandTop + 0.02 * H, f.top - 0.16 * H);
  let headY = neckBase + 0.05 * H;
  if (neckJ >= 0) {
    // Top of the narrow part: the head joint sits at the skull base.
    let j = neckJ;
    while (j + 1 < jTop) {
      const r = runNear(s, j + 1, cx);
      if (!r || runWidth(s, r) > neckW * 1.35 + s.cell) break;
      j++;
    }
    headY = Math.min(Math.max(cellY(s, j), neckBase + 0.03 * H), f.top - 0.08 * H);
  }
  out.Neck = { x: cx, y: neckBase };
  out.Head = { x: cx, y: headY };
  out.HeadTop_End = { x: cx, y: f.top };

  // Crotch: first row below the chest whose centre is empty between two leg runs.
  let crotchY = f.bottom + 0.47 * H;
  for (let j = rowOf(s, armY - 0.2 * H); j >= rowOf(s, f.bottom + 0.1 * H); j--) {
    if (s.occ[j * s.nx + colOf(s, cx)]) continue;
    const runs = mergedRuns(s, j);
    const leftOf = runs.some((r) => runCenter(s, r) < cx && cx - cellX(s, r.i1) < 0.2 * H);
    const rightOf = runs.some((r) => runCenter(s, r) > cx && cellX(s, r.i0) - cx < 0.2 * H);
    if (leftOf && rightOf) {
      crotchY = cellY(s, j) + s.cell / 2;
      break;
    }
  }
  out.Hips = { x: cx, y: Math.min(crotchY + 0.05 * H, armY - 0.2 * H) };
  spineFrom(out);

  const legRowJ = rowOf(s, crotchY - 0.06 * H);
  const footY = f.bottom + 0.045 * H;
  for (const sgn of [1, -1]) {
    const S = sgn > 0 ? 'Left' : 'Right';
    const runs = mergedRuns(s, legRowJ).filter((r) => (runCenter(s, r) - cx) * sgn > 0);
    let legX = cx + sgn * Math.min(torsoHalf * 0.55, 0.1 * H);
    if (runs.length) {
      const r = sgn > 0 ? runs[0] : runs[runs.length - 1]; // the leg next to the crotch
      legX = runCenter(s, r);
    }
    const upY = out.Hips.y - 0.02 * H;
    const kneeY = (upY + footY) / 2 + 0.01 * H;
    const kneeRun = runNear(s, rowOf(s, kneeY), legX);
    const kneeX = kneeRun && Math.abs(runCenter(s, kneeRun) - legX) < 0.1 * H ? runCenter(s, kneeRun) : legX;
    const footRun = runNear(s, rowOf(s, footY), kneeX);
    const footX = footRun && Math.abs(runCenter(s, footRun) - kneeX) < 0.1 * H ? runCenter(s, footRun) : kneeX;
    out[`${S}UpLeg` as CoreBone] = { x: legX, y: upY };
    out[`${S}Leg` as CoreBone] = { x: kneeX, y: kneeY };
    out[`${S}Foot` as CoreBone] = { x: footX, y: footY };
    out[`${S}ToeBase` as CoreBone] = { x: footX, y: f.bottom + 0.015 * H };
  }
  return out;
}

/**
 * Arms-down / A-pose reading of the silhouette: below the shoulders the arms
 * show up as separate runs outside the torso (or outside the two legs, lower
 * down). A least-squares line x = a + b·y through each side's outer run
 * centres gives the arm axis; the arm joints go along it (the rest of the
 * skeleton is proportional). Null when either arm is not found.
 */
function armsDownLayout(s: Silhouette, f: Frame2D): Record<CoreBone, XY> | null {
  const { cx, bottom, H } = f;
  const cxCol = colOf(s, cx);
  const pts: [XY[], XY[]] = [[], []]; // left (+x), right (-x)
  const low = [Infinity, Infinity];
  const done = [false, false], lastJ = [-1, -1];
  for (let j = rowOf(s, bottom + 0.78 * H); j >= rowOf(s, bottom + 0.3 * H); j--) {
    const runs = mergedRuns(s, j);
    if (runs.length < 2) continue;
    // Inner runs: the torso (containing the centre) or, below the crotch, the two legs flanking it.
    let lo = runs.findIndex((r) => r.i0 <= cxCol && r.i1 >= cxCol), hi = lo;
    if (lo < 0) {
      hi = runs.findIndex((r) => r.i0 > cxCol);
      lo = hi - 1;
      if (lo < 0 || hi < 0 || cx - cellX(s, runs[lo].i1) > 0.15 * H || cellX(s, runs[hi].i0) - cx > 0.15 * H) continue;
    }
    const y = cellY(s, j);
    for (const [side, r, inner] of [[0, runs[runs.length - 1], runs[hi]], [1, runs[0], runs[lo]]] as const) {
      if (done[side] || r === inner || runWidth(s, r) > 0.12 * H) continue;
      const gap = side === 0 ? r.i0 - inner.i1 - 1 : inner.i0 - r.i1 - 1;
      if (gap < 1) continue;
      // One continuous limb from the top: a jump (e.g. to a leg below the hand) ends the chain.
      const x = runCenter(s, r), prev = pts[side][pts[side].length - 1];
      if (prev && (lastJ[side] - j > 3 || Math.abs(x - prev.x) > Math.max(4 * s.cell, 0.02 * H))) {
        done[side] = true;
        continue;
      }
      lastJ[side] = j;
      pts[side].push({ x, y });
      low[side] = Math.min(low[side], y - s.cell / 2);
    }
  }
  const lines: { a: number; b: number; yLow: number }[] = [];
  for (const side of [0, 1] as const) {
    const p = pts[side], sgn = side === 0 ? 1 : -1;
    if (p.length < 3) return null;
    let my = 0, mx = 0;
    for (const q of p) {
      my += q.y;
      mx += q.x;
    }
    my /= p.length;
    mx /= p.length;
    let syy = 0, sxy = 0;
    for (const q of p) {
      syy += (q.y - my) ** 2;
      sxy += (q.y - my) * (q.x - mx);
    }
    if (syy < 1e-12) return null;
    const b = sxy / syy, a = mx - b * my;
    // Length covered along the line, and its angle below horizontal (x grows outwards going down).
    const yTop = p[0].y, yLow = low[side];
    const len = Math.hypot(yTop - yLow, b * (yTop - yLow));
    const deg = (Math.atan2(1, -sgn * b) * 180) / Math.PI;
    if (len < 0.15 * H || !(deg >= 20 && deg <= 95)) return null;
    // The fit must be good (an arm, not scattered clutter).
    let err = 0;
    for (const q of p) err = Math.max(err, Math.abs(a + b * q.y - q.x));
    if (err > 0.04 * H) return null;
    lines.push({ a, b, yLow });
  }
  const out = proportionalLayout(f);
  const shoulderY = bottom + 0.8 * H;
  for (const side of [0, 1] as const) {
    const { a, b, yLow } = lines[side], sgn = side === 0 ? 1 : -1;
    const S = sgn > 0 ? 'Left' : 'Right';
    const xAt = (y: number) => a + b * y;
    // The arm merges with the torso near the shoulder: extrapolate the axis up to shoulder height.
    const armY = Math.max(shoulderY, pts[side][0].y);
    const armX = sgn * (xAt(armY) - cx) >= 0.04 * H ? xAt(armY) : cx + sgn * 0.04 * H;
    // Wrist ≈ 0.09 H back from the fingertips along the line.
    const dirLen = Math.hypot(1, b);
    const handY = Math.min(yLow + (0.09 * H) / dirLen, armY - 0.1 * H);
    const hand = { x: xAt(handY), y: handY };
    out[`${S}Arm` as CoreBone] = { x: armX, y: armY };
    out[`${S}ForeArm` as CoreBone] = { x: armX + 0.55 * (hand.x - armX), y: armY + 0.55 * (hand.y - armY) };
    out[`${S}Hand` as CoreBone] = hand;
    out[`${S}Shoulder` as CoreBone] = { x: cx + 0.3 * (armX - cx), y: armY + 0.02 * H };
  }
  return out;
}

/** Forward (+Z) offset of a toe joint: towards the front of the lowest rows around the foot. */
function toeZ(s: Silhouette, footX: number, footZ: number, bottom: number, H: number): number {
  let zFront = -Infinity;
  for (let j = rowOf(s, bottom); j <= rowOf(s, bottom + 0.05 * H); j++) {
    for (let i = colOf(s, footX - 0.05 * H); i <= colOf(s, footX + 0.05 * H); i++) {
      const k = j * s.nx + i;
      if (s.occ[k]) zFront = Math.max(zFront, s.zMax[k]);
    }
  }
  if (!Number.isFinite(zFront)) return footZ + 0.05 * H;
  return Math.max(footZ + 0.01 * H, Math.min(footZ + 0.08 * H, zFront - 0.025 * H));
}

// ---------------------------------------------------------------------------
// Pose landmarks → joints

interface PixelMap {
  toModel(px: number, py: number): XY;
}

function pixelMap(s: Silhouette, width: number, height: number, mask: Mask | null | undefined): PixelMap {
  let mx0 = 0, my0 = 0, mx1 = width, my1 = height;
  if (mask && mask.width > 0 && mask.height > 0) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < mask.height; y++) {
      for (let x = 0; x < mask.width; x++) {
        if (!mask.data[y * mask.width + x]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 >= x0) {
      // Mask pixels → image pixels (the mask may be at another resolution).
      const sx = width / mask.width, sy = height / mask.height;
      mx0 = x0 * sx;
      mx1 = (x1 + 1) * sx;
      my0 = y0 * sy;
      my1 = (y1 + 1) * sy;
    }
  }
  const b = s.box;
  const bw = b.isEmpty() ? 2 : b.max.x - b.min.x, bh = b.isEmpty() ? 2 : b.max.y - b.min.y;
  const bx = b.isEmpty() ? -1 : b.min.x, byTop = b.isEmpty() ? 1 : b.max.y;
  return {
    toModel: (px, py) => ({
      x: bx + ((px - mx0) / Math.max(mx1 - mx0, 1e-6)) * bw,
      y: byTop - ((py - my0) / Math.max(my1 - my0, 1e-6)) * bh,
    }),
  };
}

function usable(l: Landmark | undefined, w: number, h: number): l is Landmark {
  if (!l || !Number.isFinite(l.x) || !Number.isFinite(l.y)) return false;
  if ((l.visibility ?? 1) < 0.5) return false;
  return l.x >= -0.02 * w && l.x <= 1.02 * w && l.y >= -0.02 * h && l.y <= 1.02 * h;
}

const HAND_JOINTS: Record<FingerName, [number, number, number]> = {
  Thumb: [1, 2, 3],
  Index: [5, 6, 7],
  Middle: [9, 10, 11],
  Ring: [13, 14, 15],
  Pinky: [17, 18, 19],
};

function poseJoints(pose: PoseResult, map: PixelMap, w: number, h: number): Partial<Record<CoreBone, XY>> {
  const L = pose.landmarks;
  const get = (i: number): XY | null => (usable(L[i], w, h) ? map.toModel(L[i].x, L[i].y) : null);
  const mid = (a: XY | null, b: XY | null): XY | null => (a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null);
  const lerp = (a: XY, b: XY, t: number): XY => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const out: Partial<Record<CoreBone, XY>> = {};
  const set = (b: CoreBone, v: XY | null) => {
    if (v) out[b] = v;
  };
  const lSh = get(POSE.leftShoulder), rSh = get(POSE.rightShoulder);
  const lHip = get(POSE.leftHip), rHip = get(POSE.rightHip);
  const midSh = mid(lSh, rSh), hips = mid(lHip, rHip);
  const ears = mid(get(POSE.leftEar), get(POSE.rightEar)) ?? get(POSE.nose);
  const mouth = mid(get(POSE.mouthLeft), get(POSE.mouthRight));
  set('Hips', hips);
  set('LeftUpLeg', lHip);
  set('RightUpLeg', rHip);
  set('LeftLeg', get(POSE.leftKnee));
  set('RightLeg', get(POSE.rightKnee));
  set('LeftFoot', get(POSE.leftAnkle));
  set('RightFoot', get(POSE.rightAnkle));
  for (const [side, ankle, toe] of [['Left', POSE.leftAnkle, POSE.leftFootIndex], ['Right', POSE.rightAnkle, POSE.rightFootIndex]] as const) {
    const a = get(ankle), t = get(toe);
    if (a && t) set(`${side}ToeBase`, { x: a.x + (t.x - a.x) * 0.8, y: t.y + 0.25 * (a.y - t.y) });
  }
  set('LeftArm', lSh);
  set('RightArm', rSh);
  set('LeftForeArm', get(POSE.leftElbow));
  set('RightForeArm', get(POSE.rightElbow));
  set('LeftHand', get(POSE.leftWrist));
  set('RightHand', get(POSE.rightWrist));
  if (midSh) {
    const neck = ears ? lerp(midSh, ears, 0.2) : midSh;
    set('Neck', neck);
    if (lSh) set('LeftShoulder', { x: midSh.x + (lSh.x - midSh.x) * 0.25, y: neck.y - 0.35 * (neck.y - midSh.y) });
    if (rSh) set('RightShoulder', { x: midSh.x + (rSh.x - midSh.x) * 0.25, y: neck.y - 0.35 * (neck.y - midSh.y) });
    if (ears) {
      const head = lerp(neck, ears, 0.55);
      set('Head', head);
      // Crown: as far above the ears as the ears are above the mouth line, ×2.2.
      const drop = mouth ? Math.max(ears.y - mouth.y, 0) : 0;
      if (drop > 0) set('HeadTop_End', { x: ears.x, y: ears.y + 2.2 * drop });
    }
    if (hips) {
      const at = (t: number) => lerp(hips, neck, t);
      set('Spine', at(0.18));
      set('Spine1', at(0.42));
      set('Spine2', at(0.68));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

function toLayout(s: Silhouette, xy: Partial<Record<HumanoidBone, XY>>, H: number): JointLayout {
  const behind = 0.02 * H;
  const out: JointLayout = {};
  for (const [b, p] of Object.entries(xy) as [HumanoidBone, XY][]) out[b] = { x: p.x, y: p.y, z: jointZ(s, p.x, p.y, behind) };
  return out;
}

/**
 * Fill bones missing from `layout` from `base`, keeping each grafted
 * joint's offset to its parent (so a missing forearm hangs off the detected
 * shoulder, not off the heuristic one). Hips missing → placed below the
 * neck / shoulders like in `base`.
 */
export function completeLayout(layout: JointLayout, base: JointLayout): JointLayout {
  const out: JointLayout = { ...layout };
  const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
  if (!out.Hips && base.Hips) {
    const anchor = (['Neck', 'Spine2', 'LeftArm', 'RightArm'] as CoreBone[]).find((b) => out[b] && base[b]);
    out.Hips = anchor ? add(out[anchor]!, sub(base.Hips, base[anchor]!)) : { ...base.Hips };
  }
  for (const b of CORE_BONES) {
    if (out[b] || !base[b]) continue;
    const p = parentOf(b);
    out[b] = p && out[p] && base[p] ? add(out[p]!, sub(base[b]!, base[p]!)) : { ...base[b]! };
  }
  return out;
}

export function autoPlaceJointsDetailed(root: Object3D, opts: AutoJointOptions = {}): AutoJointResult {
  const data = opts.meshData ?? collectMeshData(root);
  const s = buildSilhouette(data, opts.resolution ?? 192);
  const f = occupiedFrame(s) ?? { cx: 0, bottom: -1, top: 1, H: 2, halfW: 1 };
  const down = armsDownLayout(s, f);
  const t = down ? null : tposeLayout(s, f);
  const heurXY = t ?? down ?? proportionalLayout(f);
  const heuristic = toLayout(s, heurXY, f.H);
  fixToes(s, heuristic, f);
  let method: JointMethod = t ? 'silhouette' : down ? 'arms-down' : 'proportional';
  let layout = heuristic;

  const { pose, imageSize } = opts;
  if (pose && imageSize && pose.landmarks.length >= 33) {
    const map = pixelMap(s, imageSize.width, imageSize.height, opts.imageMask);
    const xy = poseJoints(pose, map, imageSize.width, imageSize.height);
    // Enough of the body to anchor a skeleton: both shoulders or both hips.
    if ((xy.LeftArm && xy.RightArm) || (xy.LeftUpLeg && xy.RightUpLeg)) {
      if (xy.Head) {
        // The mesh's own crown above the head joint beats the ear / mouth estimate.
        const top = columnTop(s, xy.Head.x, xy.Head.y);
        if (top !== null && top > xy.Head.y + 0.03 * f.H) xy.HeadTop_End = { x: xy.Head.x, y: top };
      }
      const fromPose = toLayout(s, xy, f.H);
      if (xy.LeftToeBase || xy.RightToeBase) fixToes(s, fromPose, f);
      layout = completeLayout(fromPose, heuristic);
      addFingers(s, layout, opts.hands ?? [], map, f.H);
      method = 'pose';
    }
  }
  return { layout, method, heuristic, silhouette: s };
}

export function autoPlaceJoints(root: Object3D, opts: AutoJointOptions = {}): JointLayout {
  return autoPlaceJointsDetailed(root, opts).layout;
}

/** Highest occupied Y in column x above y (the crown above the head joint), or null. */
function columnTop(s: Silhouette, x: number, y: number): number | null {
  const i = colOf(s, x);
  let top: number | null = null;
  for (let j = rowOf(s, y); j < s.ny; j++) if (s.occ[j * s.nx + i]) top = cellY(s, j) + s.cell / 2;
  return top;
}

function fixToes(s: Silhouette, layout: JointLayout, f: Frame2D): void {
  for (const side of SIDES) {
    const foot = layout[`${side}Foot`], toe = layout[`${side}ToeBase`];
    if (foot && toe) toe.z = toeZ(s, toe.x, foot.z, f.bottom, f.H);
  }
}

function addFingers(
  s: Silhouette,
  layout: JointLayout,
  hands: HandResult[],
  map: PixelMap,
  H: number,
): void {
  const seen = new Set<string>();
  for (const hand of hands) {
    if (hand.landmarks.length < 21 || !hand.landmarks.slice(0, 20).every((l) => Number.isFinite(l.x) && Number.isFinite(l.y))) continue;
    const pts = hand.landmarks.map((l) => map.toModel(l.x, l.y));
    let side = hand.handedness;
    // Trust the wrist position over the handedness label when they disagree clearly.
    const own = layout[`${side}Hand`], other = layout[`${mirrorBone(`${side}Hand` as const)}`];
    const d = (p: Vec3 | undefined) => (p ? Math.hypot(p.x - pts[0].x, p.y - pts[0].y) : Infinity);
    if (d(other) < 0.5 * d(own)) side = side === 'Left' ? 'Right' : 'Left';
    if (seen.has(side)) continue;
    seen.add(side);
    const hz = layout[`${side}Hand`]?.z ?? jointZ(s, pts[0].x, pts[0].y, 0.02 * H);
    const zAt = (p: XY) => {
      const z = jointZ(s, p.x, p.y, 0.005 * H, 2);
      return Math.abs(z - hz) < 0.08 * H ? z : hz;
    };
    layout[`${side}Hand`] = { x: pts[0].x, y: pts[0].y, z: hz };
    for (const finger of FINGER_NAMES) {
      HAND_JOINTS[finger].forEach((li, k) => {
        const p = pts[li];
        layout[fingerBone(side, finger, (k + 1) as 1 | 2 | 3)] = { x: p.x, y: p.y, z: zAt(p) };
      });
    }
  }
}
