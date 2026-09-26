/**
 * Minimal typed client for Tripo3D's public OpenAPI (image → textured 3D model).
 *
 * The API docs are not reachable from the build sandbox, so endpoint paths and
 * payload shapes follow the v2 OpenAPI as known at the time of writing. Every
 * such assumption is marked `ASSUMPTION` so the provider can be adjusted in
 * one place without touching the routes.
 *
 * The key is only ever sent to `baseUrl` — never to model download hosts —
 * and upstream error messages are scrubbed of it before they leave this module.
 */

export const TRIPO_API_BASE = 'https://api.tripo3d.ai/v2/openapi';

/**
 * ASSUMPTION: direct multipart upload is `POST /upload` in the original v2
 * docs and `POST /upload/sts` in newer ones (same request/response). Tried in
 * this order; the next one is used only when the previous answers 404/405.
 */
export const UPLOAD_PATHS = ['/upload', '/upload/sts'] as const;

/**
 * ASSUMPTION: hosts Tripo serves generated models from. Model URLs are signed
 * links on Tripo's own domains or its object-storage CDN. Entries match the
 * host exactly or as a dot-separated suffix. Override with
 * TRIPO_ALLOWED_MODEL_HOSTS when Tripo moves its CDN (the server logs the
 * refused host name).
 */
export const DEFAULT_MODEL_HOSTS = ['tripo3d.ai', 'tripo3d.com', 'tripo-data.cdn.bcebos.com'];

export type TripoImageMime = 'image/png' | 'image/jpeg' | 'image/webp';
export type TripoFileType = 'png' | 'jpg' | 'webp';

export const FILE_TYPE_BY_MIME: Record<TripoImageMime, TripoFileType> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export type TripoTaskStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'unknown' | 'banned' | 'expired';

export interface TripoTask {
  task_id: string;
  type?: string;
  /** One of TripoTaskStatus; kept as string so unknown future values survive. */
  status: string;
  /** 0..100 */
  progress: number;
  /** ASSUMPTION: `model`, `pbr_model`, `base_model`, `rendered_image` are URL strings (a `{ url }` object is tolerated too). */
  output: Record<string, unknown>;
}

export interface ImageToModelOptions {
  fileType: TripoFileType;
  modelVersion?: string;
  texture?: boolean;
  pbr?: boolean;
  /** Omitted when undefined or ≤ 0 (Tripo picks adaptively). */
  faceLimit?: number;
}

export type TripoErrorKind = 'http' | 'api' | 'timeout' | 'network' | 'aborted' | 'invalid-response' | 'untrusted-host';

export class TripoError extends Error {
  constructor(
    message: string,
    readonly kind: TripoErrorKind,
    /** Upstream HTTP status, when there was a response. */
    readonly httpStatus?: number,
    /** Tripo's numeric `code` from the JSON envelope, when present. */
    readonly code?: number,
  ) {
    super(message);
    this.name = 'TripoError';
  }
}

export interface TripoTimeouts {
  uploadMs: number;
  requestMs: number;
  /** Model download: until the response headers arrive (over all redirect hops). */
  downloadMs: number;
  /** Model download: longest gap between two body chunks. */
  downloadIdleMs: number;
  /** Model download: hard cap on the whole transfer, far above any realistic one. */
  downloadTotalMs: number;
}

export const DEFAULT_TIMEOUTS: TripoTimeouts = {
  uploadMs: 60_000,
  requestMs: 20_000,
  downloadMs: 60_000,
  downloadIdleMs: 60_000,
  downloadTotalMs: 30 * 60_000,
};

export interface TripoClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeouts?: Partial<TripoTimeouts>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const KEY_LIKE = /tsk_[A-Za-z0-9_.-]+/g;

/** Replace secrets (and anything shaped like a Tripo key) in upstream text; cap its length. */
export function redactSecrets(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]');
  out = out.replace(KEY_LIKE, '[redacted]');
  return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}

/** Combine a timeout with an optional caller signal. */
function withTimeout(ms: number, signal?: AbortSignal): { signal: AbortSignal; timeout: AbortSignal } {
  const timeout = AbortSignal.timeout(ms);
  return { signal: signal ? AbortSignal.any([timeout, signal]) : timeout, timeout };
}

function transportError(e: unknown, timedOut: boolean, signal?: AbortSignal): TripoError {
  if (timedOut) return new TripoError('Tripo API request timed out', 'timeout');
  if (signal?.aborted) return new TripoError('Request aborted', 'aborted');
  if (e instanceof TripoError) return e;
  return new TripoError('Could not reach the Tripo API', 'network');
}

export class TripoClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeouts: TripoTimeouts;

  constructor(opts: TripoClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? TRIPO_API_BASE).replace(/\/+$/, '');
    // Wrapped so a bare global fetch is never called with a foreign `this`.
    const f = opts.fetch;
    this.fetchImpl = f ? (input, init) => f(input, init) : (input, init) => fetch(input, init);
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
  }

  /** Upload an image; returns the file token for createImageToModelTask. */
  async uploadImage(image: Blob | Uint8Array, mime: TripoImageMime, signal?: AbortSignal): Promise<string> {
    const blob = new Blob([image as BlobPart], { type: mime });
    let lastError: TripoError | null = null;
    for (const path of UPLOAD_PATHS) {
      const form = new FormData();
      form.append('file', blob, `image.${FILE_TYPE_BY_MIME[mime]}`);
      try {
        const data = await this.request(path, { method: 'POST', body: form }, this.timeouts.uploadMs, signal);
        // ASSUMPTION: `{ image_token }`; `file_token` accepted in case the field is renamed.
        const token = isRecord(data) ? data.image_token ?? data.file_token : undefined;
        if (typeof token !== 'string' || !token) throw new TripoError('Tripo upload returned no file token', 'invalid-response');
        return token;
      } catch (e) {
        if (e instanceof TripoError && e.kind === 'http' && (e.httpStatus === 404 || e.httpStatus === 405)) {
          lastError = e;
          continue;
        }
        throw e;
      }
    }
    throw lastError ?? new TripoError('Tripo upload endpoint not found', 'http', 404);
  }

  /** Start an image → model task; returns its id. */
  async createImageToModelTask(fileToken: string, opts: ImageToModelOptions, signal?: AbortSignal): Promise<string> {
    const body: Record<string, unknown> = {
      type: 'image_to_model',
      file: { type: opts.fileType, file_token: fileToken },
    };
    if (opts.modelVersion) body.model_version = opts.modelVersion;
    if (opts.texture !== undefined) body.texture = opts.texture;
    if (opts.pbr !== undefined) body.pbr = opts.pbr;
    if (opts.faceLimit !== undefined && opts.faceLimit > 0) body.face_limit = Math.round(opts.faceLimit);
    const data = await this.request(
      '/task',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      this.timeouts.requestMs,
      signal,
    );
    const id = isRecord(data) ? data.task_id : undefined;
    if (typeof id !== 'string' || !id) throw new TripoError('Tripo returned no task id', 'invalid-response');
    return id;
  }

  async getTask(taskId: string, signal?: AbortSignal): Promise<TripoTask> {
    const data = await this.request(`/task/${encodeURIComponent(taskId)}`, { method: 'GET' }, this.timeouts.requestMs, signal);
    if (!isRecord(data) || typeof data.status !== 'string') throw new TripoError('Invalid task response from Tripo', 'invalid-response');
    const progress = typeof data.progress === 'number' && Number.isFinite(data.progress) ? Math.min(100, Math.max(0, data.progress)) : 0;
    return {
      task_id: typeof data.task_id === 'string' ? data.task_id : taskId,
      type: typeof data.type === 'string' ? data.type : undefined,
      status: data.status,
      progress,
      output: isRecord(data.output) ? data.output : {},
    };
  }

  /** Authenticated call to the OpenAPI; returns the envelope's `data`. */
  private async request(path: string, init: RequestInit, timeoutMs: number, callerSignal?: AbortSignal): Promise<unknown> {
    const { signal, timeout } = withTimeout(timeoutMs, callerSignal);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.apiKey}`);
    headers.set('Accept', 'application/json');
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal });
      text = await res.text();
    } catch (e) {
      throw transportError(e, timeout.aborted, callerSignal);
    }
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const env = isRecord(json) ? json : null;
    const code = typeof env?.code === 'number' ? env.code : undefined;
    const describe = (fallback: string) => {
      const msg = typeof env?.message === 'string' && env.message ? env.message : fallback;
      const hint = typeof env?.suggestion === 'string' && env.suggestion ? ` (${env.suggestion})` : '';
      return redactSecrets(`${msg}${hint}${code !== undefined ? ` [code ${code}]` : ''}`, [this.apiKey]);
    };
    if (!res.ok) throw new TripoError(describe(`HTTP ${res.status}`), 'http', res.status, code);
    if (!env) throw new TripoError('Invalid response from the Tripo API', 'invalid-response', res.status);
    // ASSUMPTION: success is `code: 0`; a missing code on a 2xx is tolerated.
    if (code !== undefined && code !== 0) throw new TripoError(describe('Tripo API error'), 'api', res.status, code);
    return env.data;
  }
}

/** Best downloadable GLB of a finished task: PBR model, then textured model, then base mesh. */
export function resolveModelUrl(task: Pick<TripoTask, 'output'>): string | null {
  const pick = (v: unknown): string | null =>
    typeof v === 'string' && v ? v : isRecord(v) && typeof v.url === 'string' && v.url ? v.url : null;
  const o = task.output;
  return pick(o.pbr_model) ?? pick(o.model) ?? pick(o.base_model);
}

/** Parse a comma-separated host list (lower-cased, empty entries dropped). */
export function parseHostList(value: string | undefined): string[] | null {
  if (value === undefined || !value.trim()) return null;
  return value.split(',').map((h) => h.trim().toLowerCase().replace(/^\*?\./, '')).filter(Boolean);
}

/** True for https URLs whose host equals, or is a subdomain of, one of `allowedHosts`. */
export function isTrustedModelUrl(url: URL, allowedHosts: string[]): boolean {
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
}

export interface ModelDownloadOptions {
  allowedHosts: string[];
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Until the response headers arrive, over all redirect hops (default DEFAULT_TIMEOUTS.downloadMs). */
  timeoutMs?: number;
  /** Longest gap between two body chunks (default DEFAULT_TIMEOUTS.downloadIdleMs). */
  idleTimeoutMs?: number;
  /** Cap on the whole transfer, headers included (default DEFAULT_TIMEOUTS.downloadTotalMs). */
  totalTimeoutMs?: number;
  maxRedirects?: number;
  /**
   * Called exactly once when the download is over: the body finished, failed,
   * timed out or was cancelled, or this function threw.
   */
  onSettled?: () => void;
}

/**
 * Open a streaming download of a model URL returned by Tripo. Every hop
 * (including redirects) must pass the host allow-list, and no credentials are
 * sent. Throws TripoError('untrusted-host') with the refused host in `message`.
 *
 * The body is relayed at the browser's pace, so after the headers only
 * progress is timed (`idleTimeoutMs` between chunks), so a slow but moving
 * transfer is only cut by the generous `totalTimeoutMs`. A stalled or
 * over-long body errors with TripoError('timeout') and the upstream is closed.
 */
export async function openModelDownload(modelUrl: string, opts: ModelDownloadOptions): Promise<Response> {
  const f = opts.fetch ?? fetch;
  const maxRedirects = opts.maxRedirects ?? 3;
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    opts.onSettled?.();
  };
  let url: URL;
  try {
    url = new URL(modelUrl);
  } catch {
    settle();
    throw new TripoError('Tripo returned an invalid model URL', 'invalid-response');
  }

  const ctrl = new AbortController();
  const signal = opts.signal ? AbortSignal.any([ctrl.signal, opts.signal]) : ctrl.signal;
  let timeoutError: TripoError | null = null;
  const expire = (message: string) => () => {
    timeoutError ??= new TripoError(message, 'timeout');
    ctrl.abort(timeoutError);
  };
  const total = setTimeout(expire('Model download took too long'), opts.totalTimeoutMs ?? DEFAULT_TIMEOUTS.downloadTotalMs);
  const headersTimer = setTimeout(expire('Model download timed out'), opts.timeoutMs ?? DEFAULT_TIMEOUTS.downloadMs);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = () => {
    clearTimeout(total);
    clearTimeout(headersTimer);
    clearTimeout(idle);
  };

  let res: Response;
  try {
    for (let hop = 0; ; hop++) {
      if (!isTrustedModelUrl(url, opts.allowedHosts)) throw new TripoError(url.hostname || url.protocol, 'untrusted-host');
      try {
        res = await f(url.toString(), { method: 'GET', redirect: 'manual', credentials: 'omit', signal });
      } catch (e) {
        throw transportError(e, timeoutError !== null, opts.signal);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!location || hop >= maxRedirects) throw new TripoError('Too many redirects downloading the model', 'http', res.status);
        url = new URL(location, url);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new TripoError(`Model download failed (HTTP ${res.status})`, 'http', res.status);
      }
      break;
    }
  } catch (e) {
    clearTimers();
    settle();
    throw e;
  }
  clearTimeout(headersTimer);
  if (!res.body) {
    clearTimers();
    settle();
    return res;
  }

  // Relay the body, re-arming the idle timer on every chunk.
  const reader = res.body.getReader();
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_TIMEOUTS.downloadIdleMs;
  let finished = false;
  let out!: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => {
    finished = true;
    clearTimers();
    signal.removeEventListener('abort', onAbort);
    settle();
  };
  const onAbort = () => {
    if (finished) return;
    finish();
    const reason = timeoutError ?? new TripoError('Request aborted', 'aborted');
    out.error(reason);
    reader.cancel(reason).catch(() => {});
  };
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(expire('Model download stalled'), idleMs);
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(c) {
        out = c;
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        else arm();
      },
      async pull(c) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (!finished) {
            finish();
            c.error(timeoutError ?? e);
          }
          return;
        }
        if (finished) return;
        if (chunk.done) {
          finish();
          c.close();
        } else {
          arm();
          c.enqueue(chunk.value);
        }
      },
      cancel(reason) {
        finish();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
