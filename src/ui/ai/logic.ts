/**
 * Pure helpers behind the AI components (Node-testable): style search, the
 * settings edits of the providers dialog, and the human-detection summary.
 */
import type { HumanAnalysis } from '../../core/human/types';
import type { AiCapability, AiSettings, ProviderConfig, ProviderKindId, StyleCategory, StylePreset } from '../../ai/types';
import { STYLE_CATEGORIES } from '../../ai/styles';
import { getProviderKind } from '../../ai/kinds';
import { createProviderConfig, normalizeDefaults } from '../../ai/settings';

// ---------- Style search ----------

/** Lower case without diacritics, Turkish dotless / dotted i folded to "i" ("Şeker" → "seker"). */
export function foldText(s: string): string {
  return s
    .replace(/[İIı]/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

const CATEGORY_NAMES = new Map(STYLE_CATEGORIES.map((c) => [c.id, c.name]));

function haystack(s: StylePreset): string {
  const cat = CATEGORY_NAMES.get(s.category);
  return foldText([s.id.replace(/-/g, ' '), s.name.tr, s.name.en, cat?.tr ?? '', cat?.en ?? ''].join(' '));
}

/** Styles in `category` ('all' = any) whose names match every word of `query` (either language). */
export function filterStyles(styles: StylePreset[], query: string, category: StyleCategory | 'all'): StylePreset[] {
  const words = foldText(query).split(/\s+/).filter(Boolean);
  return styles.filter((s) => {
    if (category !== 'all' && s.category !== category) return false;
    if (!words.length) return true;
    const h = haystack(s);
    return words.every((w) => h.includes(w));
  });
}

// ---------- Provider settings edits ----------

/** `base`, or `base 2`, `base 3`… when a provider already uses that label. */
export function uniqueLabel(providers: ProviderConfig[], base: string): string {
  const taken = new Set(providers.map((p) => p.label.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** Appends a new entry of `kind` (unique label); defaults are filled for capabilities that had none. */
export function addProvider(s: AiSettings, kind: ProviderKindId): { settings: AiSettings; id: string } {
  const cfg = createProviderConfig(kind, { label: uniqueLabel(s.providers, getProviderKind(kind).name) });
  return { settings: normalizeDefaults({ ...s, providers: [...s.providers, cfg] }), id: cfg.id };
}

/**
 * Shallow patch of one entry. Values are NOT re-sanitised here (that would
 * trim a label while it is typed); loadAiSettings sanitises on the next load.
 */
export function updateProvider(s: AiSettings, id: string, patch: Partial<Omit<ProviderConfig, 'id' | 'kind' | 'managed'>>): AiSettings {
  let changed = false;
  const providers = s.providers.map((p) => {
    if (p.id !== id) return p;
    changed = true;
    return { ...p, ...patch };
  });
  return changed ? normalizeDefaults({ ...s, providers }) : s;
}

/** Removes an entry (managed ones cannot be removed: the server announces them again). */
export function removeProvider(s: AiSettings, id: string): AiSettings {
  const target = s.providers.find((p) => p.id === id);
  if (!target || target.managed) return s;
  const defaults = { ...s.defaults };
  for (const cap of Object.keys(defaults) as AiCapability[]) if (defaults[cap] === id) delete defaults[cap];
  return normalizeDefaults({ ...s, providers: s.providers.filter((p) => p.id !== id), defaults });
}

export function setDefaultProvider(s: AiSettings, cap: AiCapability, id: string): AiSettings {
  return { ...s, defaults: { ...s.defaults, [cap]: id } };
}

/** Capabilities for which `id` is the default. */
export function defaultsOf(s: AiSettings, id: string): AiCapability[] {
  return (Object.keys(s.defaults) as AiCapability[]).filter((cap) => s.defaults[cap] === id);
}

/** Is `model` one of the kind's suggestions for `cap`? (Else the model field shows the free-text box.) */
export function isSuggestedModel(kind: ProviderKindId, cap: AiCapability, model: string): boolean {
  return (getProviderKind(kind).models[cap] ?? []).some((m) => m.id === model);
}

// ---------- Human detection ----------

export type DetectionState =
  | { kind: 'none' }
  | { kind: 'analyzing' }
  | { kind: 'unavailable'; reason: { tr: string; en: string } | null }
  | { kind: 'human'; faces: number; hands: number; poses: number }
  | { kind: 'not-human' };

export function detectionState(human: HumanAnalysis | 'analyzing' | null): DetectionState {
  if (human === null) return { kind: 'none' };
  if (human === 'analyzing') return { kind: 'analyzing' };
  if (human.isHuman) return { kind: 'human', faces: human.faces.length, hands: human.hands.length, poses: human.poses.length };
  if (human.unavailableReason || human.unavailableText) {
    const reason = human.unavailableText ?? (human.unavailableReason ? { tr: human.unavailableReason, en: human.unavailableReason } : null);
    return { kind: 'unavailable', reason };
  }
  return { kind: 'not-human' };
}
