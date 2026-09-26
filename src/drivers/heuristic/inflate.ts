/**
 * "Balloon" inflation of a silhouette (Teddy / Monster Mash style), fully
 * offline. Every foreground pixel carries a sphere whose radius is its
 * distance to the silhouette edge; the union of those spheres has circular
 * cross-sections — a disk becomes a hemisphere, a limb a round tube — so
 * thin parts are naturally thinner than thick ones.
 */
import type { DepthMap, Driver, DriverInput, DriverResult, I18nText, Mask, ParamSpec, RGBAImage } from '../../core/types';
import { throwIfAborted } from '../../core/types';
import { yieldToPaint } from '../../core/yield';
import { LocalizedError } from '../../core/errors';
import { blurFloat, luminance, maskArea, maskFromAlpha, resizeMask } from '../../core/image/ops';
import { distanceTransform, unionOfSpheres } from '../../core/image/distance';
import { autoMaskFromBorder, hasMeaningfulAlpha } from '../../core/image/autoMask';

export type InflateProfile = 'round' | 'soft' | 'flat';

export interface InflateOptions {
  /** Cross-section: round = balloon (circular), soft = pillow (parabolic), flat = cookie (plateau + rounded bevel). */
  profile: InflateProfile;
  /** 0..1: 0 = thickness proportional to local width, 1 = every part as thick as the thickest. */
  thickness: number;
  /** 0..1: amount of image-luminance relief added on top of the body. */
  detail: number;
  /** Shape blur radius in pixels at a 512 px working size (scaled with the image). */
  blur: number;
}

export const DEFAULT_INFLATE_OPTIONS: InflateOptions = { profile: 'round', thickness: 0.2, detail: 0, blur: 1 };

// Moved to core; re-exported for existing imports.
export { LocalizedError };

export const NO_SILHOUETTE: I18nText = {
  tr: 'Siluet bulunamadı. Saydam arka planlı bir PNG ya da düz, tek renk arka plan üzerinde bir görsel yükleyin (veya arka plan kaldırmayı kullanın).',
  en: 'No silhouette found. Upload a PNG with a transparent background or an image on a plain, single-colour background (or use background removal).',
};

/**
 * Foreground mask for silhouette-based drivers: the given mask, else the
 * alpha channel, else a border-colour flood fill. Null if none is usable.
 */
export function resolveSilhouette(image: RGBAImage, mask: Mask | null): Mask | null {
  if (mask) {
    const m = mask.width === image.width && mask.height === image.height ? mask : resizeMask(mask, image.width, image.height);
    return maskArea(m) > 0 ? m : null;
  }
  if (hasMeaningfulAlpha(image)) {
    const m = maskFromAlpha(image);
    return maskArea(m) > 0 ? m : null;
  }
  return autoMaskFromBorder(image);
}

/**
 * Inflated height field of `mask`, normalised to [0, 1] (1 = thickest point,
 * ~0 at the silhouette edge, exactly 0 on the background).
 * `image` (same size as the mask) is only needed when `opts.detail > 0`.
 */
export function inflateDepth(mask: Mask, image: RGBAImage | null, opts: InflateOptions): DepthMap {
  const { width: w, height: h, data: m } = mask;
  const n = w * h;
  const L = Math.max(w, h);
  const k = Math.min(1, Math.max(0, opts.thickness));

  // Sphere radius = distance to the nearest background pixel centre, so the
  // surface reaches 0 exactly at the silhouette. (Using the half-pixel
  // boundary instead lets tiny rim spheres win and adds edge noise.)
  // The exact EDT jitters by ~0.3 px along the medial ridge (lattice
  // effects), which shows up as ripples on the dome; a light blur capped by
  // the raw distance smooths the ridge without pushing spheres past the edge.
  const dist = distanceTransform(mask);
  const ridge = blurFloat(dist, w, h, Math.min(4, Math.max(1.5, L / 128)), 3, mask);
  const radius = new Float32Array(n);
  for (let i = 0; i < n; i++) radius[i] = ridge[i] < dist[i] ? ridge[i] : dist[i];
  const hr = unionOfSpheres(radius, w, h);

  let height = hr;
  if (opts.profile !== 'round' || k > 0) {
    let rMax = 0;
    for (let i = 0; i < n; i++) if (radius[i] > rMax) rMax = radius[i];
    // For a circular section of radius R, the height H at depth d from the
    // edge satisfies H² = 2Rd − d², so R = (H² + d²) / 2d is a continuous
    // local-radius estimate (no seams between parts, unlike per-sphere radii).
    const local = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (!m[i]) continue;
      const d = Math.max(1e-3, radius[i]), H = hr[i];
      local[i] = Math.min(rMax, (H * H + d * d) / (2 * d));
    }
    // Smoothed copy for the soft profile, whose shape depends on R directly.
    const localSmooth = opts.profile === 'soft' ? blurFloat(local, w, h, Math.max(1, rMax * 0.1), 3, mask) : local;
    const plateau = Math.max(1, rMax * 0.3);
    height = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (!m[i]) continue;
      const H = hr[i];
      const boost = k > 0 ? Math.pow(rMax / local[i], k) : 1;
      if (opts.profile === 'soft') {
        // Parabolic section R·(2s − s²) with s = d / R, which equals H² / R:
        // rounded, but meets the silhouette at a finite angle (pillow).
        height[i] = ((H * H) / Math.max(H, localSmooth[i])) * boost;
      } else if (opts.profile === 'flat') {
        // Cookie: round body clipped by a plateau with a C1 rounded shoulder.
        const u = Math.min(1, (H * boost) / plateau);
        height[i] = plateau * (1 - (1 - u) * (1 - u));
      } else {
        height[i] = H * boost;
      }
    }
  }

  const blurR = Math.max(0, opts.blur) * (L / 512);
  if (blurR >= 0.5) height = blurFloat(height, w, h, blurR, 3, mask);
  let depth = normaliseMax(height, m);

  if (opts.detail > 0 && image && image.width === w && image.height === h) {
    depth = addDetail(depth, image, mask, Math.min(1, opts.detail));
  }
  return { width: w, height: h, data: depth };
}

/** Divide by the foreground maximum; background forced to 0. */
function normaliseMax(data: Float32Array, m: Uint8Array): Float32Array {
  let max = 0;
  for (let i = 0; i < data.length; i++) if (m[i] && data[i] > max) max = data[i];
  const out = new Float32Array(data.length);
  if (max <= 0) return out;
  const inv = 1 / max;
  for (let i = 0; i < data.length; i++) out[i] = m[i] ? Math.min(1, Math.max(0, data[i] * inv)) : 0;
  return out;
}

/**
 * Mix in high-frequency luminance relief (bright = raised), faded out near the
 * silhouette so the edge stays at ~0.
 */
function addDetail(depth: Float32Array, image: RGBAImage, mask: Mask, amount: number): Float32Array {
  const { width: w, height: h, data: m } = mask;
  const n = w * h;
  const L = Math.max(w, h);
  const lum = blurFloat(luminance(image), w, h, 1, 1, mask); // light denoise
  const base = blurFloat(lum, w, h, Math.max(2, L / 100), 3, mask);
  let sum2 = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    if (!m[i]) continue;
    const d = lum[i] - base[i];
    sum2 += d * d;
    cnt++;
  }
  const sigma = cnt > 0 ? Math.sqrt(sum2 / cnt) : 0;
  if (sigma < 1e-4) return depth;
  const scale = 1 / (2.5 * sigma);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!m[i]) continue;
    const hp = Math.min(1, Math.max(-1, (lum[i] - base[i]) * scale));
    const fade = Math.min(1, depth[i] / 0.15);
    out[i] = Math.max(0, depth[i] + amount * 0.25 * hp * fade);
  }
  return normaliseMax(out, m);
}

/** Let queued input (Cancel / Esc) run between steps. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const PARAMS: ParamSpec[] = [
  {
    kind: 'select',
    key: 'profile',
    label: { tr: 'Profil', en: 'Profile' },
    hint: { tr: 'Kesit şekli', en: 'Cross-section shape' },
    default: DEFAULT_INFLATE_OPTIONS.profile,
    options: [
      { value: 'round', label: { tr: 'Yuvarlak (balon)', en: 'Round (balloon)' } },
      { value: 'soft', label: { tr: 'Yumuşak (yastık)', en: 'Soft (pillow)' } },
      { value: 'flat', label: { tr: 'Düz (kurabiye, yuvarlatılmış kenar)', en: 'Flat (cookie, rounded edge)' } },
    ],
  },
  {
    kind: 'number',
    key: 'thickness',
    label: { tr: 'İnce parça kalınlığı', en: 'Thin-part thickness' },
    hint: {
      tr: '0 = gerçek yuvarlak kesit (ince kısımlar ince kalır), 1 = tüm parçalar eşit kalın',
      en: '0 = true round cross-sections (thin parts stay thin), 1 = every part equally thick',
    },
    min: 0, max: 1, step: 0.05, default: DEFAULT_INFLATE_OPTIONS.thickness,
  },
  {
    kind: 'number',
    key: 'detail',
    label: { tr: 'Yüzey detayı', en: 'Surface detail' },
    hint: { tr: 'Görselin parlaklığından ince kabartma ekler', en: 'Adds fine relief from the image brightness' },
    min: 0, max: 1, step: 0.05, default: DEFAULT_INFLATE_OPTIONS.detail,
  },
  {
    kind: 'number',
    key: 'blur',
    label: { tr: 'Şekil yumuşatma', en: 'Shape blur' },
    hint: { tr: 'Parçalar arasındaki kıvrımları yumuşatır', en: 'Softens creases between parts' },
    min: 0, max: 10, step: 0.5, default: DEFAULT_INFLATE_OPTIONS.blur,
  },
];

function optionsFromParams(p: DriverInput['params']): InflateOptions {
  const d = DEFAULT_INFLATE_OPTIONS;
  const num = (key: 'thickness' | 'detail' | 'blur') =>
    typeof p[key] === 'number' && Number.isFinite(p[key]) ? (p[key] as number) : d[key];
  const profile = p.profile === 'soft' || p.profile === 'flat' || p.profile === 'round' ? p.profile : d.profile;
  return { profile, thickness: num('thickness'), detail: num('detail'), blur: num('blur') };
}

export const inflateDriver: Driver = {
  id: 'silhouette-inflate',
  name: { tr: 'Siluet şişirme', en: 'Silhouette inflate' },
  description: {
    tr: 'Silueti balon gibi şişirerek yumuşak, hacimli bir gövde üretir (Teddy / Monster Mash tarzı). Karakterler, logolar ve çizimler için idealdir; saydam PNG ya da düz arka plan gerekir. Kapalı bir 3D şekil için mesh tipi olarak "Çift yüz" önerilir.',
    en: 'Inflates the silhouette into a puffy, balloon-like body (Teddy / Monster Mash style). Great for characters, logos and drawings; needs a transparent PNG or a plain background. Use mesh type "Double-sided" for a closed 3D shape.',
  },
  category: 'heuristic',
  badges: ['offline', 'closed-mesh'],
  params: PARAMS,
  producesDepth: true,
  async run(input: DriverInput): Promise<DriverResult> {
    const { image, signal, onProgress } = input;
    throwIfAborted(signal);
    onProgress({ label: { tr: 'Siluet hazırlanıyor', en: 'Preparing silhouette' }, ratio: 0.1 });
    const mask = resolveSilhouette(image, input.mask);
    if (!mask) throw new LocalizedError(NO_SILHOUETTE);
    await tick();
    throwIfAborted(signal);
    onProgress({ label: { tr: 'Şişiriliyor', en: 'Inflating' }, ratio: 0.4 });
    await yieldToPaint(); // show the label during the synchronous step
    throwIfAborted(signal);
    const depth = inflateDepth(mask, image, optionsFromParams(input.params));
    throwIfAborted(signal);
    onProgress({ label: { tr: 'Tamamlandı', en: 'Done' }, ratio: 1 });
    return { kind: 'depth', depth, mask };
  },
};
