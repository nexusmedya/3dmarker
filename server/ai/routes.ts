/**
 * AI provider routes (registered by server/app.ts):
 *
 *   GET  /api/ai/providers              { providers, proxyKinds, byok } — managed providers (server keys)
 *   ANY  /api/ai/proxy/<kind>/<path>    the same request to that kind's fixed API base
 *   GET  /api/ai/fetch?url=<https URL>  a provider output file from an allow-listed host
 *
 * Proxy: the host always comes from PROXY_KINDS (or, for 'openai-compatible'
 * / 'custom-http', an exact AI_PROXY_EXTRA_BASES entry named by x-ai-base).
 * Key: the user's own (x-ai-key, relayed unless AI_PROXY_BYOK=0) wins, else
 * the server's, else 401. Only content-type / accept and a few per-kind
 * headers go upstream; only content headers, request ids, rate-limit info
 * and Retry-After come back. Bodies stream both ways (request ≤
 * AI_PROXY_MAX_BODY_MB, response ≤ AI_FETCH_MAX_MB); upstream error bodies
 * are buffered and scrubbed of keys. Upstream redirects are refused.
 *
 * Both proxy and fetch need CLIENT_HEADER (no cross-site use of the server's
 * keys) and are rate limited per client IP; our own errors are `{ error }`
 * JSON with AI_PROXY_ERROR_HEADER set.
 */
import type { Context, Env, Hono, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  AI_AUTH_HEADER,
  AI_BASE_HEADER,
  AI_FETCH_MAX_BYTES,
  AI_FETCH_PATH,
  AI_KEY_HEADER,
  AI_PROVIDERS_PATH,
  AI_PROXY_ERROR_HEADER,
  AI_PROXY_MAX_BODY_BYTES,
  AI_PROXY_PATH,
  type AiProvidersResponse,
  type ApiErrorBody,
  type ProxiedKind,
} from '../../src/drivers/cloud/api';
import type { ProviderKindId } from '../../src/ai/types';
import { FixedWindowRateLimiter, InFlight } from '../rateLimit';
import { countingBody, timedRelay, type RelayErrorKind } from '../relay';
import {
  AI_KEY_PATTERN,
  DEFAULT_FETCH_HOSTS,
  buildTargetUrl,
  buildUpstreamHeaders,
  checkFetchUrl,
  joinBase,
  parseHostRules,
  rawPathAndQuery,
  redactKeys,
  relayResponseHeaders,
  safeContentType,
  validateProxyPath,
} from './proxy';
import {
  EXTRA_KINDS,
  PROXY_KINDS,
  allServerKeys,
  byokEnabled,
  enabledProxyKinds,
  isExtraKind,
  isProxiedKind,
  managedProviders,
  normalizeBase,
  parseExtraBases,
  serverKeyFor,
  type AiServerEnv,
  type ProxyKindSpec,
} from './providers';

export interface AiRoutesDeps {
  env: AiServerEnv;
  /** Used for every upstream call. */
  fetch?: typeof fetch;
  /** Clock for the rate limiters (ms). */
  now?: () => number;
  log: Pick<Console, 'info' | 'warn' | 'error'>;
  /** Rate-limit key of the client (see server/app.ts). */
  clientIp: (c: Context) => string;
  /** CSRF guard (CLIENT_HEADER + Sec-Fetch-Site). */
  sameOriginOnly: MiddlewareHandler;
  /** Tripo model CDN hosts, added to the default download allow-list. */
  tripoModelHosts?: string[];
}

/** Proxied requests one client may have in progress (image edits take a minute; views are generated in parallel). */
export const MAX_PROXY_PER_CLIENT = 8;
/** Output downloads one client may have in progress. */
export const MAX_FETCH_PER_CLIENT = 4;
const BUSY_RETRY_SEC = 5;
/** Largest upstream error body relayed (it is buffered to scrub keys). */
const MAX_ERROR_BODY = 256 * 1024;
const PROXY_IDLE_MS = 120_000;
const TRANSFER_TOTAL_MS = 30 * 60_000;
const FETCH_HEADERS_MS = 60_000;
const FETCH_IDLE_MS = 60_000;
const MAX_REDIRECTS = 3;

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PROXY_METHODS = new Set(['GET', 'HEAD', ...WRITE_METHODS]);

const intEnv = (v: string | undefined, def: number): number => {
  if (v === undefined || !v.trim()) return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
};
/** Positive number (decimals allowed), else `def`. */
const numEnv = (v: string | undefined, def: number): number => {
  if (v === undefined || !v.trim()) return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
};

/** A failure answered with our own `{ error }` JSON. */
class RouteError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
  ) {
    super(message);
    this.name = 'RouteError';
  }
}

type KeySource = 'server' | 'user' | 'none';
interface Target {
  kind: ProviderKindId;
  name: string;
  spec: Pick<ProxyKindSpec, 'forwardHeaders'> & { auth?: ProxyKindSpec['auth'] };
  url: URL;
}

export function registerAiRoutes<E extends Env>(app: Hono<E>, deps: AiRoutesDeps): void {
  const { env, log, clientIp, sameOriginOnly } = deps;
  const doFetch: typeof fetch = (input, init) => (deps.fetch ?? fetch)(input, init);
  const kinds = new Set<ProxiedKind>(enabledProxyKinds(env));
  const extraBases = parseExtraBases(env.AI_PROXY_EXTRA_BASES);
  const byok = byokEnabled(env);
  const serverKeys = allServerKeys(env);
  const timeoutMs = numEnv(env.AI_PROXY_TIMEOUT_SEC, 180) * 1000;
  const maxBody = Math.floor(numEnv(env.AI_PROXY_MAX_BODY_MB, AI_PROXY_MAX_BODY_BYTES / 1024 / 1024) * 1024 * 1024);
  const maxFetch = Math.floor(numEnv(env.AI_FETCH_MAX_MB, AI_FETCH_MAX_BYTES / 1024 / 1024) * 1024 * 1024);
  const tooLargeBody = `The request body is larger than ${Math.round((maxBody / 1024 / 1024) * 10) / 10} MB`;
  const writeLimits: Record<Exclude<KeySource, 'none'>, number> = {
    server: intEnv(env.AI_PROXY_RATE_LIMIT, 60),
    user: intEnv(env.AI_PROXY_RATE_LIMIT_BYOK, 600),
  };
  const writeLimiter = new FixedWindowRateLimiter(intEnv(env.AI_PROXY_RATE_WINDOW_SEC, 3600) * 1000, deps.now);
  const readLimit = intEnv(env.AI_PROXY_READ_RATE_LIMIT, 300);
  const readLimiter = new FixedWindowRateLimiter(60_000, deps.now);
  const maxConcurrent = intEnv(env.AI_PROXY_MAX_CONCURRENT, 64);
  const inFlight = new InFlight();
  const downloads = new InFlight();
  const fetchRules =
    parseHostRules(env.AI_FETCH_ALLOWED_HOSTS) ?? parseHostRules([DEFAULT_FETCH_HOSTS, ...(deps.tripoModelHosts ?? [])].join(','))!;

  const fail = (c: Context, status: ContentfulStatusCode, error: string, retryAfterSec?: number) => {
    c.header(AI_PROXY_ERROR_HEADER, '1');
    if (retryAfterSec !== undefined) c.header('Retry-After', String(retryAfterSec));
    return c.json({ error } satisfies ApiErrorBody, status);
  };

  const scrub = (text: string, userKey?: string | null) => redactKeys(text, [...serverKeys, userKey]);

  app.get(AI_PROVIDERS_PATH, (c) =>
    c.json({
      providers: managedProviders(env),
      proxyKinds: [...kinds, ...(extraBases.length ? EXTRA_KINDS : [])],
      byok,
    } satisfies AiProvidersResponse),
  );

  /** Resolve kind + validated upstream URL, or throw a RouteError. */
  const resolveTarget = (c: Context, kind: string): Target => {
    const { path, query } = rawPathAndQuery(c.req.url);
    const prefix = `${AI_PROXY_PATH}/${kind}/`;
    if (!path.startsWith(prefix)) throw new RouteError(400, 'Invalid API path');
    const rest = validateProxyPath(path.slice(prefix.length));
    if (!rest) throw new RouteError(400, 'Invalid API path');
    if (isProxiedKind(kind) && kinds.has(kind)) {
      const spec = PROXY_KINDS[kind];
      const url = buildTargetUrl(spec, rest, query);
      if (!url) throw new RouteError(400, 'Invalid API path');
      return { kind, name: spec.name, spec, url };
    }
    if (isExtraKind(kind) && extraBases.length) {
      const base = normalizeBase(c.req.header(AI_BASE_HEADER) ?? '');
      if (!base || !extraBases.includes(base)) {
        throw new RouteError(403, `This server only proxies ${kind} providers at the base URLs listed in AI_PROXY_EXTRA_BASES`);
      }
      const url = joinBase(base, rest, query);
      if (!url) throw new RouteError(400, 'Invalid API path');
      const scheme = c.req.header(AI_AUTH_HEADER)?.trim().toLowerCase();
      const auth = (key: string): [string, string] => (scheme === 'api-key' ? ['api-key', key] : ['Authorization', `Bearer ${key}`]);
      return { kind, name: new URL(base).host, spec: { forwardHeaders: [], auth }, url };
    }
    throw new RouteError(404, `Unknown or disabled provider kind: ${kind.slice(0, 40)}`);
  };

  /** The key to send (user's wins), or a RouteError. */
  const resolveKey = (c: Context, t: Target): { key: string | null; source: KeySource } => {
    const header = c.req.header(AI_KEY_HEADER)?.trim();
    if (header) {
      if (!byok) throw new RouteError(403, 'This server does not relay user API keys; use a provider managed by the server');
      if (!AI_KEY_PATTERN.test(header)) throw new RouteError(401, 'The provided API key has an invalid format');
      return { key: header, source: 'user' };
    }
    if (isProxiedKind(t.kind)) {
      const key = serverKeyFor(env, t.kind);
      if (key) return { key, source: 'server' };
      throw new RouteError(401, `No ${t.name} API key: the server has none configured, so provide your own key (${AI_KEY_HEADER} header)`);
    }
    return { key: null, source: 'none' }; // extra bases may need no key
  };

  const readRate: MiddlewareHandler = async (c, next) => {
    const rate = readLimiter.hit(`ai-read:${clientIp(c)}`, readLimit);
    if (!rate.allowed) return fail(c, 429, 'Too many requests; try again shortly', rate.retryAfterSec);
    await next();
  };

  const relayError = (name: string) => (kind: RelayErrorKind, message: string) =>
    kind === 'timeout'
      ? new RouteError(504, `${name}: ${message}`)
      : kind === 'too-large'
        ? new RouteError(502, `${name}: the response is too large`)
        : // The client went away: @hono/node-server logs this code as "The user aborted a request." instead of an error.
          Object.assign(new RouteError(502, 'Request aborted'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });

  app.all(`${AI_PROXY_PATH}/:kind/*`, sameOriginOnly, async (c) => {
    const method = c.req.method.toUpperCase();
    if (!PROXY_METHODS.has(method)) return fail(c, 405, 'Method not allowed');
    const kind = c.req.param('kind') ?? '';
    const ip = clientIp(c);
    let target: Target;
    let auth: { key: string | null; source: KeySource };
    try {
      target = resolveTarget(c, kind);
      auth = resolveKey(c, target);
    } catch (e) {
      if (e instanceof RouteError) return fail(c, e.status, e.message);
      throw e;
    }

    const hasBody = WRITE_METHODS.has(method) && c.req.raw.body !== null;
    const declared = c.req.header('content-length');
    if (declared !== undefined && !/^\d{1,15}$/.test(declared)) return fail(c, 400, 'Invalid Content-Length');
    if (declared !== undefined && Number(declared) > maxBody) return fail(c, 413, tooLargeBody);

    // Checked before the budgets, so a "busy" answer does not use one up.
    if (inFlight.count(ip) >= MAX_PROXY_PER_CLIENT || (maxConcurrent > 0 && inFlight.total >= maxConcurrent)) {
      return fail(c, 429, 'Too many AI requests in progress; try again in a few seconds', BUSY_RETRY_SEC);
    }
    // Budgets: generations per window (server key / own key), reads per minute.
    if (WRITE_METHODS.has(method)) {
      const limit = auth.source === 'server' ? writeLimits.server : writeLimits.user;
      const rate = writeLimiter.hit(`ai-${auth.source}:${ip}`, limit);
      if (!rate.allowed) return fail(c, 429, `Too many generation requests; try again in ${Math.ceil(rate.retryAfterSec / 60)} min`, rate.retryAfterSec);
    } else {
      const rate = readLimiter.hit(`ai-read:${ip}`, readLimit);
      if (!rate.allowed) return fail(c, 429, 'Too many requests; try again shortly', rate.retryAfterSec);
    }

    const counted = hasBody ? countingBody(c.req.raw.body!, maxBody) : null;
    const headers = buildUpstreamHeaders(target.spec, c.req.raw.headers, auth.key, hasBody && declared !== undefined ? declared : null);
    const clientSignal = c.req.raw.signal;
    let upstream: Response;
    try {
      upstream = await timedRelay(
        async (signal, timedOut) => {
          let res: Response;
          try {
            res = await doFetch(target.url.toString(), {
              method,
              headers,
              body: counted?.body ?? null,
              redirect: 'manual',
              credentials: 'omit',
              signal,
              ...(counted ? { duplex: 'half' } : {}),
            } as RequestInit);
          } catch {
            if (counted?.exceeded()) throw new RouteError(413, tooLargeBody);
            if (timedOut()) throw new RouteError(504, `${target.name} did not answer within ${Math.round(timeoutMs / 1000)} s`);
            if (clientSignal.aborted) throw new RouteError(502, 'Request aborted');
            throw new RouteError(502, `Could not reach ${target.name}`);
          }
          if (res.status >= 300 && res.status < 400) {
            await res.body?.cancel().catch(() => {});
            throw new RouteError(502, `${target.name} answered with an unexpected redirect`);
          }
          return res;
        },
        {
          signal: clientSignal,
          timeoutMs,
          idleTimeoutMs: PROXY_IDLE_MS,
          totalTimeoutMs: TRANSFER_TOTAL_MS,
          maxBytes: maxFetch,
          onSettled: inFlight.acquire(ip),
          makeError: relayError(target.name),
        },
      );
    } catch (e) {
      if (e instanceof RouteError) return fail(c, e.status, e.message);
      log.error('AI proxy error:', scrub(e instanceof Error ? `${e.name}: ${e.message}` : String(e), auth.key));
      return fail(c, 502, `${target.name} request failed`);
    }

    const where = target.url.pathname.split('/').slice(0, 4).join('/');
    if (WRITE_METHODS.has(method) || !upstream.ok) log.info(`AI proxy ${kind} ${method} ${where} → ${upstream.status} (${auth.source} key)`);

    if (!upstream.ok) {
      // Buffered (small) so keys an upstream message may echo can be scrubbed.
      let text = '';
      try {
        text = await readCapped(upstream, MAX_ERROR_BODY);
      } catch {
        text = '';
      }
      if (upstream.status === 401 && auth.source === 'server') {
        log.warn(`${target.name} rejected the server API key (${PROXY_KINDS[kind as ProxiedKind]?.keyEnv ?? kind})`);
        return fail(c, 502, `${target.name} rejected the server's API key`);
      }
      const out = relayResponseHeaders(upstream.headers);
      out.delete('content-length');
      out.set('Cache-Control', 'no-store');
      return new Response(scrub(text, auth.key), { status: upstream.status, headers: out });
    }

    const out = relayResponseHeaders(upstream.headers);
    out.set('Cache-Control', 'no-store');
    return new Response(method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
  });

  app.get(AI_FETCH_PATH, sameOriginOnly, readRate, async (c) => {
    // Hono would run this handler for HEAD and drop the body without closing the download.
    if (c.req.method === 'HEAD') return fail(c, 405, 'Method not allowed');
    const first = checkFetchUrl(c.req.query('url') ?? '', fetchRules);
    if (!first.ok) {
      if (first.host) log.warn(`AI fetch refused host "${first.host.slice(0, 200)}" (add it to AI_FETCH_ALLOWED_HOSTS if it serves provider output)`);
      return fail(c, first.host ? 403 : 400, first.reason);
    }
    const ip = clientIp(c);
    if (downloads.count(ip) >= MAX_FETCH_PER_CLIENT) return fail(c, 429, 'Too many downloads in progress; try again in a few seconds', BUSY_RETRY_SEC);

    let res: Response;
    try {
      res = await timedRelay(
        async (signal, timedOut) => {
          let url = first.url;
          for (let hop = 0; ; hop++) {
            let r: Response;
            try {
              r = await doFetch(url.toString(), { method: 'GET', redirect: 'manual', credentials: 'omit', headers: { accept: '*/*' }, signal });
            } catch {
              if (timedOut()) throw new RouteError(504, 'The download timed out');
              throw new RouteError(502, 'Could not download the file');
            }
            if (r.status >= 300 && r.status < 400) {
              await r.body?.cancel().catch(() => {});
              const location = r.headers.get('location');
              if (!location || hop >= MAX_REDIRECTS) throw new RouteError(502, 'Too many redirects');
              let next: URL;
              try {
                next = new URL(location, url);
              } catch {
                throw new RouteError(502, 'Invalid redirect');
              }
              const check = checkFetchUrl(next, fetchRules);
              if (!check.ok) throw new RouteError(502, `Redirected to a location this server does not trust (${check.reason})`);
              url = check.url;
              continue;
            }
            if (!r.ok) {
              await r.body?.cancel().catch(() => {});
              throw new RouteError(502, `Download failed (HTTP ${r.status})`);
            }
            const len = Number(r.headers.get('content-length'));
            if (Number.isFinite(len) && len > maxFetch) {
              await r.body?.cancel().catch(() => {});
              throw new RouteError(413, `The file is larger than ${Math.round(maxFetch / 1024 / 1024)} MB`);
            }
            return r;
          }
        },
        {
          signal: c.req.raw.signal,
          timeoutMs: FETCH_HEADERS_MS,
          idleTimeoutMs: FETCH_IDLE_MS,
          totalTimeoutMs: TRANSFER_TOTAL_MS,
          maxBytes: maxFetch,
          onSettled: downloads.acquire(ip),
          makeError: relayError('Download'),
        },
      );
    } catch (e) {
      if (e instanceof RouteError) return fail(c, e.status, e.message);
      log.error('AI fetch error:', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return fail(c, 502, 'Download failed');
    }
    const headers = new Headers({
      'Content-Type': safeContentType(res.headers.get('content-type')),
      'Content-Disposition': 'attachment',
      // Served from our origin: never let it run as a page.
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cache-Control': 'private, no-store',
    });
    const len = res.headers.get('content-length');
    if (len && /^\d+$/.test(len) && !res.headers.get('content-encoding')) headers.set('Content-Length', len);
    return new Response(res.body, { status: 200, headers });
  });
}

/** Read at most `max` bytes of a body as text (the rest is cancelled). */
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - size;
    chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
    size += Math.min(value.byteLength, room);
    if (size >= max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const ch of chunks) {
    buf.set(ch, off);
    off += ch.byteLength;
  }
  return new TextDecoder().decode(buf);
}
