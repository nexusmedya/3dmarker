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
    /** Thin parts and which views cannot see their depth (colouring, depth cap); null = none recorded. */
    readonly parts: ThinPartInfo | null = null,
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

  /**
   * The front columns within `reach` voxels of a point (world coords of the
   * grid) that belong to a thin part hidden from the view looking along
   * `axis` (0: left / right, 1: top / bottom; see ThinPartInfo): calls
   * `f(column, part gate)`.
   */
  private hiddenColumns(p: ArrayLike<number>, axis: 0 | 1, reach: number, f: (c: number, g: number) => void): void {
    const parts = this.parts;
    if (!parts) return;
    const { grid } = this;
    const [nx, ny] = grid.dims;
    const ic = Math.round((p[0] - grid.origin[0]) / grid.spacing), jc = Math.round((p[1] - grid.origin[1]) / grid.spacing);
    for (let j = Math.max(0, jc - reach); j <= Math.min(ny - 1, jc + reach); j++) {
      if (axis === 0 && !parts.rowHidden[j]) continue;
      for (let i = Math.max(0, ic - reach); i <= Math.min(nx - 1, ic + reach); i++) {
        if (axis === 1 && !parts.colHidden[i]) continue;
        const c = i + nx * j;
        if (parts.gate[c] > 0) f(c, parts.gate[c]);
      }
    }
  }

  /**
   * How far the view looking along `axis` (0: left / right, 1: top / bottom)
   * may colour a surface point (world coords of the grid): 1, except on a thin
   * part hidden from it, where it fades to 1 − gate within `margin` voxels
   * outside the part's round cross-section around the tube centre: beyond it
   * the hull only has the depth of whatever lies behind the part in that view
   * (see ColorOptions.thin). The least over the columns within `reach` voxels: the smoothed surface sits a
   * voxel or two outside the front silhouette.
   */
  colorSupport(p: ArrayLike<number>, axis: 0 | 1, margin = 1.5, reach = 2): number {
    const parts = this.parts;
    if (!parts) return 1;
    const k = (p[2] - this.grid.origin[2]) / this.grid.spacing;
    let support = 1;
    this.hiddenColumns(p, axis, reach, (c, g) => {
      const t = Math.min(1, Math.max(0, (Math.abs(k - this.center[c]) - parts.radius[c]) / margin));
      support = Math.min(support, 1 - g * t * t * (3 - 2 * t));
    });
    return support;
  }

  /** The largest part gate of the columns within `reach` voxels of the point (world coords); 0 = not thin. */
  gateAt(p: ArrayLike<number>, reach = 2): number {
    const parts = this.parts;
    if (!parts) return 0;
    const { grid } = this;
    const [nx, ny] = grid.dims;
    const ic = Math.round((p[0] - grid.origin[0]) / grid.spacing), jc = Math.round((p[1] - grid.origin[1]) / grid.spacing);
    let g = 0;
    for (let j = Math.max(0, jc - reach); j <= Math.min(ny - 1, jc + reach); j++)
      for (let i = Math.max(0, ic - reach); i <= Math.min(nx - 1, ic + reach); i++) g = Math.max(g, parts.gate[i + nx * j]);
    return g;
  }

  /**
   * Without depth maps nothing narrows a thin part whose depth every profile
   * view reads off a bigger part behind it (a T-pose arm: the side views see
   * the chest there, so the hull keeps the chest's depth — a plank). Caps such
   * columns to a round cross-section: field = min(field, ramp at
   * ROUND_SLACK · radius + 0.5 voxel around the tube centre), the thicker the
   * part the looser (1 − gate adds the rest of the profile interval). Returns
   * the voxels that dropped below 0.5.
   */
  capHidden(field: Float32Array): number {
    const parts = this.parts;
    if (!parts || (!parts.hasZY && !parts.hasXZ)) return 0;
    const [nx, ny, nz] = this.grid.dims;
    let removed = 0;
    for (let j = 1; j < ny - 1; j++) {
      if (parts.hasZY && !parts.rowHidden[j]) continue;
      for (let i = 1; i < nx - 1; i++) {
        if (parts.hasXZ && !parts.colHidden[i]) continue;
        const c = i + nx * j;
        const g = parts.gate[c];
        if (!(g > 0)) continue;
        const r = ROUND_SLACK * parts.radius[c] + (1 - g) * parts.span[c], kc = this.center[c];
        for (let k = 1; k < nz - 1; k++) {
          const v0 = r - Math.abs(k - kc) + 0.5;
          if (v0 >= 1) continue;
          const v = v0 <= 0 ? 0 : v0;
          const q = i + nx * (j + ny * k);
          if (field[q] > v) {
            if (field[q] > 0.5 && v <= 0.5) removed++;
            field[q] = v;
          }
        }
      }
    }
    return removed;
  }
}

/** capHidden keeps this multiple of the round half-thickness (a limb is rarely exactly round). */
export const ROUND_SLACK = 1.25;

/**
 * Thin parts of the front silhouette, per front column (i + nx·j) of the
 * guard grid, and which profile views see behind them. A left / right view
 * sees front row j in one piece, so where that row also holds a thicker part
 * (the chest beside a T-pose arm) its depth there belongs to that part
 * (`rowHidden`); likewise a top / bottom view and front column i
 * (`colHidden`: the head above the shoulders).
 */
export interface ThinPartInfo {
  /** 0..1 per column: how much it belongs to a thin PART (thinPartGate). */
  gate: Float32Array;
  /** Round cross-section's half-thickness min(h3, zhalf) and the profile interval's half length, voxels. */
  radius: Float32Array;
  span: Float32Array;
  rowHidden: Uint8Array;
  colHidden: Uint8Array;
  hasZY: boolean;
  hasXZ: boolean;
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

/** Area / (largest local thickness)² of a thin region below which it is a corner sliver, not a part. */
export const PART_MIN_AREA = 0.3;

/**
 * The thin PARTS of the front silhouette: columns whose guard gate is above ½
 * (local thickness below 3δL; a thick torso near 4δL fades the guard in but
 * is no part), ramped to 1 at ¾, in connected regions (4-neighbours) that are
 * not mere corner slivers — the corners of a thick silhouette have a small
 * local thickness too (only small discs fit there), but their region's area
 * is ≈ 0.05 τ², while a limb (elongated) or a head (a disc, ≈ 0.8 τ²) has
 * at least PART_MIN_AREA · (its largest τ)².
 */
export function thinPartGate(gate: Float32Array, tau: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const label = new Int32Array(w * h).fill(-1);
  const stack: number[] = [];
  const members: number[] = [];
  const thin = (c: number) => gate[c] > 0.5;
  for (let c0 = 0; c0 < w * h; c0++) {
    if (!thin(c0) || label[c0] >= 0) continue;
    members.length = 0;
    stack.push(c0);
    label[c0] = c0;
    let tmax = 0;
    while (stack.length) {
      const c = stack.pop()!;
      members.push(c);
      tmax = Math.max(tmax, tau[c]);
      const x = c % w, y = (c - x) / w;
      for (const d of [x > 0 ? c - 1 : -1, x < w - 1 ? c + 1 : -1, y > 0 ? c - w : -1, y < h - 1 ? c + w : -1]) {
        if (d < 0 || label[d] >= 0 || !thin(d)) continue;
        label[d] = c0;
        stack.push(d);
      }
    }
    if (members.length < PART_MIN_AREA * tmax * tmax) continue;
    for (const c of members) out[c] = Math.min(1, 4 * (gate[c] - 0.5));
  }
  return out;
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
  const gates = new Float32Array(nx * ny), radius = new Float32Array(nx * ny), span = new Float32Array(nx * ny);
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
      gates[c] = gate;
      radius[c] = Math.min(h3[c], zhalf);
      span[c] = zhalf;
      columns++;
    }
  const partGate = thinPartGate(gates, tau, nx, ny);
  // A front pixel of no thin part (a thicker part, or a corner of one) hides its row / column's parts.
  const rowHidden = new Uint8Array(ny), colHidden = new Uint8Array(nx);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const c = i + nx * j;
      if (bin[c] && !(partGate[c] > 0)) rowHidden[j] = colHidden[i] = 1;
    }
  const parts: ThinPartInfo = { gate: partGate, radius, span, rowHidden, colHidden, hasZY: planes.hasZY, hasXZ: planes.hasXZ };
  return new GuardField(grid, center, half, zBox, columns, parts);
}
