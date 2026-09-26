/**
 * AI orchestration used by the UI and drivers: prepare the front image
 * (style / T-pose / body completion), render the other views from it, make
 * sure an image has a transparent background, and run image → 3D.
 *
 * When `removeBackground` is on, prepareFrontImage and generateViewImage
 * finish with ensureTransparent themselves (idempotent: an already
 * transparent result is returned as is), using `ctx.bgProvider` or, when that
 * is undefined, the background-removal provider resolved from the published
 * settings (currentAiSettings); null means the local fallbacks (a white
 * border colour key, the MODNet model).
 *
 * The adapters are loaded on first use (they are not needed on page load).
 */
import type { Mask, Progress, RGBAImage, ViewId } from '../core/types';
import { AbortError, throwIfAborted } from '../core/types';
import type { PrepOptions, ProviderAdapter, ProviderConfig, ProviderKindId, ToModelRequest } from './types';
import { buildPrepPrompt, buildViewPrompt, isHumanoid, prepNeeded } from './prompts';
import { decodeRGBA, encodePng, imageSize, isGlbBuffer, toUploadImage } from './encode';
import { AiError, providerName } from './transport';
import { canRenderViews, currentAiSettings, resolveProvider } from './settings';
import { VIEW_LABELS } from './views';
import { autoMaskFromBorder } from '../core/image/autoMask';
import { removeBackground } from '../core/preprocess/removeBackground';

export { VIEW_LABELS };

export interface AiContext {
  signal: AbortSignal;
  onProgress: (p: Progress) => void;
}

export interface AiRunContext extends AiContext {
  isHuman: boolean;
  /** Provider for background removal; undefined = from currentAiSettings(), null = the local model. */
  bgProvider?: ProviderConfig | null;
  /**
   * generateViewImage: the prep options that produced the current front
   * image (null / undefined = none were applied); its extra instructions
   * are repeated for the views.
   */
  frontPrep?: PrepOptions | null;
}

async function adapterFor(kind: ProviderKindId): Promise<ProviderAdapter> {
  return (await import('./adapters')).getAdapter(kind);
}

type OtherView = Exclude<ViewId, 'front'>;
type Aspect = 'square' | 'portrait' | 'landscape';

/** Reference images sent with a view request (front + up to three others). */
export const MAX_VIEW_REFS = 4;

/**
 * Byte budget of the reference images of one request: base64 adds a third,
 * and Gemini rejects inline requests over 20 MB (Replicate / fal data-URI
 * bodies are best kept small too).
 */
export const REF_BYTE_BUDGET = 12 * 1024 * 1024;

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
  noViews: (n: string) => ({
    tr: `${n}: bu model kompozisyonu korur; yeni görünüm üretemez. Görünümler için başka bir görsel düzenleme sağlayıcısı seçin.`,
    en: `${n}: this model keeps the composition and cannot render new views. Pick another image-edit provider for the views.`,
  }),
  noRepose: (n: string) => ({
    tr: `${n}: bu model kompozisyonu korur; T-poz ya da gövde tamamlama yapamaz (yalnızca stil verebilir).`,
    en: `${n}: this model keeps the composition and cannot re-pose or complete the body (it can only restyle).`,
  }),
  bgProviderFailed: (n: string) => ({
    tr: `${n} arka planı kaldıramadı; yerel yöntem deneniyor`,
    en: `${n} could not remove the background; trying the local method`,
  }),
  bgKept: {
    tr: 'Arka plan kaldırılamadı; görsel olduğu gibi tutuldu (düz arka plan sonra kenar renginden ayrılır)',
    en: 'The background could not be removed; the image was kept as is (a plain background is cut out by its edge colour later)',
  },
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

/**
 * Edits the source image per the prep options (see the module comment for
 * background removal). When only `removeBackground` is set (no edit needed,
 * see prepNeeded) no image-edit call is made and `cfg` may be null: the
 * background-removal provider or the local fallbacks run on the file itself.
 */
export async function prepareFrontImage(file: Blob, o: PrepOptions, cfg: ProviderConfig | null, ctx: AiRunContext): Promise<Blob> {
  const { signal } = ctx;
  throwIfAborted(signal);
  const humanoid = isHumanoid(o, ctx);
  if (!prepNeeded(o) && o.removeBackground) {
    return ensureTransparent(file, { bgProvider: bgProviderFor(ctx), signal, onProgress: ctx.onProgress, isHuman: humanoid });
  }
  if (!cfg) throw new AiError({ tr: 'Görsel düzenleme sağlayıcısı seçilmemiş.', en: 'No image-edit provider is chosen.' }, 'unsupported');
  const name = providerName(cfg);
  const adapter = await adapterFor(cfg.kind);
  if (!adapter.editImage) throw new AiError(T.noEdit(name), 'unsupported');
  if (!canRenderViews(cfg) && (o.completeBody || (o.tPose && humanoid))) throw new AiError(T.noRepose(name), 'unsupported');
  const alpha = adapter.supportsAlpha?.(cfg) ?? false;
  const head = T.prep(name);
  ctx.onProgress({ label: head });
  const image = await toUploadImage(file, { keepAlpha: alpha });
  const aspect = prepAspect(o, humanoid, await imageSize(image));
  let out = await adapter.editImage(cfg, {
    prompt: buildPrepPrompt(o, { isHuman: ctx.isHuman, alphaOutput: o.removeBackground && alpha }),
    images: [image],
    transparentBackground: o.removeBackground,
    aspect,
    signal,
    onProgress: prefixed(ctx.onProgress, head),
  });
  if (o.removeBackground) out = await ensureTransparent(out, { bgProvider: bgProviderFor(ctx), signal, onProgress: ctx.onProgress, isHuman: humanoid });
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
  const adapter = await adapterFor(cfg.kind);
  if (!adapter.editImage) throw new AiError(T.noEdit(name), 'unsupported');
  if (!canRenderViews(cfg)) throw new AiError(T.noViews(name), 'unsupported');
  const alpha = adapter.supportsAlpha?.(cfg) ?? false;
  const upload = { keepAlpha: alpha };
  // Only as many references as the model's request actually carries (single-image templates: the front).
  const maxRefs = Math.max(1, Math.min(MAX_VIEW_REFS, adapter.editImageLimit?.(cfg) ?? MAX_VIEW_REFS));
  const head = T.view(view, name);
  ctx.onProgress({ label: head });
  const front = await toUploadImage(refs.front, upload);
  const refViews: ViewId[] = ['front'];
  const images: Blob[] = [front];
  let bytes = front.size;
  for (const v of REF_ORDER[view]) {
    const b = refs.others[v];
    if (!b || images.length >= maxRefs) continue;
    const img = await toUploadImage(b, upload);
    if (bytes + img.size > REF_BYTE_BUDGET) continue;
    bytes += img.size;
    refViews.push(v);
    images.push(img);
  }
  const humanoid = isHumanoid(o, ctx);
  let out = await adapter.editImage(cfg, {
    prompt: buildViewPrompt(view, o, { isHuman: ctx.isHuman, refViews, alphaOutput: o.removeBackground && alpha, frontPrep: ctx.frontPrep }),
    images,
    transparentBackground: o.removeBackground,
    aspect: viewAspect(view, await imageSize(front)),
    signal,
    onProgress: prefixed(ctx.onProgress, head),
  });
  if (o.removeBackground) out = await ensureTransparent(out, { bgProvider: bgProviderFor(ctx), signal, onProgress: ctx.onProgress, isHuman: humanoid });
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

/** Side of the small decode that only checks for transparency. */
const ALPHA_PROBE_SIDE = 256;
/** Longest side of the image the local background removal works on. */
const LOCAL_BG_MAX_SIDE = 2048;

/**
 * Foreground mask by keying out a plain border colour (the prompts ask for a
 * solid white background): null unless nearly the whole border has one
 * colour and the foreground covers 5–95 % of the image.
 */
export function borderKeyMask(img: RGBAImage): Mask | null {
  const mask = autoMaskFromBorder(img, 0.12, { minBorderAgreement: 0.9 });
  if (!mask) return null;
  let area = 0;
  for (let i = 0; i < mask.data.length; i++) area += mask.data[i];
  const frac = area / mask.data.length;
  return frac >= 0.05 && frac <= 0.95 ? mask : null;
}

/**
 * The image with a transparent background: returned as is when it already
 * has one; otherwise the 'background-removal' provider if given (its result
 * is checked for transparency), else locally: a colour key of a plain border
 * and the MODNet portrait matting model — MODNet first for humanoids, the key
 * first for everything else. When nothing works (e.g. the model cannot be
 * downloaded) the opaque image is returned with a progress warning instead
 * of losing the (paid) result. Outside the browser (no decoder) the image
 * is returned as is when no provider is given.
 */
export async function ensureTransparent(
  image: Blob,
  opts: { bgProvider: ProviderConfig | null; signal: AbortSignal; onProgress?: (p: Progress) => void; isHuman?: boolean },
): Promise<Blob> {
  const { signal, bgProvider } = opts;
  throwIfAborted(signal);
  const probe = await decodeRGBA(image, ALPHA_PROBE_SIDE);
  if (probe && hasTransparency(probe)) return image;
  const onProgress = opts.onProgress ?? (() => {});
  const rethrowAbort = (e: unknown) => {
    if (signal.aborted || e instanceof AbortError) throw new AbortError();
  };
  if (bgProvider) {
    const adapter = await adapterFor(bgProvider.kind);
    if (adapter.removeBackground) {
      const name = providerName(bgProvider);
      onProgress({ label: T.bg(name) });
      try {
        const out = await adapter.removeBackground(bgProvider, image, signal);
        const check = await decodeRGBA(out, ALPHA_PROBE_SIDE);
        if (!check || hasTransparency(check)) return out; // undecodable here (Node): trust the provider
      } catch (e) {
        rethrowAbort(e);
      }
      onProgress({ label: T.bgProviderFailed(name) });
    }
  }
  const rgba = probe ? await decodeRGBA(image, LOCAL_BG_MAX_SIDE) : null;
  if (!rgba) return image;
  const keyed = async () => {
    const mask = borderKeyMask(rgba);
    return mask ? encodePng(applyMaskToAlpha(rgba, mask)) : null;
  };
  if (!opts.isHuman) {
    const out = await keyed();
    if (out) return out;
  }
  onProgress({ label: T.bg(null) });
  try {
    const mask = await removeBackground(rgba, { signal, onProgress });
    throwIfAborted(signal);
    return await encodePng(applyMaskToAlpha(rgba, mask));
  } catch (e) {
    rethrowAbort(e);
  }
  const out = opts.isHuman ? await keyed() : null;
  if (out) return out;
  onProgress({ label: T.bgKept });
  return image;
}

/** Image → 3D (or multi-view → 3D) with a provider; resolves with a validated GLB. */
export async function generateModel(
  cfg: ProviderConfig,
  views: Partial<Record<ViewId, Blob>>,
  ctx: AiContext & { capability?: ToModelRequest['capability'] },
): Promise<ArrayBuffer> {
  throwIfAborted(ctx.signal);
  const name = providerName(cfg);
  const adapter = await adapterFor(cfg.kind);
  if (!adapter.toModel) throw new AiError(T.no3d(name), 'unsupported');
  const glb = await adapter.toModel(cfg, { views, capability: ctx.capability, signal: ctx.signal, onProgress: ctx.onProgress });
  if (!isGlbBuffer(glb)) throw new AiError(T.badGlb(name), 'bad-response');
  return glb;
}
