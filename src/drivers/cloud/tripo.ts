/**
 * Cloud driver: true image → full 3D via Tripo3D, proxied through our own
 * server (/api/tripo/*, see server/app.ts) so the API key stays server-side.
 * Uploads the original file, polls the task, then downloads the GLB.
 */
import type { Availability, Driver, DriverInput, DriverResult, I18nText, ParamSpec, ParamValues } from '../../core/types';
import { AbortError, throwIfAborted } from '../../core/types';
import { LocalizedError } from '../../core/errors';
import {
  MAX_IMAGE_BYTES,
  TRIPO_KEY_HEADER,
  TRIPO_STATUS_PATH,
  TRIPO_TASKS_PATH,
  taskModelPath,
  taskPath,
  type CreateTaskResponse,
  type StatusResponse,
  type TaskStateResponse,
} from './api';

export interface TripoDriverOptions {
  /** Defaults to the global fetch, looked up at call time. */
  fetch?: typeof fetch;
  /** Delay between status polls (default 2000 ms). */
  pollIntervalMs?: number;
  /** Give up after this long (default 15 min). */
  maxWaitMs?: number;
  /** Consecutive transient poll failures tolerated (default 5). */
  maxPollErrors?: number;
}

export interface TripoParams {
  apiKey: string;
  modelVersion: string;
  texture: boolean;
  pbr: boolean;
  faceLimit: number;
}

export const DEFAULT_TRIPO_PARAMS: TripoParams = { apiKey: '', modelVersion: 'default', texture: true, pbr: true, faceLimit: 0 };

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

// Progress bands: upload → 0.05, generation 0.05..0.9, download 0.9..1.
const GEN_START = 0.05;
const GEN_END = 0.9;

const T = {
  upload: { tr: 'Görsel Tripo3D’ye yükleniyor', en: 'Uploading image to Tripo3D' },
  queued: { tr: 'Tripo3D kuyruğunda bekleniyor', en: 'Waiting in the Tripo3D queue' },
  generating: (p: number): I18nText => ({ tr: `3B model oluşturuluyor… %${p}`, en: `Generating 3D model… ${p}%` }),
  downloading: { tr: 'Model indiriliyor', en: 'Downloading model' },
  done: { tr: 'Tamamlandı', en: 'Done' },
  serverUnreachable: {
    tr: 'API sunucusuna ulaşılamadı; bulut sürücüsü sunucu olmadan çalışmaz.',
    en: 'Could not reach the API server; the cloud driver needs it.',
  },
  needsKey: {
    tr: 'Sunucuda Tripo3D anahtarı tanımlı değil: parametrelerden kendi API anahtarınızı (tsk_…) girin.',
    en: 'No Tripo3D key is configured on the server: enter your own API key (tsk_…) in the parameters.',
  },
  keyRejected: {
    tr: 'Tripo3D API anahtarı geçersiz ya da reddedildi. Anahtarı kontrol edin.',
    en: 'The Tripo3D API key is invalid or was rejected. Please check it.',
  },
  tooLarge: { tr: 'Görsel 20 MB sınırını aşıyor.', en: 'The image exceeds the 20 MB limit.' },
  unsupported: {
    tr: 'Tripo3D yalnızca PNG, JPEG veya WEBP görselleri kabul eder.',
    en: 'Tripo3D only accepts PNG, JPEG or WEBP images.',
  },
  rateLimited: (min: number | null): I18nText => ({
    tr: `Çok fazla istek gönderildi; ${min ? `${min} dk sonra` : 'biraz sonra'} tekrar deneyin.`,
    en: `Too many requests; try again ${min ? `in ${min} min` : 'later'}.`,
  }),
  refused: (d: string): I18nText => ({
    tr: `Tripo3D isteği reddetti (kredi yetersiz olabilir): ${d}`,
    en: `Tripo3D refused the request (you may be out of credits): ${d}`,
  }),
  failed: (d: string): I18nText => ({
    tr: `Tripo3D bu görselden model üretemedi${d ? ` (${d})` : ''}.`,
    en: `Tripo3D could not generate a model from this image${d ? ` (${d})` : ''}.`,
  }),
  cancelled: { tr: 'Görev Tripo3D tarafında iptal edildi.', en: 'The task was cancelled on Tripo3D.' },
  timeout: (min: number): I18nText => ({
    tr: `Tripo3D ${min} dakika içinde sonuç vermedi.`,
    en: `Tripo3D did not finish within ${min} minutes.`,
  }),
  badModel: { tr: 'Tripo3D geçerli bir GLB dosyası döndürmedi.', en: 'Tripo3D did not return a valid GLB file.' },
  generic: (d: string): I18nText => ({ tr: `Tripo3D hatası: ${d}`, en: `Tripo3D error: ${d}` }),
};

/** Non-2xx response (status 0 = network failure). */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSec: number | null = null,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const isTransient = (e: HttpError) => e.status === 0 || e.status === 429 || e.status >= 500;

function localize(e: HttpError, userKey: boolean): LocalizedError {
  switch (e.status) {
    case 0:
      return new LocalizedError(T.serverUnreachable);
    case 401:
      return new LocalizedError(userKey ? T.keyRejected : T.needsKey);
    case 402:
    case 403:
      return new LocalizedError(T.refused(e.message));
    case 413:
      return new LocalizedError(T.tooLarge);
    case 415:
      return new LocalizedError(T.unsupported);
    case 429:
      return new LocalizedError(T.rateLimited(e.retryAfterSec ? Math.ceil(e.retryAfterSec / 60) : null));
    default:
      return new LocalizedError(T.generic(e.message));
  }
}

export function tripoParamsFrom(p: ParamValues): TripoParams {
  const d = DEFAULT_TRIPO_PARAMS;
  const faceLimit = typeof p.faceLimit === 'number' && Number.isFinite(p.faceLimit) ? Math.max(0, Math.round(p.faceLimit)) : d.faceLimit;
  return {
    apiKey: typeof p.apiKey === 'string' ? p.apiKey.trim() : d.apiKey,
    modelVersion: typeof p.modelVersion === 'string' && p.modelVersion ? p.modelVersion : d.modelVersion,
    texture: typeof p.texture === 'boolean' ? p.texture : d.texture,
    pbr: typeof p.pbr === 'boolean' ? p.pbr : d.pbr,
    faceLimit,
  };
}

/** Multipart body for POST /api/tripo/tasks. */
export function buildTaskForm(file: Blob, params: TripoParams): FormData {
  const form = new FormData();
  const name = 'name' in file && typeof file.name === 'string' && file.name ? file.name : 'image';
  form.append('image', file, name);
  if (params.modelVersion !== 'default') form.append('model_version', params.modelVersion);
  form.append('texture', String(params.texture));
  form.append('pbr', String(params.pbr));
  if (params.faceLimit > 0) form.append('face_limit', String(params.faceLimit));
  return form;
}

/** True when `buf` starts with the binary glTF magic ('glTF', version 2). */
export function isGlb(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false;
  const v = new DataView(buf);
  return v.getUint32(0, true) === 0x46546c67 && v.getUint32(4, true) === 2;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AbortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const PARAMS: ParamSpec[] = [
  {
    kind: 'text',
    key: 'apiKey',
    label: { tr: 'Tripo3D API anahtarı', en: 'Tripo3D API key' },
    hint: {
      tr: 'Sunucunun anahtarını kullanmak için boş bırakın. Kendi anahtarınız yalnızca bu istekte sunucumuz üzerinden Tripo3D’ye iletilir, saklanmaz.',
      en: "Leave empty to use the server's key. Your own key is only relayed to Tripo3D through our server for this request and is never stored.",
    },
    default: DEFAULT_TRIPO_PARAMS.apiKey,
    secret: true,
    placeholder: 'tsk_…',
  },
  {
    kind: 'select',
    key: 'modelVersion',
    label: { tr: 'Model sürümü', en: 'Model version' },
    // ASSUMPTION: version ids as published in Tripo's docs at the time of
    // writing; 'default' omits the field so Tripo uses its current default.
    options: [
      { value: 'default', label: { tr: 'Varsayılan (Tripo’nun güncel modeli)', en: "Default (Tripo's current model)" } },
      { value: 'v3.0-20250812', label: { tr: 'v3.0 (en yüksek detay)', en: 'v3.0 (highest detail)' } },
      { value: 'v2.5-20250123', label: { tr: 'v2.5', en: 'v2.5' } },
      { value: 'v2.0-20240919', label: { tr: 'v2.0 (daha hızlı)', en: 'v2.0 (faster)' } },
    ],
    default: DEFAULT_TRIPO_PARAMS.modelVersion,
  },
  {
    kind: 'boolean',
    key: 'texture',
    label: { tr: 'Doku üret', en: 'Generate texture' },
    default: DEFAULT_TRIPO_PARAMS.texture,
  },
  {
    kind: 'boolean',
    key: 'pbr',
    label: { tr: 'PBR malzeme', en: 'PBR material' },
    hint: {
      tr: 'Metalik/pürüzlülük haritaları üretir (doku gerektirir)',
      en: 'Adds metallic/roughness maps (requires texture)',
    },
    default: DEFAULT_TRIPO_PARAMS.pbr,
  },
  {
    kind: 'number',
    key: 'faceLimit',
    label: { tr: 'Üçgen sınırı', en: 'Face limit' },
    hint: { tr: '0 = otomatik', en: '0 = automatic' },
    min: 0,
    max: 300_000,
    step: 1000,
    default: DEFAULT_TRIPO_PARAMS.faceLimit,
  },
];

export function createTripoDriver(options: TripoDriverOptions = {}): Driver {
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const maxWaitMs = options.maxWaitMs ?? 15 * 60_000;
  const maxPollErrors = options.maxPollErrors ?? 5;
  const doFetch: typeof fetch = (input, init) => (options.fetch ?? fetch)(input, init);

  /** fetch that throws AbortError on abort and HttpError on network failure / non-2xx. */
  async function request(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal });
    } catch {
      if (signal.aborted) throw new AbortError();
      throw new HttpError(0, 'network error');
    }
    if (res.ok) return res;
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string' && body.error) message = body.error;
    } catch {
      if (signal.aborted) throw new AbortError();
    }
    const ra = Number(res.headers.get('retry-after'));
    throw new HttpError(res.status, message, Number.isFinite(ra) && ra > 0 ? ra : null);
  }

  async function readJson<T>(res: Response, signal: AbortSignal): Promise<T> {
    try {
      return (await res.json()) as T;
    } catch {
      if (signal.aborted) throw new AbortError();
      throw new HttpError(502, 'invalid JSON from the API server');
    }
  }

  async function downloadModel(taskId: string, headers: HeadersInit, input: DriverInput): Promise<ArrayBuffer> {
    const { signal, onProgress } = input;
    onProgress({ label: T.downloading, ratio: GEN_END });
    const res = await request(taskModelPath(taskId), { headers }, signal);
    const total = Number(res.headers.get('content-length')) || 0;
    try {
      if (!res.body || !total) return await res.arrayBuffer();
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      let lastPct = -1;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        const pct = Math.min(100, Math.floor((received / total) * 100));
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress({ label: T.downloading, ratio: GEN_END + (1 - GEN_END) * (pct / 100) });
        }
      }
      const out = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      return out.buffer;
    } catch {
      if (signal.aborted) throw new AbortError();
      throw new HttpError(0, 'download interrupted');
    }
  }

  async function run(input: DriverInput): Promise<DriverResult> {
    const { file, signal, onProgress } = input;
    const params = tripoParamsFrom(input.params);
    const userKey = params.apiKey !== '';
    throwIfAborted(signal);
    if (file.size > MAX_IMAGE_BYTES) throw new LocalizedError(T.tooLarge);
    if (file.type && !ACCEPTED_TYPES.includes(file.type)) throw new LocalizedError(T.unsupported);
    const headers: Record<string, string> = userKey ? { [TRIPO_KEY_HEADER]: params.apiKey } : {};

    try {
      onProgress({ label: T.upload, ratio: 0.01 });
      const created = await readJson<CreateTaskResponse>(
        await request(TRIPO_TASKS_PATH, { method: 'POST', headers, body: buildTaskForm(file, params) }, signal),
        signal,
      );
      if (typeof created.taskId !== 'string' || !created.taskId) throw new HttpError(502, 'no task id');
      const taskId = created.taskId;
      onProgress({ label: T.queued, ratio: GEN_START });

      const deadline = Date.now() + maxWaitMs;
      let errors = 0;
      for (;;) {
        await sleep(pollIntervalMs, signal);
        if (Date.now() > deadline) throw new LocalizedError(T.timeout(Math.round(maxWaitMs / 60_000)));
        let state: TaskStateResponse;
        try {
          state = await readJson<TaskStateResponse>(await request(taskPath(taskId), { headers }, signal), signal);
          errors = 0;
        } catch (e) {
          if (e instanceof HttpError && isTransient(e) && ++errors <= maxPollErrors) continue;
          throw e;
        }
        const pct = Math.max(0, Math.min(100, Math.round(Number(state.progress) || 0)));
        if (state.status === 'success') break;
        if (state.status === 'failed') throw new LocalizedError(T.failed(state.error ?? ''));
        if (state.status === 'cancelled') throw new LocalizedError(T.cancelled);
        if (state.status === 'running' || pct > 0) {
          onProgress({ label: T.generating(pct), ratio: GEN_START + (GEN_END - GEN_START) * (pct / 100) });
        } else {
          onProgress({ label: T.queued, ratio: GEN_START });
        }
      }

      const glb = await downloadModel(taskId, headers, input);
      if (!isGlb(glb)) throw new LocalizedError(T.badModel);
      onProgress({ label: T.done, ratio: 1 });
      return { kind: 'model', glb };
    } catch (e) {
      if (signal.aborted || e instanceof AbortError) throw new AbortError();
      if (e instanceof HttpError) throw localize(e, userKey);
      throw e;
    }
  }

  async function isAvailable(): Promise<Availability> {
    let body: Partial<StatusResponse> | null = null;
    try {
      const res = await doFetch(TRIPO_STATUS_PATH, { signal: AbortSignal.timeout(5000) });
      if (res.ok) body = (await res.json()) as Partial<StatusResponse>;
    } catch {
      body = null;
    }
    if (!body || typeof body.configured !== 'boolean') return { ok: false, reason: T.serverUnreachable };
    return body.configured ? { ok: true } : { ok: true, reason: T.needsKey };
  }

  return {
    id: 'tripo3d-cloud',
    name: { tr: 'Tripo3D (bulut, tam 3B)', en: 'Tripo3D (cloud, full 3D)' },
    description: {
      tr: 'Görseli Tripo3D API’sine gönderir; görünmeyen yüzleri de tamamlanmış, dokulu ve kapalı bir 3B model (GLB) döner. En gerçekçi sonuç budur ancak Tripo3D API anahtarı (sunucuda tanımlı ya da kendi anahtarınız) gerektirir, kredi harcar ve görsel üçüncü taraf bir hizmete yüklenir. Genellikle 1–3 dakika sürer.',
      en: 'Sends the image to the Tripo3D API and returns a textured, closed 3D model (GLB) with the unseen sides reconstructed. The most realistic option, but it needs a Tripo3D API key (configured on the server, or your own), uses credits and uploads the image to a third-party service. Usually takes 1–3 minutes.',
    },
    category: 'cloud',
    badges: ['api-key', 'full-3d', 'closed-mesh'],
    params: PARAMS,
    producesDepth: false,
    isAvailable,
    run,
  };
}

export const tripoDriver: Driver = createTripoDriver();
