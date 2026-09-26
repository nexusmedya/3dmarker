/**
 * HTTP transport of the AI adapters: direct browser calls vs our server
 * proxy, auth headers per kind, timeouts, abort, and turning HTTP / network
 * failures into bilingual AiErrors. Output files (generated images, GLBs) are
 * downloaded directly, or through GET /api/ai/fetch when CORS blocks that.
 *
 * Routing: a managed config (key held by the server) and kinds without CORS
 * support always go through `/api/ai/proxy/<kind>/<path>`; the server injects
 * its key or relays the user's key from `x-ai-key`, and only talks to the
 * kind's fixed API host. Everything else calls the API host directly with the
 * user's own key.
 */
import type { ProviderConfig, ProviderKindId } from './types';
import { AbortError, type I18nText } from '../core/types';
import { LocalizedError } from '../core/errors';
import {
  AI_AUTH_HEADER,
  AI_BASE_HEADER,
  AI_FETCH_PATH,
  AI_KEY_HEADER,
  AI_PROVIDERS_PATH,
  AI_PROXY_BASES,
  AI_PROXY_ERROR_HEADER,
  AI_PROXY_PATH,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  aiFetchPath,
  aiProxyPath,
} from '../drivers/cloud/api';
import { getProviderKind, isProviderKindId, kindNeedsKey } from './kinds';
import { dataUriToBlob, withSniffedType } from './encode';

// The wire contract lives in src/drivers/cloud/api.ts (shared with server/ai/).
export { AI_AUTH_HEADER, AI_BASE_HEADER, AI_FETCH_PATH, AI_KEY_HEADER, AI_PROVIDERS_PATH, AI_PROXY_ERROR_HEADER, AI_PROXY_PATH };

/** Fixed API hosts per kind (the proxy uses the same table). */
export const KIND_BASES: Partial<Record<ProviderKindId, string>> = AI_PROXY_BASES;
/** fal's queue API; paths starting with 'queue/' go here. */
export const FAL_QUEUE_BASE = 'https://queue.fal.run';

/** Timing knobs (mutable so tests can shorten them). */
export const aiTiming = {
  /** Delay between status polls of async jobs. */
  pollMs: 2000,
  /** One request (image edits can take a couple of minutes). */
  requestTimeoutMs: 5 * 60_000,
  /** One status poll. */
  pollTimeoutMs: 30_000,
  /** A whole async job (queue + generation). */
  maxJobMs: 20 * 60_000,
  /** Downloading an output file. */
  downloadTimeoutMs: 3 * 60_000,
  /** First back-off delay of a retried idempotent request (doubles per attempt, with jitter). */
  retryBaseMs: 1000,
  /** Longest back-off delay between retries. */
  retryMaxMs: 15_000,
  /** Attempts of a retried idempotent request (the first one included). */
  retryAttempts: 4,
};

export type AiErrorCode =
  | 'network'
  | 'needs-server'
  | 'missing-key'
  | 'key-format'
  | 'auth'
  | 'forbidden'
  | 'billing'
  | 'rate-limit'
  | 'content-policy'
  | 'bad-request'
  | 'not-found'
  | 'too-large'
  | 'server'
  | 'timeout'
  | 'bad-response'
  | 'unsupported'
  | 'failed';

/** User-facing AI error: bilingual text plus a machine-readable code and the HTTP status (0 = none). */
export class AiError extends LocalizedError {
  constructor(
    i18n: I18nText,
    readonly code: AiErrorCode,
    readonly status = 0,
    readonly detail = '',
  ) {
    super(i18n);
    this.name = 'AiError';
  }

  /** Seconds the provider asked us to wait (Retry-After, Google RetryInfo, OpenAI "try again in"). */
  retryAfterSec: number | null = null;
}

export type Route = 'direct' | 'proxy';

/** Zero-width characters that often come along when a key is copied from a web page. */
const INVISIBLE = /[​-‍⁠﻿]/g;
/** Header-safe key: printable ASCII without spaces (fetch throws on anything else). */
const KEY_PATTERN = /^[\x21-\x7e]{1,1000}$/;

export function cleanKey(key: string): string {
  return key.replace(INVISIBLE, '').trim();
}

export function providerName(cfg: Pick<ProviderConfig, 'kind' | 'label'>): string {
  if (cfg.label.trim()) return cfg.label.trim();
  return isProviderKindId(cfg.kind) ? getProviderKind(cfg.kind).name : cfg.kind;
}

/** How requests of this config travel. */
export function routeFor(cfg: Pick<ProviderConfig, 'kind' | 'managed' | 'values'>): Route {
  if (cfg.kind === 'custom-http') return 'direct';
  if (cfg.managed) return 'proxy';
  if (cfg.kind === 'openai-compatible') return cfg.values.direct === false ? 'proxy' : 'direct';
  return getProviderKind(cfg.kind).browserDirect ? 'direct' : 'proxy';
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Absolute API URL of `path` for a direct call. */
export function directUrl(cfg: Pick<ProviderConfig, 'kind' | 'values'>, path: string): string {
  const p = path.replace(/^\/+/, '');
  if (cfg.kind === 'openai-compatible') return joinUrl(String(cfg.values.baseUrl ?? ''), p);
  if (cfg.kind === 'fal' && p.startsWith('queue/')) return joinUrl(FAL_QUEUE_BASE, p.slice('queue/'.length));
  const base = KIND_BASES[cfg.kind];
  if (!base) throw new Error(`No API base for ${cfg.kind}`);
  return joinUrl(base, p);
}

/** Same-origin proxy URL of `path`. */
export function proxyUrl(kind: ProviderKindId, path: string): string {
  return aiProxyPath(kind, path);
}

/** Auth header of a direct call. */
export function authHeaders(cfg: Pick<ProviderConfig, 'kind' | 'values'>, key: string): Record<string, string> {
  if (!key) return {};
  switch (cfg.kind) {
    case 'gemini':
      return { 'x-goog-api-key': key };
    case 'fal':
      return { Authorization: `Key ${key}` };
    case 'openai-compatible': {
      const mode = cfg.values.authHeader;
      if (mode === 'none') return {};
      if (mode === 'api-key') return { 'api-key': key };
      return { Authorization: `Bearer ${key}` };
    }
    case 'custom-http':
      return {};
    default:
      return { Authorization: `Bearer ${key}` };
  }
}

const T = {
  missingKey: (n: string): I18nText => ({
    tr: `${n} için API anahtarı girilmemiş. AI sağlayıcı ayarlarından anahtarı ekleyin.`,
    en: `No API key is set for ${n}. Add it in the AI provider settings.`,
  }),
  keyFormat: (n: string): I18nText => ({
    tr: `${n} API anahtarı geçersiz karakterler içeriyor. Kopyalarken gelen boşluk, tırnak ya da görünmez karakterleri silin.`,
    en: `The ${n} API key contains invalid characters. Remove any spaces, quotes or hidden characters picked up when copying it.`,
  }),
  network: (n: string): I18nText => ({
    tr: `${n} sunucusuna ulaşılamadı. Tarayıcı isteği engellemiş olabilir (CORS ya da ağ filtresi); bu sağlayıcı için sunucu vekili gerekebilir. Bağlantınızı kontrol edin.`,
    en: `Could not reach ${n}. The browser may have blocked the request (CORS or a network filter); this provider may need the server proxy. Check your connection.`,
  }),
  needsServer: (n: string): I18nText => ({
    tr: `${n} isteği 3D Marker sunucusu üzerinden gitmeli, ancak sunucuya ya da AI vekiline ulaşılamadı (statik demoda sunucu yoktur). Tarayıcıdan doğrudan çağrılabilen bir sağlayıcı (OpenAI, Gemini, fal.ai) kullanın ya da uygulamayı sunucusuyla çalıştırın.`,
    en: `${n} requests must go through the 3D Marker server, but the server or its AI proxy could not be reached (the static demo has no server). Use a provider the browser can call directly (OpenAI, Gemini, fal.ai) or run the app with its server.`,
  }),
  auth: (n: string, d: string): I18nText => ({
    tr: `${n} API anahtarı geçersiz ya da reddedildi${d ? ` (${d})` : ''}. Anahtarı kontrol edin.`,
    en: `The ${n} API key is invalid or was rejected${d ? ` (${d})` : ''}. Please check it.`,
  }),
  forbidden: (n: string, d: string): I18nText => ({
    tr: `${n} bu isteğe izin vermedi (anahtarın yetkisi, hesap doğrulaması ya da model erişimi)${d ? `: ${d}` : '.'}`,
    en: `${n} did not allow this request (key permissions, account verification or model access)${d ? `: ${d}` : '.'}`,
  }),
  billing: (n: string, d: string): I18nText => ({
    tr: `${n}: kredi / kota yetersiz ya da faturalandırma gerekli${d ? ` (${d})` : ''}.`,
    en: `${n}: out of credits / quota, or billing is required${d ? ` (${d})` : ''}.`,
  }),
  rateLimit: (n: string, sec: number | null): I18nText => ({
    tr: `${n} hız sınırına takıldı; ${sec ? `${sec} sn sonra` : 'biraz sonra'} tekrar deneyin.`,
    en: `${n} rate limit reached; try again ${sec ? `in ${sec} s` : 'shortly'}.`,
  }),
  contentPolicy: (n: string, d: string): I18nText => ({
    tr: `${n} içerik politikası isteği reddetti (görsel ya da istem güvenlik filtresine takıldı)${d ? `: ${d}` : ''}. Başka bir görsel, stil ya da açıklama deneyin.`,
    en: `${n} rejected the request under its content policy (the image or prompt hit a safety filter)${d ? `: ${d}` : ''}. Try another image, style or description.`,
  }),
  badRequest: (n: string, d: string): I18nText => ({
    tr: `${n} isteği geçersiz buldu${d ? `: ${d}` : '.'} Model adını ve ayarları kontrol edin.`,
    en: `${n} rejected the request as invalid${d ? `: ${d}` : '.'} Check the model id and settings.`,
  }),
  notFound: (n: string, d: string): I18nText => ({
    tr: `${n}: model ya da uç nokta bulunamadı${d ? ` (${d})` : ''}. Model kimliğini kontrol edin.`,
    en: `${n}: model or endpoint not found${d ? ` (${d})` : ''}. Check the model id.`,
  }),
  tooLarge: (n: string): I18nText => ({
    tr: `${n} için gönderilen görsel çok büyük.`,
    en: `The image sent to ${n} is too large.`,
  }),
  server: (n: string, status: number, d: string): I18nText => ({
    tr: `${n} geçici bir hata döndürdü (HTTP ${status}${d ? `: ${d}` : ''}); biraz sonra tekrar deneyin.`,
    en: `${n} returned a temporary error (HTTP ${status}${d ? `: ${d}` : ''}); try again shortly.`,
  }),
  timeout: (n: string, sec: number): I18nText => ({
    tr: `${n} ${sec} sn içinde yanıt vermedi.`,
    en: `${n} did not respond within ${sec} s.`,
  }),
  badResponse: (n: string, d: string): I18nText => ({
    tr: `${n} beklenmeyen bir yanıt döndürdü${d ? `: ${d}` : ''}.`,
    en: `${n} returned an unexpected response${d ? `: ${d}` : ''}.`,
  }),
  notProxied: (n: string, d: string): I18nText => ({
    tr: `3D Marker sunucusu ${n} isteklerini iletmiyor${d ? ` (${d})` : ''}. Sunucu yöneticisinin bu sağlayıcıyı açması gerekir.`,
    en: `The 3D Marker server does not forward ${n} requests${d ? ` (${d})` : ''}. The server admin has to enable this provider.`,
  }),
  downloadFailed: (d: string): I18nText => ({
    tr: `Üretilen dosya indirilemedi${d ? ` (${d})` : ''}. Sağlayıcının dosya adresi tarayıcıdan erişilemiyor olabilir; sunucu ile çalıştırmayı deneyin.`,
    en: `The generated file could not be downloaded${d ? ` (${d})` : ''}. The provider’s file URL may not be reachable from the browser; try running with the server.`,
  }),
};

export const AI_ERROR_TEXT = T;

const POLICY = /moderation|content[_ ]?policy|safety|nsfw|prohibited|violat|inappropriate|flagged|blocked|sensitive/i;
const KEY_INVALID = /api[_ ]?key.*(invalid|not valid|incorrect)|(invalid|incorrect).*api[_ ]?key|API_KEY_INVALID|unauthenticated/i;
const BILLING = /insufficient[_ ]?quota|billing|credit|payment|balance|exceeded your current quota/i;

/** "12s" / "12.5s" (Google Duration JSON) → whole seconds. */
function durationSec(v: unknown): number | null {
  const m = typeof v === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(v.trim()) : null;
  return m ? Math.max(1, Math.ceil(Number(m[1]))) : null;
}

/** OpenAI's "Please try again in 12s" / "in 820ms" → whole seconds. */
function tryAgainSec(message: string): number | null {
  const m = /try again in (\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(message);
  if (!m) return null;
  const sec = m[2].toLowerCase() === 'ms' ? Number(m[1]) / 1000 : Number(m[1]);
  return Number.isFinite(sec) ? Math.max(1, Math.ceil(sec)) : null;
}

/**
 * Error message and code-ish text out of the usual provider error bodies
 * (Google details[]: reasons, QuotaFailure quota ids, RetryInfo delay).
 */
export function extractErrorDetail(body: unknown): { message: string; codes: string; retryAfterSec?: number } {
  if (typeof body === 'string') {
    const text = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return { message: text.slice(0, 200), codes: '' };
  }
  if (!body || typeof body !== 'object') return { message: '', codes: '' };
  const o = body as Record<string, unknown>;
  const codes: string[] = [];
  const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  let message = '';
  let retry: number | null = null;
  const err = o.error;
  if (err && typeof err === 'object') {
    // OpenAI { error: { message, type, code } }, Google { error: { code, message, status, details } }
    const e = err as Record<string, unknown>;
    message = str(e.message);
    codes.push(str(e.type), str(e.code), str(e.status));
    if (Array.isArray(e.details)) {
      for (const d of e.details) {
        if (!d || typeof d !== 'object') continue;
        const dd = d as Record<string, unknown>;
        codes.push(str(dd.reason));
        retry = durationSec(dd.retryDelay) ?? retry; // google.rpc.RetryInfo
        if (Array.isArray(dd.violations)) {
          // google.rpc.QuotaFailure
          for (const v of dd.violations) if (v && typeof v === 'object') codes.push(str((v as Record<string, unknown>).quotaId));
        }
      }
    }
  } else if (typeof err === 'string') {
    message = err; // our server, Replicate prediction errors
  }
  if (!message && typeof o.detail === 'string') message = o.detail; // Replicate / fal
  if (!message && Array.isArray(o.detail)) {
    // fal / FastAPI validation errors [{ loc, msg, type }]
    message = o.detail
      .map((d) => (d && typeof d === 'object' ? `${(Array.isArray((d as Record<string, unknown>).loc) ? ((d as Record<string, unknown>).loc as unknown[]).join('.') + ': ' : '')}${str((d as Record<string, unknown>).msg)}` : str(d)))
      .filter(Boolean)
      .join('; ');
  }
  if (!message && Array.isArray(o.errors)) message = o.errors.map(str).filter(Boolean).join('; '); // Stability { name, errors }
  if (!message) message = str(o.message) || str(o.title);
  codes.push(str(o.name), str(o.code), str(o.title), str(o.type));
  retry ??= tryAgainSec(message);
  const out: { message: string; codes: string; retryAfterSec?: number } = { message: message.replace(/\s+/g, ' ').trim(), codes: codes.filter(Boolean).join(' ') };
  if (retry !== null) out.retryAfterSec = retry;
  return out;
}

function scrub(text: string, key?: string): string {
  let s = text;
  if (key && key.length >= 6) s = s.split(key).join('***');
  s = s.replace(/\b(sk-|r8_|tsk_|AIza)[-_A-Za-z0-9]{12,}/g, '***');
  return s.length > 300 ? `${s.slice(0, 297)}…` : s;
}

export interface ErrorContext {
  /** Provider name shown to the user. */
  name: string;
  route: Route;
  /** The user's key, scrubbed from echoed messages. */
  key?: string;
  retryAfterSec?: number | null;
  /** Proxy responses that look like "no such route" mean the server lacks the proxy. */
  contentType?: string;
  /** The error came from our proxy itself (AI_PROXY_ERROR_HEADER), not from the provider. */
  proxyError?: boolean;
}

/** Bilingual error for a non-2xx response. */
export function errorFromStatus(status: number, body: unknown, ctx: ErrorContext): AiError {
  const e = classifyStatus(status, body, ctx);
  if (e.code === 'rate-limit' || e.code === 'server' || e.code === 'needs-server') {
    e.retryAfterSec = ctx.retryAfterSec ?? extractErrorDetail(body).retryAfterSec ?? null;
  }
  return e;
}

/** Per-minute style limits vs. an exhausted quota / missing billing (429 bodies of OpenAI and Google). */
const RATE_CODE = /rate[_ ]?limit[_ ]?exceeded|RESOURCE_EXHAUSTED/i;
const QUOTA_CODE = /insufficient[_ ]?quota/i;
const BILLING_QUOTA_ID = /PerDay|Billing/i;

function classifyStatus(status: number, body: unknown, ctx: ErrorContext): AiError {
  const { name } = ctx;
  const { message, codes, retryAfterSec } = extractErrorDetail(body);
  const d = scrub(message, ctx.key);
  const all = `${message} ${codes}`;
  // Our server's routes answer "No <provider> API key: …" when neither it nor the user has one.
  if (ctx.route === 'proxy' && status === 401 && /^no\b.*key/i.test(message)) return new AiError(T.missingKey(name), 'missing-key', status, d);
  if (ctx.route === 'proxy' && ctx.proxyError) {
    if (status === 404) return new AiError(T.notProxied(name, d), 'needs-server', status, d);
  } else if (ctx.route === 'proxy') {
    const ct = (ctx.contentType ?? '').toLowerCase();
    const serverMissing =
      ((status === 404 || status === 405) && !ct.includes('json')) ||
      (status === 404 && message === 'Not found') ||
      (status === 502 && typeof body === 'string' && !body.trim());
    if (serverMissing) return new AiError(T.needsServer(name), 'needs-server', status, d);
  }
  if (status === 401 || KEY_INVALID.test(all)) return new AiError(T.auth(name, d), 'auth', status, d);
  if ((status === 400 || status === 403 || status === 422 || status === 451) && POLICY.test(all)) {
    return new AiError(T.contentPolicy(name, d), 'content-policy', status, d);
  }
  if (status === 429) {
    // Machine codes first: rate-limit messages often mention billing / "exceeded your current quota" too.
    const billing = QUOTA_CODE.test(codes) || (RATE_CODE.test(codes) ? BILLING_QUOTA_ID.test(codes) : BILLING.test(all));
    if (billing) return new AiError(T.billing(name, d), 'billing', status, d);
    return new AiError(T.rateLimit(name, ctx.retryAfterSec ?? retryAfterSec ?? null), 'rate-limit', status, d);
  }
  if (status === 402 || ((status === 403 || status === 400) && BILLING.test(all))) {
    return new AiError(T.billing(name, d), 'billing', status, d);
  }
  if (status === 403) return new AiError(T.forbidden(name, d), 'forbidden', status, d);
  if (status === 404) return new AiError(T.notFound(name, d), 'not-found', status, d);
  if (status === 413) return new AiError(T.tooLarge(name), 'too-large', status, d);
  if (status >= 500) return new AiError(T.server(name, status, d), 'server', status, d);
  if (status >= 400) return new AiError(T.badRequest(name, d), 'bad-request', status, d);
  return new AiError(T.badResponse(name, d || `HTTP ${status}`), 'bad-response', status, d);
}

/** Bilingual error for a network-level failure (no HTTP response). */
export function networkError(ctx: ErrorContext): AiError {
  return ctx.route === 'proxy' ? new AiError(T.needsServer(ctx.name), 'needs-server') : new AiError(T.network(ctx.name), 'network');
}

async function readBody(res: Response): Promise<unknown> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return '';
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function retryAfter(res: Response): number | null {
  const v = Number(res.headers.get('retry-after'));
  return Number.isFinite(v) && v > 0 ? Math.ceil(v) : null;
}

/** AbortSignal that fires on the caller's abort or after `ms`. */
function linkedSignal(signal: AbortSignal, ms: number): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const ctl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctl.abort(signal.reason);
  if (signal.aborted) ctl.abort(signal.reason);
  else signal.addEventListener('abort', onAbort, { once: true });
  const timer =
    ms > 0 && Number.isFinite(ms)
      ? setTimeout(() => {
          timedOut = true;
          ctl.abort(new Error('timeout'));
        }, ms)
      : undefined;
  return {
    signal: ctl.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    },
  };
}

export interface SendInit extends Omit<RequestInit, 'signal' | 'headers'> {
  signal: AbortSignal;
  headers?: Record<string, string>;
  /** Default aiTiming.requestTimeoutMs; 0 = none. */
  timeoutMs?: number;
}

/**
 * The response with its body re-streamed so that the timeout and the caller's
 * abort keep applying until the body has been read (or cancelled); a failed
 * body read rejects with AbortError / AiError 'timeout' / a network AiError.
 */
function guardBody(res: Response, link: ReturnType<typeof linkedSignal>, failure: () => Error): Response {
  if (!res.body || res.status === 204 || res.status === 205) {
    link.dispose();
    return res;
  }
  const reader = res.body.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    link.dispose();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const r = await reader.read();
        if (r.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(r.value);
        }
      } catch {
        const err = failure();
        finish();
        controller.error(err);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * fetch with timeout and error normalisation: resolves with a 2xx Response,
 * throws AbortError on the caller's abort and AiError otherwise. The timeout
 * and the abort also cover reading the returned response's body.
 */
export async function send(url: string, init: SendInit, ctx: ErrorContext): Promise<Response> {
  const { signal, timeoutMs, headers, ...rest } = init;
  if (signal.aborted) throw new AbortError();
  const ms = timeoutMs ?? aiTiming.requestTimeoutMs;
  const link = linkedSignal(signal, ms);
  const failure = (): Error => {
    if (signal.aborted) return new AbortError();
    if (link.timedOut()) return new AiError(T.timeout(ctx.name, Math.round(ms / 1000)), 'timeout');
    return networkError(ctx);
  };
  let res: Response;
  try {
    res = await fetch(url, { ...rest, headers, signal: link.signal });
  } catch {
    link.dispose();
    throw failure();
  }
  if (res.ok) return guardBody(res, link, failure);
  let body: unknown;
  try {
    body = await readBody(res);
  } finally {
    link.dispose();
  }
  if (signal.aborted) throw new AbortError();
  throw errorFromStatus(res.status, body, {
    ...ctx,
    retryAfterSec: retryAfter(res),
    contentType: res.headers.get('content-type') ?? '',
    proxyError: res.headers.get(AI_PROXY_ERROR_HEADER) === '1',
  });
}

export type AiFetchInit = SendInit;

/** The config's key, validated (empty for managed configs). */
export function configKey(cfg: ProviderConfig): string {
  if (cfg.managed) return '';
  const key = cleanKey(cfg.apiKey);
  const name = providerName(cfg);
  if (!key && kindNeedsKey(cfg.kind)) throw new AiError(T.missingKey(name), 'missing-key');
  if (key && !KEY_PATTERN.test(key)) throw new AiError(T.keyFormat(name), 'key-format');
  return key;
}

/** The URL and headers a request of this config to `path` uses (exported for tests and the adapters). */
export function requestTarget(cfg: ProviderConfig, path: string): { url: string; headers: Record<string, string>; route: Route; key: string } {
  const key = configKey(cfg);
  const route = routeFor(cfg);
  if (route === 'direct') return { url: directUrl(cfg, path), headers: authHeaders(cfg, key), route, key };
  const headers: Record<string, string> = { [CLIENT_HEADER]: CLIENT_HEADER_VALUE };
  if (key) headers[AI_KEY_HEADER] = key;
  if (cfg.kind === 'openai-compatible') {
    // Proxied only when the server lists this exact base (AI_PROXY_EXTRA_BASES).
    headers[AI_BASE_HEADER] = String(cfg.values.baseUrl ?? '').trim();
    headers[AI_AUTH_HEADER] = cfg.values.authHeader === 'api-key' ? 'api-key' : 'bearer';
  }
  return { url: proxyUrl(cfg.kind, path), headers, route, key };
}

/**
 * Calls `path` of the config's API (relative to the kind's fixed base, e.g.
 * 'v1/images/edits'; for fal 'queue/<model>' targets the queue host).
 */
export async function aiFetch(cfg: ProviderConfig, path: string, init: AiFetchInit): Promise<Response> {
  const target = requestTarget(cfg, path);
  return send(
    target.url,
    { ...init, headers: { ...target.headers, ...(init.headers ?? {}) } },
    { name: providerName(cfg), route: target.route, key: target.key },
  );
}

/** Parses a JSON response body; AiError 'bad-response' when it is not JSON (timeouts / network errors while reading pass through). */
export async function readJson<T = unknown>(res: Response, name: string, signal: AbortSignal): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (e) {
    if (signal.aborted || e instanceof AbortError) throw new AbortError();
    if (e instanceof AiError) throw e;
    throw new AiError(T.badResponse(name, 'invalid JSON'), 'bad-response', res.status);
  }
}

/** Worth retrying an idempotent request after this error (network blips, timeouts, 408 / 425 / 429 / 5xx)? */
export function isTransientError(e: unknown): boolean {
  if (!(e instanceof AiError)) return false;
  switch (e.code) {
    case 'network':
    case 'timeout':
    case 'rate-limit':
      return true;
    case 'server':
      return e.status !== 501;
    case 'needs-server':
      // Our proxy unreachable for a moment / a gateway error; a 404 means it has no such route.
      return e.status === 0 || e.status >= 500;
    default:
      return e.status === 408 || e.status === 425;
  }
}

/**
 * Runs an idempotent request (fetch + body read) again after transient
 * failures, with exponential back-off and jitter (honouring Retry-After),
 * never past `deadline`. Never use it for requests that start paid work.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: { signal: AbortSignal; deadline?: number; attempts?: number }): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? aiTiming.retryAttempts);
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (opts.signal.aborted || e instanceof AbortError) throw new AbortError();
      if (i >= attempts - 1 || !isTransientError(e)) throw e;
      const backoff = Math.min(aiTiming.retryMaxMs, aiTiming.retryBaseMs * 2 ** i) * (0.75 + Math.random() * 0.5);
      const hinted = e instanceof AiError && e.retryAfterSec ? Math.min(60, e.retryAfterSec) * 1000 : 0;
      const delay = Math.max(backoff, hinted);
      if (opts.deadline !== undefined && Date.now() + delay > opts.deadline) throw e;
      await sleep(delay, opts.signal);
    }
  }
}

/** Resolves after `ms`, or rejects with AbortError. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
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

/**
 * Downloads a provider output file (generated image / GLB): data URIs are
 * decoded, http(s) URLs fetched directly and, when the browser cannot (CORS),
 * through GET /api/ai/fetch?url=… on our server.
 */
export async function downloadOutput(url: string, opts: { signal: AbortSignal; timeoutMs?: number }): Promise<Blob> {
  const { signal } = opts;
  if (signal.aborted) throw new AbortError();
  if (url.startsWith('data:')) {
    const blob = dataUriToBlob(url);
    if (!blob) throw new AiError(T.downloadFailed('data URI'), 'bad-response');
    return blob;
  }
  if (!/^https?:\/\//i.test(url)) throw new AiError(T.downloadFailed(url.slice(0, 60)), 'bad-response');
  const timeoutMs = opts.timeoutMs ?? aiTiming.downloadTimeoutMs;
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return 'URL';
    }
  })();
  try {
    const res = await send(url, { signal, timeoutMs, credentials: 'omit' }, { name: host, route: 'direct' });
    return await withSniffedType(await res.blob());
  } catch (e) {
    if (signal.aborted || e instanceof AbortError) throw new AbortError();
    // Only a network-level failure (typically CORS) is worth the proxy; HTTP errors are final.
    if (!(e instanceof AiError) || e.code !== 'network') throw e;
  }
  try {
    const res = await send(
      aiFetchPath(url),
      { signal, timeoutMs, headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE } },
      { name: host, route: 'proxy' },
    );
    return await withSniffedType(await res.blob());
  } catch (e) {
    if (signal.aborted || e instanceof AbortError) throw new AbortError();
    if (e instanceof AiError && (e.code === 'needs-server' || e.code === 'network')) throw new AiError(T.downloadFailed(host), 'needs-server');
    throw e;
  }
}
