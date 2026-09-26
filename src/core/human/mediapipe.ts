/**
 * Browser loader for the MediaPipe Tasks Vision landmarkers (main thread):
 * lazily imported bundle, self-hosted wasm runtime, model download with
 * progress and stall timeout, GPU delegate with CPU fallback.
 *
 * The wasm runtime is bundled by Vite (`?url` asset imports: hashed files
 * under the app's BASE_URL, so it works on a GitHub Pages sub-path). Not
 * FilesetResolver.forVisionTasks(base), which builds un-hashed names under
 * one directory; its SIMD probe is reused to pick the SIMD / no-SIMD build.
 * On the main thread the bundle injects the loader with a <script> tag
 * (classic script defining the global ModuleFactory), so the non-module
 * build is the right one here.
 */
import type { FaceLandmarker, HandLandmarker, NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision';
import simdLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import simdBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import nosimdLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.js?url';
import nosimdBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.wasm?url';
import { LocalizedError } from '../errors';
import { AbortError, type I18nText, type RGBAImage } from '../types';
import type { Detector, DetectorBackend, LoadContext, RawDetections, RawLandmark } from './backend';
import { humanConfigFrom, modelUrls, type HumanConfig } from './config';
import type { HumanDetector } from './types';

type Vision = typeof import('@mediapipe/tasks-vision');
type Fileset = Parameters<Vision['FaceLandmarker']['createFromOptions']>[0];
type Task = FaceLandmarker | HandLandmarker | PoseLandmarker;
type Delegate = 'GPU' | 'CPU';

const config: HumanConfig = humanConfigFrom(import.meta.env ?? {});

/** The effective configuration (env overrides applied). */
export function getHumanConfig(): HumanConfig {
  return config;
}

const NAMES: Record<HumanDetector, I18nText> = {
  faces: { tr: 'yüz', en: 'face' },
  hands: { tr: 'el', en: 'hand' },
  pose: { tr: 'vücut', en: 'body' },
};

function failure(kind: HumanDetector, detail: string): LocalizedError {
  const n = NAMES[kind];
  return new LocalizedError({
    tr: `İnsan algılama (${n.tr}) modeli yüklenemedi: ${detail}`,
    en: `Could not load the human detection (${n.en}) model: ${detail}`,
  });
}

class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

class TimeoutError extends Error {
  constructor(what: string) {
    super(`${what} timed out`);
    this.name = 'TimeoutError';
  }
}

let vision: Promise<Vision> | null = null;

function loadVision(): Promise<Vision> {
  vision ??= import('@mediapipe/tasks-vision').catch((e: unknown) => {
    vision = null;
    throw e;
  });
  return vision;
}

let fileset: Promise<Fileset> | null = null;

function wasmFileset(v: Vision): Promise<Fileset> {
  fileset ??= (async () => {
    if (config.wasmBase) return v.FilesetResolver.forVisionTasks(config.wasmBase);
    const simd = await v.FilesetResolver.isSimdSupported();
    return simd
      ? { wasmLoaderPath: simdLoaderUrl, wasmBinaryPath: simdBinaryUrl }
      : { wasmLoaderPath: nosimdLoaderUrl, wasmBinaryPath: nosimdBinaryUrl };
  })();
  return fileset;
}

/** Resolve / reject like `p`, or reject with TimeoutError after `ms`; a late result is handed to `onLate` (to dispose it). */
function withTimeout<T>(p: Promise<T>, ms: number, what: string, onLate: (v: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new TimeoutError(what));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        if (timedOut) onLate(v);
        else resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        if (!timedOut) reject(e);
      },
    );
  });
}

/**
 * Task creation runs one at a time: each creation injects the loader script,
 * which sets the global ModuleFactory that createFromOptions consumes and
 * then clears, so concurrent creations would race on it.
 */
let chain: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn);
  chain = run.catch(() => undefined);
  return run;
}

async function createTask(v: Vision, kind: HumanDetector, bytes: Uint8Array, delegate: Delegate): Promise<Task> {
  const fs = await wasmFileset(v);
  const baseOptions = { modelAssetBuffer: bytes, delegate };
  const c = config.minConfidence;
  switch (kind) {
    case 'faces':
      return v.FaceLandmarker.createFromOptions(fs, {
        baseOptions,
        runningMode: 'IMAGE',
        numFaces: config.numFaces,
        minFaceDetectionConfidence: c,
        minFacePresenceConfidence: c,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      });
    case 'hands':
      return v.HandLandmarker.createFromOptions(fs, {
        baseOptions,
        runningMode: 'IMAGE',
        numHands: config.numHands,
        minHandDetectionConfidence: c,
        minHandPresenceConfidence: c,
      });
    case 'pose':
      return v.PoseLandmarker.createFromOptions(fs, {
        baseOptions,
        runningMode: 'IMAGE',
        numPoses: config.numPoses,
        minPoseDetectionConfidence: c,
        minPosePresenceConfidence: c,
        outputSegmentationMasks: false,
      });
  }
}

let gpuUsable: boolean | null = null;

/**
 * Whether the GPU delegate is worth trying: it needs WebGL2, and on a
 * software rasteriser (SwiftShader, llvmpipe… — headless browsers, VMs,
 * blocklisted GPUs) it is ~10× slower than the CPU (XNNPACK) path.
 * ASSUMPTION: renderer names from WEBGL_debug_renderer_info; when the
 * extension is unavailable the GPU is assumed to be real.
 */
function gpuDelegateUsable(): boolean {
  if (gpuUsable !== null) return gpuUsable;
  gpuUsable = false;
  try {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    if (!gl) return gpuUsable;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gpuUsable = !/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    gpuUsable = false;
  }
  return gpuUsable;
}

/** Create on the preferred delegates in order ('auto': GPU when usable, then CPU). */
async function createWithFallback(v: Vision, kind: HumanDetector, bytes: Uint8Array): Promise<{ task: Task; delegate: Delegate }> {
  const order: Delegate[] = config.delegate !== 'auto' ? [config.delegate] : gpuDelegateUsable() ? ['GPU', 'CPU'] : ['CPU'];
  let last: unknown = null;
  for (const delegate of order) {
    try {
      // A copy per attempt: the buffer handed to the wasm side is not ours afterwards.
      const task = await serialized(() =>
        withTimeout(createTask(v, kind, bytes.slice(), delegate), config.initTimeoutMs, `${kind} model initialisation`, (t) => t.close()),
      );
      return { task, delegate };
    } catch (e) {
      last = e;
      if (order.length > 1) console.warn(`[human] ${kind} landmarker on ${delegate} failed`, e);
    }
  }
  throw last;
}

/** Download a model with byte progress; aborts when no bytes arrive for `stallMs`. */
async function fetchBytes(url: string, ctx: LoadContext, stallMs: number): Promise<Uint8Array> {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ac.abort();
    }, stallMs);
  };
  try {
    if (ctx.signal.aborted) throw new AbortError();
    arm();
    const res = await fetch(url, { signal: ac.signal, credentials: 'omit' });
    if (!res.ok) throw new HttpError(res.status, url);
    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      arm();
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      ctx.onBytes?.(loaded, Math.max(total, loaded));
    }
    const out = new Uint8Array(loaded);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out;
  } catch (e) {
    if (ctx.signal.aborted) throw new AbortError();
    if (stalled) throw new TimeoutError(`Download of ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

/** Models are kept in the Cache API (like transformers.js does for its weights), so they download once per browser. */
const MODEL_CACHE = '3dmarker-mediapipe-v1';

async function cachedModel(url: string): Promise<Uint8Array | null> {
  try {
    if (typeof caches === 'undefined') return null;
    const res = await (await caches.open(MODEL_CACHE)).match(url);
    return res?.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  } catch {
    return null; // private mode, opaque origin…
  }
}

function storeModel(url: string, bytes: Uint8Array): void {
  if (typeof caches === 'undefined') return;
  const body = new Blob([bytes as Uint8Array<ArrayBuffer>]);
  caches
    .open(MODEL_CACHE)
    .then((c) => c.put(url, new Response(body, { headers: { 'content-type': 'application/octet-stream' } })))
    .catch(() => undefined);
}

function evictModel(url: string): void {
  if (typeof caches === 'undefined') return;
  caches.open(MODEL_CACHE).then((c) => c.delete(url)).catch(() => undefined);
}

interface ModelBytes {
  url: string;
  bytes: Uint8Array;
  cached: boolean;
}

/** First candidate that loads (cache, then network); an HTTP error moves on to the next one (e.g. pose full → lite). */
async function fetchModel(kind: HumanDetector, ctx: LoadContext, skipCache = false): Promise<ModelBytes> {
  let last: unknown = null;
  for (const url of modelUrls(config, kind)) {
    const hit = skipCache ? null : await cachedModel(url);
    if (hit) {
      ctx.onBytes?.(hit.byteLength, hit.byteLength);
      return { url, bytes: hit, cached: true };
    }
    try {
      return { url, bytes: await fetchBytes(url, ctx, config.stallTimeoutMs), cached: false };
    } catch (e) {
      if (e instanceof AbortError) throw e;
      last = e;
      if (!(e instanceof HttpError)) break; // network / CORS / timeout: the other candidates share the host
    }
  }
  throw last;
}

function convert(list: NormalizedLandmark[][] | undefined): RawLandmark[][] {
  return (list ?? []).map((pts) => pts.map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility })));
}

function run(task: Task, kind: HumanDetector, image: ImageData): RawDetections {
  switch (kind) {
    case 'faces':
      return { landmarks: convert((task as FaceLandmarker).detect(image).faceLandmarks) };
    case 'hands': {
      const r = (task as HandLandmarker).detect(image);
      return { landmarks: convert(r.landmarks), handedness: (r.handedness ?? []).map((c) => c[0]?.categoryName ?? '') };
    }
    case 'pose':
      return { landmarks: convert((task as PoseLandmarker).detect(image).landmarks) };
  }
}

class MediaPipeDetector implements Detector {
  constructor(
    readonly kind: HumanDetector,
    private readonly v: Vision,
    private task: Task,
    private delegate: Delegate,
    /** Kept until the GPU path has worked once, for the CPU fallback. */
    private bytes: Uint8Array | null,
  ) {}

  async detect(image: RGBAImage): Promise<RawDetections> {
    const plain = image.data.buffer instanceof ArrayBuffer ? (image.data as Uint8ClampedArray<ArrayBuffer>) : new Uint8ClampedArray(image.data);
    const input = new ImageData(plain, image.width, image.height);
    try {
      const out = run(this.task, this.kind, input);
      this.bytes = null;
      return out;
    } catch (e) {
      if (this.delegate !== 'GPU' || !this.bytes) throw e;
      // GPU inference failed (lost context, unsupported op…): switch to CPU once.
      console.warn(`[human] ${this.kind} GPU inference failed, retrying on CPU`, e);
      const bytes = this.bytes;
      this.bytes = null;
      this.task.close();
      this.task = await serialized(() =>
        withTimeout(createTask(this.v, this.kind, bytes, 'CPU'), config.initTimeoutMs, `${this.kind} model initialisation`, (t) => t.close()),
      );
      this.delegate = 'CPU';
      return run(this.task, this.kind, input);
    }
  }
}

const detectors = new Map<HumanDetector, Promise<Detector>>();

/** One-line reason (MediaPipe appends a multi-line source location trace to its status messages). */
function describe(e: unknown): string {
  let msg: string;
  if (e instanceof Error) msg = e.message || e.name;
  else if (typeof Event !== 'undefined' && e instanceof Event) msg = `${e.type} event (script or network error)`;
  else msg = String(e);
  return msg.split('\n=== Source Location Trace')[0].split('\n')[0].trim().slice(0, 300);
}

async function loadDetector(kind: HumanDetector, ctx: LoadContext): Promise<Detector> {
  let v: Vision;
  try {
    v = await loadVision();
  } catch (e) {
    throw failure(kind, describe(e));
  }
  for (let attempt = 0; ; attempt++) {
    let model: ModelBytes;
    try {
      model = await fetchModel(kind, ctx, attempt > 0);
    } catch (e) {
      if (e instanceof AbortError) throw e;
      throw failure(kind, describe(e));
    }
    try {
      const { task, delegate } = await createWithFallback(v, kind, model.bytes);
      // Cached only once it initialised: a truncated / wrong file must not stick.
      if (!model.cached) storeModel(model.url, model.bytes);
      return new MediaPipeDetector(kind, v, task, delegate, delegate === 'GPU' ? model.bytes : null);
    } catch (e) {
      if (model.cached && attempt === 0) {
        evictModel(model.url); // a stale / corrupt cached copy: download it again
        continue;
      }
      throw failure(kind, describe(e));
    }
  }
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

export const mediapipeBackend: DetectorBackend = {
  unsupportedReason() {
    const jsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent ?? ''); // unit tests: never download models
    if (jsdom || typeof document === 'undefined' || typeof WebAssembly !== 'object' || typeof ImageData === 'undefined' || typeof fetch !== 'function') {
      return {
        tr: 'İnsan algılama (MediaPipe) bu ortamda çalışmıyor',
        en: 'Human detection (MediaPipe) is not supported in this environment',
      };
    }
    return null;
  },

  async load(kind, ctx) {
    for (let attempt = 0; ; attempt++) {
      let entry = detectors.get(kind);
      if (!entry) {
        entry = loadDetector(kind, ctx);
        detectors.set(kind, entry);
        const mine = entry;
        entry.catch(() => {
          if (detectors.get(kind) === mine) detectors.delete(kind);
        });
      }
      try {
        return await raceAbort(entry, ctx.signal);
      } catch (e) {
        // Another caller's download was cancelled: start our own once.
        if (e instanceof AbortError && !ctx.signal.aborted && attempt === 0) continue;
        throw e;
      }
    }
  },
};
