/**
 * Depth refinement of the visual hull: each view's normalised depth map
 * (1 = nearest) carves voxels in front of the estimated surface along that
 * view's axis. It only removes material, and a view only sees its near half:
 * k = 0.5 · strength.
 *
 *  - fit 'object': t_surf = min(t_face + (1 − d) · k · 2E, (t0 + t1) / 2)
 *  - fit 'ray':    t_surf = t0 + (1 − d) · k · (t1 − t0)
 *
 * E = half the box extent along the axis, [t0, t1] = the ray's hull interval.
 * The 'object' cap at the interval's middle keeps one view from erasing a
 * thin part (or front + back from flattening it to nothing).
 * t is measured in voxels from the camera-side grid face. 'object' treats
 * depth as one affine map along the axis (a sphere seen from all six sides is
 * recovered exactly with strength 1); 'ray' rescales per ray, which over-carves
 * rays that other views already narrowed. Rays outside the view's silhouette
 * are left alone. The carve is a one-voxel ramp so the 0.5 crossing lands at
 * t_surf with sub-voxel accuracy.
 */
import type { DepthMap, Mask } from '../types';
import { sampleBilinear } from '../image/ops';
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
  const k = 0.5 * Math.min(1, Math.max(0, o.strength));
  if (k <= 0) return out;
  const { depth, rect } = vd;
  const sx = depth.width / Math.max(1e-9, rect.x1 - rect.x0), sy = depth.height / Math.max(1e-9, rect.y1 - rect.y0);
  const extentT = (2 * o.halfExtent) / grid.spacing;
  const tFace = worldToRayT(grid, proj, proj.ws * o.halfExtent);
  const s = grid.spacing;
  const iv = new Float64Array(2);
  forEachRay(grid, proj, (a, b, start, step, n) => {
    const u = proj.ou + proj.su * (grid.origin[proj.ua] + a * s);
    const v = proj.ov + proj.sv * (grid.origin[proj.va] + b * s);
    const px = Math.floor(u), py = Math.floor(v);
    if (px < 0 || py < 0 || px >= mask.width || py >= mask.height || !mask.data[py * mask.width + px]) return;
    if (u < rect.x0 || v < rect.y0 || u > rect.x1 || v > rect.y1) return;
    if (!rayCrossings(hull, start, step, n, 0.5, iv)) return;
    const d = Math.min(1, Math.max(0, sampleBilinear(depth.data, depth.width, depth.height, (u - rect.x0) * sx, (v - rect.y0) * sy)));
    const t = o.fit === 'ray'
      ? iv[0] + (1 - d) * k * (iv[1] - iv[0])
      : Math.min(tFace + (1 - d) * k * extentT, (iv[0] + iv[1]) / 2);
    if (t > iv[0]) out[a + nu * b] = t; // never adds: in front of the hull there is nothing to carve
  });
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
