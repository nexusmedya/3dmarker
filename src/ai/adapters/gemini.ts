/**
 * Google Gemini image models (POST /v1beta/models/{model}:generateContent).
 *
 * Verified against @google/genai 2.24 (the Gemini Developer API "mldev"
 * converters): REST JSON is camelCase — contents[].parts[] with { text } or
 * { inlineData: { mimeType, data } }, generationConfig.responseModalities
 * (Modality 'IMAGE' / 'TEXT'), generationConfig.imageConfig { aspectRatio
 * ('1:1', '3:4', '4:3' …), imageSize ('1K' | '2K' | '4K') }; the key goes in
 * the x-goog-api-key header. The image comes back as
 * candidates[0].content.parts[].inlineData.data (base64). Gemini cannot
 * return transparency: the caller removes the background afterwards.
 */
import type { ImageEditRequest, ProviderAdapter, ProviderConfig } from '../types';
import { base64ToBlob, blobToBase64 } from '../encode';
import { aiFetch, AiError, AI_ERROR_TEXT, providerName, readJson } from '../transport';
import { asImage, modelFor, prepareImages, PROGRESS } from './common';

const ASPECT: Record<NonNullable<ImageEditRequest['aspect']>, string> = { square: '1:1', portrait: '3:4', landscape: '4:3' };

/** Finish / block reasons that mean the safety filters stopped the request. */
const BLOCKED = /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/;

export function generatePath(model: string): string {
  return `v1beta/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`;
}

export async function buildGenerateBody(
  cfg: ProviderConfig,
  req: Pick<ImageEditRequest, 'prompt' | 'aspect'>,
  images: Blob[],
): Promise<Record<string, unknown>> {
  const parts: Record<string, unknown>[] = [{ text: req.prompt }];
  for (const img of images) parts.push({ inlineData: { mimeType: img.type || 'image/png', data: await blobToBase64(img) } });
  const imageConfig: Record<string, string> = {};
  if (req.aspect) imageConfig.aspectRatio = ASPECT[req.aspect];
  const size = cfg.values.imageSize;
  if (typeof size === 'string' && /^[124]K$/.test(size)) imageConfig.imageSize = size;
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      // ASSUMPTION: image-only output is accepted by every Gemini image model (documented for 2.5 Flash Image).
      responseModalities: ['IMAGE'],
      ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
    },
  };
}

interface Part {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
}

interface GenerateResponse {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string; finishMessage?: string }[];
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
}

/** The final (non-thought) image of a generateContent response. */
export function parseGenerateResponse(body: GenerateResponse, name: string): Blob {
  const block = body.promptFeedback?.blockReason;
  if (block) {
    const d = body.promptFeedback?.blockReasonMessage || block;
    throw new AiError(AI_ERROR_TEXT.contentPolicy(name, d), 'content-policy', 0, d);
  }
  const cand = body.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  let image: { mime: string; data: string } | null = null;
  const texts: string[] = [];
  for (const p of parts) {
    const inline = p.inlineData ? { mime: p.inlineData.mimeType ?? '', data: p.inlineData.data ?? '' } : p.inline_data ? { mime: p.inline_data.mime_type ?? '', data: p.inline_data.data ?? '' } : null;
    if (inline?.data && !p.thought) image = inline;
    else if (typeof p.text === 'string' && !p.thought) texts.push(p.text);
  }
  if (image) return base64ToBlob(image.data, image.mime.startsWith('image/') ? image.mime : undefined);
  const reason = cand?.finishReason ?? '';
  if (BLOCKED.test(reason)) {
    const d = cand?.finishMessage || reason;
    throw new AiError(AI_ERROR_TEXT.contentPolicy(name, d), 'content-policy', 0, d);
  }
  const said = texts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  throw new AiError(
    {
      tr: `${name} görsel yerine yalnızca metin döndürdü${said ? `: “${said}”` : ''}${reason ? ` (${reason})` : ''}. Tekrar deneyin ya da başka bir model seçin.`,
      en: `${name} returned no image${said ? `, only text: “${said}”` : ''}${reason ? ` (${reason})` : ''}. Try again or pick another model.`,
    },
    'bad-response',
    0,
    said || reason,
  );
}

export const geminiAdapter: ProviderAdapter = {
  kind: 'gemini',
  async editImage(cfg, req) {
    const name = providerName(cfg);
    const model = modelFor(cfg, 'image-edit');
    req.onProgress?.(PROGRESS.sending(name));
    const images = await prepareImages(req.images.slice(0, 14));
    const body = await buildGenerateBody(cfg, req, images);
    req.onProgress?.(PROGRESS.generating(name));
    const res = await aiFetch(cfg, generatePath(model), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    return asImage(parseGenerateResponse(await readJson<GenerateResponse>(res, name, req.signal), name), name);
  },
  async testConnection(cfg, signal) {
    await aiFetch(cfg, 'v1beta/models?pageSize=1', { method: 'GET', signal, timeoutMs: 20_000 });
    return { ok: true };
  },
};
