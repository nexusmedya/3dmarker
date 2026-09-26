# 3D Marker — Görselden 3D'ye (tarayıcıda)

> **English summary.** 3D Marker is a browser-based image-to-3D SaaS prototype (in the spirit of tripo3d.ai).
> A six-step studio: **1** upload an image (background from PNG alpha, a plain border or an in-browser AI matte) →
> **2** optional AI preparation with your own provider keys (60 style presets, T-pose, completing a cropped body,
> transparent background) → **3** the other views (back / left / right / top / bottom), uploaded or AI-generated →
> **4** a *driver* turns them into a mesh: in-browser depth models (Depth Anything V2, MiDaS; faces, noses, lips,
> ears, hands and fingers get extra relief from MediaPipe landmarks), instant heuristics, **multi-view fusion**
> (a closed, vertex-coloured full-3D mesh from several views, entirely in the browser) or cloud models (Tripo3D,
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
| **1 Görsel** | Görsel yükleme / yapıştırma / örnekler; arka plan: PNG alfa, düz kenar rengi, yapay zekâ (MODNet) ya da yok |
| **2 AI hazırlık** (isteğe bağlı) | Kendi sağlayıcınızla görseli **60 stilden** birine çevirme, **T-poz**, **eksik gövdeyi tamamlama** (ör. yalnızca kafa → tam boy), saydam arka plan; önce/sonra karşılaştırma, kabul et / vazgeç / orijinale dön |
| **3 Görünümler** | Tam 3B için **arka, sol, sağ, üst, alt** görünümler: elle yükleyin ya da yapay zekâya ürettirin ("Eksikleri üret") |
| **4 3D** | Sürücü seçimi, parametreler, canlı mesh ayarları; "3D Oluştur" her adımdan erişilebilir (Ctrl/⌘ + Enter; heykel modunda ve metin alanlarında devre dışı). Heykel / rig / derinlik düzenlemesi taşıyan modeli yeniden oluşturmadan önce onay istenir |
| **5 Düzenle** | Blender tarzı **heykel** fırçaları (8 fırça, simetri, geri al) ve **derinlik haritası editörü** |
| **6 Rig & Anim** | Otomatik insansı iskelet, eklem düzenleyici, **45 hazır animasyon**, BVH / FBX / GLB içe aktarma, animasyonlu GLB |

- Yapay zekâ derinlik modelleri (Depth Anything V2, MiDaS) ve insan algılama (MediaPipe) **kullanıcının tarayıcısında** çalışır; sunucuya görsel gitmez.
- **İnsan detayı:** yüz (478 nokta), eller (21 nokta) ve vücut (33 nokta) algılanır; burun, göz çukurları, dudaklar, çene, kulaklar, parmaklar ve kollar derinlik haritasına ek kabartma olarak eklenir — yüzler artık dümdüz çıkmaz.
- **Çok görünümlü füzyon** (`multiview-fusion`): ön + diğer görünümlerden kapalı (watertight), köşe renkli tam 3B mesh — tamamen tarayıcıda.
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
| **Çok görünümlü füzyon** (`multiview-fusion`) | Çok görünüm, tarayıcı | geometri, köşe renkli, **tam 3B** | evet | ~50 MB (derinlik iyileştirme; isteğe bağlı) | 1–3 s (144 voksel) | Ön + arka/yan görünümleri olan karakterler, nesneler | Ön + en az 1 görünüm |
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
  ek talimatlar tekrarlanarak üretilir), **Orijinale dön** her zaman mümkündür.

## Çok görünümlü iş akışı

1. Görseli yükleyin (ve isterseniz 2. adımda stil / T-poz uygulayın).
2. **3 Görünümler:** her yuva için yükle (⤒), AI ile üret (✎) ya da temizle (×). "Eksikleri üret" boş yuvaları sırayla üretir;
   her yeni görünüm öncekileri referans alır (tutarlılık). Yüklenen görünümlerin maskesi alfa kanalından ya da düz kenar
   renginden çıkarılır; arka plan modu "AI" ise gerekirse MODNet ile kaldırılır (başka bir iş sürüyorsa sıraya alınır).
   AI hazırlığı kabul edildiğinde (ya da orijinale dönüldüğünde) eski ön görselden AI ile üretilen görünümler kaldırılır;
   yüklenen görünümler kalır. Seçili sürücü görünümleri kullanmıyorsa 3. ve 4. adımda füzyona geçiş önerilir.
3. **4 3D:** `multiview-fusion` (tarayıcıda), `tripo3d-multiview` ya da `ai-provider-3d` seçin.
   Füzyon: her görünümün siluet kutusu nesne kutusunun ilgili yüzüne hizalanır (farklı ölçek/çerçeve tolere edilir), yumuşak
   görsel gövde voksel ızgarada kesişir, isteğe bağlı olarak her görünümde Depth Anything ile oyulur (model inemezse siluet
   gövdesine düşer ve uyarır), marching cubes + Taubin yumuşatma ile kapalı mesh, görünürlük kontrollü köşe renkleri.
   Parametreler: voksel çözünürlüğü (64–256), gövde toleransı, derinlik iyileştirme / modeli / gücü, yumuşatma, renk keskinliği,
   üçgen sınırı.

## İnsan detayı (yüz, burun, kulak, dudak, el, parmak)

ML derinlik sürücülerinde **İnsan detayı** (varsayılan açık) MediaPipe Tasks Vision ile yüz (478 nokta), el (21 nokta) ve
vücut (33 nokta) algılar ve derinliğe ek kabartma ekler: yüz ağı (852 üçgen) üzerinden burun, göz çukurları, dudaklar,
yanaklar, çene; ten rengindeki piksellerde kulaklar (baş 40°'den fazla dönükse atlanır); parmaklar ve kollar kapsül olarak,
avuç ve gövde kubbe olarak. Yalnızca modelin derinliğinde eksik olan ayrıntı eklenir. Küçük yüzler vücut pozundan kırpılarak
yeniden aranır; "Yüksek çözünürlüklü kırpma" yüz/el bölgelerinde derinliği ayrıca hesaplar. Ayarlar: yüz gücü (0.8), el gücü (0.7).
Algılama ana iş parçacığında, derinlik çıkarımıyla paralel çalışır; modeller inemezse (ör. ağ engeli) "Algılama kullanılamıyor"
gösterilir ve düz derinlikle devam edilir; yavaş (≥5 s, ör. indirme takılması) bir model yükleme hatası 5 dakika hatırlanır, bu
sürede sonraki çalıştırmalar beklemeden düz derinliğe geçer (hızlı ağ hataları her seferinde yeniden denenir). Kırpma geçişi
yalnızca küresel geçişten daha ince çözünürlük verecekse yapılır. Bilinen sınır: varsayılan mesh çözünürlüğü / yumuşatmada
parmaklar ve kulaklar yumuşayabilir; ayrıntı için "Canlı mesh" çözünürlüğünü artırıp yumuşatmayı azaltın. Sonuç 2. ve 4. adımda (algılanan yüz/el/vücut sayısı) görünür; 2. adımda algılama
yalnızca hazırlığı çalıştırabilecek bir sağlayıcı varken kendiliğinden başlar (gereksiz ~20 MB indirmeyi önler).

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

**Derinlik haritası editörü** (derinlik sonuçları için): Yükselt / Alçalt / Yumuşat / Düzleştir / Geri yükle fırçaları,
yarıçap, güç, düşüş eğrisi, "yalnızca özne içinde", gri / renkli görünüm, görsel kaplama, önce/sonra, yakınlaştırma
(tekerlek), kaydırma (Boşluk + sürükle). En yakın noktalar da yükseltilebilir: uygulamada harita yeniden `[0,1]`'e ölçeklenir.
**Uygula** yeni derinlikten modeli yeniden kurar (canlı mesh ayarları çalışmaya devam eder).

## Rig ve animasyon (6. adım)

- **Otomatik iskelet:** 23+ kemikli insansı iskelet (Mixamo adları: `Hips`, `Spine`, `LeftArm`, `LeftForeArm`, `LeftUpLeg`…;
  el noktaları algılanırsa parmaklar). Eklemler önce MediaPipe vücut pozundan, yoksa kolları aşağıda / T-poz siluetinden, o da
  olmazsa oranlardan yerleştirilir. Deri ağırlıkları mesafe + iç görünürlük testiyle, köşe başına 4 kemik.
- **Eklem düzenleyici:** eklemleri görünümde sürükleyin ya da X/Y/Z ile dürtün (ayna seçeneğiyle); her değişiklik ağırlıkları yeniler.
- **45 hazır animasyon** (bekleme, yürüyüş/koşu, jestler, duygular, dans, aksiyon, pozlar): oynat / duraklat / durdur (T-poza döner),
  zaman çubuğu, hız, döngü, geçiş (cross-fade), arama ve kategori filtresi. Klipler kanonik T-pozda yazılır ve dinlenme yönlerine
  göre aktarılır; A-pozlu iskeletleri de doğru sürer.
- **İçe aktarma:** `.bvh`, `.fbx` (Mixamo dahil), `.glb`/`.gltf`. Kemik adları Mixamo, klasik/CMU/SecondLife BVH, Unity, Unreal ve
  Rigify düzenlerinden eşlenir; kaynağın yukarı/ileri eksenleri iskeletten bulunur; kalça hareketi bacak boyuna göre ölçeklenir,
  döngüler yerinde kalır.
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
özel HTTP) kullanıcının kendi anahtarıyla. `/api/ai/providers` yoklaması 404 alır → "sunucu yok" kabul edilir; sunucu gerektiren
kayıtlar (Stability, Replicate, Tripo, yönetilen anahtarlar) ve Tripo sürücüleri iki dilde "sunucu gerekir / ulaşılamıyor"
açıklamasıyla devre dışı kalır.

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
                   fusion/ (çok görünümlü füzyon: hizalama, görsel gövde, derinlik oyma, marching cubes, renk),
                   human/ (MediaPipe algılama, yüz/el/vücut kabartması, işaret noktası kaplaması)
  ai/              sağlayıcı kayıtları (kinds, settings), adaptörler (adapters/), taşıma (transport: doğrudan / vekil),
                   60 stil (styles), istemler (prompts), iş akışı (generate: ön görsel, görünümler, saydamlık)
  drivers/         ml/ (transformers.js depth + worker istemcisi + insan detayı), heuristic/ (inflate, extrude, luminance),
                   multiview/ (füzyon), cloud/ (tripo, tripo çok görünüm, AI sağlayıcı ile 3D)
  sculpt/          heykel oturumu, fırçalar, BVH, geçmiş; derinlik fırçaları ve derinlik çizimi
  rig/             insansı kemikler, otomatik eklemler, iskelet, deri ağırlıkları, animasyon kütüphanesi (animations/),
                   içe aktarma + yeniden hedefleme, oynatıcı, eklem düzenleyici (engine.ts ile tembel yüklenir)
  workers/         ml.worker.ts (transformers.js boru hatları, WebGPU/WASM seçimi, önbellek, kuyruk)
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
  görmediği içbükey oyuklar kurtarılamaz; yalnızca siluetle (derinlik modeli inemezse) T-pozdaki kollar gibi ince parçalar yan
  görünümlerde gövdeyle örtüştüğü için derinlemesine kalınlaşabilir ve (fotometrik tutarlılık adımı olmadığından) bu hayalet
  hacme yan görünüm renkleri taşabilir. Derinlik ölçeği yan / üst / alt görünüm varsa siluet gövdesine göre kalibre edilir;
  profil bilgisi vermeyen bir görünüm oymaz. İş ana iş parçacığında dilimler hâlinde yapılır (~30 ms'de bir yol verir, en uzun
  duraklama ~70 ms; İptal aşama ortasında etkili olur); ayrı bir Worker'a taşınmadı.
- **AI görünümleri tutarlılığı:** Görüntü modelleri arka/yan görünümleri "hayal eder"; ölçek ve çerçeve farkları füzyonda
  hizalanır ama anatomi/kıyafet tutarsızlıkları mesh'e yansır. Görünümleri elle düzeltmek (yeniden üret / yükle) mümkündür.
- **İnsan detayı:** İlk kullanımda ~20 MB MediaPipe modeli indirilir (görselde insan olmasa da; parametreden kapatılabilir).
  Çok küçük, bulanık ya da dönük yüzlerde yüz ağı hatalı olabilir; ten rengine yakın arka planlarda kulak kabartması taşabilir.
  Algılama çağrıları ana iş parçacığını kısa süre (CPU'da ~100–300 ms) bloklar.
- **Heykel:** oturum kurulumu (kaynak + BVH) büyük mesh'lerde ~0.8 s ana iş parçacığını bloklar. Dokunmatik ekranda ikinci parmak
  ilk dokunuştan hemen sonra (300 ms / 12 px içinde) gelirse darbe geri alınır ve iki parmak görünüme (yakınlaştır / döndür)
  verilir; daha sonra gelirse darbe korunur. Düzenle adımından çıkıp dönünce geri al geçmişi korunur. Derinlik modelinde mesh
  seçeneklerini değiştirmek heykel düzenlemelerini siler.
- **Rig:** vücut noktaları olmadan siluet kuralları T-pozu ve aşağı sarkan / A-pozlu kolları tanır (diğer pozlar kolları aşağı
  sarkan oransal iskelet alır; eklem düzenleyiciyle düzeltilir). Parmak kemikleri yalnızca el noktaları algılanırsa oluşur.
  Ağırlıklandırma ana iş parçacığında (zaman dilimli; 180k köşede `prepareSkinning` ~230 ms bloklar). Yerdeki kliplerde
  ayaklar zemine oturtulur (uçma / yüzme hariç); tek seferlik klipler (ör. düşme) "Döngü" açıkken de bir kez oynar.
- **ML derinliği göreli:** Depth Anything / MiDaS ölçeksiz derinlik verir; metrik ölçü beklemeyin. Modeller ilk kullanımda
  Hugging Face'ten indirilir (~50–490 MB); engelliyse `VITE_MODEL_HOST` ile ayna kullanın, erişilemezse anlaşılır hata gösterilir.
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
6. **Kalite:** füzyon ve ağırlıklandırmayı Web Worker'a taşıma, retopoloji/decimation, doku pişirme (köşe renginden UV dokuya),
   metrik derinlik modelleri, yüz/el detayının çok görünümlü füzyona da uygulanması.
7. **Operasyon:** Gözlemlenebilirlik (OpenTelemetry), hata izleme (Sentry), Docker imajı, CI'da `npm run check`.
