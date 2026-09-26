/**
 * Registration of the extra views to the front by their silhouette profiles.
 *
 * The bbox normalisation (./frame.ts) is exact for consistent views, but views
 * drawn or generated outside the app differ from the front by a few percent
 * of scale and offset, or are cut off at an image edge (feet, hair). A few
 * percent is enough to move a side view's arm rows off the front's, and the
 * hull intersection then deletes the arms. So every non-front view is
 * registered to the front along the axes they share:
 *
 *   back  rows ↔ front rows, back columns ↔ front columns mirrored ("twin"
 *         pairs: the profiles are the same quantity and are compared directly)
 *   left / right rows ↔ front rows, top / bottom columns ↔ front columns
 *         ("shared-axis" pairs: a side profile is another quantity, only its
 *         edges — crown, neck, shoulders, hips, sole — and support line up)
 *
 * Profile = foreground count per row / column. Descriptors on a reference grid
 * over the front's extent (with margins): x = log(1 + w / w̄), support, and
 * soft-clipped edges d/dy[G_σ ∗ x]. A hypothesis (k, δ) resamples the view at
 * p(f) = c_v + sign · k · ρ · (f − δ) (f = front-frame position relative to the
 * front bbox centre, ρ = bbox extent ratio; k = 1, δ = 0 is the bbox fit) and
 * is scored by NCC of x, NCC of the edges and the IoU of the supports. Bins
 * past a cut image edge are unknown under the "censored" hypothesis, which
 * has to beat the uncensored one by a margin to count as a crop. Coarse grid
 * → local maxima → fine, trimmed refinement (the worst 20 % of bins dropped,
 * so a back whose arms sit lower does not drag the offset) → parabolic sub-
 * step. Plain references (sphere, box) and weak matches keep the bbox fit.
 *
 * Isotropy: one content scale k for both shared axes of the back (the rows'),
 * the columns re-fitted for their offset only. A back cut on one axis is the
 * exception: its uncut axis keeps its own extent, so alignedBox (one scale)
 * reproduces such a fitBox on the cut (vertical) axis only.
 *
 * Results feed the hull (fitBox), the UI badge (score / level / notes) and
 * the overlay (guides). Pure and deterministic; Node-testable.
 */
import type { I18nText, Lang, ViewId, ViewTrust } from '../types';
import { DEFAULT_VIEW_ALIGN } from '../types';
import type { MaskSource, PixelBox, PreparedView } from './frame';
import type {
  AlignCorrection,
  AlignLevel,
  AlignMode,
  AlignNote,
  AlignNoteCode,
  AlignStatus,
  CutFlags,
  ViewAlignment,
} from './types';

export const SHARED_AXES: Record<ViewId, { x: boolean; y: boolean }> = {
  front: { x: true, y: true },
  back: { x: true, y: true },
  left: { x: false, y: true },
  right: { x: false, y: true },
  top: { x: true, y: false },
  bottom: { x: true, y: false },
};

export interface AlignOptions {
  mode: AlignMode;
}

/** Registration constants (tuned on the procedural T-pose fixtures of ./testing.ts). */
export const ALIGN = {
  /** Reference grid bins over the front extent × (1 + 2·GRID_MARGIN). */
  N_BINS: 256,
  GRID_MARGIN: 0.35,
  /** Edge smoothing σ, bins. */
  SMOOTH_SIGMA: 1.5,
  /** Soft clip τ = EDGE_CLIP · MAD of the edges (τ·tanh(e/τ)). */
  EDGE_CLIP: 3,
  /** Scale search: ln k in ±LOGK_RANGE, coarse / fine steps (k = 1/(1 − 0.28) covers knee-up crops). */
  LOGK_RANGE: 0.37,
  LOGK_STEP: 0.02,
  LOGK_FINE: 0.005,
  /** Offset search, fractions of the front extent: coarse step; the fine step is a quarter bin (≈ 0.0017). */
  DELTA_RANGE: 0.3,
  DELTA_STEP: 0.01,
  /** Similarity weights (profile, edges, support) for twin and shared-axis pairs. */
  W_TWIN: [0.25, 0.5, 0.25] as const,
  W_SHARED: [0.2, 0.5, 0.3] as const,
  /** Untrimmed similarity at the fit below → 'weak'. */
  S_MIN_TWIN: 0.55,
  S_MIN_SHARED: 0.35,
  /**
   * Best − second distinct peak below → 'weak'. Distinct: farther than PEAK_DIST_LOGK / PEAK_DIST_DELTA
   * and separated by a valley at least VALLEY deep on the coarse grid (a ridge is one peak).
   */
  PROMINENCE: 0.08,
  PEAK_DIST_LOGK: 0.03,
  PEAK_DIST_DELTA: 0.02,
  VALLEY: 0.05,
  /** 1 − autocorrelation of the reference at a 3 % shift below → 'plain'. */
  STRUCTURE_MIN: 0.1,
  STRUCTURE_SHIFT: 0.03,
  /** Known-bin share under the front support below which 0.5·(VALID_MIN − valid) is subtracted. */
  VALID_MIN: 0.6,
  /** Share of the bins with the largest residual dropped in the fine refinement. */
  TRIM: 0.2,
  /** The censored hypothesis is preferred unless the uncensored one beats it by more than this. */
  CENSOR_SLACK: 0.01,
  /** A fit extending past a cut edge by this share of its extent means the view is cropped there. */
  CROP_MIN: 0.01,
  /** Back: |ln(k_cols / k_rows)| above → note 'aspect'. */
  ASPECT_WARN: Math.log(1.06),
  /** Border row / column foreground share of the bbox side for a cut flag (see frame.ts). */
  CUT_MIN_FRACTION: 0.02,
  /** Edge match tolerance (shared-axis confidence), fraction of the front extent; credit for an opposite-sign feature there. */
  MATCH_TOL: 0.02,
  MATCH_OPPOSITE: 0.85,
  /** Coarse ln k range of an axis with both silhouette ends intact (the end prior rules out more). */
  LOGK_RANGE_UNCUT: 0.16,
  /** Prior: an uncut silhouette end is the object's end; the fit pays this per unit of relative end deviation. */
  W_END: 1,
  /** Unmirrored columns must beat the mirrored fit by this (and the front be asymmetric) for note 'mirrored'. */
  MIRROR_MARGIN: 0.1,
  MIRROR_ASYMMETRY: 0.15,
  /** Guides: strongest edges per axis, non-maximum suppression radius (fraction of the extent). */
  GUIDES: 6,
  GUIDE_NMS: 0.03,
} as const;

/** Diagnostics sink for scripts / tests (null = silent). */
export let alignDebug: ((line: string) => void) | null = null;
export function setAlignDebug(sink: ((line: string) => void) | null): void {
  alignDebug = sink;
}

/** Sub-bin lattice per reference bin: the fine offset step. */
const SUB = 4;
const N: number = ALIGN.N_BINS;
/** ln k values of a coarse grid (symmetric, the identity on it). */
function logkGrid(range: number): number[] {
  const m = Math.floor(range / ALIGN.LOGK_STEP + 1e-9);
  const out: number[] = [];
  for (let i = -m; i <= m; i++) out.push(i * ALIGN.LOGK_STEP);
  return out;
}
const LOGK_GRID = logkGrid(ALIGN.LOGK_RANGE);
const LOGK_GRID_UNCUT = logkGrid(ALIGN.LOGK_RANGE_UNCUT);
/** Coarse offset step in sub-bin steps, and the search range. */
const D_STEP = Math.max(1, Math.round((ALIGN.DELTA_STEP * N * SUB) / (1 + 2 * ALIGN.GRID_MARGIN)));
const D_MAX = Math.floor((ALIGN.DELTA_RANGE * N * SUB) / (1 + 2 * ALIGN.GRID_MARGIN) / D_STEP) * D_STEP;
/** Lattice half length: every bin at every offset of the coarse range (+ the fine margin) must be on it. */
const M = (SUB * (N - 1)) / 2 + D_MAX + 2 * D_STEP;
const LATTICE = 2 * M + 1;
const KERNEL: Float32Array = (() => {
  const s = ALIGN.SMOOTH_SIGMA, r = Math.ceil(3 * s);
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * s * s));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
})();
const KR = (KERNEL.length - 1) / 2;

// ---------------------------------------------------------------------------
// Profiles

interface AxisProfile {
  n: number;
  count: Float64Array;
  /** n + 1 prefix sums of count / of (count > 0). */
  cum: Float64Array;
  cumSup: Float64Array;
  /** Mean count over the support. */
  mean: number;
  /** bbox along the axis (pixel edges). */
  lo: number;
  hi: number;
  cutLo: boolean;
  cutHi: boolean;
}

export interface AxisProfiles {
  rows: AxisProfile;
  cols: AxisProfile;
}

function profileOf(count: Float64Array, lo: number, hi: number, cutLo: boolean, cutHi: boolean): AxisProfile {
  const n = count.length;
  const cum = new Float64Array(n + 1), cumSup = new Float64Array(n + 1);
  let sum = 0, sup = 0;
  for (let i = 0; i < n; i++) {
    const c = count[i];
    cum[i + 1] = cum[i] + c;
    cumSup[i + 1] = cumSup[i] + (c > 0 ? 1 : 0);
    if (c > 0) {
      sum += c;
      sup++;
    }
  }
  return { n, count, cum, cumSup, mean: sup > 0 ? sum / sup : 1, lo, hi, cutLo, cutHi };
}

/** Per-row and per-column foreground counts of a view (whole image) with prefix sums. */
export function axisProfiles(view: PreparedView): AxisProfiles {
  const { width: w, height: h, data } = view.mask;
  const rows = new Float64Array(h), cols = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let c = 0;
    for (let x = 0; x < w; x++) {
      if (data[row + x]) {
        c++;
        cols[x]++;
      }
    }
    rows[y] = c;
  }
  const { bbox, cut } = view;
  return {
    rows: profileOf(rows, bbox.y0, bbox.y1, cut.top, cut.bottom),
    cols: profileOf(cols, bbox.x0, bbox.x1, cut.left, cut.right),
  };
}

/** ∫ count over [0, p] (linear between integer positions; outside the image counts 0). */
function cumAt(cum: Float64Array, count: Float64Array, n: number, p: number): number {
  if (p <= 0) return 0;
  if (p >= n) return cum[n];
  const i = Math.floor(p);
  return cum[i] + (p - i) * count[i];
}

function supAt(cumSup: Float64Array, count: Float64Array, n: number, p: number): number {
  if (p <= 0) return 0;
  if (p >= n) return cumSup[n];
  const i = Math.floor(p);
  return cumSup[i] + (p - i) * (count[i] > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Descriptors

/** Descriptors of one axis on a grid (the reference grid or the sub-bin lattice). */
class Descriptor {
  readonly x: Float32Array;
  readonly e: Float32Array;
  readonly sup: Uint8Array;
  readonly known: Uint8Array;
  private readonly xs: Float32Array;
  /** Edge clip scale. */
  tau = 0;

  constructor(readonly len: number) {
    this.x = new Float32Array(len);
    this.e = new Float32Array(len);
    this.xs = new Float32Array(len);
    this.sup = new Uint8Array(len);
    this.known = new Uint8Array(len).fill(1);
  }

  /** Smoothed edges of x at `stride` samples per bin, soft-clipped at τ = EDGE_CLIP · MAD over the support. */
  edges(stride: number): void {
    const { x, xs, e, len, sup, known } = this;
    for (let m = 0; m < len; m++) {
      let acc = 0;
      for (let j = -KR; j <= KR; j++) {
        const q = m + j * stride;
        if (q >= 0 && q < len) acc += KERNEL[j + KR] * x[q];
      }
      xs[m] = acc;
    }
    for (let m = 0; m < len; m++) {
      const a = m - stride >= 0 ? xs[m - stride] : 0, b = m + stride < len ? xs[m + stride] : 0;
      e[m] = (b - a) / 2;
    }
    // MAD over the support (plus a margin so the support ends count): median of |e|.
    let lo = len, hi = -1;
    for (let m = 0; m < len; m++) if (sup[m] && known[m]) {
      if (m < lo) lo = m;
      hi = m;
    }
    let tau = 1e-6;
    if (hi >= lo) {
      lo = Math.max(0, lo - 3 * stride);
      hi = Math.min(len - 1, hi + 3 * stride);
      const abs = new Float32Array(hi - lo + 1);
      let max = 0;
      for (let m = lo; m <= hi; m++) {
        const v = Math.abs(e[m]);
        abs[m - lo] = v;
        if (v > max) max = v;
      }
      abs.sort();
      tau = Math.max(ALIGN.EDGE_CLIP * abs[abs.length >> 1], 0.05 * max, 1e-6);
    }
    this.tau = tau;
    for (let m = 0; m < len; m++) e[m] = tau * Math.tanh(e[m] / tau);
  }
}

/** The front's descriptors along one axis. */
interface RefAxis {
  /** Bin width (front px), front bbox centre and extent, position of bin 0's centre. */
  wb: number;
  c: number;
  extent: number;
  r0: number;
  desc: Descriptor;
  supCount: number;
  supLo: number;
  supHi: number;
  /** 1 − autocorrelation at a STRUCTURE_SHIFT shift over the support (0 = plain). */
  structure: number;
  /** Front pixel positions of the support ends and the strongest edges. */
  guides: number[];
  /** 1 − NCC(x, mirrored x) over the support: how asymmetric the profile is. */
  asymmetry: number;
}

function ncc(n: number, sa: number, sb: number, saa: number, sbb: number, sab: number): number {
  if (n < 2) return 0;
  const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
  if (!(va > 1e-12) || !(vb > 1e-12)) return 0;
  const v = (sab - (sa * sb) / n) / Math.sqrt(va * vb);
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

function refAxis(prof: AxisProfile): RefAxis {
  const extent = prof.hi - prof.lo, c = (prof.lo + prof.hi) / 2;
  const wb = (extent * (1 + 2 * ALIGN.GRID_MARGIN)) / N;
  const r0 = c - ((N - 1) / 2) * wb;
  const desc = new Descriptor(N);
  let supCount = 0, supLo = N, supHi = -1;
  for (let i = 0; i < N; i++) {
    const r = r0 + i * wb;
    const w = (cumAt(prof.cum, prof.count, prof.n, r + wb / 2) - cumAt(prof.cum, prof.count, prof.n, r - wb / 2)) / wb;
    desc.x[i] = Math.log(1 + w / prof.mean);
    const s = (supAt(prof.cumSup, prof.count, prof.n, r + wb / 2) - supAt(prof.cumSup, prof.count, prof.n, r - wb / 2)) / wb;
    if (s >= 0.5) {
      desc.sup[i] = 1;
      supCount++;
      if (i < supLo) supLo = i;
      supHi = i;
    }
  }
  desc.edges(1);
  // Structure: autocorrelation of x at a 3 % shift over the support; a smooth profile (sphere, box) has none.
  const shift = Math.max(1, Math.round((ALIGN.STRUCTURE_SHIFT * extent) / wb));
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  let ma = 0, mb = 0, maa = 0, mbb = 0, mab = 0, mn = 0;
  for (let i = supLo; i <= supHi; i++) {
    const a = desc.x[i];
    if (i + shift <= supHi) {
      const b = desc.x[i + shift];
      n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
    const b2 = desc.x[supLo + supHi - i];
    mn++; ma += a; mb += b2; maa += a * a; mbb += b2 * b2; mab += a * b2;
  }
  // A constant profile (a rectangle) has no structure at all: NCC is undefined there, not 0.
  const flat = mn < 4 || maa - (ma * ma) / mn < 1e-9;
  const structure = flat || n < 4 ? 0 : 1 - ncc(n, sa, sb, saa, sbb, sab);
  const asymmetry = flat ? 0 : 1 - ncc(mn, ma, mb, maa, mbb, mab);
  // Guides: support ends + the strongest edges away from them (non-maximum suppression).
  const guides = [prof.lo, prof.hi];
  const nms = Math.max(1, Math.round((ALIGN.GUIDE_NMS * extent) / wb));
  const cand: { i: number; v: number }[] = [];
  for (let i = supLo + nms; i <= supHi - nms; i++) {
    const v = Math.abs(desc.e[i]);
    let peak = v > 0;
    for (let j = Math.max(0, i - nms); peak && j <= Math.min(N - 1, i + nms); j++) if (j !== i && Math.abs(desc.e[j]) > v) peak = false;
    if (peak) cand.push({ i, v });
  }
  cand.sort((p, q) => q.v - p.v);
  for (const { i } of cand.slice(0, ALIGN.GUIDES)) guides.push(r0 + i * wb);
  return { wb, c, extent, r0, desc, supCount, supLo, supHi, structure, guides, asymmetry };
}

interface FrontRef {
  rows: RefAxis;
  cols: RefAxis;
  profiles: AxisProfiles;
}

const frontCache = new WeakMap<PreparedView, FrontRef>();

function frontRef(front: PreparedView): FrontRef {
  let ref = frontCache.get(front);
  if (!ref) {
    const profiles = axisProfiles(front);
    ref = { rows: refAxis(profiles.rows), cols: refAxis(profiles.cols), profiles };
    frontCache.set(front, ref);
  }
  return ref;
}

/** One view axis against a front axis. */
interface Pair {
  prof: AxisProfile;
  ref: RefAxis;
  /** +1: same direction as the front's axis; −1: mirrored (back columns). */
  sign: 1 | -1;
  /** View bbox extent / front bbox extent (the bbox fit's scale) and the view bbox centre. */
  rho: number;
  cv: number;
  twin: boolean;
  /** Censored view ends (bins past them are unknown). */
  censorLo: boolean;
  censorHi: boolean;
}

function makePair(prof: AxisProfile, ref: RefAxis, sign: 1 | -1, twin: boolean, censor: boolean): Pair {
  return {
    prof, ref, sign, twin,
    rho: (prof.hi - prof.lo) / ref.extent,
    cv: (prof.lo + prof.hi) / 2,
    censorLo: censor && prof.cutLo,
    censorHi: censor && prof.cutHi,
  };
}

/**
 * Fill `desc` with the view's descriptors at scale k for the front-frame
 * positions f(m) = f0 + m·step (relative to the front bbox centre), `stride`
 * samples per bin. Bins whose footprint (plus a bin) reaches past a censored
 * end are unknown and sample the end (replicated) instead.
 */
function sampleView(pair: Pair, k: number, f0: number, step: number, stride: number, desc: Descriptor): void {
  const { prof, ref, sign, rho, cv, censorLo, censorHi } = pair;
  const { cum, cumSup, count, n, mean } = prof;
  const s = k * rho, hw = (s * ref.wb) / 2, margin = s * ref.wb;
  const { x, sup, known, len } = desc;
  for (let m = 0; m < len; m++) {
    let p = cv + sign * s * (f0 + m * step);
    let ok = 1;
    if (censorLo && p - hw - margin < 0) {
      ok = 0;
      if (p < hw) p = hw;
    }
    if (censorHi && p + hw + margin > n) {
      ok = 0;
      if (p > n - hw) p = n - hw;
    }
    known[m] = ok;
    x[m] = Math.log(1 + (cumAt(cum, count, n, p + hw) - cumAt(cum, count, n, p - hw)) / (2 * hw) / mean);
    sup[m] = (supAt(cumSup, count, n, p + hw) - supAt(cumSup, count, n, p - hw)) / (2 * hw) >= 0.5 ? 1 : 0;
  }
  desc.edges(stride);
}

// ---------------------------------------------------------------------------
// Similarity

interface Scratch {
  res: Float32Array;
  sorted: Float32Array;
}

const scratch: Scratch = { res: new Float32Array(N), sorted: new Float32Array(N) };

interface Terms {
  s: number;
  nccX: number;
  nccE: number;
  iou: number;
  valid: number;
  n: number;
}

/**
 * Similarity of the reference and the view descriptor gathered at bins
 * j = base + stride·i: w_p·NCC(x) + w_e·NCC(e) + w_s·IoU(sup) − penalty(valid).
 * The NCC terms run over the bins where either side has support (the
 * background would otherwise dominate them; the supports' agreement is the
 * IoU term's job), the IoU over every known bin. `trim` > 0 drops that share
 * of the support bins with the largest standardised residual and
 * re-evaluates on the rest.
 */
function similarity(ref: RefAxis, desc: Descriptor, base: number, stride: number, w: readonly [number, number, number], trim: number): Terms {
  const R = ref.desc, { res, sorted } = scratch;
  const rx = R.x, re = R.e, rs = R.sup, vx = desc.x, ve = desc.e, vs = desc.sup, kn = desc.known;
  let n = 0, sxr = 0, sxv = 0, sxrr = 0, sxvv = 0, sxrv = 0, ser = 0, sev = 0, serr = 0, sevv = 0, serv = 0, inter = 0, union = 0, validN = 0;
  for (let i = 0; i < N; i++) {
    const j = base + stride * i;
    if (!kn[j]) continue;
    validN += rs[i];
    if (rs[i] & vs[j]) inter++;
    if (!(rs[i] | vs[j])) continue;
    union++;
    n++;
    const a = rx[i], b = vx[j], c = re[i], d = ve[j];
    sxr += a; sxv += b; sxrr += a * a; sxvv += b * b; sxrv += a * b;
    ser += c; sev += d; serr += c * c; sevv += d * d; serv += c * d;
  }
  const valid = ref.supCount > 0 ? validN / ref.supCount : 1;
  const pen = valid < ALIGN.VALID_MIN ? 0.5 * (ALIGN.VALID_MIN - valid) : 0;
  if (n < 8) return { s: -1, nccX: 0, nccE: 0, iou: 0, valid, n };
  let nccX = ncc(n, sxr, sxv, sxrr, sxvv, sxrv), nccE = ncc(n, ser, sev, serr, sevv, serv);
  const iou = union > 0 ? inter / union : 0;
  if (trim > 0 && n >= 16) {
    const mxr = sxr / n, mxv = sxv / n, mer = ser / n, mev = sev / n;
    const dxr = Math.sqrt(Math.max(1e-12, sxrr / n - mxr * mxr)), dxv = Math.sqrt(Math.max(1e-12, sxvv / n - mxv * mxv));
    const der = Math.sqrt(Math.max(1e-12, serr / n - mer * mer)), dev = Math.sqrt(Math.max(1e-12, sevv / n - mev * mev));
    let q = 0;
    for (let i = 0; i < N; i++) {
      const j = base + stride * i;
      if (!kn[j] || !(rs[i] | vs[j])) continue;
      const zx = (rx[i] - mxr) / dxr - (vx[j] - mxv) / dxv, ze = (re[i] - mer) / der - (ve[j] - mev) / dev;
      const r = w[0] * zx * zx + w[1] * ze * ze + w[2] * (rs[i] !== vs[j] ? 1 : 0);
      res[i] = r;
      sorted[q++] = r;
    }
    const view = sorted.subarray(0, q);
    view.sort();
    const thr = view[Math.min(q - 1, Math.floor((1 - trim) * q))];
    let m = 0, inter2 = 0, union2 = 0;
    sxr = sxv = sxrr = sxvv = sxrv = ser = sev = serr = sevv = serv = 0;
    for (let i = 0; i < N; i++) {
      const j = base + stride * i;
      if (!kn[j] || !(rs[i] | vs[j]) || res[i] > thr) continue;
      m++;
      const a = rx[i], b = vx[j], c = re[i], d = ve[j];
      sxr += a; sxv += b; sxrr += a * a; sxvv += b * b; sxrv += a * b;
      ser += c; sev += d; serr += c * c; sevv += d * d; serv += c * d;
      if (rs[i] & vs[j]) inter2++;
      union2++;
    }
    nccX = ncc(m, sxr, sxv, sxrr, sxvv, sxrv);
    nccE = ncc(m, ser, sev, serr, sevv, serv);
    return { s: w[0] * nccX + w[1] * nccE + w[2] * (union2 > 0 ? inter2 / union2 : 0) - pen, nccX, nccE, iou, valid, n };
  }
  return { s: w[0] * nccX + w[1] * nccE + w[2] * iou - pen, nccX, nccE, iou, valid, n };
}

/**
 * Twin confidence: NCC of the log-width profiles over the support bins (either
 * side) — a back whose arms sit lower loses agreement there, not over the
 * background. Shared-axis confidence: how much of the view's edge mass has a
 * same-sign front edge within MATCH_TOL (a side profile has fewer edges than
 * the front, all of which should be explained by it).
 */
function confidenceOf(ref: RefAxis, desc: Descriptor, twin: boolean, plain: boolean): number {
  const R = ref.desc;
  if (plain) {
    let inter = 0, union = 0;
    for (let i = 0; i < N; i++) {
      if (!desc.known[i]) continue;
      if (R.sup[i] & desc.sup[i]) inter++;
      if (R.sup[i] | desc.sup[i]) union++;
    }
    return union > 0 ? inter / union : 0;
  }
  if (twin) {
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let i = 0; i < N; i++) {
      if (!desc.known[i] || !(R.sup[i] | desc.sup[i])) continue;
      const a = R.x[i], b = desc.x[i];
      n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
    return Math.max(0, ncc(n, sa, sb, saa, sbb, sab));
  }
  // A view edge is explained when the front has a same-sign edge nearby at least as strong relative
  // to its own clip scale (a gentle leg taper matches a gentle taper, a landmark a landmark).
  const tol = Math.max(1, Math.round((ALIGN.MATCH_TOL * ref.extent) / ref.wb));
  const tauR = R.tau, tauV = desc.tau;
  let mass = 0, matched = 0;
  for (let i = 0; i < N; i++) {
    if (!desc.known[i]) continue;
    const ev = desc.e[i], a = Math.abs(ev);
    if (a <= 1e-9) continue;
    const sgn = ev > 0 ? 1 : -1;
    let same = 0, opposite = 0;
    for (let j = Math.max(0, i - tol); j <= Math.min(N - 1, i + tol); j++) {
      const v = (R.e[j] * sgn) / tauR;
      if (v > same) same = v;
      if (-v > opposite) opposite = -v;
    }
    // A feature of the opposite sign at the same place (a hand thinner from above, taller from the
    // front) is still the same landmark: partial credit.
    const rel = a / tauV;
    mass += a;
    matched += a * Math.max(Math.min(1, same / rel), ALIGN.MATCH_OPPOSITE * Math.min(1, opposite / rel));
  }
  return mass > 1e-9 ? matched / mass : 0;
}

// ---------------------------------------------------------------------------
// Search

interface AxisFit {
  status: 'aligned' | 'weak' | 'plain';
  logk: number;
  /** Offset δ in front px (front-frame, relative to the front bbox centre). */
  delta: number;
  /** Untrimmed similarity at the fit, and the trimmed one of the refinement. */
  s: number;
  st: number;
  prominence: number;
  confidence: number;
  censored: boolean;
  desc: Descriptor;
}

/** Descriptor of the view on the reference grid at an exact (k, δ). */
function directDescriptor(pair: Pair, logk: number, delta: number): Descriptor {
  const desc = new Descriptor(N);
  const { ref } = pair;
  sampleView(pair, Math.exp(logk), -((N - 1) / 2) * ref.wb - delta, ref.wb, 1, desc);
  return desc;
}

/**
 * Prior on a hypothesis: an uncut silhouette end is the object's end, so the
 * fitted interval should reach it; the deviation is paid relative to the bbox
 * extent (`d` in sub-bin steps).
 */
function endPrior(pair: Pair, logk: number, d: number): number {
  const { prof } = pair;
  const [lo, hi] = fitInterval(pair, logk, (d * pair.ref.wb) / SUB);
  let dev = 0;
  if (!prof.cutLo) dev += Math.abs(lo - prof.lo);
  if (!prof.cutHi) dev += Math.abs(hi - prof.hi);
  return (ALIGN.W_END * dev) / Math.max(1e-9, prof.hi - prof.lo);
}

/**
 * Coarse grid (ln k × δ) → local maxima → fine trimmed refinement of the top
 * three and the identity → parabolic sub-step. `logks` = the scale values to
 * search (a single value fixes k).
 */
function search(pair: Pair, logks: readonly number[], fineK: boolean): { logk: number; delta: number; st: number; prominence: number } {
  const { ref } = pair;
  const w = pair.twin ? ALIGN.W_TWIN : ALIGN.W_SHARED;
  const lattice = new Descriptor(LATTICE);
  const nd = (2 * D_MAX) / D_STEP + 1, nk = logks.length;
  const grid = new Float32Array(nk * nd).fill(-2);
  const build = (logk: number) => sampleView(pair, Math.exp(logk), -M * (ref.wb / SUB), ref.wb / SUB, SUB, lattice);
  const baseOf = (d: number) => M - (SUB * (N - 1)) / 2 - d;
  for (let ki = 0; ki < nk; ki++) {
    build(logks[ki]);
    for (let di = 0; di < nd; di++) {
      const d = -D_MAX + di * D_STEP;
      grid[ki * nd + di] = similarity(ref, lattice, baseOf(d), SUB, w, 0).s - endPrior(pair, logks[ki], d);
    }
  }
  // Local maxima of the coarse grid, best first; the identity cell always joins.
  const peaks: { ki: number; di: number; s: number }[] = [];
  for (let ki = 0; ki < nk; ki++)
    for (let di = 0; di < nd; di++) {
      const s = grid[ki * nd + di];
      let top = s > -2;
      for (let a = Math.max(0, ki - 1); top && a <= Math.min(nk - 1, ki + 1); a++)
        for (let b = Math.max(0, di - 1); top && b <= Math.min(nd - 1, di + 1); b++)
          if ((a !== ki || b !== di) && grid[a * nd + b] > s) top = false;
      if (top) peaks.push({ ki, di, s });
    }
  peaks.sort((p, q) => q.s - p.s);
  const cands = peaks.slice(0, 3);
  const ki0 = logks.findIndex((v) => Math.abs(v) < 1e-9), di0 = D_MAX / D_STEP;
  if (ki0 >= 0 && !cands.some((c) => c.ki === ki0 && c.di === di0)) cands.push({ ki: ki0, di: di0, s: grid[ki0 * nd + di0] });
  // Fine, trimmed refinement of each candidate within ±1 coarse cell.
  const kFine = fineK ? Math.round(ALIGN.LOGK_STEP / ALIGN.LOGK_FINE) : 0;
  const refined: { logk: number; d: number; st: number; su: number; cell: Float32Array; nkf: number; ndf: number; ki: number; di: number; cs: number }[] = [];
  for (const c of cands) {
    const nkf = 2 * kFine + 1, ndf = 2 * D_STEP + 1;
    const cell = new Float32Array(nkf * ndf).fill(-2);
    let best = -Infinity, bk = 0, bd = 0;
    // (the candidate's coarse cell is kept for the valley test below)
    for (let a = 0; a < nkf; a++) {
      const logk = logks[c.ki] + (a - kFine) * ALIGN.LOGK_FINE;
      if (Math.abs(logk) > ALIGN.LOGK_RANGE + 1e-9) continue;
      build(logk);
      for (let b = 0; b < ndf; b++) {
        const d = -D_MAX + c.di * D_STEP + (b - D_STEP);
        const st = similarity(ref, lattice, baseOf(d), SUB, w, ALIGN.TRIM).s - endPrior(pair, logk, d);
        cell[a * ndf + b] = st;
        if (st > best) {
          best = st;
          bk = a;
          bd = b;
        }
      }
    }
    // Parabolic sub-step in each dimension (interior cells only).
    const sub = (lo: number, mid: number, hi: number) => {
      const den = lo - 2 * mid + hi;
      return den < -1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (lo - hi)) / den)) : 0;
    };
    let logk = logks[c.ki] + (bk - kFine) * ALIGN.LOGK_FINE;
    if (bk > 0 && bk < nkf - 1 && cell[(bk - 1) * ndf + bd] > -2 && cell[(bk + 1) * ndf + bd] > -2) {
      logk += sub(cell[(bk - 1) * ndf + bd], best, cell[(bk + 1) * ndf + bd]) * ALIGN.LOGK_FINE;
    }
    let d = -D_MAX + c.di * D_STEP + (bd - D_STEP);
    if (bd > 0 && bd < ndf - 1) d += sub(cell[bk * ndf + bd - 1], best, cell[bk * ndf + bd + 1]);
    refined.push({ logk, d, st: best, su: -2, cell, nkf, ndf, ki: c.ki, di: c.di, cs: c.s });
  }
  // The trimmed score picks the winner (a back whose arms sit lower agrees perfectly on the other 80 %
  // of its bins at the identity, while an alias that lines the arm band up has a higher untrimmed score
  // thanks to the band's share of the variance). A rival is an ambiguity only when it is close on both
  // the trimmed and the untrimmed score: trimming alone flatters an alias that mismatches 20 %.
  const direct = new Descriptor(N);
  for (const r of refined) {
    sampleView(pair, Math.exp(r.logk), -((N - 1) / 2) * ref.wb - (r.d * ref.wb) / SUB, ref.wb, 1, direct);
    r.su = similarity(ref, direct, 0, 1, w, 0).s - endPrior(pair, r.logk, r.d);
  }
  refined.sort((p, q) => q.st - p.st);
  const top = refined[0];
  const distD = (ALIGN.PEAK_DIST_DELTA * ref.extent * SUB) / ref.wb;
  // Lowest coarse score on the straight path between two cells (nearest cells).
  const pathMin = (a: { ki: number; di: number }, b: { ki: number; di: number }) => {
    const steps = Math.max(Math.abs(a.ki - b.ki), Math.abs(a.di - b.di));
    let min = Infinity;
    for (let s = 0; s <= steps; s++) {
      const t = steps ? s / steps : 0;
      const ki = Math.round(a.ki + (b.ki - a.ki) * t), di = Math.round(a.di + (b.di - a.di) * t);
      min = Math.min(min, grid[ki * nd + di]);
    }
    return min;
  };
  let prominence = Infinity;
  for (const r of refined.slice(1)) {
    const far = Math.abs(r.logk - top.logk) > ALIGN.PEAK_DIST_LOGK || Math.abs(r.d - top.d) > distD;
    if (!far) continue;
    if (Math.min(r.cs, top.cs) - pathMin(top, r) < ALIGN.VALLEY) continue; // the same ridge
    prominence = Math.min(prominence, Math.max(top.st - r.st, top.su - r.su));
  }
  if (alignDebug) {
    alignDebug(`    search ${pair.twin ? 'twin' : 'shared'} sign ${pair.sign} censor ${pair.censorLo ? 'lo' : ''}${pair.censorHi ? 'hi' : ''}: coarse peaks ${peaks.slice(0, 5).map((p) => `(lnk ${logks[p.ki].toFixed(3)} δ ${((-D_MAX + p.di * D_STEP) / SUB / N * (1 + 2 * ALIGN.GRID_MARGIN)).toFixed(3)} S ${p.s.toFixed(3)})`).join(' ')}`);
    alignDebug(`      refined ${refined.map((r) => `(lnk ${r.logk.toFixed(3)} δ ${(r.d / SUB / N * (1 + 2 * ALIGN.GRID_MARGIN)).toFixed(4)} St ${r.st.toFixed(3)} Su ${r.su.toFixed(3)})`).join(' ')} → prominence ${prominence.toFixed(3)}`);
  }
  return { logk: top.logk, delta: (top.d * ref.wb) / SUB, st: top.st, prominence };
}

/** Fit of one axis (both censor variants when the axis is cut); the identity when plain / weak. */
function fitAxis(pair0: Pair, logks: readonly number[], fineK: boolean): AxisFit {
  const { ref } = pair0;
  const w = pair0.twin ? ALIGN.W_TWIN : ALIGN.W_SHARED;
  const sMin = pair0.twin ? ALIGN.S_MIN_TWIN : ALIGN.S_MIN_SHARED;
  const identity = (status: AxisFit['status'], pair: Pair): AxisFit => {
    const desc = directDescriptor(pair, 0, 0);
    return {
      status, logk: 0, delta: 0, s: similarity(ref, desc, 0, 1, w, 0).s, st: 0, prominence: 0,
      confidence: confidenceOf(ref, desc, pair.twin, status === 'plain'), censored: false, desc,
    };
  };
  if (ref.structure < ALIGN.STRUCTURE_MIN) return identity('plain', pair0);
  const cut = pair0.prof.cutLo || pair0.prof.cutHi;
  const variants: Pair[] = [pair0];
  if (cut) variants.push({ ...pair0, censorLo: pair0.prof.cutLo, censorHi: pair0.prof.cutHi });
  const grid = !cut && logks.length > 1 ? LOGK_GRID_UNCUT : logks;
  let best: AxisFit | null = null;
  for (const pair of variants) {
    const r = search(pair, grid, fineK);
    const desc = directDescriptor(pair, r.logk, r.delta);
    const t = similarity(ref, desc, 0, 1, w, 0);
    const fit: AxisFit = {
      status: 'aligned', logk: r.logk, delta: r.delta, s: t.s, st: r.st, prominence: r.prominence,
      confidence: confidenceOf(ref, desc, pair.twin, false), censored: pair.censorLo || pair.censorHi, desc,
    };
    if (alignDebug) alignDebug(`      final S ${t.s.toFixed(3)} (nccX ${t.nccX.toFixed(3)} nccE ${t.nccE.toFixed(3)} iou ${t.iou.toFixed(3)} valid ${t.valid.toFixed(2)}) conf ${fit.confidence.toFixed(3)}`);
    // Censoring is the right model when a crop exists: prefer it unless clearly worse.
    if (!best) best = fit;
    else if (fit.s >= best.s - ALIGN.CENSOR_SLACK) best = fit;
  }
  const fit = best!;
  if (fit.s < sMin || fit.prominence < ALIGN.PROMINENCE) return identity('weak', pair0);
  return fit;
}

// ---------------------------------------------------------------------------
// Fallback anchors for cut views

/**
 * Crown → neck anchor: row (from the bbox top) of the first pronounced
 * minimum of the smoothed per-row extent within the top 45 %: a drop below
 * 0.75 × the running max followed by a rise ≥ 25 %. Null when there is none.
 */
export function neckRow(prof: AxisProfile, limitFrac = 0.45): number | null {
  const n = prof.hi - prof.lo, lim = Math.floor(n * limitFrac);
  if (n < 8) return null;
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const at = (j: number) => prof.count[prof.lo + Math.max(0, Math.min(n - 1, j))];
    e[i] = (at(i - 1) + at(i) + at(i + 1)) / 3;
  }
  let runMax = 0;
  for (let i = 0; i < lim; i++) {
    runMax = Math.max(runMax, e[i]);
    if (e[i] >= 0.75 * runMax) continue;
    let jmin = i;
    for (let j = i; j < lim; j++) {
      if (e[j] < e[jmin]) jmin = j;
      if (j > jmin && e[j] >= 1.25 * e[jmin]) return jmin;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public helpers

/** Bbox → fitted box for a correction (content right ⇔ the box moves left; content larger ⇔ the box shrinks, shared axes only). */
export function alignedBox(b: PixelBox, a: { dx: number; dy: number; scale: number }, shared: { x: boolean; y: boolean }): PixelBox {
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0, L = Math.max(bw, bh);
  // Content right ⇔ the fitted box moves left; content larger ⇔ the fitted box shrinks (shared axes only:
  // the unshared axis of a side / cap view measures the object's depth and keeps the bbox extent).
  const cx = (b.x0 + b.x1) / 2 - a.dx * L, cy = (b.y0 + b.y1) / 2 - a.dy * L;
  const hw = bw / 2 / (shared.x ? a.scale : 1), hh = bh / 2 / (shared.y ? a.scale : 1);
  return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
}

/** The correction that alignedBox needs to turn `bbox` into `fit` (scale from the shared vertical axis when there is one). */
export function correctionOf(bbox: PixelBox, fit: PixelBox, shared: { x: boolean; y: boolean }): { dx: number; dy: number; scale: number } {
  const bw = bbox.x1 - bbox.x0, bh = bbox.y1 - bbox.y0, L = Math.max(bw, bh);
  const scale = shared.y ? bh / Math.max(1e-9, fit.y1 - fit.y0) : shared.x ? bw / Math.max(1e-9, fit.x1 - fit.x0) : 1;
  return {
    dx: ((bbox.x0 + bbox.x1) / 2 - (fit.x0 + fit.x1) / 2) / L,
    dy: ((bbox.y0 + bbox.y1) / 2 - (fit.y0 + fit.y1) / 2) / L,
    scale,
  };
}

export function alignResidual(suggested: AlignCorrection, current: { dx: number; dy: number; scale: number }): { dx: number; dy: number; scale: number } {
  return { dx: suggested.dx - current.dx, dy: suggested.dy - current.dy, scale: suggested.scale / Math.max(1e-9, current.scale) };
}

export function alignScore(a: {
  confidence: number;
  residual: { dx: number; dy: number; scale: number };
  cut: CutFlags;
  status: AlignStatus;
  id: ViewId;
  maskSource: MaskSource;
}): number {
  if (a.maskSource === 'none') return 0;
  const shared = SHARED_AXES[a.id];
  const r = a.residual;
  const fit = 1
    - 0.5 * Math.min(1, Math.abs(r.dy) / 0.08) * (shared.y ? 1 : 0)
    - 0.3 * Math.min(1, Math.abs(Math.log(Math.max(1e-9, r.scale))) / 0.15)
    - 0.2 * Math.min(1, Math.abs(r.dx) / 0.08) * (shared.x ? 1 : 0);
  const base = 100 * Math.min(1, Math.max(0, a.confidence)) * Math.max(0, fit);
  const cuts = (a.cut.top ? 1 : 0) + (a.cut.bottom ? 1 : 0) + (a.cut.left ? 1 : 0) + (a.cut.right ? 1 : 0);
  const pen = 8 * cuts + (a.status === 'stretched' ? 25 : 0);
  return Math.round(Math.min(100, Math.max(0, base - pen)));
}

export function alignLevel(score: number): AlignLevel {
  return score >= 80 ? 'good' : score >= 55 ? 'fair' : 'poor';
}

// ---------------------------------------------------------------------------
// Text

export const ALIGN_TEXT = {
  aligned: { tr: 'Önle hizalı', en: 'Aligned with the front' },
  autoAligned: { tr: 'Otomatik hizalandı: {what}', en: 'Auto-aligned: {what}' },
  lower: { tr: '%{n} aşağı', en: '{n} % down' },
  higher: { tr: '%{n} yukarı', en: '{n} % up' },
  leftOf: { tr: '%{n} sola', en: '{n} % left' },
  rightOf: { tr: '%{n} sağa', en: '{n} % right' },
  scaled: { tr: 'ölçek {s}', en: 'scale {s}' },
  cropped: { tr: 'Kenarda kesik', en: 'Cut off at the edge' },
  croppedBottom: { tr: 'Alt kenarda kesik (ayaklar?)', en: 'Cut off at the bottom edge (feet?)' },
  croppedTop: { tr: 'Üst kenarda kesik (saç / kafa?)', en: 'Cut off at the top edge (hair / head?)' },
  croppedLeft: { tr: 'Sol kenarda kesik', en: 'Cut off at the left edge' },
  croppedRight: { tr: 'Sağ kenarda kesik', en: 'Cut off at the right edge' },
  stretched: { tr: 'Kenarda kesik, ölçek bulunamadı; hizalama yaklaşık', en: 'Cut off at the edge, scale not found; alignment is approximate' },
  weak: { tr: 'Önle eşleştirilemedi; çerçeve olduğu gibi kullanılıyor', en: 'Could not be matched to the front; using its frame as is' },
  plain: { tr: 'Hizalanacak ayrıntı yok (düz siluet)', en: 'Nothing to align (a plain silhouette)' },
  aspect: { tr: 'En-boy oranı önden %{n} farklı; arka görünüm önle aynı oranda olmalı', en: 'Aspect differs from the front by {n} %; the back view should match the front\'s proportions' },
  sideBlind: { tr: 'Yan görünüm kol yüksekliğini doğrulayamaz; kollar kaybolursa "Yalnız renk"i deneyin', en: 'A side view cannot verify the arm height; if the arms vanish, try "Colour only"' },
  noMask: { tr: 'Arka plan bulunamadı: tüm görsel özne sayılır. Saydam PNG ya da düz arka plan kullanın', en: 'No background found: the whole image counts as the subject. Use a transparent PNG or a plain background' },
  mirrored: { tr: 'Aynalanmış görünüyor: arka görünümde öznenin solu görselin solunda olmalı', en: 'Looks mirrored: in the back view the subject\'s left should be on the image\'s left' },
  colorOnly: { tr: 'Yalnız renk için kullanılıyor', en: 'Used for colour only' },
  off: { tr: 'Kapalı: birleştirmede kullanılmıyor', en: 'Off: not used in the fusion' },
  inconsistent: { tr: 'Ön görünümle tam örtüşmüyor; ince parçalar korundu', en: 'Does not quite match the front; thin parts were protected' },
} satisfies Record<AlignNoteCode | 'lower' | 'higher' | 'leftOf' | 'rightOf' | 'scaled' | 'croppedTop' | 'croppedBottom' | 'croppedLeft' | 'croppedRight', I18nText>;

/** {n}: one decimal below 5, an integer above. */
export function formatPercent(v: number): string {
  const a = Math.abs(v);
  return a < 5 ? a.toFixed(1) : String(Math.round(a));
}

const fill = (t: I18nText, vars: Record<string, string>): I18nText => {
  const sub = (s: string) => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
  return { tr: sub(t.tr), en: sub(t.en) };
};

export function alignNote(code: AlignNoteCode, text: I18nText = ALIGN_TEXT[code]): AlignNote {
  return { code, text };
}

/** The status note of a correction: 'aligned' when trivial, else 'autoAligned: {what}'. */
function statusNote(id: ViewId, a: AlignCorrection): AlignNote {
  const shared = SHARED_AXES[id];
  const parts: I18nText[] = [];
  if (shared.y && Math.abs(a.dy) >= 0.005) parts.push(fill(a.dy > 0 ? ALIGN_TEXT.lower : ALIGN_TEXT.higher, { n: formatPercent(100 * a.dy) }));
  if (shared.x && Math.abs(a.dx) >= 0.005) parts.push(fill(a.dx > 0 ? ALIGN_TEXT.rightOf : ALIGN_TEXT.leftOf, { n: formatPercent(100 * a.dx) }));
  if (Math.abs(a.scale - 1) >= 0.01) parts.push(fill(ALIGN_TEXT.scaled, { s: a.scale.toFixed(2) }));
  if (parts.length === 0) return alignNote('aligned');
  return alignNote('autoAligned', {
    tr: fill(ALIGN_TEXT.autoAligned, { what: parts.map((p) => p.tr).join(', ') }).tr,
    en: fill(ALIGN_TEXT.autoAligned, { what: parts.map((p) => p.en).join(', ') }).en,
  });
}

/** First note, localised (UI convenience). */
export function alignNoteText(view: ViewAlignment, lang: Lang): string {
  return view.notes[0]?.text[lang] ?? '';
}

// ---------------------------------------------------------------------------
// Per-view registration

const IDENTITY: AlignCorrection = { dx: 0, dy: 0, scale: 1, flipX: false };

function bboxFit(view: PreparedView): { x0: number; y0: number; x1: number; y1: number } {
  return { ...view.bbox };
}

/** fitBox interval of one axis from a fit: the front bbox ends through p(f). */
function fitInterval(pair: Pair, logk: number, delta: number): [number, number] {
  const k = Math.exp(logk), s = k * pair.rho, half = pair.ref.extent / 2;
  const a = pair.cv + pair.sign * s * (-half - delta), b = pair.cv + pair.sign * s * (half - delta);
  return a < b ? [a, b] : [b, a];
}

/** Inverse of fitInterval. */
function fitOfInterval(pair: Pair, interval: [number, number]): { logk: number; delta: number } {
  const k = (interval[1] - interval[0]) / (pair.rho * pair.ref.extent);
  const centre = (interval[0] + interval[1]) / 2;
  return { logk: Math.log(Math.max(1e-9, k)), delta: (pair.sign * (pair.cv - centre)) / (k * pair.rho) };
}

/** (ln k, δ) of a manual correction on one axis (inverse of fitInterval through alignedBox). */
function manualFit(pair: Pair, view: PreparedView, a: AlignCorrection, axis: 'x' | 'y'): { logk: number; delta: number } {
  const b = view.bbox, L = Math.max(b.x1 - b.x0, b.y1 - b.y0);
  const shared = SHARED_AXES[view.id];
  const scaled = axis === 'x' ? shared.x : shared.y;
  const k = scaled ? 1 / a.scale : 1;
  const shift = (axis === 'x' ? a.dx : a.dy) * L;
  // Fitted centre c' = cv − shift = cv − sign·k·ρ·δ.
  return { logk: Math.log(k), delta: (pair.sign * shift) / (k * pair.rho) };
}

interface AxisResult {
  fit: AxisFit;
  interval: [number, number];
  cropped: boolean;
  stretched: boolean;
  colorOnly: boolean;
}

/**
 * fitBox interval of one axis. A cut axis without a profile match assumes
 * the cut is real: the uncut end stays, the extent comes from an anchor (the
 * back's complete width through the front's aspect; a side view's crown →
 * neck distance), else the axis is 'stretched' (bbox kept). Cut at both ends
 * → colour only.
 */
function resolveAxis(view: PreparedView, pair: Pair, fit: AxisFit, front: PreparedView, fref: FrontRef, axis: 'rows' | 'cols'): AxisResult {
  const prof = pair.prof;
  let interval = fitInterval(pair, fit.logk, fit.delta);
  // Cropped when the registered box reaches past a cut edge (a silhouette that merely touches it fits inside).
  const reach = (fit.status === 'aligned' ? Math.max(prof.cutLo ? -interval[0] : 0, prof.cutHi ? interval[1] - prof.n : 0) : 0) / (interval[1] - interval[0]);
  let cropped = reach >= ALIGN.CROP_MIN;
  let stretched = false, colorOnly = false;
  if ((prof.cutLo || prof.cutHi) && fit.status !== 'aligned') {
    const bboxExt = prof.hi - prof.lo;
    let ext: number | null = null;
    if (prof.cutLo && prof.cutHi) {
      colorOnly = true;
    } else if (view.id === 'back') {
      const fb = front.bbox, vb = view.bbox;
      const fw = fb.x1 - fb.x0, fh = fb.y1 - fb.y0;
      ext = axis === 'rows' ? ((vb.x1 - vb.x0) * fh) / fw : ((vb.y1 - vb.y0) * fw) / fh;
    } else if ((view.id === 'left' || view.id === 'right') && prof.cutHi && !prof.cutLo) {
      const nf = neckRow(fref.profiles.rows), nv = neckRow(prof);
      if (nf !== null && nv !== null && nv > 2 && nf > 2) {
        const e = (fref.rows.extent * nv) / nf;
        if (e / bboxExt >= 0.5 && e / bboxExt <= 2) ext = e;
      }
    }
    if (!colorOnly) {
      if (ext === null) stretched = true;
      else {
        interval = prof.cutHi ? [prof.lo, prof.lo + ext] : [prof.hi - ext, prof.hi];
        cropped = true;
        // The confidence belongs to the anchored placement, not to the identity the fit fell back to.
        const f = fitOfInterval({ ...pair, censorLo: prof.cutLo, censorHi: prof.cutHi }, interval);
        fit = { ...fit, confidence: confidenceOf(pair.ref, directDescriptor({ ...pair, censorLo: prof.cutLo, censorHi: prof.cutHi }, f.logk, f.delta), pair.twin, fit.status === 'plain') };
      }
    }
  }
  return { fit, interval, cropped, stretched, colorOnly };
}

/** Registration of one view against the front (pure, deterministic). */
export function alignView(front: PreparedView, view: PreparedView, o: Partial<AlignOptions> = {}): ViewAlignment {
  const mode = o.mode ?? 'auto';
  const id = view.id;
  const shared = SHARED_AXES[id];
  const request = view.align ?? DEFAULT_VIEW_ALIGN;
  const manual = request.mode === 'manual';
  const base = (status: AlignStatus, applied: AlignCorrection, suggested: AlignCorrection, confidence: number, fitBox: PixelBox, trust: ViewTrust, notes: AlignNote[]): ViewAlignment => {
    const residual = alignResidual(suggested, applied);
    const score = alignScore({ confidence, residual, cut: view.cut, status, id, maskSource: view.maskSource });
    const ref = frontRef(front);
    return {
      id, status, level: alignLevel(score), score, confidence, applied, suggested, residual,
      cut: { ...view.cut }, fitBox, trust, notes, guides: { rows: ref.rows.guides.slice(), cols: ref.cols.guides.slice() },
    };
  };
  const trustNotes = (trust: ViewTrust, notes: AlignNote[]) => {
    if (trust === 'color') notes.push(alignNote('colorOnly'));
    if (trust === 'off') notes.push(alignNote('off'));
    if (view.maskSource === 'none') notes.push(alignNote('noMask'));
  };
  if (view.maskSource === 'none') {
    const notes: AlignNote[] = [];
    trustNotes(request.trust, notes);
    return base('bbox', IDENTITY, IDENTITY, 0, bboxFit(view), request.trust, notes);
  }
  const fref = frontRef(front);
  const profiles = axisProfiles(view);
  // Pairs along the shared axes.
  const rowsPair = shared.y ? makePair(profiles.rows, fref.rows, 1, id === 'back', false) : null;
  const colsPair = shared.x ? makePair(profiles.cols, fref.cols, id === 'back' ? -1 : 1, id === 'back', false) : null;
  const requested: AlignCorrection = { dx: request.dx, dy: request.dy, scale: request.scale, flipX: request.flipX };

  // Automatic registration (also the suggestion under manual / bbox mode).
  let suggested: AlignCorrection = IDENTITY;
  let status: AlignStatus = 'bbox';
  let fitBox = bboxFit(view);
  let trust: ViewTrust = request.trust;
  const notes: AlignNote[] = [];
  const extraNotes: AlignNote[] = [];
  let confidence = 1;
  if (mode === 'auto') {
    let rows = rowsPair ? fitAxis(rowsPair, LOGK_GRID, true) : null;
    let cols = colsPair ? fitAxis(colsPair, LOGK_GRID, true) : null;
    if (rows && cols && rowsPair && colsPair) {
      // Back: one content scale (the rows'); the columns re-fitted for their offset only — unless an
      // axis is cut, when each keeps its own evidence (see the header).
      const rowsCut = rowsPair.prof.cutLo || rowsPair.prof.cutHi, colsCut = colsPair.prof.cutLo || colsPair.prof.cutHi;
      if (!rowsCut && !colsCut && rows.status === 'aligned' && cols.status === 'aligned' && Math.abs(cols.logk - rows.logk) > ALIGN.ASPECT_WARN) {
        extraNotes.push(alignNote('aspect', fill(ALIGN_TEXT.aspect, { n: formatPercent(100 * Math.abs(Math.exp(cols.logk - rows.logk) - 1)) })));
      }
      if (!rowsCut && !colsCut) {
        const logk = rows.status === 'aligned' ? rows.logk : cols.status === 'aligned' ? cols.logk : 0;
        if (cols.status === 'aligned' && Math.abs(cols.logk - logk) > 1e-9) cols = refitDelta(colsPair, logk, cols);
        if (rows.status === 'aligned' && Math.abs(rows.logk - logk) > 1e-9) rows = refitDelta(rowsPair, logk, rows);
      }
      // Mirrored back: the unmirrored columns fit wins clearly and the front is asymmetric.
      if (cols.status === 'aligned' && fref.cols.asymmetry >= ALIGN.MIRROR_ASYMMETRY) {
        const un = search({ ...colsPair, sign: 1 }, LOGK_GRID, true);
        if (un.st >= cols.st + ALIGN.MIRROR_MARGIN) extraNotes.push(alignNote('mirrored'));
      }
    }
    const ry = rows && rowsPair ? resolveAxis(view, rowsPair, rows, front, fref, 'rows') : null;
    const rx = cols && colsPair ? resolveAxis(view, colsPair, cols, front, fref, 'cols') : null;
    const results = [ry, rx].filter((r): r is AxisResult => !!r);
    if (results.some((r) => r.colorOnly) && trust === 'full') trust = 'color';
    const stretched = results.some((r) => r.stretched);
    const aligned = results.some((r) => r.fit.status === 'aligned');
    const weak = results.some((r) => r.fit.status === 'weak');
    status = stretched ? 'stretched' : aligned ? 'aligned' : weak ? 'weak' : 'plain';
    if (ry) fitBox = { ...fitBox, y0: ry.interval[0], y1: ry.interval[1] };
    if (rx) fitBox = { ...fitBox, x0: rx.interval[0], x1: rx.interval[1] };
    const c = correctionOf(view.bbox, fitBox, shared);
    suggested = { ...c, flipX: request.flipX };
    confidence = Math.min(...results.map((r) => r.fit.confidence));
    if (status === 'aligned') notes.push(statusNote(id, suggested));
    else if (status === 'weak') notes.push(alignNote('weak'));
    else if (status === 'plain') notes.push(alignNote('plain'));
    else notes.push(alignNote('stretched'));
    if (results.some((r) => r.cropped)) {
      if (view.cut.top) notes.push(alignNote('cropped', ALIGN_TEXT.croppedTop));
      if (view.cut.bottom) notes.push(alignNote('cropped', ALIGN_TEXT.croppedBottom));
      if (view.cut.left) notes.push(alignNote('cropped', ALIGN_TEXT.croppedLeft));
      if (view.cut.right) notes.push(alignNote('cropped', ALIGN_TEXT.croppedRight));
    }
    notes.push(...extraNotes);
  } else {
    // Bbox mode: confidence at the identity, no search.
    const confs: number[] = [];
    if (rowsPair) confs.push(confidenceOf(fref.rows, directDescriptor(rowsPair, 0, 0), rowsPair.twin, fref.rows.structure < ALIGN.STRUCTURE_MIN));
    if (colsPair) confs.push(confidenceOf(fref.cols, directDescriptor(colsPair, 0, 0), colsPair.twin, fref.cols.structure < ALIGN.STRUCTURE_MIN));
    confidence = confs.length ? Math.min(...confs) : 1;
    notes.push(alignNote('aligned'));
  }
  let applied: AlignCorrection = mode === 'auto' ? suggested : { ...IDENTITY, flipX: request.flipX };
  if (manual) {
    applied = requested;
    status = 'manual';
    fitBox = alignedBox(view.bbox, applied, shared);
    const confs: number[] = [];
    if (rowsPair) {
      const f = manualFit(rowsPair, view, applied, 'y');
      confs.push(confidenceOf(fref.rows, directDescriptor(rowsPair, f.logk, f.delta), rowsPair.twin, fref.rows.structure < ALIGN.STRUCTURE_MIN));
    }
    if (colsPair) {
      const f = manualFit(colsPair, view, applied, 'x');
      confs.push(confidenceOf(fref.cols, directDescriptor(colsPair, f.logk, f.delta), colsPair.twin, fref.cols.structure < ALIGN.STRUCTURE_MIN));
    }
    confidence = confs.length ? Math.min(...confs) : 1;
    // Manual placement never demotes; the suggestion's cut handling is informative only.
    trust = request.trust;
  }
  if (id === 'left' || id === 'right') notes.push(alignNote('sideBlind'));
  trustNotes(trust, notes);
  return base(status, applied, suggested, confidence, fitBox, trust, notes);
}

/** Re-fit the offset of an axis at a fixed scale (the back's columns at the rows' scale). */
function refitDelta(pair: Pair, logk: number, prev: AxisFit): AxisFit {
  const w = pair.twin ? ALIGN.W_TWIN : ALIGN.W_SHARED;
  const variant = prev.censored ? { ...pair, censorLo: pair.prof.cutLo, censorHi: pair.prof.cutHi } : pair;
  const r = search(variant, [logk], false);
  const desc = directDescriptor(variant, logk, r.delta);
  return {
    ...prev, logk, delta: r.delta, st: r.st, prominence: r.prominence,
    s: similarity(pair.ref, desc, 0, 1, w, 0).s, confidence: confidenceOf(pair.ref, desc, pair.twin, false), desc,
  };
}

/**
 * Register every view against the front (first in `views`): sets fitBox,
 * registration and trust in place and returns the alignments in `views`
 * order. The front gets status 'bbox', score 100.
 */
export function registerViews(views: PreparedView[], o: AlignOptions): ViewAlignment[] {
  const front = views.find((v) => v.id === 'front');
  if (!front) throw new Error('registerViews: the front view is required');
  const fref = frontRef(front);
  return views.map((view) => {
    if (view.id === 'front') {
      view.fitBox = bboxFit(view);
      view.registration = 'bbox';
      view.trust = 'full';
      const notes: AlignNote[] = [];
      if (view.maskSource === 'none') notes.push(alignNote('noMask'));
      return {
        id: 'front', status: 'bbox', level: 'good', score: 100, confidence: 1, applied: IDENTITY, suggested: IDENTITY,
        residual: { dx: 0, dy: 0, scale: 1 }, cut: { ...view.cut }, fitBox: bboxFit(view), trust: 'full', notes,
        guides: { rows: fref.rows.guides.slice(), cols: fref.cols.guides.slice() },
      };
    }
    const a = alignView(front, view, o);
    view.fitBox = { ...a.fitBox };
    view.registration = a.status;
    view.trust = a.trust;
    return a;
  });
}
