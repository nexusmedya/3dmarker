/**
 * localStorage persistence (per-viewer conveniences only). Every access is
 * guarded: storage may be missing, full or blocked (private mode, previews).
 * Secret params (API keys) are never written.
 */
import type { ParamSpec, ParamValue, ParamValues } from '../core/types';

const PREFIX = '3dmarker:';

/** Minimal Storage surface (lets tests pass a fake). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function browserStorage(): KeyValueStore | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadJSON(store: KeyValueStore | null, key: string): unknown {
  if (!store) return undefined;
  try {
    const raw = store.getItem(PREFIX + key);
    return raw == null ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

export function saveJSON(store: KeyValueStore | null, key: string, value: unknown): void {
  if (!store) return;
  try {
    store.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // quota exceeded / blocked: ignore
  }
}

/** Validate one value against its spec; returns undefined when unusable. */
export function sanitizeValue(spec: ParamSpec, value: unknown): ParamValue | undefined {
  switch (spec.kind) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      return Math.min(spec.max, Math.max(spec.min, value));
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'select':
      return typeof value === 'string' && spec.options.some((o) => o.value === value) ? value : undefined;
    case 'text':
      return typeof value === 'string' ? value : undefined;
  }
}

/** Defaults overlaid with every valid stored value (unknown keys dropped). */
export function sanitizeParams(specs: ParamSpec[], stored: unknown): ParamValues {
  const src = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  const out: ParamValues = {};
  for (const s of specs) {
    const v = s.key in src ? sanitizeValue(s, src[s.key]) : undefined;
    out[s.key] = v ?? s.default;
  }
  return out;
}

/** Values safe to persist: secret text params removed. */
export function persistableParams(specs: ParamSpec[], values: ParamValues): ParamValues {
  const secret = new Set(specs.filter((s) => s.kind === 'text' && s.secret).map((s) => s.key));
  const out: ParamValues = {};
  for (const [k, v] of Object.entries(values)) if (!secret.has(k)) out[k] = v;
  return out;
}
