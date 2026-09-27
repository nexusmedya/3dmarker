/**
 * Enhancement presets and the plan each one resolves to for a given image:
 * AI super-resolution (Swin2SR in the ML worker), the pixel-art scaler, or a
 * chain of local filters. Plans carry the resulting size, so the card can
 * show it before anything runs.
 */
import type { I18nText } from '../types';
import type { ImageAnalysis } from './analyze';
import { pixelChain, type PixelGrid } from './pixelArt';

export type EnhancePresetId = 'auto' | 'ai-x2' | 'ai-x4' | 'pixel' | 'sharpen' | 'denoise';
export const ENHANCE_PRESET_IDS: EnhancePresetId[] = ['auto', 'ai-x2', 'ai-x4', 'pixel', 'sharpen', 'denoise'];

export function isEnhancePreset(v: unknown): v is EnhancePresetId {
  return typeof v === 'string' && (ENHANCE_PRESET_IDS as string[]).includes(v);
}

/** Longest side of an enhanced image (= the texture cap, TEXTURE_MAX_SIDE in app/pipeline). */
export const ENHANCE_MAX_SIDE = 2048;
/** Longest side the pixel-art chain aims for. */
export const PIXEL_TARGET_SIDE = 1024;
/** Auto picks ×4 (instead of ×2) up to this longest side. */
export const AUTO_X4_MAX_SIDE = 384;

/**
 * Swin2SR checkpoints converted for transformers.js ('image-to-image' pipeline).
 * x2: the pipeline's documented default. x4: real-world degradations (blur,
 * noise, resampling), trained with a PSNR loss (no invented texture).
 * x4Jpeg: compressed-input model for JPEG-artefact images.
 */
export const SR_MODELS = {
  x2: 'Xenova/swin2SR-classical-sr-x2-64',
  x4: 'Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr',
  x4Jpeg: 'Xenova/swin2SR-compressed-sr-x4-48',
} as const;

/** Approximate one-time download (MB) per model, for the card (quantized WASM weights are smaller). */
export const SR_MODEL_MB: Record<string, number> = {
  [SR_MODELS.x2]: 50,
  [SR_MODELS.x4]: 50,
  [SR_MODELS.x4Jpeg]: 45,
};

export type LocalOp = 'deblock' | 'denoise' | 'upscale' | 'sharpen';

export type EnhancePlan =
  | {
      kind: 'ai';
      model: string;
      scale: 2 | 4;
      /** Size handed to the model (the image is downscaled first when the result would pass ENHANCE_MAX_SIDE). */
      inputWidth: number;
      inputHeight: number;
      width: number;
      height: number;
      /** Light JPEG deblocking before the model (the x2 model expects clean input). */
      deblock: boolean;
    }
  | { kind: 'pixel'; grid: PixelGrid; steps: (2 | 3)[]; width: number; height: number }
  | { kind: 'filter'; ops: LocalOp[]; scale: number; width: number; height: number };

export interface PresetInfo {
  id: EnhancePresetId;
  label: I18nText;
  hint: I18nText;
  /** Runs an AI model (download on first use). */
  ai: boolean;
}

export const ENHANCE_PRESETS: PresetInfo[] = [
  {
    id: 'auto',
    label: { tr: 'Otomatik', en: 'Automatic' },
    hint: {
      tr: 'Piksel sanatına piksel ölçekleyici, küçük / bulanık görsele yapay zekâ büyütme, diğerlerine keskinleştirme.',
      en: 'Pixel scaler for pixel art, AI upscaling for small / blurry images, sharpening otherwise.',
    },
    ai: false,
  },
  {
    id: 'ai-x2',
    label: { tr: 'AI büyüt ×2', en: 'AI upscale ×2' },
    hint: { tr: 'Swin2SR ile 2 kat çözünürlük (tarayıcıda).', en: 'Swin2SR doubles the resolution (in your browser).' },
    ai: true,
  },
  {
    id: 'ai-x4',
    label: { tr: 'AI büyüt ×4', en: 'AI upscale ×4' },
    hint: {
      tr: 'Swin2SR ile 4 kat çözünürlük; JPEG bozulmalı görsellerde sıkıştırma modeli seçilir.',
      en: 'Swin2SR quadruples the resolution; JPEG-damaged images get the compression model.',
    },
    ai: true,
  },
  {
    id: 'pixel',
    label: { tr: 'Piksel sanatı', en: 'Pixel art' },
    hint: {
      tr: 'Scale2x / Scale3x: sert kenarlar ve palet korunur, çapraz basamaklar yumuşar. Anında, çevrimdışı.',
      en: 'Scale2x / Scale3x: hard edges and palette kept, diagonal steps rounded. Instant, offline.',
    },
    ai: false,
  },
  {
    id: 'sharpen',
    label: { tr: 'Keskinleştir', en: 'Sharpen' },
    hint: { tr: 'Netleştirme maskesi (boyut aynı kalır). Anında, çevrimdışı.', en: 'Unsharp mask (same size). Instant, offline.' },
    ai: false,
  },
  {
    id: 'denoise',
    label: { tr: 'Gürültü azalt', en: 'Denoise' },
    hint: {
      tr: 'Kenar koruyan gürültü azaltma ve JPEG blok yumuşatma. Anında, çevrimdışı.',
      en: 'Edge-preserving denoise and JPEG deblocking. Instant, offline.',
    },
    ai: false,
  },
];

export function presetInfo(id: EnhancePresetId): PresetInfo {
  return ENHANCE_PRESETS.find((p) => p.id === id) ?? ENHANCE_PRESETS[0];
}

function aiPlan(a: ImageAnalysis, scale: 2 | 4): EnhancePlan {
  const maxIn = Math.floor(ENHANCE_MAX_SIDE / scale);
  const f = Math.min(1, maxIn / a.maxSide);
  const inputWidth = Math.max(1, Math.round(a.width * f));
  const inputHeight = Math.max(1, Math.round(a.height * f));
  const model = scale === 2 ? SR_MODELS.x2 : a.jpegArtifacts ? SR_MODELS.x4Jpeg : SR_MODELS.x4;
  return {
    kind: 'ai',
    model,
    scale,
    inputWidth,
    inputHeight,
    width: inputWidth * scale,
    height: inputHeight * scale,
    deblock: scale === 2 && a.jpegArtifacts,
  };
}

/** Art pixels along an axis of `len` px with grid size k and phase off (see reduceToGrid). */
function gridCount(len: number, k: number, off: number): number {
  if (k <= 1) return len;
  return (off > 0 ? 1 : 0) + Math.ceil((len - off) / k);
}

function pixelPlan(a: ImageAnalysis): EnhancePlan {
  const g = a.grid;
  const w = gridCount(a.width, g.size, g.offsetX);
  const h = gridCount(a.height, g.size, g.offsetY);
  const steps = pixelChain(Math.max(w, h), PIXEL_TARGET_SIDE, ENHANCE_MAX_SIDE);
  const f = steps.reduce((p, s) => p * s, 1);
  return { kind: 'pixel', grid: g, steps, width: w * f, height: h * f };
}

function filterPlan(a: ImageAnalysis, ops: LocalOp[], scale = 1): EnhancePlan {
  const s = ops.includes('upscale') ? Math.max(1, Math.min(scale, ENHANCE_MAX_SIDE / a.maxSide)) : 1;
  return { kind: 'filter', ops, scale: s, width: Math.round(a.width * s), height: Math.round(a.height * s) };
}

/** What `preset` does to an image with analysis `a`. */
export function planEnhance(preset: EnhancePresetId, a: ImageAnalysis): EnhancePlan {
  switch (preset) {
    case 'ai-x2':
      return aiPlan(a, 2);
    case 'ai-x4':
      return aiPlan(a, 4);
    case 'pixel':
      return pixelPlan(a);
    case 'sharpen':
      return filterPlan(a, a.jpegArtifacts ? ['deblock', 'sharpen'] : ['sharpen']);
    case 'denoise':
      return filterPlan(a, ['deblock', 'denoise']);
    case 'auto':
      if (a.pixelArt) return pixelPlan(a);
      if (a.small || a.blurry) return aiPlan(a, a.maxSide <= AUTO_X4_MAX_SIDE ? 4 : 2);
      return filterPlan(a, a.jpegArtifacts ? ['deblock', 'sharpen'] : ['sharpen']);
  }
}

/** The offline stand-in for an AI plan (auto preset, model unavailable): Lanczos to the same size + sharpening. */
export function localFallbackPlan(plan: Extract<EnhancePlan, { kind: 'ai' }>, a: ImageAnalysis): EnhancePlan {
  const ops: LocalOp[] = a.jpegArtifacts ? ['deblock', 'upscale', 'sharpen'] : ['upscale', 'sharpen'];
  return { kind: 'filter', ops, scale: plan.width / a.width, width: plan.width, height: plan.height };
}

export type EnhanceReason = 'small' | 'blurry' | 'pixelated' | 'jpeg';

/** Why the card should be suggested for this image (null: it looks fine). */
export function enhanceSuggestion(a: ImageAnalysis): { reasons: EnhanceReason[]; preset: EnhancePresetId } | null {
  const reasons: EnhanceReason[] = [];
  if (a.pixelArt) reasons.push('pixelated');
  if (a.small) reasons.push('small');
  if (a.blurry) reasons.push('blurry');
  if (reasons.length === 0) return null;
  if (a.jpegArtifacts) reasons.push('jpeg');
  return { reasons, preset: a.pixelArt ? 'pixel' : 'auto' };
}
