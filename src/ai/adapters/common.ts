/** Helpers shared by the provider adapters. */
import type { I18nText, Progress, ViewId } from '../../core/types';
import { VIEW_IDS } from '../../core/types';
import type { AiCapability, ProviderConfig, ToModelRequest } from '../types';
import { configCapabilities, defaultModel } from '../kinds';
import { blobToBase64, isGlbBuffer, sniffType, toUploadPng } from '../encode';
import { AiError, providerName } from '../transport';
import { templatePlaceholders, type TemplateVars } from '../template';

/** The model id chosen for a capability (the kind's first suggestion when unset). */
export function modelFor(cfg: ProviderConfig, cap: AiCapability): string {
  const chosen = (cfg.models[cap] ?? '').trim();
  const id = chosen || defaultModel(cfg.kind, cap);
  if (!id) {
    const n = providerName(cfg);
    throw new AiError(
      { tr: `${n} için bu işlemde kullanılacak model seçilmemiş.`, en: `No model is chosen for this task in ${n}.` },
      'bad-request',
    );
  }
  return id;
}

/**
 * The capability a toModel request runs as, and the views it sends
 * (image-to-3d: the front only).
 */
export function toModelPlan(cfg: ProviderConfig, req: ToModelRequest): { cap: 'image-to-3d' | 'multiview-to-3d'; views: Partial<Record<ViewId, Blob>> } {
  const caps = configCapabilities(cfg);
  const extra = (Object.keys(req.views) as ViewId[]).some((v) => v !== 'front' && req.views[v]);
  let cap = req.capability ?? (extra && caps.includes('multiview-to-3d') ? 'multiview-to-3d' : 'image-to-3d');
  if (!caps.includes(cap)) cap = caps.includes('image-to-3d') ? 'image-to-3d' : 'multiview-to-3d';
  const views = cap === 'image-to-3d' ? (req.views.front ? { front: req.views.front } : {}) : { ...req.views };
  if (!views.front) {
    throw new AiError(
      { tr: `${providerName(cfg)}: ön görünüm gerekli.`, en: `${providerName(cfg)}: the front view is required.` },
      'bad-request',
    );
  }
  return { cap, views };
}

/** Downscaled PNGs of the reference images (as-is outside the browser). */
export function prepareImages(images: Blob[]): Promise<Blob[]> {
  return Promise.all(images.map((b) => toUploadPng(b)));
}

export function fileName(blob: Blob, base: string): string {
  const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
  return `${base}.${ext}`;
}

export function unsupported(cfg: ProviderConfig, what: I18nText): AiError {
  const n = providerName(cfg);
  return new AiError({ tr: `${n}: ${what.tr}`, en: `${n}: ${what.en}` }, 'unsupported');
}

/** Validates a GLB download; AiError 'bad-response' otherwise. */
export async function asGlb(blob: Blob, name: string): Promise<ArrayBuffer> {
  const buf = await blob.arrayBuffer();
  if (isGlbBuffer(buf)) return buf;
  const type = sniffType(new Uint8Array(buf.slice(0, 16))) ?? blob.type ?? 'unknown';
  throw new AiError(
    {
      tr: `${name} geçerli bir GLB (ikili glTF) dosyası döndürmedi (${type}). Çıktı biçimi GLB olan bir model ya da çıktı yolu seçin.`,
      en: `${name} did not return a valid GLB (binary glTF) file (${type}). Choose a model or output path that yields GLB.`,
    },
    'bad-response',
  );
}

/** Validates an image result; AiError 'bad-response' otherwise. */
export async function asImage(blob: Blob, name: string): Promise<Blob> {
  const type = sniffType(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
  if (type && type.startsWith('image/')) return blob.type === type ? blob : new Blob([blob], { type });
  throw new AiError(
    { tr: `${name} bir görsel döndürmedi.`, en: `${name} did not return an image.` },
    'bad-response',
  );
}

export const PROGRESS = {
  sending: (n: string): Progress => ({ label: { tr: `${n} isteği gönderiliyor`, en: `Sending the request to ${n}` } }),
  working: (n: string): Progress => ({ label: { tr: `${n} çalışıyor…`, en: `${n} is working…` } }),
  queued: (n: string, pos?: number): Progress => ({
    label: {
      tr: `${n} kuyruğunda bekleniyor${pos != null ? ` (sıra ${pos + 1})` : ''}`,
      en: `Waiting in the ${n} queue${pos != null ? ` (position ${pos + 1})` : ''}`,
    },
  }),
  generating: (n: string, pct?: number): Progress => ({
    label: {
      tr: `${n} üretiyor…${pct != null ? ` %${pct}` : ''}`,
      en: `${n} is generating…${pct != null ? ` ${pct}%` : ''}`,
    },
    ratio: pct != null ? pct / 100 : undefined,
  }),
  downloading: (n: string): Progress => ({ label: { tr: `${n} sonucu indiriliyor`, en: `Downloading the ${n} result` } }),
};

/**
 * Template variables for the generic kinds, computed only for the
 * placeholders the template uses: {{prompt}}, {{key}}, {{image}},
 * {{image2}}…, {{images}}, the six view names, each with a `_base64` twin
 * (raw base64 instead of a data URI).
 */
export async function buildTemplateVars(
  templateText: string,
  data: { prompt?: string; key?: string; images?: Blob[]; views?: Partial<Record<ViewId, Blob>>; swapSides?: boolean },
): Promise<TemplateVars> {
  const used = new Set(templatePlaceholders(templateText));
  const vars: TemplateVars = {};
  if (data.prompt !== undefined) vars.prompt = data.prompt;
  if (data.key !== undefined) vars.key = data.key;
  const views: Partial<Record<ViewId, Blob>> = { ...(data.views ?? {}) };
  if (data.swapSides) [views.left, views.right] = [views.right, views.left];
  const images = data.images ?? (VIEW_IDS.map((v) => views[v]).filter(Boolean) as Blob[]);
  if (!views.front && images[0]) views.front = images[0];

  const cache = new Map<Blob, Promise<{ uri: string; b64: string }>>();
  const encode = (b: Blob) => {
    let p = cache.get(b);
    if (!p) {
      p = blobToBase64(b).then((b64) => ({ uri: `data:${b.type || 'image/png'};base64,${b64}`, b64 }));
      cache.set(b, p);
    }
    return p;
  };
  const put = async (name: string, blob: Blob | undefined) => {
    if (!blob) return;
    if (used.has(name)) vars[name] = (await encode(blob)).uri;
    if (used.has(`${name}_base64`)) vars[`${name}_base64`] = (await encode(blob)).b64;
  };
  await put('image', images[0]);
  for (let i = 1; i < images.length; i++) await put(`image${i + 1}`, images[i]);
  for (const v of VIEW_IDS) await put(v, views[v]);
  if (used.has('images')) vars.images = await Promise.all(images.map(async (b) => (await encode(b)).uri));
  if (used.has('images_base64')) vars.images_base64 = await Promise.all(images.map(async (b) => (await encode(b)).b64));
  return vars;
}
