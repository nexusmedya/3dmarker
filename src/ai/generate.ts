/**
 * AI orchestration used by the UI and drivers: prepare the front image
 * (style / T-pose / body completion), render the other views from it, make
 * sure an image has a transparent background, and run image → 3D.
 *
 * When `removeBackground` is on, prepareFrontImage and generateViewImage
 * finish with ensureTransparent themselves (idempotent: an already
 * transparent result is returned as is), using `ctx.bgProvider` or, when that
 * is undefined, the background-removal provider resolved from the published
 * settings (currentAiSettings); null means the local MODNet model.
 */
import type { Mask, Progress, RGBAImage, ViewId } from '../core/types';
import { throwIfAborted } from '../core/types';
import type { PrepOptions, ProviderConfig, ToModelRequest } from './types';
import { getAdapter } from './adapters';
import { buildPrepPrompt, buildViewPrompt, isHumanoid } from './prompts';
import { decodeRGBA, encodePng, imageSize, isGlbBuffer, toUploadPng } from './encode';
import { AiError, providerName } from './transport';
import { currentAiSettings, resolveProvider } from './settings';
import { VIEW_LABELS } from './views';

export { VIEW_LABELS };

export interface AiContext {
  signal: AbortSignal;
  onProgress: (p: Progress) => void;
}

export interface AiRunContext extends AiContext {
  isHuman: boolean;
  /** Provider for background removal; undefined = from currentAiSettings(), null = the local model. */
  bgProvider?: ProviderConfig | null;
}

type OtherView = Exclude<ViewId, 'front'>;
type Aspect = 'square' | 'portrait' | 'landscape';

/** Reference images sent with a view request (front + up to three others). */
export const MAX_VIEW_REFS = 4;

/** Other views that help most when rendering a view, best first. */
const REF_ORDER: Record<OtherView, OtherView[]> = {
  back: ['left', 'right', 'top', 'bottom'],
  left: ['back', 'right', 'top', 'bottom'],
  right: ['back', 'left', 'top', 'bottom'],
  top: ['back', 'left', 'right', 'bottom'],
  bottom: ['back', 'left', 'right', 'top'],
};

const T = {
  noEdit: (n: string) => ({ tr: `${n} görsel düzenleme desteklemiyor.`, en: `${n} does not support image editing.` }),
  no3d: (n: string) => ({ tr: `${n} görselden 3B üretmeyi desteklemiyor.`, en: `${n} does not support image-to-3D.` }),
  prep: (n: string) => ({ tr: `AI görseli hazırlıyor (${n})`, en: `AI is preparing the image (${n})` }),
  view: (v: OtherView, n: string) => ({ tr: `${VIEW_LABELS[v].tr} görünüm üretiliyor (${n})`, en: `Generating the ${VIEW_LABELS[v].en.toLowerCase()} view (${n})` }),
  bg: (n: string | null) => ({ tr: `Arka plan kaldırılıyor${n ? ` (${n})` : ''}`, en: `Removing the background${n ? ` (${n})` : ''}` }),
  badGlb: (n: string) => ({ tr: `${n} geçerli bir GLB döndürmedi.`, en: `${n} did not return a valid GLB.` }),
};

function prefixed(onProgress: (p: Progress) => void, head: { tr: string; en: string }): (p: Progress) => void {
  return (p) => onProgress({ label: { tr: `${head.tr} · ${p.label.tr}`, en: `${head.en} · ${p.label.en}` }, ratio: p.ratio });
}

/** Aspect class of a size (null → square). */
export function aspectOf(size: { width: number; height: number } | null): Aspect {
  if (!size || !size.width || !size.height) return 'square';
  const r = size.width / size.height;
  return r > 1.2 ? 'landscape' : r < 0.83 ? 'portrait' : 'square';
}

/** Output aspect of the prepared front image: a T-pose is about as wide as tall, a completed body is tall. */
export function prepAspect(o: PrepOptions, humanoid: boolean, source: { width: number; height: number } | null): Aspect {
  if (humanoid && o.tPose) return 'square';
  if (humanoid && o.completeBody) return 'portrait';
  return aspectOf(source);
}

/** Aspect of a generated view: back / sides keep the front's framing, top / bottom are square. */
export function viewAspect(view: OtherView, front: { width: number; height: number } | null): Aspect {
  return view === 'top' || view === 'bottom' ? 'square' : aspectOf(front);
}

function bgProviderFor(ctx: AiRunContext): ProviderConfig | null {
  if (ctx.bgProvider !== undefined) return ctx.bgProvider;
  const { settings, serverAvailable } = currentAiSettings();
  return resolveProvider(settings, 'background-removal', null, serverAvailable);
}

/** Edits the source image per the prep options (see the module comment for background removal). */
export async function prepareFrontImage(file: Blob, o: PrepOptions, cfg: ProviderConfig, ctx: AiRunContext): Promise<Blob> {
  const { signal } = ctx;
  throwIfAborted(signal);
  const name = providerName(cfg);
  const adapter = getAdapter(cfg.kind);
  if (!adapter.editImage) throw new AiError(T.noEdit(name), 'unsupported');
  const head = T.prep(name);
  ctx.onProgress({ label: head });
  const image = await toUploadPng(file);
  const aspect = prepAspect(o, isHumanoid(o, ctx), await imageSize(image));
  let out = await adapter.editImage(cfg, {
    prompt: buildPrepPrompt(o, ctx),
    images: [image],
    transparentBackground: o.removeBackground,
    aspect,
    signal,
    onProgress: prefixed(ctx.onProgress, head),
  });
  if (o.removeBackground) out = await ensureTransparent(out, { bgProvider: bgProviderFor(ctx), signal, onProgress: ctx.onProgress });
  return out;
}

/** Renders one of the other views from the front (and any other views already there). */
export async function generateViewImage(
  view: OtherView,
  refs: { front: Blob; others: Partial<Record<ViewId, Blob>> },
  o: PrepOptions,
  cfg: ProviderConfig,
  ctx: AiRunContext,
): Promise<Blob> {
  const { signal } = ctx;
  throwIfAborted(signal);
  const name = providerName(cfg);
  const adapter = getAdapter(cfg.kind);
  if (!adapter.editImage) throw new AiError(T.noEdit(name), 'unsupported');
  const head = T.view(view, name);
  ctx.onProgress({ label: head });
  const front = await toUploadPng(refs.front);
  const refViews: ViewId[] = ['front'];
  const images: Blob[] = [front];
  for (const v of REF_ORDER[view]) {
    const b = refs.others[v];
    if (!b || images.length >= MAX_VIEW_REFS) continue;
    refViews.push(v);
    images.push(await toUploadPng(b));
  }
  let out = await adapter.editImage(cfg, {
    prompt: buildViewPrompt(view, o, { isHuman: ctx.isHuman, refViews }),
    images,
    transparentBackground: o.removeBackground,
    aspect: viewAspect(view, await imageSize(front)),
    signal,
    onProgress: prefixed(ctx.onProgress, head),
  });
  if (o.removeBackground) out = await ensureTransparent(out, { bgProvider: bgProviderFor(ctx), signal, onProgress: ctx.onProgress });
  return out;
}

/** True when at least `minFraction` of the pixels are (partly) transparent. */
export function hasTransparency(img: RGBAImage, minFraction = 0.005): boolean {
  const d = img.data;
  const n = img.width * img.height;
  if (!n) return false;
  const need = Math.max(1, Math.ceil(n * minFraction));
  let count = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250 && ++count >= need) return true;
  return false;
}

/** Copy of `img` whose alpha is zero outside the mask (same size). */
export function applyMaskToAlpha(img: RGBAImage, mask: Mask): RGBAImage {
  if (mask.width !== img.width || mask.height !== img.height) throw new Error('applyMaskToAlpha: size mismatch');
  const data = new Uint8ClampedArray(img.data);
  for (let i = 0; i < mask.data.length; i++) if (!mask.data[i]) data[i * 4 + 3] = 0;
  return { width: img.width, height: img.height, data };
}

/**
 * The image with a transparent background: returned as is when it already
 * has one; otherwise the 'background-removal' provider if given, else the
 * local MODNet model (browser) composited into the alpha channel → PNG.
 * Outside the browser (no decoder) an image without a provider is returned as is.
 */
export async function ensureTransparent(
  image: Blob,
  opts: { bgProvider: ProviderConfig | null; signal: AbortSignal; onProgress?: (p: Progress) => void },
): Promise<Blob> {
  const { signal, bgProvider } = opts;
  throwIfAborted(signal);
  const rgba = await decodeRGBA(image);
  if (rgba && hasTransparency(rgba)) return image;
  const onProgress = opts.onProgress ?? (() => {});
  if (bgProvider) {
    const adapter = getAdapter(bgProvider.kind);
    if (adapter.removeBackground) {
      onProgress({ label: T.bg(providerName(bgProvider)) });
      return adapter.removeBackground(bgProvider, image, signal);
    }
  }
  if (!rgba) return image;
  onProgress({ label: T.bg(null) });
  const { removeBackground } = await import('../core/preprocess/removeBackground');
  const mask = await removeBackground(rgba, { signal, onProgress });
  throwIfAborted(signal);
  return encodePng(applyMaskToAlpha(rgba, mask));
}

/** Image → 3D (or multi-view → 3D) with a provider; resolves with a validated GLB. */
export async function generateModel(
  cfg: ProviderConfig,
  views: Partial<Record<ViewId, Blob>>,
  ctx: AiContext & { capability?: ToModelRequest['capability'] },
): Promise<ArrayBuffer> {
  throwIfAborted(ctx.signal);
  const name = providerName(cfg);
  const adapter = getAdapter(cfg.kind);
  if (!adapter.toModel) throw new AiError(T.no3d(name), 'unsupported');
  const glb = await adapter.toModel(cfg, { views, capability: ctx.capability, signal: ctx.signal, onProgress: ctx.onProgress });
  if (!isGlbBuffer(glb)) throw new AiError(T.badGlb(name), 'bad-response');
  return glb;
}
