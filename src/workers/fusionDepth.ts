/**
 * The fusion's depth estimator, split so the pixel work can run in the
 * geometry worker: the crop is prepared (composited, resized) and the raw
 * model output post-processed wherever the fusion runs, while `infer` only
 * runs the model. On the main thread `infer` is the ML worker request
 * itself; in the geometry worker it is relayed through the main thread
 * (which owns the ML worker), so the main thread only forwards buffers.
 */
import type { I18nText } from '../core/types';
import { throwIfAborted } from '../core/types';
import { DepthOfflineError } from '../core/fusion';
import type { DepthEstimator } from '../core/fusion';
import { isNetworkError } from '../drivers/ml/errors';
import { mlProgressToProgress, processDepth, type DepthConvention, type RawDepth } from '../drivers/ml/postprocess';
import { prepareInferenceImage } from '../drivers/ml/prepare';
import type { ImagePayload, MlProgress } from './mlProtocol';

const ACTION: I18nText = { tr: 'Derinlik hesaplanıyor', en: 'Estimating depth' };

/** What the fusion needs of a depth model (a subset of DepthModelSpec, plain data). */
export interface FusionDepthSpec {
  model: string;
  convention: DepthConvention;
  nativeSide: number;
  patchMultiple?: number;
}

/** One model run: the prepared image in, the raw tensor out. */
export interface InferJob {
  model: string;
  image: ImagePayload;
  exactSize: boolean;
}

export type DepthInfer = (job: InferJob, o: { signal: AbortSignal; onProgress: (p: MlProgress) => void }) => Promise<RawDepth>;

/**
 * Depth estimator of the fusion. A download failure becomes
 * DepthOfflineError: the fusion reports it in its own words (the depth
 * drivers' advice to pick an offline driver does not apply — the fusion
 * carries on from the silhouettes).
 */
export function createFusionDepthEstimator(spec: FusionDepthSpec, infer: DepthInfer): DepthEstimator {
  return async ({ image, mask }, { signal, onProgress }) => {
    const prepared = prepareInferenceImage(image, { side: spec.nativeSide, multiple: spec.patchMultiple ?? 1 });
    let raw: RawDepth;
    try {
      raw = await infer(
        { model: spec.model, image: prepared, exactSize: !!spec.patchMultiple },
        { signal, onProgress: (p) => onProgress(mlProgressToProgress(p, ACTION)) },
      );
    } catch (e) {
      // localizeMlError keeps the raw fetch message in its text ("[Failed to fetch]").
      if (!signal.aborted && isNetworkError(e)) throw new DepthOfflineError();
      throw e;
    }
    throwIfAborted(signal);
    return processDepth(raw, { width: image.width, height: image.height, convention: spec.convention, mask, refine: null });
  };
}
