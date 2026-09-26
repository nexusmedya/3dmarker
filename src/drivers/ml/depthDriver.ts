/**
 * Shared factory for the in-browser monocular depth drivers
 * (transformers.js 'depth-estimation' pipeline in a worker).
 */
import { throwIfAborted, type Availability, type Driver, type I18nText, type ParamSpec, type ParamValues } from '../../core/types';
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
    badges: ['download', 'webgpu'],
    downloadSizeMB: spec.downloadSizeMB,
    params: detail ? [detail, ...COMMON_PARAMS] : COMMON_PARAMS,
    producesDepth: true,
    isAvailable: mlAvailability,
    async run({ image, mask, params, signal, onProgress }) {
      throwIfAborted(signal);
      onProgress({ label: { tr: 'Görüntü hazırlanıyor…', en: 'Preparing image…' } });
      const side = resolveSide(spec, params);
      const multiple = spec.patchMultiple ?? 1;
      const prepared = prepareInferenceImage(image, { side, multiple });

      const raw = await requestDepth(
        {
          model: spec.model,
          image: prepared,
          exactSize: !!spec.patchMultiple,
          device: params.device === 'wasm' ? 'wasm' : 'auto',
          precision: params.precision === 'fp32' ? 'fp32' : 'auto',
        },
        { signal, onProgress: (p) => onProgress(mlProgressToProgress(p, ACTION)) },
      );
      throwIfAborted(signal);

      onProgress({ label: { tr: 'Son işlem…', en: 'Post-processing…' } });
      await yieldToPaint(); // show the label during the synchronous post-processing
      throwIfAborted(signal);
      const depth = processDepth(raw, {
        width: image.width,
        height: image.height,
        convention: spec.convention,
        mask,
        refine: params.edgeRefine === true ? { image } : null,
      });
      return { kind: 'depth', depth, mask };
    },
  };
}
