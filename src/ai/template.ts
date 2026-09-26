/**
 * Request templates and response paths for the generic kinds (Replicate,
 * fal.ai, custom HTTP). Pure functions.
 *
 * A template is JSON with `{{name}}` placeholders. A string that is exactly
 * one placeholder is replaced by the value itself (so `"{{images}}"` becomes
 * an array); a missing value drops that key / array item (optional views).
 * Placeholders inside longer strings are substituted as text.
 */
import { LocalizedError } from '../core/errors';

export type TemplateValue = string | string[];
export type TemplateVars = Record<string, TemplateValue | undefined>;

const WHOLE = /^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/;
const INLINE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const OMIT = Symbol('omit');

/** Parses a JSON template; a bilingual error names the field when it is not valid JSON. */
export function parseTemplate(text: string, fieldName = 'template'): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new LocalizedError({
      tr: `Şablon geçerli bir JSON değil (${fieldName}): ${detail}`,
      en: `The template is not valid JSON (${fieldName}): ${detail}`,
    });
  }
}

/** True when `text` is empty or parses as JSON. */
export function isValidTemplate(text: string): boolean {
  if (!text.trim()) return true;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Replaces placeholders in plain text (missing values become ''). */
export function renderString(s: string, vars: TemplateVars): string {
  return s.replace(INLINE, (_, name: string) => {
    const v = vars[name];
    return v === undefined ? '' : Array.isArray(v) ? v.join(',') : v;
  });
}

function render(value: unknown, vars: TemplateVars): unknown {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value);
    if (whole) {
      const v = vars[whole[1]];
      return v === undefined ? OMIT : Array.isArray(v) ? [...v] : v;
    }
    return renderString(value, vars);
  }
  if (Array.isArray(value)) return value.map((v) => render(v, vars)).filter((v) => v !== OMIT);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = render(v, vars);
      if (r !== OMIT) out[k] = r;
    }
    return out;
  }
  return value;
}

/** Renders a parsed template (see the module comment). */
export function renderTemplate(tpl: unknown, vars: TemplateVars): unknown {
  const r = render(tpl, vars);
  return r === OMIT ? null : r;
}

/** Placeholder names used anywhere in a template text. */
export function templatePlaceholders(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(INLINE)) out.add(m[1]);
  return [...out];
}

/**
 * JSONPath-lite: `data.0.b64_json`, `output[0].url`, `$.images[0].url`.
 * Returns undefined when any step is missing.
 */
export function getPath(obj: unknown, path: string): unknown {
  const steps = path
    .trim()
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur: unknown = obj;
  for (const step of steps) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[step];
  }
  return cur;
}

const IMAGE_EXT = /\.(png|webp|jpe?g|gif)(\?|#|$)/i;
const MODEL_EXT = /\.glb(\?|#|$)/i;

const isFileRef = (s: string) => /^https?:\/\//i.test(s) || /^data:[^,]*;base64,/i.test(s);

/**
 * Finds the most plausible output file (URL or data URI) in a provider's
 * result: `prefer` 'image' favours image extensions / "image" keys and skips
 * masks; 'model' favours .glb / "glb" keys and skips previews. Null when the
 * result holds no URL at all.
 */
export function findOutputUrl(value: unknown, prefer: 'image' | 'model'): string | null {
  let best: { url: string; score: number } | null = null;
  const visit = (v: unknown, path: string, contentType: string) => {
    if (typeof v === 'string') {
      if (!isFileRef(v)) return;
      const key = path.toLowerCase();
      const type = (contentType || (/^data:([^;,]*)/i.exec(v)?.[1] ?? '')).toLowerCase();
      let score = 0;
      if (prefer === 'model') {
        if (MODEL_EXT.test(v) || type.includes('gltf')) score += 3;
        if (key.includes('glb')) score += 2;
        if (key.includes('pbr')) score += 1;
        if (key.includes('mesh') || key.includes('model')) score += 1;
        if (IMAGE_EXT.test(v) || type.startsWith('image/') || /thumb|render|preview|video/.test(key)) score -= 5;
      } else {
        if (IMAGE_EXT.test(v) || type.startsWith('image/')) score += 3;
        if (key.includes('image')) score += 1;
        if (/mask|thumb|depth/.test(key)) score -= 5;
      }
      if (!best || score > best.score) best = { url: v, score };
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, `${path}.${i}`, ''));
      return;
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const ct = typeof o.content_type === 'string' ? o.content_type : typeof o.contentType === 'string' ? o.contentType : '';
      for (const [k, child] of Object.entries(o)) visit(child, path ? `${path}.${k}` : k, ct);
    }
  };
  visit(value, '', '');
  return (best as { url: string; score: number } | null)?.url ?? null;
}
