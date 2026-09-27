/**
 * Local "depth + volume" driver: a closed, textured body from one image,
 * entirely in the browser. The front comes from the ML depth model (Depth
 * Anything V2, same worker as the ML drivers), the back from the silhouette
 * inflation blended with a smoothed mirror of the front (see ./volume.ts).
 * Round characters become balls and cars box-like volumes instead of flat
 * reliefs. When the depth model cannot run (offline, blocked download, no
 * WebAssembly) it falls back to the inflated body alone, with a warning.
 */
import type { DepthMap, Driver, DriverInput, DriverResult, I18nText, Mask, ParamSpec, ParamValues, Progress, RGBAImage } from '../../core/types';
import { AbortError, throwIfAborted } from '../../core/types';
import { LocalizedError } from '../../core/errors';
import { yieldToPaint } from '../../core/yield';
import { resizeMask } from '../../core/image/ops';
import { NO_SILHOUETTE, resolveSilhouette } from '../heuristic/inflate';
import { DEPTH_MODEL_SPECS } from '../ml';
import { mlProgressToProgress, processDepth } from '../ml/postprocess';
import { prepareInferenceImage } from '../ml/prepare';
import { isMlSupported, requestDepth } from '../ml/workerClient';
import { buildDepthVolume, DEFAULT_VOLUME_OPTIONS, type VolumeOptions, type VolumeShape } from './volume';

/** Estimates a normalised depth map (1 = nearest) at width × height; injectable for tests. */
export type DepthEstimator = (req: {
  image: RGBAImage;
  /** Silhouette at width × height. */
  mask: Mask;
  width: number;
  height: number;
  model: string;
  signal: AbortSignal;
  onProgress: (p: Progress) => void;
}) => Promise<DepthMap>;

const DEPTH_ACTION: I18nText = { tr: 'Ön yüz derinliği hesaplanıyor', en: 'Estimating the front depth' };

const MODELS = DEPTH_MODEL_SPECS.filter((s) => s.id.startsWith('depth-anything'));

/** Default estimator: the shared ML worker (transformers.js). */
export const workerDepthEstimator: DepthEstimator = async ({ image, mask, width, height, model, signal, onProgress }) => {
  const spec = MODELS.find((s) => s.model === model) ?? MODELS[0];
  const prepared = prepareInferenceImage(image, { side: spec.nativeSide, multiple: spec.patchMultiple ?? 1 });
  const raw = await requestDepth(
    { model: spec.model, image: prepared, exactSize: !!spec.patchMultiple, device: 'auto', precision: 'auto' },
    { signal, onProgress: (p) => onProgress(mlProgressToProgress(p, DEPTH_ACTION)) },
  );
  return processDepth(raw, { width, height, convention: spec.convention, mask });
};

const PARAMS: ParamSpec[] = [
  {
    kind: 'select',
    key: 'shape',
    label: { tr: 'Gövde şekli', en: 'Body shape' },
    hint: {
      tr: 'Otomatik: silüetten tahmin edilir (yuvarlak karakter → top, dolu ve uzun silüet → kutu). Yuvarlak = balon kesit; Kutu = düz üst, dik yanlar (arabalar, kutular, binalar)',
      en: 'Auto: guessed from the silhouette (round character → ball, well-filled elongated silhouette → box). Round = balloon section; Boxy = flat top, steep sides (cars, boxes, buildings)',
    },
    default: DEFAULT_VOLUME_OPTIONS.shape,
    options: [
      { value: 'auto', label: { tr: 'Otomatik', en: 'Auto' } },
      { value: 'round', label: { tr: 'Yuvarlak (karakter, top)', en: 'Round (character, ball)' } },
      { value: 'boxy', label: { tr: 'Kutu (araba, nesne)', en: 'Boxy (car, object)' } },
    ],
  },
  {
    kind: 'number',
    key: 'thickness',
    label: { tr: 'Kalınlık', en: 'Thickness' },
    hint: {
      tr: '0 = otomatik (yuvarlak gövdede derinlik ≈ genişlik). 1 = silüetin yerel genişliği kadar kalın; daha büyük = daha tombul',
      en: '0 = auto (a round body is as deep as it is wide). 1 = as thick as the silhouette is locally wide; higher = chubbier',
    },
    min: 0,
    max: 2,
    step: 0.05,
    default: DEFAULT_VOLUME_OPTIONS.thickness,
  },
  {
    kind: 'number',
    key: 'depthScale',
    label: { tr: 'Ön kabartma gücü', en: 'Front relief strength' },
    hint: {
      tr: '0 = otomatik: yapay zekâ derinliği gövdeye göre ölçeklenir (derinlik aralığı genişlikle orantılı). Büyük = yüz, tekerlek, kol gibi ayrıntılar daha belirgin',
      en: '0 = auto: the AI depth is calibrated against the body (depth range proportional to width). Higher = faces, wheels, arms stand out more',
    },
    min: 0,
    max: 3,
    step: 0.05,
    default: DEFAULT_VOLUME_OPTIONS.depthScale,
  },
  {
    kind: 'number',
    key: 'backDetail',
    label: { tr: 'Arka yüzde ön ayrıntı', en: 'Front detail on the back' },
    hint: {
      tr: '0 = arka yüz düzgün bir balon, 1 = ön yüzün yumuşatılmış aynası (simetrik nesneler için)',
      en: '0 = a smooth balloon back, 1 = a smoothed mirror of the front (for symmetric objects)',
    },
    min: 0,
    max: 1,
    step: 0.05,
    default: DEFAULT_VOLUME_OPTIONS.backDetail,
  },
  {
    kind: 'select',
    key: 'resolution',
    label: { tr: 'Mesh çözünürlüğü', en: 'Mesh resolution' },
    hint: { tr: 'Uzun kenardaki köşe sayısı', en: 'Vertices along the longest side' },
    default: '320',
    options: [
      { value: '192', label: { tr: '192 (hızlı)', en: '192 (fast)' } },
      { value: '320', label: { tr: '320 (dengeli)', en: '320 (balanced)' } },
      { value: '448', label: { tr: '448 (ayrıntılı)', en: '448 (detailed)' } },
    ],
  },
  {
    kind: 'select',
    key: 'model',
    label: { tr: 'Derinlik modeli', en: 'Depth model' },
    default: MODELS[0].model,
    options: MODELS.map((s) => ({ value: s.model, label: s.name })),
  },
];

export function volumeOptionsFrom(p: ParamValues): VolumeOptions {
  const d = DEFAULT_VOLUME_OPTIONS;
  const n = (k: 'thickness' | 'backDetail' | 'depthScale', lo: number, hi: number) =>
    typeof p[k] === 'number' && Number.isFinite(p[k]) ? Math.min(hi, Math.max(lo, p[k] as number)) : d[k];
  const shape: VolumeShape = p.shape === 'round' || p.shape === 'boxy' || p.shape === 'auto' ? p.shape : d.shape;
  return { shape, thickness: n('thickness', 0, 3), backDetail: n('backDetail', 0, 1), depthScale: n('depthScale', 0, 5) };
}

/** Work grid for the longest side `res`, keeping the image aspect. */
export function workSize(width: number, height: number, res: number): { width: number; height: number } {
  const L = Math.max(width, height);
  const r = Math.max(16, Math.min(1024, Math.round(res) || 320));
  const k = Math.min(1, r / L);
  return { width: Math.max(2, Math.round(width * k)), height: Math.max(2, Math.round(height * k)) };
}

const isAbort = (e: unknown) => e instanceof AbortError || (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError');

const T = {
  prep: { tr: 'Siluet hazırlanıyor…', en: 'Preparing the silhouette…' },
  noMl: {
    tr: 'Derinlik modeli bu tarayıcıda çalışamıyor; yalnızca siluet hacmiyle devam ediliyor (ön yüz ayrıntısı olmadan)…',
    en: 'The depth model cannot run in this browser; continuing with the silhouette volume only (no front detail)…',
  },
  fallback: (why: string): I18nText => ({
    tr: `Derinlik modeli kullanılamadı, yalnızca siluet hacmiyle devam ediliyor (ön yüz ayrıntısı olmadan): ${why}`,
    en: `Depth model unavailable, continuing with the silhouette volume only (no front detail): ${why}`,
  }),
  build: { tr: 'Kapalı gövde örülüyor…', en: 'Building the closed body…' },
  done: { tr: 'Tamamlandı', en: 'Done' },
};

export interface DepthVolumeDriverOptions {
  estimateDepth?: DepthEstimator;
  mlSupported?: () => boolean;
}

export function createDepthVolumeDriver(options: DepthVolumeDriverOptions = {}): Driver {
  const estimate = options.estimateDepth ?? workerDepthEstimator;
  const mlSupported = options.mlSupported ?? isMlSupported;

  async function run(input: DriverInput): Promise<DriverResult> {
    const { image, signal, onProgress, params } = input;
    throwIfAborted(signal);
    onProgress({ label: T.prep, ratio: 0.02 });
    const full = resolveSilhouette(image, input.mask);
    if (!full) throw new LocalizedError(NO_SILHOUETTE);
    const size = workSize(image.width, image.height, Number(params.resolution) || 320);
    const mask = resizeMask(full, size.width, size.height);

    let depth: DepthMap | null = null;
    if (!mlSupported()) {
      onProgress({ label: T.noMl, ratio: 0.1 });
    } else {
      try {
        depth = await estimate({
          image,
          mask,
          width: size.width,
          height: size.height,
          model: typeof params.model === 'string' && params.model ? params.model : MODELS[0].model,
          signal,
          onProgress: (p) => onProgress({ label: p.label, ratio: p.ratio != null ? 0.05 + 0.8 * p.ratio : undefined }),
        });
      } catch (e) {
        if (isAbort(e) || signal.aborted) throw new AbortError();
        const why = e instanceof LocalizedError ? e.i18n.en : e instanceof Error ? e.message : String(e);
        console.warn('[depth-volume] depth model failed; inflation only', e);
        const msg = e instanceof LocalizedError ? { tr: T.fallback(e.i18n.tr).tr, en: T.fallback(e.i18n.en).en } : T.fallback(why.slice(0, 160));
        onProgress({ label: msg, ratio: 0.85 });
        depth = null;
      }
    }
    throwIfAborted(signal);
    onProgress({ label: T.build, ratio: 0.9 });
    await yieldToPaint();
    throwIfAborted(signal);
    const { geometry } = buildDepthVolume(mask, depth, volumeOptionsFrom(params));
    onProgress({ label: T.done, ratio: 1 });
    return { kind: 'geometry', geometry };
  }

  return {
    id: 'depth-volume',
    name: { tr: 'Derinlik + hacim (kapalı gövde)', en: 'Depth + volume (closed body)' },
    description: {
      tr: 'Tek görselden tarayıcıda kapalı, dokulu bir 3B gövde: ön yüz yapay zekâ derinliğinden (Depth Anything V2), arka yüz siluet şişirme ile ön yüzün yumuşatılmış aynasının karışımından. Kirby gibi yuvarlak karakterler top, arabalar kutu gibi hacim kazanır — düz bir kabartma değil. Saydam PNG ya da düz arka plan gerekir; model indirilemezse yalnızca siluet hacmiyle devam eder.',
      en: 'A closed, textured 3D body from one image, in the browser: the front from AI depth (Depth Anything V2), the back from the silhouette inflation blended with a smoothed mirror of the front. Round characters like Kirby become balls and cars box-like volumes — not a flat relief. Needs a transparent PNG or a plain background; if the model cannot download it continues with the silhouette volume alone.',
    },
    category: 'ml',
    badges: ['download', 'webgpu', 'closed-mesh'],
    downloadSizeMB: MODELS[0].downloadSizeMB,
    params: PARAMS,
    producesDepth: false,
    async isAvailable() {
      return mlSupported()
        ? { ok: true }
        : { ok: true, reason: { tr: 'Derinlik modeli bu tarayıcıda çalışamaz; yalnızca siluet hacmi kullanılır.', en: 'The depth model cannot run in this browser; only the silhouette volume is used.' } };
    },
    run,
  };
}

export const depthVolumeDriver: Driver = createDepthVolumeDriver();
