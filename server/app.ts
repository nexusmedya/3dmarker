/**
 * 3D Marker API (Hono): a health check plus a thin proxy to Tripo3D's
 * image → 3D API, so the Tripo key stays on the server.
 *
 *   GET  /api/health                  { ok: true }
 *   GET  /api/tripo/status            { configured }
 *   POST /api/tripo/tasks             multipart `image` (+ model_version, texture, pbr, face_limit) → { taskId }
 *   GET  /api/tripo/tasks/:id         { status, progress, reason?, error? }
 *   GET  /api/tripo/tasks/:id/model   GLB stream (HEAD: headers only, no download)
 *
 * The three task routes require the `x-3dmarker-client: 1` header (sent by
 * our driver; see CLIENT_HEADER) and refuse cross-site Sec-Fetch-Site, so
 * other sites cannot spend the server's key through visitors' browsers.
 *
 * Key resolution: TRIPO_API_KEY, else the `x-tripo-key` header (the user's
 * own key; ignored when the server has one), else 401. Keys are never logged
 * or echoed; upstream messages are scrubbed. The model route looks the task
 * up itself (the client never supplies a URL) and only downloads from an
 * allow-listed host, so it cannot be used for SSRF.
 *
 * Limits per client IP: task creations per window (TRIPO_RATE_LIMIT[_BYOK]),
 * task/model reads per minute (TRIPO_READ_RATE_LIMIT), uploads and model
 * downloads in progress at once (a few; uploads are buffered in memory before
 * they are checked), plus TRIPO_MAX_CONCURRENT_UPLOADS over all clients.
 *
 * Environment (all optional, see ServerEnv): TRIPO_API_KEY, TRIPO_API_BASE,
 * TRIPO_ALLOWED_MODEL_HOSTS, TRIPO_RATE_LIMIT, TRIPO_RATE_LIMIT_BYOK,
 * TRIPO_RATE_WINDOW_SEC, TRIPO_READ_RATE_LIMIT, TRIPO_MAX_CONCURRENT_UPLOADS,
 * TRUST_PROXY, CROSS_ORIGIN_ISOLATION.
 */
import { isIP } from 'node:net';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getConnInfo } from '@hono/node-server/conninfo';
import {
  API_HEALTH_PATH,
  API_KEY_PATTERN,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  MAX_FACE_LIMIT,
  MAX_IMAGE_BYTES,
  MODEL_VERSION_PATTERN,
  TASK_ID_PATTERN,
  TRIPO_KEY_HEADER,
  TRIPO_STATUS_PATH,
  TRIPO_TASKS_PATH,
  type ApiErrorBody,
  type CreateTaskResponse,
  type StatusResponse,
  type TaskStateResponse,
} from '../src/drivers/cloud/api';
import {
  DEFAULT_MODEL_HOSTS,
  DEFAULT_TIMEOUTS,
  FILE_TYPE_BY_MIME,
  TRIPO_API_BASE,
  TripoClient,
  TripoError,
  openModelDownload,
  parseHostList,
  redactSecrets,
  resolveModelUrl,
  type ImageToModelOptions,
  type TripoTask,
} from './providers/tripo';
import { FixedWindowRateLimiter, InFlight } from './rateLimit';
import { sniffImageMime } from './sniff';

export interface ServerEnv {
  /** Server-side Tripo key. When set, user-supplied keys are ignored. */
  TRIPO_API_KEY?: string;
  /** Tripo OpenAPI base URL (default https://api.tripo3d.ai/v2/openapi). */
  TRIPO_API_BASE?: string;
  /** Comma-separated hosts (and their subdomains) models may be downloaded from; default DEFAULT_MODEL_HOSTS. */
  TRIPO_ALLOWED_MODEL_HOSTS?: string;
  /** Task creations per client IP and window with the server key (default 10, 0 = unlimited). */
  TRIPO_RATE_LIMIT?: string;
  /** Same, for requests using the user's own key (default 60, 0 = unlimited). */
  TRIPO_RATE_LIMIT_BYOK?: string;
  /** Rate-limit window in seconds (default 3600). */
  TRIPO_RATE_WINDOW_SEC?: string;
  /**
   * Task status polls + model downloads per client IP and minute (default 300,
   * 0 = unlimited). Each one is an upstream Tripo call with the server's key;
   * one generation polls about 30 times a minute, and users behind one NAT share it.
   */
  TRIPO_READ_RATE_LIMIT?: string;
  /**
   * Uploads being received at once over all clients (default 16, 0 = no cap).
   * Each is buffered in memory (a 20 MB image costs ~100 MB at peak), so this
   * bounds memory; the trade-off is that someone holding this many slow uploads
   * from many addresses delays everyone else's uploads until theirs time out.
   * One client IP can never have more than MAX_UPLOADS_PER_CLIENT in progress.
   */
  TRIPO_MAX_CONCURRENT_UPLOADS?: string;
  /** '1' behind exactly one reverse proxy: identify clients by the last X-Forwarded-For hop. */
  TRUST_PROXY?: string;
  /** '1' to send COEP: credentialless (with COOP) so onnxruntime-web can use threaded WASM. */
  CROSS_ORIGIN_ISOLATION?: string;
}

export interface AppDeps {
  /** Used for every upstream call (Tripo API and model downloads). */
  fetch?: typeof fetch;
  env?: ServerEnv;
  /** Clock for the rate limiter (ms). */
  now?: () => number;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

type KeySource = 'server' | 'user';
type Auth = { key: string; source: KeySource };

/** State handed from the pre-body middleware of POST /api/tripo/tasks to its handler. */
interface UploadSlot {
  auth: Auth;
  /** Rate-limit key: key source + client IP. */
  rateKey: string;
  /** Stop counting this upload as a pending window hit (call right before limiter.hit). */
  settle: () => void;
}

export type AppEnv = { Variables: { upload: UploadSlot } };

/** Uploads one client may have in progress (bodies are buffered before they can be checked). */
export const MAX_UPLOADS_PER_CLIENT = 3;
/** Model downloads one client may have in progress (each holds an upstream CDN connection). */
export const MAX_DOWNLOADS_PER_CLIENT = 4;
/** Retry-After for "too many in progress" answers. */
const BUSY_RETRY_SEC = 5;

const intEnv = (v: string | undefined, def: number): number => {
  if (v === undefined || !v.trim()) return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
};
const flagEnv = (v: string | undefined) => v === '1' || v?.toLowerCase() === 'true';

/** Multipart framing on top of the image itself. */
const FORM_OVERHEAD_BYTES = 64 * 1024;

const fail = (c: Context, status: ContentfulStatusCode, error: string) => c.json({ error } satisfies ApiErrorBody, status);

/** Rate-limit key for an address: IPv4 as-is, IPv6 by /64 (one subscriber usually owns a whole /64). */
export function rateKeyForIp(ip: string): string {
  const addr = ip.replace(/%.*$/, '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return mapped[1];
  if (!addr.includes(':')) return addr;
  const [head, tail = ''] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = addr.includes('::') ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * Last X-Forwarded-For hop → bare IP, or null when it is not an IP. Some
 * proxies (Azure, IIS ARR) append the client port ('1.2.3.4:5678',
 * '[2001:db8::1]:443'); that is stripped so every connection does not get a
 * fresh rate-limit bucket. Bare IPv6 is never port-stripped.
 */
export function parseForwardedHop(hop: string): string | null {
  const h = hop.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(h);
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(h);
  const ip = bracketed ? bracketed[1] : v4port ? v4port[1] : h;
  return isIP(ip) ? ip : null;
}

export function toTaskState(task: Pick<TripoTask, 'status' | 'progress'>): TaskStateResponse {
  const progress = Math.round(task.progress);
  switch (task.status) {
    case 'queued':
    case 'running':
    case 'unknown':
      return { status: task.status, progress };
    case 'success':
      return { status: 'success', progress: 100 };
    case 'failed':
      return { status: 'failed', progress, reason: 'failed', error: 'Tripo could not generate a model from this image' };
    case 'cancelled':
      return { status: 'cancelled', progress, error: 'The task was cancelled' };
    case 'banned':
      return { status: 'failed', progress, reason: 'banned', error: 'The image was rejected by Tripo content moderation' };
    case 'expired':
      return { status: 'failed', progress, reason: 'expired', error: 'The task expired on Tripo' };
    default:
      return { status: 'unknown', progress };
  }
}

type TaskFields = Omit<ImageToModelOptions, 'fileType'>;

/** Validate the optional multipart fields of POST /api/tripo/tasks. */
export function parseTaskFields(body: Record<string, unknown>): { ok: true; fields: TaskFields } | { ok: false; error: string } {
  const fields: TaskFields = {};
  const str = (k: string): string | undefined | null => {
    const v = body[k];
    if (v === undefined) return undefined;
    return typeof v === 'string' ? v.trim() : null;
  };
  const mv = str('model_version');
  if (mv === null) return { ok: false, error: 'model_version must be text' };
  if (mv && mv !== 'default') {
    if (!MODEL_VERSION_PATTERN.test(mv)) return { ok: false, error: 'Invalid model_version' };
    fields.modelVersion = mv;
  }
  for (const k of ['texture', 'pbr'] as const) {
    const v = str(k);
    if (v === undefined || v === '') continue;
    if (v !== 'true' && v !== 'false') return { ok: false, error: `${k} must be 'true' or 'false'` };
    fields[k] = v === 'true';
  }
  const fl = str('face_limit');
  if (fl) {
    if (!/^\d{1,7}$/.test(fl) || Number(fl) > MAX_FACE_LIMIT) return { ok: false, error: `face_limit must be an integer between 0 and ${MAX_FACE_LIMIT}` };
    if (Number(fl) > 0) fields.faceLimit = Number(fl);
  } else if (fl === null) {
    return { ok: false, error: 'face_limit must be text' };
  }
  return { ok: true, fields };
}

export function createApp(deps: AppDeps = {}): Hono<AppEnv> {
  const env: ServerEnv = deps.env ?? process.env;
  const log = deps.logger ?? console;
  const serverKey = env.TRIPO_API_KEY?.trim() || null;
  const apiBase = env.TRIPO_API_BASE?.trim() || TRIPO_API_BASE;
  const allowedHosts = parseHostList(env.TRIPO_ALLOWED_MODEL_HOSTS) ?? DEFAULT_MODEL_HOSTS;
  const limits: Record<KeySource, number> = {
    server: intEnv(env.TRIPO_RATE_LIMIT, 10),
    user: intEnv(env.TRIPO_RATE_LIMIT_BYOK, 60),
  };
  const limiter = new FixedWindowRateLimiter(intEnv(env.TRIPO_RATE_WINDOW_SEC, 3600) * 1000, deps.now);
  const readLimit = intEnv(env.TRIPO_READ_RATE_LIMIT, 300);
  const readLimiter = new FixedWindowRateLimiter(60_000, deps.now);
  const maxUploads = intEnv(env.TRIPO_MAX_CONCURRENT_UPLOADS, 16);
  /** Uploads from the pre-body check until the response (body buffering + Tripo upload). */
  const uploads = new InFlight();
  /** Uploads not yet counted by limiter.hit: they may still use up the rest of the window. */
  const pendingHits = new InFlight();
  const downloads = new InFlight();
  const trustProxy = flagEnv(env.TRUST_PROXY);
  let warnedBadForwardedFor = false;

  const tripo = (key: string) => new TripoClient({ apiKey: key, baseUrl: apiBase, fetch: deps.fetch });
  const scrub = (text: string, auth?: Auth) => redactSecrets(text, [serverKey ?? '', auth?.key ?? '']);

  /** Resolve the key to use for this request, or the 401 response. */
  const resolveKey = (c: Context): Auth | Response => {
    if (serverKey) return { key: serverKey, source: 'server' };
    const header = c.req.header(TRIPO_KEY_HEADER)?.trim();
    if (!header) {
      return fail(c, 401, 'No Tripo API key: the server has none configured, so provide your own key (x-tripo-key header)');
    }
    if (!API_KEY_PATTERN.test(header)) return fail(c, 401, 'The provided Tripo API key has an invalid format');
    return { key: header, source: 'user' };
  };

  const clientIp = (c: Context): string => {
    if (trustProxy) {
      const hops = (c.req.header('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const ip = hops.length ? parseForwardedHop(hops[hops.length - 1]) : null;
      if (ip) return rateKeyForIp(ip);
      if (hops.length && !warnedBadForwardedFor) {
        warnedBadForwardedFor = true;
        log.warn('TRUST_PROXY: unparseable X-Forwarded-For hop; rate-limiting by the proxy address instead');
      }
    }
    try {
      return rateKeyForIp(getConnInfo(c).remote.address ?? 'unknown');
    } catch {
      return 'unknown'; // no Node socket (e.g. app.request in tests)
    }
  };

  const tooMany = (c: Context, retryAfterSec: number) => {
    c.header('Retry-After', String(retryAfterSec));
    return fail(c, 429, `Too many generation requests; try again in ${Math.ceil(retryAfterSec / 60)} min`);
  };

  const busy = (c: Context, what: string) => {
    c.header('Retry-After', String(BUSY_RETRY_SEC));
    return fail(c, 429, `Too many ${what} in progress; try again in a few seconds`);
  };

  /** Map a failed upstream call to a JSON error; nothing secret leaves here. */
  const upstreamFailure = (c: Context, e: unknown, auth: Auth, op: 'create' | 'read'): Response => {
    if (!(e instanceof TripoError)) {
      log.error('Tripo proxy error:', scrub(e instanceof Error ? `${e.name}: ${e.message}` : String(e), auth));
      return fail(c, 502, 'Tripo request failed');
    }
    const msg = scrub(e.message, auth);
    switch (e.kind) {
      case 'timeout':
        return fail(c, 504, 'The Tripo API timed out');
      case 'network':
      case 'aborted':
        return fail(c, 502, 'Could not reach the Tripo API');
      case 'invalid-response':
        return fail(c, 502, msg);
      default:
        break;
    }
    const s = e.httpStatus ?? 502;
    if (s === 401) {
      if (auth.source === 'user') return fail(c, 401, 'Tripo rejected the API key');
      log.warn('Tripo rejected the server API key (TRIPO_API_KEY)');
      return fail(c, 502, "Tripo rejected the server's API key");
    }
    if (s === 402 || s === 403) return fail(c, s, `Tripo refused the request: ${msg}`);
    if (s === 404 && op === 'read') return fail(c, 404, 'Task not found');
    if (s === 429) return fail(c, 429, 'Tripo is rate limiting requests; try again shortly');
    if (s === 400 || s === 422) return fail(c, 400, `Tripo rejected the request: ${msg}`);
    return fail(c, 502, `Tripo API error: ${msg}`);
  };

  /**
   * Refuse cross-site use (drive-by spending of the server's credits from
   * visitors' browsers). Sec-Fetch-Site alone is not enough: browsers omit it
   * for plain-HTTP origins. Our client always sends CLIENT_HEADER, which other
   * sites cannot add without a CORS preflight that this server never approves.
   */
  const sameOriginOnly: MiddlewareHandler = async (c, next) => {
    const site = c.req.header('sec-fetch-site');
    if (site === 'cross-site' || site === 'same-site' || c.req.header(CLIENT_HEADER) !== CLIENT_HEADER_VALUE) {
      return fail(c, 403, 'Cross-site requests are not allowed');
    }
    await next();
  };

  /** Per-IP budget for the read routes: every call is an upstream Tripo request. */
  const readRate: MiddlewareHandler = async (c, next) => {
    const rate = readLimiter.hit(`read:${clientIp(c)}`, readLimit);
    if (!rate.allowed) {
      c.header('Retry-After', String(rate.retryAfterSec));
      return fail(c, 429, 'Too many requests; try again shortly');
    }
    await next();
  };

  const app = new Hono<AppEnv>();

  app.use(
    '*',
    // No CSP: the SPA needs wasm (+ WebGPU), module workers, blob: URLs and
    // model downloads from Hugging Face; a policy that allows all of that
    // adds little, and a wrong one silently breaks inference.
    secureHeaders({
      crossOriginEmbedderPolicy: flagEnv(env.CROSS_ORIGIN_ISOLATION) ? 'credentialless' : false,
      strictTransportSecurity: 'max-age=15552000',
    }),
  );
  app.use('/api/*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store');
  });

  app.get(API_HEALTH_PATH, (c) => c.json({ ok: true }));

  app.get(TRIPO_STATUS_PATH, (c) => c.json({ configured: serverKey !== null } satisfies StatusResponse));

  app.post(
    TRIPO_TASKS_PATH,
    sameOriginOnly,
    // Cheap checks before the body is read, and a slot held until the response:
    // bodies are buffered in memory, and invalid ones never count as hits.
    async (c, next) => {
      const auth = resolveKey(c);
      if (auth instanceof Response) return auth;
      const rateKey = `${auth.source}:${clientIp(c)}`;
      const rate = limiter.peek(rateKey, limits[auth.source]);
      if (!rate.allowed) return tooMany(c, rate.retryAfterSec);
      if (
        uploads.count(rateKey) >= MAX_UPLOADS_PER_CLIENT ||
        (maxUploads > 0 && uploads.total >= maxUploads) ||
        // Uploads still arriving could use up the rest of the window: let them finish first.
        rate.remaining <= pendingHits.count(rateKey)
      ) {
        return busy(c, 'uploads');
      }
      const release = uploads.acquire(rateKey);
      const settle = pendingHits.acquire(rateKey);
      c.set('upload', { auth, rateKey, settle });
      try {
        await next();
      } finally {
        settle();
        release();
      }
    },
    bodyLimit({
      maxSize: MAX_IMAGE_BYTES + FORM_OVERHEAD_BYTES,
      onError: (c) => fail(c, 413, `Image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`),
    }),
    async (c) => {
      const { auth, rateKey, settle } = c.get('upload');
      let body: Record<string, unknown>;
      try {
        body = await c.req.parseBody();
      } catch {
        return fail(c, 400, 'Expected multipart/form-data with an "image" file');
      }
      const image = body.image;
      if (!(image instanceof Blob)) return fail(c, 400, 'Missing "image" file');
      if (image.size === 0) return fail(c, 400, 'The image is empty');
      if (image.size > MAX_IMAGE_BYTES) return fail(c, 413, `Image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
      const mime = sniffImageMime(new Uint8Array(await image.slice(0, 16).arrayBuffer()));
      if (!mime) return fail(c, 415, 'Unsupported image type: upload a PNG, JPEG or WEBP file');
      const parsed = parseTaskFields(body);
      if (!parsed.ok) return fail(c, 400, parsed.error);

      const limit = limits[auth.source];
      settle(); // from here on the window count covers this upload
      const rate = limiter.hit(rateKey, limit);
      if (!rate.allowed) return tooMany(c, rate.retryAfterSec);
      if (limit > 0) {
        c.header('X-RateLimit-Limit', String(limit));
        c.header('X-RateLimit-Remaining', String(rate.remaining));
      }

      const client = tripo(auth.key);
      const signal = c.req.raw.signal;
      try {
        const token = await client.uploadImage(image, mime, signal);
        const taskId = await client.createImageToModelTask(token, { fileType: FILE_TYPE_BY_MIME[mime], ...parsed.fields }, signal);
        log.info(`Tripo task ${taskId} created (${auth.source} key)`);
        return c.json({ taskId } satisfies CreateTaskResponse);
      } catch (e) {
        return upstreamFailure(c, e, auth, 'create');
      }
    },
  );

  app.get(`${TRIPO_TASKS_PATH}/:id`, sameOriginOnly, readRate, async (c) => {
    const id = c.req.param('id');
    if (!TASK_ID_PATTERN.test(id)) return fail(c, 400, 'Invalid task id');
    const auth = resolveKey(c);
    if (auth instanceof Response) return auth;
    try {
      const task = await tripo(auth.key).getTask(id, c.req.raw.signal);
      return c.json(toTaskState(task));
    } catch (e) {
      return upstreamFailure(c, e, auth, 'read');
    }
  });

  app.get(`${TRIPO_TASKS_PATH}/:id/model`, sameOriginOnly, readRate, async (c) => {
    const id = c.req.param('id');
    if (!TASK_ID_PATTERN.test(id)) return fail(c, 400, 'Invalid task id');
    const auth = resolveKey(c);
    if (auth instanceof Response) return auth;
    let url: string | null;
    try {
      const task = await tripo(auth.key).getTask(id, c.req.raw.signal);
      if (task.status !== 'success') return fail(c, 409, 'The model is not ready yet');
      url = resolveModelUrl(task);
    } catch (e) {
      return upstreamFailure(c, e, auth, 'read');
    }
    if (!url) return fail(c, 502, 'Tripo returned no model for this task');

    const headers = new Headers({
      'Content-Type': 'model/gltf-binary',
      'Content-Disposition': `attachment; filename="tripo-${id}.glb"`,
      'Cache-Control': 'private, no-store',
    });
    // Hono answers HEAD with this handler and drops the body without cancelling
    // it, so never open the CDN download for one (the size is unknown here).
    if (c.req.method === 'HEAD') return c.body(null, 200, Object.fromEntries(headers));

    const ip = clientIp(c);
    if (downloads.count(ip) >= MAX_DOWNLOADS_PER_CLIENT) return busy(c, 'model downloads');
    let upstream: Response;
    try {
      upstream = await openModelDownload(url, {
        allowedHosts,
        fetch: deps.fetch,
        signal: c.req.raw.signal,
        timeoutMs: DEFAULT_TIMEOUTS.downloadMs,
        idleTimeoutMs: DEFAULT_TIMEOUTS.downloadIdleMs,
        totalTimeoutMs: DEFAULT_TIMEOUTS.downloadTotalMs,
        // Held until the relayed body is finished, failed, stalled or cancelled.
        onSettled: downloads.acquire(ip),
      });
    } catch (e) {
      if (e instanceof TripoError && e.kind === 'untrusted-host') {
        log.warn(`Refused model download from untrusted host "${e.message}" (task ${id}); add it to TRIPO_ALLOWED_MODEL_HOSTS if it belongs to Tripo`);
        return fail(c, 502, 'The model is hosted on a domain this server does not trust (TRIPO_ALLOWED_MODEL_HOSTS)');
      }
      if (e instanceof TripoError && e.kind === 'http') return fail(c, 502, scrub(e.message, auth));
      return upstreamFailure(c, e, auth, 'read');
    }

    const length = upstream.headers.get('content-length');
    // fetch transparently decodes gzip/br, so the length is only valid for identity bodies.
    if (length && /^\d+$/.test(length) && !upstream.headers.get('content-encoding')) headers.set('Content-Length', length);
    return new Response(upstream.body, { status: 200, headers });
  });

  // Unmatched API paths stay JSON (and never fall through to the SPA fallback).
  app.all('/api/*', (c) => fail(c, 404, 'Not found'));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return fail(c, err.status as ContentfulStatusCode, err.message || 'Request failed');
    log.error('Unhandled server error:', scrub(err instanceof Error ? `${err.name}: ${err.message}` : String(err)));
    return fail(c, 500, 'Internal server error');
  });

  return app;
}
