# 3D Marker — Görselden 3D'ye (tarayıcıda)

> **English summary.** 3D Marker is a browser-based image-to-3D SaaS prototype (in the spirit of tripo3d.ai).
> A six-step studio: **1** upload an image or pick a sample (which also selects its driver; the "auto" background uses PNG
> alpha, else a plain border colour; an in-browser AI matte is optional) →
> **2** optional AI preparation with your own provider keys (60 style presets, T-pose, completing a cropped body,
> transparent background) → **3** the other views (back / left / right / top / bottom), uploaded or AI-generated →
> **4** a *driver* turns them into a mesh: in-browser depth models (Depth Anything V2, MiDaS; faces, noses, lips,
> ears, hands and fingers get extra relief from MediaPipe landmarks), instant heuristics, **multi-view fusion**
> (a closed, vertex-coloured full-3D mesh from several views, entirely in the browser; hand-made views are registered
> to the front by their silhouette profiles, cropped edges are detected and thin parts such as T-pose arms are
> guarded, with a per-view consistency badge, an Align panel, trust modes and a "copy prompt"; wrong-slot, duplicate,
> mirrored and featureless views are flagged as poor; colours are exposure-matched per view and chosen by a visibility-checked
> vote so side views no longer bleed onto arms and hands; fusion and skin weighting run in a Web Worker so the page stays
> responsive) or cloud models (Tripo3D,
> Tripo multi-view, any image-to-3D model of a provider you added) → **5** Blender-style sculpting on the mesh and a
> depth-map painter → **6** automatic humanoid rig (Mixamo bone names), 45 built-in animations, BVH / FBX / GLB
> import, animated GLB export (OBJ / STL / PLY too). AI providers are a dynamic list (OpenAI, Gemini, Stability,
> Replicate, fal.ai, Tripo3D, OpenAI-compatible, custom HTTP; any number of entries, keys stay in the browser or on
> the server). The static GitHub Pages demo runs everything except the server-proxied providers.
> Stack: Vite + React 19 + TypeScript, three.js (+ three-mesh-bvh), @huggingface/transformers, MediaPipe Tasks
> Vision, Hono. `npm ci --ignore-scripts && npm run dev`.

---

## Nedir?

3D Marker, bir PNG'yi (veya JPEG/WEBP) **tarayıcının içinde** 3B modele çeviren bir SaaS prototipidir.
Stüdyo altı adımdan oluşur (sol paneldeki numaralı sekmeler; klavyeyle ←/→, Home/End):

| Adım | Ne yapar |
|---|---|
| **1 Görsel** | Görsel yükleme / yapıştırma / örnekler (her örnek kendi önerilen sürücüsünü seçer); arka plan: **otomatik** (PNG alfa, yoksa düz kenar rengi — beyaz / düz fonlu JPEG'ler de kesilir), düz kenar rengi, yapay zekâ (MODNet) ya da yok |
| **2 AI hazırlık** (isteğe bağlı) | Kendi sağlayıcınızla görseli **60 stilden** birine çevirme, **T-poz**, **eksik gövdeyi tamamlama** (ör. yalnızca kafa → tam boy), saydam arka plan; önce/sonra karşılaştırma, kabul et / vazgeç / orijinale dön |
| **3 Görünümler** | Tam 3B için **arka, sol, sağ, üst, alt** görünümler: elle yükleyin ya da yapay zekâya ürettirin ("Eksikleri üret") |
| **4 3D** | Sürücü seçimi, parametreler, canlı mesh ayarları; "3D Oluştur" her adımdan erişilebilir (Ctrl/⌘ + Enter; heykel modunda ve metin alanlarında devre dışı). Heykel / rig / derinlik düzenlemesi taşıyan modeli yeniden oluşturmadan önce onay istenir |
| **5 Düzenle** | Blender tarzı **heykel** fırçaları (8 fırça, simetri, geri al) ve **derinlik haritası editörü** |
| **6 Rig & Anim** | Otomatik insansı iskelet, eklem düzenleyici, **45 hazır animasyon**, BVH / FBX / GLB içe aktarma, animasyonlu GLB |

- Yapay zekâ derinlik modelleri (Depth Anything V2, MiDaS) ve insan algılama (MediaPipe) **kullanıcının tarayıcısında** çalışır; sunucuya görsel gitmez.
- **İnsan detayı:** yüz (478 nokta), eller (21 nokta) ve vücut (33 nokta) algılanır; burun, göz çukurları, dudaklar, çene, kulaklar, parmaklar ve kollar derinlik haritasına ek kabartma olarak eklenir — yüzler artık dümdüz çıkmaz.
- **Çok görünümlü füzyon** (`multiview-fusion`): ön + diğer görünümlerden kapalı (watertight), köşe renkli tam 3B mesh — tamamen tarayıcıda.
  Elle yüklenen / başka araçta üretilen görünümler ön görünüme **otomatik hizalanır** (ölçek, kayma, kenarda kesik çerçeve),
  ince parçalar (T-pozdaki kollar) korunur; her görünüm için **tutarlılık rozeti**, **Hizala** paneli, güven modu
  ("Şekil + renk" / "Yalnız renk" / "Kapalı") ve **İstemi kopyala** vardır. Yanlış yuvaya konmuş, ön görselin kopyası,
  ters yöne bakan ya da ayrıntısız görünümler "zayıf" puan alır ve raporda ne yapılacağı söylenir. Renkler görünüm başına
  pozlama eşitlenerek ve görünürlük kontrollü oylamayla seçilir (yan görünüm renkleri kollara / ellere taşmaz). Füzyon ve
  deri ağırlıklandırma ayrı bir **Web Worker**'da çalışır: sayfa bu sırada donmaz, İptal hemen etkilidir.
- **Yapay zekâ sağlayıcıları** dinamik bir listedir: istediğiniz kadar sağlayıcı / anahtar / model ekleyin (OpenAI, Google Gemini, Stability AI, Replicate, fal.ai, Tripo3D, OpenAI uyumlu, özel HTTP). Anahtarlar tarayıcıda kalır ya da sunucuda tutulur.
- Arayüz Türkçe ve İngilizce; açık/koyu tema; ayarlar tarayıcıda saklanır (gizli anahtarlar yalnızca "hatırla" açıksa).

## Mimari

```
┌──────────────────────────────────── Tarayıcı ─────────────────────────────────────┐
│ 1 Görsel ─► loadImageFile ─► fitRGBA (≤1024 px) ─► maske (alfa │ kenar │ MODNet)    │
│      │                                                                            │
│ 2 AI hazırlık ─┐   src/ai: PROVIDER_KINDS + adapters (openai, gemini, stability,   │
│ 3 Görünümler ──┤   replicate, fal, tripo, openai-compatible, custom-http),         │
│                │   prompts + 60 styles, generate.ts (prepareFrontImage,            │
│                │   generateViewImage, ensureTransparent)                           │
│                ▼          │ doğrudan (CORS) ────────────────► sağlayıcı API'si      │
│   ViewSet {front, back,   │ ya da /api/ai/proxy/<kind>/… ──► Hono sunucusu          │
│   left, right, top,       │                                                        │
│   bottom} + params        ▼                                                        │
│ 4 ┌──────────────── DRIVERS (src/drivers, açılır liste) ──────────────────────┐    │
│   │ ML (Web Worker)       │ Sezgisel        │ Çok görünüm       │ Bulut          │    │
│   │ transformers.js + ORT │ inflate/extrude │ multiview-fusion  │ tripo3d-cloud  │    │
│   │ + insan detayı        │ /luminance      │ (src/core/fusion: │ tripo3d-multi  │    │
│   │ (src/core/human,      │                 │ görsel gövde +    │ ai-provider-3d │    │
│   │ MediaPipe)            │                 │ derinlik oyma +   │                │    │
│   │                       │                 │ marching cubes)   │                │    │
│   └───────┬───────────────┴────────┬────────┴─────────┬─────────┴───────┬────────┘    │
│      {kind:'depth'}          {kind:'geometry'}   (color attr.)   {kind:'model'} GLB  │
│   buildGeometryFromDepth           │                               GLTFLoader        │
│           └───────────────┬────────┴───────────────────────────────────┘            │
│                           ▼                                                         │
│   ViewerCore (three.js; kil/tel kafes; overlay, frame listener, rescanObject)       │
│ 5    ├─ SculptSession (src/sculpt, three-mesh-bvh)  · DepthMapEditor → yeni derinlik │
│ 6    └─ rigModel / AnimationPlayer (src/rig: iskelet, deri ağırlıkları, 45 klip,     │
│         BVH/FBX/GLB içe aktarma + yeniden hedefleme)                                │
│                           ▼                                                         │
│   exportObject → GLB (deri + animasyonlar) │ OBJ │ STL (mm) │ PLY ──► indirme        │
└──────────────────────────────┬──────────────────────────────────────────────────────┘
                               │ /api/*  (Vite dev proxy / aynı origin; GitHub Pages'te yok)
┌──────────────────────────────▼──────────────────────────────────────────────────────┐
│ Hono sunucusu (server/)  :8787                                                       │
│  GET  /api/health             GET /api/tripo/status                                  │
│  POST /api/tripo/tasks (multipart "image")   POST /api/tripo/multiview-tasks         │
│  GET  /api/tripo/tasks/:id    GET /api/tripo/tasks/:id/model (GLB)                   │
│  GET  /api/ai/providers       → sunucu anahtarlı ("managed") sağlayıcılar            │
│  ANY  /api/ai/proxy/<kind>/…  → yalnızca o türün SABİT API adresine iletir           │
│  GET  /api/ai/fetch?url=…     → izinli CDN'lerden çıktı indirme (CORS engelinde)     │
│  • Anahtarlar sunucuda; kullanıcı anahtarı x-ai-key / x-tripo-key ile (loglanmaz)    │
│  • IP başına hız limiti, gövde/boyut sınırı, çapraz site engeli (x-3dmarker-client), │
│    SSRF koruması (sabit hostlar, izin listesi, yönlendirme kontrolü)                 │
└──────────────────────────────────────────────────────────────────────────────────────┘
 Model dosyaları: huggingface.co (derinlik), storage.googleapis.com/mediapipe-models (insan algılama);
 ilk kullanımda indirilir, tarayıcı önbelleğinde tutulur. ONNX Runtime ve MediaPipe wasm: uygulamanın kendi /assets'i.
```

Önemli sözleşmeler (`src/core/types.ts`):

- `DepthMap` değerleri `[0,1]`, **1 = izleyiciye en yakın**. `Mask`: 1 = ön plan. Görüntüler satır sıralı, üst satır önce.
- Geometri çerçevesi: +Y yukarı, +Z izleyiciye doğru (ön görünüm), görüntünün uzun kenarı 2 birim, merkezde; UV (0,0) = sol alt.
- Görünümler (`ViewSet`): **back** arkadan (öznenin solu görüntünün solunda), **left** öznenin sol yanından (özne görüntünün
  soluna bakar), **right** sağ yanından (sağa bakar), **top** yukarıdan (önü görüntünün altında), **bottom** aşağıdan (önü üstte).
- `geometry` sonuçlarında `color` özniteliği = köşe renkleri (doku yerine). Tüm kullanıcı metinleri `I18nText { tr, en }`.

## Sürücüler

| Sürücü (id) | Tür | Çıktı | Kapalı mesh | İndirme | Hız | En iyi kullanım | Not / lisans |
|---|---|---|---|---|---|---|---|
| Depth Anything V2 Small (`depth-anything-v2-small`, varsayılan) | ML, tarayıcı | derinlik → mesh (2.5D) + insan detayı | solid/double modunda | ~50 MB + ~20 MB MediaPipe (bir kez) | WebGPU'da hızlı, WASM'da daha yavaş | Fotoğraflar, portreler, genel amaç | Apache-2.0 |
| Depth Anything V2 Base (`depth-anything-v2-base`) | ML, tarayıcı | derinlik (daha ayrıntılı) + insan detayı | solid/double | ~195 MB | Small'dan 3–4× yavaş | Kalite öncelikli | **CC-BY-NC-4.0 — ticari kullanım yok** |
| DPT Hybrid MiDaS (`dpt-hybrid-midas`) | ML, tarayıcı | derinlik (384×384 sabit) + insan detayı | solid/double | ~125–490 MB | orta | Karşılaştırma, yumuşak sahne derinliği | Intel DPT (model kartını kontrol edin) |
| Siluet şişirme (`silhouette-inflate`) | Sezgisel | derinlik (balon profili) → çift yüz | evet | yok | anında (~0.5 s) | Maskotlar, karakterler, çıkartmalar, logolar (saydam PNG) | Siluet gerekir |
| Siluet kalıplama / ekstrüzyon (`silhouette-extrude`) | Sezgisel | geometri (düz + pah) | evet | yok | anında | Logolar, ikonlar, yazılar, 3B baskı | Siluet gerekir |
| Parlaklık haritası (`luminance-heightmap`) | Sezgisel | derinlik (parlaklıktan) | solid/double | yok | anında | Kabartma, litofan, doku, desen | Gerçek derinlik değil |
| **Çok görünümlü füzyon** (`multiview-fusion`) | Çok görünüm, tarayıcı | geometri, köşe renkli, **tam 3B** | evet | ~50 MB (derinlik iyileştirme; isteğe bağlı) | 1–3 s (144 voksel) | Ön + arka/yan görünümleri olan karakterler, nesneler; elle çizilmiş / dış araçta üretilen görünümler hizalanır | Ön + en az 1 görünüm ("Şekil + renk" güveniyle) |
| Tripo3D (`tripo3d-cloud`) | Bulut API | GLB (tam 3B, dokulu) | evet | yok (sunucuda) | 1–3 dk | Gerçekçi, arkası da olan tam model | API anahtarı + kredi; sunucu gerekir |
| Tripo3D çok görünüm (`tripo3d-multiview`) | Bulut API | GLB | evet | yok | 1–3 dk | Ön + sol/arka/sağ görünümlerden gerçekçi model | Sunucu gerekir; üst/alt yok sayılır |
| AI sağlayıcı ile 3D (`ai-provider-3d`) | Bulut API | GLB | modele bağlı | yok | modele bağlı | Eklediğiniz fal / Replicate / Stability / Tripo image-to-3D veya multi-view modeli | Görünümler varsa çok görünümlü model tercih edilir |

Mesh seçenekleri (derinlik üreten sürücüler için, **canlı** — sürücüyü yeniden çalıştırmadan yeniden örer):
`mode` (relief = açık yüzey, solid = düz taban/baskıya uygun, double = aynalı arka), `resolution`, `depthScale`,
`gamma`, `smoothing`, `useMask`, `discontinuity` (relief'te derinlik sıçramalarında yırtma), `baseThickness`, `invert`.
Sürücü değiştirmek ekrandaki modeli yeniden örmez; yeni sürücünün önerdiği `mode` bir sonraki oluşturmada uygulanır.
Model heykelle düzenlendiyse, heykel modu açıksa ya da iskelet eklendiyse canlı yeniden örme **duraklar** ("Düzenlemeleri at" ile devam eder).

### Hangi sürücüyü seçmeliyim?

- **Saydam PNG karakter/maskot** → Siluet şişirme (anında, kapalı, yuvarlak hacim).
- **Logo, ikon, yazı** → Siluet kalıplama / ekstrüzyon (net kenarlar, pah, baskıya hazır STL).
- **Fotoğraf / portre** → Depth Anything V2 Small (insan detayı açık: yüz ve eller kabartmalı).
- **Her yönü olan karakter / nesne** → 3. adımda görünümleri ekleyin (yükleyin ya da AI ile üretin) → Çok görünümlü füzyon.
  Örnek: "T-poz manken" örneği arka/sol/sağ görünümleriyle gelir; çevrimdışı tam 3B + iskelet + animasyon denemesi için idealdir.
  "T-poz manken (elle çizilmiş görünümler)" örneği aynı ön görseli, bir sanatçının kendi ölçeği / kayması / kol yüksekliğiyle
  çizdiği ve altı kesik bir sol görünümle birlikte verir: hizalama, kesik kenar tanıma ve ince parça korumasının canlı gösterimi.
- **Gerçekçi, dokulu tam model** → Tripo3D / Tripo3D çok görünüm (sunucu) ya da AI sağlayıcı ile 3D (fal.ai tarayıcıdan da çalışır).

## Yapay zekâ sağlayıcıları

Üst çubuktaki **AI sağlayıcılar** düğmesi (anahtar simgesi + sayı) sağlayıcı iletişim kutusunu açar. Her kayıt:
tür, ad, API anahtarı, yetenek başına model (öneri listesi ya da elle model kimliği), türe özel seçenekler
(boyut, kalite, temel URL, istek şablonu…), etkin/pasif ve "bağlantıyı test et". Görev başına **varsayılan sağlayıcı**
seçilebilir (görsel düzenleme, arka plan kaldırma, görselden 3B, çok görünümden 3B). Değişiklikler anında kaydedilir.

| Tür | Yetenekler | Statik demoda (GitHub Pages) | Not |
|---|---|---|---|
| OpenAI | görsel düzenleme, arka plan kaldırma | **evet** (tarayıcıdan doğrudan) | `POST /v1/images/edits`; gpt-image-1.5 (varsayılan), gpt-image-2, 2.5 Flare/Sunburst, 1, 1-mini, chatgpt-image-latest; saydam PNG |
| Google Gemini | görsel düzenleme | **evet** | 2.5 Flash Image (Nano Banana), 3.1 Flash Image, 3 Pro Image; saydamlık yok → arka plan ayrıca kaldırılır |
| fal.ai | düzenleme, arka plan, görselden 3B, çok görünümden 3B | **evet** | Nano Banana / FLUX Kontext / Seedream; BiRefNet; Hunyuan3D v2/v2.1/v3, TRELLIS, Tripo v2.5, TripoSR; kuyruk API'si |
| Stability AI | düzenleme (Control), arka plan, görselden 3B | hayır — sunucu vekili | Stable Fast 3D, SPAR3D |
| Replicate | düzenleme, arka plan, görselden 3B, çok görünüm | hayır — sunucu vekili | FLUX Kontext, Nano Banana, Qwen, Seedream; TRELLIS, Hunyuan3D-2 / 2mv |
| Tripo3D | görselden 3B, çok görünümden 3B | hayır — sunucu vekili | Tripo sürücüleriyle aynı hesap |
| OpenAI uyumlu | düzenleme, arka plan | CORS izin veriyorsa evet | Kendi temel URL'niz; sunucu vekili yalnızca `AI_PROXY_EXTRA_BASES` listesindeki adresler için |
| Özel HTTP | hepsi (şablonla) | CORS izin veriyorsa evet | Tek eşzamanlı istek; gövde/çıktı yolu şablonla tanımlanır |

- **Anahtarların saklanması:** varsayılan olarak yalnızca bu sekmenin `sessionStorage`'ında (sekme kapanınca silinir).
  "Anahtarları bu cihazda hatırla" açıkken `localStorage`'a taşınır; ikisine birden asla yazılmaz. Sunucu anahtarları
  ("Sunucu" rozetli kayıtlar) tarayıcıya hiç gelmez. Anahtarlar yalnızca sağlayıcının API'sine ya da kendi sunucumuzun
  vekiline gider; vekil onları loglamaz ve yanıtlarda geri göndermez.
- **Sunucu vekili** (`/api/ai/proxy/<kind>/…`): CORS desteklemeyen sağlayıcılar (Stability, Replicate) ve sunucu
  anahtarlı kayıtlar bu yoldan gider. Vekil yalnızca o türün sabit adresine iletir (openai → api.openai.com,
  gemini → generativelanguage.googleapis.com, stability → api.stability.ai, replicate → api.replicate.com,
  fal → queue.fal.run) ve **yalnızca uygulamanın adaptörlerinin çağırdığı uç noktaları** (ör. openai `POST v1/images/edits`,
  `GET v1/models`; replicate tahmin oluştur / sorgula / iptal; fal kuyruk gönder / durum / sonuç / iptal) geçirir: diğer
  yollar 403, GET/POST/PUT dışındaki yöntemler 405 alır. `AI_PROXY_EXTRA_BASES` adresleri için yalnızca `POST images/edits`
  ve `GET models`. Tripo3D genel vekilden geçmez; kendi `/api/tripo` rotalarını kullanır. Sunucu yoksa (GitHub Pages) bu
  kayıtlar "sunucu vekili gerekir" uyarısıyla devre dışı görünür.
- **Sunucu anahtarları:** `.env`'de `OPENAI_API_KEY`, `GEMINI_API_KEY`, `STABILITY_API_KEY`, `REPLICATE_API_TOKEN`,
  `FAL_KEY`, `TRIPO_API_KEY` — her biri iletişim kutusunda `server-<tür>` kimlikli "yönetilen" bir kayıt olarak görünür.
- **Arka plan kaldırma:** "Arka planı kaldır" açıkken istem, gerçek saydamlık veren modellere (OpenAI gpt-image) saydam,
  diğerlerine düz beyaz arka plan ister. Çıktı zaten saydamsa olduğu gibi kalır; değilse düz kenarlı nesneler renk anahtarıyla,
  insanlar tarayıcıdaki MODNet modeliyle (ya da arka plan varsayılanı olarak seçtiğiniz sağlayıcıyla) kesilir; hepsi
  başarısız olursa ücretli görsel atılmaz, olduğu gibi uyarıyla tutulur. Arka plan kaldırma varsayılanı **Yerel (tarayıcıda)**
  modeldir; OpenAI gibi görseli yeniden çizen sağlayıcılar yalnızca açıkça seçilirse kullanılır. Yalnızca "Arka planı kaldır"
  açıkken **AI ile hazırla** görsel düzenleme sağlayıcısı olmadan da çalışır (yalnızca arka planı kaldırır).

### Stiller, T-poz, gövde tamamlama

- **60 stil**, 6 kategoride (gerçekçi 6, animasyon 9, oyuncak 9, malzeme 19, sanatsal 6, oyun 11): Fotogerçekçi, Kil render,
  Anime, Chibi, Claymation, Vinil figür, Peluş, Mermer heykel, Bronz, Altın, Cam, Low-poly, Voksel, Suluboya, Cyberpunk,
  Steampunk, Samuray… Arama Türkçe/İngilizce adlarda, aksan ve "ı/i" farkı gözetmeden çalışır. Stil istemleri marka adı
  içermez (testle denetlenir) ve her biri kimliği, pozu ve kompozisyonu korumayı ister.
- **T-poz** (yalnızca insan/karakter; "otomatik" konu seçiminde insan algılamaya göre) ve **eksik gövdeyi tamamla**
  (ör. yalnızca kafa → tam boy; nesnelerde "eksik parçaları tamamla").
- T-poz ve gövde tamamlama istendiğinde stilin "pozu ve kompozisyonu koru" cümlesi çıkarılır ve bu talimatlar stilden önce,
  öncelikli olarak verilir. Stability'nin düzenleme uç noktaları kompozisyonu korur: T-poz / tamamlama ve yeni görünümler için
  kullanılamaz (yalnızca stil); Görünümler adımı bu durumda görünüm üretebilen başka bir sağlayıcıyı kullanır.
- Sonuç önce/sonra kaydırıcısıyla gösterilir; **Bu görseli kullan** kaynağı değiştirir (görünümler bu görselden, aynı stil /
  ek talimatlar tekrarlanarak üretilir), **Orijinale dön** her zaman mümkündür: yapay zekâ görünümleri silinecekse önce onay
  istenir ve **Yapay zekâ görseline dön** ile hazırlanan görsel ve görünümleri geri gelir (ücretli sonuçlar kaybolmaz).
- Model indirilemediğinde (çevrimdışı, engelli ağ) hata kutusu **Siluet şişirme ile dene** düğmesini sunar; teknik ayrıntı
  "Ayrıntılar" altında katlanır. Görüntüleyicide **Önden / Arkadan / Soldan / Sağdan / Üstten** hazır bakış açıları vardır.
- Telefonda: oluşturma bitince sayfa modele kayar, Düzenle / Rig adımlarında görüntüleyici ekranın altına sabitlenir, görüntüleyici
  üzerinde dikey kaydırma sayfayı kaydırır (heykel modu hariç), adım sekmeleri kaydırılabilir olduğunu kenar solmasıyla gösterir.

## Çok görünümlü iş akışı

1. Görseli yükleyin (ve isterseniz 2. adımda stil / T-poz uygulayın).
2. **3 Görünümler:** her yuva için yükle (⤒), AI ile üret (✎) ya da temizle (×). "Eksikleri üret" boş yuvaları sırayla üretir;
   her yeni görünüm öncekileri referans alır (tutarlılık). Yüklenen görünümlerin maskesi alfa kanalından ya da düz kenar
   renginden çıkarılır; arka plan modu "AI" ise gerekirse MODNet ile kaldırılır (başka bir iş sürüyorsa sıraya alınır).
   AI hazırlığı kabul edildiğinde (ya da orijinale dönüldüğünde) eski ön görselden AI ile üretilen görünümler kaldırılır;
   yüklenen görünümler kalır. Seçili sürücü görünümleri kullanmıyorsa 3. ve 4. adımda füzyona geçiş önerilir.
3. **4 3D:** `multiview-fusion` (tarayıcıda), `tripo3d-multiview` ya da `ai-provider-3d` seçin.
   Füzyon (`src/core/fusion`): (1) her görünümün silueti ve çerçevesi çıkarılır, ek görünümler ön görünüme **siluet profilleriyle
   hizalanır** (`align.ts`, aşağıda); (2) yumuşak görsel gövde voksel ızgarada kesişir — **arka siluet gövdeyi oymaz** (ön görünümün
   aynasıdır; yalnızca yan / üst / alt görünümler derinliği sınırlar) — ve **ince parça koruması** (`guard.ts`) ön görünümde ince olan
   kolları / bacakları diğer görünümler uyuşmasa da yerinde tutar; (3) isteğe bağlı olarak her görünümde Depth Anything ile oyma
   (model inemezse siluet gövdesine düşer ve uyarır; derinlik ölçeği sabit noktalı, sağlam bir medyanla kalibre edilir, oyma asla
   korumanın altına inmez; model inmezse yalnızca yan görünümlerde gövdenin önünde görünen ince parçalar — T-pozdaki kollar —
   yuvarlak kesite kırpılır, "tahta kol" oluşmaz); (4) marching cubes + Taubin yumuşatma ile kapalı mesh ve köşe renkleri
   (`color.ts`): her görünüm son mesh'in kendi derinlik görüntüsünü çizer, başka bir parçanın arkasında kalan (ya da onun
   kenarına bitişik) noktalar o görünümden renk almaz; yan / arka / üst görünümlerin renkleri kanal başına ön görünüme
   **pozlama eşitlenir** (farklı ışıkta / tonda çizilmiş setler modeli boyamaz; gerçekten farklı renkli görünümler olduğu gibi
   kalır); her noktada görünümler bakış açısı ve önceliğe göre (ön 1, arka 0.9, yan / üst / alt 0.8, "Yalnız renk" yarısı)
   **oy verir**, iyi desteklenen görünümlerle çelişen örnek atılır; görünüm alanlarının kenarı iki köşe halkasında yumuşakça
   söner. Ön görünümde ince olan parçalarda (kol, el, bacak, boyun, baş) yan / üst görünüm rengi yalnızca parçanın yuvarlak
   kesiti içinde ve ön / arka renge kabaca uyuyorsa kullanılır.
   Füzyon ayrı bir Web Worker'da (`src/workers/geometry.worker.ts`) çalışır; derinlik modeli çıkarımı ML worker'ına gider,
   yalnızca son geometri ana iş parçacığına aktarılır. Worker başlatılamazsa oturum boyunca ana iş parçacığına (dilimli, yol
   veren) geri düşülür; worker iş ortasında çökerse iki dilde hata gösterilir ve sonraki çalıştırma yeni bir worker alır.
   Derinlik modeli indirilemezse raporda tek satır çıkar: "Derinlik modeli indirilemedi (bağlantı yok); model yalnız
   siluetlerden oluşturuldu…"; indirme yanıt vermeyi keserse ~30 s sonra "yanıt vermiyor" nedeniyle yine siluetlere düşülür.
   Parametreler: voksel çözünürlüğü (64–256), kabuk modu + gövde toleransı, **görünüm hizalama** (Otomatik = siluet profilleri /
   Yalnız çerçeve = eski bbox davranışı), **ince parça koruması (%)** (0–15, varsayılan 6; ön görselin uzun kenarının bu yüzdesinden
   ince parçalar korunur, 0 = kapalı), derinlik iyileştirme / modeli / gücü, yumuşatma, renk keskinliği, üçgen sınırı.
   Geliştiriciler için `FusionOptions.hullBack` / `calibration` (arayüzde yok) ve `LEGACY_FUSION_OPTIONS` eski davranışı bire bir
   yeniden üretir (regresyon testleri bunu kullanır).

### Elle eklenen görünümler: hizalama, tutarlılık, güven, istem

Başka bir araçta çizilen / üretilen görünümler ön görselle aynı çerçeveyi neredeyse hiç paylaşmaz: birkaç yüzde ölçek ya da
kayma farkı, yan görünümdeki kol diskini ön görünümün kol satırlarından uzaklaştırır ve gövde **kesişimi** ince kolları siler
(kol kalınlığı boyun %4–6'sı iken eski tolerans %2 idi). Bu yüzden füzyon artık çerçeveye değil içeriğe göre çalışır:

- **Otomatik hizalama:** her ek görünümün satır / sütun profilleri (satır başına ön plan piksel sayısı) ön görünümünkiyle
  paylaştığı eksenlerde eşlenir — arka: satırlar + aynalanmış sütunlar; sol / sağ: satırlar; üst / alt: sütunlar. Ölçek
  (ln k ∈ ±0.37) ve kayma (±%30) aranır, kaba ızgara → yerel tepeler → budanmış ince arama (en kötü %20 bölme atılır, kolları
  farklı yükseklikte olan bir arka görünüm kaymayı sürüklemez). Arka görünümde tek bir içerik ölçeği kullanılır (izotropi).
  Eşleşme zayıfsa ya da siluet düzse (küre, kutu) çerçeve olduğu gibi kalır ("Ön görünümle eşleştirilemedi" / "Hizalanacak ayrıntı yok").
- **Kenarda kesik görünümler:** siluet görsel kenarına değiyorsa (kenar satırında bbox kenarının ≥ %2'si kadar ön plan) o kenar
  "bilinmiyor" sayılır: gövde orada oymaz, eksik kısım diğer görünümlerden tamamlanır. Ölçek profil eşleşmesinden, o da yoksa
  arka için ön görünümün en-boy oranından, yan görünüm için tepe–boyun mesafesinden bulunur; hiçbiri yoksa "ölçeği bulunamadı;
  hizalama yaklaşık" uyarısıyla çerçeve kullanılır. Paylaşılan eksenin **iki ucu da** kesik ve profil eşleşmesi de yoksa görünüm
  kendiliğinden "Yalnız renk"e düşer.
- **Tutarlılık rozeti** (Görünümler adımı, her dolu yuva): 0–100 puan + iyi / orta / zayıf simgesi (renk tek başına anlam
  taşımaz), üzerine gelince açıklama ("Otomatik hizalandı: %1.5 yukarı, ölçek 0.97", "Alt kenarda kesik (ayaklar?)", "Aynalanmış
  görünüyor"…). Ön kontrol, füzyonun hizalama kodunu görsel değişince (ve bir kaydırıcı düzenlemesinden 250 ms sonra) doğrudan
  çağırır; oluşturmadan sonraki **birleştirme raporu** (3D adımı: görünüm başına puan, seviye, güven, tutarlılık, uyarılar) esas
  sonuçtur. Derinlik yolunda ek olarak görünüm başına *tutarlılık payı* ölçülür: bir görünümün oyacağı hacmin korumanın tuttuğu
  payı %25'i aşarsa "ön görünümle tam örtüşmüyor; ince parçalar korundu" uyarısı verilir.
- **Yanlış / şüpheli görünüm denetimleri** (puanı sınırlar, notu iki dilde açıklar, raporda uyarı + öneri çıkar):
  - *Yanlış yuva:* ön / arka görseli yan ya da üst yuvada (figür görünümlüyse: boyun, bacak / kol arası boşluk) → en çok 30
    (zayıf) ve elle konmadıysa yalnız renk; lamba ya da kare masa gibi yanı önüne benzeyen nesneler işaretlenmez.
  - *Aynı görsel:* ön görsel başka bir yuvaya tekrar yüklenmiş ya da bir görsel iki yuvada → "ön görselle aynı görsel" (zayıf);
    silindir / küre gibi her yönden aynı görünen nesneler işaretlenmez.
  - *Uymayan derinlik:* bir yan / üst görünüm ön görselin 3 katından derin bir hacim ya da diğer derinlik görünümleriyle çelişen
    bir derinlik veriyorsa zayıf puan ve yalnız renk.
  - *Ayrıntısız:* ön görsel bir figür / ayrıntılıyken düz bir leke ya da dikdörtgen → zayıf.
  - *Ters yön:* yan görünümde ayak uçları ve burun yanlış yöne bakıyorsa "ters yöne bakıyor olabilir — Yatay aynala'yı deneyin"
    (en çok 70, orta); Yatay aynala açılınca kalkar.
  - *Kopya arka:* arka görünüm ön görselin (aynalı ya da değil) kopyasıysa "ön görselle aynı görünüyor" (en çok 79).
  - Başka nedeni olmayan **zayıf** her görünüm raporda puanı ve çözümüyle adlandırılır (Hizala panelinde düzeltin ya da
    güveni "Yalnız renk" / "Kapalı" yapın). Elle hizalama sırasında da bu sınırlar rozette korunur. İki görünümü karşılaştıran
    denetimler (aynı görsel iki yuvada, çelişen derinlik) yalnızca oluşturmadan sonraki raporda görünür.
- **Hizala paneli** (yuvadaki hizalama düğmesi): üst üste bindirme önizlemesi (gri: önden beklenen — arka için ön siluetin aynası,
  yanlar için uzunluk çizgileri ve kesikli işaret satırları; renkli: bu görünüm; kırmızı tarama: kesik kenar), **Dikey / Yatay kayma**
  (±%20; yan görünümlerde yatay kayma yoktur, üst / alt görünümlerde dikey kayma yoktur) ve **Ölçek** (%70–140) kaydırıcı + sayı
  kutusu, **Yatay aynala**, **Otomatik hizala** (kayıtlı sonuca dön) ve **Sıfırla**. Herhangi bir kayma / ölçek düzenlemesi görünümü
  "elle" moduna alır; rozet çekirdek yeniden çalışmadan anında yeniden puanlanır. Esc paneli kapatır ve odağı düğmeye verir.
- **Güven modları** ("Bu görünüm ne için kullanılsın"): **Şekil + renk** (varsayılan; gövdeyi sınırlar, derinlikle oyar, renk verir),
  **Yalnız renk** (gövdeye dokunmaz, yalnızca köşe renklerine katkı verir — kolları kaybettiren bir yan görünüm için hızlı çözüm),
  **Kapalı** (füzyona hiç girmez; bulut çok görünüm sürücülerine de yüklenmez). Tüm ek görünümler kapalıysa "3D Oluştur" görünüm
  gerekçesiyle engellenir.
- **İstemi kopyala** (ön görsel varken her yuvada): ön görselin **ölçülen çerçevesiyle** — figürün görsel yüksekliğine oranı,
  en dar kenar boşluğu, çıktı boyutu (`768 × 768 px` gibi), T-pozda kolların yükseklik bandı — İngilizce bir istem üretir
  (kamera: ortografik, 90° / 180°; üst / alt için "tam yukarıdan / aşağıdan"), panoya yazar ve iki dilde bildirir. Pano reddederse
  aynı metin salt okunur bir kutuda "Tümünü seç" ile görünür. Yuvanın altındaki **"Görünümleri tutarlı yapmak için"** rehberi
  kuralları özetler (aynı yükseklik / ölçek, hiçbir şey kesilmesin, ortografik kamera, aynı poz, kollar kaybolursa Hizala ya da
  "Yalnız renk").

## İnsan detayı (yüz, burun, kulak, dudak, el, parmak)

ML derinlik sürücülerinde **İnsan detayı** (varsayılan açık) MediaPipe Tasks Vision ile yüz (478 nokta), el (21 nokta) ve
vücut (33 nokta) algılar ve derinliğe ek kabartma ekler: yüz ağı (852 üçgen) üzerinden burun, göz çukurları, dudaklar,
yanaklar, çene; ten rengindeki piksellerde kulaklar (baş 40°'den fazla dönükse atlanır); parmaklar ve kollar kapsül olarak,
avuç ve gövde kubbe olarak. Yalnızca modelin derinliğinde eksik olan ayrıntı eklenir. Küçük yüzler vücut pozundan kırpılarak
yeniden aranır; "Yüksek çözünürlüklü kırpma" yüz/el bölgelerinde derinliği ayrıca hesaplar. Ayarlar: yüz gücü (0.8), el gücü (0.7).
Algılama ana iş parçacığında, derinlik çıkarımıyla paralel çalışır; modeller inemezse (ör. ağ engeli) "Algılama kullanılamıyor"
gösterilir ve düz derinlikle devam edilir; yavaş (≥5 s, ör. indirme takılması) bir model yükleme hatası 5 dakika hatırlanır, bu
sürede sonraki çalıştırmalar beklemeden düz derinliğe geçer (hızlı ağ hataları her seferinde yeniden denenir). Kırpma geçişi
yalnızca küresel geçişten daha ince çözünürlük verecekse yapılır. Sonuç 2. ve 4. adımda (algılanan yüz/el/vücut sayısı) görünür; 2. adımda algılama
yalnızca hazırlığı çalıştırabilecek bir sağlayıcı varken kendiliğinden başlar (gereksiz ~20 MB indirmeyi önler).

- **Parmak ve kulak ayrıntısı:** sürücü yüz (kulak payıyla) ve el bölgelerini derinlikle birlikte işaretler; mesh kurucu bu
  bölgelerde derinliği yumuşatılmış ızgaradan değil tam çözünürlüklü haritadan alır ve üçgenleri yalnızca orada ~1.25 piksele
  kadar böler (en çok 3 düzey, en fazla 250 bin ek üçgen; bölge dışına 2 hücrede geçiş, çatlak yok, kapalı mesh kapalı kalır).
  Varsayılan ayarlarda parmak sırtlarının / kulak kabartmasının ~%93–95'i korunur (önce %3–6); mesh ~68k yerine ~122k üçgen.
- **Algılama kullanılamazsa** (model inmedi, zaman aşımı, WebGL hatası) 4. adımdaki **İnsan detayı** kartı nedeni sade dille
  gösterir ("3B üretim yine çalışır, ancak yüz ve el kabartması eklenmez") ve **Yeniden dene** düğmesi sunar (hatırlanan
  indirme hatasını unutup hemen yeniden indirir); yalnızca bir algılayıcı başarısızsa ("El algılama kullanılamadı; bulunanlarla
  devam edilir") uyarı gösterilir. Üretim sırasında ilerleme satırı da kabartmasız devam edildiğini söyler.

## Heykel ve derinlik editörü (5. adım)

**Heykel modu** ekrandaki mesh üzerinde çalışır (three-mesh-bvh ile ışın izleme, yalnızca etkilenen bölge güncellenir):
modelin üzerinde sürükleyin; boş alanda sürüklemek görünümü döndürür.

| Kısayol | İşlev |
|---|---|
| `1`–`8` | Fırça: Çiz, Kil, Yumuşat, Düzleştir, Şişir, Sıkıştır, Tut-çek, Kırışık |
| `[` / `]` | Yarıçap küçült / büyüt |
| `Shift` + `[` / `]` | Güç azalt / artır |
| `Ctrl`/`⌘` + sürükle | Ters yönde çalış (oy / söndür / sırt) |
| `Shift` + sürükle | Yumuşat (her fırçada) |
| `X` | X simetrisini aç / kapat |
| `Ctrl`/`⌘` + `Z`, `Ctrl`/`⌘` + `Shift` + `Z` / `Y` | Geri al / yinele (64 darbeye kadar) |

Dikişler bozulmaz (aynı konumdaki köşeler birlikte hareket eder), açık kenarlar isteğe bağlı sabitlenir. Heykelli bir derinlik
modelinde mesh seçeneklerini değiştirmek yüzeyi yeniden örer ve düzenlemeleri siler — bu yüzden canlı yeniden örme duraklatılır.

Kaba mesh'ler (ör. ekstrüzyon, düşük poligonlu modeller) heykel başlarken **otomatik alt bölünür**: en uzun kenar varsayılan
fırça yarıçapının yarısına göre 1.5 kattan uzunsa kenarlar bölünür (konuma göre, dikişlerde çatlak yok, kapalı mesh kapalı kalır,
en çok 300 bin üçgen; morph hedefli geometri atlanır). Panel "Mesh heykel için sıklaştırıldı: X → Y üçgen" der; bu düzenleme
sayılmaz, Geri al / Sıfırla alt bölünmüş, düzenlenmemiş yüzeye döner. Hiçbir köşeye değmeyen bir darbeden sonra ve tipik kenar
fırça yarıçapından uzunsa baştan uyarı gösterilir.

**Derinlik haritası editörü** (derinlik sonuçları için): Yükselt / Alçalt / Yumuşat / Düzleştir / Geri yükle fırçaları,
yarıçap, güç, düşüş eğrisi, "yalnızca özne içinde", gri / renkli görünüm, görsel kaplama, önce/sonra, yakınlaştırma
(tekerlek), kaydırma (Boşluk + sürükle). En yakın noktalar da yükseltilebilir: uygulamada harita yeniden `[0,1]`'e ölçeklenir.
**Uygula** yeni derinlikten modeli yeniden kurar (canlı mesh ayarları çalışmaya devam eder). Düzenleme varken Esc / × / İptal
önce sorar ("N düzenleme silinsin mi?" — **Düzenlemeye devam** odaklı, **Vazgeç ve kapat**); soru açıkken Esc düzenlemeye döner,
yani iki kez Esc'ye basmak çalışmayı kaybettirmez.

## Rig ve animasyon (6. adım)

- **Otomatik iskelet:** 23+ kemikli insansı iskelet (Mixamo adları: `Hips`, `Spine`, `LeftArm`, `LeftForeArm`, `LeftUpLeg`…;
  el noktaları algılanırsa parmaklar). Eklemler önce MediaPipe vücut pozundan, yoksa kolları aşağıda / T-poz siluetinden, o da
  olmazsa oranlardan yerleştirilir. Deri ağırlıkları mesafe + iç görünürlük testiyle, köşe başına 4 kemik.
- **Eklem düzenleyici:** eklemleri görünümde sürükleyin ya da X/Y/Z ile dürtün (ayna seçeneğiyle); her değişiklik ağırlıkları yeniler.
  **Geri al / Yinele / Otomatik konuma sıfırla** düğmeleri ve Ctrl/⌘+Z, Ctrl+Shift+Z / Ctrl+Y (her sürükleme ya da dürtme dizisi
  bir adım; içe aktarılan klipler korunur). Sürükleme 3 px'ten sonra başlar (kayan tıklama yeniden ağırlıklandırmaz); gövde dışına
  bırakılan eklem (ve ayna ikizi) dinlenme pozunun ön silueti içine çekilir (parmaklar hariç).
- **Algılama durumu:** MediaPipe modeli yüklenemezse durum satırının altında nedeni ve **Tekrar dene** gösterilir (kişi bulunursa
  eklemler tek, geri alınabilir bir adımda yeniden yerleşir); "(insan algılanmadı)" yalnızca algılama gerçekten çalışıp kimseyi
  bulamadığında yazılır. İlerleme vermeyen bir model indirmesi 10 s sonra bırakılır. Şekil insana benzemiyorsa (baş–boyun, bacak
  arası boşluk, derinlik puanı < 0.5) "siluetten (emin değil)" ve "… insan figürüne benzemiyor; animasyonlar modeli yırtabilir"
  uyarısı çıkar.
- **45 hazır animasyon** (bekleme, yürüyüş/koşu, jestler, duygular, dans, aksiyon, pozlar): oynat / duraklat / durdur (T-poza döner),
  zaman çubuğu, hız, döngü, geçiş (cross-fade), arama ve kategori filtresi. Klipler kanonik T-pozda yazılır ve dinlenme yönlerine
  göre aktarılır; A-pozlu iskeletleri de doğru sürer. Zemin geçişi deri ağırlıklarıyla birlikte saklanan ~1 500 yüzey
  noktasını her karede pozlar ve en alçak noktayı zeminde tutar: tabanlar, ayak uçları, yatarken sırt ve baş zemine girmez
  (bağlı mesh yoksa eklemler + yaklaşık vücut kalınlığı kullanılır).
- **İçe aktarma:** `.bvh`, `.fbx` (Mixamo dahil), `.glb`/`.gltf`. Kemik adları Mixamo, klasik/CMU/SecondLife BVH, Unity, Unreal ve
  Rigify düzenlerinden eşlenir; kaynağın yukarı/ileri eksenleri iskeletten bulunur; kalça hareketi bacak boyuna göre ölçeklenir,
  döngüler yerinde kalır. Ayak ucu eklemi olmayan dosyalarda zemin iki tarafta da ayak bileğinden ölçülür (karakter zemine
  gömülmez). Bozuk dosyada ham JavaScript hatası yerine iki dilde "dosya bozuk ya da geçerli bir BVH / FBX / GLB animasyonu değil"
  gösterilir.
- **Dışa aktarma:** GLB deriyi (JOINTS_0/WEIGHTS_0) ve **seçili tüm animasyonları** taşır (dosya adı `-rigged`); OBJ / STL / PLY
  o anda gösterilen pozu verir. Kemikli GLB modellerin kendi animasyonları da oynatılabilir ve GLB'ye geri yazılır.
- En iyi sonuç tam boy ve T-pozdaki modellerle alınır: 2. adımdaki **T-poz** + 3. adımdaki görünümler + çok görünümlü füzyon.

## Çalıştırma

Gereksinimler: Node.js ≥ 22 (öneri 24), npm.

```bash
npm ci --ignore-scripts      # onnxruntime-node'un postinstall indirmesi gerekmiyor (tarayıcıda onnxruntime-web kullanılır)
npm run dev                  # Vite (http://localhost:5173) + API sunucusu (http://127.0.0.1:8787, yalnızca yerel), birlikte
# ya da ayrı ayrı:
npm run dev:web
npm run dev:api
```

Tarayıcıda http://localhost:5173 adresini açın, örnek görsellerden birine tıklayın ve "3D Oluştur"a basın.
Yapay zekâ adımları için üst çubuktaki **AI sağlayıcılar**'dan bir sağlayıcı ekleyin (ör. OpenAI + kendi anahtarınız)
ya da sunucuya `.env` ile anahtar verin.

### Ortam değişkenleri

`.env.example` dosyasını `.env` olarak kopyalayın (tüm değişkenler orada açıklamalı). Kabuktaki değişkenler `.env`'dekileri ezer.
API sunucusu ve Vite proxy'si (`PORT`, `CROSS_ORIGIN_ISOLATION`) yalnızca `.env`'i okur; `.env.local` / `.env.[mode]` yalnızca tarayıcı derlemesinin `VITE_*` değişkenlerini etkiler.

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | `8787` | API/üretim sunucusu portu (Vite proxy'si de bunu kullanır) |
| `HOST` | geliştirmede `127.0.0.1`, üretimde tüm arayüzler | Dinlenecek adres. Geliştirmede ayarlanırsa (ör. `0.0.0.0`) API ve sunucu anahtarları ağa açılır |
| `ALLOWED_HOSTS` | boş | DNS rebinding'e karşı Host başlığı denetimi her modda açıktır: localhost, IP adresleri ve bu virgüllü adlar geçer (`*.example.com` = alt alan adları). Gerçek bir alan adında sunarken ayarlayın (ör. `app.example.com`), yoksa 403; `*` denetimi kapatır |
| `STATIC_DIR` | `./dist` | Üretimde sunulan SPA klasörü |
| `TRIPO_API_KEY` | boş | Sunucu tarafı Tripo3D anahtarı (Tripo sürücüleri + yönetilen "Tripo3D" sağlayıcısı). Boşsa kullanıcılar kendi anahtarını girer |
| `TRIPO_API_BASE` | `https://api.tripo3d.ai/v2/openapi` | Tripo API adresi |
| `TRIPO_ALLOWED_MODEL_HOSTS` | `tripo3d.ai,tripo3d.com,tripo-data.cdn.bcebos.com` | GLB'nin indirilebileceği hostlar (alt alan adları dahil) |
| `TRIPO_RATE_LIMIT` / `TRIPO_RATE_LIMIT_BYOK` | `10` / `60` | IP başına pencere başına görev (sunucu anahtarı / kullanıcı anahtarı), 0 = sınırsız |
| `TRIPO_RATE_WINDOW_SEC` | `3600` | Hız limiti penceresi |
| `TRIPO_READ_RATE_LIMIT` | `300` | IP başına dakikada görev durumu sorgusu + model indirme, 0 = sınırsız |
| `TRIPO_MAX_CONCURRENT_UPLOADS` | `16` | Tüm istemcilerde aynı anda alınan yükleme sayısı (bellekte tutulur), 0 = sınırsız. IP başına en fazla 3 |
| `TRIPO_MULTIVIEW_ORDER` | `front,left,back,right` | Tripo çok görünüm görevinde dosya sırası (ASSUMPTION; gerekirse değiştirin) |
| `OPENAI_API_KEY`, `GEMINI_API_KEY`, `STABILITY_API_KEY`, `REPLICATE_API_TOKEN`, `FAL_KEY` | boş | Sunucu tarafı AI anahtarları; her biri "yönetilen" bir sağlayıcı olarak görünür, anahtar tarayıcıya gitmez |
| `OPENAI_IMAGE_MODEL` / `GEMINI_IMAGE_MODEL` | uygulamanın önerisi | Yönetilen OpenAI / Gemini kaydının görsel düzenleme modeli |
| `AI_PROXY_KINDS` | `openai,gemini,stability,replicate,fal` | Vekilin hizmet verdiği türler (Tripo3D kendi `/api/tripo` rotalarını kullanır) |
| `AI_PROXY_BYOK` | `1` | `0`: kullanıcı anahtarlarını (`x-ai-key`) iletme, yalnızca sunucu anahtarları |
| `AI_PROXY_EXTRA_BASES` | boş | `openai-compatible` / `custom-http` için vekilin konuşabileceği tam temel URL'ler (virgülle) |
| `AI_PROXY_TIMEOUT_SEC` / `AI_PROXY_MAX_BODY_MB` | `180` / `40` | Üst akış yanıt süresi / en büyük istek gövdesi |
| `AI_PROXY_RATE_LIMIT` / `AI_PROXY_RATE_LIMIT_BYOK` / `AI_PROXY_RATE_WINDOW_SEC` | `60` / `600` / `3600` | IP başına üretim isteği (sunucu / kullanıcı anahtarı); IPv6'da /64 başına, sunucu anahtarıyla /48 başına da 4× sınır. Toplam harcamayı sınırlamaz |
| `AI_PROXY_GLOBAL_RATE_LIMIT` / `AI_PROXY_DAILY_LIMIT` | `10 × AI_PROXY_RATE_LIMIT` / `0` | Tüm istemcilerde, sağlayıcı türü başına sunucu anahtarlı üretim isteği: pencere başına / 24 saatte (0 = sınırsız) |
| `AI_PROXY_READ_RATE_LIMIT` / `AI_PROXY_MAX_CONCURRENT` | `300` / `64` | Dakikalık durum sorgusu + indirme; eşzamanlı vekil isteği (IP başına en fazla 8 ve diğerlerinin boş bıraktığının yarısı, en az 2; dörtte biri sunucu anahtarlı isteklere ayrılır) |
| `AI_FETCH_ALLOWED_HOSTS` / `AI_FETCH_MAX_MB` | `replicate.delivery,fal.media,storage.googleapis.com/falserverless` + Tripo hostları / `200` | `/api/ai/fetch` ile indirilebilecek çıktı hostları (`host` = alt alan adları dahil, `host/yol` = yalnızca o host, o yol altında); en büyük dosya |
| `TRUST_PROXY` | kapalı | `1`: tek bir ters proxy arkasında, istemci IP'si son `X-Forwarded-For` — yalnızca `TRUSTED_PROXIES` adreslerinden gelen bağlantılarda. Sunucuyu `HOST=127.0.0.1`'e bağlayın ya da portu güvenlik duvarıyla kapatın |
| `TRUSTED_PROXIES` | loopback + özel ağlar | `X-Forwarded-For`'una güvenilen ters proxy IP'leri / CIDR'ları (virgülle) |
| `CROSS_ORIGIN_ISOLATION` | kapalı | `1`: COOP + `COEP: credentialless` → ONNX Runtime çok iş parçacıklı WASM. Vite dev/preview ve üretim sunucusu uygular |
| `BASE_PATH` | `/` | Derleme alt yolu (GitHub Pages proje sitesi: `/<repo>/`) |
| `VITE_MODEL_HOST` | `https://huggingface.co/` | Derinlik modeli dosyaları için ayna (derleme zamanı) |
| `VITE_MODEL_STALL_MS` | `30000` | Derinlik modeli indirmesi bu kadar ms hiç veri göndermezse "yanıt vermiyor" hatasıyla biter (asılı kalmaz); takılan model 5 dk hatırlanır. `0` = kapalı |
| `VITE_STATIC_DEMO` | boş | `1`: sunucusuz statik derleme (GitHub Pages); `/api/ai/providers` ve `/api/tripo/status` yoklanmaz (konsolda 404 yok) |
| `VITE_ORT_WASM_PREFIX` | derlemedeki kopya (`/assets`) | ONNX Runtime wasm dosyalarını başka bir dizinden vermek için (ör. `/ort/`) |
| `VITE_MEDIAPIPE_MODEL_BASE` | `https://storage.googleapis.com/mediapipe-models/` | MediaPipe `.task` modelleri; göreli değer (ör. `mediapipe/`) alt yol altında da çalışır |
| `VITE_MEDIAPIPE_WASM_BASE` | derlemedeki kopya (`/assets`) | MediaPipe wasm çalışma zamanını başka bir dizinden vermek için |
| `VITE_MEDIAPIPE_POSE_MODEL` | `full` | `lite` (~5.5 MB) / `full` (~9 MB) / `heavy` (~29 MB); bulunamazsa lite'a düşer |
| `VITE_MEDIAPIPE_DELEGATE` | `auto` | `auto` (GPU; WebGL2 yoksa ya da yazılım çiziciyse CPU) / `GPU` / `CPU` |
| `VITE_REPO_URL` | boş | Üst çubuktaki kaynak kodu bağlantısı (boşsa gizli) |

### Üretim

```bash
npm run build                # tsc + vite build → dist/
npm start                    # --production: API + dist/ aynı porttan (varsayılan 8787), tüm arayüzlerde
```

Gerçek bir alan adında sunarken `ALLOWED_HOSTS=<alan adınız>` ayarlayın (Host denetimi aksi halde 403 döndürür). Anahtarlı
sağlayıcılar sunucuya ulaşabilen herkese açıktır: önüne kimlik doğrulama koyun ve sağlayıcılarda harcama sınırı belirleyin.
`/assets/*` bir yıl önbelleklenir, `index.html` `no-cache`; metin/JS/CSS gzip'lenir; uzantısız yollar SPA'ya düşer, `/api/*` asla.
Not: `npm start` `tsx` kullanır (devDependency); üretim imajında dev bağımlılıkları kurulu olmalı ya da sunucuyu derleyin.
Derleme `dist/assets` altına ~27 MB'lık ORT wasm ve ~23 MB'lık MediaPipe wasm dosyalarını da bırakır (yalnızca kullanıldıklarında
indirilir; CDN gerekmez). Heykel (three-mesh-bvh) ve rig motoru (animasyon kütüphanesi, BVH/FBX yükleyiciler) ayrı parçalar
olarak ilk kullanımda yüklenir. ORT wasm'ı başka bir dizinden vermek için
`node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.{mjs,wasm}` dosyalarını örn. `public/ort/` altına kopyalayıp
`VITE_ORT_WASM_PREFIX=/ort/` ile derleyin.

### Statik demo (GitHub Pages)

`.github/workflows/deploy-pages.yml` `BASE_PATH=/<repo>/` ile derleyip yayınlar; sunucu yoktur. Tarayıcıda çalışan her şey
çalışır: tüm ML / sezgisel sürücüler, insan detayı, çok görünümlü füzyon, heykel, derinlik editörü, rig ve animasyon,
dışa aktarma ve **tarayıcıdan doğrudan çağrılabilen** sağlayıcılar (OpenAI, Gemini, fal.ai; CORS izin veriyorsa OpenAI uyumlu /
özel HTTP) kullanıcının kendi anahtarıyla. İş akışı `VITE_STATIC_DEMO=1` ile derler: sunucu yoklamaları hiç yapılmaz ("sunucu yok"
kabul edilir; bayraksız derlemede yoklama 404 alır ve sonuç aynıdır). Sunucu gerektiren kayıtlar (Stability, Replicate, Tripo,
yönetilen anahtarlar) "sunucu vekili gerekir" uyarısıyla devre dışı kalır; Tripo3D sürücüleri açıklamalarında "çevrimiçi demoda
çalışmaz" der ve seçilince Tripo3D için fal.ai anahtarıyla **AI sağlayıcı ile 3D** sürücüsünü önerir. Alt yol (`/3dmarker/`)
altında ML ve geometri worker'ları da `/<repo>/assets/` altından yüklenir.

### Testler

```bash
npm test                     # vitest: saf mantık (Node, DOM yok) — görüntü işleme, mesh, füzyon, insan detayı, heykel, rig,
                             # AI adaptörleri (sahte ağ), sunucu; src/ui testleri jsdom'da (`// @vitest-environment jsdom`)
npm run typecheck
npm run test:e2e             # Playwright: gerçek Chromium + SwiftShader WebGL; Vite ve API sunucusunu kendisi başlatır
npm run check                # hepsi
```

E2E testleri `tests/e2e/` altında; ekran görüntüleri `test-results/screenshots/` klasörüne yazılır.
Chromium yoksa `npx playwright install chromium` çalıştırın ya da `CHROMIUM_PATH=/yol/chrome` verin.
Portlar `E2E_WEB_PORT` (5173) ve `E2E_API_PORT` (8787) ile değişir; `CI` tanımlı değilse bu portlarda zaten çalışan sunucular
yeniden kullanılır. Testler (renk şeması testleri dışında) koyu şemayla çalışır.
Harici servisler taklit edilir ya da kesilir: Hugging Face ve MediaPipe model adresleri erişilemez (hata / geri düşüş yolları),
OpenAI `/v1/images/edits` ve `/v1/models` istekleri `page.route` ile yanıtlanır (`tests/e2e/png.ts` isteğin istemine göre her
görünüm için farklı bir karakter silueti çizer), Tripo API'si sahte yanıtlarla taklit edilir.

- `app.spec.ts` — sürücüler, canlı yeniden örme, dışa aktarma, ML hata yolu, Tripo, dil, telefon düzeni, renk şeması.
- `steps.spec.ts` — adım gezgini, çok görünüm engeli, AI hazırlık → görünümler → füzyon, heykel/derinlik, rig + GLB.
- `features.spec.ts` — sağlayıcı iletişim kutusu (bağlantı testi, anahtarların yalnızca "hatırla" ile kalıcı olması),
  stil + T-poz + tam gövde istemleri, görünüm üret / yükle / temizle, köşe renkli kapalı füzyon, MediaPipe erişilemezken insan
  detayı, heykel darbeleri + geri al, derinlik editörü, T-poz mankeninde otomatik rig + 3 animasyonun mesh'i deforme etmesi +
  BVH içe aktarma + animasyonlu GLB, 375 px'de tüm adımlar iki dilde.
- `shell.spec.ts` — düz fonlu opak görselin otomatik maskesi, örneklerin sürücü seçmesi, model indirme hatasında çevrimdışı
  sürücü düğmesi, 1440 px'de kesilmeyen adım sekmeleri, kamera hazır açıları, 375 px'de sekme kaydırma ipucu / adım altlığı /
  oluşturma sonrası modele kaydırma / görüntüleyicide `touch-action: pan-y`.
- `sculpt.spec.ts` — ekstrüde yıldızda alt bölme notu + dört fırçanın etkisi; derinlik editöründe Esc / İptal / × onayı.
- `human-detail.spec.ts` — MediaPipe indirmesi takılınca 4. adım kartında Türkçe / İngilizce neden, "Yeniden dene"nin yeniden indirmesi.
- `ml-stall.spec.ts` — Hugging Face hiç yanıt vermezken füzyonun siluetlere düşmesi (ikinci çalıştırma beklemeden) ve Depth
  Anything'in "yanıt vermiyor" hatası.
- `offload.spec.ts` — geometri worker'ı: füzyon ve otomatik rig worker'da, füzyon ortasında İptal, kapalı mesh; uzun görev
  süreleri günlüğe yazılır (makineye bağlı olduğu için doğrulanmaz).
- `fusion-robust.spec.ts` — elle çizilmiş görünümler (5. örnek): tutarlılık rozetleri ve kesik kenar bayrağı, füzyonun kollarını
  ve gövde oranlarını tutarlı örnekle karşılaştırma (`fusion-robust-arms.png`), Hizala paneli (kaydırıcı → yeniden puanlama, Otomatik
  hizala / Sıfırla, Esc ile odak), güven modları (yalnız renk → rapor çipi; hepsi kapalı → Oluştur engeli), İstemi kopyala (pano +
  yedek metin kutusu), birleştirme raporu, T-poz örneklerinde ellerde yan görünüm rengi (mavi) yok, 375 / 414 px'de yatay taşma yok.

Saf mantık tarafında `src/core/fusion/*.test.ts` hizalamayı (ölçek / kayma / kesik senaryoları, sanatçı gürültüsü, ayna, düz siluet),
korumayı, derinlik kalibrasyonunu ve `reconstruct`'ı prosedürel T-poz fikstürleriyle (`testing.ts`: analitik doğruluk hacmi, kol /
bacak / gövde ölçümleri) sınar; `LEGACY_FUSION_OPTIONS` ile eski çıktı bire bir yeniden üretilir.

## Yeni bir sürücü eklemek

1. `Driver` arayüzünü uygulayın (`src/core/types.ts`). Sürücü üç sonuçtan birini döndürür:
   `{ kind: 'depth', depth, mask }` (ortak mesh kurucusu ve canlı mesh ayarları devreye girer),
   `{ kind: 'geometry', geometry }` (hazır `BufferGeometry`, ortak çerçevede) ya da `{ kind: 'model', glb }`.
2. Parametreleri `ParamSpec[]` olarak tanımlayın; arayüz formu otomatik üretilir (number / boolean / select / text, `secret` destekli).
3. Uzun işlerde `signal`'e uyun (`throwIfAborted(signal)`), `onProgress({ label: {tr, en}, ratio })` ile ilerleme bildirin.
   Ana iş parçacığındaki uzun, senkron bir adımdan önce `await yieldToPaint()` (`src/core/yield.ts`) çağırın: etiket ekrana gelir
   ve bu sırada basılan İptal / Esc işlenir.
   Kullanıcıya gösterilecek hatalar için `LocalizedError` (`src/core/errors.ts`) kullanın.
4. İlgili kategori listesine ekleyin: `src/drivers/ml/index.ts`, `src/drivers/heuristic/index.ts`,
   `src/drivers/multiview/index.ts` veya `src/drivers/cloud/index.ts`. `DRIVERS` listesi (açılır liste) buradan oluşur.
   Saf mantığı yanında `*.test.ts` ile test edin.
5. Ek görünümleri kullanan sürücüler `input.views` (`ViewSet`; `front` her zaman kaynak görseldir) okur ve `views: 'optional' | 'required'`,
   `minViews` ile ne istediğini bildirir (arayüz eksik görünümleri adıyla söyler ve 3. adıma bağlantı verir).
   Geometri sonucuna `color` özniteliği eklenirse model doku yerine köşe renkleriyle gösterilir ve dışa aktarılır.

```ts
import type { Driver } from '../../core/types';
import { throwIfAborted } from '../../core/types';
import { luminance } from '../../core/image/ops';

export const myDriver: Driver = {
  id: 'my-driver',
  name: { tr: 'Benim sürücüm', en: 'My driver' },
  description: { tr: 'Parlaklıktan basit derinlik.', en: 'Simple depth from brightness.' },
  category: 'heuristic',
  badges: ['offline'],
  producesDepth: true,
  params: [{ kind: 'number', key: 'gain', label: { tr: 'Kazanç', en: 'Gain' }, min: 0, max: 2, step: 0.1, default: 1 }],
  async run({ image, mask, params, signal }) {
    throwIfAborted(signal);
    const data = luminance(image).map((v) => Math.min(1, v * Number(params.gain)));
    return { kind: 'depth', depth: { width: image.width, height: image.height, data }, mask };
  },
};
```

Yeni bir **AI sağlayıcı türü** için `src/ai/kinds.ts`'e bir `ProviderKind` ve `src/ai/adapters/`'a bir `ProviderAdapter`
ekleyin (yetenekler: `image-edit`, `background-removal`, `image-to-3d`, `multiview-to-3d`); arayüz ve ayarlar kayıttan otomatik oluşur.
CORS desteklemeyen API'ler için vekilin sabit adres listesine (`AI_PROXY_BASES`, `src/drivers/cloud/api.ts`) bir temel adres ekleyin.

Sunucu tarafında çalışan yeni bir bulut sağlayıcı (ör. kendi GPU sunucunuzda TripoSR) için `server/providers/tripo.ts` ve
`server/app.ts`'deki desen izlenebilir: istemci sürücüsü yalnızca kendi `/api/...` uçlarımızla konuşur ve her istekte
`CLIENT_HEADER` başlığını gönderir (`src/drivers/cloud/api.ts`; sunucu bu başlık olmadan gelen istekleri çapraz site sayıp reddeder),
anahtarlar sunucuda kalır.

## Proje yapısı

```
src/
  core/            sözleşmeler (types, errors, yield), görüntü işleme (image/), mesh kurucu ve istatistik (mesh/),
                   dışa aktarım (export/, deri + animasyonlu GLB), AI arka plan kaldırma (preprocess/),
                   fusion/ (çok görünümlü füzyon: çerçeve + kesik kenarlar (frame), profil hizalama (align), görsel gövde (volume),
                   ince parça koruması (guard), derinlik oyma (depthCarve), marching cubes, renk, rapor (reconstruct)),
                   human/ (MediaPipe algılama, yüz/el/vücut kabartması, işaret noktası kaplaması)
  ai/              sağlayıcı kayıtları (kinds, settings), adaptörler (adapters/), taşıma (transport: doğrudan / vekil),
                   60 stil (styles), istemler (prompts), kullanıcı görünüm istemi (viewPrompts: "İstemi kopyala"),
                   iş akışı (generate: ön görsel, görünümler, saydamlık)
  drivers/         ml/ (transformers.js depth + worker istemcisi + insan detayı), heuristic/ (inflate, extrude, luminance),
                   multiview/ (füzyon), cloud/ (tripo, tripo çok görünüm, AI sağlayıcı ile 3D)
  sculpt/          heykel oturumu, fırçalar, BVH, geçmiş; derinlik fırçaları ve derinlik çizimi
  rig/             insansı kemikler, otomatik eklemler, iskelet, deri ağırlıkları, animasyon kütüphanesi (animations/),
                   içe aktarma + yeniden hedefleme, oynatıcı, eklem düzenleyici (engine.ts ile tembel yüklenir)
  workers/         ml.worker.ts (transformers.js boru hatları, WebGPU/WASM seçimi, önbellek, kuyruk, indirme takılma süresi),
                   geometry.worker.ts (füzyon + deri ağırlıkları; geometryClient: iptal, çökme, ana iş parçacığına geri düşüş)
  app/             DOM'suz uygulama mantığı: pipeline, store (reducer), steps, viewer (three.js), i18n, örnekler
  ui/              React bileşenleri; ai/ (sağlayıcı iletişim kutusu, stil seçici, hazırlık, görünümler), sculpt/, rig/
server/            Hono API: Tripo vekili (+ çok görünüm), ai/ (sağlayıcı listesi, AI vekili, çıktı indirme), relay, hız limiti
tests/e2e/         Playwright uçtan uca testleri (+ png.ts: sahte AI çıktıları için küçük PNG kodlayıcı)
```

## Sınırlamalar

- **2.5D ve tam 3B farkı:** Tek görselden çalışan derinlik ve sezgisel sürücüler yalnızca görünen yüzü üretir; `solid`/`double`
  kapalı bir mesh verir ama arka yüz gerçekte yeniden oluşturulmaz. Tam 3B için görünümleri ekleyip **çok görünümlü füzyon**,
  Tripo3D ya da bir AI image-to-3D modeli kullanın.
- **Füzyon:** görünümler ortografik kabul edilir (perspektifi hizalama ve tolerans emer); hiçbir görünümün derinliğinin
  görmediği içbükey oyuklar kurtarılamaz; yalnızca siluetle (derinlik modeli inemezse) gövdenin önündeki ince parçalar yuvarlak
  kesite kırpılır, gerçekte yassı olan bir parça (ör. geniş kanat) bu yüzden incelebilir. Renk: aynı yüzeyi eşit iyi gören iki
  görünüm çelişirse dikişte karışım kalır; pozlama eşitlemesi 255'te kırpılmış (aşırı pozlanmış) kanalları kurtaramaz; yalnızca
  yan görünümün gördüğü küçük bir kol ucunda renk komşulardan yayılabilir. Derinlik ölçeği yan / üst / alt görünüm varsa siluet
  gövdesine göre kalibre edilir; profil bilgisi vermeyen bir görünüm oymaz. Füzyon Worker'da çalışır; ana iş parçacığında kalanlar:
  oluşturmadan önceki görsel hazırlığı ve Hizala önizlemesi (~0.1–0.18 s) ile sonda geometrinin görüntüleyiciye aktarılması ve ilk
  çizim (gölgelendirici derleme; SwiftShader'da 0.1–0.3 s). Renk adımı altı 1024² görünümde ~0.2 s ekler (tüm füzyon ~1.4 s).
- **Hizalama ve tutarlılık kontrolü:** hizalama, paylaşılan eksenlerdeki 1B siluet profilleriyle çalışır: ölçek, kayma ve kesik
  çerçeveyi düzeltir, **içerik farkını düzeltmez** — A-poz ile T-poz farkı, farklı kıyafet ya da yan görünümde kolun başka
  yükseklikte çizilmesi (yan siluet kol yüksekliğini doğrulayamaz; rozet bunu "Yan görünüm kol yüksekliğini doğrulayamaz" notuyla
  söyler). Böyle durumlarda ince parça koruması kolları tutar, ama yanlış yerde bir kol diski gövdeyi girintileyebilir; çözüm aynı
  poz, "Yalnız renk" ya da elle hizalama. Paylaşılan eksenin iki ucu da kesik ve profil eşleşmesi yoksa görünüm yalnız renk için
  kullanılır. Yanlış yuva / kopya / ayrıntısız denetimleri sezgiseldir: sol–sağ ya da üst–alt yuvaların yer değiştirmesi siluetten
  ayırt edilemez (sol–sağ için yalnızca "ters yön" denetimi vardır); yanlış yuva denetimi yan yuvalarda ön görsel figür gibi
  görünüyorsa çalışır; iki görünümü karşılaştıran denetimler ön kontrol rozetinde değil yalnızca raporda görünür. Ayna algısı (arka
  görünüm ters yüklenmiş) yalnızca ön siluet belirgin ölçüde asimetrikse çalışır. Kesik kenar tanıma kenara değme sezgisine
  dayanır (kenar satırında ≥ 2 px ve bbox kenarının ≥ %2'si). Ön kontrol rozeti 1. adımdaki önizleme maskesini kullanır; esas
  değerler oluşturmadan sonraki birleştirme raporundadır. Elle hizalama sınırları: kayma ±%20 (çekirdek ±%25), ölçek %70–140
  (çekirdek 0.5–2). Tek ekseni kesik bir arka görünümde önizleme, kesik olmayan ekseni de aynı ölçekle gösterir (çekirdek o eksende
  kendi genişliğini kullanır). Yan ve üst / alt görünümler arasında Z ekseninde hizalama yapılmaz.
- **AI görünümleri tutarlılığı:** Görüntü modelleri arka/yan görünümleri "hayal eder"; ölçek ve çerçeve farkları füzyonda
  hizalanır ama anatomi/kıyafet tutarsızlıkları mesh'e yansır. Görünümleri elle düzeltmek (yeniden üret / yükle) mümkündür.
- **İnsan detayı:** İlk kullanımda ~20 MB MediaPipe modeli indirilir (görselde insan olmasa da; parametreden kapatılabilir).
  Çok küçük, bulanık ya da dönük yüzlerde yüz ağı hatalı olabilir; ten rengine yakın arka planlarda kulak kabartması taşabilir.
  Algılama çağrıları ana iş parçacığını kısa süre (CPU'da ~100–300 ms) bloklar. Yüz / el bölgesi inceltmesi mesh kurulumunu
  ~0.3–0.45 s'ye çıkarır. Derinlik editöründe (5. adım) uygulanan bir düzenleme bölgeleri taşımaz: o yeniden kurulumda yüz ve
  eller yine yumuşatılır. 2. adımdaki algılama çipinde "Yeniden dene" yoktur (yalnızca "İnsan olarak ayarla").
- **Heykel:** oturum kurulumu (kaynak + BVH) büyük mesh'lerde ~0.8 s ana iş parçacığını bloklar; kaba mesh'in alt bölünmesi
  buna ~0.1 s ekler. Dokunmatik ekranda ikinci parmak
  ilk dokunuştan hemen sonra (300 ms / 12 px içinde) gelirse darbe geri alınır ve iki parmak görünüme (yakınlaştır / döndür)
  verilir; daha sonra gelirse darbe korunur. Düzenle adımından çıkıp dönünce geri al geçmişi korunur. Derinlik modelinde mesh
  seçeneklerini değiştirmek heykel düzenlemelerini siler.
- **Rig:** vücut noktaları olmadan siluet kuralları T-pozu ve aşağı sarkan / A-pozlu kolları tanır (diğer pozlar kolları aşağı
  sarkan oransal iskelet alır; eklem düzenleyiciyle düzeltilir). Parmak kemikleri yalnızca el noktaları algılanırsa oluşur.
  Deri ağırlıkları geometri worker'ında hesaplanır (mesh bir kez hazırlanır, her eklem düzenlemesi orada yeniden ağırlıklanır);
  ana iş parçacığında kalanlar: animasyon kütüphanesinin zemin geçişi (~0.3 s tek görev) ve iskeletli mesh'in ilk çizimi.
  İnsana benzemeyen şekiller için rigden önce onay istenmez, uyarı sonradan gösterilir. Yerdeki kliplerde vücut zemine oturtulur
  (uçma / yüzme hariç); tek seferlik klipler (ör. düşme) "Döngü" açıkken de bir kez oynar.
- **ML derinliği göreli:** Depth Anything / MiDaS ölçeksiz derinlik verir; metrik ölçü beklemeyin. Modeller ilk kullanımda
  Hugging Face'ten indirilir (~50–490 MB); engelliyse `VITE_MODEL_HOST` ile ayna kullanın, erişilemezse anlaşılır hata gösterilir.
  Yanıt vermeyen bir indirme `VITE_MODEL_STALL_MS` (30 s) sonra "Model indirmesi yanıt vermiyor…" hatasıyla biter (WebGPU'da
  takılma WASM'da ikinci kez beklenmez) ve 5 dakika boyunca aynı model beklemeden hata verir.
- **Çift yüzlü (double) mod:** kenar yüksekliği siluet kenarına doğru sıfıra indirilir ve ön / arka yüz yuvarlak tek bir dikişte
  buluşur; "Düz (kurabiye)" şişirme profilinde kenar ızgaradan dik olduğu için yüksek duvar kalır.
- **WebGPU:** yoksa ya da hata verirse WASM'a düşülür (daha yavaş). `CROSS_ORIGIN_ISOLATION=1` WASM'ı çok iş parçacıklı yapar.
- **AI arka plan kaldırma (yerel):** MODNet portre için eğitilmiştir ve sert maske üretir (kenar yumuşatma yok).
- **Özel HTTP sağlayıcı:** yalnızca tek eşzamanlı, tarayıcıdan doğrudan istek (kuyruk/sorgulama yok).
- **Hız limitleri** bellek içidir (tek sunucu örneği).
- **Dokular:** GLB dokuyu / köşe renklerini taşır; OBJ (MTL yok), STL ve PLY doku taşımaz. STL varsayılan olarak en uzun kenar 100 mm.

### Doğrulanamayan API ayrıntıları (ASSUMPTION)

Geliştirme ortamında sağlayıcı API'lerine erişim yoktu; biçimler SDK kaynaklarından (openai-node 7.23, @google/genai 2.24,
@fal-ai/client 1.10, replicate 1.4, @mediapipe/tasks-vision) doğrulandı. Doğrulanamayanlar kodda `ASSUMPTION:` ile işaretli ve
ayarlardan / ortam değişkenlerinden değiştirilebilir:

- **Stability AI:** v2beta uç nokta yolları, alan adları ve `Authorization: Bearer` başlığı.
- **Replicate:** önerilen modellerin girdi adları; topluluk modellerinin `:version` gerektirip gerektirmediği.
- **fal.ai:** girdilerin data URI olabileceği; bağlantı testinin anahtarı nasıl denetlediği.
- **Gemini:** yalnızca görsel çıktının (`responseModalities: ['IMAGE']`) her görsel modelinde çalıştığı.
- **OpenAI:** `input_fidelity`'yi hangi modellerin kabul ettiği (mini ve GPT dışı modellere gönderilmez).
- **Tripo3D:** model sürüm kimlikleri; çok görünüm görevinin dosya sırası (`TRIPO_MULTIVIEW_ORDER`) ve boş yuva biçimi;
  ayrıca mevcut Tripo uç nokta yolları (`server/providers/tripo.ts`).
- **Çok görünümlü modellerde "sol":** öznenin mi kameranın mı solu — sürücülerde "sol/sağı değiştir" seçeneği var.
- **Çıktı CDN hostları** (`AI_FETCH_ALLOWED_HOSTS` ile değiştirilebilir).
- **MediaPipe:** `full`/`heavy` poz modeli adresleri (bulunamazsa lite'a düşer); el yönü etiketinin aynalı olduğu
  (yakın bir vücut pozu varsa o karar verir); yazılım GPU algılaması (tarayıcının bildirdiği çizici adı).
- **Rig:** gerçek ikili Mixamo FBX dosyaları (aynı yükleyici, metin FBX örneğiyle test edildi); MediaPipe `z` değerleri eklem
  derinliği için kullanılmaz.

## Lisanslar ve notlar

- **Depth Anything V2 Small** Apache-2.0; **Base** CC-BY-NC-4.0'dır (ticari SaaS'ta kullanmayın ya da lisans alın).
- **MediaPipe** Tasks Vision çalışma zamanı ve face / hand / pose landmarker modelleri Apache-2.0 (Google); modeller Google'ın
  genel deposundan indirilir (`VITE_MEDIAPIPE_MODEL_BASE` ile kendi sunucunuzdan verilebilir).
- **three.js**, **three-mesh-bvh** MIT; **@huggingface/transformers** Apache-2.0; **Hono** MIT.
- **Stil istemleri** marka / ticari marka adı içermez (ör. "Blocky toy figure", "Vinyl collectible figure"; belirli bir oyuncak markasının figür tarifi de yok); bir test bunu denetler.
- Hazır animasyonlar projede prosedürel olarak yazılmıştır (dışarıdan hareket verisi yok). İçe aktarılan BVH / FBX (ör. Mixamo)
  dosyalarının lisansı kullanıcının sorumluluğundadır.
- AI sağlayıcılarına gönderilen görseller o sağlayıcının koşullarına tabidir; tarayıcı içi sürücüler görseli hiçbir yere yüklemez.

## SaaS yol haritası

1. **Kimlik doğrulama:** e-posta/OAuth girişi (ör. Auth.js / Clerk), oturum, ekip hesapları.
2. **Faturalandırma ve kredi:** Stripe abonelik + kullandıkça öde kredisi; bulut/GPU/AI işleri kredi düşer, tarayıcı içi sürücüler ücretsiz kalır.
   Kullanıcı başına kota ve hız limiti (Redis), kötüye kullanım koruması; sunucu anahtarlı AI sağlayıcıları için kullanıcı başına bütçe.
3. **İş kuyruğu + GPU işçileri:** BullMQ/Redis veya SQS kuyruğu; kendi barındırdığımız modeller için GPU işçileri:
   **TripoSR**, **Stable Fast 3D (SF3D)**, **Hunyuan3D-2**, **TRELLIS**, çok görünümlü üretim (Zero123++ / MV-Adapter).
   Her biri `{ kind: 'model', glb }` sözleşmesiyle bir sürücü olarak eklenir; ilerleme SSE/WebSocket ile.
4. **Depolama:** Yüklenen görseller ve üretilen GLB'ler için S3/R2 + imzalı URL'ler, saklama süresi politikası, CDN.
5. **Galeri ve paylaşım:** Kullanıcının model geçmişi, herkese açık paylaşım sayfaları, `<model-viewer>` gömme kodu, AR (USDZ).
6. **Kalite:** animasyon kütüphanesi zemin geçişini de worker'a taşıma, retopoloji/decimation, doku pişirme (köşe renginden UV dokuya),
   metrik derinlik modelleri, yüz/el detayının çok görünümlü füzyona da uygulanması.
7. **Operasyon:** Gözlemlenebilirlik (OpenTelemetry), hata izleme (Sentry), Docker imajı, CI'da `npm run check`.
