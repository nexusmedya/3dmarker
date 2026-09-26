/**
 * Landmark geometric priors (pure): relief height fields rasterised from the
 * face / hand / body landmarks, in image pixels.
 *
 *  - Face: the 852-triangle MediaPipe face mesh with per-landmark height
 *    (-z), the eye and mouth openings filled (iris depth / slight recess);
 *    ears as separate blobs beside landmarks 234 / 454 (helix rim + concha,
 *    faded by head yaw and by how skin-like the pixels are).
 *  - Hand: tapered capsules along the finger bones (radius from the palm
 *    size) over a domed palm; webbing gaps inside the hand's hull sit behind.
 *  - Body: capsules along the limbs and a domed torso (low weight).
 *
 * enhance.ts turns the fields into depth detail (band-pass, top-up only).
 */
import { blurFloat } from '../image/ops';
import type { RGBAImage } from '../types';
import {
  convexHull,
  coverage,
  domeProfile,
  featherWeights,
  heightBuffer,
  insidePolygon,
  rasterFan,
  rasterTriangle,
  regionAround,
  smoothstep,
  stampCapsule,
  stampEllipse,
  type P3,
  type Region,
} from './raster';
import { CHEEK_POINTS, FACE, FACE_TRIANGLES, FINGERS, INNER_LIPS_LOOP, LEFT_EYE_LOOP, PALM, RIGHT_EYE_LOOP } from './topology';
import { POSE, type FaceResult, type HandResult, type Landmark, type PoseResult } from './types';

export interface ReliefField extends Region {
  kind: 'face' | 'hand' | 'body';
  /** Height in image pixels above the field's farthest covered point (larger = nearer); 0 where uncovered. */
  relief: Float32Array;
  /** Feathered coverage in [0, 1]. */
  weight: Float32Array;
  /** Band-pass detail radii (px), fine to coarse (see enhance.ts applyField). */
  bands: number[];
  /**
   * Scale (px) of the rim membrane the remaining relief is measured from:
   * the field bulges towards the viewer from its own outline (0 = no rim stage).
   */
  rimRadius: number;
  /** Largest relief value (px). */
  span: number;
  /** Characteristic size (px): face height, palm length or shoulder width. */
  size: number;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const finite = (p: Landmark | undefined): p is Landmark => !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

/** Relief scaled to [0, 1] and multiplied by the feathered weight. */
export function unitRelief(field: ReliefField): Float32Array {
  const out = new Float32Array(field.relief.length);
  const s = field.span > 0 ? 1 / field.span : 0;
  for (let i = 0; i < out.length; i++) out[i] = field.relief[i] * s * field.weight[i];
  return out;
}

/** Relief value at an image pixel (0 outside the field). */
export function reliefAt(field: ReliefField, x: number, y: number, unit = false): number {
  const lx = Math.floor(x) - field.x0, ly = Math.floor(y) - field.y0;
  if (lx < 0 || ly < 0 || lx >= field.width || ly >= field.height) return 0;
  const i = ly * field.width + lx;
  return unit ? (field.span > 0 ? (field.relief[i] / field.span) * field.weight[i] : 0) : field.relief[i];
}

/** Shared tail: coverage → relative heights, feathered weight (× optional per-pixel factor). */
function finish(
  kind: ReliefField['kind'],
  r: Region,
  buf: Float32Array,
  imgW: number,
  imgH: number,
  feather: number,
  bands: number[],
  size: number,
  rimRadius: number,
  factor?: Float32Array,
  smooth = 0,
): ReliefField | null {
  const cov = coverage(buf, r);
  let count = 0, base = Infinity;
  for (let i = 0; i < buf.length; i++) {
    if (!cov.data[i]) continue;
    count++;
    if (buf[i] < base) base = buf[i];
  }
  if (count < 8) return null;
  let relief: Float32Array = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) if (cov.data[i]) relief[i] = buf[i] - base;
  // Piecewise-linear triangles shade as facets: soften them (inside the coverage only).
  if (smooth >= 0.5) relief = blurFloat(relief, r.width, r.height, smooth, 2, cov);
  let span = 0;
  for (let i = 0; i < buf.length; i++) if (cov.data[i] && relief[i] > span) span = relief[i];
  const weight = featherWeights(cov, feather, {
    left: r.x0 === 0,
    top: r.y0 === 0,
    right: r.x0 + r.width === imgW,
    bottom: r.y0 + r.height === imgH,
  });
  if (factor) for (let i = 0; i < weight.length; i++) weight[i] *= factor[i];
  return { kind, ...r, relief, weight, bands, rimRadius, span, size };
}

// ---------------------------------------------------------------------------
// Face

export interface FaceReliefOptions {
  /** The analysed image: ear blobs are only kept on skin-coloured pixels (not checked without it). */
  image?: RGBAImage | null;
  /** faceReliefs(): add ears beside the face outline (default true). */
  ears?: boolean;
}

/** Mean colour around the cheek landmarks, as normalised chromaticity + luminance. */
function skinReference(image: RGBAImage, L: Landmark[]): { r: number; g: number; l: number } | null {
  let sr = 0, sg = 0, sl = 0, n = 0;
  for (const idx of CHEEK_POINTS) {
    const p = L[idx];
    if (!p) continue;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = Math.floor(p.x) + dx, y = Math.floor(p.y) + dy;
        if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
        const o = (y * image.width + x) * 4;
        if (image.data[o + 3] < 128) continue;
        const R = image.data[o], G = image.data[o + 1], B = image.data[o + 2];
        const s = R + G + B + 1e-3;
        sr += R / s; sg += G / s; sl += (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255; n++;
      }
    }
  }
  return n > 0 ? { r: sr / n, g: sg / n, l: sl / n } : null;
}

/** 0..1 skin likeness of an image pixel against the reference (chromaticity first, loose on brightness). */
function skinLikeness(image: RGBAImage, x: number, y: number, ref: { r: number; g: number; l: number }): number {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return 0;
  const o = (y * image.width + x) * 4;
  if (image.data[o + 3] < 128) return 0;
  const R = image.data[o], G = image.data[o + 1], B = image.data[o + 2];
  const s = R + G + B + 1e-3;
  const dc = Math.hypot(R / s - ref.r, G / s - ref.g);
  const dl = Math.log((((0.2126 * R + 0.7152 * G + 0.0722 * B) / 255) + 0.03) / (ref.l + 0.03));
  const like = Math.exp(-((dc / 0.035) ** 2)) * Math.exp(-((dl / 0.6) ** 2));
  return smoothstep(0.15, 0.5, like);
}

/** Ear cross-profile at normalised radius ρ: raised helix rim, hollow concha. */
export function earProfile(rho: number): number {
  return 0.8 * Math.exp(-(((rho - 0.78) / 0.13) ** 2)) - 0.4 * Math.exp(-((rho / 0.4) ** 2));
}

export function faceRelief(face: FaceResult, width: number, height: number): ReliefField | null {
  const L = face.landmarks;
  if (L.length < 468) return null;
  for (let i = 0; i < 468; i++) if (!finite(L[i])) return null;
  const faceH = dist(L[FACE.forehead], L[FACE.chin]);
  const faceW = dist(L[FACE.rightSide], L[FACE.leftSide]);
  const size = Math.max(faceH, faceW);
  if (!(size >= 8)) return null;

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < 468; i++) {
    x0 = Math.min(x0, L[i].x); y0 = Math.min(y0, L[i].y);
    x1 = Math.max(x1, L[i].x); y1 = Math.max(y1, L[i].y);
  }
  const r = regionAround(x0, y0, x1, y1, 0.3 * size, width, height);
  if (!r) return null;
  const P = (i: number): P3 => ({ x: L[i].x, y: L[i].y, h: -L[i].z });
  const buf = heightBuffer(r);
  for (let t = 0; t < FACE_TRIANGLES.length; t += 3) rasterTriangle(r, buf, P(FACE_TRIANGLES[t]), P(FACE_TRIANGLES[t + 1]), P(FACE_TRIANGLES[t + 2]));

  // Eye openings: the iris centre gives the eyeball depth; mouth opening: slightly recessed.
  const mean = (loop: readonly number[]): P3 => {
    let x = 0, y = 0, h = 0;
    for (const i of loop) { x += L[i].x; y += L[i].y; h -= L[i].z; }
    return { x: x / loop.length, y: y / loop.length, h: h / loop.length };
  };
  const eyes: [readonly number[], number][] = [[RIGHT_EYE_LOOP, FACE.rightIris], [LEFT_EYE_LOOP, FACE.leftIris]];
  for (const [loop, iris] of eyes) {
    const c = mean(loop);
    if (finite(L[iris])) c.h = Math.min(-L[iris].z, c.h + 0.02 * size);
    rasterFan(r, buf, loop.map(P), c);
  }
  const mouth = mean(INNER_LIPS_LOOP);
  mouth.h -= 0.03 * size;
  rasterFan(r, buf, INNER_LIPS_LOOP.map(P), mouth);

  return finish('face', r, buf, width, height, Math.max(1.5, 0.06 * size), [0.07 * size], size, 0.2 * size, undefined, 0.012 * size);
}

/**
 * Ear blobs beside the face outline (landmarks 234 / 454), as separate fields
 * so only their own structure is added (rim up, concha down), never a shift
 * relative to the face. Faded out as the head turns that ear away, and — with
 * `image` — kept only on skin-coloured pixels (hair over the ears stays flat).
 */
export function earReliefs(face: FaceResult, width: number, height: number, opts: FaceReliefOptions = {}): ReliefField[] {
  const L = face.landmarks;
  if (L.length < 468) return [];
  const ids = [FACE.forehead, FACE.chin, FACE.rightSide, FACE.leftSide, FACE.noseTip];
  if (!ids.every((i) => finite(L[i]))) return [];
  const faceH = dist(L[FACE.forehead], L[FACE.chin]);
  const faceW = dist(L[FACE.rightSide], L[FACE.leftSide]);
  const earH = 0.3 * faceH, earW = 0.5 * earH;
  if (!(earH >= 8) || !(faceW > 0)) return [];
  const up = { x: L[FACE.forehead].x - L[FACE.chin].x, y: L[FACE.forehead].y - L[FACE.chin].y };
  const ul = Math.hypot(up.x, up.y) || 1;
  up.x /= ul; up.y /= ul;
  const mid = { x: (L[FACE.rightSide].x + L[FACE.leftSide].x) / 2, y: (L[FACE.rightSide].y + L[FACE.leftSide].y) / 2 };
  const nose = L[FACE.noseTip];
  // Head yaw from the outline points' depth: beyond ~40° the frontal ear placement no longer holds.
  const yaw = Math.abs(Math.atan2(L[FACE.leftSide].z - L[FACE.rightSide].z, L[FACE.leftSide].x - L[FACE.rightSide].x));
  if (yaw > (40 * Math.PI) / 180 && yaw < (140 * Math.PI) / 180) return [];
  const ref = opts.image ? skinReference(opts.image, L) : null;
  if (opts.image && !ref) return [];
  const fields: ReliefField[] = [];
  for (const side of [FACE.rightSide, FACE.leftSide]) {
    const s = L[side];
    const v = { x: s.x - mid.x, y: s.y - mid.y };
    const along = v.x * up.x + v.y * up.y;
    const out = { x: v.x - along * up.x, y: v.y - along * up.y };
    const ol = Math.hypot(out.x, out.y);
    if (ol < 1e-6) continue;
    out.x /= ol; out.y /= ol;
    // Yaw: this side's outline point closes in on the nose when the head turns away.
    const vis = smoothstep(0.35, 0.75, dist(s, nose) / (0.5 * faceW));
    if (vis <= 0.02) continue;
    const c = { x: s.x + out.x * 0.5 * earW - up.x * 0.05 * earH, y: s.y + out.y * 0.5 * earW - up.y * 0.05 * earH };
    const ext = earH / 2;
    const r = regionAround(c.x - ext, c.y - ext, c.x + ext, c.y + ext, 2, width, height);
    if (!r) continue;
    const buf = heightBuffer(r);
    const cover = new Float32Array(buf.length);
    const base = -s.z, amp = 0.1 * earH * vis;
    stampEllipse(r, buf, c, out, earW / 2, earH / 2, (_u, _v, rho) => base + amp * earProfile(rho), cover, (rho) => vis * (1 - smoothstep(0.75, 1, rho)));
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === -Infinity) continue;
      let w = cover[i];
      if (opts.image && ref) w *= skinLikeness(opts.image, r.x0 + (i % r.width), r.y0 + Math.floor(i / r.width), ref);
      if (w <= 0.01) buf[i] = -Infinity;
      cover[i] = w;
    }
    const f = finish('face', r, buf, width, height, Math.max(1, 0.1 * earW), [], earH, 0.25 * earH, cover);
    if (f) fields.push(f);
  }
  return fields;
}

/** Face mesh relief plus ears (unless `opts.ears` is false). */
export function faceReliefs(face: FaceResult, width: number, height: number, opts: FaceReliefOptions = {}): ReliefField[] {
  const f = faceRelief(face, width, height);
  const out = f ? [f] : [];
  if (opts.ears !== false) out.push(...earReliefs(face, width, height, opts));
  return out;
}

// ---------------------------------------------------------------------------
// Hand

/** Finger radius at the knuckle as a fraction of the palm length (thumb, index, middle, ring, pinky). */
export const FINGER_RADIUS = [0.12, 0.1, 0.1, 0.095, 0.085];
/** Radius taper along each finger chain (knuckle → tip). */
const TAPER = [1, 0.9, 0.82, 0.75];

/** Palm length (wrist → middle knuckle) using z too, so foreshortened hands keep realistic finger widths. */
export function palmLength(L: Landmark[]): number {
  const a = L[0], b = L[9];
  const d3 = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  return Number.isFinite(d3) ? d3 : dist(a, b);
}

export function handRelief(hand: HandResult, width: number, height: number): ReliefField | null {
  const L = hand.landmarks;
  if (L.length < 21) return null;
  for (let i = 0; i < 21; i++) if (!finite(L[i])) return null;
  const palm = palmLength(L);
  if (!(palm >= 6)) return null;
  const r0 = 0.1 * palm;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < 21; i++) {
    x0 = Math.min(x0, L[i].x); y0 = Math.min(y0, L[i].y);
    x1 = Math.max(x1, L[i].x); y1 = Math.max(y1, L[i].y);
  }
  const r = regionAround(x0, y0, x1, y1, 0.35 * palm, width, height);
  if (!r) return null;
  const P = (i: number): P3 => ({ x: L[i].x, y: L[i].y, h: -L[i].z });
  const buf = heightBuffer(r);

  // Palm: plane through its outline, domed, with rounded edges.
  const palmBuf = heightBuffer(r);
  const outline = PALM.map(P);
  const c = outline.reduce((s, p) => ({ x: s.x + p.x / outline.length, y: s.y + p.y / outline.length, h: s.h + p.h / outline.length }), { x: 0, y: 0, h: 0 });
  rasterFan(r, palmBuf, outline, c);
  const dome = domeProfile(coverage(palmBuf, r));
  for (let i = 0; i < buf.length; i++) if (palmBuf[i] > -Infinity) buf[i] = Math.max(buf[i], palmBuf[i] + 0.12 * palm * dome[i]);
  for (let i = 0; i < outline.length; i++) stampCapsule(r, buf, outline[i], outline[(i + 1) % outline.length], 0.08 * palm, 0.08 * palm);

  // Fingers (the thumb chain starts at its CMC joint; wrist → CMC is the thumb's fleshy base).
  stampCapsule(r, buf, P(0), P(1), 0.13 * palm, FINGER_RADIUS[0] * palm);
  FINGERS.forEach((chain, f) => {
    for (let j = 0; j + 1 < chain.length; j++) {
      stampCapsule(r, buf, P(chain[j]), P(chain[j + 1]), FINGER_RADIUS[f] * TAPER[j] * palm, FINGER_RADIUS[f] * TAPER[j + 1] * palm);
    }
  });

  // Webbing gaps between spread fingers lie behind the hand.
  const hull = convexHull(L.slice(0, 21).map((p) => ({ x: p.x, y: p.y })));
  let minH = Infinity;
  for (let i = 0; i < 21; i++) minH = Math.min(minH, -L[i].z);
  const factor = new Float32Array(buf.length).fill(1);
  if (hull.length >= 3) {
    for (let y = 0; y < r.height; y++) {
      for (let x = 0; x < r.width; x++) {
        const i = y * r.width + x;
        if (buf[i] > -Infinity || !insidePolygon(r.x0 + x + 0.5, r.y0 + y + 0.5, hull)) continue;
        buf[i] = minH - r0;
        factor[i] = 0.6;
      }
    }
  }
  return finish('hand', r, buf, width, height, Math.max(1, 0.35 * r0), [], palm, 1.2 * r0, factor);
}

// ---------------------------------------------------------------------------
// Body

/** Limb capsules: [from, to, radius at from, radius at to] (radii × shoulder width). */
const LIMBS: [number, number, number, number][] = [
  [POSE.leftShoulder, POSE.leftElbow, 0.13, 0.11],
  [POSE.leftElbow, POSE.leftWrist, 0.11, 0.08],
  [POSE.rightShoulder, POSE.rightElbow, 0.13, 0.11],
  [POSE.rightElbow, POSE.rightWrist, 0.11, 0.08],
  [POSE.leftHip, POSE.leftKnee, 0.2, 0.15],
  [POSE.leftKnee, POSE.leftAnkle, 0.15, 0.1],
  [POSE.rightHip, POSE.rightKnee, 0.2, 0.15],
  [POSE.rightKnee, POSE.rightAnkle, 0.15, 0.1],
];

const TORSO = [POSE.leftShoulder, POSE.rightShoulder, POSE.rightHip, POSE.leftHip];

export function bodyRelief(pose: PoseResult, width: number, height: number): ReliefField | null {
  const L = pose.landmarks;
  if (L.length < 33) return null;
  const ok = (i: number) => finite(L[i]) && (L[i].visibility ?? 1) >= 0.5;
  let S = ok(POSE.leftShoulder) && ok(POSE.rightShoulder) ? dist(L[POSE.leftShoulder], L[POSE.rightShoulder]) : 0;
  if (ok(POSE.leftShoulder) && ok(POSE.leftHip)) S = Math.max(S, 0.5 * dist(L[POSE.leftShoulder], L[POSE.leftHip]));
  if (ok(POSE.rightShoulder) && ok(POSE.rightHip)) S = Math.max(S, 0.5 * dist(L[POSE.rightShoulder], L[POSE.rightHip]));
  if (!(S >= 12)) return null;
  // Pose z is noisy; damped so it only tilts limbs.
  const P = (i: number): P3 => ({ x: L[i].x, y: L[i].y, h: -0.5 * L[i].z });
  const limbs = LIMBS.filter(([a, b]) => ok(a) && ok(b));
  const torso = TORSO.every(ok);
  if (limbs.length === 0 && !torso) return null;
  const used = new Set<number>(limbs.flatMap(([a, b]) => [a, b]));
  if (torso) for (const i of TORSO) used.add(i);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of used) {
    x0 = Math.min(x0, L[i].x); y0 = Math.min(y0, L[i].y);
    x1 = Math.max(x1, L[i].x); y1 = Math.max(y1, L[i].y);
  }
  const r = regionAround(x0, y0, x1, y1, 0.25 * S, width, height);
  if (!r) return null;
  const buf = heightBuffer(r);
  if (torso) {
    const tBuf = heightBuffer(r);
    const loop = TORSO.map(P);
    const c = loop.reduce((s, p) => ({ x: s.x + p.x / 4, y: s.y + p.y / 4, h: s.h + p.h / 4 }), { x: 0, y: 0, h: 0 });
    rasterFan(r, tBuf, loop, c);
    const dome = domeProfile(coverage(tBuf, r));
    for (let i = 0; i < buf.length; i++) if (tBuf[i] > -Infinity) buf[i] = Math.max(buf[i], tBuf[i] + 0.22 * S * dome[i]);
  }
  for (const [a, b, ra, rb] of limbs) stampCapsule(r, buf, P(a), P(b), ra * S, rb * S);
  return finish('body', r, buf, width, height, Math.max(1, 0.02 * S), [], S, 0.15 * S);
}
