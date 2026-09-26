/**
 * Landmark-guided depth refinement for people. A monocular depth model run
 * on the whole image sees a face at a few dozen pixels, so noses, lips, eye
 * sockets, ears and fingers come out flat. Two passes fix that:
 *
 *  (a) High-res crops (optional, `refineCrop`): each face / hand box,
 *      expanded by 35 %, is re-estimated by the depth model at its native
 *      input size, aligned to the global depth by a robust scale + offset
 *      fit (mask-aware, outlier-trimmed) and blended back with a feathered
 *      box weight.
 *  (b) Landmark priors (prior.ts): each relief field is split into detail
 *      bands (field − low-pass, low-pass computed inside the field only) and
 *      converted from pixels to depth units at the mesh's reference depth
 *      scale, so relief keeps human proportions. Only the missing part is
 *      added: per band, the amount k already present in the current depth
 *      (least-squares projection of its own band onto the prior's) is
 *      subtracted from the strength, so a model that already resolves the
 *      nose is left alone and a flat face gets the full relief.
 *
 * Only foreground pixels (mask = 1) change. Values stay in [0, 1]: if the
 * added relief overshoots 1, the foreground is rescaled linearly into range.
 * Missing detections leave the depth untouched (the same object is returned).
 */
import { blurFloat, resizeFloat, resizeMask, resizeRGBA } from '../image/ops';
import { DEFAULT_MESH_OPTIONS } from '../mesh/options';
import { throwIfAborted, type DepthMap, type I18nText, type Mask, type RGBAImage } from '../types';
import { yieldToPaint } from '../yield';
import { boxFeather, fitAffine } from './align';
import { bodyRelief, faceReliefs, handRelief, type ReliefField } from './prior';
import { cropRGBA } from './raster';
import type { Box, HumanAnalysis, HumanDetailOptions, Landmark } from './types';

/**
 * Depth units ↔ pixels: the mesh builder displaces d·depthScale·(longest
 * side), so at the default depth scale a relief of p pixels is
 * p / (longest side · REFERENCE_DEPTH_SCALE) in depth units.
 */
export const REFERENCE_DEPTH_SCALE = DEFAULT_MESH_OPTIONS.depthScale;

/** Faces / hands smaller than this (longest box side, px) are skipped. */
export const MIN_DETAIL_SIDE = 24;
/** Crop box margin per side, as a fraction of the landmark box's longest side. */
export const CROP_MARGIN = 0.35;
/** A crop is only worth an inference if it raises the resolution by this factor over the global pass. */
const MIN_CROP_GAIN = 1.5;
const DEFAULT_MAX_CROPS = 6;
const DEFAULT_BODY_STRENGTH = 0.3;

const TEXT = {
  relief: { tr: 'Yüz ve el kabartması ekleniyor…', en: 'Adding face and hand relief…' },
} satisfies Record<string, I18nText>;

function cropLabel(kind: 'face' | 'hand', i: number, n: number): I18nText {
  return kind === 'face'
    ? { tr: `Yüz ayrıntısı: yüksek çözünürlüklü geçiş (${i}/${n})…`, en: `Face detail: high-res pass (${i}/${n})…` }
    : { tr: `El ayrıntısı: yüksek çözünürlüklü geçiş (${i}/${n})…`, en: `Hand detail: high-res pass (${i}/${n})…` };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const clampStrength = (v: number | undefined, fallback: number) => (Number.isFinite(v) ? Math.min(1.5, Math.max(0, v as number)) : fallback);

/** The analysis in another pixel grid (landmark z scales with x). */
export function scaleAnalysis(a: HumanAnalysis, width: number, height: number): HumanAnalysis {
  if (a.width === width && a.height === height) return a;
  const sx = width / Math.max(1, a.width), sy = height / Math.max(1, a.height);
  const L = (l: Landmark): Landmark => ({ ...l, x: l.x * sx, y: l.y * sy, z: l.z * sx });
  const B = (b: Box): Box => ({ x: b.x * sx, y: b.y * sy, width: b.width * sx, height: b.height * sy });
  return {
    ...a,
    width,
    height,
    faces: a.faces.map((f) => ({ ...f, landmarks: f.landmarks.map(L), box: B(f.box) })),
    hands: a.hands.map((h) => ({ ...h, landmarks: h.landmarks.map(L), box: B(h.box) })),
    poses: a.poses.map((p) => ({ ...p, landmarks: p.landmarks.map(L), box: B(p.box) })),
  };
}

export interface CropJob {
  kind: 'face' | 'hand';
  /** Integer pixel box (expanded, clamped). */
  box: Box;
  /** Feather width (px) of the blend towards the box edges. */
  feather: number;
  open: { left: boolean; right: boolean; top: boolean; bottom: boolean };
}

/**
 * Crop boxes worth a high-res pass: faces first, then hands, largest first, at
 * most `maxCrops`. `sideRatio` = crop inference side / global inference side
 * (default 1).
 */
export function planCrops(a: HumanAnalysis, opts: { maxCrops: number; faces: boolean; hands: boolean; sideRatio?: number }): CropJob[] {
  const { width: W, height: H } = a;
  const sideRatio = opts.sideRatio !== undefined && opts.sideRatio > 0 && Number.isFinite(opts.sideRatio) ? opts.sideRatio : 1;
  const jobs: (CropJob & { area: number; rank: number })[] = [];
  const add = (kind: 'face' | 'hand', b: Box, rank: number) => {
    const side = Math.max(b.width, b.height);
    if (!(side >= MIN_DETAIL_SIDE)) return;
    const m = CROP_MARGIN * side;
    const x0 = Math.max(0, Math.floor(b.x - m)), y0 = Math.max(0, Math.floor(b.y - m));
    const x1 = Math.min(W, Math.ceil(b.x + b.width + m)), y1 = Math.min(H, Math.ceil(b.y + b.height + m));
    const w = x1 - x0, h = y1 - y0;
    if (w < MIN_DETAIL_SIDE || h < MIN_DETAIL_SIDE) return;
    // Model input budgets scale as side² (square-equivalent), so the resolution
    // gain over the global pass = (crop side / global side) · sqrt(area ratio).
    if (sideRatio * Math.sqrt((W * H) / (w * h)) < MIN_CROP_GAIN) return;
    jobs.push({
      kind,
      box: { x: x0, y: y0, width: w, height: h },
      feather: Math.max(2, m),
      open: { left: x0 === 0, top: y0 === 0, right: x1 === W, bottom: y1 === H },
      area: w * h,
      rank,
    });
  };
  if (opts.faces) for (const f of a.faces) add('face', f.box, 0);
  if (opts.hands) for (const h of a.hands) add('hand', h.box, 1);
  jobs.sort((p, q) => p.rank - q.rank || q.area - p.area);
  return jobs.slice(0, Math.max(0, opts.maxCrops)).map(({ kind, box, feather, open }) => ({ kind, box, feather, open }));
}

/** Blend one re-estimated crop into `out` (aligned by a robust affine fit). Returns false when the crop could not be aligned. */
export function blendCrop(out: Float32Array, W: number, mask: Mask | null, job: CropJob, crop: DepthMap): boolean {
  const { x: bx, y: by, width: bw, height: bh } = job.box;
  const cd = crop.width === bw && crop.height === bh ? crop.data : resizeFloat(crop.data, crop.width, crop.height, bw, bh);
  const target = new Float32Array(bw * bh);
  const weight = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const g = (by + y) * W + bx + x;
      target[y * bw + x] = out[g];
      weight[y * bw + x] = mask ? mask.data[g] : 1;
    }
  }
  const fit = fitAffine(cd, target, weight);
  if (!fit || !(fit.scale > 0)) return false;
  const fw = boxFeather(bw, bh, job.feather, job.open);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = y * bw + x;
      if (!weight[i]) continue;
      const g = (by + y) * W + bx + x;
      out[g] += fw[i] * (fit.scale * cd[i] + fit.offset - out[g]);
    }
  }
  return true;
}

/** Zero `field`'s weight where any of `occluders` covers it (hands in front of a face). */
export function occlude(field: ReliefField, occluders: ReliefField[]): void {
  for (const o of occluders) {
    const x0 = Math.max(field.x0, o.x0), x1 = Math.min(field.x0 + field.width, o.x0 + o.width);
    const y0 = Math.max(field.y0, o.y0), y1 = Math.min(field.y0 + field.height, o.y0 + o.height);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const w = o.weight[(y - o.y0) * o.width + (x - o.x0)];
        if (w > 0) field.weight[(y - field.y0) * field.width + (x - field.x0)] *= 1 - Math.min(1, w);
      }
    }
  }
}

/**
 * Normalised convolution with soft weights (≈ Gaussian, 3 box passes):
 * blur(v·w) / blur(w). Using the feathered field weight instead of a binary
 * coverage keeps the low-pass smooth where the coverage edge is jagged.
 */
function softBlur(v: Float32Array, wgt: Float32Array, w: number, h: number, radius: number): Float32Array {
  const vw = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) vw[i] = v[i] * wgt[i];
  const num = blurFloat(vw, w, h, radius, 3, null);
  const den = blurFloat(wgt, w, h, radius, 3, null);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = den[i] > 1e-6 ? num[i] / den[i] : v[i];
  return out;
}

/**
 * Smooth surface through the field's rim values (a cheap membrane): rim
 * samples (covered pixels in the feather zone, outermost weighted most)
 * spread inwards by normalised convolution at growing scales, blended so the
 * fine scale rules near the rim and coarser ones fill the interior. Across a
 * limb it is the height of its outline; over a face, its oval.
 */
function membrane(v: Float32Array, rim: Float32Array, w: number, h: number, radius: number): Float32Array {
  const n = v.length;
  const vr = new Float32Array(n);
  for (let i = 0; i < n; i++) vr[i] = v[i] * rim[i];
  const num = new Float64Array(n), den = new Float64Array(n);
  let rad = Math.max(1, radius), mix = 1;
  for (let s = 0; s < 4; s++, rad *= 3, mix *= 0.05) {
    const a = blurFloat(vr, w, h, rad, 3, null), b = blurFloat(rim, w, h, rad, 3, null);
    for (let i = 0; i < n; i++) { num[i] += mix * a[i]; den[i] += mix * b[i]; }
  }
  let gn = 0, gd = 0;
  for (let i = 0; i < n; i++) { gn += vr[i]; gd += rim[i]; }
  const fallback = gd > 0 ? gn / gd : 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = den[i] > 1e-9 ? num[i] / den[i] : fallback;
  return out;
}

/**
 * Add a relief field's missing detail to `out` (depth units = px · toDepth).
 * Detail comes in stages: band-passes at field.bands (fine → coarse), then
 * what remains relative to the rim membrane (the field bulging towards the
 * viewer from its own outline: no groove along the outline). Per stage only
 * max(0, strength − k) is added, k being the share the depth already has.
 * Returns true when anything was added.
 */
export function applyField(out: Float32Array, W: number, mask: Mask | null, field: ReliefField, strength: number, toDepth: number): boolean {
  if (!(strength > 0)) return false;
  const { x0, y0, width: w, height: h } = field;
  const n = w * h;
  const cov = new Uint8Array(n);
  const wgt = new Float32Array(n);
  const rim = new Float32Array(n);
  const d = new Float32Array(n);
  const r = new Float32Array(n);
  let count = 0, rimCount = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const g = (y0 + y) * W + x0 + x;
      d[i] = out[g];
      r[i] = field.relief[i] * toDepth;
      if (field.weight[i] > 0 && (!mask || mask.data[g])) {
        cov[i] = 1;
        wgt[i] = field.weight[i];
        count++;
        if (wgt[i] < 0.5) { rim[i] = 1 - wgt[i]; rimCount++; }
      }
    }
  }
  if (count < 16) return false;
  const delta = new Float32Array(n);
  let added = false;
  const stage = (detR: Float32Array, detD: Float32Array) => {
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      if (!cov[i]) continue;
      num += wgt[i] * detD[i] * detR[i];
      den += wgt[i] * detR[i] * detR[i];
    }
    if (!(den > 1e-12)) return;
    const add = strength - Math.max(0, num / den);
    if (add <= 0) return;
    for (let i = 0; i < n; i++) if (cov[i]) delta[i] += add * detR[i];
    added = true;
  };
  const minus = (a: Float32Array, b: Float32Array) => a.map((v, i) => v - b[i]);
  let prevR: Float32Array = r, prevD: Float32Array = d;
  for (const radius of field.bands) {
    const lowR = softBlur(prevR, wgt, w, h, radius);
    const lowD = softBlur(prevD, wgt, w, h, radius);
    stage(minus(prevR, lowR), minus(prevD, lowD));
    prevR = lowR;
    prevD = lowD;
  }
  if (field.rimRadius > 0 && rimCount >= 4) {
    stage(minus(prevR, membrane(prevR, rim, w, h, field.rimRadius)), minus(prevD, membrane(prevD, rim, w, h, field.rimRadius)));
  }
  if (!added) return false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (cov[i]) out[(y0 + y) * W + x0 + x] += wgt[i] * delta[i];
    }
  }
  return true;
}

/** Keep the foreground in [0, 1]: rescale [min, max] → [min, 1] on overshoot, then clamp. */
export function fitRange(out: Float32Array, mask: Mask | null): void {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < out.length; i++) {
    if (mask && !mask.data[i]) continue;
    if (out[i] < lo) lo = out[i];
    if (out[i] > hi) hi = out[i];
  }
  if (!(hi > lo)) return;
  const s = hi > 1 ? (1 - Math.max(0, lo)) / (hi - Math.max(0, lo)) : 1;
  const base = Math.max(0, lo);
  for (let i = 0; i < out.length; i++) {
    if (mask && !mask.data[i]) continue;
    const v = s === 1 ? out[i] : base + (out[i] - base) * s;
    out[i] = Math.min(1, Math.max(0, v));
  }
}

export async function enhanceHumanDepth(
  depth: DepthMap,
  mask: Mask | null,
  image: RGBAImage,
  analysis: HumanAnalysis,
  opts: HumanDetailOptions,
): Promise<DepthMap> {
  const { signal, onProgress } = opts;
  throwIfAborted(signal);
  const W = depth.width, H = depth.height;
  const faceStrength = clampStrength(opts.faceStrength, 0);
  const handStrength = clampStrength(opts.handStrength, 0);
  const bodyStrength = clampStrength(opts.bodyStrength, DEFAULT_BODY_STRENGTH);
  const a = scaleAnalysis(analysis, W, H);
  const faces = faceStrength > 0 ? a.faces.filter((f) => Math.max(f.box.width, f.box.height) >= MIN_DETAIL_SIDE) : [];
  const hands = handStrength > 0 ? a.hands.filter((h) => Math.max(h.box.width, h.box.height) >= MIN_DETAIL_SIDE) : [];
  const poses = bodyStrength > 0 ? a.poses : [];
  if (faces.length === 0 && hands.length === 0 && poses.length === 0) return depth;

  const m = mask && (mask.width !== W || mask.height !== H) ? resizeMask(mask, W, H) : mask;
  const img = image.width !== W || image.height !== H ? resizeRGBA(image, W, H) : image;
  const out = depth.data.slice();
  let changed = false;

  // (a) High-res crop pass.
  if (opts.refineCrop) {
    const jobs = planCrops({ ...a, faces, hands }, { maxCrops: opts.maxCrops ?? DEFAULT_MAX_CROPS, faces: true, hands: true, sideRatio: opts.cropSideRatio });
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      onProgress?.({ label: cropLabel(job.kind, i + 1, jobs.length), ratio: i / jobs.length });
      const crop = await opts.refineCrop(cropRGBA(img, job.box), signal);
      throwIfAborted(signal);
      if (blendCrop(out, W, m, job, crop)) changed = true;
    }
  }

  // (b) Landmark priors: body (lowest), faces (minus hands in front), hands.
  onProgress?.({ label: TEXT.relief });
  await yieldToPaint();
  throwIfAborted(signal);
  const nonNull = <T>(v: T | null): v is T => v !== null;
  const toDepth = 1 / (Math.max(W, H) * REFERENCE_DEPTH_SCALE);
  const bodyFields = poses.map((p) => bodyRelief(p, W, H)).filter(nonNull);
  const handFields = hands.map((h) => handRelief(h, W, H)).filter(nonNull);
  const faceFields = faces.flatMap((f) => faceReliefs(f, W, H, { image: img }));
  for (const f of faceFields) occlude(f, handFields);
  const steps: [ReliefField, number][] = [
    ...bodyFields.map((f): [ReliefField, number] => [f, bodyStrength]),
    ...faceFields.map((f): [ReliefField, number] => [f, faceStrength]),
    ...handFields.map((f): [ReliefField, number] => [f, handStrength]),
  ];
  let slice = now();
  for (const [f, strength] of steps) {
    // Large fields (a full-body pose) take a while: let the page paint / take a Cancel between them.
    if (now() - slice > 50) {
      await yieldToPaint();
      throwIfAborted(signal);
      slice = now();
    }
    if (applyField(out, W, m, f, strength, toDepth)) changed = true;
  }
  if (!changed) return depth;
  fitRange(out, m);
  return { width: W, height: H, data: out };
}
