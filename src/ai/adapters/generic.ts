/**
 * Shared flow of the template-driven kinds (Replicate, fal.ai): pick the
 * template, render it with the images, run the job, then locate and
 * download the output file.
 */
import type { Progress, ViewId } from '../../core/types';
import type { AiCapability, ProviderConfig } from '../types';
import { AiError, downloadOutput, providerName } from '../transport';
import { findOutputUrl, getPath, parseTemplate, renderTemplate } from '../template';
import { buildTemplateVars, modelFor, prepareImages, PROGRESS } from './common';
import { resolveTemplate } from './presets';
import { VIEW_LABELS } from '../views';

export interface GenericRequest {
  prompt?: string;
  images?: Blob[];
  views?: Partial<Record<ViewId, Blob>>;
  signal: AbortSignal;
  onProgress?: (p: Progress) => void;
}

export type JobRunner = (model: string, input: unknown, req: GenericRequest) => Promise<unknown>;

/** The rendered input object of a request (exported for tests). */
export async function buildGenericInput(cfg: ProviderConfig, cap: AiCapability, model: string, req: Omit<GenericRequest, 'signal'>): Promise<unknown> {
  const { text, requires } = resolveTemplate(cfg, cap, model);
  const views = req.views ?? {};
  const missing = requires.filter((v) => !views[v]);
  if (missing.length) {
    const n = providerName(cfg);
    const tr = missing.map((v) => VIEW_LABELS[v].tr).join(', ');
    const en = missing.map((v) => VIEW_LABELS[v].en).join(', ');
    throw new AiError(
      { tr: `${n} / ${model} şu görünümleri de ister: ${tr}.`, en: `${n} / ${model} also needs these views: ${en}.` },
      'bad-request',
    );
  }
  const vars = await buildTemplateVars(text, {
    prompt: req.prompt,
    images: req.images,
    views: req.views,
    swapSides: cfg.values.swapSides === true,
  });
  return renderTemplate(parseTemplate(text, model), vars);
}

/** The output file URL of a finished job: the configured output path, else the best guess. */
export function outputUrl(cfg: ProviderConfig, output: unknown, prefer: 'image' | 'model'): string {
  const path = typeof cfg.values.outputPath === 'string' ? cfg.values.outputPath.trim() : '';
  let url: unknown = path ? getPath(output, path) : findOutputUrl(output, prefer);
  if (url && typeof url === 'object' && typeof (url as { url?: unknown }).url === 'string') url = (url as { url: string }).url;
  if (Array.isArray(url) && typeof url[0] === 'string') url = url[0];
  if (typeof url === 'string' && url) return url;
  const n = providerName(cfg);
  throw new AiError(
    path
      ? { tr: `${n} yanıtında “${path}” yolunda dosya bulunamadı.`, en: `No file at “${path}” in the ${n} response.` }
      : { tr: `${n} yanıtında bir çıktı dosyası bulunamadı; ayarlardan çıktı yolunu belirtin.`, en: `No output file found in the ${n} response; set the output path in the settings.` },
    'bad-response',
  );
}

export async function runGeneric(cfg: ProviderConfig, cap: AiCapability, req: GenericRequest, prefer: 'image' | 'model', run: JobRunner): Promise<Blob> {
  const name = providerName(cfg);
  const model = modelFor(cfg, cap);
  req.onProgress?.(PROGRESS.sending(name));
  const images = req.images ? await prepareImages(req.images) : undefined;
  let views: Partial<Record<ViewId, Blob>> | undefined;
  if (req.views) {
    views = {};
    for (const [id, blob] of Object.entries(req.views) as [ViewId, Blob | undefined][]) if (blob) views[id] = (await prepareImages([blob]))[0];
  }
  const input = await buildGenericInput(cfg, cap, model, { prompt: req.prompt, images, views });
  const output = await run(model, input, req);
  const url = outputUrl(cfg, output, prefer);
  req.onProgress?.(PROGRESS.downloading(name));
  return downloadOutput(url, { signal: req.signal });
}
