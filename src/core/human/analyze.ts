/**
 * Human analysis: face / hand / body landmarks of one image in pixel
 * coordinates (conventions in types.ts), via MediaPipe Tasks Vision
 * (mediapipe.ts, imported lazily so the 150 kB bundle and the wasm stay out
 * of the main chunk until a human-detail feature runs).
 *
 *  - Results are cached per image object and detector set; concurrent calls
 *    for the same image share one run (it is cancelled only when every
 *    caller has aborted).
 *  - Never throws except AbortError: models that cannot be downloaded, a
 *    missing WebGL / wasm, a detector crash… give an empty result with
 *    `unavailableReason` (or `failed` when only some detectors failed).
 *  - Small subjects: the face / hand detectors miss faces and hands that are
 *    small in the frame, so when the pose model finds a head or a wrist with
 *    no face / hand on it, that region is cropped, up-scaled and searched
 *    again; landmarks are mapped back to the full image.
 */
import { resizeRGBA } from '../image/ops';
import { compositeOver, NEUTRAL_GREY } from '../preprocess/composite';
import { AbortError, throwIfAborted, type I18nText, type Progress, type RGBAImage } from '../types';
import { yieldToPaint } from '../yield';
import type { Detector, DetectorBackend, LoadContext, RawLandmark } from './backend';
import { humanConfigFrom } from './config';
import { cropRGBA } from './raster';
import { FACE, LEFT_EYE_LOOP, RIGHT_EYE_LOOP } from './topology';
import {
  POSE,
  type AnalyzeOptions,
  type Box,
  type FaceResult,
  type HandResult,
  type HumanAnalysis,
  type HumanDetector,
  type Landmark,
  type PoseResult,
} from './types';

/** Detection order: the pose guides the face / hand crop passes. */
const ORDER: HumanDetector[] = ['pose', 'faces', 'hands'];

/** Crops for the second-chance pass are up-scaled to at least this side. */
const CROP_MIN_SIDE = 256;
/** At most this many second-chance crops per detector. */
const MAX_GUIDED_CROPS = 4;

const HANDEDNESS_MIRRORED = humanConfigFrom(import.meta.env ?? {}).handednessMirrored;

const TEXT = {
  loading: { tr: 'İnsan algılama modelleri yükleniyor (ilk kullanımda indirilir)…', en: 'Loading human detection models (downloaded on first use)…' },
  detecting: { tr: 'Yüz, el ve vücut algılanıyor…', en: 'Detecting face, hands and body…' },
  moduleFailed: { tr: 'İnsan algılama modülü yüklenemedi', en: 'Could not load the human detection module' },
} satisfies Record<string, I18nText>;

// ---------------------------------------------------------------------------
// Backend

let backendOverride: DetectorBackend | null = null;

/** Replace the MediaPipe backend (tests, tools); null restores it. Clears the cache. */
export function setDetectorBackend(backend: DetectorBackend | null): void {
  backendOverride = backend;
  clearHumanCache();
}

async function getBackend(): Promise<DetectorBackend> {
  if (backendOverride) return backendOverride;
  return (await import('./mediapipe')).mediapipeBackend;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)

/** Where the analysed (possibly cropped / scaled) image sits in the full image, in full-image pixels. */
export interface Frame {
  x0: number;
  y0: number;
  width: number;
  height: number;
}

/**
 * Normalised MediaPipe landmarks → full-image pixels; z is scaled like x (by
 * the analysed image's width). Only the pose model reports visibility (the
 * face / hand models fill in 0), so it is kept on request only.
 */
export function toPixels(points: RawLandmark[], frame: Frame, keepVisibility = false): Landmark[] {
  return points.map((p) => {
    const l: Landmark = { x: frame.x0 + p.x * frame.width, y: frame.y0 + p.y * frame.height, z: p.z * frame.width };
    if (keepVisibility && p.visibility !== undefined && Number.isFinite(p.visibility)) l.visibility = p.visibility;
    return l;
  });
}

/** Bounding box of the landmarks, clamped to the image (points with visibility < minVisibility are ignored when others remain). */
export function landmarkBox(points: Landmark[], width: number, height: number, minVisibility = 0): Box {
  let use = points.filter((p) => (p.visibility ?? 1) >= minVisibility);
  if (use.length === 0) use = points;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of use) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  x0 = Math.max(0, Math.min(width, x0)); x1 = Math.max(0, Math.min(width, x1));
  y0 = Math.max(0, Math.min(height, y0)); y1 = Math.max(0, Math.min(height, y1));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/** Square box of side `size` centred on (cx, cy), clamped to the image (integer pixels). */
export function squareBox(cx: number, cy: number, size: number, width: number, height: number): Box | null {
  const x0 = Math.max(0, Math.floor(cx - size / 2));
  const y0 = Math.max(0, Math.floor(cy - size / 2));
  const x1 = Math.min(width, Math.ceil(cx + size / 2));
  const y1 = Math.min(height, Math.ceil(cy + size / 2));
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

function visible(p: Landmark | undefined, width: number, height: number, min = 0.5): p is Landmark {
  return !!p && (p.visibility ?? 1) >= min && p.x >= 0 && p.y >= 0 && p.x < width && p.y < height;
}

/** Head region of a pose (square around nose / eyes / ears / mouth), or null when the head is not visible. */
export function headBoxFromPose(pose: PoseResult, width: number, height: number): Box | null {
  const L = pose.landmarks;
  const ids = [POSE.nose, POSE.leftEye, POSE.rightEye, POSE.leftEar, POSE.rightEar, POSE.mouthLeft, POSE.mouthRight];
  const pts = ids.map((i) => L[i]).filter((p) => visible(p, width, height));
  if (pts.length < 3 || !visible(L[POSE.nose], width, height)) return null;
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  let span = 0;
  for (const a of pts) for (const b of pts) span = Math.max(span, dist(a, b));
  const eyes = L[POSE.leftEye] && L[POSE.rightEye] ? dist(L[POSE.leftEye], L[POSE.rightEye]) * 2.2 : 0;
  const size = 2.6 * Math.max(span, eyes, 10);
  return squareBox(cx, cy, size, width, height);
}

/** Hand region around a pose wrist (towards its knuckle points), or null. */
export function handBoxFromPose(pose: PoseResult, side: 'left' | 'right', width: number, height: number): Box | null {
  const L = pose.landmarks;
  const [w, k1, k2, k3] = side === 'left'
    ? [POSE.leftWrist, POSE.leftPinky, POSE.leftIndex, POSE.leftThumb]
    : [POSE.rightWrist, POSE.rightPinky, POSE.rightIndex, POSE.rightThumb];
  const wrist = L[w];
  if (!visible(wrist, width, height)) return null;
  const knuckles = [L[k1], L[k2], L[k3]].filter((p): p is Landmark => !!p && (p.visibility ?? 1) >= 0.3);
  const shoulders = L[POSE.leftShoulder] && L[POSE.rightShoulder] ? dist(L[POSE.leftShoulder], L[POSE.rightShoulder]) : 0;
  let cx = wrist.x, cy = wrist.y, handLen = 0.35 * shoulders;
  if (knuckles.length > 0) {
    const kx = knuckles.reduce((s, p) => s + p.x, 0) / knuckles.length;
    const ky = knuckles.reduce((s, p) => s + p.y, 0) / knuckles.length;
    handLen = Math.max(handLen * 0.6, 2.2 * Math.hypot(kx - wrist.x, ky - wrist.y));
    cx = wrist.x + (kx - wrist.x) * 1.1;
    cy = wrist.y + (ky - wrist.y) * 1.1;
  }
  const size = Math.max(2.4 * handLen, 24);
  return squareBox(cx, cy, size, width, height);
}

function contains(box: Box, x: number, y: number, margin = 0): boolean {
  const mx = box.width * margin, my = box.height * margin;
  return x >= box.x - mx && x <= box.x + box.width + mx && y >= box.y - my && y <= box.y + box.height + my;
}

/** Face-mesh points matching pose landmarks: nose tip, eye centres (eye loop means), mouth corners. */
const FACE_POSE_PAIRS: [number, readonly number[]][] = [
  [POSE.nose, [FACE.noseTip]],
  [POSE.leftEye, LEFT_EYE_LOOP],
  [POSE.rightEye, RIGHT_EYE_LOOP],
  [POSE.mouthLeft, [291]],
  [POSE.mouthRight, [61]],
];

/**
 * A face mesh that contradicts the pose found on the same head is a bad fit
 * (typical for small, blurred or strongly turned faces) and would sculpt a
 * distorted face: rejected when its nose / eyes / mouth corners sit on
 * average more than 0.22 face sizes from the pose's, or its eye line is
 * rotated more than 25° against the pose's. Faces with no pose are kept.
 */
export function faceAgreesWithPose(face: FaceResult, poses: PoseResult[]): boolean {
  const L = face.landmarks;
  const size = Math.max(dist(L[FACE.forehead], L[FACE.chin]), dist(L[FACE.rightSide], L[FACE.leftSide]));
  if (!(size > 0)) return false;
  const center = (ids: readonly number[]) => ({
    x: ids.reduce((s, i) => s + L[i].x, 0) / ids.length,
    y: ids.reduce((s, i) => s + L[i].y, 0) / ids.length,
  });
  for (const pose of poses) {
    const P = pose.landmarks;
    const nose = P[POSE.nose];
    if (!nose || (nose.visibility ?? 1) < 0.5 || !contains(face.box, nose.x, nose.y, 0.3)) continue;
    let sum = 0, n = 0;
    for (const [pi, fi] of FACE_POSE_PAIRS) {
      const p = P[pi];
      if (!p || (p.visibility ?? 1) < 0.5) continue;
      sum += dist(p, center(fi));
      n++;
    }
    if (n >= 3 && sum / n > 0.22 * size) return false;
    const le = P[POSE.leftEye], re = P[POSE.rightEye];
    if (le && re && (le.visibility ?? 1) >= 0.5 && (re.visibility ?? 1) >= 0.5 && dist(le, re) > 0.1 * size) {
      const a = Math.atan2(le.y - re.y, le.x - re.x);
      const b = Math.atan2(L[FACE.leftEyeOuter].y - L[FACE.rightEyeOuter].y, L[FACE.leftEyeOuter].x - L[FACE.rightEyeOuter].x);
      let d = Math.abs(a - b);
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d > (25 * Math.PI) / 180) return false;
    }
    return true;
  }
  return true;
}

const boxCenter = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const area = (b: Box) => b.width * b.height;

/** Subject's own hand from MediaPipe's label, or from the nearest pose wrist when a pose is known. */
export function resolveHandedness(label: string, wrist: Landmark, poses: PoseResult[], mirrored = HANDEDNESS_MIRRORED): 'Left' | 'Right' {
  let best: { d: number; side: 'Left' | 'Right' } | null = null;
  for (const p of poses) {
    for (const [idx, side] of [[POSE.leftWrist, 'Left'], [POSE.rightWrist, 'Right']] as const) {
      const w = p.landmarks[idx];
      if (!w || (w.visibility ?? 1) < 0.3) continue;
      const d = dist(w, wrist);
      if (!best || d < best.d) best = { d, side };
    }
  }
  if (best) {
    // Only trust the pose when its wrist is close to this hand.
    const scale = Math.max(...poses.map((p) => {
      const a = p.landmarks[POSE.leftShoulder], b = p.landmarks[POSE.rightShoulder];
      return a && b ? dist(a, b) : 0;
    }));
    if (scale === 0 || best.d < 0.6 * scale) return best.side;
  }
  const isLeft = label.toLowerCase() === 'left';
  return isLeft !== mirrored ? 'Left' : 'Right';
}

// ---------------------------------------------------------------------------
// Cache

let cache = new WeakMap<RGBAImage, Map<string, HumanAnalysis>>();

interface Flight {
  promise: Promise<HumanAnalysis>;
  controller: AbortController;
  waiters: number;
  listeners: Set<(p: Progress) => void>;
  last: Progress | null;
}

let inflight = new WeakMap<RGBAImage, Map<string, Flight>>();

/**
 * A detector load that failed slowly (stalled download on a blackholed host,
 * hung GPU init: up to the stall / init timeouts) is remembered for a while
 * and fails at once, so every later depth run does not wait again. Fast
 * failures (HTTP / DNS / CORS errors) are cheap and retried every time.
 */
export const SLOW_LOAD_FAILURE_MS = 5_000;
export const LOAD_FAILURE_TTL_MS = 5 * 60_000;
let loadFailures = new Map<HumanDetector, { at: number; error: unknown }>();

async function loadDetector(backend: DetectorBackend, kind: HumanDetector, ctx: LoadContext): Promise<Detector> {
  const known = loadFailures.get(kind);
  if (known && Date.now() - known.at < LOAD_FAILURE_TTL_MS) throw known.error;
  const start = Date.now();
  try {
    const d = await backend.load(kind, ctx);
    loadFailures.delete(kind);
    return d;
  } catch (e) {
    const end = Date.now();
    if (!(e instanceof AbortError) && !ctx.signal.aborted && end - start >= SLOW_LOAD_FAILURE_MS) loadFailures.set(kind, { at: end, error: e });
    throw e;
  }
}

/** Forget cached analyses (all images, or one); clearing all also forgets remembered model load failures. */
export function clearHumanCache(image?: RGBAImage): void {
  if (image) {
    cache.delete(image);
    return;
  }
  cache = new WeakMap();
  inflight = new WeakMap();
  loadFailures = new Map();
}

function requested(detect: AnalyzeOptions['detect']): HumanDetector[] {
  return ORDER.filter((d) => {
    if (!detect) return true;
    const v = d === 'pose' ? detect.pose : detect[d];
    return v !== false;
  });
}

function withOnly(a: HumanAnalysis, detectors: HumanDetector[]): HumanAnalysis {
  const faces = detectors.includes('faces') ? a.faces : [];
  const hands = detectors.includes('hands') ? a.hands : [];
  const poses = detectors.includes('pose') ? a.poses : [];
  return { width: a.width, height: a.height, faces, hands, poses, isHuman: faces.length > 0 || poses.length > 0 };
}

function cached(image: RGBAImage, detectors: HumanDetector[]): HumanAnalysis | null {
  const m = cache.get(image);
  if (!m) return null;
  const exact = m.get(detectors.join(','));
  if (exact) return exact;
  for (const [key, a] of m) {
    const have = key.split(',');
    if (detectors.every((d) => have.includes(d))) return withOnly(a, detectors);
  }
  return null;
}

function empty(image: RGBAImage): HumanAnalysis {
  return { width: image.width, height: image.height, faces: [], hands: [], poses: [], isHuman: false };
}

function unavailable(image: RGBAImage, text: I18nText): HumanAnalysis {
  return { ...empty(image), unavailableReason: text.en, unavailableText: text };
}

function errorText(e: unknown): I18nText {
  if (typeof e === 'object' && e !== null && 'i18n' in e) {
    const t = (e as { i18n: I18nText }).i18n;
    if (t && typeof t.tr === 'string' && typeof t.en === 'string') return t;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { tr: `İnsan algılama başarısız: ${msg}`, en: `Human detection failed: ${msg}` };
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

// ---------------------------------------------------------------------------
// Analysis

const MB = 1024 * 1024;

async function detectIn(detector: Detector, source: RGBAImage, box: Box | null): Promise<{ frame: Frame; landmarks: RawLandmark[][]; handedness?: string[] }> {
  if (!box) {
    const r = await detector.detect(source);
    return { frame: { x0: 0, y0: 0, width: source.width, height: source.height }, ...r };
  }
  let crop = cropRGBA(source, box);
  const frame = { x0: Math.round(box.x), y0: Math.round(box.y), width: crop.width, height: crop.height };
  const minSide = Math.min(crop.width, crop.height);
  if (minSide < CROP_MIN_SIDE) {
    const s = CROP_MIN_SIDE / minSide;
    crop = resizeRGBA(crop, Math.round(crop.width * s), Math.round(crop.height * s));
  }
  const r = await detector.detect(crop);
  return { frame, ...r };
}

async function runPose(det: Detector, input: RGBAImage): Promise<PoseResult[]> {
  const { frame, landmarks } = await detectIn(det, input, null);
  return landmarks
    .filter((pts) => pts.length >= 33)
    .map((pts) => {
      const l = toPixels(pts, frame, true);
      return { landmarks: l, box: landmarkBox(l, input.width, input.height, 0.5) };
    });
}

async function runFaces(det: Detector, input: RGBAImage, poses: PoseResult[], signal: AbortSignal): Promise<FaceResult[]> {
  const { width, height } = input;
  const out: { items: FaceResult[] } = { items: [] };
  const add = (frame: Frame, lists: RawLandmark[][]) => {
    for (const pts of lists) {
      if (pts.length < 468) continue;
      const l = toPixels(pts, frame);
      const box = landmarkBox(l, width, height);
      const c = boxCenter(box);
      if (box.width < 2 || box.height < 2 || out.items.some((f) => contains(f.box, c.x, c.y))) continue;
      const face = { landmarks: l, box };
      // A mesh the pose contradicts is dropped (its head then gets the up-scaled crop pass).
      if (!faceAgreesWithPose(face, poses)) continue;
      out.items.push(face);
    }
  };
  const full = await detectIn(det, input, null);
  add(full.frame, full.landmarks);
  let crops = 0;
  for (const pose of poses) {
    if (crops >= MAX_GUIDED_CROPS) break;
    const nose = pose.landmarks[POSE.nose];
    if (!nose || out.items.some((f) => contains(f.box, nose.x, nose.y, 0.25))) continue;
    const box = headBoxFromPose(pose, width, height);
    if (!box) continue;
    crops++;
    await yieldToPaint();
    throwIfAborted(signal);
    const r = await detectIn(det, input, box);
    add(r.frame, r.landmarks);
  }
  return out.items.sort((a, b) => area(b.box) - area(a.box));
}

async function runHands(det: Detector, input: RGBAImage, poses: PoseResult[], signal: AbortSignal): Promise<HandResult[]> {
  const { width, height } = input;
  const items: HandResult[] = [];
  const add = (frame: Frame, lists: RawLandmark[][], labels: string[] | undefined) => {
    lists.forEach((pts, i) => {
      if (pts.length < 21) return;
      const l = toPixels(pts, frame);
      const box = landmarkBox(l, width, height);
      const c = boxCenter(box);
      if (box.width < 2 || box.height < 2 || items.some((h) => contains(h.box, c.x, c.y))) return;
      items.push({ landmarks: l, handedness: resolveHandedness(labels?.[i] ?? '', l[0], poses), box });
    });
  };
  const full = await detectIn(det, input, null);
  add(full.frame, full.landmarks, full.handedness);
  let crops = 0;
  for (const pose of poses) {
    for (const side of ['left', 'right'] as const) {
      if (crops >= MAX_GUIDED_CROPS) break;
      const wrist = pose.landmarks[side === 'left' ? POSE.leftWrist : POSE.rightWrist];
      if (!wrist) continue;
      const box = handBoxFromPose(pose, side, width, height);
      if (!box) continue;
      if (items.some((h) => dist(h.landmarks[0], wrist) < 0.5 * Math.max(box.width, box.height))) continue;
      crops++;
      await yieldToPaint();
      throwIfAborted(signal);
      const r = await detectIn(det, input, box);
      add(r.frame, r.landmarks, r.handedness);
    }
  }
  return items.sort((a, b) => area(b.box) - area(a.box));
}

async function runAnalysis(
  image: RGBAImage,
  detectors: HumanDetector[],
  signal: AbortSignal,
  emit: (p: Progress) => void,
): Promise<HumanAnalysis> {
  let backend: DetectorBackend;
  try {
    backend = await getBackend();
  } catch (e) {
    console.warn('[human] could not load the MediaPipe module', e);
    return unavailable(image, TEXT.moduleFailed);
  }
  throwIfAborted(signal);
  const unsupported = backend.unsupportedReason();
  if (unsupported) return unavailable(image, unsupported);

  emit({ label: TEXT.loading });
  const bytes = new Map<HumanDetector, [number, number]>();
  const onBytes = (kind: HumanDetector) => (loaded: number, total: number) => {
    bytes.set(kind, [loaded, total]);
    let l = 0, t = 0;
    for (const [a, b] of bytes.values()) { l += a; t += b; }
    const mb = t > 0 ? ` ${(l / MB).toFixed(1)} / ${(t / MB).toFixed(1)} MB` : '';
    emit({ label: { tr: `${TEXT.loading.tr}${mb}`, en: `${TEXT.loading.en}${mb}` }, ratio: t > 0 ? Math.min(1, l / t) : undefined });
  };
  const loaded = await Promise.allSettled(detectors.map((kind) => loadDetector(backend, kind, { signal, onBytes: onBytes(kind) })));
  throwIfAborted(signal);

  const failed: Partial<Record<HumanDetector, string>> = {};
  const failedText: I18nText[] = [];
  const dets = new Map<HumanDetector, Detector>();
  loaded.forEach((r, i) => {
    if (r.status === 'fulfilled') dets.set(detectors[i], r.value);
    else {
      if (r.reason instanceof AbortError) throw r.reason;
      const t = errorText(r.reason);
      failed[detectors[i]] = t.en;
      failedText.push(t);
      console.warn(`[human] ${detectors[i]} detector unavailable`, r.reason);
    }
  });
  if (dets.size === 0) return { ...unavailable(image, failedText[0] ?? TEXT.moduleFailed), failed };

  emit({ label: TEXT.detecting });
  await yieldToPaint();
  throwIfAborted(signal);
  // MediaPipe ignores alpha: flatten transparent PNGs like the depth models see them.
  const input = compositeOver(image, NEUTRAL_GREY);

  const guard = async <T>(kind: HumanDetector, fn: (d: Detector) => Promise<T[]>): Promise<T[]> => {
    const d = dets.get(kind);
    if (!d) return [];
    try {
      const out = await fn(d);
      await yieldToPaint();
      throwIfAborted(signal);
      return out;
    } catch (e) {
      if (e instanceof AbortError) throw e;
      const t = errorText(e);
      failed[kind] = t.en;
      failedText.push(t);
      console.warn(`[human] ${kind} detection failed`, e);
      return [];
    }
  };
  const poses = await guard('pose', (d) => runPose(d, input));
  const faces = await guard('faces', (d) => runFaces(d, input, poses, signal));
  const hands = await guard('hands', (d) => runHands(d, input, poses, signal));

  const result: HumanAnalysis = { width: image.width, height: image.height, faces, hands, poses, isHuman: faces.length > 0 || poses.length > 0 };
  const failures = Object.keys(failed).length;
  if (failures === detectors.length) return { ...unavailable(image, failedText[0]), failed };
  if (failures > 0) result.failed = failed;
  return result;
}

/**
 * Detect faces (478 landmarks), hands (21) and bodies (33) in `image`.
 * Resolves with an empty result (and `unavailableReason`) when detection
 * cannot run; rejects only with AbortError.
 */
export async function analyzeHuman(image: RGBAImage, opts: AnalyzeOptions): Promise<HumanAnalysis> {
  const { signal, onProgress } = opts;
  throwIfAborted(signal);
  const detectors = requested(opts.detect);
  if (detectors.length === 0 || image.width === 0 || image.height === 0) return empty(image);
  const hit = cached(image, detectors);
  if (hit) return hit;

  const key = detectors.join(',');
  let flights = inflight.get(image);
  if (!flights) inflight.set(image, (flights = new Map()));
  let flight = flights.get(key);
  if (flight?.controller.signal.aborted) flight = undefined; // being cancelled: never join it
  if (!flight) {
    const controller = new AbortController();
    const f: Flight = { controller, waiters: 0, listeners: new Set(), last: null, promise: Promise.resolve(empty(image)) };
    const owner = flights;
    f.promise = runAnalysis(image, detectors, controller.signal, (p) => {
      f.last = p;
      for (const l of f.listeners) l(p);
    })
      .catch((e: unknown) => {
        if (e instanceof AbortError) throw e;
        console.warn('[human] analysis failed', e);
        return unavailable(image, errorText(e));
      })
      .then((res) => {
        if (!res.unavailableReason && !res.failed) {
          let m = cache.get(image);
          if (!m) cache.set(image, (m = new Map()));
          m.set(key, res);
        }
        return res;
      })
      .finally(() => {
        if (owner.get(key) === f) owner.delete(key);
      });
    flights.set(key, f);
    flight = f;
  }

  const listener = onProgress ? (p: Progress) => onProgress(p) : null;
  flight.waiters++;
  if (listener) {
    flight.listeners.add(listener);
    if (flight.last) listener(flight.last);
  }
  try {
    return await raceAbort(flight.promise, signal);
  } finally {
    if (listener) flight.listeners.delete(listener);
    flight.waiters--;
    if (flight.waiters === 0 && signal.aborted) {
      // Unlisted at once: a caller arriving before the run settles starts a fresh one.
      const owner = inflight.get(image);
      if (owner?.get(key) === flight) owner.delete(key);
      flight.controller.abort();
    }
  }
}
