/**
 * Shared factory for the in-browser monocular depth drivers
 * (transformers.js 'depth-estimation' pipeline in a worker).
 *
 * Human detail (default on): while the depth model runs, MediaPipe finds
 * faces / hands / bodies (src/core/human); the depth is then refined with a
 * high-res pass of the same model on each face / hand crop and with
 * landmark-based relief (nose, lips, eye sockets, ears, fingers).
 */
import { analyzeHuman } from '../../core/human/analyze';
import { enhanceHumanDepth } from '../../core/human/enhance';
import type { HumanAnalysis } from '../../core/human/types';
import {
  AbortError,
  throwIfAborted,
  type Availability,
  type DepthMap,
  type Driver,
  type I18nText,
  type ParamSpec,
  type ParamValues,
  type Progress,
  type RGBAImage,
} from '../../core/types';
import { yieldToPaint } from '../../core/yield';
import { mlProgressToProgress, processDepth, type DepthConvention } from './postprocess';
import { prepareInferenceImage } from './prepare';
import { isMlSupported, requestDepth } from './workerClient';

export interface DepthModelSpec {
  id: string;
  /** Hugging Face model id (ONNX weights under onnx/). */
  model: string;
  name: I18nText;
  description: I18nText;
  /** Approximate one-time download in MB (default precision on WebGPU). */
  downloadSizeMB: number;
  convention: DepthConvention;
  /** Square-equivalent input side the model was trained at (e.g. 518 for Depth Anything). */
  nativeSide: number;
  /**
   * Set when the ONNX graph accepts any input size that is a multiple of this
   * (ViT patch size). Enables the "detail" select; otherwise the image
   * processor's fixed size is used.
   */
  patchMultiple?: number;
  /** Square-equivalent sides offered by the detail select (multiples of patchMultiple). */
  detailSides?: number[];
}

const ACTION: I18nText = { tr: 'Derinlik hesaplanıyor', en: 'Estimating depth' };

const DETAIL_NAMES: I18nText[] = [
  { tr: 'Hızlı', en: 'Fast' },
  { tr: 'Dengeli', en: 'Balanced' },
  { tr: 'Yüksek', en: 'High' },
  { tr: 'Çok yüksek', en: 'Very high' },
];

function detailParam(spec: DepthModelSpec): ParamSpec | null {
  const sides = spec.detailSides;
  if (!spec.patchMultiple || !sides?.length) return null;
  return {
    kind: 'select',
    key: 'detail',
    label: { tr: 'Çıkarım çözünürlüğü', en: 'Inference resolution' },
    hint: {
      tr: 'Yüksek değerler daha ince detay verir ama daha yavaştır ve daha çok bellek ister (WebGPU önerilir)',
      en: 'Higher values give finer detail but are slower and use more memory (WebGPU recommended)',
    },
    default: String(spec.nativeSide),
    options: sides.map((side, i) => {
      const name = DETAIL_NAMES[Math.min(i, DETAIL_NAMES.length - 1)];
      const native = side === spec.nativeSide;
      return {
        value: String(side),
        label: {
          tr: `${name.tr} (${side} px${native ? ', önerilen' : ''})`,
          en: `${name.en} (${side} px${native ? ', recommended' : ''})`,
        },
      };
    }),
  };
}

const COMMON_PARAMS: ParamSpec[] = [
  {
    kind: 'boolean',
    key: 'edgeRefine',
    label: { tr: 'Kenar iyileştirme', en: 'Edge-aware refine' },
    hint: {
      tr: 'Derinlik kenarlarını görüntüdeki kenarlara hizalar (guided filter)',
      en: 'Snaps depth edges to image edges (guided filter)',
    },
    default: false,
  },
  {
    kind: 'select',
    key: 'precision',
    label: { tr: 'Hassasiyet', en: 'Precision' },
    default: 'auto',
    options: [
      { value: 'auto', label: { tr: 'Otomatik (WebGPU: fp16, CPU: 8-bit)', en: 'Auto (WebGPU: fp16, CPU: 8-bit)' } },
      { value: 'fp32', label: { tr: 'Tam (fp32, daha büyük indirme)', en: 'Full (fp32, larger download)' } },
    ],
  },
  {
    kind: 'select',
    key: 'device',
    label: { tr: 'Hızlandırma', en: 'Acceleration' },
    hint: {
      tr: 'WebGPU hata verirse otomatik olarak WASM\'a geçilir',
      en: 'Falls back to WASM automatically if WebGPU fails',
    },
    default: 'auto',
    options: [
      { value: 'auto', label: { tr: 'Otomatik (WebGPU, yoksa WASM)', en: 'Auto (WebGPU, else WASM)' } },
      { value: 'wasm', label: { tr: 'Yalnızca CPU (WASM)', en: 'CPU only (WASM)' } },
    ],
  },
];

/** Landmark-guided face / hand refinement (src/core/human). */
export const HUMAN_PARAMS: ParamSpec[] = [
  {
    kind: 'boolean',
    key: 'humanDetail',
    label: { tr: 'İnsan detayı (yüz ve eller)', en: 'Human detail (face & hands)' },
    hint: {
      tr: 'Yüz, el ve vücut noktalarını algılar (MediaPipe, ilk kullanımda ~20 MB indirilir) ve burun, dudak, göz çukuru, kulak ve parmaklara kabartma ekler. İnsan yoksa derinlik değişmez',
      en: 'Detects face, hand and body landmarks (MediaPipe, ~20 MB downloaded on first use) and adds relief to the nose, lips, eye sockets, ears and fingers. Without people the depth is unchanged',
    },
    default: true,
  },
  {
    kind: 'number',
    key: 'faceStrength',
    label: { tr: 'Yüz kabartması', en: 'Face relief' },
    hint: {
      tr: '0 = kapalı, 1 ≈ gerçek yüz oranları (varsayılan derinlikte); yalnızca modelde eksik kalan kısım eklenir',
      en: '0 = off, 1 ≈ true facial proportions (at the default depth); only what the model is missing is added',
    },
    min: 0,
    max: 1.5,
    step: 0.05,
    default: 0.8,
  },
  {
    kind: 'number',
    key: 'handStrength',
    label: { tr: 'El ve parmak kabartması', en: 'Hand & finger relief' },
    min: 0,
    max: 1.5,
    step: 0.05,
    default: 0.7,
  },
  {
    kind: 'boolean',
    key: 'hiResCrops',
    label: { tr: 'Yüz/el için yüksek çözünürlüklü geçiş', en: 'High-res pass on faces & hands' },
    hint: {
      tr: 'Modeli her yüz ve elin yakın plan kırpıntısında yeniden çalıştırır: daha ince detay, kırpıntı başına bir çıkarım daha',
      en: 'Re-runs the model on a close-up crop of each face and hand: finer detail, one extra inference per crop',
    },
    default: true,
  },
];

const isAbort = (e: unknown) => e instanceof AbortError || (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError');

/**
 * Human analysis started alongside the depth inference (MediaPipe runs on the
 * main thread while the worker infers). Its progress is held back until the
 * depth is done (`relay`), so the two label streams do not interleave.
 */
function startHumanAnalysis(image: RGBAImage, signal: AbortSignal) {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const state: { last: Progress | null; relay: ((p: Progress) => void) | null; settled: boolean } = { last: null, relay: null, settled: false };
  const promise: Promise<HumanAnalysis | null> = analyzeHuman(image, {
    signal: ac.signal,
    onProgress: (p) => {
      state.last = p;
      state.relay?.(p);
    },
  })
    .catch((e: unknown) => {
      if (isAbort(e)) throw e;
      console.warn('[ml] human analysis failed', e);
      return null;
    })
    .finally(() => {
      state.settled = true;
      signal.removeEventListener('abort', onAbort);
    });
  promise.catch(() => undefined); // awaited later, or dropped when the depth fails
  return { promise, state, cancel: () => ac.abort() };
}

/** Inference side for the given params (validated against the spec). */
export function resolveSide(spec: DepthModelSpec, params: ParamValues): number {
  const v = Number(params.detail);
  return spec.patchMultiple && spec.detailSides?.includes(v) ? v : spec.nativeSide;
}

async function mlAvailability(): Promise<Availability> {
  if (isMlSupported()) return { ok: true };
  return {
    ok: false,
    reason: {
      tr: 'Bu tarayıcı Web Worker / WebAssembly desteklemiyor',
      en: 'This browser does not support Web Workers / WebAssembly',
    },
  };
}

export function createDepthDriver(spec: DepthModelSpec): Driver {
  const detail = detailParam(spec);
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    category: 'ml',
    badges: ['download', 'webgpu', 'human-detail'],
    downloadSizeMB: spec.downloadSizeMB,
    params: [...(detail ? [detail] : []), ...COMMON_PARAMS, ...HUMAN_PARAMS],
    producesDepth: true,
    isAvailable: mlAvailability,
    async run({ image, mask, params, signal, onProgress }) {
      throwIfAborted(signal);
      onProgress({ label: { tr: 'Görüntü hazırlanıyor…', en: 'Preparing image…' } });
      const side = resolveSide(spec, params);
      const multiple = spec.patchMultiple ?? 1;
      const prepared = prepareInferenceImage(image, { side, multiple });
      const job = {
        model: spec.model,
        exactSize: !!spec.patchMultiple,
        device: params.device === 'wasm' ? ('wasm' as const) : ('auto' as const),
        precision: params.precision === 'fp32' ? ('fp32' as const) : ('auto' as const),
      };
      const human = params.humanDetail !== false ? startHumanAnalysis(image, signal) : null;

      let raw;
      try {
        raw = await requestDepth(
          { ...job, image: prepared },
          { signal, onProgress: (p) => onProgress(mlProgressToProgress(p, ACTION)) },
        );
      } catch (e) {
        human?.cancel();
        throw e;
      }
      if (signal.aborted) human?.cancel();
      throwIfAborted(signal);

      onProgress({ label: { tr: 'Son işlem…', en: 'Post-processing…' } });
      await yieldToPaint(); // show the label during the synchronous post-processing
      if (signal.aborted) human?.cancel();
      throwIfAborted(signal);
      const depth = processDepth(raw, {
        width: image.width,
        height: image.height,
        convention: spec.convention,
        mask,
        refine: params.edgeRefine === true ? { image } : null,
      });
      if (!human) return { kind: 'depth', depth, mask };

      // Human detail: wait for the analysis (showing its progress from now on).
      if (!human.state.settled) {
        if (human.state.last) onProgress(human.state.last);
        human.state.relay = onProgress;
      }
      const analysis = await human.promise;
      throwIfAborted(signal);
      if (!analysis || (analysis.faces.length === 0 && analysis.hands.length === 0 && analysis.poses.length === 0)) {
        return { kind: 'depth', depth, mask };
      }
      // High-res crop pass: the same model at its native input size on each face / hand crop.
      const refineCrop = async (crop: RGBAImage, sig: AbortSignal): Promise<DepthMap> => {
        const r = await requestDepth({ ...job, image: prepareInferenceImage(crop, { side: spec.nativeSide, multiple }) }, { signal: sig });
        // Min-max, not percentile, normalisation: the nearest ~1% of a face crop is
        // the nose tip, which clamping would flatten; blendCrop's robust affine fit
        // sets scale / offset (and trims outliers) anyway.
        return processDepth(r, { width: crop.width, height: crop.height, convention: spec.convention, mask: null, robust: false });
      };
      try {
        const refined = await enhanceHumanDepth(depth, mask, image, analysis, {
          faceStrength: numberParam(params.faceStrength, 0.8),
          handStrength: numberParam(params.handStrength, 0.7),
          refineCrop: params.hiResCrops !== false ? refineCrop : undefined,
          cropSideRatio: spec.nativeSide / side,
          signal,
          onProgress,
        });
        return { kind: 'depth', depth: refined, mask };
      } catch (e) {
        if (isAbort(e) || signal.aborted) throw e;
        // Detail is a bonus: never lose the base depth over it.
        console.warn('[ml] human detail refinement failed; keeping the plain depth', e);
        return { kind: 'depth', depth, mask };
      }
    },
  };
}

function numberParam(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(1.5, Math.max(0, n)) : fallback;
}
