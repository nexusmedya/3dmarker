/**
 * OpenAI Images API (POST /v1/images/edits, multipart), also used by the
 * 'openai-compatible' kind against its own base URL.
 *
 * Verified against openai-node 7.23 (resources/images.d.ts ImageEditParams):
 * fields model, prompt, image (one file) or image[] (several, as the SDK
 * encodes arrays), background 'transparent' | 'opaque' | 'auto',
 * input_fidelity 'high' | 'low', output_format 'png', quality, size
 * ('auto' | '1024x1024' | '1024x1536' | '1536x1024'); the response is
 * ImagesResponse { data: [{ b64_json }] } (GPT image models always return
 * base64; dall-e-2 needs response_format 'b64_json').
 */
import type { ImageEditRequest, ProviderAdapter, ProviderConfig } from '../types';
import { base64ToBlob } from '../encode';
import { aiFetch, AiError, downloadOutput, providerName, readJson } from '../transport';
import { asImage, fileName, modelFor, prepareImages, PROGRESS } from './common';

type OpenAiKind = 'openai' | 'openai-compatible';

/** Prompt of the background-removal capability (the model re-renders the image with alpha). */
export const REMOVE_BG_PROMPT =
  'Remove the background completely and return the same image with a fully transparent background. Keep the subject exactly as it is: same shape, pose, colours, details and framing; do not add shadows, a floor or any new elements.';

const isGptImage = (model: string) => /^(gpt-image|chatgpt-image)/.test(model);

/** ASSUMPTION: input_fidelity is accepted by gpt-image-1 / 1.5 (not the mini); gpt-image-2 ignores it. */
const supportsFidelity = (model: string) => /^gpt-image-1(\.5)?(-\d{4}-\d{2}-\d{2})?$/.test(model);

/** The request size for the chosen setting and the wanted aspect. */
export function openAiSize(setting: unknown, aspect: ImageEditRequest['aspect']): string | undefined {
  if (setting === 'auto') return 'auto';
  if (typeof setting === 'string' && /^\d+x\d+$/.test(setting)) return setting;
  // 'match' (default): one of the standard sizes supported by every GPT image model.
  if (aspect === 'portrait') return '1024x1536';
  if (aspect === 'landscape') return '1536x1024';
  if (aspect === 'square') return '1024x1024';
  // No aspect (background removal): leave it to the server default rather than 'auto',
  // which not every GPT image model documents.
  return undefined;
}

export function editPath(kind: OpenAiKind): string {
  return kind === 'openai' ? 'v1/images/edits' : 'images/edits';
}

/** Multipart body of POST /images/edits. */
export function buildEditForm(
  cfg: ProviderConfig,
  model: string,
  req: Pick<ImageEditRequest, 'prompt' | 'transparentBackground' | 'aspect'>,
  images: Blob[],
): FormData {
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', req.prompt);
  if (images.length === 1) form.append('image', images[0], fileName(images[0], 'image'));
  else images.forEach((b, i) => form.append('image[]', b, fileName(b, `image-${i + 1}`)));
  const gpt = isGptImage(model);
  if (gpt) {
    // Only 'transparent' is sent: the server default is 'auto', and the 2.5 models document only opaque / transparent.
    if (req.transparentBackground) form.append('background', 'transparent');
    form.append('output_format', 'png');
    const quality = cfg.values.quality;
    if (typeof quality === 'string' && quality !== 'auto') form.append('quality', quality);
    const fidelity = cfg.values.inputFidelity;
    if ((fidelity === 'high' || fidelity === 'low') && supportsFidelity(model)) form.append('input_fidelity', fidelity);
  } else if (model.startsWith('dall-e')) {
    form.append('response_format', 'b64_json');
  }
  const size = openAiSize(cfg.values.size, req.aspect);
  if (size && (gpt || size !== 'auto')) form.append('size', size);
  return form;
}

interface ImagesResponse {
  data?: { b64_json?: string; url?: string }[];
}

/** First image of an ImagesResponse. */
export async function parseImagesResponse(body: ImagesResponse, name: string, signal: AbortSignal): Promise<Blob> {
  const first = body.data?.[0];
  if (first?.b64_json) return base64ToBlob(first.b64_json);
  if (first?.url) return downloadOutput(first.url, { signal });
  throw new AiError(
    { tr: `${name} yanıtında görsel yok.`, en: `The ${name} response contains no image.` },
    'bad-response',
  );
}

export function createOpenAiAdapter(kind: OpenAiKind): ProviderAdapter {
  async function edit(cfg: ProviderConfig, model: string, req: ImageEditRequest): Promise<Blob> {
    const name = providerName(cfg);
    req.onProgress?.(PROGRESS.sending(name));
    const images = await prepareImages(req.images.slice(0, 16));
    const form = buildEditForm(cfg, model, req, images);
    req.onProgress?.(PROGRESS.generating(name));
    const res = await aiFetch(cfg, editPath(kind), { method: 'POST', body: form, signal: req.signal });
    const body = await readJson<ImagesResponse>(res, name, req.signal);
    return asImage(await parseImagesResponse(body, name, req.signal), name);
  }

  return {
    kind,
    editImageLimit: () => 16,
    // GPT image models return real alpha with background=transparent (dall-e does not).
    supportsAlpha: (cfg) => isGptImage(modelFor(cfg, 'image-edit')),
    editImage: (cfg, req) => edit(cfg, modelFor(cfg, 'image-edit'), req),
    removeBackground: (cfg, image, signal) =>
      edit(cfg, modelFor(cfg, 'background-removal'), {
        prompt: REMOVE_BG_PROMPT,
        images: [image],
        transparentBackground: true,
        signal,
      }),
    async testConnection(cfg, signal) {
      await aiFetch(cfg, kind === 'openai' ? 'v1/models' : 'models', { method: 'GET', signal, timeoutMs: 20_000 });
      return { ok: true };
    },
  };
}

export const openAiAdapter = createOpenAiAdapter('openai');
export const openAiCompatibleAdapter = createOpenAiAdapter('openai-compatible');
