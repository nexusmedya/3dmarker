# 3D Marker — Görselden 3D'ye (tarayıcıda)

> **English summary.** 3D Marker is a browser-based image-to-3D SaaS prototype (in the spirit of tripo3d.ai).
> Upload a PNG/JPEG/WEBP, pick a *driver* (strategy) from a select box, and get a textured mesh in a three.js
> viewer that you can export as GLB / OBJ / STL / PLY. Drivers: in-browser ML depth estimation
> (Depth Anything V2 Small/Base, DPT-Hybrid MiDaS via transformers.js + ONNX Runtime Web, WebGPU with WASM
> fallback), instant offline heuristics (silhouette inflation, silhouette extrusion, luminance height map) and a
> cloud driver (Tripo3D API, full 3D) proxied through a small Hono server that keeps the API key server-side.
> Stack: Vite + React 19 + TypeScript, three.js, @huggingface/transformers, Hono. `npm ci --ignore-scripts && npm run dev`.

---

## Nedir?

3D Marker, bir PNG'yi (veya JPEG/WEBP) **tarayıcının içinde** 3B modele çeviren bir SaaS prototipidir.
Görseli yüklersiniz, açılır listeden bir **sürücü** (dönüştürme stratejisi) seçersiniz, "3D Oluştur"a basarsınız;
sonuç dokulu bir mesh olarak three.js görüntüleyicide açılır ve **GLB, OBJ, STL, PLY** olarak indirilebilir.

- Yapay zekâ derinlik modelleri (Depth Anything V2, MiDaS) **kullanıcının tarayıcısında** çalışır (WebGPU varsa GPU, yoksa WASM). Sunucuya görsel gitmez.
- Sezgisel sürücüler (şişirme, ekstrüzyon, parlaklık haritası) hiçbir şey indirmeden, anında ve çevrimdışı çalışır.
- Bulut sürücüsü (Tripo3D) görünmeyen arka yüzleri de tamamlayan **tam 3B** model üretir; API anahtarı sunucuda kalır.
- Arayüz Türkçe ve İngilizce; açık/koyu tema; ayarlar tarayıcıda saklanır (gizli anahtarlar hariç).

## Mimari

```
┌──────────────────────────────── Tarayıcı ─────────────────────────────────┐
│                                                                           │
│  UploadCard ──► loadImageFile ──► fitRGBA (≤1024 px çalışma görüntüsü)    │
│                                        │                                  │
│  Arka plan modu: PNG alfa │ düz kenar rengi (autoMask) │ AI (MODNet) │ yok │
│                                        ▼                                  │
│                         DriverInput { image, mask, file, params }         │
│                                        │                                  │
│   ┌────────────── DRIVERS (select listesi, src/drivers) ───────────────┐  │
│   │ ML (Web Worker)          │ Sezgisel (ana iş parçacığı) │ Bulut      │  │
│   │ transformers.js + ORT    │ inflate / extrude /         │ Tripo3D    │  │
│   │ WebGPU ⇢ WASM            │ luminance                   │ (fetch)    │  │
│   └──────────┬───────────────┴──────────────┬──────────────┴─────┬──────┘  │
│        { kind:'depth' }            { kind:'geometry' }    { kind:'model' } │
│              ▼                              │               GLB (ArrayBuf) │
│   buildGeometryFromDepth(depth, mask,       │                    │         │
│     MeshOptions: relief│solid│double)       │             GLTFLoader       │
│              └──────────────┬───────────────┴────────────────────┘         │
│                             ▼                                             │
│          ViewerCore (three.js, orbit, kil/tel kafes, derinlik önizleme)    │
│                             ▼                                             │
│          exportObject → GLB │ OBJ │ STL (mm ölçekli) │ PLY  ──► indirme     │
└────────────────────────────────┬──────────────────────────────────────────┘
                                 │ /api/*  (Vite dev proxy / aynı origin)
┌────────────────────────────────▼──────────────────────────────────────────┐
│  Hono sunucusu (server/)  :8787                                            │
│   GET  /api/health                GET /api/tripo/status                    │
│   POST /api/tripo/tasks (multipart "image")  → Tripo upload + görev        │
│   GET  /api/tripo/tasks/:id       GET /api/tripo/tasks/:id/model (GLB)     │
│   • TRIPO_API_KEY sunucuda; yoksa kullanıcının x-tripo-key başlığı          │
│   • IP başına hız limiti, boyut/MIME kontrolü, çapraz site POST engeli,     │
│     model indirmede izinli host listesi (SSRF koruması)                    │
│   • Üretimde dist/ klasörünü (SPA) de sunar                                │
└────────────────────────────────┬──────────────────────────────────────────┘
                                 ▼
                     api.tripo3d.ai (image → 3D)

 Model ağırlıkları: huggingface.co (ilk kullanımda indirilir, tarayıcı önbelleğinde tutulur)
 ONNX Runtime wasm: cdn.jsdelivr.net (varsayılan; VITE_ORT_WASM_PREFIX ile kendi sunucunuzdan)
```

Önemli sözleşmeler (`src/core/types.ts`):

- `DepthMap` değerleri `[0,1]`, **1 = izleyiciye en yakın**. `Mask`: 1 = ön plan. Görüntüler satır sıralı, üst satır önce.
- Geometri çerçevesi: +Y yukarı, +Z izleyiciye doğru, görüntünün uzun kenarı 2 birim, X/Y'de merkezde; UV (0,0) = sol alt.
- Tüm kullanıcı metinleri `I18nText { tr, en }`.

## Sürücüler

| Sürücü (id) | Tür | Çıktı | Kapalı mesh | İndirme | Hız | En iyi kullanım | Not / lisans |
|---|---|---|---|---|---|---|---|
| Depth Anything V2 Small (`depth-anything-v2-small`, varsayılan) | ML, tarayıcı | derinlik → mesh (2.5D) | solid/double modunda | ~50 MB (bir kez) | WebGPU'da hızlı, WASM'da daha yavaş | Fotoğraflar, sahneler, genel amaç | Apache-2.0 |
| Depth Anything V2 Base (`depth-anything-v2-base`) | ML, tarayıcı | derinlik (daha ayrıntılı) | solid/double | ~195 MB | Small'dan 3–4× yavaş | Kalite öncelikli | **CC-BY-NC-4.0 — ticari kullanım yok** |
| DPT Hybrid MiDaS (`dpt-hybrid-midas`) | ML, tarayıcı | derinlik (384×384 sabit) | solid/double | ~125–490 MB | orta | Karşılaştırma, yumuşak sahne derinliği | Intel DPT (model kartını kontrol edin) |
| Siluet şişirme (`silhouette-inflate`) | Sezgisel | derinlik (balon profili) → çift yüz | evet | yok | anında (~0.5 s) | Maskotlar, karakterler, çıkartmalar, logolar (saydam PNG) | Siluet gerekir |
| Siluet ekstrüzyon (`silhouette-extrude`) | Sezgisel | geometri (düz + pah) | evet | yok | anında | Logolar, ikonlar, yazılar, 3B baskı | Siluet gerekir |
| Parlaklık yükseklik haritası (`luminance-heightmap`) | Sezgisel | derinlik (parlaklıktan) | solid/double | yok | anında | Kabartma, litofan, doku, desen | Gerçek derinlik değil |
| Tripo3D (`tripo3d-cloud`) | Bulut API | GLB (tam 3B, dokulu) | evet | yok (sunucuda) | 1–3 dk | Gerçekçi, arkası da olan tam model | API anahtarı + kredi; görsel üçüncü tarafa gider |

Mesh seçenekleri (derinlik üreten sürücüler için, **canlı** — sürücüyü yeniden çalıştırmadan yeniden örer):
`mode` (relief = açık yüzey, solid = düz taban/baskıya uygun, double = aynalı arka), `resolution`, `depthScale`,
`gamma`, `smoothing`, `useMask`, `discontinuity` (relief'te derinlik sıçramalarında yırtma), `baseThickness`, `invert`.

### Hangi sürücüyü seçmeliyim?

- **Saydam PNG karakter/maskot** → Siluet şişirme (anında, kapalı, yuvarlak hacim).
- **Logo, ikon, yazı** → Siluet ekstrüzyon (net kenarlar, pah, baskıya hazır STL).
- **Fotoğraf / manzara** → Depth Anything V2 Small (relief veya solid).
- **Gerçek 3B nesne, arka yüzü de lazım** → Tripo3D (bulut).

## Çalıştırma

Gereksinimler: Node.js ≥ 22 (öneri 24), npm.

```bash
npm ci --ignore-scripts      # onnxruntime-node'un postinstall indirmesi gerekmiyor (tarayıcıda onnxruntime-web kullanılır)
npm run dev                  # Vite (http://localhost:5173) + API sunucusu (http://localhost:8787), birlikte
# ya da ayrı ayrı:
npm run dev:web
npm run dev:api
```

Tarayıcıda http://localhost:5173 adresini açın, örnek görsellerden birine tıklayın ve "3D Oluştur"a basın.

### Ortam değişkenleri

`.env.example` dosyasını `.env` olarak kopyalayın. Kabuktaki değişkenler `.env`'dekileri ezer.

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | `8787` | API/üretim sunucusu portu (Vite proxy'si de bunu kullanır) |
| `HOST` | tüm arayüzler | Dinlenecek adres |
| `STATIC_DIR` | `./dist` | Üretimde sunulan SPA klasörü |
| `TRIPO_API_KEY` | boş | Sunucu tarafı Tripo3D anahtarı. Boşsa kullanıcılar arayüzde kendi anahtarını girer |
| `TRIPO_API_BASE` | `https://api.tripo3d.ai/v2/openapi` | Tripo API adresi |
| `TRIPO_ALLOWED_MODEL_HOSTS` | `tripo3d.ai,tripo3d.com,tripo-data.cdn.bcebos.com` | GLB'nin indirilebileceği hostlar (alt alan adları dahil) |
| `TRIPO_RATE_LIMIT` / `TRIPO_RATE_LIMIT_BYOK` | `10` / `60` | IP başına pencere başına görev (sunucu anahtarı / kullanıcı anahtarı), 0 = sınırsız |
| `TRIPO_RATE_WINDOW_SEC` | `3600` | Hız limiti penceresi |
| `TRUST_PROXY` | kapalı | `1`: tek bir ters proxy arkasında, istemci IP'si son `X-Forwarded-For` |
| `CROSS_ORIGIN_ISOLATION` | kapalı | `1`: COOP + `COEP: credentialless` → ONNX Runtime çok iş parçacıklı WASM (CPU'da daha hızlı). Vite dev/preview ve üretim sunucusu uygular |
| `VITE_MODEL_HOST` | `https://huggingface.co/` | Model dosyaları için ayna (derleme zamanı) |
| `VITE_ORT_WASM_PREFIX` | jsDelivr | ONNX Runtime wasm dosyalarını kendi sunucunuzdan vermek için dizin (ör. `/ort/`) |
| `VITE_REPO_URL` | boş | Üst çubuktaki kaynak kodu bağlantısı (boşsa gizli) |

### Üretim

```bash
npm run build                # tsc + vite build → dist/
npm start                    # NODE_ENV=production: API + dist/ aynı porttan (varsayılan 8787)
```

`/assets/*` bir yıl önbelleklenir, `index.html` `no-cache`; uzantısız yollar SPA'ya düşer, `/api/*` asla.
Not: `npm start` `tsx` kullanır (devDependency); üretim imajında dev bağımlılıkları kurulu olmalı ya da sunucuyu derleyin.
Derleme `dist/assets` altına ~27 MB'lık bir ORT wasm kopyası da bırakır; varsayılan ayarda kullanılmaz (wasm jsDelivr'den gelir).
Kendi sunucunuzdan vermek için `node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.{mjs,wasm}` dosyalarını örn. `public/ort/`
altına kopyalayıp `VITE_ORT_WASM_PREFIX=/ort/` ile derleyin.

### Testler

```bash
npm test                     # vitest: saf mantık (Node, DOM yok) — görüntü işleme, mesh, dışa aktarım, sürücüler, sunucu
npm run typecheck
npm run test:e2e             # Playwright: gerçek Chromium + SwiftShader WebGL; Vite ve API sunucusunu kendisi başlatır
npm run check                # hepsi
```

E2E testleri `tests/e2e/` altında; ekran görüntüleri `test-results/screenshots/` klasörüne yazılır.
Chromium yoksa `npx playwright install chromium` çalıştırın ya da `CHROMIUM_PATH=/yol/chrome` verin.
E2E, Hugging Face'e erişimi bilerek keser (ML sürücüsünün hata yolunu test eder) ve Tripo API'sini sahte yanıtlarla taklit eder.

## Yeni bir sürücü eklemek

1. `Driver` arayüzünü uygulayın (`src/core/types.ts`). Sürücü üç sonuçtan birini döndürür:
   `{ kind: 'depth', depth, mask }` (ortak mesh kurucusu ve canlı mesh ayarları devreye girer),
   `{ kind: 'geometry', geometry }` (hazır `BufferGeometry`, ortak çerçevede) ya da `{ kind: 'model', glb }`.
2. Parametreleri `ParamSpec[]` olarak tanımlayın; arayüz formu otomatik üretilir (number / boolean / select / text, `secret` destekli).
3. Uzun işlerde `signal`'e uyun (`throwIfAborted(signal)`), `onProgress({ label: {tr, en}, ratio })` ile ilerleme bildirin.
   Kullanıcıya gösterilecek hatalar için `LocalizedError` (`src/core/errors.ts`) kullanın.
4. İlgili kategori listesine ekleyin: `src/drivers/ml/index.ts`, `src/drivers/heuristic/index.ts` veya `src/drivers/cloud/index.ts`.
   `DRIVERS` listesi (açılır liste) buradan oluşur. Saf mantığı yanında `*.test.ts` ile test edin.

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

Sunucu tarafında çalışan yeni bir bulut sağlayıcı (ör. kendi GPU sunucunuzda TripoSR) için `server/providers/tripo.ts` ve
`server/app.ts`'deki desen izlenebilir: istemci sürücüsü yalnızca kendi `/api/...` uçlarımızla konuşur, anahtarlar sunucuda kalır.

## Proje yapısı

```
src/
  core/            sözleşmeler (types, errors), görüntü işleme (image/), mesh kurucu ve istatistik (mesh/),
                   dışa aktarım (export/), AI arka plan kaldırma (preprocess/)
  drivers/         ml/ (transformers.js depth + worker istemcisi), heuristic/ (inflate, extrude, luminance), cloud/ (tripo)
  workers/         ml.worker.ts (transformers.js boru hatları, WebGPU/WASM seçimi, önbellek, kuyruk)
  app/             DOM'suz uygulama mantığı: pipeline, store (reducer), viewer (three.js), i18n, örnekler
  ui/              React bileşenleri
server/            Hono API (Tripo proxy, hız limiti, statik sunum)
tests/e2e/         Playwright uçtan uca testleri
```

## Sınırlamalar

- **2.5D ve tam 3B farkı:** Tarayıcıdaki derinlik sürücüleri ve sezgisel sürücüler yalnızca görünen yüzü üretir.
  `solid` modu düz bir taban, `double` modu aynalanmış bir arka ekler; bu kapalı ve baskıya uygun bir mesh verir ama
  **gerçek arka yüz yeniden oluşturulmaz**. Arkası da gerçekçi bir model için Tripo3D (veya yol haritasındaki GPU modelleri) gerekir.
- **ML derinliği göreli:** Depth Anything / MiDaS göreli (ölçeksiz) derinlik verir; metrik ölçü beklemeyin.
- **İlk kullanımda indirme:** ML sürücüleri model ağırlıklarını ilk kullanımda Hugging Face'ten indirir (~50–490 MB) ve
  tarayıcı önbelleğinde tutar; ONNX Runtime wasm'ı varsayılan olarak jsDelivr'den gelir. Kurumsal ağlarda bu adresler
  engelliyse `VITE_MODEL_HOST` / `VITE_ORT_WASM_PREFIX` ile ayna kullanın. Erişilemezse arayüz anlaşılır bir hata gösterir.
- **WebGPU:** Yoksa WASM'a düşülür (daha yavaş). `CROSS_ORIGIN_ISOLATION=1` WASM'ı çok iş parçacıklı yapar.
- **AI arka plan kaldırma:** Varsayılan model MODNet portre için eğitilmiştir; nesnelerde zayıf kalabilir.
  Saydam PNG veya düz renkli arka plan en iyi sonucu verir.
- **Tripo3D:** API anahtarı (sunucuda ya da kullanıcının kendi anahtarı) ve kredi gerektirir; görsel üçüncü taraf bir hizmete
  yüklenir. Uç nokta yolları ve yanıt biçimleri canlı API'ye karşı henüz doğrulanmadı (`server/providers/tripo.ts` içinde
  `ASSUMPTION` olarak işaretli). Hız limiti bellek içidir (tek sunucu).
- **Dokular:** GLB dokuyu taşır; OBJ (MTL yok), STL ve PLY doku taşımaz. STL varsayılan olarak en uzun kenar 100 mm olacak şekilde ölçeklenir.
- **Lisanslar:** Depth Anything V2 **Base** CC-BY-NC-4.0'dır (ticari SaaS'ta kullanmayın ya da lisans alın); Small Apache-2.0'dır.

## SaaS yol haritası

1. **Kimlik doğrulama:** e-posta/OAuth girişi (ör. Auth.js / Clerk), oturum, ekip hesapları.
2. **Faturalandırma ve kredi:** Stripe abonelik + kullandıkça öde kredisi; bulut/GPU işleri kredi düşer, tarayıcı içi sürücüler ücretsiz kalır.
   Kullanıcı başına kota ve hız limiti (Redis), kötüye kullanım koruması.
3. **İş kuyruğu + GPU işçileri:** BullMQ/Redis veya SQS kuyruğu; kendi barındırdığımız görselden-3B modeller için GPU işçileri:
   **TripoSR**, **Stable Fast 3D (SF3D)**, **Hunyuan3D-2**, **TRELLIS**. Her biri sunucu tarafı bir sürücü olarak
   (`category: 'cloud'`) aynı `{ kind: 'model', glb }` sözleşmesiyle eklenir; ilerleme SSE/WebSocket ile.
4. **Depolama:** Yüklenen görseller ve üretilen GLB'ler için S3/R2 + imzalı URL'ler, saklama süresi politikası, CDN.
5. **Galeri ve paylaşım:** Kullanıcının model geçmişi, herkese açık paylaşım sayfaları, `<model-viewer>` gömme kodu, AR (USDZ).
6. **Kalite:** Web Worker'da sezgisel sürücüler, retopoloji/decimation, doku pişirme, metrik derinlik modelleri,
   çoklu görüntüden (çok açılı) yeniden yapılandırma.
7. **Operasyon:** Gözlemlenebilirlik (OpenTelemetry), hata izleme (Sentry), Docker imajı, CI'da `npm run check`.
