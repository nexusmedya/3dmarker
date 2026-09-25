/**
 * UI strings (Turkish + English). Driver-specific text comes from the
 * drivers themselves; long-form landing copy lives in content.ts.
 * Placeholders use {name} and are filled by `tx(text, lang, vars)`.
 */
import type { I18nText, Lang } from '../core/types';

export const LANGS: Lang[] = ['tr', 'en'];

export const UI = {
  appName: { tr: '3D Marker', en: '3D Marker' },
  tagline: { tr: 'Görselden 3D modele, tarayıcınızda', en: 'Image to 3D, right in your browser' },
  beta: { tr: 'beta', en: 'beta' },

  navStudio: { tr: 'Stüdyo', en: 'Studio' },
  navHow: { tr: 'Nasıl çalışır', en: 'How it works' },
  navDrivers: { tr: 'Sürücüler', en: 'Drivers' },
  navPricing: { tr: 'Fiyatlar', en: 'Pricing' },
  navFaq: { tr: 'SSS', en: 'FAQ' },
  switchLang: { tr: 'Switch to English', en: 'Türkçeye geç' },
  themeDark: { tr: 'Koyu temaya geç', en: 'Switch to dark theme' },
  themeLight: { tr: 'Açık temaya geç', en: 'Switch to light theme' },
  sourceCode: { tr: 'Kaynak kod', en: 'Source code' },

  // Upload
  imageTitle: { tr: 'Görsel', en: 'Image' },
  dropTitle: { tr: 'PNG sürükleyip bırakın', en: 'Drop a PNG here' },
  dropBody: { tr: 'ya da tıklayıp seçin · Ctrl+V ile yapıştırın', en: 'or click to browse · paste with Ctrl+V' },
  dropFormats: { tr: 'PNG, JPEG, WEBP · saydam PNG en iyi sonucu verir', en: 'PNG, JPEG, WEBP · transparent PNGs work best' },
  dropActive: { tr: 'Bırakın, yükleyelim', en: 'Release to upload' },
  chooseFile: { tr: 'Görsel seç', en: 'Choose image' },
  changeImage: { tr: 'Değiştir', en: 'Change' },
  removeImage: { tr: 'Görseli kaldır', en: 'Remove image' },
  readingImage: { tr: 'Görsel okunuyor…', en: 'Reading image…' },
  trySample: { tr: 'Ya da bir örnek deneyin', en: 'Or try a sample' },
  sampleWorksWith: { tr: 'Önerilen sürücü: {driver}', en: 'Works well with: {driver}' },
  showMask: { tr: 'Maskeyi göster', en: 'Show mask' },
  imageInfo: { tr: '{w} × {h} px', en: '{w} × {h} px' },
  foreground: { tr: 'Ön plan: %{pct}', en: 'Foreground: {pct}%' },
  previewAlt: { tr: 'Yüklenen görselin önizlemesi', en: 'Preview of the uploaded image' },

  // Background
  bgTitle: { tr: 'Arka plan', en: 'Background' },
  bgAuto: { tr: 'PNG saydamlığını kullan (otomatik)', en: 'Use PNG transparency (auto)' },
  bgBorder: { tr: 'Düz arka planı otomatik ayır', en: 'Auto from plain background' },
  bgAi: { tr: 'Yapay zekâ ile arka plan kaldır', en: 'AI background removal' },
  bgNone: { tr: 'Yok (tüm görsel)', en: 'None (full image)' },
  bgAutoNoAlpha: {
    tr: 'Görselde saydamlık yok; tüm görsel kullanılacak.',
    en: 'The image has no transparency; the whole image is used.',
  },
  bgBorderFail: {
    tr: 'Düz bir arka plan rengi bulunamadı; tüm görsel kullanılacak.',
    en: 'No plain background colour detected; the whole image is used.',
  },
  bgAiHint: {
    tr: 'Maske, Oluştur’a bastığınızda hesaplanır (ilk seferde ~25 MB model indirilir).',
    en: 'The mask is computed when you press Generate (downloads a ~25 MB model the first time).',
  },
  bgAiReady: { tr: 'Yapay zekâ maskesi hazır (önbellekte).', en: 'AI mask ready (cached).' },

  // Driver
  driverTitle: { tr: 'Sürücü', en: 'Driver' },
  driverHelp: {
    tr: 'Görseli 3D’ye çeviren yöntem. Farklı sürücüleri aynı görselle karşılaştırabilirsiniz.',
    en: 'The method that turns the image into 3D. Try several on the same image to compare.',
  },
  downloadSize: { tr: 'İlk kullanımda ~{mb} MB indirme', en: '~{mb} MB one-time download' },
  checking: { tr: 'Kontrol ediliyor…', en: 'Checking…' },
  ready: { tr: 'Hazır', en: 'Ready' },
  unavailable: { tr: 'Kullanılamıyor', en: 'Unavailable' },

  paramsTitle: { tr: 'Parametreler', en: 'Parameters' },
  meshTitle: { tr: 'Mesh', en: 'Mesh' },
  meshLive: { tr: 'Canlı', en: 'Live' },
  meshLiveHint: {
    tr: 'Mesh ayarları sürücüyü yeniden çalıştırmadan anında uygulanır',
    en: 'Mesh settings apply instantly without re-running the driver',
  },
  meshSuggested: { tr: 'Mesh tipi bu sürücü için “{mode}” olarak ayarlandı.', en: 'Mesh type set to “{mode}” for this driver.' },
  reset: { tr: 'Sıfırla', en: 'Reset' },
  noParams: { tr: 'Bu sürücünün ayarı yok.', en: 'This driver has no settings.' },
  show: { tr: 'Göster', en: 'Show' },
  hide: { tr: 'Gizle', en: 'Hide' },
  on: { tr: 'Açık', en: 'On' },
  off: { tr: 'Kapalı', en: 'Off' },

  generate: { tr: '3D Oluştur', en: 'Generate 3D' },
  regenerate: { tr: 'Yeniden oluştur', en: 'Regenerate' },
  generating: { tr: 'Oluşturuluyor…', en: 'Generating…' },
  cancel: { tr: 'İptal', en: 'Cancel' },
  cancelled: { tr: 'İşlem iptal edildi.', en: 'Cancelled.' },
  shortcutHint: { tr: 'Ctrl + Enter ile oluştur · Esc ile iptal', en: 'Ctrl + Enter to generate · Esc to cancel' },
  needImage: { tr: 'Önce bir görsel yükleyin', en: 'Upload an image first' },
  starting: { tr: 'Başlatılıyor…', en: 'Starting…' },
  loadingModule: { tr: 'Model yükleniyor…', en: 'Loading model…' },
  buildingMesh: { tr: 'Mesh oluşturuluyor…', en: 'Building mesh…' },
  loadingGlb: { tr: 'GLB modeli açılıyor…', en: 'Opening GLB model…' },
  elapsed: { tr: '{s} sn', en: '{s} s' },
  errorTitle: { tr: 'Oluşturma başarısız', en: 'Generation failed' },
  imageErrorTitle: { tr: 'Görsel yüklenemedi', en: 'Could not load the image' },
  dismiss: { tr: 'Kapat', en: 'Dismiss' },

  // Viewer
  viewerLabel: { tr: '3D görüntüleyici', en: '3D viewer' },
  viewerEmptyTitle: { tr: 'Modeliniz burada görünecek', en: 'Your model will appear here' },
  viewerEmptyBody: {
    tr: 'Bir görsel yükleyin, sürücü seçin ve “3D Oluştur”a basın.',
    en: 'Upload an image, pick a driver and press “Generate 3D”.',
  },
  noWebgl: {
    tr: 'Bu tarayıcıda WebGL kullanılamıyor; 3D önizleme gösterilemiyor.',
    en: 'WebGL is not available in this browser; the 3D preview cannot be shown.',
  },
  viewTexture: { tr: 'Doku', en: 'Texture' },
  viewWireframe: { tr: 'Tel kafes', en: 'Wireframe' },
  viewClay: { tr: 'Kil görünüm', en: 'Clay' },
  viewAutoRotate: { tr: 'Otomatik döndür', en: 'Auto-rotate' },
  viewReset: { tr: 'Görünümü sıfırla', en: 'Reset view' },
  viewBackground: { tr: 'Arka plan açık/koyu', en: 'Light/dark background' },
  viewDepth: { tr: 'Derinlik haritası', en: 'Depth map' },
  depthAlt: { tr: 'Derinlik haritası önizlemesi (açık = yakın)', en: 'Depth map preview (bright = near)' },
  controlsHint: { tr: 'Sürükle: döndür · Sağ tık: kaydır · Tekerlek: yakınlaş', en: 'Drag: orbit · Right-drag: pan · Wheel: zoom' },

  // Stats / export
  vertices: { tr: 'vertex', en: 'vertices' },
  triangles: { tr: 'üçgen', en: 'triangles' },
  watertight: { tr: 'Kapalı (watertight)', en: 'Watertight' },
  openMesh: { tr: 'Açık yüzey', en: 'Open surface' },
  watertightHint: {
    tr: 'Kapalı mesh’ler 3D baskıya hazırdır. Rölyef modu açık bir yüzey üretir; “Katı” modu kapalıdır.',
    en: 'Closed meshes are ready for 3D printing. Relief mode is an open surface; “Solid” mode is closed.',
  },
  exportTitle: { tr: 'Dışa aktar', en: 'Export' },
  exporting: { tr: 'Hazırlanıyor…', en: 'Preparing…' },
  exportFailed: { tr: 'Dışa aktarma başarısız: {msg}', en: 'Export failed: {msg}' },
  stlSize: { tr: 'STL boyutu (mm)', en: 'STL size (mm)' },
  stlSizeHint: {
    tr: 'Dilimleyiciler STL birimini mm okur; en uzun kenar bu boyutta olur.',
    en: 'Slicers read STL units as mm; the longest side gets this size.',
  },

  // Landing
  footerNote: {
    tr: 'three.js, transformers.js ve ONNX Runtime Web ile yapıldı. Tarayıcı içi sürücüler görselinizi hiçbir yere yüklemez.',
    en: 'Built with three.js, transformers.js and ONNX Runtime Web. In-browser drivers never upload your image.',
  },
  tryIt: { tr: 'Dene', en: 'Try it' },
  colDriver: { tr: 'Sürücü', en: 'Driver' },
  colCategory: { tr: 'Tür', en: 'Type' },
  colOutput: { tr: 'Çıktı', en: 'Output' },
  colBadges: { tr: 'Özellikler', en: 'Features' },
  colBestFor: { tr: 'En uygun', en: 'Best for' },
  colDownload: { tr: 'İndirme', en: 'Download' },
  none: { tr: 'Yok', en: 'None' },
} satisfies Record<string, I18nText>;

export type UIKey = keyof typeof UI;

/** Pick the language from navigator.language(s): Turkish if the first preferred language is Turkish, else English. */
export function detectLang(languages: readonly string[] | string | undefined): Lang {
  const list = typeof languages === 'string' ? [languages] : languages ?? [];
  const first = list.find((l) => typeof l === 'string' && l.length > 0);
  return first && first.toLowerCase().startsWith('tr') ? 'tr' : 'en';
}

/** Localise `text` and fill {placeholders}. */
export function tx(text: I18nText, lang: Lang, vars?: Record<string, string | number>): string {
  const s = text[lang] ?? text.en;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Localised UI string by key. */
export function t(key: UIKey, lang: Lang, vars?: Record<string, string | number>): string {
  return tx(UI[key], lang, vars);
}

/** Locale-aware integer formatting (1.234.567 / 1,234,567). */
export function formatInt(n: number, lang: Lang): string {
  return Math.round(n).toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-US');
}
