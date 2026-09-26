/**
 * Alignment helpers for the high-res crop pass (pure): a robust weighted
 * least-squares scale + offset between two relative depth maps, and a
 * feathered box blend weight. Relative (affine-invariant) disparities of the
 * same scene differ by an affine map, so scale + offset is the right model.
 */

export interface AffineFit {
  scale: number;
  offset: number;
  /** Weighted RMS residual over the inliers. */
  rmse: number;
  /** Inlier sample count. */
  count: number;
}

export interface FitOptions {
  /** Fraction of the largest residuals dropped per iteration (default 0.2). */
  trim?: number;
  /** Trimming iterations after the first fit (default 2). */
  iterations?: number;
  /** Minimum sample count (default 16). */
  minCount?: number;
}

function solve(src: ArrayLike<number>, dst: ArrayLike<number>, weight: ArrayLike<number> | null, idx: Int32Array | number[], n: number): AffineFit | null {
  let sw = 0, ss = 0, st = 0, sss = 0, sst = 0;
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    const w = weight ? weight[i] : 1;
    const s = src[i], t = dst[i];
    sw += w; ss += w * s; st += w * t; sss += w * s * s; sst += w * s * t;
  }
  if (sw <= 1e-12) return null;
  const ms = ss / sw, mt = st / sw;
  const varS = sss / sw - ms * ms;
  if (!(varS > 1e-10)) return null;
  const scale = (sst / sw - ms * mt) / varS;
  const offset = mt - scale * ms;
  let se = 0;
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    const w = weight ? weight[i] : 1;
    const e = scale * src[i] + offset - dst[i];
    se += w * e * e;
  }
  return { scale, offset, rmse: Math.sqrt(se / sw), count: n };
}

/**
 * Weighted least squares for dst ≈ scale·src + offset over samples with
 * weight > 0 (all samples when `weight` is null), refitted after dropping
 * the largest residuals (outliers: occluders, mis-segmented pixels). Null
 * when there are too few samples or `src` is constant.
 */
export function fitAffine(src: ArrayLike<number>, dst: ArrayLike<number>, weight: ArrayLike<number> | null, opts: FitOptions = {}): AffineFit | null {
  const trim = Math.min(0.9, Math.max(0, opts.trim ?? 0.2));
  const iterations = opts.iterations ?? 2;
  const minCount = opts.minCount ?? 16;
  const n0 = Math.min(src.length, dst.length);
  let idx = new Int32Array(n0);
  let n = 0;
  for (let i = 0; i < n0; i++) {
    if (weight && !(weight[i] > 0)) continue;
    if (!Number.isFinite(src[i]) || !Number.isFinite(dst[i])) continue;
    idx[n++] = i;
  }
  if (n < minCount) return null;
  let fit = solve(src, dst, weight, idx, n);
  for (let it = 0; it < iterations && fit && trim > 0; it++) {
    const res = new Float32Array(n);
    for (let k = 0; k < n; k++) res[k] = Math.abs(fit.scale * src[idx[k]] + fit.offset - dst[idx[k]]);
    const sorted = res.slice().sort();
    const thr = sorted[Math.min(n - 1, Math.floor(n * (1 - trim)))];
    const next = new Int32Array(n);
    let m = 0;
    for (let k = 0; k < n; k++) if (res[k] <= thr) next[m++] = idx[k];
    if (m < minCount || m === n) break;
    idx = next;
    n = m;
    fit = solve(src, dst, weight, idx, n) ?? fit;
  }
  return fit;
}

/**
 * Blend weight for a box of w × h pixels: 1 inside, falling smoothly to 0
 * over `feather` px towards each edge. Edges flagged open (the box touches
 * the image border there) are not feathered.
 */
export function boxFeather(
  w: number,
  h: number,
  feather: number,
  open: { left: boolean; right: boolean; top: boolean; bottom: boolean } = { left: false, right: false, top: false, bottom: false },
): Float32Array {
  const out = new Float32Array(w * h);
  const f = Math.max(1e-6, feather);
  const ramp = (d: number) => {
    const t = Math.min(1, Math.max(0, d / f));
    return t * t * (3 - 2 * t);
  };
  for (let y = 0; y < h; y++) {
    const wy = Math.min(open.top ? 1 : ramp(y + 0.5), open.bottom ? 1 : ramp(h - y - 0.5));
    for (let x = 0; x < w; x++) {
      const wx = Math.min(open.left ? 1 : ramp(x + 0.5), open.right ? 1 : ramp(w - x - 0.5));
      out[y * w + x] = Math.min(wx, wy);
    }
  }
  return out;
}
