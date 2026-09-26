/**
 * Server side of the AI provider registry: which kinds the proxy forwards,
 * where to (a fixed base per kind — never a client-supplied host), how each
 * API authenticates, and the "managed" providers announced to the browser
 * for every key configured in the environment.
 *
 * Auth schemes, verified against the official SDK sources unless marked:
 *  - OpenAI     Authorization: Bearer <key>          (openai)
 *  - Gemini     x-goog-api-key: <key>                (@google/genai)
 *  - Replicate  Authorization: Bearer <token>        (replicate)
 *  - fal.ai     Authorization: Key <key>             (@fal-ai/client)
 *  - Tripo3D    Authorization: Bearer <key>          (as server/providers/tripo.ts)
 *  - Stability  Authorization: Bearer <key>          ASSUMPTION (REST docs; no SDK to check)
 */
import type { AiCapability, ProviderConfig, ProviderKindId } from '../../src/ai/types';
import { AI_PROXY_BASES, type ProxiedKind } from '../../src/drivers/cloud/api';

/** Environment read by the AI routes (all optional). */
export interface AiServerEnv {
  OPENAI_API_KEY?: string;
  /** Model for image edits with the server's OpenAI key (e.g. gpt-image-1). */
  OPENAI_IMAGE_MODEL?: string;
  GEMINI_API_KEY?: string;
  /** Model for image edits with the server's Gemini key (e.g. gemini-2.5-flash-image). */
  GEMINI_IMAGE_MODEL?: string;
  STABILITY_API_KEY?: string;
  REPLICATE_API_TOKEN?: string;
  FAL_KEY?: string;
  TRIPO_API_KEY?: string;
  /** '0' / 'false': do not relay users' own keys (x-ai-key); only server keys are used. Default on. */
  AI_PROXY_BYOK?: string;
  /** Comma-separated kinds the proxy forwards (default: all of AI_PROXY_BASES). */
  AI_PROXY_KINDS?: string;
  /** Comma-separated base URLs 'openai-compatible' / 'custom-http' providers may be proxied to. */
  AI_PROXY_EXTRA_BASES?: string;
  /** Upstream response-header timeout in seconds (default 180). */
  AI_PROXY_TIMEOUT_SEC?: string;
  /** Largest proxied request body in MB (default 40). */
  AI_PROXY_MAX_BODY_MB?: string;
  /** Generation requests (POST/PUT/PATCH/DELETE) per client IP and window with a server key (default 60, 0 = unlimited). */
  AI_PROXY_RATE_LIMIT?: string;
  /** Same with the user's own key (default 600, 0 = unlimited). */
  AI_PROXY_RATE_LIMIT_BYOK?: string;
  /** Window of the two limits above in seconds (default 3600). */
  AI_PROXY_RATE_WINDOW_SEC?: string;
  /** GET/HEAD proxy calls (task polls) + output downloads per client IP and minute (default 300, 0 = unlimited). */
  AI_PROXY_READ_RATE_LIMIT?: string;
  /** Proxied requests in progress over all clients (default 64, 0 = no cap). */
  AI_PROXY_MAX_CONCURRENT?: string;
  /** Hosts provider output files may be downloaded from (replaces DEFAULT_FETCH_HOSTS). */
  AI_FETCH_ALLOWED_HOSTS?: string;
  /** Largest downloaded output file in MB (default 200). */
  AI_FETCH_MAX_MB?: string;
}

type EnvKey = keyof AiServerEnv;

export interface ProxyKindSpec {
  kind: ProxiedKind;
  name: string;
  /** Env var with the server's key for this kind. */
  keyEnv: EnvKey;
  /** Env vars choosing the managed provider's model per capability. */
  modelEnv: Partial<Record<AiCapability, EnvKey>>;
  /** Fixed upstream origin. */
  base: string;
  /** Paths starting with `prefix` go to another fixed origin, prefix removed (fal's queue host). */
  prefixBases: { prefix: string; base: string }[];
  /** Header carrying the key. */
  auth: (key: string) => [name: string, value: string];
  /** Request headers (lower case) forwarded besides content-type / accept; values are length-checked. */
  forwardHeaders: string[];
  /** Query parameters never forwarded (keys some clients put in the URL). */
  dropQuery: string[];
}

const bearer = (key: string): [string, string] => ['Authorization', `Bearer ${key}`];

export const PROXY_KINDS: Record<ProxiedKind, ProxyKindSpec> = {
  openai: {
    kind: 'openai',
    name: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: { 'image-edit': 'OPENAI_IMAGE_MODEL' },
    base: AI_PROXY_BASES.openai,
    prefixBases: [],
    auth: bearer,
    forwardHeaders: [],
    dropQuery: [],
  },
  gemini: {
    kind: 'gemini',
    name: 'Google Gemini',
    keyEnv: 'GEMINI_API_KEY',
    modelEnv: { 'image-edit': 'GEMINI_IMAGE_MODEL' },
    base: AI_PROXY_BASES.gemini,
    prefixBases: [],
    auth: (key) => ['x-goog-api-key', key],
    forwardHeaders: [],
    // The REST API also accepts ?key=; only the header set here may authenticate.
    dropQuery: ['key'],
  },
  stability: {
    kind: 'stability',
    name: 'Stability AI',
    keyEnv: 'STABILITY_API_KEY',
    modelEnv: {},
    base: AI_PROXY_BASES.stability,
    prefixBases: [],
    auth: bearer, // ASSUMPTION, see the header comment
    forwardHeaders: [],
    dropQuery: [],
  },
  replicate: {
    kind: 'replicate',
    name: 'Replicate',
    keyEnv: 'REPLICATE_API_TOKEN',
    modelEnv: {},
    base: AI_PROXY_BASES.replicate,
    prefixBases: [],
    auth: bearer,
    // 'Prefer: wait[=n]' holds the request open until the prediction ends (capped, see sanitizePrefer).
    forwardHeaders: ['prefer', 'cancel-after'],
    dropQuery: [],
  },
  fal: {
    kind: 'fal',
    name: 'fal.ai',
    keyEnv: 'FAL_KEY',
    modelEnv: {},
    base: AI_PROXY_BASES.fal,
    prefixBases: [{ prefix: 'queue/', base: 'https://queue.fal.run' }],
    auth: (key) => ['Authorization', `Key ${key}`],
    forwardHeaders: ['x-fal-request-timeout', 'x-fal-queue-priority', 'x-fal-runner-hint', 'x-fal-object-lifecycle-preference'],
    dropQuery: [],
  },
  tripo: {
    kind: 'tripo',
    name: 'Tripo3D',
    keyEnv: 'TRIPO_API_KEY',
    modelEnv: {},
    base: AI_PROXY_BASES.tripo,
    prefixBases: [],
    auth: bearer,
    forwardHeaders: [],
    dropQuery: [],
  },
};

export const isProxiedKind = (k: string): k is ProxiedKind => Object.hasOwn(PROXY_KINDS, k);

/** Kinds proxied only to bases the operator lists in AI_PROXY_EXTRA_BASES. */
export type ExtraKind = Extract<ProviderKindId, 'openai-compatible' | 'custom-http'>;
export const EXTRA_KINDS: readonly ExtraKind[] = ['openai-compatible', 'custom-http'];
export const isExtraKind = (k: string): k is ExtraKind => (EXTRA_KINDS as readonly string[]).includes(k);

const envValue = (env: AiServerEnv, key: EnvKey) => env[key]?.trim() || null;

/** The server's key for `kind`, or null. */
export function serverKeyFor(env: AiServerEnv, kind: ProxiedKind): string | null {
  return envValue(env, PROXY_KINDS[kind].keyEnv);
}

/** Every configured server key (for redaction). */
export function allServerKeys(env: AiServerEnv): string[] {
  return (Object.keys(PROXY_KINDS) as ProxiedKind[]).map((k) => serverKeyFor(env, k)).filter((k): k is string => !!k);
}

/** Kinds the proxy forwards: AI_PROXY_KINDS (unknown names ignored) or all. */
export function enabledProxyKinds(env: AiServerEnv): ProxiedKind[] {
  const all = Object.keys(PROXY_KINDS) as ProxiedKind[];
  const raw = env.AI_PROXY_KINDS?.trim();
  if (!raw) return all;
  const wanted = new Set(raw.split(',').map((s) => s.trim().toLowerCase()));
  return all.filter((k) => wanted.has(k));
}

export const byokEnabled = (env: AiServerEnv) => !/^(0|false|no|off)$/i.test(env.AI_PROXY_BYOK?.trim() ?? '');

/**
 * Managed providers (GET /api/ai/providers): one per proxied kind with a
 * server key. The key itself never leaves the server; `models` only carries
 * the env overrides (the client falls back to the kind's suggestions).
 */
export function managedProviders(env: AiServerEnv): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  for (const kind of enabledProxyKinds(env)) {
    const spec = PROXY_KINDS[kind];
    if (!serverKeyFor(env, kind)) continue;
    const models: Partial<Record<AiCapability, string>> = {};
    for (const [cap, key] of Object.entries(spec.modelEnv) as [AiCapability, EnvKey][]) {
      const v = envValue(env, key);
      if (v) models[cap] = v;
    }
    out.push({ id: `server-${kind}`, kind, label: spec.name, apiKey: '', managed: true, values: {}, models, enabled: true });
  }
  return out;
}

/**
 * Normalise a base URL for comparison: http(s) only, no credentials, query or
 * fragment; lower-case origin, path without trailing '/'. Null when invalid.
 */
export function normalizeBase(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** AI_PROXY_EXTRA_BASES → normalised bases (invalid entries dropped). */
export function parseExtraBases(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(',')
    .map((s) => normalizeBase(s))
    .filter((s): s is string => s !== null);
}
