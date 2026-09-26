/**
 * Thin-part guard: a floor under the occupancy that keeps the parts the FRONT
 * shows as thin (arms, legs, a mug handle) where another view disagrees.
 *
 * Every hull intersection and every depth carve can only remove material, so
 * a few percent of misregistration between hand-made views (a side view whose
 * arm rows sit lower than the front's, a knee-up back) deletes thin parts
 * outright, while thick parts merely get dented. The guard makes the thin
 * parts of the front's silhouette survive: for each front column (x, y) whose
 * local thickness τ is below 2δ·L (L = the front's longest side, δ = the
 * FusionOptions.guard share) it protects a tube along Z of half-length
 * half = gate·ρ·min(h3, zhalf) around the middle of the profile interval —
 * h3 = the balloon height of the front silhouette there (a limb as thick as
 * it is wide), zhalf = half the interval where the side / top planes say the
 * object is (so the tube stays inside the profile hull), ρ < 1 so the guard
 * never touches the silhouette surface of a consistent set (measured: adds
 * 0 voxels there). gate fades the guard out between τ = 2δL and 4δL. Where a
 * profile plane is empty at a front column (it disagrees with the front), the
 * other plane places the tube, else the box centre. Only two floats per
 * column are stored (no 3D buffer).
 */
import { distanceTransform, unionOfSpheres } from '../image/distance';
import type { ObjectBox } from './frame';
import { drain, type Steps } from './steps';
import { extentCoverage, type Grid, type HullPlanes } from './volume';

export interface GuardOptions {
  /** Thinness threshold δ, fraction of max(W, H). */
  delta: number;
  /** Tube half-length share ρ of the profile / balloon half-thickness (0.9). */
  rho: number;
}

/** ρ used by the reconstruction. */
export const GUARD_FILL = 0.9;

/**
 * Local thickness (Hildebrand–Rüegsegger) of a binary plane: diameter of the
 * largest inscribed disc containing the pixel. Every foreground pixel paints
 * its inscribed disc (radius = its distance transform) with the diameter,
 * max-composited; O(Σ r²), fine on the grid-resolution plane.
 */
export function localThickness(bin: Uint8Array, w: number, h: number): Float32Array {
  const dt = distanceTransform({ width: w, height: h, data: bin });
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const r = dt[y * w + x];
      if (r <= 0) continue;
      const ri = Math.ceil(r), r2 = r * r, d = 2 * r;
      for (let dy = -ri; dy <= ri; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        const row = yy * w;
        for (let dx = -ri; dx <= ri; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || dx * dx + dy * dy > r2) continue;
          if (d > out[row + xx]) out[row + xx] = d;
        }
      }
    }
  return out;
}

/** The guard as a per-front-column Z tube: value(i, j, k) = clamp(half − |k − centre| + 0.5, 0, 1) · zBox[k]. */
export class GuardField {
  constructor(
    readonly grid: Grid,
    readonly center: Float32Array,
    readonly half: Float32Array,
    readonly zBox: Float32Array,
    readonly columns: number,
  ) {}

  /** Guard occupancy at voxel (i, j, k); 0 where the column is not guarded. */
  value(i: number, j: number, k: number): number {
    const c = i + this.grid.dims[0] * j;
    const h = this.half[c];
    if (h <= 0) return 0;
    const v = h - Math.abs(k - this.center[c]) + 0.5;
    return (v <= 0 ? 0 : v >= 1 ? 1 : v) * this.zBox[k];
  }

  /** field = max(field, guard) on interior voxels; returns the voxels that crossed 0.5. */
  applyFloor(field: Float32Array): number {
    const [nx, ny, nz] = this.grid.dims;
    const { center, half, zBox } = this;
    let added = 0;
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const c = i + nx * j;
        const h = half[c];
        if (h <= 0) continue;
        const kc = center[c];
        const k0 = Math.max(1, Math.floor(kc - h - 0.5)), k1 = Math.min(nz - 2, Math.ceil(kc + h + 0.5));
        for (let k = k0; k <= k1; k++) {
          const v0 = h - Math.abs(k - kc) + 0.5;
          const v = (v0 <= 0 ? 0 : v0 >= 1 ? 1 : v0) * zBox[k];
          const p = i + nx * (j + ny * k);
          if (v > field[p]) {
            if (field[p] <= 0.5 && v > 0.5) added++;
            field[p] = v;
          }
        }
      }
    return added;
  }
}

/** Interval of entries ≥ 0.5 (with zBox > 0) of a line read through `get`, or null. */
function interval(n: number, get: (k: number) => number, zBox: Float32Array): [number, number] | null {
  let a = -1, b = -1;
  for (let k = 0; k < n; k++)
    if (zBox[k] > 0 && get(k) >= 0.5) {
      if (a < 0) a = k;
      b = k;
    }
  return a < 0 ? null : [a, b];
}

export function buildGuard(planes: HullPlanes, box: ObjectBox, grid: Grid, o: GuardOptions): GuardField {
  return drain(buildGuardSteps(planes, box, grid, o));
}

/** buildGuard as cooperative steps (a yield per front row). */
export function* buildGuardSteps(planes: HullPlanes, box: ObjectBox, grid: Grid, o: GuardOptions): Steps<GuardField> {
  const [nx, ny, nz] = grid.dims;
  const bin = new Uint8Array(nx * ny);
  for (let c = 0; c < bin.length; c++) bin[c] = planes.xy[c] >= 0.5 ? 1 : 0;
  const dt = distanceTransform({ width: nx, height: ny, data: bin });
  const h3 = unionOfSpheres(dt, nx, ny);
  const tau = localThickness(bin, nx, ny);
  const deltaVox = (o.delta * Math.max(box.size[0], box.size[1])) / grid.spacing;
  const zBox = extentCoverage(grid, 2, box.size[2] / 2);
  const center = new Float32Array(nx * ny), half = new Float32Array(nx * ny);
  // Profile intervals along Z: per row from the side views' plane, per column from the caps' plane.
  const zyLo = new Int32Array(ny).fill(-1), zyHi = new Int32Array(ny).fill(-1);
  if (planes.hasZY)
    for (let j = 0; j < ny; j++) {
      const iv = interval(nz, (k) => planes.zy[k + nz * j], zBox);
      if (iv) {
        zyLo[j] = iv[0];
        zyHi[j] = iv[1];
      }
    }
  const xzLo = new Int32Array(nx).fill(-1), xzHi = new Int32Array(nx).fill(-1);
  if (planes.hasXZ)
    for (let i = 0; i < nx; i++) {
      const iv = interval(nz, (k) => planes.xz[i + nx * k], zBox);
      if (iv) {
        xzLo[i] = iv[0];
        xzHi[i] = iv[1];
      }
    }
  const boxIv = interval(nz, () => 1, zBox) ?? [0, nz - 1];
  let columns = 0;
  for (let j = 0; j < ny; j++, yield)
    for (let i = 0; i < nx; i++) {
      const c = i + nx * j;
      if (!bin[c] || !(deltaVox > 0)) continue;
      const gate = Math.min(1, Math.max(0, (2 * deltaVox - tau[c] / 2) / deltaVox));
      if (gate <= 0) continue;
      // Profile interval: ZY row ∩ XZ column. A plane that disagrees with the front (disjoint, or
      // empty where the front shows a part: a frontal image in the top slot, a drawing without the
      // hat brim) does not decide alone: the other plane places the tube, else the box does — the
      // front says the part exists, the profiles only say where along Z. On a consistent set every
      // front-occupied row / column is occupied in both planes, so only inconsistent sets get here.
      let k0: number, k1: number;
      const zy = planes.hasZY && zyLo[j] >= 0, xz = planes.hasXZ && xzLo[i] >= 0;
      if (zy && xz) {
        const lo = Math.max(zyLo[j], xzLo[i]), hi = Math.min(zyHi[j], xzHi[i]);
        if (lo <= hi) [k0, k1] = [lo, hi];
        else [k0, k1] = [zyLo[j], zyHi[j]]; // disjoint: the side views decide
      } else if (zy) [k0, k1] = [zyLo[j], zyHi[j]];
      else if (xz) [k0, k1] = [xzLo[i], xzHi[i]];
      else [k0, k1] = boxIv;
      const zhalf = (k1 - k0 + 1) / 2;
      const p = gate * o.rho * Math.min(h3[c], zhalf);
      if (p <= 0) continue;
      center[c] = (k0 + k1) / 2;
      half[c] = p;
      columns++;
    }
  return new GuardField(grid, center, half, zBox, columns);
}
