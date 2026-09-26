/**
 * Cloud driver: image (or several views) → 3D model through whichever AI
 * provider the user set up under "AI Providers" (src/ai: Tripo3D, Stability,
 * fal.ai, Replicate, a custom endpoint…). With extra views (and
 * `preferMultiview`) it picks a provider offering 'multiview-to-3d', else one
 * offering 'image-to-3d', and runs that kind's adapter `toModel`.
 *
 * Providers the browser may call directly work on the static build too; the
 * rest go through our server's proxy (the adapters handle routing and turn
 * failures into bilingual errors). The adapters are loaded on first use.
 */
import type { AiCapability, AiSettings, ProviderAdapter, ProviderConfig, ProviderKindId } from '../../ai/types';
import type { Availability, Driver, DriverInput, DriverResult, I18nText, ParamSpec, ViewId } from '../../core/types';
import { AbortError, VIEW_IDS, throwIfAborted } from '../../core/types';
import { LocalizedError } from '../../core/errors';
import { isGlb } from './tripo';
import { currentAiSettings, resolveProvider } from '../../ai/settings';

/** What the driver needs from src/ai (injectable for tests). */
export interface AiModelDeps {
  currentAiSettings(): { settings: AiSettings; serverAvailable: boolean };
  resolveProvider(s: AiSettings, cap: AiCapability, preferredId?: string | null, serverAvailable?: boolean): ProviderConfig | null;
  getAdapter(kind: ProviderKindId): ProviderAdapter;
}

async function loadDeps(): Promise<AiModelDeps> {
  // The settings are in the main bundle already (the studio owns them); the adapters load on demand.
  const adapters = await import('../../ai/adapters');
  return { currentAiSettings, resolveProvider, getAdapter: adapters.getAdapter };
}

export interface AiModelDriverOptions {
  deps?: () => Promise<AiModelDeps>;
}

const T = {
  noProvider: {
    tr: 'Görselden 3B üretebilen bir yapay zekâ sağlayıcısı yok: “AI Sağlayıcıları” bölümünden görselden 3B destekleyen bir sağlayıcı ekleyin (ör. Tripo3D, Stability AI, fal.ai, Replicate).',
    en: 'No AI provider can make 3D models from images: add a provider with image-to-3D in AI Providers (e.g. Tripo3D, Stability AI, fal.ai, Replicate).',
  },
  noModelSupport: (name: string): I18nText => ({
    tr: `“${name}” sağlayıcısı 3B model üretemiyor. AI Sağlayıcıları’ndan görselden 3B destekleyen başka bir sağlayıcı seçin.`,
    en: `The provider “${name}” cannot generate 3D models. Pick another provider with image-to-3D in AI Providers.`,
  }),
  starting: (name: string, views: number): I18nText =>
    views > 1
      ? { tr: `${views} görünüm ${name} ile 3B modele dönüştürülüyor…`, en: `Turning ${views} views into a 3D model with ${name}…` }
      : { tr: `${name} ile 3B model oluşturuluyor…`, en: `Generating the 3D model with ${name}…` },
  badModel: (name: string): I18nText => ({
    tr: `${name} geçerli bir GLB dosyası döndürmedi.`,
    en: `${name} did not return a valid GLB file.`,
  }),
  failed: (name: string, detail: string): I18nText => ({
    tr: `${name} ile 3B model üretilemedi${detail ? `: ${detail}` : '.'}`,
    en: `${name} could not generate the 3D model${detail ? `: ${detail}` : '.'}`,
  }),
  done: { tr: 'Tamamlandı', en: 'Done' },
};

export interface AiModelParams {
  /** Use a multi-view provider when extra views exist. */
  preferMultiview: boolean;
}

const PARAMS: ParamSpec[] = [
  {
    kind: 'boolean',
    key: 'preferMultiview',
    label: { tr: 'Ek görünümleri kullan', en: 'Use the extra views' },
    hint: {
      tr: 'Arka/yan görünümler varsa çoklu görünüm destekleyen bir sağlayıcıya hepsini gönderir; yoksa yalnızca ön görsel gider.',
      en: 'With back/side views present, sends them all to a provider with multi-view support; otherwise only the front image is sent.',
    },
    default: true,
  },
];

export function aiModelParamsFrom(p: DriverInput['params']): AiModelParams {
  return { preferMultiview: typeof p.preferMultiview === 'boolean' ? p.preferMultiview : true };
}

/** Views besides the front that the input carries. */
export function extraViewIds(input: Pick<DriverInput, 'views'>): ViewId[] {
  return VIEW_IDS.filter((v) => v !== 'front' && input.views[v]?.file);
}

/** The provider (and capability) to use: multi-view when wanted and offered, else single-image. */
export function chooseProvider(
  deps: Pick<AiModelDeps, 'resolveProvider'>,
  settings: AiSettings,
  serverAvailable: boolean,
  wantMultiview: boolean,
): { cfg: ProviderConfig; cap: AiCapability } | null {
  if (wantMultiview) {
    const cfg = deps.resolveProvider(settings, 'multiview-to-3d', null, serverAvailable);
    if (cfg) return { cfg, cap: 'multiview-to-3d' };
  }
  const cfg = deps.resolveProvider(settings, 'image-to-3d', null, serverAvailable);
  return cfg ? { cfg, cap: 'image-to-3d' } : null;
}

const providerName = (cfg: ProviderConfig) => cfg.label.trim() || cfg.kind;

export function createAiModelDriver(options: AiModelDriverOptions = {}): Driver {
  const getDeps = options.deps ?? loadDeps;

  async function run(input: DriverInput): Promise<DriverResult> {
    const { signal, onProgress } = input;
    throwIfAborted(signal);
    const params = aiModelParamsFrom(input.params);
    const deps = await getDeps();
    throwIfAborted(signal);
    const { settings, serverAvailable } = deps.currentAiSettings();
    const extras = extraViewIds(input);
    const choice = chooseProvider(deps, settings, serverAvailable, params.preferMultiview && extras.length > 0);
    if (!choice) throw new LocalizedError(T.noProvider);
    const { cfg, cap } = choice;
    const name = providerName(cfg);
    const adapter = deps.getAdapter(cfg.kind);
    if (!adapter.toModel) throw new LocalizedError(T.noModelSupport(name));

    const views: Partial<Record<ViewId, Blob>> = { front: input.views.front?.file ?? input.file };
    if (cap === 'multiview-to-3d') for (const v of extras) views[v] = input.views[v]!.file;
    onProgress({ label: T.starting(name, Object.keys(views).length) });

    let glb: ArrayBuffer;
    try {
      glb = await adapter.toModel(cfg, { views, signal, onProgress });
    } catch (e) {
      if (signal.aborted || (e instanceof Error && e.name === 'AbortError')) throw new AbortError();
      if (e instanceof LocalizedError) throw e;
      throw new LocalizedError(T.failed(name, e instanceof Error ? e.message.slice(0, 300) : ''));
    }
    throwIfAborted(signal);
    if (!(glb instanceof ArrayBuffer) || !isGlb(glb)) throw new LocalizedError(T.badModel(name));
    onProgress({ label: T.done, ratio: 1 });
    return { kind: 'model', glb };
  }

  /**
   * Checked when the driver is selected, possibly before the AI settings are
   * loaded or while the user is still adding a provider, so a missing
   * provider only warns (ok with a reason); run() fails clearly instead.
   */
  async function isAvailable(): Promise<Availability> {
    let deps: AiModelDeps;
    try {
      deps = await getDeps();
    } catch {
      return { ok: true, reason: T.noProvider };
    }
    const { settings, serverAvailable } = deps.currentAiSettings();
    return chooseProvider(deps, settings, serverAvailable, true) ? { ok: true } : { ok: true, reason: T.noProvider };
  }

  return {
    id: 'ai-provider-3d',
    name: { tr: 'Yapay zekâ sağlayıcısı (bulut, tam 3B)', en: 'AI provider (cloud, full 3D)' },
    description: {
      tr: '“AI Sağlayıcıları” bölümünde eklediğiniz görselden 3B hizmetini kullanır (Tripo3D, Stability AI, fal.ai, Replicate ya da kendi uç noktanız). Arka/yan görünümler varsa ve sağlayıcı destekliyorsa hepsini gönderir. Dokulu, tam bir 3B model (GLB) döner; sağlayıcının API anahtarını ve kredisini kullanır, görseller o hizmete yüklenir.',
      en: 'Uses the image-to-3D service you added under AI Providers (Tripo3D, Stability AI, fal.ai, Replicate or your own endpoint). With back/side views present and a provider that supports them, sends them all. Returns a textured, complete 3D model (GLB); uses that provider’s API key and credits, and uploads the images to it.',
    },
    category: 'cloud',
    badges: ['api-key', 'full-3d', 'multi-view'],
    params: PARAMS,
    producesDepth: false,
    views: 'optional',
    isAvailable,
    run,
  };
}

export const aiModelDriver: Driver = createAiModelDriver();
