/**
 * Pure helpers of the AI proxy and output-download routes (./routes.ts):
 * path validation and target resolution (the host always comes from the
 * kind's fixed base), request / response header filtering, secret redaction
 * and the download host allow-list. No I/O here.
 */
import { isIP } from 'node:net';
import type { ProxyKindSpec } from './providers';

/** Longest proxied path (without the query). */
export const MAX_PROXY_PATH = 2048;

/** One raw path segment: RFC 3986 pchar, percent-escapes allowed. */
const SEGMENT = /^(?:[A-Za-z0-9\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})+$/;
/** Characters a decoded segment may never contain: separators and controls. */
const FORBIDDEN_DECODED = /[/\\\u0000-\u001f\u007f]/;
const SCHEME_LIKE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Validate the (still percent-encoded) API path after `/api/ai/proxy/<kind>/`.
 * Rejects empty paths and segments, dot segments (also encoded), encoded
 * slashes / backslashes / controls, anything outside RFC 3986 pchar and a
 * first segment that looks like a URL scheme. Returns the path or null.
 */
export function validateProxyPath(raw: string): string | null {
  if (!raw || raw.length > MAX_PROXY_PATH) return null;
  const segments = raw.split('/');
  // A single trailing slash is fine ('a/b/'); empty segments elsewhere are not.
  if (segments.at(-1) === '' && segments.length > 1) segments.pop();
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (!SEGMENT.test(seg)) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (decoded === '.' || decoded === '..' || FORBIDDEN_DECODED.test(decoded)) return null;
  }
  if (SCHEME_LIKE.test(decodeURIComponent(segments[0]))) return null;
  return raw;
}

/** The raw (undecoded) path and query of a request URL, as the client sent them. */
export function rawPathAndQuery(url: string): { path: string; query: string } {
  const start = url.indexOf('/', url.indexOf('://') + 3);
  const rest = start === -1 ? '/' : url.slice(start);
  const hash = rest.indexOf('#');
  const noHash = hash === -1 ? rest : rest.slice(0, hash);
  const q = noHash.indexOf('?');
  return q === -1 ? { path: noHash, query: '' } : { path: noHash.slice(0, q), query: noHash.slice(q + 1) };
}

/**
 * Upstream URL for a validated path: `<base>/<path>?<query>`, with the base
 * picked by prefix (fal 'queue/'), `dropQuery` parameters removed, and a final
 * check that the result is still on that base. Null when anything is off.
 */
export function buildTargetUrl(
  spec: Pick<ProxyKindSpec, 'base' | 'prefixBases' | 'dropQuery'>,
  path: string,
  query: string,
): URL | null {
  let base = spec.base;
  let rest = path;
  for (const p of spec.prefixBases) {
    if (path.startsWith(p.prefix)) {
      base = p.base;
      rest = path.slice(p.prefix.length);
      break;
    }
  }
  if (!rest) return null;
  return joinBase(base, rest, query, spec.dropQuery);
}

/** `<base>/<path>?<query>` staying under `base` (origin and path prefix), or null. */
export function joinBase(base: string, path: string, query: string, dropQuery: string[] = []): URL | null {
  const b = new URL(base);
  const basePath = b.pathname.replace(/\/+$/, '');
  let target: URL;
  try {
    target = new URL(`${b.origin}${basePath}/${path}`);
  } catch {
    return null;
  }
  if (target.origin !== b.origin || !target.pathname.startsWith(`${basePath}/`) || target.username || target.password) return null;
  if (query) {
    const params = new URLSearchParams(query);
    const dropped = dropQuery.filter((k) => params.has(k));
    for (const k of dropped) params.delete(k);
    // Keep the client's exact encoding unless something was dropped.
    target.search = dropped.length ? params.toString() : query;
  }
  return target;
}

/**
 * Replicate's `Prefer: wait[=n]` with n capped at `maxSec` (the API's own
 * maximum is 60); anything else → null (dropped).
 */
export function sanitizePrefer(value: string, maxSec = 60): string | null {
  const m = /^\s*wait(?:\s*=\s*(\d{1,4}))?\s*$/i.exec(value);
  if (!m) return null;
  if (m[1] === undefined) return `wait=${maxSec}`;
  const n = Math.max(1, Math.min(maxSec, Number(m[1])));
  return `wait=${n}`;
}

/** Header values forwarded as-is must be short printable ASCII. */
const SAFE_HEADER_VALUE = /^[\x20-\x7e]{1,256}$/;
const SAFE_CONTENT_TYPE = /^[\x20-\x7e]{1,512}$/;

/**
 * Upstream request headers: only content-type, accept and the kind's own
 * `forwardHeaders` (never cookies, our client / key headers, hop-by-hop or
 * forwarding headers), plus the auth header when a key is given.
 */
export function buildUpstreamHeaders(
  spec: Pick<ProxyKindSpec, 'forwardHeaders'> & { auth?: ProxyKindSpec['auth'] },
  incoming: Headers,
  key: string | null,
  contentLength: string | null,
): Headers {
  const out = new Headers();
  const ct = incoming.get('content-type');
  if (ct && SAFE_CONTENT_TYPE.test(ct)) out.set('content-type', ct);
  const accept = incoming.get('accept');
  if (accept && SAFE_CONTENT_TYPE.test(accept)) out.set('accept', accept);
  for (const name of spec.forwardHeaders) {
    const v = incoming.get(name);
    if (!v) continue;
    if (name === 'prefer') {
      const p = sanitizePrefer(v);
      if (p) out.set('prefer', p);
    } else if (SAFE_HEADER_VALUE.test(v)) {
      out.set(name, v);
    }
  }
  if (contentLength !== null) out.set('content-length', contentLength);
  if (key && spec.auth) {
    const [name, value] = spec.auth(key);
    out.set(name, value);
  }
  return out;
}

/** Upstream response headers relayed to the browser (everything else — cookies, hop-by-hop, CORS, HSTS… — is dropped). */
const RELAYED_RESPONSE_HEADER = /^(content-type|content-disposition|retry-after|x-request-id|request-id|x-ratelimit-[a-z0-9-]+|openai-processing-ms|x-fal-request-id|x-fal-request-timeout-type)$/;

/**
 * Filter upstream response headers. Content-Length is kept only for identity
 * bodies: fetch already decoded a compressed one, so its length (and
 * Content-Encoding) would be wrong.
 */
export function relayResponseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  upstream.forEach((value, name) => {
    if (RELAYED_RESPONSE_HEADER.test(name)) out.set(name, value);
  });
  const len = upstream.get('content-length');
  if (len && /^\d+$/.test(len) && !upstream.get('content-encoding')) out.set('content-length', len);
  return out;
}

/**
 * Shapes of well-known provider keys, redacted from relayed error bodies even
 * when they are not ours (upstream messages sometimes echo a key).
 */
const KEY_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI, Stability
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google
  /\br8_[A-Za-z0-9]{20,}/g, // Replicate
  /\btsk_[A-Za-z0-9_.-]{8,}/g, // Tripo
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{16,}/gi, // fal.ai
];

/** Replace every given secret and every key-shaped token in `text`. */
export function redactKeys(text: string, secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  for (const re of KEY_SHAPES) out = out.replace(re, '[redacted]');
  return out;
}

/** Accepted user key: printable ASCII without spaces, as the client checks it (the provider decides whether it is valid). */
export const AI_KEY_PATTERN = /^[\x21-\x7e]{1,1024}$/;

// --- output downloads (/api/ai/fetch) -----------------------------------------

/**
 * A download allow-list entry: a host (+ its subdomains, only them for '*.',
 * or the exact host for an entry with a path) optionally limited to a path prefix.
 */
export interface HostRule {
  host: string;
  subdomains: 'also' | 'only' | 'exact';
  /** '/prefix' (no trailing slash) or '' for any path. */
  pathPrefix: string;
}

/**
 * ASSUMPTION: where providers serve generated files. Replicate:
 * replicate.delivery (+ pbxt., …); fal.ai: fal.media (v2/v3.fal.media …) and
 * its older GCS bucket. The routes add Tripo's model hosts
 * (TRIPO_ALLOWED_MODEL_HOSTS); AI_FETCH_ALLOWED_HOSTS replaces the lot.
 */
export const DEFAULT_FETCH_HOSTS = 'replicate.delivery,fal.media,storage.googleapis.com/falserverless';

/**
 * Parse 'a.com, *.b.com, c.com/some/prefix'. 'a.com' matches the host and its
 * subdomains, '*.b.com' only subdomains; a path limits the entry to that
 * prefix (on a segment boundary) and to exactly that host ('*.c.com/prefix'
 * for its subdomains): on shared hosts such as storage.googleapis.com a
 * subdomain is someone else's bucket. Invalid entries are dropped; null when empty.
 */
export function parseHostRules(value: string | undefined): HostRule[] | null {
  if (value === undefined || !value.trim()) return null;
  const rules: HostRule[] = [];
  for (const raw of value.split(',')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const m = /^(\*\.)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)\.?(\/[a-z0-9\-._~!$&'()*+,;=:@%/]*)?$/.exec(entry);
    if (!m || isIP(m[2])) continue;
    const pathPrefix = (m[3] ?? '').replace(/\/+$/, '');
    rules.push({ host: m[2], subdomains: m[1] ? 'only' : pathPrefix ? 'exact' : 'also', pathPrefix });
  }
  return rules.length ? rules : null;
}

/** `host` is set when the URL is fine but its host / path is not on the allow-list. */
export type FetchUrlCheck = { ok: true; url: URL } | { ok: false; reason: string; host?: string };

/**
 * Whether `value` may be downloaded: https on the default port, no
 * credentials, a DNS name (never an IP literal, in any notation the URL
 * parser accepts) matching a rule.
 */
export function checkFetchUrl(value: string | URL, rules: HostRule[]): FetchUrlCheck {
  let url: URL;
  try {
    url = typeof value === 'string' ? new URL(value) : value;
  } catch {
    return { ok: false, reason: 'Invalid URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'Only https URLs can be fetched' };
  if (url.username || url.password) return { ok: false, reason: 'URLs with credentials are not allowed' };
  if (url.port) return { ok: false, reason: 'Only the default https port is allowed' };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare) || /^[\d.]+$/.test(host)) return { ok: false, reason: 'IP addresses are not allowed' };
  const path = url.pathname;
  const pathEncodedSep = /%2f|%5c/i.test(path);
  const allowed = rules.some((r) => {
    const hostOk =
      r.subdomains === 'only' ? host.endsWith(`.${r.host}`) : r.subdomains === 'exact' ? host === r.host : host === r.host || host.endsWith(`.${r.host}`);
    if (!hostOk) return false;
    if (!r.pathPrefix) return true;
    return !pathEncodedSep && (path === r.pathPrefix || path.startsWith(`${r.pathPrefix}/`));
  });
  return allowed ? { ok: true, url } : { ok: false, reason: `Host not allowed: ${host}`, host };
}

/** Content-Type relayed for downloads: a plain media type, else application/octet-stream. */
export function safeContentType(value: string | null): string {
  const v = value?.trim() ?? '';
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+"-]+)*$/i.test(v) ? v : 'application/octet-stream';
}
