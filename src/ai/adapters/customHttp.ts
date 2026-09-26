/**
 * Fully custom HTTP endpoint, called directly from the browser (it must send
 * CORS headers). The settings give the URL, method, a JSON headers template
 * ({{key}}), a JSON body template (see ../template) sent as JSON or as
 * multipart (whole-placeholder image values become file parts), and where
 * the result is: the response body itself, or a JSONPath-lite path to a
 * base64 string, data URI or URL.
 */
import type { ViewId } from '../../core/types';
import { VIEW_IDS } from '../../core/types';
import type { AiCapability, ProviderAdapter, ProviderConfig } from '../types';
import { base64ToBlob, dataUriToBlob } from '../encode';
import { AiError, cleanKey, downloadOutput, providerName, readJson, send } from '../transport';
import { findOutputUrl, getPath, parseTemplate, renderString, renderTemplate } from '../template';
import { asGlb, asImage, buildTemplateVars, fileName, prepareImages, PROGRESS, templateTakesSeveralImages, toModelPlan, unsupported } from './common';

export interface CustomRequestData {
  prompt?: string;
  images?: Blob[];
  views?: Partial<Record<ViewId, Blob>>;
}

const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const WHOLE = /^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/;

function incomplete(cfg: ProviderConfig, what: string): AiError {
  const n = providerName(cfg);
  return new AiError({ tr: `${n}: ${what} ayarı eksik ya da geçersiz.`, en: `${n}: the ${what} setting is missing or invalid.` }, 'bad-request');
}

/** Blobs a whole-placeholder multipart value stands for (null when it is not an image placeholder). */
function blobsFor(name: string, images: Blob[], views: Partial<Record<ViewId, Blob>>): Blob[] | null {
  if (name === 'images') return images;
  if (name === 'image') return images[0] ? [images[0]] : [];
  const n = /^image(\d+)$/.exec(name);
  if (n) return images[Number(n[1]) - 1] ? [images[Number(n[1]) - 1]] : [];
  if ((VIEW_IDS as string[]).includes(name)) return views[name as ViewId] ? [views[name as ViewId] as Blob] : [];
  return null;
}

/** URL and fetch init of a request (exported for tests). */
export async function buildCustomRequest(cfg: ProviderConfig, data: CustomRequestData): Promise<{ url: string; method: string; headers: Record<string, string>; body: BodyInit }> {
  const key = cleanKey(cfg.apiKey);
  const url = renderString(str(cfg.values.url).trim(), { key });
  if (!/^https?:\/\/[^\s]+$/i.test(url)) throw incomplete(cfg, 'URL');
  const method = str(cfg.values.method, 'POST') === 'PUT' ? 'PUT' : 'POST';

  const headers: Record<string, string> = {};
  const headerTpl = str(cfg.values.headers).trim();
  if (headerTpl) {
    const parsed = parseTemplate(headerTpl, 'headers');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw incomplete(cfg, 'headers');
    for (const [k, v] of Object.entries(parsed)) {
      const value = renderString(String(v), { key }).trim();
      if (value) headers[k] = value;
    }
  }

  const bodyText = str(cfg.values.body).trim() || '{}';
  const images = data.images ?? (VIEW_IDS.map((v) => data.views?.[v]).filter(Boolean) as Blob[]);
  const views: Partial<Record<ViewId, Blob>> = { ...(data.views ?? {}) };
  if (!views.front && images[0]) views.front = images[0];

  if (cfg.values.bodyType === 'multipart') {
    const tpl = parseTemplate(bodyText, 'body');
    if (!tpl || typeof tpl !== 'object' || Array.isArray(tpl)) throw incomplete(cfg, 'body');
    const vars = { prompt: data.prompt, key };
    const form = new FormData();
    for (const [k, v] of Object.entries(tpl)) {
      const whole = typeof v === 'string' ? WHOLE.exec(v) : null;
      const blobs = whole ? blobsFor(whole[1], images, views) : null;
      if (blobs) blobs.forEach((b, i) => form.append(k, b, fileName(b, blobs.length > 1 ? `${k}-${i + 1}` : k)));
      else if (typeof v === 'string') form.append(k, renderString(v, vars));
      else form.append(k, JSON.stringify(v));
    }
    return { url, method, headers, body: form };
  }

  const vars = await buildTemplateVars(bodyText, { prompt: data.prompt, key, images, views });
  const body = JSON.stringify(renderTemplate(parseTemplate(bodyText, 'body'), vars));
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  return { url, method, headers, body };
}

/** The result file of a JSON response: value at the configured path (base64, data URI or URL). */
export async function resultFromJson(cfg: ProviderConfig, json: unknown, prefer: 'image' | 'model', signal: AbortSignal): Promise<Blob> {
  const path = str(cfg.values.responsePath).trim();
  let v: unknown = path ? getPath(json, path) : findOutputUrl(json, prefer);
  if (v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string') v = (v as { url: string }).url;
  if (typeof v !== 'string' || !v) {
    const n = providerName(cfg);
    throw new AiError(
      { tr: `${n} yanıtında “${path}” yolunda değer yok.`, en: `The ${n} response has no value at “${path}”.` },
      'bad-response',
    );
  }
  if (v.startsWith('data:')) {
    const blob = dataUriToBlob(v);
    if (blob) return blob;
  }
  if (/^https?:\/\//i.test(v)) return downloadOutput(v, { signal });
  try {
    return base64ToBlob(v);
  } catch {
    throw new AiError({ tr: `${providerName(cfg)} yanıtındaki değer çözülemedi.`, en: `Could not decode the value in the ${providerName(cfg)} response.` }, 'bad-response');
  }
}

async function call(cfg: ProviderConfig, cap: AiCapability, data: CustomRequestData, signal: AbortSignal, prefer: 'image' | 'model'): Promise<Blob> {
  const serves = str(cfg.values.capability, 'image-edit');
  if (serves !== cap) {
    throw unsupported(cfg, { tr: `bu uç nokta “${serves}” için ayarlı.`, en: `this endpoint is set up for “${serves}”.` });
  }
  const name = providerName(cfg);
  const req = await buildCustomRequest(cfg, data);
  const res = await send(req.url, { method: req.method, headers: req.headers, body: req.body, signal }, { name, route: 'direct', key: cleanKey(cfg.apiKey) });
  if (cfg.values.responseType === 'binary') return res.blob();
  return resultFromJson(cfg, await readJson(res, name, signal), prefer, signal);
}

export const customHttpAdapter: ProviderAdapter = {
  kind: 'custom-http',
  editImageLimit: (cfg) => (templateTakesSeveralImages(str(cfg.values.body)) ? Infinity : 1),
  async editImage(cfg, req) {
    req.onProgress?.(PROGRESS.generating(providerName(cfg)));
    const images = await prepareImages(req.images, { keepAlpha: false });
    return asImage(await call(cfg, 'image-edit', { prompt: req.prompt, images }, req.signal, 'image'), providerName(cfg));
  },
  async removeBackground(cfg, image, signal) {
    const images = await prepareImages([image], { keepAlpha: false });
    return asImage(await call(cfg, 'background-removal', { images }, signal, 'image'), providerName(cfg));
  },
  async toModel(cfg, req) {
    req.onProgress?.(PROGRESS.generating(providerName(cfg)));
    const { cap, views } = toModelPlan(cfg, req);
    const prepared: Partial<Record<ViewId, Blob>> = {};
    for (const v of VIEW_IDS) if (views[v]) prepared[v] = (await prepareImages([views[v]]))[0];
    return asGlb(await call(cfg, cap, { views: prepared }, req.signal, 'model'), providerName(cfg));
  },
};
