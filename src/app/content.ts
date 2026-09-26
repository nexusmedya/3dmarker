/** Bilingual landing-page copy. */
import type { I18nText } from '../core/types';

export const HERO = {
  eyebrow: { tr: 'Tarayıcıda görselden tam 3D’ye', en: 'Image to full 3D in your browser' },
  title: {
    tr: 'Bir görsel yükleyin: stil verin, her yönünü tamamlayın, heykelleyin ve canlandırın.',
    en: 'Upload an image. Style it, complete every side, sculpt it and bring it to life.',
  },
  body: {
    tr: 'Tek görselden 2.5D kabartma, ön / arka / yan / üst / alt görünümlerden tam 3D model üretin. Yapay zekâ ile onlarca stil, T-poz ve eksik gövdeyi tamamlama; yüz ve ellerde ayrıntılı derinlik; Blender tarzı heykel ve derinlik düzenleme; otomatik iskelet ve 45 hazır animasyon. Sonucu GLB (animasyonlarıyla), OBJ, STL ya da PLY olarak indirin. Tarayıcı içi sürücüler görselinizi hiçbir yere yüklemez; AI sağlayıcıları için kendi anahtarınızı kullanırsınız.',
    en: 'Turn one image into a 2.5D relief, or front / back / side / top / bottom views into a full 3D model. AI restyling with dozens of styles, T-pose and body completion; detailed depth on faces and hands; Blender-style sculpting and depth editing; auto-rigging with 45 ready-made animations. Download GLB (with animations), OBJ, STL or PLY. In-browser drivers never upload your image; AI providers use your own keys.',
  },
  cta: { tr: 'Stüdyoyu aç', en: 'Open the studio' },
  secondary: { tr: 'Sürücüleri karşılaştır', en: 'Compare drivers' },
} satisfies Record<string, I18nText>;

export const HIGHLIGHTS: { title: I18nText; body: I18nText }[] = [
  {
    title: { tr: 'Gizlilik önce', en: 'Private by default' },
    body: {
      tr: 'Derinlik, sezgisel ve çok görünümlü sürücüler cihazınızda çalışır; AI anahtarları yalnızca bu tarayıcıda kalır.',
      en: 'Depth, heuristic and multi-view drivers run on your device; AI keys stay in this browser.',
    },
  },
  {
    title: { tr: 'Her yönden tam 3D', en: 'Full 3D from every side' },
    body: {
      tr: 'Arka, yan, üst ve alt görünümleri yükleyin ya da yapay zekâya ürettirin; siluetler ve derinlik kapalı, renkli bir modelde birleşir.',
      en: 'Upload the back, side, top and bottom views or let AI generate them; silhouettes and depth fuse into a closed, coloured model.',
    },
  },
  {
    title: { tr: 'Yapay zekâ hazırlığı', en: 'AI preparation' },
    body: {
      tr: '60 stil, T-poz, yalnızca baştan tam gövde ve saydam arka plan — OpenAI, Gemini, fal.ai ve diğerleriyle.',
      en: '60 styles, T-pose, a full body from just a head and transparent backgrounds — with OpenAI, Gemini, fal.ai and more.',
    },
  },
  {
    title: { tr: 'Yüz ve el detayı', en: 'Face & hand detail' },
    body: {
      tr: 'Yüz, el ve vücut noktaları algılanır; burun, dudak, göz çukuru, kulak ve parmaklar düz kalmaz.',
      en: 'Face, hand and body landmarks are detected, so noses, lips, eye sockets, ears and fingers no longer come out flat.',
    },
  },
  {
    title: { tr: 'Heykel ve derinlik editörü', en: 'Sculpt & depth editor' },
    body: {
      tr: 'Blender tarzı sekiz fırça, simetri ve geri alma; derinlik haritasını da fırçayla boyayın.',
      en: 'Eight Blender-style brushes with symmetry and undo; paint the depth map with brushes too.',
    },
  },
  {
    title: { tr: 'İskelet ve animasyon', en: 'Rig & animate' },
    body: {
      tr: 'Otomatik insansı iskelet, 45 hazır animasyon, BVH / FBX / GLB içe aktarma ve animasyonlu GLB.',
      en: 'Automatic humanoid skeleton, 45 built-in animations, BVH / FBX / GLB import and animated GLB export.',
    },
  },
];

export const STEPS: { title: I18nText; body: I18nText }[] = [
  {
    title: { tr: 'Görseli yükleyin', en: 'Upload an image' },
    body: {
      tr: 'PNG’yi sürükleyip bırakın, yapıştırın ya da bir örnek seçin. Saydam arka plan maske olur; düz ya da karmaşık arka planı otomatik veya yapay zekâ ile ayırın.',
      en: 'Drag & drop a PNG, paste it or pick a sample. A transparent background becomes the mask; plain or busy backgrounds are removed automatically or with AI.',
    },
  },
  {
    title: { tr: 'Yapay zekâ ile hazırlayın', en: 'Prepare with AI' },
    body: {
      tr: 'İsteğe bağlı: kendi sağlayıcınızı ekleyin, onlarca stilden birini seçin, kişiyi T-pozuna getirin ya da eksik gövdeyi tamamlatın; sonucu onaylayın veya orijinale dönün.',
      en: 'Optional: add your own provider, pick one of dozens of styles, re-pose a person into a T-pose or complete the missing body; accept the result or revert to the original.',
    },
  },
  {
    title: { tr: 'Görünümleri ekleyin', en: 'Add the views' },
    body: {
      tr: 'Tam 3D için arka, sol, sağ, üst ve alt görünümleri yükleyin ya da eksikleri yapay zekâya ön görünümden ürettirin.',
      en: 'For full 3D, upload the back, left, right, top and bottom views, or have AI generate the missing ones from the front.',
    },
  },
  {
    title: { tr: '3D’yi oluşturun', en: 'Generate the 3D' },
    body: {
      tr: 'Fotoğraflar için yapay zekâ derinliği (yüz ve el detayıyla), logolar için ekstrüzyon, karakterler için şişirme, tam 3D için çok görünümlü birleştirme ya da bulut modelleri. Mesh ayarları canlı değişir.',
      en: 'AI depth for photos (with face & hand detail), extrusion for logos, inflation for characters, multi-view fusion or cloud models for full 3D. Mesh settings update live.',
    },
  },
  {
    title: { tr: 'Düzenleyin', en: 'Edit' },
    body: {
      tr: 'Modeli Blender tarzı fırçalarla heykelleyin ya da derinlik haritasını boyayıp yeniden örün.',
      en: 'Sculpt the model with Blender-style brushes, or paint the depth map and rebuild.',
    },
  },
  {
    title: { tr: 'Canlandırın ve indirin', en: 'Animate and export' },
    body: {
      tr: 'İskelet ekleyin, hazır ya da içe aktarılan animasyonları oynatın; GLB’yi animasyonlarıyla, ya da OBJ / STL / PLY indirin.',
      en: 'Add a skeleton, play built-in or imported animations; download GLB with its animations, or OBJ / STL / PLY.',
    },
  },
];

export const FAQ: { q: I18nText; a: I18nText }[] = [
  {
    q: { tr: 'Görselim bir sunucuya yükleniyor mu?', en: 'Is my image uploaded anywhere?' },
    a: {
      tr: 'Yapay zekâ derinliği, sezgisel ve çok görünümlü sürücüler, heykel ve animasyon tamamen tarayıcınızda çalışır; görsel cihazınızdan çıkmaz. Yalnızca sizin başlattığınız yapay zekâ işleri (hazırlık, görünüm üretme, bulut 3D) görseli seçtiğiniz sağlayıcıya — doğrudan ya da sunucumuzun vekili üzerinden — gönderir.',
      en: 'The ML depth, heuristic and multi-view drivers, sculpting and animation run entirely in your browser; the image never leaves your device. Only AI jobs you start (preparation, view generation, cloud 3D) send it to the provider you chose — directly or through our server’s proxy.',
    },
  },
  {
    q: { tr: 'Yapay zekâ özellikleri için ne gerekir?', en: 'What do the AI features need?' },
    a: {
      tr: 'Üst çubuktaki “AI sağlayıcılar” penceresinden bir anahtar ekleyin: OpenAI, Google Gemini, Stability AI, Replicate, fal.ai, OpenAI uyumlu bir uç nokta ya da özel bir HTTP servisi; istediğiniz kadar sağlayıcı ve model tanımlanabilir. Anahtarlar yalnızca bu tarayıcıda kalır (“hatırla” açık değilse sekme kapanınca silinir). Tarayıcıdan doğrudan çağrılamayan servisler (Stability, Replicate, Tripo3D) sunucu vekili gerektirir; statik demoda OpenAI, Gemini ve fal.ai doğrudan çalışır.',
      en: 'Add a key in the “AI providers” dialog in the top bar: OpenAI, Google Gemini, Stability AI, Replicate, fal.ai, an OpenAI-compatible endpoint or a custom HTTP service; add as many providers and models as you like. Keys stay in this browser (gone when the tab closes unless you choose to remember them). Services that browsers cannot call directly (Stability, Replicate, Tripo3D) need the server proxy; on the static demo OpenAI, Gemini and fal.ai work directly.',
    },
  },
  {
    q: { tr: '2.5D derinlik ile tam 3D arasındaki fark nedir?', en: 'What is the difference between 2.5D depth and full 3D?' },
    a: {
      tr: 'Derinlik sürücüleri tek görselde her pikselin kameraya uzaklığını tahmin eder ve görünen yüzeyi kabartma olarak üretir; arka taraf tahmin edilmez (düz taban veya aynalı arka eklenebilir). Tam 3D için ön görünüme arka, yan, üst ve alt görünümleri ekleyin: çok görünümlü sürücü bunları tarayıcıda kapalı, renkli bir modelde birleştirir; bulut sürücüleri de görünmeyen yüzleri tamamlar.',
      en: 'Depth drivers estimate how far each pixel of one image is from the camera and build the visible surface as a relief; the back is not predicted (a flat base or mirrored back can be added). For full 3D, add back, side, top and bottom views to the front: the multi-view driver fuses them into a closed, coloured model in your browser, and cloud drivers also reconstruct the unseen sides.',
    },
  },
  {
    q: { tr: 'Tam 3D için hangi görünümler gerekir?', en: 'Which views does full 3D need?' },
    a: {
      tr: 'Ön görünüm ve en az bir ek görünüm; en iyisi arka, sol ve sağ (üst ve alt da yardımcı olur). Görünümler dik, ortalanmış ve aynı ölçekte olmalı. Elinizde yoksa yapay zekâ bunları ön görünümden üretebilir.',
      en: 'The front and at least one more view; back, left and right work best (top and bottom help too). Views should be upright, centred and at the same scale. If you have none, AI can generate them from the front.',
    },
  },
  {
    q: { tr: 'Yüzler neden artık düz çıkmıyor?', en: 'Why do faces no longer come out flat?' },
    a: {
      tr: 'Yapay zekâ derinlik sürücüleri görselde yüz, el ve vücut noktalarını (MediaPipe) algılar ve burun, dudak, göz çukuru, kulak ve parmaklara gerçek oranlarda kabartma ekler; istenirse yüz ve eller yakın planda yeniden işlenir. Kalan kısımları heykel fırçalarıyla elle belirginleştirebilirsiniz.',
      en: 'The ML depth drivers detect face, hand and body landmarks (MediaPipe) and add relief with true proportions to the nose, lips, eye sockets, ears and fingers; optionally faces and hands are re-processed in close-up. Bring out the rest by hand with the sculpt brushes.',
    },
  },
  {
    q: { tr: 'Modeli canlandırabilir miyim?', en: 'Can I animate the model?' },
    a: {
      tr: 'Evet. “Rig & Animasyon” adımı modele insansı bir iskelet (Mixamo kemik adları) ekler, eklemleri otomatik yerleştirir (kişi algılanırsa vücut noktalarıyla), deri ağırlıklarını hesaplar; 45 hazır animasyonu oynatır ve BVH / FBX / GLB animasyonlarını içe aktarır. Seçtiğiniz animasyonlar GLB’ye eklenir. En iyi sonuç T-pozundaki tam boy modellerle alınır — yapay zekâ hazırlığı T-pozu üretebilir.',
      en: 'Yes. The “Rig & animation” step adds a humanoid skeleton (Mixamo bone names), places the joints automatically (from body landmarks when a person is detected), computes skin weights, plays 45 built-in animations and imports BVH / FBX / GLB animations. The clips you pick are included in the GLB. Full-body models in a T-pose work best — the AI preparation can produce one.',
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
      tr: 'Yapay zekâ sürücüleri ilk kullanımda model ağırlıklarını (25–500 MB), insan algılama ise ~20 MB’lık modelleri indirir; tarayıcı bunları önbelleğe alır, sonraki çalıştırmalar hızlıdır.',
      en: 'ML drivers download their weights (25–500 MB) and human detection its ~20 MB of models on first use; the browser caches them so later runs are fast.',
    },
  },
  {
    q: { tr: 'Sonucu 3D yazıcıda basabilir miyim?', en: 'Can I 3D print the result?' },
    a: {
      tr: 'Evet: mesh tipini “Katı” ya da “Çift yüz” yapın, ekstrüzyon ya da çok görünümlü sürücüyü kullanın. “Watertight” rozeti kapalı bir mesh olduğunu gösterir; STL boyutunu mm olarak ayarlayıp indirin.',
      en: 'Yes: set the mesh type to “Solid” or “Double-sided”, or use the extrusion or multi-view driver. The “Watertight” badge confirms a closed mesh; set the STL size in mm and download.',
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
      { tr: 'Tüm tarayıcı içi sürücüler (yapay zekâ derinliği, sezgisel, çok görünümlü)', en: 'All in-browser drivers (ML depth, heuristic, multi-view)' },
      { tr: 'Heykel, derinlik editörü, iskelet ve 45 animasyon', en: 'Sculpting, depth editor, rigging and 45 animations' },
      { tr: 'Kendi AI anahtarınızla stil, T-poz ve gövde tamamlama', en: 'Styles, T-pose and body completion with your own AI key' },
      { tr: 'Sınırsız oluşturma, kayıt gerekmez', en: 'Unlimited generations, no sign-up' },
      { tr: 'GLB (animasyonlu), OBJ, STL, PLY dışa aktarma', en: 'GLB (animated), OBJ, STL, PLY export' },
    ],
    cta: { tr: 'Hemen başla', en: 'Start now' },
    highlighted: true,
  },
  {
    id: 'pro',
    name: { tr: 'Pro', en: 'Pro' },
    price: { tr: 'Yakında', en: 'Soon' },
    period: { tr: 'kredi paketleri', en: 'credit packs' },
    blurb: { tr: 'Anahtarsız yapay zekâ ve bulutta tam 3D.', en: 'AI without your own keys, full 3D in the cloud.' },
    features: [
      { tr: 'Yönetilen AI sağlayıcıları (anahtar gerekmez)', en: 'Managed AI providers (no keys needed)' },
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
  howSub: { tr: 'Altı adımda görselden animasyonlu modele.', en: 'From an image to an animated model in six steps.' },
  drivers: { tr: 'Sürücü karşılaştırması', en: 'Compare drivers' },
  driversSub: {
    tr: 'Her sürücü farklı bir yaklaşım kullanır; aynı görselle deneyip en iyisini seçin.',
    en: 'Each driver takes a different approach; try them on the same image and keep the best.',
  },
  pricing: { tr: 'Fiyatlandırma', en: 'Pricing' },
  pricingSub: { tr: 'Tarayıcı içi her şey ücretsiz.', en: 'Everything in the browser is free.' },
  faq: { tr: 'Sık sorulan sorular', en: 'Frequently asked questions' },
} satisfies Record<string, I18nText>;
