/**
 * AI provider settings: create / load / save / merge / resolve.
 *
 * Storage: the settings without secrets go to localStorage ('ai-settings');
 * API keys and secret field values go to ONE store ('ai-keys'): localStorage
 * when `rememberKeys`, otherwise sessionStorage. Saving writes the keys to
 * the chosen store and clears them from the other (so toggling migrates
 * them). Everything loaded is sanitised strictly. Managed providers (keys
 * held by our server) come from GET /api/ai/providers, are merged at runtime
 * and never persisted.
 */
import type { I18nText, ParamValues } from '../core/types';
import type { AiCapability, AiSettings, ProviderConfig, ProviderKindId } from './types';
import { AI_CAPABILITIES } from './types';
import { loadJSON, persistableParams, sanitizeParams, saveJSON, type KeyValueStore } from '../app/persist';
import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from '../drivers/cloud/api';
import { configCapabilities, defaultModel, getProviderKind, isProviderKindId, kindNeedsKey, migrateOutputPath } from './kinds';
import { AI_PROVIDERS_PATH, cleanKey, routeFor } from './transport';
import { isValidTemplate } from './template';

export const AI_SETTINGS_KEY = 'ai-settings';
export const AI_KEYS_KEY = 'ai-keys';
/** 2: background removal no longer defaults to a generative re-render (see normalizeDefaults). */
const VERSION = 2;

export const DEFAULT_AI_SETTINGS: AiSettings = { providers: [], defaults: {}, rememberKeys: false };

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MODEL_PATTERN = /^[\x20-\x7e]{1,200}$/;
const MAX_PROVIDERS = 50;
const MAX_KEY = 1000;

export function newProviderId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // not a secure context: fall through
  }
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** sessionStorage, guarded like browserStorage (null where blocked / missing). */
export function browserSessionStorage(): KeyValueStore | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

function sanitizeModels(kind: ProviderKindId, stored: unknown): Partial<Record<AiCapability, string>> {
  const src = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  const out: Partial<Record<AiCapability, string>> = {};
  for (const cap of getProviderKind(kind).capabilities) {
    const v = typeof src[cap] === 'string' ? (src[cap] as string).trim() : '';
    out[cap] = MODEL_PATTERN.test(v) ? v : defaultModel(kind, cap);
  }
  return out;
}

export function createProviderConfig(kind: ProviderKindId, init: Partial<ProviderConfig> = {}): ProviderConfig {
  const k = getProviderKind(kind);
  const label = typeof init.label === 'string' && init.label.trim() ? init.label.trim().slice(0, 80) : k.name;
  return {
    id: typeof init.id === 'string' && ID_PATTERN.test(init.id) ? init.id : newProviderId(),
    kind,
    label,
    apiKey: typeof init.apiKey === 'string' ? cleanKey(init.apiKey).slice(0, MAX_KEY) : '',
    ...(init.managed ? { managed: true } : {}),
    values: sanitizeParams(k.fields, migrateOutputPath(kind, { ...(init.values ?? {}) })),
    models: sanitizeModels(kind, init.models),
    enabled: typeof init.enabled === 'boolean' ? init.enabled : true,
  };
}

/** Does this config offer `cap` with a model chosen? */
export function supports(cfg: ProviderConfig, cap: AiCapability): boolean {
  if (!configCapabilities(cfg).includes(cap)) return false;
  return cfg.kind === 'custom-http' || !!(cfg.models[cap] ?? '').trim() || !!defaultModel(cfg.kind, cap);
}

/**
 * Default id meaning "the local in-browser model" (background removal only).
 * No default for background removal means the same.
 */
export const LOCAL_PROVIDER_ID = 'local';

/**
 * Background removers that re-draw the whole image with a generative edit
 * model (OpenAI gpt-image): slow, paid and not pixel-exact, so they are used
 * only when the user picks one explicitly.
 */
export function isRerenderBackgroundRemover(cfg: Pick<ProviderConfig, 'kind'>): boolean {
  return cfg.kind === 'openai' || cfg.kind === 'openai-compatible';
}

/** May this config be picked for `cap` without the user choosing it? */
const autoPickable = (p: ProviderConfig, cap: AiCapability) => cap !== 'background-removal' || !isRerenderBackgroundRemover(p);

/**
 * Drops defaults that point nowhere and fills missing ones with the first
 * enabled provider offering the capability (for background removal only a
 * dedicated matting model; otherwise the local model stays in charge).
 */
export function normalizeDefaults(s: AiSettings): AiSettings {
  const defaults: Partial<Record<AiCapability, string>> = {};
  for (const cap of AI_CAPABILITIES) {
    const cur = s.defaults[cap];
    if (cap === 'background-removal' && cur === LOCAL_PROVIDER_ID) {
      defaults[cap] = cur;
      continue;
    }
    const valid = cur && s.providers.some((p) => p.id === cur && supports(p, cap));
    const pick = valid ? cur : s.providers.find((p) => p.enabled && supports(p, cap) && autoPickable(p, cap))?.id;
    if (pick) defaults[cap] = pick;
  }
  return { ...s, defaults };
}

/**
 * Can this image-edit config render NEW views (back / sides) or re-pose /
 * complete a subject? Stability's edit endpoints (control/structure, style,
 * sketch) keep the input's composition by design, whatever the model id.
 */
export function canRenderViews(cfg: Pick<ProviderConfig, 'kind'>): boolean {
  return cfg.kind !== 'stability';
}

interface StoredKeys {
  [id: string]: { apiKey?: unknown; secrets?: unknown } | undefined;
}

function secretSpecs(kind: ProviderKindId) {
  return getProviderKind(kind).fields.filter((f) => f.kind === 'text' && f.secret);
}

/** Loads and sanitises the settings (keys from local or session storage per rememberKeys). */
export function loadAiSettings(local: KeyValueStore | null, session: KeyValueStore | null): AiSettings {
  const raw = loadJSON(local, AI_SETTINGS_KEY);
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rememberKeys = src.rememberKeys === true;
  const keysRaw = loadJSON(rememberKeys ? local : session, AI_KEYS_KEY);
  const keys: StoredKeys = keysRaw && typeof keysRaw === 'object' && !Array.isArray(keysRaw) ? (keysRaw as StoredKeys) : {};

  const providers: ProviderConfig[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(src.providers) ? src.providers.slice(0, MAX_PROVIDERS) : []) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    if (!isProviderKindId(p.kind)) continue; // unknown kinds dropped
    if (p.managed === true || (typeof p.id === 'string' && p.id.startsWith('server-'))) continue; // managed ones come from the server
    let id = typeof p.id === 'string' && ID_PATTERN.test(p.id) ? p.id : newProviderId();
    if (seen.has(id)) id = newProviderId();
    seen.add(id);
    // Keys belong to the stored id; an entry whose id had to be replaced gets none.
    const stored = id === p.id && Object.hasOwn(keys, id) ? keys[id] : undefined;
    const secrets = stored && typeof stored.secrets === 'object' && stored.secrets ? (stored.secrets as Record<string, unknown>) : {};
    const values = { ...(p.values && typeof p.values === 'object' ? (p.values as Record<string, unknown>) : {}) };
    for (const spec of secretSpecs(p.kind)) values[spec.key] = secrets[spec.key];
    providers.push(
      createProviderConfig(p.kind, {
        id,
        label: typeof p.label === 'string' ? p.label : undefined,
        apiKey: stored && typeof stored.apiKey === 'string' ? stored.apiKey : '',
        values: values as ParamValues,
        models: p.models as Partial<Record<AiCapability, string>>,
        enabled: typeof p.enabled === 'boolean' ? p.enabled : true,
      }),
    );
  }
  const defaults: Partial<Record<AiCapability, string>> = {};
  const d = src.defaults && typeof src.defaults === 'object' ? (src.defaults as Record<string, unknown>) : {};
  for (const cap of AI_CAPABILITIES) if (typeof d[cap] === 'string' && ID_PATTERN.test(d[cap] as string)) defaults[cap] = d[cap] as string;
  // Version 1 filled the background-removal default automatically, often with an OpenAI re-render.
  const bgDefault = providers.find((p) => p.id === defaults['background-removal']);
  if (!(typeof src.version === 'number' && src.version >= 2) && bgDefault && isRerenderBackgroundRemover(bgDefault)) delete defaults['background-removal'];
  if (local) seenWrites.set(local, { rev: typeof src.rev === 'string' ? src.rev : '', rememberKeys, stale: false });
  const s: AiSettings = { providers, defaults, rememberKeys };
  const kept = normalizeDefaults(s).defaults;
  // Defaults naming a server provider stay until mergeServerProviders validates them.
  for (const cap of AI_CAPABILITIES) if (defaults[cap]?.startsWith('server-')) kept[cap] = defaults[cap];
  return { ...s, defaults: kept };
}

function clearStore(store: KeyValueStore | null, key: string): void {
  if (!store) return;
  try {
    const s = store as KeyValueStore & { removeItem?: (k: string) => void };
    if (typeof s.removeItem === 'function') s.removeItem(`3dmarker:${key}`);
    else saveJSON(store, key, {});
  } catch {
    // blocked storage: ignore
  }
}

/**
 * What this tab last read from / wrote to a local store: the write id and
 * rememberKeys. Lets a tab notice that another tab turned remembering off
 * (see saveAiSettings).
 */
const seenWrites = new WeakMap<object, { rev: string; rememberKeys: boolean; stale: boolean }>();

const newRev = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Whether keys may go to localStorage: a tab whose rememberKeys=true is
 * stale (another tab has since saved rememberKeys=false) must not bring the
 * keys back to the device; it keeps them in sessionStorage until its own
 * user turns remembering off and on again.
 */
function effectiveRemember(local: KeyValueStore | null, wanted: boolean): boolean {
  const seen = local ? seenWrites.get(local) : undefined;
  if (!local || !seen) return wanted;
  if (!wanted) {
    seen.stale = false;
    return false;
  }
  if (seen.stale) return false;
  const stored = loadJSON(local, AI_SETTINGS_KEY) as { rev?: unknown; rememberKeys?: unknown } | null;
  const otherTabWrote = !!stored && typeof stored.rev === 'string' && stored.rev !== seen.rev;
  if (otherTabWrote && stored.rememberKeys !== true && seen.rememberKeys) {
    seen.stale = true;
    return false;
  }
  return true;
}

/**
 * Persists the settings; managed providers are skipped, keys go to exactly
 * one store. Returns the settings as saved (rememberKeys may be turned off
 * when another tab turned it off meanwhile).
 */
export function saveAiSettings(local: KeyValueStore | null, session: KeyValueStore | null, settings: AiSettings): AiSettings {
  const s = { ...settings, rememberKeys: effectiveRemember(local, settings.rememberKeys) };
  const own = s.providers.filter((p) => !p.managed && isProviderKindId(p.kind));
  const keys: Record<string, { apiKey: string; secrets?: Record<string, string> }> = {};
  const providers = own.map((p) => {
    const specs = getProviderKind(p.kind).fields;
    const secrets: Record<string, string> = {};
    for (const spec of secretSpecs(p.kind)) if (typeof p.values[spec.key] === 'string' && p.values[spec.key]) secrets[spec.key] = p.values[spec.key] as string;
    if (p.apiKey || Object.keys(secrets).length) keys[p.id] = { apiKey: p.apiKey, ...(Object.keys(secrets).length ? { secrets } : {}) };
    return { id: p.id, kind: p.kind, label: p.label, values: persistableParams(specs, p.values), models: p.models, enabled: p.enabled };
  });
  const rev = newRev();
  saveJSON(local, AI_SETTINGS_KEY, { version: VERSION, rev, providers, defaults: s.defaults, rememberKeys: s.rememberKeys });
  if (local) {
    const seen = seenWrites.get(local);
    seenWrites.set(local, { rev, rememberKeys: s.rememberKeys, stale: seen?.stale ?? false });
  }
  const target = s.rememberKeys ? local : session;
  const other = s.rememberKeys ? session : local;
  if (Object.keys(keys).length) saveJSON(target, AI_KEYS_KEY, keys);
  else clearStore(target, AI_KEYS_KEY);
  if (other !== target) clearStore(other, AI_KEYS_KEY);
  return s;
}

const T = {
  disabled: { tr: 'Devre dışı.', en: 'Disabled.' },
  noKey: { tr: 'API anahtarı girilmemiş.', en: 'No API key entered.' },
  needsServer: {
    tr: 'Bu sağlayıcı sunucu vekili gerektirir; sunucu yok (ör. statik demo).',
    en: 'This provider needs the server proxy, and there is no server (e.g. the static demo).',
  },
  baseUrl: { tr: 'Geçerli bir temel URL girin (https://…).', en: 'Enter a valid base URL (https://…).' },
  url: { tr: 'Geçerli bir URL girin (https://…).', en: 'Enter a valid URL (https://…).' },
  template: (field: string): I18nText => ({ tr: `“${field}” geçerli bir JSON değil.`, en: `“${field}” is not valid JSON.` }),
  unknown: { tr: 'Bilinmeyen sağlayıcı türü.', en: 'Unknown provider kind.' },
};

const isHttpUrl = (v: unknown) => typeof v === 'string' && /^https?:\/\/[^\s/]+/i.test(v.trim());

/** Can this config be used right now, and if not, why. */
export function providerUsable(cfg: ProviderConfig, serverAvailable: boolean): { ok: boolean; reason?: I18nText } {
  if (!isProviderKindId(cfg.kind)) return { ok: false, reason: T.unknown };
  if (!cfg.enabled) return { ok: false, reason: T.disabled };
  if (!cfg.managed && kindNeedsKey(cfg.kind) && !cleanKey(cfg.apiKey)) return { ok: false, reason: T.noKey };
  if (routeFor(cfg) === 'proxy' && !serverAvailable) return { ok: false, reason: T.needsServer };
  if (cfg.kind === 'openai-compatible' && !isHttpUrl(cfg.values.baseUrl)) return { ok: false, reason: T.baseUrl };
  if (cfg.kind === 'custom-http') {
    if (!isHttpUrl(cfg.values.url)) return { ok: false, reason: T.url };
    for (const key of ['headers', 'body']) if (!isValidTemplate(String(cfg.values[key] ?? ''))) return { ok: false, reason: T.template(key) };
  }
  if (cfg.kind === 'replicate' || cfg.kind === 'fal') {
    for (const spec of getProviderKind(cfg.kind).fields) {
      if (spec.kind === 'text' && /Template$/.test(spec.key) && !isValidTemplate(String(cfg.values[spec.key] ?? ''))) {
        return { ok: false, reason: T.template(spec.key) };
      }
    }
  }
  return { ok: true };
}

/**
 * The config to use for `cap`: enabled, usable and offering it — the
 * preferred id first, then the default for the capability, then the first.
 */
export function resolveProvider(s: AiSettings, cap: AiCapability, preferredId?: string | null, serverAvailable = false): ProviderConfig | null {
  const ok = (p: ProviderConfig) => p.enabled && supports(p, cap) && providerUsable(p, serverAvailable).ok;
  const byId = (id: string | null | undefined) => (id ? s.providers.find((p) => p.id === id && ok(p)) : undefined);
  if (cap === 'background-removal' && (preferredId === LOCAL_PROVIDER_ID || (!preferredId && s.defaults[cap] === LOCAL_PROVIDER_ID))) return null;
  // Falling back never picks a generative re-render for background removal (null = the local model).
  return byId(preferredId) ?? byId(s.defaults[cap]) ?? s.providers.find((p) => ok(p) && autoPickable(p, cap)) ?? null;
}

/** Usable configs offering `cap` (for pickers). */
export function usableProviders(s: AiSettings, cap: AiCapability, serverAvailable: boolean): ProviderConfig[] {
  return s.providers.filter((p) => p.enabled && supports(p, cap) && providerUsable(p, serverAvailable).ok);
}

/** Sanitises the server's announced providers: known kinds, ids 'server-…', managed, never a key. */
export function sanitizeServerProviders(raw: unknown): ProviderConfig[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { providers?: unknown }).providers) ? ((raw as { providers: unknown[] }).providers) : [];
  const out: ProviderConfig[] = [];
  for (const item of list.slice(0, MAX_PROVIDERS)) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    if (!isProviderKindId(p.kind) || typeof p.id !== 'string' || !p.id.startsWith('server-') || !ID_PATTERN.test(p.id)) continue;
    if (out.some((o) => o.id === p.id)) continue;
    out.push(
      createProviderConfig(p.kind, {
        id: p.id,
        label: typeof p.label === 'string' ? p.label : undefined,
        managed: true,
        values: p.values as ParamValues,
        models: p.models as Partial<Record<AiCapability, string>>,
        enabled: p.enabled !== false,
      }),
    );
  }
  return out;
}

export interface AiServerInfo {
  /** Managed providers (server keys). */
  providers: ProviderConfig[];
  /** Kinds the proxy forwards ([] when the server does not say). */
  proxyKinds: ProviderKindId[];
  /** The proxy relays users' own keys. */
  byok: boolean;
}

/**
 * True for the static build (VITE_STATIC_DEMO=1, e.g. GitHub Pages): there is
 * no API server, so probing it would only log a 404 in every visitor's console.
 */
export function apiServerDisabled(env: Record<string, unknown> = import.meta.env ?? {}): boolean {
  const v = String(env.VITE_STATIC_DEMO ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/**
 * GET /api/ai/providers → the server's AI info, or null when there is no
 * server (static hosting: network error, 404 page, HTML fallback).
 */
export async function fetchServerInfo(signal?: AbortSignal): Promise<AiServerInfo | null> {
  // Browsers log failed responses whatever JS does with them: don't send it at all.
  if (apiServerDisabled()) return null;
  try {
    const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(8000) : undefined;
    const sig = signal && timeout && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal ?? timeout;
    const res = await fetch(AI_PROVIDERS_PATH, { headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE, Accept: 'application/json' }, signal: sig });
    if (!res.ok) return null;
    if (!(res.headers.get('content-type') ?? '').includes('json')) return null;
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== 'object' || !Array.isArray((body as { providers?: unknown }).providers)) return null;
    const o = body as { proxyKinds?: unknown; byok?: unknown };
    return {
      providers: sanitizeServerProviders(body),
      proxyKinds: Array.isArray(o.proxyKinds) ? o.proxyKinds.filter(isProviderKindId) : [],
      byok: o.byok !== false,
    };
  } catch {
    return null;
  }
}

/** The server's managed providers ([] = a server without any), or null when there is no server. */
export async function fetchServerProviders(signal?: AbortSignal): Promise<ProviderConfig[] | null> {
  return (await fetchServerInfo(signal))?.providers ?? null;
}

/** Replaces the managed entries with the server's list (user entries first) and re-validates the defaults. */
export function mergeServerProviders(s: AiSettings, server: ProviderConfig[]): AiSettings {
  const own = s.providers.filter((p) => !p.managed);
  const ids = new Set(own.map((p) => p.id));
  const managed = server.filter((p) => !ids.has(p.id)).map((p) => ({ ...p, managed: true, apiKey: '' }));
  return normalizeDefaults({ ...s, providers: [...own, ...managed] });
}

let current: { settings: AiSettings; serverAvailable: boolean } = { settings: DEFAULT_AI_SETTINGS, serverAvailable: false };

/** Publishes the UI's settings so drivers (outside React) can read them. */
export function setCurrentAiSettings(s: AiSettings, serverAvailable: boolean): void {
  current = { settings: s, serverAvailable };
}

export function currentAiSettings(): { settings: AiSettings; serverAvailable: boolean } {
  return current;
}
