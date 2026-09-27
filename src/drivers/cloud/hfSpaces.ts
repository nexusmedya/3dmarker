/**
 * Cloud drivers backed by public Hugging Face Spaces (Gradio apps) running
 * state-of-the-art image-to-3D models: TRELLIS, Hunyuan3D-2, TripoSG,
 * Stable Fast 3D (the specs live in ./hfSpecs.ts).
 *
 * Every model is described by data (HfSpaceSpec): the Space id, an ordered
 * list of API calls (endpoint name + argument mapping) and where the GLB is in
 * the last call's result. This file is the generic runner: it connects with
 * the official @gradio/client (loaded on first use), uploads the image, runs
 * the steps in one Gradio session (so `gr.State` values carry over between
 * steps), relays queue position / GPU progress, downloads and validates the
 * GLB, and maps failures (ZeroGPU quota, sleeping / paused Space, wrong
 * endpoint, no network) to bilingual messages.
 *
 * Works from the static GitHub Pages build: the browser talks to
 * `<space>.hf.space` directly. ASSUMPTION: Gradio Spaces answer CORS requests
 * from any origin (Gradio's default `allowed_origins` / the Spaces proxy send
 * `Access-Control-Allow-Origin` for the API, config, upload and file routes);
 * this could not be verified from the build sandbox (huggingface.co was
 * unreachable).
 *
 * Space ids, endpoint names and argument names are ASSUMPTIONS (see
 * hfSpecs.ts): Spaces change without notice, so the Space id, the main
 * endpoint and extra arguments can be overridden from the driver parameters
 * ("Advanced: …") without a code change.
 */
import type { Availability, Driver, DriverInput, DriverResult, I18nText, Mask, ParamSpec, ParamValues, Progress, RGBAImage } from '../../core/types';
import { AbortError, throwIfAborted } from '../../core/types';
import { LocalizedError } from '../../core/errors';
import type { AiSettings } from '../../ai/types';
import { currentAiSettings } from '../../ai/settings';
import { isGlb } from './tripo';

// ---------------------------------------------------------------------------
// Minimal view of @gradio/client (so tests can inject a fake)

/** One event of a Gradio job (subset of @gradio/client's GradioEvent). */
export type GradioEventLike =
  | { type: 'data'; data: unknown[] }
  | {
      type: 'status';
      stage: string;
      queue?: boolean;
      position?: number;
      size?: number;
      eta?: number;
      message?: unknown;
      title?: string;
      /** 'process_starts' once a worker picked the job up (stage stays 'pending'). */
      original_msg?: string;
      progress_data?: { progress: number | null; index: number | null; length: number | null; unit: string | null; desc: string | null }[] | null;
    }
  | { type: 'log' | 'render'; [k: string]: unknown };

export interface GradioJobLike {
  next(): Promise<IteratorResult<GradioEventLike, unknown>>;
  return?(): Promise<unknown>;
  cancel(): Promise<void>;
}

export interface GradioClientLike {
  submit(
    endpoint: string,
    data: unknown[] | Record<string, unknown>,
    event_data?: unknown,
    trigger_id?: number | null,
    all_events?: boolean,
  ): GradioJobLike;
  close?(): void;
  config?: { root?: string } | undefined;
}

/** Space status reported while connecting (subset of @gradio/client's SpaceStatus). */
export interface SpaceStatusLike {
  status: string;
  detail?: string;
  message?: string;
}

export interface GradioConnectOptions {
  token?: `hf_${string}`;
  hf_token?: `hf_${string}`;
  status_callback?: ((s: SpaceStatusLike) => void) | null;
  events?: ('data' | 'status' | 'log' | 'render')[];
  record_history?: boolean;
}

export interface GradioModule {
  connect(space: string, options: GradioConnectOptions): Promise<GradioClientLike>;
  /** @gradio/client's handle_file: wraps a Blob / URL for upload. */
  handleFile(file: Blob | string): unknown;
}

async function loadGradio(): Promise<GradioModule> {
  // Loaded on first use: keeps @gradio/client out of the main bundle.
  const mod = await import('@gradio/client');
  return {
    connect: (space, options) => mod.Client.connect(space, options as never) as unknown as Promise<GradioClientLike>,
    handleFile: (file) => mod.handle_file(file as Blob),
  };
}

// ---------------------------------------------------------------------------
// Data-driven model specs

export interface HfStepContext {
  /** The uploaded front image (handle_file result). */
  image: unknown;
  /** Seed to use (the param, or a random one when the param is 0). */
  seed: number;
  params: ParamValues;
  /** Results (`data` arrays) of the previous steps, by step id. */
  outputs: Record<string, unknown[]>;
  /** A previous step already returned a .glb file. */
  hasModel: boolean;
}

export interface HfStep {
  id: string;
  /** Gradio API name, e.g. '/image_to_3d'. ASSUMPTION for every Space. */
  endpoint: string | ((params: ParamValues) => string);
  /** Arguments: named (preferred; resolved by parameter name) or positional. */
  args: (ctx: HfStepContext) => unknown[] | Record<string, unknown>;
  /** Failure is ignored (e.g. a session-setup or texturing call). */
  optional?: boolean;
  /** Skipped when this returns false. */
  when?: (params: ParamValues) => boolean;
  /** Skipped when this returns true (checked right before the call, with the earlier outputs). */
  skip?: (ctx: HfStepContext) => boolean;
  /** The step the "endpoint" / "extra arguments" overrides apply to. Exactly one per spec. */
  main?: boolean;
  label: I18nText;
  /** Relative share of the total time (progress bands; default 1). */
  weight?: number;
}

export interface HfSpaceSpec {
  id: string;
  /** Short model name for messages, e.g. 'TRELLIS'. */
  model: string;
  name: I18nText;
  description: I18nText;
  /** Default Space id ('owner/name'). ASSUMPTION. */
  space: string;
  /** Other known mirrors, suggested in errors. ASSUMPTION. */
  alternativeSpaces?: string[];
  steps: HfStep[];
  /**
   * Indices in the last successful model step's data to look at first for the
   * GLB (e.g. the textured mesh before the untextured one). The runner then
   * searches the whole result for any .glb file.
   */
  glbOutputs?: { step: string; index: number }[];
  /** Model-specific parameters (shown before the shared ones). */
  params: ParamSpec[];
  /** Typical GPU time, for the hint. */
  typicalSeconds: number;
}

// ---------------------------------------------------------------------------
// Texts

const T = {
  connecting: (m: string, space: string): I18nText => ({
    tr: `Hugging Face Space’e bağlanılıyor (${m}: ${space})…`,
    en: `Connecting to the Hugging Face Space (${m}: ${space})…`,
  }),
  waking: (m: string): I18nText => ({
    tr: `${m} Space’i uyuyordu, uyandırılıyor (1–5 dk sürebilir)…`,
    en: `The ${m} Space was asleep; waking it up (may take 1–5 min)…`,
  }),
  building: (m: string): I18nText => ({
    tr: `${m} Space’i başlatılıyor…`,
    en: `The ${m} Space is starting…`,
  }),
  uploading: { tr: 'Görsel yükleniyor…', en: 'Uploading the image…' },
  queue: (step: I18nText, pos: number | null, size: number | null, eta: number | null): I18nText => {
    const place = pos != null ? (size ? `${pos + 1}/${size}` : `${pos + 1}`) : '';
    const etaTr = eta != null && eta > 0 ? `, ~${Math.ceil(eta)} sn` : '';
    const etaEn = eta != null && eta > 0 ? `, ~${Math.ceil(eta)} s` : '';
    return {
      tr: `${step.tr}: kuyrukta${place ? ` (sıra ${place}${etaTr})` : etaTr ? ` (${etaTr.slice(2)})` : ''}…`,
      en: `${step.en}: in the queue${place ? ` (position ${place}${etaEn})` : etaEn ? ` (${etaEn.slice(2)})` : ''}…`,
    };
  },
  generating: (step: I18nText, pct: number | null, desc: string | null): I18nText => {
    const p = pct != null ? ` %${pct}` : '';
    const pe = pct != null ? ` ${pct}%` : '';
    const d = desc ? ` — ${desc.slice(0, 60)}` : '';
    return { tr: `${step.tr}: GPU’da üretiliyor…${p}${d}`, en: `${step.en}: generating on the GPU…${pe}${d}` };
  },
  optionalSkipped: (step: I18nText): I18nText => ({
    tr: `${step.tr} atlandı (Space bu adımı desteklemiyor ya da hata verdi); devam ediliyor…`,
    en: `${step.en} skipped (the Space does not support it or it failed); continuing…`,
  }),
  downloading: { tr: 'Model indiriliyor…', en: 'Downloading the model…' },
  done: { tr: 'Tamamlandı', en: 'Done' },
  hint: (m: string, sec: number): I18nText => ({
    tr: `Ücretsiz Hugging Face Space (ZeroGPU): anahtar gerekmez, görsel ${m} Space’ine yüklenir. Bir üretim ~${sec} sn GPU kullanır; anonim kota düşüktür — kota hatası alırsanız ücretsiz bir HF erişim anahtarı (hf_…) ekleyin.`,
    en: `Free Hugging Face Space (ZeroGPU): no key needed; the image is uploaded to the ${m} Space. One run uses ~${sec} s of GPU; the anonymous quota is small — if you hit it, add a free HF access token (hf_…).`,
  }),
  tokenFormat: {
    tr: 'Hugging Face erişim anahtarı geçersiz biçimde: “hf_” ile başlamalı ve yalnızca harf/rakam içermeli. Kopyalarken gelen boşluk ya da tırnakları silin.',
    en: 'The Hugging Face access token has an invalid format: it must start with “hf_” and contain only letters and digits. Remove spaces or quotes picked up when copying it.',
  },
  badSpace: {
    tr: 'Space kimliği geçersiz: “sahip/ad” biçiminde olmalı (ör. JeffreyXiang/TRELLIS) ya da tam bir https:// adresi.',
    en: 'Invalid Space id: it must look like “owner/name” (e.g. JeffreyXiang/TRELLIS) or be a full https:// URL.',
  },
  badExtra: {
    tr: '“Ek argümanlar” geçerli bir JSON nesnesi (ya da konumsal argümanlar için dizi) olmalı.',
    en: '“Extra arguments” must be a valid JSON object (or an array for positional arguments).',
  },
  quota: (m: string, hasToken: boolean): I18nText => ({
    tr: `${m} Space’inin ücretsiz GPU (ZeroGPU) kotası doldu. ${hasToken ? 'Kotanız yenilenince (genellikle birkaç dakika–1 saat) tekrar deneyin, HF PRO ile kotayı artırın' : 'Parametrelerden ücretsiz bir Hugging Face erişim anahtarı (hf_…, huggingface.co/settings/tokens) ekleyin — giriş yapmış kullanıcıların kotası daha yüksektir —'} ya da başka bir modeli (ör. Stable Fast 3D, TripoSG) deneyin.`,
    en: `The ${m} Space's free GPU (ZeroGPU) quota is used up. ${hasToken ? 'Try again when your quota refills (usually minutes to an hour), raise it with HF PRO' : 'Add a free Hugging Face access token (hf_…, huggingface.co/settings/tokens) in the parameters — signed-in users get a larger quota —'} or try another model (e.g. Stable Fast 3D, TripoSG).`,
  }),
  gpuBusy: (m: string): I18nText => ({
    tr: `${m} Space’inde şu an boş GPU yok ya da GPU görevi yarıda kesildi. Birkaç dakika sonra tekrar deneyin ya da başka bir model seçin.`,
    en: `The ${m} Space has no free GPU right now, or the GPU task was aborted. Try again in a few minutes or pick another model.`,
  }),
  busy: (m: string): I18nText => ({
    tr: `${m} Space’i çok yoğun (kuyruk dolu). Biraz sonra tekrar deneyin ya da başka bir model seçin.`,
    en: `The ${m} Space is too busy (queue full). Try again later or pick another model.`,
  }),
  sleeping: (m: string, space: string, alt: string[]): I18nText => ({
    tr: `${m} Space’i (${space}) şu an çalışmıyor (uyuyor, duraklatılmış ya da hata veriyor). Birkaç dakika sonra tekrar deneyin${alt.length ? `, “Gelişmiş: Space” alanına başka bir kopya yazın (ör. ${alt.join(', ')})` : ''} ya da başka bir model seçin.`,
    en: `The ${m} Space (${space}) is not running (asleep, paused or broken). Try again in a few minutes${alt.length ? `, enter another copy under “Advanced: Space” (e.g. ${alt.join(', ')})` : ''} or pick another model.`,
  }),
  notFound: (m: string, space: string): I18nText => ({
    tr: `${m} Space’i bulunamadı (${space}). Space taşınmış ya da özel olabilir: “Gelişmiş: Space” alanını düzeltin ya da özel bir Space için erişim anahtarı ekleyin.`,
    en: `The ${m} Space was not found (${space}). It may have moved or be private: fix “Advanced: Space”, or add an access token for a private Space.`,
  }),
  tokenRejected: {
    tr: 'Hugging Face erişim anahtarı reddedildi. Anahtarı kontrol edin (huggingface.co/settings/tokens) ya da boş bırakın.',
    en: 'The Hugging Face access token was rejected. Check it (huggingface.co/settings/tokens) or leave it empty.',
  },
  endpoint: (m: string, ep: string, detail: string): I18nText => ({
    tr: `${m} Space’inin API’si beklenenden farklı (${ep}): ${detail}. Space güncellenmiş olabilir; Space sayfasındaki “Use via API” bölümüne bakıp “Gelişmiş: uç nokta / ek argümanlar” alanlarını düzeltin ya da başka bir model seçin.`,
    en: `The ${m} Space's API differs from what was expected (${ep}): ${detail}. The Space may have been updated; check “Use via API” on its page and fix “Advanced: endpoint / extra arguments”, or pick another model.`,
  }),
  network: (m: string): I18nText => ({
    tr: `${m} Space’ine ulaşılamadı (ağ hatası ya da CORS engeli). İnternet bağlantınızı kontrol edin; kurumsal ağlarda *.hf.space engelli olabilir.`,
    en: `Could not reach the ${m} Space (network error or CORS block). Check your connection; corporate networks may block *.hf.space.`,
  }),
  timeout: (m: string, min: number): I18nText => ({
    tr: `${m} ${min} dakika içinde sonuç vermedi (kuyruk çok uzun olabilir). Daha sonra tekrar deneyin, zaman aşımını artırın ya da başka bir model seçin.`,
    en: `${m} did not finish within ${min} minutes (the queue may be very long). Try again later, raise the timeout or pick another model.`,
  }),
  noModel: (m: string): I18nText => ({
    tr: `${m} bir 3B model dosyası döndürmedi. Space’in API’si değişmiş olabilir (“Gelişmiş” alanlarına bakın).`,
    en: `${m} did not return a 3D model file. The Space's API may have changed (see the “Advanced” fields).`,
  }),
  badModel: (m: string, what: string): I18nText => ({
    tr: `${m} geçerli bir GLB dosyası döndürmedi${what ? ` (${what})` : ''}.`,
    en: `${m} did not return a valid GLB file${what ? ` (${what})` : ''}.`,
  }),
  download: (m: string, detail: string): I18nText => ({
    tr: `${m} modeli üretti ama indirilemedi (${detail}). Tekrar deneyin.`,
    en: `${m} generated the model but it could not be downloaded (${detail}). Please try again.`,
  }),
  failed: (m: string, detail: string): I18nText => ({
    tr: `${m} bu görselden model üretemedi${detail ? `: ${detail}` : '.'}`,
    en: `${m} could not generate a model from this image${detail ? `: ${detail}` : '.'}`,
  }),
};

export const HF_TEXT = T;

// ---------------------------------------------------------------------------
// Params

/** Parameters shared by every HF Space driver (after the model-specific ones). */
export function sharedHfParams(spec: HfSpaceSpec): ParamSpec[] {
  const main = spec.steps.find((s) => s.main) ?? spec.steps[spec.steps.length - 1];
  const mainEp = typeof main.endpoint === 'string' ? main.endpoint : main.endpoint({});
  return [
    {
      kind: 'text',
      key: 'hfToken',
      label: { tr: 'Hugging Face erişim anahtarı (isteğe bağlı)', en: 'Hugging Face access token (optional)' },
      hint: {
        tr: 'Boş bırakılabilir. Ücretsiz bir “read” anahtarı (huggingface.co/settings/tokens) GPU kotanızı artırır. Yalnızca Hugging Face’e gönderilir, saklanmaz. Boşsa “AI Sağlayıcıları”nda hf_ ile başlayan bir anahtar varsa o kullanılır.',
        en: 'Optional. A free “read” token (huggingface.co/settings/tokens) raises your GPU quota. Only sent to Hugging Face, never stored. When empty, an hf_… key from AI Providers is used if there is one.',
      },
      default: '',
      secret: true,
      placeholder: 'hf_…',
    },
    {
      kind: 'number',
      key: 'seed',
      label: { tr: 'Tohum (seed)', en: 'Seed' },
      hint: { tr: '0 = her seferinde rastgele; aynı sayı aynı sonucu verir', en: '0 = random each time; the same number repeats the result' },
      min: 0,
      max: 2_147_483_647,
      step: 1,
      default: 0,
    },
    {
      kind: 'number',
      key: 'timeoutMin',
      label: { tr: 'Zaman aşımı (dk)', en: 'Timeout (min)' },
      hint: { tr: 'Kuyruk + üretim için en uzun bekleme', en: 'Longest wait for queue + generation' },
      min: 2,
      max: 60,
      step: 1,
      default: 15,
    },
    {
      kind: 'text',
      key: 'space',
      label: { tr: 'Gelişmiş: Space', en: 'Advanced: Space' },
      hint: {
        tr: `Boş = ${spec.space}. Space taşınırsa ya da kendi kopyanızı (duplicate) kullanmak isterseniz “sahip/ad” yazın.`,
        en: `Empty = ${spec.space}. Enter “owner/name” if the Space moved or to use your own duplicate.`,
      },
      default: '',
      placeholder: spec.space,
    },
    {
      kind: 'text',
      key: 'endpoint',
      label: { tr: 'Gelişmiş: uç nokta', en: 'Advanced: endpoint' },
      hint: {
        tr: `Boş = ${mainEp}. Space’in “Use via API” sayfasındaki api_name.`,
        en: `Empty = ${mainEp}. The api_name from the Space's “Use via API” page.`,
      },
      default: '',
      placeholder: mainEp,
    },
    {
      kind: 'text',
      key: 'extraArgs',
      label: { tr: 'Gelişmiş: ek argümanlar (JSON)', en: 'Advanced: extra arguments (JSON)' },
      hint: {
        tr: 'Ana çağrının argümanlarına eklenir / üzerine yazar, ör. {"texture_size": 2048}; null bir argümanı kaldırır. Dizi verilirse konumsal argümanların yerine geçer ("$image" = görsel, "$seed" = tohum).',
        en: 'Merged into / overrides the main call\'s arguments, e.g. {"texture_size": 2048}; null removes an argument. An array replaces the positional arguments ("$image" = the image, "$seed" = the seed).',
      },
      default: '',
      placeholder: '{}',
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)

const INVISIBLE = /[​-‍⁠﻿]/g;
export const HF_TOKEN_PATTERN = /^hf_[A-Za-z0-9]{8,200}$/;
const SPACE_PATTERN = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;

export function cleanToken(v: unknown): string {
  return typeof v === 'string' ? v.replace(INVISIBLE, '').trim().replace(/^Bearer\s+/i, '') : '';
}

/**
 * An HF token from the AI provider settings, without a dedicated provider
 * kind: an enabled entry whose key looks like an HF token (hf_…), preferring
 * one whose label / URL mentions Hugging Face (e.g. an OpenAI-compatible entry
 * pointed at router.huggingface.co).
 */
export function hfTokenFromAiSettings(settings: AiSettings | null | undefined): string {
  if (!settings) return '';
  const candidates = settings.providers.filter((p) => p.enabled && !p.managed && HF_TOKEN_PATTERN.test(cleanToken(p.apiKey)));
  const mentionsHf = (p: (typeof candidates)[number]) =>
    /hugging\s*face|huggingface|\bhf\b/i.test(`${p.label} ${String(p.values?.baseUrl ?? '')} ${String(p.values?.url ?? '')}`);
  const best = candidates.find(mentionsHf) ?? candidates[0];
  return best ? cleanToken(best.apiKey) : '';
}

/** 'owner/name', a huggingface.co/spaces URL or an *.hf.space URL → what Client.connect accepts. */
export function normalizeSpace(v: string): string | null {
  const s = v.replace(INVISIBLE, '').trim().replace(/\/+$/, '');
  if (!s) return null;
  const m = /^https?:\/\/huggingface\.co\/spaces\/([^/?#]+\/[^/?#]+)/i.exec(s);
  if (m) return SPACE_PATTERN.test(m[1]) ? m[1] : null;
  if (/^https:\/\/[^\s/]+(\/[^\s]*)?$/i.test(s)) return s; // a direct app URL (e.g. https://owner-name.hf.space)
  return SPACE_PATTERN.test(s) ? s : null;
}

export function normalizeEndpoint(v: string): string {
  const s = v.trim();
  return s ? (s.startsWith('/') ? s : `/${s}`) : '';
}

/** Parse the "extra arguments" param: '' → null; an object / array; anything else throws. */
export function parseExtraArgs(v: unknown): Record<string, unknown> | unknown[] | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    throw new LocalizedError(T.badExtra);
  }
  if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown> | unknown[];
  throw new LocalizedError(T.badExtra);
}

/** Apply the extra-args override: arrays replace (with $image / $seed placeholders), objects merge. */
export function applyExtraArgs(
  base: unknown[] | Record<string, unknown>,
  extra: Record<string, unknown> | unknown[] | null,
  ctx: Pick<HfStepContext, 'image' | 'seed'>,
): unknown[] | Record<string, unknown> {
  if (!extra) return base;
  const sub = (x: unknown) => (x === '$image' ? ctx.image : x === '$seed' ? ctx.seed : x);
  if (Array.isArray(extra)) return extra.map(sub);
  if (Array.isArray(base)) return base; // named extras cannot apply to positional args
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) delete out[k]; // null removes an argument the Space no longer takes
    else out[k] = sub(v);
  }
  return out;
}

interface FileRef {
  url?: string;
  path?: string;
  name?: string;
}

function asFileRef(v: unknown): FileRef | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const url = typeof o.url === 'string' ? o.url : undefined;
  const path = typeof o.path === 'string' ? o.path : typeof o.name === 'string' ? o.name : undefined;
  if (!url && !path) return null;
  const name = typeof o.orig_name === 'string' ? o.orig_name : undefined;
  return { url, path, name };
}

const fileExt = (f: FileRef) => {
  const s = (f.name || f.path || f.url || '').split(/[?#]/)[0].toLowerCase();
  const m = /\.([a-z0-9]+)$/.exec(s);
  return m ? m[1] : '';
};

/** Every file-like value in `v` (FileData objects, `{value: FileData}` updates, nested arrays), depth-first. */
export function collectFiles(v: unknown, out: FileRef[] = [], depth = 0): FileRef[] {
  if (depth > 6 || v == null) return out;
  if (typeof v === 'string') {
    if (/^https?:\/\/\S+\.glb(\?|#|$)/i.test(v)) out.push({ url: v });
    return out;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectFiles(x, out, depth + 1);
    return out;
  }
  if (typeof v === 'object') {
    const f = asFileRef(v);
    if (f) {
      out.push(f);
      return out;
    }
    for (const x of Object.values(v as Record<string, unknown>)) collectFiles(x, out, depth + 1);
  }
  return out;
}

/** The model file to download: preferred indices first, then any .glb, then any file without a known non-GLB extension. */
export function pickModelFile(spec: HfSpaceSpec, outputs: Record<string, unknown[]>): { file: FileRef | null; other: string } {
  for (const pref of spec.glbOutputs ?? []) {
    const data = outputs[pref.step];
    if (!data) continue;
    const f = collectFiles(data[pref.index])[0];
    if (f && (fileExt(f) === 'glb' || fileExt(f) === '')) return { file: f, other: '' };
  }
  const all: FileRef[] = [];
  for (const step of [...spec.steps].reverse()) if (outputs[step.id]) collectFiles(outputs[step.id], all);
  const glb = all.find((f) => fileExt(f) === 'glb');
  if (glb) return { file: glb, other: '' };
  const others = all.map(fileExt).filter((e) => ['obj', 'ply', 'stl', 'gltf', 'fbx', 'usdz'].includes(e));
  return { file: null, other: others[0] ?? '' };
}

/** Absolute URL of a result file. ASSUMPTION: Gradio ≥ 4 serves bare paths at `<root>/gradio_api/file=<path>` (Gradio 5; `<root>/file=` on 4). */
export function fileUrl(f: FileRef, root: string | undefined): string | null {
  if (f.url && /^https?:\/\//i.test(f.url)) return f.url;
  if (f.path && /^https?:\/\//i.test(f.path)) return f.path;
  if (f.path && root) return `${root.replace(/\/+$/, '')}/gradio_api/file=${f.path}`;
  return null;
}

/** Hosts that may receive the HF token with a file download. */
export function isHfHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.endsWith('.hf.space') || h === 'huggingface.co' || h.endsWith('.huggingface.co');
  } catch {
    return false;
  }
}

function statusMessage(msg: { message?: unknown; title?: string }): string {
  const m = msg.message;
  if (typeof m === 'string' && m) return m;
  if (Array.isArray(m)) return m.map((x) => (x && typeof x === 'object' && 'message' in x ? String((x as { message: unknown }).message) : String(x))).join('; ');
  return msg.title ?? '';
}

/** A failure reported by the Space (status stage 'error'), or by the client while connecting. */
export class HfSpaceError extends Error {
  constructor(
    message: string,
    readonly phase: 'connect' | 'step',
    readonly endpoint = '',
  ) {
    super(message);
    this.name = 'HfSpaceError';
  }
}

export type HfFailure = 'quota' | 'gpu' | 'busy' | 'sleeping' | 'not-found' | 'token' | 'endpoint' | 'network' | 'other';

/** Classify a Space / client error message. */
export function classifyHfError(message: string): HfFailure {
  const m = message.toLowerCase();
  if (/quota|exceeded your gpu|gpu (duration|time).*(left|exceed)|requested vs|daily limit|rate.?limit|too many requests|\b429\b/.test(m)) return 'quota';
  if (/no gpu (was )?available|gpu task aborted|zerogpu|cuda out of memory|out of memory|worker (error|died)|gpu is not available/.test(m)) return 'gpu';
  if (/currently busy|queue is full|queue full/.test(m)) return 'busy';
  if (/invalid credentials|not authorized|unauthori[sz]ed|\b401\b|\b403\b|invalid (user )?token|login credentials/.test(m)) return 'token';
  if (/could not be accessed|\b404\b|not found|does not exist/.test(m) && !/endpoint|api_name|fn_index/.test(m)) return 'not-found';
  if (/sleep|paused|space_error|runtime_error|build_error|could not load this space|could not resolve app config|could not get space status|space metadata|starting|building|broken|connection errored/.test(m)) return 'sleeping';
  if (/endpoint|api_name|fn_index|no api information|parameter|argument|missing .*required|unexpected keyword|takes \d+ positional|validation|could not get api info/.test(m)) return 'endpoint';
  if (/failed to fetch|networkerror|network error|load failed|cors|err_/.test(m)) return 'network';
  return 'other';
}

const shorten = (s: string, n = 240) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------------------------------------------------------------------------
// Driver

export interface HfSpaceDriverOptions {
  gradio?: () => Promise<GradioModule>;
  /** Defaults to the global fetch, looked up at call time. */
  fetch?: typeof fetch;
  /** Reads the AI settings (for an hf_ token); defaults to src/ai currentAiSettings. */
  aiSettings?: () => AiSettings | null;
  /** Random seed source (tests). */
  random?: () => number;
  /** Milliseconds per "minute" of the timeout param (tests). */
  minuteMs?: number;
  /** RGBA → PNG (defaults to src/ai/encode encodePng; browser only). */
  encodePng?: (img: RGBAImage) => Promise<Blob>;
}

/** The image with alpha = the mask (the cut-out), or null when there is no usable mask. */
export function cutoutImage(image: RGBAImage, mask: Mask | null): RGBAImage | null {
  if (!mask || mask.width !== image.width || mask.height !== image.height) return null;
  let fg = 0;
  for (let i = 0; i < mask.data.length; i++) fg += mask.data[i] ? 1 : 0;
  if (fg === 0 || fg === mask.data.length) return null;
  const data = new Uint8ClampedArray(image.data);
  for (let i = 0; i < mask.data.length; i++) if (!mask.data[i]) data[i * 4 + 3] = 0;
  return { width: image.width, height: image.height, data };
}

const isAbort = (e: unknown) => e instanceof AbortError || (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError');

export function createHfSpaceDriver(spec: HfSpaceSpec, options: HfSpaceDriverOptions = {}): Driver {
  const getGradio = options.gradio ?? loadGradio;
  const doFetch: typeof fetch = (i, init) => (options.fetch ?? fetch)(i, init);
  const readSettings = options.aiSettings ?? (() => currentAiSettings().settings);
  const random = options.random ?? Math.random;
  const minuteMs = options.minuteMs ?? 60_000;
  const encode = options.encodePng ?? (async (img: RGBAImage) => (await import('../../ai/encode')).encodePng(img));

  /** What to upload: the cut-out PNG when wanted and possible, else the original file. */
  async function uploadBlob(input: DriverInput): Promise<Blob> {
    const original = input.views.front?.file ?? input.file;
    if (input.params.cutout === false) return original;
    const cut = cutoutImage(input.image, input.views.front?.mask ?? input.mask);
    if (!cut) return original;
    try {
      return await encode(cut);
    } catch {
      return original; // no canvas (e.g. Node): the Space removes the background itself
    }
  }
  const params: ParamSpec[] = [...spec.params, ...sharedHfParams(spec)];
  const M = spec.model;

  function localize(e: unknown, ctx: { space: string; token: boolean; endpoint: string }): LocalizedError {
    if (e instanceof LocalizedError) return e;
    const message = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
    switch (classifyHfError(message)) {
      case 'quota':
        return new LocalizedError(T.quota(M, ctx.token));
      case 'gpu':
        return new LocalizedError(T.gpuBusy(M));
      case 'busy':
        return new LocalizedError(T.busy(M));
      case 'sleeping':
        return new LocalizedError(T.sleeping(M, ctx.space, (spec.alternativeSpaces ?? []).filter((s) => s !== ctx.space)));
      case 'not-found':
        return new LocalizedError(T.notFound(M, ctx.space));
      case 'token':
        return new LocalizedError(ctx.token ? T.tokenRejected : T.notFound(M, ctx.space));
      case 'endpoint':
        return new LocalizedError(T.endpoint(M, ctx.endpoint || '?', shorten(message, 160)));
      case 'network':
        return new LocalizedError(T.network(M));
      default:
        return new LocalizedError(T.failed(M, shorten(message)));
    }
  }

  async function run(input: DriverInput): Promise<DriverResult> {
    const { signal, onProgress } = input;
    throwIfAborted(signal);
    const p = input.params;

    // --- resolve params
    let token = cleanToken(p.hfToken);
    if (token && !HF_TOKEN_PATTERN.test(token)) throw new LocalizedError(T.tokenFormat);
    if (!token) {
      try {
        token = hfTokenFromAiSettings(readSettings());
      } catch {
        token = '';
      }
    }
    const spaceParam = typeof p.space === 'string' ? p.space : '';
    const space = spaceParam.trim() ? normalizeSpace(spaceParam) : spec.space;
    if (!space) throw new LocalizedError(T.badSpace);
    const endpointOverride = normalizeEndpoint(typeof p.endpoint === 'string' ? p.endpoint : '');
    const extra = parseExtraArgs(p.extraArgs);
    const seedParam = typeof p.seed === 'number' && Number.isFinite(p.seed) ? Math.max(0, Math.round(p.seed)) : 0;
    const seed = seedParam > 0 ? seedParam : 1 + Math.floor(random() * 2_147_483_646);
    const timeoutMin = typeof p.timeoutMin === 'number' && Number.isFinite(p.timeoutMin) ? Math.min(60, Math.max(1, p.timeoutMin)) : 15;

    // --- one controller for user abort + timeout
    const ac = new AbortController();
    let timedOut = false;
    const onAbort = () => ac.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMin * minuteMs);
    const sig = ac.signal;
    const abortPromise = new Promise<never>((_, reject) => {
      const fail = () => reject(timedOut ? new LocalizedError(T.timeout(M, timeoutMin)) : new AbortError());
      if (sig.aborted) fail();
      else sig.addEventListener('abort', fail, { once: true });
    });
    abortPromise.catch(() => undefined);
    const race = <V>(pr: Promise<V>): Promise<V> => Promise.race([pr, abortPromise]);
    const checkAbort = () => {
      if (sig.aborted) throw timedOut ? new LocalizedError(T.timeout(M, timeoutMin)) : new AbortError();
    };

    let client: GradioClientLike | null = null;
    let currentEndpoint = '';
    try {
      onProgress({ label: T.connecting(M, space), ratio: 0.01 });
      const gradio = await race(getGradio());
      checkAbort();

      let spaceTrouble = '';
      const status_callback = (s: SpaceStatusLike) => {
        if (sig.aborted) return;
        if (s.status === 'sleeping') onProgress({ label: T.waking(M) });
        else if (s.status === 'building' || s.status === 'starting') onProgress({ label: T.building(M) });
        else if (s.status === 'paused' || s.status === 'space_error' || s.status === 'error') spaceTrouble = `${s.status}: ${s.message ?? ''}`;
      };
      const connectOpts: GradioConnectOptions = {
        status_callback,
        events: ['data', 'status'],
        record_history: false,
        ...(token ? { token: token as `hf_${string}`, hf_token: token as `hf_${string}` } : {}),
      };
      try {
        client = await race(gradio.connect(space, connectOpts));
      } catch (e) {
        if (isAbort(e) || e instanceof LocalizedError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw new HfSpaceError(spaceTrouble ? `${spaceTrouble} ${msg}` : msg, 'connect');
      }
      checkAbort();

      // --- upload + steps
      const blob = await race(uploadBlob(input));
      const named = typeof File !== 'undefined' && !(blob instanceof File) ? new File([blob], 'image.png', { type: blob.type || 'image/png' }) : blob;
      const image = gradio.handleFile(named);
      const steps = spec.steps.filter((s) => !s.when || s.when(p));
      const totalWeight = steps.reduce((a, s) => a + (s.weight ?? 1), 0) || 1;
      const outputs: Record<string, unknown[]> = {};
      let done = 0;
      onProgress({ label: T.uploading, ratio: 0.03 });

      for (const step of steps) {
        const bandStart = 0.05 + (0.85 * done) / totalWeight;
        const bandSize = (0.85 * (step.weight ?? 1)) / totalWeight;
        done += step.weight ?? 1;
        const builtIn = typeof step.endpoint === 'string' ? step.endpoint : step.endpoint(p);
        const endpoint = step.main && endpointOverride ? endpointOverride : builtIn;
        currentEndpoint = endpoint;
        const hasModel = collectFiles(Object.values(outputs)).some((f) => fileExt(f) === 'glb');
        const ctx: HfStepContext = { image, seed, params: p, outputs, hasModel };
        if (step.skip?.(ctx)) continue;
        let args = step.args(ctx);
        if (step.main) args = applyExtraArgs(args, extra, ctx);
        onProgress({ label: T.queue(step.label, null, null, null), ratio: bandStart });
        try {
          outputs[step.id] = await runStep(client, endpoint, args, step.label, bandStart, bandSize);
        } catch (e) {
          if (isAbort(e) || sig.aborted) throw e;
          if (step.optional) {
            console.warn(`[hf] optional step ${step.id} failed`, e);
            onProgress({ label: T.optionalSkipped(step.label), ratio: bandStart + bandSize });
            continue;
          }
          throw e;
        }
        checkAbort();
      }

      // --- download
      const { file, other } = pickModelFile(spec, outputs);
      if (!file) throw new LocalizedError(other ? T.badModel(M, `.${other}`) : T.noModel(M));
      const url = fileUrl(file, client.config?.root);
      if (!url) throw new LocalizedError(T.noModel(M));
      onProgress({ label: T.downloading, ratio: 0.92 });
      let res: Response;
      try {
        const headers: Record<string, string> = token && isHfHost(url) ? { Authorization: `Bearer ${token}` } : {};
        res = await race(doFetch(url, { headers, signal: sig }));
      } catch (e) {
        if (isAbort(e) || sig.aborted) throw e;
        throw new LocalizedError(T.download(M, e instanceof Error ? shorten(e.message, 80) : 'network'));
      }
      if (!res.ok) throw new LocalizedError(T.download(M, `HTTP ${res.status}`));
      const glb = await race(res.arrayBuffer());
      checkAbort();
      if (!isGlb(glb)) throw new LocalizedError(T.badModel(M, fileExt(file) && fileExt(file) !== 'glb' ? `.${fileExt(file)}` : ''));
      onProgress({ label: T.done, ratio: 1 });
      return { kind: 'model', glb };
    } catch (e) {
      if (timedOut) throw new LocalizedError(T.timeout(M, timeoutMin));
      if (isAbort(e) || signal.aborted) throw new AbortError();
      throw localize(e, { space, token: !!token, endpoint: currentEndpoint });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      try {
        client?.close?.();
      } catch {
        // ignore
      }
    }

    /** One Gradio call: relays status, returns the `data` array; cancels the job on abort. */
    async function runStep(
      c: GradioClientLike,
      endpoint: string,
      args: unknown[] | Record<string, unknown>,
      label: I18nText,
      bandStart: number,
      bandSize: number,
    ): Promise<unknown[]> {
      let job: GradioJobLike;
      try {
        job = c.submit(endpoint, args, null, null, true);
      } catch (e) {
        throw new HfSpaceError(e instanceof Error ? e.message : String(e), 'step', endpoint);
      }
      const cancel = () => {
        void Promise.resolve()
          .then(() => job.cancel())
          .catch(() => undefined);
      };
      sig.addEventListener('abort', cancel, { once: true });
      let result: unknown[] | null = null;
      let complete = false;
      try {
        for (;;) {
          const it = await race(job.next());
          if (it.done) break;
          const msg = it.value;
          if (msg.type === 'data') {
            result = Array.isArray(msg.data) ? msg.data : [msg.data];
            if (complete) break;
          } else if (msg.type === 'status') {
            const st = msg as Extract<GradioEventLike, { type: 'status' }>;
            if (st.stage === 'error') throw new HfSpaceError(statusMessage(st) || 'error', 'step', endpoint);
            if (st.stage === 'complete') {
              complete = true;
              if (result) break;
              continue;
            }
            onProgress(stepProgress(st, label, bandStart, bandSize));
          }
        }
      } finally {
        sig.removeEventListener('abort', cancel);
        if (!complete || !result) void Promise.resolve(job.return?.()).catch(() => undefined);
      }
      if (!result) throw new HfSpaceError(`no data returned by ${endpoint}`, 'step', endpoint);
      return result;
    }
  }

  async function isAvailable(): Promise<Availability> {
    return { ok: true, reason: T.hint(M, spec.typicalSeconds) };
  }

  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    category: 'cloud',
    badges: ['full-3d', 'closed-mesh'],
    params,
    producesDepth: false,
    isAvailable,
    run,
  };
}

/** Progress for a status event of a step occupying [bandStart, bandStart + bandSize]. */
export function stepProgress(
  st: Extract<GradioEventLike, { type: 'status' }>,
  label: I18nText,
  bandStart: number,
  bandSize: number,
): Progress {
  const pd = st.progress_data?.find((x) => x && (x.progress != null || (x.index != null && x.length)));
  if (pd) {
    const frac = pd.progress != null ? pd.progress : pd.length ? (pd.index ?? 0) / pd.length : 0;
    const f = Math.min(1, Math.max(0, frac));
    return { label: T.generating(label, Math.round(f * 100), pd.desc), ratio: bandStart + bandSize * f };
  }
  if (st.stage === 'pending' && st.original_msg !== 'process_starts' && st.position != null) {
    return { label: T.queue(label, st.position ?? null, st.size ?? null, st.eta ?? null), ratio: bandStart };
  }
  return { label: T.generating(label, null, null), ratio: bandStart + bandSize * 0.1 };
}
