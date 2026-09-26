/**
 * 'multiview-fusion': in-browser full 3D from several views. The front (the
 * source image) and any of back / left / right / top / bottom are fused into
 * a closed, vertex-coloured mesh: a soft visual hull on a voxel grid, carved
 * further by the in-browser depth model run on every view (Depth Anything V2
 * in the ML worker), then marching cubes + Taubin smoothing
 * (src/core/fusion). Without the depth model (download failure, no Worker)
 * it falls back to the silhouette hull with a warning. Hand-made views are
 * registered to the front by their silhouette profiles, thin parts (arms)
 * are guarded against inconsistent views, and each view's ViewAlign (manual
 * offset / scale / flip, trust) travels with it; views switched off are skipped.
 */
import type { Driver, DriverInput, I18nText, ParamSpec, ParamValues } from '../../core/types';
import { throwIfAborted } from '../../core/types';
import { LocalizedError } from '../../core/errors';
import { reconstructFromViews } from '../../core/fusion/reconstruct';
import type { DepthEstimator, FusionOptions, FusionViewInput } from '../../core/fusion/types';
import { DEFAULT_FUSION_OPTIONS } from '../../core/fusion/types';
import { DEPTH_MODEL_SPECS } from '../ml';
import type { DepthModelSpec } from '../ml/depthDriver';
import { mlProgressToProgress, processDepth } from '../ml/postprocess';
import { prepareInferenceImage } from '../ml/prepare';
import { isMlSupported, requestDepth } from '../ml/workerClient';

const ACTION: I18nText = { tr: 'Derinlik hesaplanıyor', en: 'Estimating depth' };

/** Depth models offered for refinement (dynamic-size ViT models only: views are cropped to any aspect). */
const DEPTH_MODELS = DEPTH_MODEL_SPECS.filter((s) => s.patchMultiple);
const DEFAULT_DEPTH_MODEL = 'depth-anything-v2-small';

const pct = (v: number) => Math.round(v * 1000) / 10;

export const FUSION_PARAMS: ParamSpec[] = [
  {
    kind: 'number',
    key: 'resolution',
    label: { tr: 'Voksel çözünürlüğü', en: 'Voxel resolution' },
    hint: {
      tr: 'Nesnenin uzun kenarı boyunca voksel sayısı: yüksek değer daha ayrıntılı ama daha yavaş ve daha çok bellek ister',
      en: 'Voxels along the object\'s longest side: higher is more detailed but slower and uses more memory',
    },
    min: 64,
    max: 256,
    step: 8,
    default: DEFAULT_FUSION_OPTIONS.resolution,
  },
  {
    kind: 'select',
    key: 'hull',
    label: { tr: 'Kabuk modu', en: 'Hull mode' },
    hint: {
      tr: 'Toleranslı: yan/üst/alt görünüm siluetleri biraz genişletilir, yapay zekânın ürettiği hafif kaymış görünümler nesneyi oymaz (arka siluet gövdeyi oymaz; ön görünümün aynasıdır). Katı: hizalı fotoğraflar için',
      en: 'Tolerant: the side / top / bottom silhouettes are widened a little so slightly misaligned AI views do not carve the object away (the back silhouette never carves; it mirrors the front). Strict: for aligned photos',
    },
    default: DEFAULT_FUSION_OPTIONS.hull,
    options: [
      { value: 'tolerant', label: { tr: 'Toleranslı (yapay zekâ görünümleri)', en: 'Tolerant (AI-generated views)' } },
      { value: 'strict', label: { tr: 'Katı (hizalı görünümler)', en: 'Strict (aligned views)' } },
    ],
  },
  {
    kind: 'number',
    key: 'tolerance',
    label: { tr: 'Tolerans (%)', en: 'Tolerance (%)' },
    hint: {
      tr: 'Toleranslı modda ek görünüm siluetlerinin genişletilme miktarı (görünümün uzun kenarına oran)',
      en: 'How much extra views\' silhouettes are widened in tolerant mode (share of the view\'s longest side)',
    },
    min: 0,
    max: 10,
    step: 0.5,
    default: pct(DEFAULT_FUSION_OPTIONS.tolerance),
  },
  {
    kind: 'select',
    key: 'align',
    label: { tr: 'Görünüm hizalama', en: 'View alignment' },
    hint: {
      tr: 'Ek görünümler ön görünüme siluet profilleriyle hizalanır: farklı ölçek, kayma ve kenarda kesik çerçeveler düzelir',
      en: 'Extra views are aligned to the front by their silhouette profiles: different scale, offset and cropped framing are corrected',
    },
    default: 'auto',
    options: [
      { value: 'auto', label: { tr: 'Otomatik (siluet profilleri)', en: 'Automatic (silhouette profiles)' } },
      { value: 'bbox', label: { tr: 'Yalnız çerçeve', en: 'Frame only' } },
    ],
  },
  {
    kind: 'number',
    key: 'guard',
    label: { tr: 'İnce parça koruması (%)', en: 'Thin-part guard (%)' },
    hint: {
      tr: 'Ön görünümde ince olan parçalar (kollar, bacaklar) diğer görünümler uyuşmasa da bu kalınlığa kadar korunur; 0 = kapalı',
      en: 'Parts that are thin in the front view (arms, legs) are kept even where other views disagree, up to this share of the size; 0 = off',
    },
    min: 0,
    max: 15,
    step: 1,
    default: 6,
  },
  {
    kind: 'boolean',
    key: 'depthRefine',
    label: { tr: 'Derinlikle iyileştir', en: 'Refine with depth' },
    hint: {
      tr: 'Her görünümde tarayıcıda derinlik modeli çalıştırır (ilk kullanımda ~50 MB indirilir): oyukları ve yuvarlak yüzeyleri yakalar. Kapalıyken yalnız siluetler kullanılır',
      en: 'Runs the in-browser depth model on every view (~50 MB download on first use): captures concavities and rounded surfaces. Off = silhouettes only',
    },
    default: true,
  },
  {
    kind: 'select',
    key: 'depthModel',
    label: { tr: 'Derinlik modeli', en: 'Depth model' },
    default: DEFAULT_DEPTH_MODEL,
    options: DEPTH_MODELS.map((s) => ({ value: s.id, label: s.name })),
  },
  {
    kind: 'number',
    key: 'depthStrength',
    label: { tr: 'Derinlik etkisi', en: 'Depth strength' },
    hint: {
      tr: 'Derinlik haritalarının ne kadar oyacağı: 1 = her görünüm nesnenin yakın yarısına kadar oyabilir',
      en: 'How far the depth maps may carve: 1 = each view may carve up to the near half of the object',
    },
    min: 0,
    max: 1,
    step: 0.05,
    default: DEFAULT_FUSION_OPTIONS.depthStrength,
  },
  {
    kind: 'select',
    key: 'depthFit',
    label: { tr: 'Derinlik ölçeği', en: 'Depth scale' },
    hint: {
      tr: 'Nesne: her görünümün derinlik ölçeği görsel kabuktan ölçülür, tüm nesne için tek ölçek (tutarlı). Işın: her ışın kendi kabuk aralığına göre ölçeklenir (daha agresif)',
      en: 'Object: each view\'s depth scale is measured against the visual hull, one scale for the whole object (consistent). Ray: each ray is scaled to its own hull interval (more aggressive)',
    },
    default: DEFAULT_FUSION_OPTIONS.depthFit,
    options: [
      { value: 'object', label: { tr: 'Nesne kutusu', en: 'Object box' } },
      { value: 'ray', label: { tr: 'Işın aralığı', en: 'Per ray' } },
    ],
  },
  {
    kind: 'number',
    key: 'defaultDepth',
    label: { tr: 'Varsayılan kalınlık', en: 'Default thickness' },
    hint: {
      tr: 'Yalnız ön / arka görünüm varken nesnenin kalınlığı (genişliğe oran). Yan, üst ya da alt görünüm varsa ondan ölçülür',
      en: 'Object thickness (share of its width) when only front / back views exist. Measured from side, top or bottom views when present',
    },
    min: 0.1,
    max: 2,
    step: 0.05,
    default: DEFAULT_FUSION_OPTIONS.defaultDepth,
  },
  {
    kind: 'number',
    key: 'smoothness',
    label: { tr: 'Hacim yumuşatma', en: 'Volume smoothing' },
    hint: { tr: 'Yüzey çıkarılmadan önce hacme uygulanan Gauss bulanıklığı (voksel)', en: 'Gaussian blur of the volume before surface extraction (voxels)' },
    min: 0,
    max: 3,
    step: 0.1,
    default: DEFAULT_FUSION_OPTIONS.smoothness,
  },
  {
    kind: 'number',
    key: 'smoothIterations',
    label: { tr: 'Mesh yumuşatma adımı', en: 'Mesh smoothing steps' },
    hint: { tr: 'Taubin yumuşatma (hacmi küçültmeden basamakları giderir)', en: 'Taubin smoothing (removes voxel steps without shrinking)' },
    min: 0,
    max: 30,
    step: 1,
    default: DEFAULT_FUSION_OPTIONS.smoothIterations,
  },
  {
    kind: 'number',
    key: 'colorSharpness',
    label: { tr: 'Renk keskinliği', en: 'Colour sharpness' },
    hint: {
      tr: 'Yüzeye dik bakan görünümün renk ağırlığı: yüksek değer daha net, düşük değer görünümler arasında daha yumuşak geçiş',
      en: 'Weight of the view facing the surface: higher is crisper, lower blends views more softly',
    },
    min: 1,
    max: 16,
    step: 0.5,
    default: DEFAULT_FUSION_OPTIONS.colorSharpness,
  },
  {
    kind: 'number',
    key: 'maxTriangles',
    label: { tr: 'Üçgen sınırı', en: 'Triangle cap' },
    hint: { tr: 'Aşılırsa voksel adımı büyütülür (daha kaba yüzey)', en: 'Above it the voxel step grows (coarser surface)' },
    min: 20_000,
    max: 1_000_000,
    step: 10_000,
    default: DEFAULT_FUSION_OPTIONS.maxTriangles,
  },
];

/**
 * Driver params → fusion options (tolerance and guard are in percent). The
 * back-hull and calibration modes are options only (defaults: robust), not params.
 */
export function fusionOptionsFromParams(p: ParamValues): Partial<FusionOptions> {
  const num = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : undefined);
  const tol = num('tolerance');
  const guard = num('guard');
  return {
    resolution: num('resolution'),
    hull: p.hull === 'strict' ? 'strict' : 'tolerant',
    tolerance: tol === undefined ? undefined : tol / 100,
    align: p.align === 'bbox' ? 'bbox' : 'auto',
    guard: guard === undefined ? undefined : guard / 100,
    defaultDepth: num('defaultDepth'),
    depthStrength: num('depthStrength'),
    depthFit: p.depthFit === 'ray' ? 'ray' : 'object',
    smoothness: num('smoothness'),
    smoothIterations: num('smoothIterations'),
    colorSharpness: num('colorSharpness'),
    maxTriangles: num('maxTriangles'),
  };
}

const NO_ML: I18nText = {
  tr: 'Bu tarayıcı Web Worker / WebAssembly desteklemiyor',
  en: 'This browser does not support Web Workers / WebAssembly',
};

/** Depth estimator backed by the ML worker (same pipeline as the depth drivers). */
export function createWorkerDepthEstimator(spec: DepthModelSpec): DepthEstimator {
  return async ({ image, mask }, { signal, onProgress }) => {
    if (!isMlSupported()) throw new LocalizedError(NO_ML);
    const prepared = prepareInferenceImage(image, { side: spec.nativeSide, multiple: spec.patchMultiple ?? 1 });
    const raw = await requestDepth(
      { model: spec.model, image: prepared, exactSize: !!spec.patchMultiple, device: 'auto', precision: 'auto' },
      { signal, onProgress: (p) => onProgress(mlProgressToProgress(p, ACTION)) },
    );
    throwIfAborted(signal);
    return processDepth(raw, { width: image.width, height: image.height, convention: spec.convention, mask, refine: null });
  };
}

function depthSpec(id: unknown): DepthModelSpec {
  return DEPTH_MODELS.find((s) => s.id === id) ?? DEPTH_MODELS.find((s) => s.id === DEFAULT_DEPTH_MODEL) ?? DEPTH_MODEL_SPECS[0];
}

/**
 * Front (the source image and its resolved mask) plus every extra view with
 * its alignment / trust request; views switched off in the Views panel are left out.
 */
export function fusionInputs(input: Pick<DriverInput, 'image' | 'mask' | 'views'>): FusionViewInput[] {
  const out: FusionViewInput[] = [{ id: 'front', image: input.image, mask: input.mask }];
  for (const v of Object.values(input.views)) {
    if (!v || v.id === 'front' || v.align?.trust === 'off') continue;
    out.push({ id: v.id, image: v.image, mask: v.mask, align: v.align });
  }
  return out;
}

export const multiviewFusionDriver: Driver = {
  id: 'multiview-fusion',
  name: { tr: 'Çok görünümlü birleştirme (tam 3B)', en: 'Multi-view fusion (full 3D)' },
  description: {
    tr: 'Ön görünümü arka / sol / sağ / üst / alt görünümlerle birleştirip kapalı, renkli tam 3B model üretir: siluetlerden görsel kabuk, '
      + 'ardından her görünümde tarayıcıda derinlik tahminiyle oyma. Görünümleri yükleyin ya da yapay zekâ ile üretin; tamamen tarayıcıda çalışır. '
      + 'İnce parçalar (kollar) korunur; kesik / kaymış görünümler otomatik hizalanır.',
    en: 'Fuses the front with the back / left / right / top / bottom views into a closed, coloured full 3D model: a visual hull from the '
      + 'silhouettes, then carving with in-browser depth estimation on every view. Upload the views or generate them with AI; runs entirely in the browser. '
      + 'Thin parts (arms) are protected; cropped or shifted views are aligned automatically.',
  },
  category: 'multiview',
  badges: ['multi-view', 'full-3d', 'closed-mesh', 'download'],
  downloadSizeMB: 50,
  params: FUSION_PARAMS,
  producesDepth: false,
  views: 'required',
  minViews: [],
  async run(input) {
    const { params, signal, onProgress } = input;
    throwIfAborted(signal);
    const estimateDepth = params.depthRefine === false ? null : createWorkerDepthEstimator(depthSpec(params.depthModel));
    const { geometry, info } = await reconstructFromViews(fusionInputs(input), fusionOptionsFromParams(params), {
      signal,
      onProgress,
      estimateDepth,
    });
    // The consistency report the 3D step shows (reconstruct sets it too; kept in step here).
    if (info.report) geometry.userData.fusion ??= info.report;
    return { kind: 'geometry', geometry };
  },
};
