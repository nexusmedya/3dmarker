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
  docTitle: { tr: '3D Marker — Görselden 3D', en: '3D Marker — Image to 3D' },
  beta: { tr: 'beta', en: 'beta' },

  navLabel: { tr: 'Ana gezinme', en: 'Primary' },
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
  bgAuto: { tr: 'Otomatik (saydamlık ya da düz arka plan)', en: 'Auto (transparency or plain background)' },
  bgBorder: { tr: 'Düz arka planı otomatik ayır', en: 'Auto from plain background' },
  bgAi: { tr: 'Yapay zekâ ile arka plan kaldır', en: 'AI background removal' },
  bgNone: { tr: 'Yok (tüm görsel)', en: 'None (full image)' },
  bgAutoNoAlpha: {
    tr: 'Saydamlık ya da düz arka plan bulunamadı; tüm görsel kullanılacak. Yapay zekâ ile arka plan kaldırmayı deneyin.',
    en: 'No transparency or plain background found; the whole image is used. Try AI background removal.',
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
  meshPending: {
    tr: 'Mesh tipi bir sonraki oluşturmada bu sürücü için “{mode}” olarak ayarlanacak.',
    en: 'Mesh type will be set to “{mode}” for this driver on the next generation.',
  },
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
  percent: { tr: '%{pct}', en: '{pct}%' },
  elapsed: { tr: '{s} sn', en: '{s} s' },
  errorTitle: { tr: 'Oluşturma başarısız', en: 'Generation failed' },
  imageErrorTitle: { tr: 'Görsel yüklenemedi', en: 'Could not load the image' },
  dismiss: { tr: 'Kapat', en: 'Dismiss' },
  errorDetails: { tr: 'Ayrıntılar', en: 'Details' },
  tryOfflineDriver: { tr: '{driver} ile dene', en: 'Try {driver}' },

  // Viewer
  viewerLabel: { tr: '3D görüntüleyici', en: '3D viewer' },
  viewerEmptyTitle: { tr: 'Modeliniz burada görünecek', en: 'Your model will appear here' },
  viewerEmptyBody: {
    tr: 'Bir görsel yükleyin, sürücü seçin ve “3D Oluştur”a basın.',
    en: 'Upload an image, pick a driver and press “Generate 3D”.',
  },
  viewerReadyBody: {
    tr: 'Görsel yüklendi — adımları tamamlayıp “3D Oluştur”a basın.',
    en: 'Image loaded — finish the steps and press “Generate 3D”.',
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
  viewPresets: { tr: 'Hazır bakış açıları', en: 'Camera presets' },
  viewFront: { tr: 'Önden', en: 'Front' },
  viewBack: { tr: 'Arkadan', en: 'Back' },
  viewLeft: { tr: 'Soldan', en: 'Left' },
  viewRight: { tr: 'Sağdan', en: 'Right' },
  viewTop: { tr: 'Üstten', en: 'Top' },
  viewBackground: { tr: 'Arka plan açık/koyu', en: 'Light/dark background' },
  viewDepth: { tr: 'Derinlik haritası', en: 'Depth map' },
  depthAlt: { tr: 'Derinlik haritası önizlemesi (açık = yakın)', en: 'Depth map preview (bright = near)' },
  controlsHint: { tr: 'Sürükle: döndür · Sağ tık: kaydır · Tekerlek: yakınlaş', en: 'Drag: orbit · Right-drag: pan · Wheel: zoom' },

  // Stats / export
  vertices: { tr: 'köşe', en: 'vertices' },
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

  // Step navigator
  stepsLabel: { tr: 'Stüdyo adımları', en: 'Studio steps' },
  stepImage: { tr: 'Görsel', en: 'Image' },
  stepPrep: { tr: 'AI hazırlık', en: 'AI prep' },
  stepViews: { tr: 'Görünümler', en: 'Views' },
  step3d: { tr: '3D', en: '3D' },
  stepEdit: { tr: 'Düzenle', en: 'Edit' },
  stepRig: { tr: 'Rig & Anim', en: 'Rig & anim' },
  stepImageTitle: { tr: 'Görsel ve arka plan', en: 'Image & background' },
  stepPrepTitle: { tr: 'Yapay zekâ hazırlığı', en: 'AI preparation' },
  stepViewsTitle: { tr: 'Görünümler (tam 3D)', en: 'Views (full 3D)' },
  step3dTitle: { tr: '3D oluşturma', en: '3D generation' },
  stepEditTitle: { tr: 'Düzenle: heykel ve derinlik', en: 'Edit: sculpt & depth' },
  stepRigTitle: { tr: 'Rig ve animasyon', en: 'Rig & animation' },
  stepNumber: { tr: '{n}. adım', en: 'Step {n}' },
  stepNext: { tr: 'Sonraki: {step}', en: 'Next: {step}' },
  stepBack: { tr: 'Geri: {step}', en: 'Back: {step}' },
  hintTodo: { tr: 'Bekliyor', en: 'To do' },
  hintLoading: { tr: 'Okunuyor…', en: 'Reading…' },
  hintLoaded: { tr: 'Yüklendi', en: 'Loaded' },
  hintWorking: { tr: 'Çalışıyor…', en: 'Working…' },
  hintReview: { tr: 'Onaylayın', en: 'To review' },
  hintPrepared: { tr: 'Hazırlandı', en: 'Prepared' },
  hintOptional: { tr: 'İsteğe bağlı', en: 'Optional' },
  hintViews: { tr: '{n}/6 görünüm', en: '{n}/6 views' },
  hintModel: { tr: 'Hazır', en: 'Ready' },
  hintSculpted: { tr: 'Düzenlendi', en: 'Sculpted' },
  hintRigged: { tr: 'Kemikli', en: 'Rigged' },
  hintNeedsModel: { tr: 'Model yok', en: 'No model' },

  // AI providers / jobs
  aiProviders: { tr: 'AI sağlayıcılar', en: 'AI providers' },
  aiProvidersCount: { tr: '{n} etkin AI sağlayıcısı', en: '{n} enabled AI providers' },
  aiNoProviders: {
    tr: 'Henüz bir AI sağlayıcısı eklenmedi (OpenAI, Gemini, fal.ai…).',
    en: 'No AI provider has been added yet (OpenAI, Gemini, fal.ai…).',
  },
  aiNoEditProvider: {
    tr: 'Görsel düzenleyebilen, kullanılabilir bir AI sağlayıcısı yok.',
    en: 'No usable AI provider that can edit images.',
  },
  aiNothingToDo: {
    tr: 'Bir stil, T-poz, tamamlama ya da arka plan kaldırma seçin veya talimat yazın.',
    en: 'Pick a style, T-pose, completion or background removal, or write instructions.',
  },
  aiNoViewProvider: {
    tr: 'Seçili sağlayıcı kompozisyonu korur ve yeni görünüm üretemez (ör. Stability); görünümler için OpenAI, Gemini, fal.ai… gibi bir görsel düzenleme sağlayıcısı ekleyin.',
    en: 'The chosen provider keeps the composition and cannot render new views (e.g. Stability); add an image-edit provider such as OpenAI, Gemini or fal.ai for the views.',
  },
  detectingPeople: { tr: 'İnsan algılanıyor…', en: 'Detecting people…' },
  removingViewBg: { tr: 'Görünümün arka planı kaldırılıyor…', en: 'Removing the view’s background…' },
  preparedInUse: { tr: 'Yapay zekâ ile hazırlanan görsel kullanılıyor.', en: 'Using the AI-prepared image.' },
  revertOriginal: { tr: 'Orijinale dön', en: 'Revert to original' },
  revertConfirm: {
    tr: 'Orijinale dönülürse yapay zekâ ile hazırlanan görsel ve ondan üretilen {n} görünüm kaldırılır (yüklediğiniz görünümler kalır). Devam edilsin mi?',
    en: 'Reverting removes the AI-prepared image and the {n} views generated from it (uploaded views stay). Continue?',
  },
  revertKeep: { tr: 'Vazgeç', en: 'Cancel' },
  originalInUse: { tr: 'Orijinal görsel kullanılıyor.', en: 'Using the original image.' },
  restorePrepared: { tr: 'Yapay zekâ görseline dön', en: 'Back to the AI image' },
  restorePreparedViews: { tr: 'Yapay zekâ görseline dön (+{n} görünüm)', en: 'Back to the AI image (+{n} views)' },

  // Generate guards
  blockedAiBusy: { tr: 'Yapay zekâ işi bitince oluşturabilirsiniz.', en: 'Wait for the AI job to finish.' },
  needAnyView: {
    tr: 'Bu sürücü en az bir ek görünüm ister (arka, sol, sağ, üst ya da alt).',
    en: 'This driver needs at least one more view (back, left, right, top or bottom).',
  },
  needViews: { tr: 'Bu sürücü şu görünümleri de ister: {views}.', en: 'This driver also needs these views: {views}.' },
  goToViews: { tr: 'Görünümlere git', en: 'Go to Views' },
  goToImage: { tr: 'Görsele git', en: 'Go to Image' },
  viewsUnused: {
    tr: 'Bu sürücü {n} ek görünümünüzü kullanmaz: yalnızca ön görselden üretir.',
    en: 'This driver does not use your {n} extra views: it builds from the front image only.',
  },
  useFusion: { tr: 'Çok görünümlü birleştirmeye geç', en: 'Switch to multi-view fusion' },
  regenDiscardsSculpt: { tr: 'Yeniden oluşturmak heykel düzenlemelerinizi atar.', en: 'Regenerating discards your sculpt edits.' },
  regenDiscardsRig: { tr: 'Yeniden oluşturmak kemikleri ve animasyonları atar.', en: 'Regenerating discards the rig and its animations.' },
  regenDiscardsDepth: { tr: 'Yeniden oluşturmak derinlik haritası düzenlemenizi atar.', en: 'Regenerating discards your depth map edit.' },
  regenAnyway: { tr: 'Yine de oluştur', en: 'Regenerate anyway' },
  keepEdits: { tr: 'Vazgeç', en: 'Keep my edits' },
  generateWith: { tr: 'Sürücü: {driver}', en: 'Driver: {driver}' },
  changeDriver: { tr: 'Değiştir', en: 'Change' },

  // Human detail (step 3D)
  humanTitle: { tr: 'İnsan detayı', en: 'Human detail' },
  humanAnalyzing: { tr: 'İnsan algılanıyor…', en: 'Detecting people…' },
  humanDetected: { tr: 'İnsan algılandı', en: 'Person detected' },
  humanDetectedBody: {
    tr: 'Yüz, burun, dudak, kulak, el ve parmaklara ayrıntılı kabartma eklenir.',
    en: 'Detailed relief is added to the face, nose, lips, ears, hands and fingers.',
  },
  humanCounts: { tr: '{f} yüz · {h} el · {p} gövde', en: '{f} face(s) · {h} hand(s) · {p} body(ies)' },
  humanNone: { tr: 'İnsan algılanmadı', en: 'No person detected' },
  humanNoneBody: { tr: 'Derinlik olduğu gibi kullanılır.', en: 'The depth is used as is.' },
  humanUnavailable: { tr: 'Algılama kullanılamıyor', en: 'Detection unavailable' },
  humanPending: {
    tr: 'Yüz, el ve vücut noktaları oluştururken algılanır (MediaPipe, ilk seferde ~20 MB).',
    en: 'Face, hand and body landmarks are detected when you generate (MediaPipe, ~20 MB the first time).',
  },
  humanDetectNow: { tr: 'Şimdi algıla', en: 'Detect now' },
  humanOff: { tr: 'İnsan detayı kapalı (parametrelerden açılır).', en: 'Human detail is off (turn it on in the parameters).' },

  // Mesh / sculpt / rig interplay
  remeshPausedSculpt: {
    tr: 'Model heykelle düzenlendi; mesh ayarları canlı uygulanmıyor.',
    en: 'The model was sculpted; mesh settings are not applied live.',
  },
  remeshPausedActive: {
    tr: 'Heykel modu açıkken mesh ayarları uygulanmaz.',
    en: 'Mesh settings wait while sculpt mode is on.',
  },
  remeshPausedRig: {
    tr: 'Model kemikli; mesh ayarları canlı uygulanmıyor (önce kemikleri kaldırın).',
    en: 'The model is rigged; mesh settings are not applied live (remove the rig first).',
  },
  discardEdits: { tr: 'Düzenlemeleri at', en: 'Discard edits' },
  discardEditsHint: {
    tr: 'Heykel düzenlemelerini atar ve yüzeyi önbellekteki derinlikten yeniden örer.',
    en: 'Throws the sculpt edits away and rebuilds the surface from the cached depth.',
  },
  sculptBlockedRig: { tr: 'Kemikli modelde heykel kapalı; önce kemikleri kaldırın.', en: 'Sculpting is off for a rigged model; remove the rig first.' },
  rigBlockedSculpt: { tr: 'Heykel modu açıkken kemik eklenemez.', en: 'Rigging waits while sculpt mode is on.' },
  depthEditTitle: { tr: 'Derinlik haritası', en: 'Depth map' },
  depthEditBody: {
    tr: 'Derinliği Blender tarzı fırçalarla boyayın; model yeni derinlikten yeniden örülür ve mesh ayarları canlı kalır.',
    en: 'Paint the depth with Blender-style brushes; the model is rebuilt from the new depth and the mesh settings stay live.',
  },
  depthEditOpen: { tr: 'Derinlik haritasını düzenle', en: 'Edit depth map' },
  depthEditNeedsDepth: {
    tr: 'Yalnızca derinlik üreten sürücülerin sonuçlarında (yapay zekâ derinliği, şişirme, parlaklık).',
    en: 'Only for results of depth drivers (ML depth, inflate, luminance).',
  },
  depthEditRigged: { tr: 'Kemikli modelin derinliği düzenlenemez; önce kemikleri kaldırın.', en: 'Remove the rig before editing the depth.' },
  depthEditSculpted: { tr: 'Uygulamak heykel düzenlemelerini atar.', en: 'Applying discards the sculpt edits.' },

  // Multi-view fusion report (step 3D)
  fusionReport: { tr: 'Birleştirme raporu', en: 'Fusion report' },
  fusionColorOnly: { tr: 'yalnız renk', en: 'colour only' },
  fusionOff: { tr: 'kapalı', en: 'off' },

  // Export
  exportAnimations: { tr: 'GLB {n} animasyon içerir', en: 'GLB includes {n} animations' },
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
