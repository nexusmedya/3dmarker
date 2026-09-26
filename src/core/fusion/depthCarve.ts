/**
 * Depth refinement of the visual hull: each view's normalised depth map
 * (1 = nearest) carves voxels in front of the estimated surface along that
 * view's axis. It only removes material, and a view only sees its near half:
 * k = 0.5 · strength.
 *
 *  - fit 'object': t_surf = min(t_face + a + b·(1 − d), (t0 + t1) / 2)
 *  - fit 'ray':    t_surf = t0 + (1 − d) · k · (t1 − t0)
 *
 * E = half the box extent along the axis, [t0, t1] = the ray's hull interval.
 * 'object' treats depth as one affine map along the axis. A normalised map
 * carries no scale, so (a, b) are calibrated against the hull (calibrateDepth:
 * the hull entry t0 bounds the surface and is tight on the other views'
 * profiles), with b ≤ k · 2E; a view whose hull says nothing about relief
 * (flat entries) carves nothing. Without calibration (silhouette "balloon"
 * depth, front/back-only sets) a = 0 and b = k · 2E: the map's range is
 * assumed to span the near half (exact for a sphere seen from six sides).
 * The cap at the interval's middle keeps one view from erasing a thin part
 * (or front + back from flattening it to nothing). t is measured in voxels
 * from the camera-side grid face. 'ray' rescales per ray, which over-carves
 * rays that other views already narrowed. Rays outside the view's silhouette
 * are left alone, and depth is sampled from in-silhouette pixels only. The
 * carve is a one-voxel ramp so the 0.5 crossing lands at t_surf with
 * sub-voxel accuracy.
 */
import type { DepthMap, Mask } from '../types';
import { distanceTransform, unionOfSpheres } from '../image/distance';
import type { PixelBox, ViewProjection } from './frame';
import type { DepthFit } from './types';
import { forEachRay, rayCrossings, worldToRayT, type Grid } from './volume';

/** A depth map covering the `rect` region of the view image (it may have another resolution). */
export interface ViewDepth {
  depth: DepthMap;
  rect: PixelBox;
}

export interface CarveOptions {
  strength: number;
  fit: DepthFit;
  /** Object box half extent along the view axis (world units). */
  halfExtent: number;
  /**
   * 'object' fit only: calibrate the depth map's scale against the hull
   * (see calibrateDepth) instead of assuming that its range spans the near
   * half of the box. Needs a hull that constrains depth (a side / top /
   * bottom view); without one there is no scale to measure. Default true.
   */
  calibrate?: boolean;
  /**
   * How far (world units, ≥ 0) the hull may reach past the true silhouettes
   * along this view's axis where a silhouette bounds it ('tolerant' dilation
   * of the other views): added back to such hull entries before calibrating.
   */
  hullSlack?: number;
}

/** Number of (1 − d) bins of the calibration envelope. */
const CAL_BINS = 24;
/** Quantile of the hull entries per bin (robust "max": ignores a few rim outliers). */
const CAL_QUANTILE = 0.95;
/** Fewest rays per bin for the bin to count. */
const CAL_MIN_COUNT = 4;

/**
 * Scale of a view's normalised depth, measured against the hull.
 *
 * A normalised depth map only fixes the order of the surface points, not
 * their spacing: the surface is t = t_face + a + b·x with x = 1 − d and
 * unknown a, b. The hull entry t0 of every ray is an upper bound on the
 * surface's nearness (t_surf ≥ t0), and it is tight wherever the silhouette
 * of another view touches the surface (the profile). So the true line lies on
 * or above every point (x, y = t0 − t_face) and touches the tight ones: of
 * all lines above the points (per-bin high quantiles, for robustness) take
 * the lowest on average, i.e. the least carving consistent with the hull.
 * This is an LP whose optimum is a line through two bin points (or with the
 * slope at a bound). b is clamped to [0, bMax]: a view whose hull entries do
 * not vary with depth (a flat back, an occluded side) gets b = 0 and carves
 * nothing past the hull. Returns [a, b] in voxels, or null without data.
 */
export function calibrateDepth(xs: ArrayLike<number>, ys: ArrayLike<number>, count: number, bMax: number): [number, number] | null {
  const bins: number[][] = Array.from({ length: CAL_BINS }, () => []);
  const binX = new Float64Array(CAL_BINS);
  let meanX = 0;
  for (let i = 0; i < count; i++) {
    const j = Math.min(CAL_BINS - 1, Math.max(0, Math.floor(xs[i] * CAL_BINS)));
    bins[j].push(ys[i]);
    binX[j] += xs[i];
    meanX += xs[i];
  }
  if (count === 0) return null;
  meanX /= count;
  const X: number[] = [], Y: number[] = [];
  for (let j = 0; j < CAL_BINS; j++) {
    const v = bins[j];
    if (v.length < CAL_MIN_COUNT) continue;
    v.sort((p, q) => p - q);
    X.push(binX[j] / v.length);
    Y.push(v[Math.min(v.length - 1, Math.floor(CAL_QUANTILE * v.length))]);
  }
  if (X.length === 0) return null;
  const slopes = [0, Math.max(0, bMax)];
  for (let i = 0; i < X.length; i++)
    for (let j = i + 1; j < X.length; j++) {
      const dx = X[j] - X[i];
      if (Math.abs(dx) > 1e-6) slopes.push(Math.min(Math.max(0, bMax), Math.max(0, (Y[j] - Y[i]) / dx)));
    }
  let best: [number, number] | null = null, bestCost = Infinity;
  for (const b of slopes) {
    let a = -Infinity;
    for (let i = 0; i < X.length; i++) a = Math.max(a, Y[i] - b * X[i]);
    const cost = a + b * meanX;
    if (cost < bestCost - 1e-9 || (cost < bestCost + 1e-9 && best && b < best[1])) {
      bestCost = Math.min(bestCost, cost);
      best = [a, b];
    }
  }
  return best;
}

/**
 * Bilinear depth sample that only uses taps inside the view's silhouette
 * (outside it the depth map holds a meaningless 0 = "farthest"), renormalised;
 * the nearest tap when no tap is inside.
 */
function sampleDepthMasked(vd: ViewDepth, mask: Mask, sx: number, sy: number, x: number, y: number): number {
  const { depth, rect } = vd;
  const { width: w, height: h, data } = depth;
  const fx = Math.min(w - 1, Math.max(0, x - 0.5)), fy = Math.min(h - 1, Math.max(0, y - 0.5));
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = fx - ix, ty = fy - iy;
  let acc = 0, wsum = 0;
  for (let dy = 0; dy < 2; dy++)
    for (let dx = 0; dx < 2; dx++) {
      const qx = Math.min(w - 1, ix + dx), qy = Math.min(h - 1, iy + dy);
      const wt = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
      if (wt <= 0) continue;
      // The tap's centre in view-image pixels.
      const mx = Math.floor(rect.x0 + (qx + 0.5) / sx), my = Math.floor(rect.y0 + (qy + 0.5) / sy);
      if (mx < 0 || my < 0 || mx >= mask.width || my >= mask.height || !mask.data[my * mask.width + mx]) continue;
      acc += wt * data[qy * w + qx];
      wsum += wt;
    }
  if (wsum > 1e-9) return acc / wsum;
  return data[Math.min(h - 1, Math.round(fy)) * w + Math.min(w - 1, Math.round(fx))];
}

/**
 * Target surface t per ray of a view (index a + nu·b over its (ua, va)
 * plane); NaN = no carving. Computed from `hull`, which is not modified.
 */
export function carveTargets(
  hull: Float32Array,
  grid: Grid,
  proj: ViewProjection,
  mask: Mask,
  vd: ViewDepth,
  o: CarveOptions,
): Float32Array {
  const nu = grid.dims[proj.ua];
  const out = new Float32Array(nu * grid.dims[proj.va]).fill(NaN);
  const strength = Math.min(1, Math.max(0, o.strength));
  const k = 0.5 * strength;
  if (k <= 0) return out;
  const { depth, rect } = vd;
  const sx = depth.width / Math.max(1e-9, rect.x1 - rect.x0), sy = depth.height / Math.max(1e-9, rect.y1 - rect.y0);
  const extentT = (2 * o.halfExtent) / grid.spacing;
  const tFace = worldToRayT(grid, proj, proj.ws * o.halfExtent);
  const s = grid.spacing;
  const calibrate = o.fit === 'object' && o.calibrate !== false;
  // Pass 1: in-silhouette rays that hit the hull, with their depth and hull interval.
  const cap = out.length;
  const ray = new Int32Array(cap), xs = new Float32Array(cap), t0s = new Float32Array(cap), t1s = new Float32Array(cap);
  let count = 0;
  const iv = new Float64Array(2);
  forEachRay(grid, proj, (a, b, start, step, n) => {
    const u = proj.ou + proj.su * (grid.origin[proj.ua] + a * s);
    const v = proj.ov + proj.sv * (grid.origin[proj.va] + b * s);
    const px = Math.floor(u), py = Math.floor(v);
    if (px < 0 || py < 0 || px >= mask.width || py >= mask.height || !mask.data[py * mask.width + px]) return;
    if (u < rect.x0 || v < rect.y0 || u > rect.x1 || v > rect.y1) return;
    if (!rayCrossings(hull, start, step, n, 0.5, iv)) return;
    const d = Math.min(1, Math.max(0, sampleDepthMasked(vd, mask, sx, sy, (u - rect.x0) * sx, (v - rect.y0) * sy)));
    ray[count] = a + nu * b;
    xs[count] = 1 - d;
    t0s[count] = iv[0];
    t1s[count] = iv[1];
    count++;
  });
  // 'object': t = t_face + a + b·(1 − d), b at most k·(box extent) (a view sees its near half);
  // uncalibrated, a = 0 and b = that maximum.
  const bMax = k * extentT;
  let fa = 0, fb = bMax;
  if (calibrate) {
    // Entries on the box face are exact; entries behind it come from a (maybe dilated) silhouette.
    const slack = Math.max(0, o.hullSlack ?? 0) / s;
    const ys = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const y = t0s[i] - tFace;
      ys[i] = y > 0.25 ? y + slack : y;
    }
    const cal = calibrateDepth(xs, ys, count, extentT / 2);
    if (!cal) return out;
    // A lower strength only flattens the relief (never shifts the surface deeper).
    fa = cal[0];
    fb = Math.min(cal[1], bMax);
  }
  for (let i = 0; i < count; i++) {
    const t0 = t0s[i], t1 = t1s[i], x = xs[i];
    const t = o.fit === 'ray'
      ? t0 + x * k * (t1 - t0)
      : Math.min(tFace + fa + fb * x, (t0 + t1) / 2);
    if (t > t0) out[ray[i]] = t; // never adds: in front of the hull there is nothing to carve
  }
  return out;
}

/** Apply carve targets: voxels before t_surf are emptied with a one-voxel ramp (min with the field). */
export function applyCarve(field: Float32Array, grid: Grid, proj: ViewProjection, targets: Float32Array): void {
  const nu = grid.dims[proj.ua];
  forEachRay(grid, proj, (a, b, start, step, n) => {
    const ts = targets[a + nu * b];
    if (!(ts > 0)) return;
    const end = Math.min(n, Math.ceil(ts + 0.5));
    for (let t = 0, p = start; t < end; t++, p += step) {
      const ramp = t - ts + 0.5;
      const v = ramp <= 0 ? 0 : ramp;
      if (v < field[p]) field[p] = v;
    }
  });
}

/**
 * Depth-like "balloon" profile of a silhouette (union of spheres of the
 * distance transform, normalised to 1 at the thickest point): a disk becomes
 * a hemisphere, a limb a round tube. Used for front / back when no model depth
 * is available and nothing else constrains the object's depth.
 */
export function silhouetteDepth(mask: Mask): DepthMap {
  const { width: w, height: h } = mask;
  const h3 = unionOfSpheres(distanceTransform(mask), w, h);
  let max = 0;
  for (let i = 0; i < h3.length; i++) if (h3[i] > max) max = h3[i];
  const data = new Float32Array(w * h);
  if (max > 0) for (let i = 0; i < data.length; i++) data[i] = mask.data[i] ? h3[i] / max : 0;
  return { width: w, height: h, data };
}
