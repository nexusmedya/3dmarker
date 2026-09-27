/**
 * UI-side metadata about drivers: category / badge labels, "best for" copy
 * for the comparison table and the mesh mode suggested when switching.
 */
import type { Driver, DriverBadge, DriverCategory, I18nText } from '../core/types';
import type { MeshMode } from '../core/mesh/options';

export const CATEGORY_ORDER: DriverCategory[] = ['ml', 'heuristic', 'multiview', 'cloud'];

export const CATEGORY_LABELS: Record<DriverCategory, I18nText> = {
  ml: { tr: 'Yapay zekâ derinlik (tarayıcıda)', en: 'ML depth (in-browser)' },
  heuristic: { tr: 'Sezgisel (anında, çevrimdışı)', en: 'Heuristic (instant, offline)' },
  multiview: { tr: 'Çok görünümlü (tam 3D, tarayıcıda)', en: 'Multi-view (full 3D, in-browser)' },
  cloud: { tr: 'Bulut (tam 3D)', en: 'Cloud (full 3D)' },
};

export const CATEGORY_SHORT: Record<DriverCategory, I18nText> = {
  ml: { tr: 'Yapay zekâ', en: 'ML depth' },
  heuristic: { tr: 'Sezgisel', en: 'Heuristic' },
  multiview: { tr: 'Çok görünüm', en: 'Multi-view' },
  cloud: { tr: 'Bulut', en: 'Cloud' },
};

export const BADGE_LABELS: Record<DriverBadge, I18nText> = {
  offline: { tr: 'Çevrimdışı', en: 'Offline' },
  download: { tr: 'Model indirir', en: 'Downloads model' },
  webgpu: { tr: 'WebGPU', en: 'WebGPU' },
  'api-key': { tr: 'API anahtarı', en: 'API key' },
  'closed-mesh': { tr: 'Kapalı mesh', en: 'Closed mesh' },
  'full-3d': { tr: 'Tam 3D', en: 'Full 3D' },
  'multi-view': { tr: 'Çok görünüm', en: 'Multi-view' },
  'human-detail': { tr: 'İnsan detayı', en: 'Human detail' },
};

export const BADGE_HINTS: Record<DriverBadge, I18nText> = {
  offline: { tr: 'Tamamen yerel çalışır, indirme yok', en: 'Runs fully locally, no downloads' },
  download: { tr: 'İlk kullanımda model ağırlıklarını indirir (sonra önbellekte)', en: 'Downloads model weights on first use (cached afterwards)' },
  webgpu: { tr: 'Varsa WebGPU ile hızlanır, yoksa WASM', en: 'Accelerated by WebGPU when available, else WASM' },
  'api-key': { tr: 'Sunucu tarafında ya da sizin API anahtarınızı ister', en: 'Needs a server-side or your own API key' },
  'closed-mesh': { tr: 'Kapalı (watertight) mesh üretebilir', en: 'Can produce a closed (watertight) mesh' },
  'full-3d': { tr: 'Görünmeyen arka yüzü de oluşturur', en: 'Reconstructs the unseen back side' },
  'multi-view': { tr: 'Arka / yan / üst / alt görünümleri kullanır', en: 'Uses the back / side / top / bottom views' },
  'human-detail': { tr: 'Yüz ve elleri işaret noktalarıyla ayrıntılandırır', en: 'Refines faces and hands with landmark detection' },
};

const BEST_FOR: Record<string, I18nText> = {
  'depth-anything-v2-small': { tr: 'Fotoğraflar, sahneler, portreler — hızlı', en: 'Photos, scenes, portraits — fast' },
  'depth-anything-v2-base': { tr: 'Ayrıntılı fotoğraflar, en iyi derinlik kalitesi', en: 'Detailed photos, best depth quality' },
  'dpt-hybrid-midas': { tr: 'Sahne ölçeğinde yumuşak derinlik, karşılaştırma', en: 'Smooth scene-level depth, comparison' },
  'silhouette-inflate': { tr: 'Karakterler, maskotlar, çizimler (pofuduk)', en: 'Characters, mascots, drawings (puffy)' },
  'silhouette-extrude': { tr: 'Logolar, ikonlar, yazılar, 3D baskı', en: 'Logos, icons, lettering, 3D printing' },
  'luminance-heightmap': { tr: 'Kabartmalar, litofan, desenler, dokular', en: 'Embossing, lithophanes, patterns, textures' },
  'tripo3d-cloud': { tr: 'Gerçekçi, her yönden tam 3D nesneler', en: 'Realistic objects, complete from every side' },
  'multiview-fusion': {
    tr: 'Ön + arka / yan görünümleri olan karakterler ve nesneler — tarayıcıda, kapalı ve renkli',
    en: 'Characters and objects with front + back / side views — in-browser, closed and coloured',
  },
  'tripo3d-multiview': { tr: 'Ön + yan + arka görünümlerden gerçekçi tam 3D (bulut)', en: 'Realistic full 3D from front + side + back views (cloud)' },
  'depth-volume': {
    tr: 'Kirby gibi yuvarlak karakterler, oyuncaklar, arabalar — tarayıcıda kapalı, dokulu gövde (düz kabartma değil)',
    en: 'Round characters like Kirby, toys, cars — a closed, textured body in the browser (not a flat relief)',
  },
  'hf-trellis': {
    tr: 'En iyi genel kalite: karakterler, arabalar, nesneler — ücretsiz, anahtarsız tam 3D (tripo3d.ai’ye en yakın)',
    en: 'Best overall quality: characters, cars, objects — free, keyless full 3D (closest to tripo3d.ai)',
  },
  'hf-hunyuan3d-2': {
    tr: 'Çok ayrıntılı, keskin geometri: araba gövdeleri, mekanik parçalar, yüzler — ücretsiz tam 3D',
    en: 'Very detailed, crisp geometry: car bodies, mechanical parts, faces — free full 3D',
  },
  'hf-triposg': {
    tr: 'Yüksek sadakatli şekil (Tripo ekibinden, açık kaynak), karakter ve araçlar — ücretsiz tam 3D',
    en: 'High-fidelity shapes (open model from the Tripo team), characters and vehicles — free full 3D',
  },
  'hf-stable-fast-3d': {
    tr: 'Saniyeler içinde temiz dokulu model; diğerlerinin kotası dolduğunda yedek — ücretsiz tam 3D',
    en: 'A clean textured model in seconds; the fallback when the others are out of quota — free full 3D',
  },
  'ai-provider-3d': {
    tr: 'Kendi eklediğiniz yapay zekâ sağlayıcısıyla (fal, Replicate, Tripo…) tam 3D',
    en: 'Full 3D with an AI provider you added (fal, Replicate, Tripo…)',
  },
};

const BEST_FOR_FALLBACK: Record<DriverCategory, I18nText> = {
  ml: { tr: 'Fotoğraflar ve sahneler', en: 'Photos and scenes' },
  heuristic: { tr: 'Basit grafikler', en: 'Simple graphics' },
  multiview: { tr: 'Birden çok görünümü olan karakter ve nesneler', en: 'Characters and objects with several views' },
  cloud: { tr: 'Tam 3D nesneler', en: 'Full 3D objects' },
};

export function bestFor(driver: Driver): I18nText {
  return BEST_FOR[driver.id] ?? BEST_FOR_FALLBACK[driver.category];
}

/** What kind of 3D the driver produces, derived from its badges / result kind. */
export function outputKind(driver: Driver): I18nText {
  if (driver.badges.includes('full-3d')) {
    // In-browser multi-view fusion builds a vertex-coloured mesh; cloud models return a GLB.
    return driver.category === 'multiview'
      ? { tr: 'Tam 3D mesh (köşe renkli)', en: 'Full 3D mesh (vertex colours)' }
      : { tr: 'Tam 3D model (GLB)', en: 'Full 3D model (GLB)' };
  }
  if (!driver.producesDepth) return { tr: 'Kapalı katı gövde', en: 'Closed solid' };
  if (driver.badges.includes('closed-mesh')) return { tr: '2.5D gövde (kapatılabilir)', en: '2.5D body (closable)' };
  return { tr: '2.5D rölyef', en: '2.5D relief' };
}

/** Mesh mode applied once when the user switches to this driver (null = keep the current one). */
export function suggestedMeshMode(driver: Driver): MeshMode | null {
  if (driver.id === 'silhouette-inflate') return 'double';
  if (driver.category === 'ml') return driver.producesDepth ? 'relief' : null; // depth-volume builds its own closed geometry
  return null;
}

/** Drivers grouped by category in display order (empty groups dropped). */
export function groupDrivers(drivers: Driver[]): { category: DriverCategory; drivers: Driver[] }[] {
  return CATEGORY_ORDER.map((category) => ({ category, drivers: drivers.filter((d) => d.category === category) })).filter(
    (g) => g.drivers.length > 0,
  );
}
