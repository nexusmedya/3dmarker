/**
 * Runs an enhancement plan. Local plans are synchronous typed-array work;
 * AI plans hand an opaque RGB copy to an injected upscaler (the ML worker's
 * Swin2SR task in the app) and put the separately upscaled alpha back.
 * The automatic preset falls back to a local Lanczos + sharpen upscale when
 * the AI model cannot run (offline, blocked download, no WebGPU / WASM).
 */
import type { Progress, RGBAImage } from '../types';
import { AbortError, throwIfAborted } from '../types';
import { analyzeCached, type ImageAnalysis } from './analyze';
import { alphaPlane, applyAlpha, bleedColors, hasAlpha } from './alpha';
import { bilateralDenoise, deblock, unsharpMask } from './filters';
import { reduceToGrid, scale2x, scale3x } from './pixelArt';
import { localFallbackPlan, planEnhance, type EnhancePlan, type EnhancePresetId } from './presets';
import { resizeImage } from './resize';

export type AiPlan = Extract<EnhancePlan, { kind: 'ai' }>;

/** Upscales an opaque image by `plan.scale` with `plan.model`; resolves with plan.width × plan.height (or near). */
export type AiUpscaler = (img: RGBAImage, plan: AiPlan, opts: { signal?: AbortSignal; onProgress?: (p: Progress) => void }) => Promise<RGBAImage>;

export interface EnhanceOptions {
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
  /** Required for AI plans. */
  upscaleAi?: AiUpscaler;
  analysis?: ImageAnalysis;
}

export interface EnhanceOutcome {
  image: RGBAImage;
  /** The plan that produced `image` (the local fallback's, when the AI failed). */
  plan: EnhancePlan;
  /** Automatic preset only: the AI error that made it fall back to the local upscaler. */
  fallbackError?: unknown;
}

function isAbort(e: unknown): boolean {
  return e instanceof AbortError || (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError');
}

/** Local plans (pixel scaler, filter chains). */
export function runLocalPlan(img: RGBAImage, plan: Exclude<EnhancePlan, { kind: 'ai' }>): RGBAImage {
  if (plan.kind === 'pixel') {
    let cur = plan.grid.size > 1 ? reduceToGrid(img, plan.grid) : img;
    for (const s of plan.steps) cur = s === 2 ? scale2x(cur) : scale3x(cur);
    return cur === img ? { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) } : cur;
  }
  let cur = img;
  for (const op of plan.ops) {
    switch (op) {
      case 'deblock':
        cur = deblock(cur);
        break;
      case 'denoise':
        cur = bilateralDenoise(cur);
        break;
      case 'upscale':
        if (plan.width !== cur.width || plan.height !== cur.height) cur = resizeImage(cur, plan.width, plan.height, 'lanczos3');
        break;
      case 'sharpen':
        // Softer after an upscale (the interpolation already rings a little).
        cur = unsharpMask(cur, plan.ops.includes('upscale') ? { amount: 0.6, radius: 1.2, threshold: 2 } : { amount: 0.9, radius: 1, threshold: 2 });
        break;
    }
  }
  return cur === img ? { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) } : cur;
}

/** AI plans: fit → (deblock) → bleed transparent colours → model → alpha back on. */
export async function runAiPlan(img: RGBAImage, plan: AiPlan, upscale: AiUpscaler, opts: Pick<EnhanceOptions, 'signal' | 'onProgress'> = {}): Promise<RGBAImage> {
  let input = img.width === plan.inputWidth && img.height === plan.inputHeight ? img : resizeImage(img, plan.inputWidth, plan.inputHeight, 'lanczos3');
  if (plan.deblock) input = deblock(input);
  const alpha = hasAlpha(input) ? alphaPlane(input) : null;
  const rgb = alpha ? bleedColors(input) : input;
  let out = await upscale(rgb, plan, opts);
  if (opts.signal) throwIfAborted(opts.signal);
  if (out.width !== plan.width || out.height !== plan.height) out = resizeImage(out, plan.width, plan.height, 'lanczos3');
  return alpha ? applyAlpha(out, alpha, input.width, input.height) : out;
}

/** Enhance `img` with `preset`. */
export async function enhanceImage(img: RGBAImage, preset: EnhancePresetId, opts: EnhanceOptions = {}): Promise<EnhanceOutcome> {
  const analysis = opts.analysis ?? analyzeCached(img);
  const plan = planEnhance(preset, analysis);
  if (opts.signal) throwIfAborted(opts.signal);
  if (plan.kind !== 'ai') return { image: runLocalPlan(img, plan), plan };
  try {
    if (!opts.upscaleAi) throw new Error('No AI upscaler available');
    return { image: await runAiPlan(img, plan, opts.upscaleAi, opts), plan };
  } catch (e) {
    if (preset !== 'auto' || isAbort(e) || opts.signal?.aborted) throw e;
    const fallback = localFallbackPlan(plan, analysis) as Exclude<EnhancePlan, { kind: 'ai' }>;
    return { image: runLocalPlan(img, fallback), plan: fallback, fallbackError: e };
  }
}
