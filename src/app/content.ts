/** Bilingual landing-page copy. */
import type { I18nText } from '../core/types';

export const HERO = {
  eyebrow: { tr: 'Tarayıcıda görselden 3D’ye', en: 'Image to 3D in your browser' },
  title: {
    tr: 'Bir PNG yükleyin, saniyeler içinde 3D modeliniz hazır.',
    en: 'Upload a PNG. Get a 3D model in seconds.',
  },
  body: {
    tr: 'Yapay zekâ derinlik tahmini, siluet şişirme ve ekstrüzyon gibi farklı sürücüleri aynı görsel üzerinde deneyin; sonucu GLB, OBJ, STL ya da PLY olarak indirin. Tarayıcı içi sürücüler görselinizi hiçbir sunucuya yüklemez.',
    en: 'Try different drivers — AI depth estimation, silhouette inflation, extrusion and more — on the same image, then download GLB, OBJ, STL or PLY. In-browser drivers never upload your image to any server.',
  },
  cta: { tr: 'Stüdyoyu aç', en: 'Open the studio' },
  secondary: { tr: 'Sürücüleri karşılaştır', en: 'Compare drivers' },
} satisfies Record<string, I18nText>;

export const HIGHLIGHTS: { title: I18nText; body: I18nText }[] = [
  {
    title: { tr: 'Gizlilik önce', en: 'Private by default' },
    body: { tr: 'Model ağırlıkları bir kez indirilir, çıkarım cihazınızda çalışır.', en: 'Weights download once; inference runs on your device.' },
  },
  {
    title: { tr: 'WebGPU hızında', en: 'WebGPU fast' },
    body: { tr: 'WebGPU varsa GPU’da, yoksa WASM ile CPU’da çalışır.', en: 'Runs on the GPU with WebGPU, falls back to WASM on the CPU.' },
  },
  {
    title: { tr: 'Baskıya hazır', en: 'Print-ready' },
    body: { tr: 'Katı mod ve ekstrüzyon kapalı (watertight) mesh üretir.', en: 'Solid mode and extrusion produce watertight meshes.' },
  },
];

export const STEPS: { title: I18nText; body: I18nText }[] = [
  {
    title: { tr: 'Görseli yükleyin', en: 'Upload an image' },
    body: {
      tr: 'PNG’yi sürükleyip bırakın, yapıştırın ya da bir örnek seçin. Saydam arka plan varsa otomatik olarak maske olarak kullanılır.',
      en: 'Drag & drop a PNG, paste it or pick a sample. A transparent background is used as the mask automatically.',
    },
  },
  {
    title: { tr: 'Sürücüyü seçin', en: 'Pick a driver' },
    body: {
      tr: 'Fotoğraflar için yapay zekâ derinliği, logolar için ekstrüzyon, karakterler için şişirme… Parametreleri ayarlayın.',
      en: 'AI depth for photos, extrusion for logos, inflation for characters… then tune the parameters.',
    },
  },
  {
    title: { tr: 'Görüntüleyin ve indirin', en: 'Inspect and export' },
    body: {
      tr: 'Modeli döndürün, kil ya da tel kafes görünümüyle inceleyin, mesh ayarlarını canlı değiştirin ve GLB/OBJ/STL/PLY indirin.',
      en: 'Orbit the model, check it in clay or wireframe, tweak the mesh live and download GLB/OBJ/STL/PLY.',
    },
  },
];

export const FAQ: { q: I18nText; a: I18nText }[] = [
  {
    q: { tr: 'Görselim bir sunucuya yükleniyor mu?', en: 'Is my image uploaded anywhere?' },
    a: {
      tr: 'Yapay zekâ ve sezgisel sürücüler tamamen tarayıcınızda çalışır; görsel cihazınızdan çıkmaz. Yalnızca bulut sürücüsü (Tripo3D) görseli sunucumuz üzerinden Tripo3D API’sine gönderir.',
      en: 'The ML and heuristic drivers run entirely in your browser; the image never leaves your device. Only the cloud driver (Tripo3D) sends it to the Tripo3D API through our server.',
    },
  },
  {
    q: { tr: '2.5D derinlik ile tam 3D arasındaki fark nedir?', en: 'What is the difference between 2.5D depth and full 3D?' },
    a: {
      tr: 'Derinlik sürücüleri her pikselin kameraya uzaklığını tahmin eder ve görünen yüzeyi kabartma olarak üretir; arka taraf tahmin edilmez (düz taban veya aynalı arka eklenebilir). Bulut sürücüsü ise görünmeyen yüzleri de tamamlanmış tam bir model döndürür.',
      en: 'Depth drivers estimate how far each pixel is from the camera and build the visible surface as a relief; the back is not predicted (a flat base or mirrored back can be added). The cloud driver returns a complete model with the unseen sides reconstructed.',
    },
  },
  {
    q: { tr: 'Hangi görseller en iyi sonucu verir?', en: 'Which images work best?' },
    a: {
      tr: 'Tek bir nesnenin ortalandığı, saydam ya da düz arka planlı görseller. Fotoğraflarda iyi aydınlatma ve belirgin ön/arka plan derinliği yardımcı olur.',
      en: 'A single, centred object on a transparent or plain background. For photos, good lighting and clear foreground/background separation help.',
    },
  },
  {
    q: { tr: 'İlk çalıştırma neden daha uzun sürüyor?', en: 'Why is the first run slower?' },
    a: {
      tr: 'Yapay zekâ sürücüleri ilk kullanımda model ağırlıklarını (25–500 MB) indirir; tarayıcı bunları önbelleğe alır, sonraki çalıştırmalar hızlıdır.',
      en: 'ML drivers download their weights (25–500 MB) on first use; the browser caches them so later runs are fast.',
    },
  },
  {
    q: { tr: 'Sonucu 3D yazıcıda basabilir miyim?', en: 'Can I 3D print the result?' },
    a: {
      tr: 'Evet: mesh tipini “Katı” ya da “Çift yüz” yapın veya ekstrüzyon sürücüsünü kullanın. “Watertight” rozeti kapalı bir mesh olduğunu gösterir; STL boyutunu mm olarak ayarlayıp indirin.',
      en: 'Yes: set the mesh type to “Solid” or “Double-sided”, or use the extrusion driver. The “Watertight” badge confirms a closed mesh; set the STL size in mm and download.',
    },
  },
  {
    q: { tr: 'Hangi tarayıcılar destekleniyor?', en: 'Which browsers are supported?' },
    a: {
      tr: 'Güncel Chrome, Edge, Firefox ve Safari. WebGPU destekleyen tarayıcılarda yapay zekâ sürücüleri belirgin şekilde daha hızlıdır.',
      en: 'Current Chrome, Edge, Firefox and Safari. ML drivers are much faster in browsers with WebGPU.',
    },
  },
];

export interface Plan {
  id: string;
  name: I18nText;
  price: I18nText;
  period: I18nText;
  blurb: I18nText;
  features: I18nText[];
  cta: I18nText;
  highlighted?: boolean;
  comingSoon?: boolean;
}

export const PLANS: Plan[] = [
  {
    id: 'free',
    name: { tr: 'Ücretsiz', en: 'Free' },
    price: { tr: '₺0', en: '$0' },
    period: { tr: 'her zaman', en: 'forever' },
    blurb: { tr: 'Tarayıcıda çalışan her şey, sınırsız.', en: 'Everything that runs in your browser, unlimited.' },
    features: [
      { tr: 'Tüm tarayıcı içi sürücüler (yapay zekâ + sezgisel)', en: 'All in-browser drivers (ML + heuristic)' },
      { tr: 'Sınırsız oluşturma, kayıt gerekmez', en: 'Unlimited generations, no sign-up' },
      { tr: 'GLB, OBJ, STL, PLY dışa aktarma', en: 'GLB, OBJ, STL, PLY export' },
      { tr: 'Görseller cihazınızdan çıkmaz', en: 'Images never leave your device' },
    ],
    cta: { tr: 'Hemen başla', en: 'Start now' },
    highlighted: true,
  },
  {
    id: 'pro',
    name: { tr: 'Pro', en: 'Pro' },
    price: { tr: 'Yakında', en: 'Soon' },
    period: { tr: 'kredi paketleri', en: 'credit packs' },
    blurb: { tr: 'Bulutta tam 3D model üretimi.', en: 'Full 3D generation in the cloud.' },
    features: [
      { tr: 'Tam 3D bulut kredileri (Tripo3D)', en: 'Full-3D cloud credits (Tripo3D)' },
      { tr: 'Dokulu, PBR malzemeli GLB', en: 'Textured GLB with PBR materials' },
      { tr: 'Öncelikli kuyruk', en: 'Priority queue' },
      { tr: 'Ticari kullanım', en: 'Commercial use' },
    ],
    cta: { tr: 'Çok yakında', en: 'Coming soon' },
    comingSoon: true,
  },
];

export const SECTION_TITLES = {
  how: { tr: 'Nasıl çalışır', en: 'How it works' },
  howSub: { tr: 'Üç adımda görselden modele.', en: 'From image to model in three steps.' },
  drivers: { tr: 'Sürücü karşılaştırması', en: 'Compare drivers' },
  driversSub: {
    tr: 'Her sürücü farklı bir yaklaşım kullanır; aynı görselle deneyip en iyisini seçin.',
    en: 'Each driver takes a different approach; try them on the same image and keep the best.',
  },
  pricing: { tr: 'Fiyatlandırma', en: 'Pricing' },
  pricingSub: { tr: 'Tarayıcı içi her şey ücretsiz.', en: 'Everything in the browser is free.' },
  faq: { tr: 'Sık sorulan sorular', en: 'Frequently asked questions' },
} satisfies Record<string, I18nText>;
