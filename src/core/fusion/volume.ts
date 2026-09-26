/**
 * Voxel volume for multi-view fusion: the grid, the soft visual hull, 3D
 * Gaussian smoothing, box downsampling and per-ray crossings.
 *
 * The field holds occupancy in [0, 1] (surface at 0.5). Voxel (i, j, k) has
 * index i + nx·(j + ny·k) and its centre at origin + (i, j, k)·spacing. The
 * outermost layer is kept at 0 so the extracted surface is always closed.
 */
import type { Axis } from './types';
import type { ObjectBox, PreparedView, ViewProjection } from './frame';
import { viewProjection } from './frame';
import { dilateMask, SummedArea } from './silhouette';
import { drain, type Steps } from './steps';

export interface Grid {
  dims: [number, number, number];
  spacing: number;
  /** World position of voxel (0, 0, 0)'s centre. */
  origin: [number, number, number];
}

export function gridStrides(g: Grid): [number, number, number] {
  return [1, g.dims[0], g.dims[0] * g.dims[1]];
}

/** Grid over the object box, `resolution` voxels along its longest side plus `pad` empty voxels on every face, centred. */
export function createGrid(size: readonly [number, number, number], resolution: number, pad: number): Grid {
  const spacing = Math.max(size[0], size[1], size[2]) / Math.max(1, resolution);
  const dims = [0, 0, 0] as [number, number, number];
  const origin = [0, 0, 0] as [number, number, number];
  for (let a = 0; a < 3; a++) {
    dims[a] = Math.max(1, Math.ceil(size[a] / spacing - 1e-6)) + 2 * pad;
    origin[a] = (-(dims[a] - 1) / 2) * spacing;
  }
  return { dims, spacing, origin };
}

/**
 * Coverage of every voxel column of a view: the mean of `silhouette` over
 * the voxel's footprint in the image, for the (ua, va) plane of the grid
 * (index a + dims[ua]·b).
 */
export function coverageTable(proj: ViewProjection, grid: Grid, silhouette: SummedArea): Float32Array {
  const nu = grid.dims[proj.ua], nv = grid.dims[proj.va];
  const s = grid.spacing, h = s / 2;
  const u0 = new Float64Array(nu), u1 = new Float64Array(nu);
  for (let a = 0; a < nu; a++) {
    const c = grid.origin[proj.ua] + a * s;
    const p = proj.ou + proj.su * (c - h), q = proj.ou + proj.su * (c + h);
    u0[a] = Math.min(p, q);
    u1[a] = Math.max(p, q);
  }
  const v0 = new Float64Array(nv), v1 = new Float64Array(nv);
  for (let b = 0; b < nv; b++) {
    const c = grid.origin[proj.va] + b * s;
    const p = proj.ov + proj.sv * (c - h), q = proj.ov + proj.sv * (c + h);
    v0[b] = Math.min(p, q);
    v1[b] = Math.max(p, q);
  }
  const out = new Float32Array(nu * nv);
  for (let b = 0; b < nv; b++)
    for (let a = 0; a < nu; a++) out[a + nu * b] = silhouette.coverage(u0[a], v0[b], u1[a], v1[b]);
  return out;
}

/** Fraction of each voxel's extent along `axis` inside [−half, half]. */
function extentCoverage(grid: Grid, axis: Axis, half: number): Float32Array {
  const n = grid.dims[axis], s = grid.spacing;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = grid.origin[axis] + i * s;
    const lo = Math.max(c - s / 2, -half), hi = Math.min(c + s / 2, half);
    out[i] = hi > lo ? (hi - lo) / s : 0;
  }
  return out;
}

export interface HullOptions {
  hull: 'strict' | 'tolerant';
  /** Dilation of non-front views in tolerant mode, fraction of the view's longest bbox side. */
  tolerance: number;
}

/** Silhouette dilation radius (pixels) used for a view. */
export function dilationRadius(view: PreparedView, o: HullOptions): number {
  if (o.hull !== 'tolerant' || view.id === 'front' || !(o.tolerance > 0)) return 0;
  const { x0, y0, x1, y1 } = view.bbox;
  return o.tolerance * Math.max(x1 - x0, y1 - y0);
}

/**
 * Soft visual hull: occupancy = min over views of the silhouette coverage of
 * the voxel's projection. Orthographic projections are separable, so each
 * view is a 2D table over one grid plane (front/back: XY, left/right: ZY,
 * top/bottom: XZ), clipped to the object box (which alone bounds Z for a
 * front/back-only set).
 */
export function buildHull(views: PreparedView[], box: ObjectBox, grid: Grid, o: HullOptions): Float32Array {
  return drain(buildHullSteps(views, box, grid, o));
}

/** buildHull as cooperative steps (a yield per view and per Z slab). */
export function* buildHullSteps(views: PreparedView[], box: ObjectBox, grid: Grid, o: HullOptions): Steps<Float32Array> {
  const [nx, ny, nz] = grid.dims;
  const xy = new Float32Array(nx * ny).fill(1);
  const zy = new Float32Array(nz * ny).fill(1);
  const xz = new Float32Array(nx * nz).fill(1);
  for (const view of views) {
    const r = dilationRadius(view, o);
    const sil = new SummedArea(r > 0 ? dilateMask(view.mask, r) : view.mask);
    const table = coverageTable(viewProjection(view, box.size), grid, sil);
    const plane = view.id === 'front' || view.id === 'back' ? xy : view.id === 'left' || view.id === 'right' ? zy : xz;
    for (let i = 0; i < plane.length; i++) if (table[i] < plane[i]) plane[i] = table[i];
    yield;
  }
  // Every view's bbox maps onto the box, so the box bounds the hull; this also
  // keeps dilated (tolerant) silhouettes from growing the object's extents.
  const xBox = extentCoverage(grid, 0, box.size[0] / 2);
  const yBox = extentCoverage(grid, 1, box.size[1] / 2);
  const zBox = extentCoverage(grid, 2, box.size[2] / 2);
  const field = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    const zk = zBox[k];
    if (zk <= 0) continue;
    yield;
    for (let j = 0; j < ny; j++) {
      const zyv = Math.min(zk, yBox[j], zy[k + nz * j]);
      if (zyv <= 0) continue;
      const row = nx * (j + ny * k);
      for (let i = 0; i < nx; i++) {
        let v = xy[i + nx * j];
        const c = Math.min(xz[i + nx * k], xBox[i]);
        if (c < v) v = c;
        if (zyv < v) v = zyv;
        field[row + i] = v;
      }
    }
  }
  clearBorder(field, grid.dims);
  return field;
}

/** Zero the outermost voxel layer (keeps the iso-surface closed). */
export function clearBorder(field: Float32Array, dims: readonly [number, number, number]): void {
  const [nx, ny, nz] = dims;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) {
      const row = nx * (j + ny * k);
      if (k === 0 || k === nz - 1 || j === 0 || j === ny - 1) field.fill(0, row, row + nx);
      else {
        field[row] = 0;
        field[row + nx - 1] = 0;
      }
    }
}

/** Normalised 1D Gaussian kernel with radius ceil(3σ). */
export function gaussianKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/** In-place separable 3D Gaussian blur (edges clamped). Lines that are all zero are skipped. */
export function gaussianBlur3D(field: Float32Array, dims: readonly [number, number, number], sigma: number): void {
  drain(gaussianBlur3DSteps(field, dims, sigma));
}

/** gaussianBlur3D as cooperative steps (a yield per plane of lines). */
export function* gaussianBlur3DSteps(field: Float32Array, dims: readonly [number, number, number], sigma: number): Steps {
  if (!(sigma > 0.05)) return;
  const kernel = gaussianKernel(sigma);
  const r = (kernel.length - 1) / 2;
  const [nx, ny, nz] = dims;
  const strides = [1, nx, nx * ny];
  const line = new Float32Array(Math.max(nx, ny, nz) + 2 * r);
  for (let axis = 0; axis < 3; axis++) {
    const n = dims[axis], stride = strides[axis];
    // The two other axes enumerate the line starts.
    const [a1, a2] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
    for (let q = 0; q < dims[a2]; q++, yield)
      for (let p = 0; p < dims[a1]; p++) {
        const start = p * strides[a1] + q * strides[a2];
        let any = false;
        for (let t = 0; t < n; t++) {
          const v = field[start + t * stride];
          line[r + t] = v;
          if (v !== 0) any = true;
        }
        if (!any) continue;
        const first = line[r], last = line[r + n - 1];
        for (let t = 0; t < r; t++) {
          line[t] = first;
          line[r + n + t] = last;
        }
        for (let t = 0; t < n; t++) {
          let acc = 0;
          for (let m = 0; m < kernel.length; m++) acc += kernel[m] * line[t + m];
          field[start + t * stride] = acc;
        }
      }
  }
}

/**
 * Box-average downsample by an integer factor, with a one-voxel empty border
 * added on every face. Returns the new field and its grid.
 */
export function downsample(field: Float32Array, grid: Grid, factor: number): { field: Float32Array; grid: Grid } {
  return drain(downsampleSteps(field, grid, factor));
}

/** downsample as cooperative steps (a yield per coarse Z slab). */
export function* downsampleSteps(field: Float32Array, grid: Grid, factor: number): Steps<{ field: Float32Array; grid: Grid }> {
  if (factor <= 1) return { field, grid };
  const [nx, ny, nz] = grid.dims;
  const cx = Math.ceil(nx / factor), cy = Math.ceil(ny / factor), cz = Math.ceil(nz / factor);
  const dims: [number, number, number] = [cx + 2, cy + 2, cz + 2];
  const out = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let K = 0; K < cz; K++, yield)
    for (let J = 0; J < cy; J++)
      for (let I = 0; I < cx; I++) {
        let sum = 0, cnt = 0;
        const k1 = Math.min(nz, (K + 1) * factor), j1 = Math.min(ny, (J + 1) * factor), i1 = Math.min(nx, (I + 1) * factor);
        for (let k = K * factor; k < k1; k++)
          for (let j = J * factor; j < j1; j++) {
            const row = nx * (j + ny * k);
            for (let i = I * factor; i < i1; i++) sum += field[row + i];
            cnt += i1 - I * factor;
          }
        out[I + 1 + dims[0] * (J + 1 + dims[1] * (K + 1))] = sum / Math.max(1, cnt);
      }
  // Coarse cell I (after the border) averages fine cells [(I−1)f, (I−1)f + f).
  const spacing = grid.spacing * factor;
  const origin = grid.origin.map((o) => o - ((factor + 1) / 2) * grid.spacing) as [number, number, number];
  clearBorder(out, dims);
  return { field: out, grid: { dims, spacing, origin } };
}

/** Cubes whose corners straddle `iso` (≈ half the triangle count of their surface). */
export function countSurfaceCells(field: Float32Array, dims: readonly [number, number, number], iso = 0.5): number {
  return drain(countSurfaceCellsSteps(field, dims, iso));
}

/** countSurfaceCells as cooperative steps (a yield per Z slab). */
export function* countSurfaceCellsSteps(field: Float32Array, dims: readonly [number, number, number], iso = 0.5): Steps<number> {
  const [nx, ny, nz] = dims;
  const nxy = nx * ny;
  let count = 0;
  for (let k = 0; k < nz - 1; k++, yield)
    for (let j = 0; j < ny - 1; j++) {
      let p = nx * (j + ny * k);
      for (let i = 0; i < nx - 1; i++, p++) {
        const a = field[p] > iso;
        if (
          a !== field[p + 1] > iso || a !== field[p + nx] > iso || a !== field[p + nx + 1] > iso
          || a !== field[p + nxy] > iso || a !== field[p + nxy + 1] > iso
          || a !== field[p + nxy + nx] > iso || a !== field[p + nxy + nx + 1] > iso
        ) count++;
      }
    }
  return count;
}

/**
 * Calls `fn(a, b, start, step, n)` for every ray of a view over the grid's
 * (ua, va) plane: voxel t along the ray (t = 0 on the camera side) has index
 * start + t·step.
 */
export function forEachRay(
  grid: Grid,
  proj: Pick<ViewProjection, 'ua' | 'va' | 'wa' | 'ws'>,
  fn: (a: number, b: number, start: number, step: number, n: number) => void,
): void {
  const strides = gridStrides(grid);
  const nu = grid.dims[proj.ua], nv = grid.dims[proj.va], n = grid.dims[proj.wa];
  const sw = strides[proj.wa];
  for (let b = 0; b < nv; b++)
    for (let a = 0; a < nu; a++) {
      const base = a * strides[proj.ua] + b * strides[proj.va];
      if (proj.ws > 0) fn(a, b, base + (n - 1) * sw, -sw, n);
      else fn(a, b, base, sw, n);
    }
}

/**
 * First entering and last leaving `iso` crossings along a ray, in voxel
 * units of t (linear interpolation; outside the grid counts as 0).
 * Returns false when the ray misses.
 */
export function rayCrossings(field: Float32Array, start: number, step: number, n: number, iso: number, out: Float64Array): boolean {
  let prev = 0, t0 = NaN, t1 = NaN;
  for (let t = 0, p = start; t < n; t++, p += step) {
    const v = field[p];
    if (v > iso && prev <= iso) {
      if (Number.isNaN(t0)) t0 = t - 1 + (iso - prev) / (v - prev);
    } else if (v <= iso && prev > iso) {
      t1 = t - 1 + (prev - iso) / (prev - v);
    }
    prev = v;
  }
  if (prev > iso) t1 = n - 1 + (prev - iso) / prev;
  if (Number.isNaN(t0)) return false;
  out[0] = t0;
  out[1] = t1;
  return true;
}

/** t (voxel units from the camera-side grid face) of a world coordinate along the view axis. */
export function worldToRayT(grid: Grid, proj: Pick<ViewProjection, 'wa' | 'ws'>, c: number): number {
  const idx = (c - grid.origin[proj.wa]) / grid.spacing;
  return proj.ws > 0 ? grid.dims[proj.wa] - 1 - idx : idx;
}

/** World coordinate along the view axis of ray parameter t. */
export function rayTToWorld(grid: Grid, proj: Pick<ViewProjection, 'wa' | 'ws'>, t: number): number {
  const idx = proj.ws > 0 ? grid.dims[proj.wa] - 1 - t : t;
  return grid.origin[proj.wa] + idx * grid.spacing;
}
