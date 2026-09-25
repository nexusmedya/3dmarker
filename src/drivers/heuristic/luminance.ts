/**
 * Brightness → height (emboss / lithophane style), fully offline. No real
 * depth estimation: it turns tonal structure into relief, which suits logos,
 * line art, coins, engravings and lithophanes.
 */
import type { DepthMap, Driver, DriverInput, DriverResult, Mask, ParamSpec, RGBAImage } from '../../core/types';
import { throwIfAborted } from '../../core/types';
import { blurFloat, luminance, resizeMask } from '../../core/image/ops';

export type HeightSource = 'luminance' | 'lightness' | 'saturation';

export interface LuminanceOptions {
  source: HeightSource;
  /** Dark = near (lithophane convention) instead of bright = near. */
  invert: boolean;
  /** Tone curve steepness around mid-grey (1 = linear, >1 more contrast, <1 flatter mid-tones). */
  contrast: number;
  /** Noise blur radius in pixels at a 512 px working size (scaled with the image). */
  blur: number;
  /** Unsharp-mask boost of fine detail (0 = off). */
  detail: number;
}

export const DEFAULT_LUMINANCE_OPTIONS: LuminanceOptions = {
  source: 'luminance',
  invert: false,
  contrast: 1,
  blur: 1,
  detail: 0.5,
};

/** Single-channel height source in [0, 1]. */
export function sourceChannel(img: RGBAImage, source: HeightSource): Float32Array {
  if (source === 'luminance') return luminance(img);
  const n = img.width * img.height;
  const d = img.data;
  const out = new Float32Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const r = d[o], g = d[o + 1], b = d[o + 2];
    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    // lightness: HSL L; saturation: chroma (max − min), which stays calm in
    // near-black areas where HSV/HSL saturation explodes on noise.
    out[i] = (source === 'lightness' ? (max + min) / 2 : max - min) / 255;
  }
  return out;
}

/**
 * Stretch the foreground values so the `lo`/`hi` quantiles map to 0/1
 * (histogram based, O(n)). Background pixels are left untouched.
 */
export function autoLevels(data: Float32Array, mask: Mask | null, lo = 0.005, hi = 0.995): Float32Array {
  const n = data.length;
  let min = Infinity, max = -Infinity, count = 0;
  for (let i = 0; i < n; i++) {
    if (mask && !mask.data[i]) continue;
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
    count++;
  }
  const out = data.slice();
  if (count === 0) return out;
  if (!(max - min > 1e-9)) {
    for (let i = 0; i < n; i++) if (!mask || mask.data[i]) out[i] = 0.5;
    return out;
  }
  const BINS = 4096;
  const hist = new Int32Array(BINS);
  const toBin = (BINS - 1) / (max - min);
  for (let i = 0; i < n; i++) if (!mask || mask.data[i]) hist[Math.round((data[i] - min) * toBin)]++;
  const quantile = (q: number) => {
    const target = q * (count - 1);
    let acc = 0;
    for (let b = 0; b < BINS; b++) {
      acc += hist[b];
      if (acc > target) return min + b / toBin;
    }
    return max;
  };
  let a = quantile(lo), b = quantile(hi);
  if (!(b - a > 1e-9)) { a = min; b = max; }
  const inv = 1 / (b - a);
  for (let i = 0; i < n; i++) {
    if (mask && !mask.data[i]) continue;
    const v = (data[i] - a) * inv;
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}

/** Symmetric S-curve on [0, 1] fixing 0, ½ and 1: v^c / (v^c + (1 − v)^c). */
export function contrastCurve(v: number, c: number): number {
  if (c === 1 || v <= 0 || v >= 1) return v;
  const a = Math.pow(v, c);
  return a / (a + Math.pow(1 - v, c));
}

/**
 * Height map from image tones, normalised to [0, 1] (1 = near). With a mask,
 * statistics and filtering use foreground pixels only and the background is 0.
 */
export function luminanceDepth(img: RGBAImage, mask: Mask | null, opts: LuminanceOptions): DepthMap {
  const { width: w, height: h } = img;
  const n = w * h;
  const L = Math.max(w, h);
  let v = sourceChannel(img, opts.source);

  const blurR = Math.max(0, opts.blur) * (L / 512);
  if (blurR >= 0.5) v = blurFloat(v, w, h, blurR, 3, mask);

  if (opts.detail > 0) {
    // Unsharp mask: boost everything finer than ~1.5 % of the image.
    const base = blurFloat(v, w, h, Math.max(2, L / 64), 3, mask);
    const amt = opts.detail;
    for (let i = 0; i < n; i++) v[i] += amt * (v[i] - base[i]);
  }

  v = autoLevels(v, mask);
  const c = Math.max(0.05, opts.contrast);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (mask && !mask.data[i]) continue;
    const t = contrastCurve(v[i], c);
    out[i] = opts.invert ? 1 - t : t;
  }
  return { width: w, height: h, data: out };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const PARAMS: ParamSpec[] = [
  {
    kind: 'select',
    key: 'source',
    label: { tr: 'Kaynak kanal', en: 'Source channel' },
    default: DEFAULT_LUMINANCE_OPTIONS.source,
    options: [
      { value: 'luminance', label: { tr: 'Parlaklık (luma)', en: 'Luminance (luma)' } },
      { value: 'lightness', label: { tr: 'Açıklık (HSL)', en: 'Lightness (HSL)' } },
      { value: 'saturation', label: { tr: 'Doygunluk (renk canlılığı)', en: 'Saturation (colourfulness)' } },
    ],
  },
  {
    kind: 'boolean',
    key: 'invert',
    label: { tr: 'Koyu = yakın', en: 'Dark = near' },
    hint: {
      tr: 'Litofan için açın: koyu alanlar kalın, açık alanlar ince olur',
      en: 'Turn on for lithophanes: dark areas become thick, light areas thin',
    },
    default: DEFAULT_LUMINANCE_OPTIONS.invert,
  },
  {
    kind: 'number',
    key: 'contrast',
    label: { tr: 'Kontrast', en: 'Contrast' },
    hint: { tr: '1 = doğrusal', en: '1 = linear' },
    min: 0.2, max: 4, step: 0.05, default: DEFAULT_LUMINANCE_OPTIONS.contrast,
  },
  {
    kind: 'number',
    key: 'blur',
    label: { tr: 'Gürültü yumuşatma', en: 'Noise blur' },
    min: 0, max: 10, step: 0.5, default: DEFAULT_LUMINANCE_OPTIONS.blur,
  },
  {
    kind: 'number',
    key: 'detail',
    label: { tr: 'Detay vurgusu', en: 'Detail boost' },
    hint: { tr: 'İnce ayrıntıları keskinleştirir', en: 'Sharpens fine detail (unsharp mask)' },
    min: 0, max: 3, step: 0.1, default: DEFAULT_LUMINANCE_OPTIONS.detail,
  },
];

function optionsFromParams(p: DriverInput['params']): LuminanceOptions {
  const d = DEFAULT_LUMINANCE_OPTIONS;
  const num = (key: 'contrast' | 'blur' | 'detail') =>
    typeof p[key] === 'number' && Number.isFinite(p[key]) ? (p[key] as number) : d[key];
  const source = p.source === 'lightness' || p.source === 'saturation' || p.source === 'luminance' ? p.source : d.source;
  return {
    source,
    invert: typeof p.invert === 'boolean' ? p.invert : d.invert,
    contrast: num('contrast'),
    blur: num('blur'),
    detail: num('detail'),
  };
}

export const luminanceDriver: Driver = {
  id: 'luminance-heightmap',
  name: { tr: 'Parlaklık haritası', en: 'Luminance heightmap' },
  description: {
    tr: 'Parlak alanları öne, koyu alanları geriye iterek kabartma üretir (rölyef / litofan). Model indirmez, anında çalışır; logolar, çizimler, madeni para ve gravür tarzı görseller için uygundur. Gerçek derinlik tahmini yapmaz.',
    en: 'Turns brightness into relief: bright areas come forward, dark areas recede (emboss / lithophane). No download, instant; suits logos, line art, coins and engravings. Does not estimate real depth.',
  },
  category: 'heuristic',
  badges: ['offline'],
  params: PARAMS,
  producesDepth: true,
  async run(input: DriverInput): Promise<DriverResult> {
    const { image, signal, onProgress } = input;
    throwIfAborted(signal);
    onProgress({ label: { tr: 'Yükseklik haritası hesaplanıyor', en: 'Computing height map' }, ratio: 0.2 });
    await tick();
    throwIfAborted(signal);
    const mask =
      input.mask && (input.mask.width !== image.width || input.mask.height !== image.height)
        ? resizeMask(input.mask, image.width, image.height)
        : input.mask;
    const depth = luminanceDepth(image, mask, optionsFromParams(input.params));
    throwIfAborted(signal);
    onProgress({ label: { tr: 'Tamamlandı', en: 'Done' }, ratio: 1 });
    return { kind: 'depth', depth, mask };
  },
};
