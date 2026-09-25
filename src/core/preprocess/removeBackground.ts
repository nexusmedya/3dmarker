/**
 * AI background removal (browser only): runs transformers.js'
 * 'background-removal' pipeline in the ML worker and turns the predicted
 * matte into a foreground Mask at the input image size.
 */
import { throwIfAborted, type Mask, type Progress, type RGBAImage } from '../types';
import { fitRGBA, hasTransparency, maskFromAlpha } from '../image/ops';
import { compositeOver, WHITE } from './composite';
import { alphaToMask, intersectMasks } from './alphaMask';
import { mlProgressToProgress } from '../../drivers/ml/postprocess';
import { requestForegroundAlpha } from '../../drivers/ml/workerClient';

/**
 * The pipeline's default and documented example model (MODNet, ~25 MB).
 * MODNet is trained for portrait matting: best on people, weaker on objects.
 * Other architectures the pipeline accepts: BiRefNet, ISNet, BEN (pass `model`).
 */
export const DEFAULT_BACKGROUND_MODEL = 'Xenova/modnet';

/** Longest side sent to the model; the matte is upsampled back smoothly. */
const MAX_SIDE = 1024;

export interface RemoveBackgroundOptions {
  signal: AbortSignal;
  onProgress: (p: Progress) => void;
  /** Hugging Face model id (default DEFAULT_BACKGROUND_MODEL). */
  model?: string;
  /** Matte threshold 0..1 (default 0.5). */
  threshold?: number;
}

export async function removeBackground(image: RGBAImage, opts: RemoveBackgroundOptions): Promise<Mask> {
  const { signal, onProgress } = opts;
  throwIfAborted(signal);
  onProgress({ label: { tr: 'Görüntü hazırlanıyor…', en: 'Preparing image…' } });
  // Flatten any transparency (white reads as a studio background) and cap the size.
  const input = fitRGBA(compositeOver(image, WHITE), MAX_SIDE);
  const matte = await requestForegroundAlpha(
    { model: opts.model ?? DEFAULT_BACKGROUND_MODEL, image: input, device: 'auto', precision: 'auto' },
    {
      signal,
      onProgress: (p) => onProgress(mlProgressToProgress(p, { tr: 'Arka plan kaldırılıyor', en: 'Removing background' })),
    },
  );
  throwIfAborted(signal);
  let mask = alphaToMask(matte.data, matte.width, matte.height, image.width, image.height, opts.threshold ?? 0.5);
  // Pixels that were already transparent are never foreground.
  if (hasTransparency(image)) mask = intersectMasks(mask, maskFromAlpha(image));
  return mask;
}
