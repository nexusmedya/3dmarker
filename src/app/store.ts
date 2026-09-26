/**
 * App state: a plain reducer (no library) plus loading / saving the
 * persisted parts. Heavy three.js objects live outside the state (see
 * useStudio); this module stays pure and Node-testable.
 */
import type { Availability, Driver, I18nText, Lang, Mask, ParamValue, ParamValues, Progress, RGBAImage } from '../core/types';
import { defaultParams } from '../core/types';
import type { MeshStats } from '../core/mesh/stats';
import { MESH_PARAMS, type MeshMode } from '../core/mesh/options';
import { detectLang, type UIKey } from './i18n';
import { suggestedMeshMode } from './driverMeta';
import { isBackgroundMode, type BackgroundMode, type MaskNote, type SourceImage } from './pipeline';
import { loadJSON, persistableParams, sanitizeParams, saveJSON, type KeyValueStore } from './persist';

export type Theme = 'dark' | 'light';
export type JobStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

export interface ViewSettings {
  texture: boolean;
  wireframe: boolean;
  clay: boolean;
  autoRotate: boolean;
  darkBackground: boolean;
  showDepth: boolean;
}

export interface ResultInfo {
  driverId: string;
  kind: 'depth' | 'geometry' | 'model';
  stats: MeshStats;
  /** Grayscale preview of the depth map (depth results only). */
  depthPreview: RGBAImage | null;
  elapsedMs: number;
  sourceName: string;
}

export interface AppState {
  lang: Lang;
  theme: Theme;
  /** True once the theme came from the user (stored or toggled); otherwise it follows the OS and is not persisted. */
  explicitTheme: boolean;
  source: SourceImage | null;
  loadingImage: boolean;
  bgMode: BackgroundMode;
  /** Mask for the preview overlay (and for generation in the non-AI modes). */
  mask: Mask | null;
  maskNote: MaskNote;
  /** Cached AI background-removal mask for the current source. */
  aiMask: { source: SourceImage; mask: Mask | null } | null;
  showMask: boolean;
  driverId: string;
  params: Record<string, ParamValues>;
  meshParams: ParamValues;
  /** Shown once after the mesh mode was auto-set for the selected driver. */
  meshNotice: I18nText | null;
  /**
   * Mesh mode suggested for the selected driver while a re-meshable result
   * of another run is on screen: applied by the next generation (and on its
   * jobDone) instead of silently re-meshing the displayed model. Not persisted.
   */
  pendingMeshMode: MeshMode | null;
  status: JobStatus;
  progress: Progress | null;
  error: I18nText | null;
  /** Heading for the error alert (image loading vs generation). */
  errorTitle: UIKey;
  result: ResultInfo | null;
  view: ViewSettings;
  stlSizeMm: number;
}

export type Action =
  | { type: 'setLang'; lang: Lang }
  | { type: 'setTheme'; theme: Theme }
  | { type: 'imageLoading' }
  | { type: 'imageLoaded'; source: SourceImage; mask: Mask | null; maskNote: MaskNote }
  | { type: 'imageFailed'; error: I18nText }
  | { type: 'clearImage' }
  | { type: 'setBgMode'; mode: BackgroundMode; mask: Mask | null; maskNote: MaskNote }
  | { type: 'setShowMask'; show: boolean }
  | { type: 'selectDriver'; driver: Driver }
  | { type: 'setParam'; driverId: string; key: string; value: ParamValue }
  | { type: 'resetParams'; driver: Driver }
  | { type: 'setMeshParam'; key: string; value: ParamValue }
  | { type: 'resetMeshParams' }
  | { type: 'jobStart' }
  | { type: 'jobProgress'; progress: Progress }
  | { type: 'jobDone'; result: ResultInfo; source: SourceImage; bgMode: BackgroundMode; inputMask: Mask | null }
  | { type: 'jobFailed'; error: I18nText }
  | { type: 'jobCancelled' }
  | { type: 'statsUpdated'; stats: MeshStats }
  | { type: 'setView'; view: Partial<ViewSettings> }
  | { type: 'dismissError' }
  | { type: 'setStlSize'; mm: number };

export const DEFAULT_VIEW: ViewSettings = {
  texture: true,
  wireframe: false,
  clay: false,
  autoRotate: false,
  darkBackground: true,
  showDepth: true,
};

export const DEFAULT_STL_SIZE_MM = 100;

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'setLang':
      return { ...state, lang: action.lang };
    case 'setTheme':
      // The viewer background follows the theme (the viewer toolbar can still override it).
      return { ...state, theme: action.theme, explicitTheme: true, view: { ...state.view, darkBackground: action.theme === 'dark' } };
    case 'imageLoading':
      return { ...state, loadingImage: true, error: null };
    case 'imageLoaded':
      return {
        ...state,
        loadingImage: false,
        source: action.source,
        mask: action.mask,
        maskNote: action.maskNote,
        aiMask: null,
        error: null,
        status: state.status === 'running' ? 'running' : 'idle',
      };
    case 'imageFailed':
      return { ...state, loadingImage: false, error: action.error, errorTitle: 'imageErrorTitle' };
    case 'clearImage':
      // Any load still in flight is superseded (useStudio bumps its sequence) and never reports back.
      return { ...state, source: null, mask: null, maskNote: null, aiMask: null, loadingImage: false };
    case 'setBgMode': {
      // The cached AI mask survives mode switches so going back to 'ai' is instant.
      const cached = action.mode === 'ai' && state.aiMask && state.aiMask.source === state.source ? state.aiMask : null;
      return {
        ...state,
        bgMode: action.mode,
        mask: cached ? cached.mask : action.mask,
        maskNote: cached ? null : action.maskNote,
      };
    }
    case 'setShowMask':
      return { ...state, showMask: action.show };
    case 'selectDriver': {
      const { driver } = action;
      const params = state.params[driver.id] ? state.params : { ...state.params, [driver.id]: defaultParams(driver.params) };
      if (driver.id === state.driverId) return { ...state, params, meshNotice: null };
      const mode = suggestedMeshMode(driver);
      let meshParams = state.meshParams;
      let meshNotice: I18nText | null = null;
      let pendingMeshMode: MeshMode | null = null;
      if (mode && meshParams.mode !== mode) {
        // The mesh params drive the live re-mesh of the model on screen: while a
        // depth result is shown, changing them would silently rebuild it (under
        // its old driver's label / export name). Defer to the next generation.
        if (state.result?.kind === 'depth') pendingMeshMode = mode;
        else {
          meshParams = { ...meshParams, mode };
          meshNotice = meshModeLabel(mode);
        }
      }
      return { ...state, driverId: driver.id, params, meshParams, meshNotice, pendingMeshMode };
    }
    case 'setParam': {
      const current = state.params[action.driverId] ?? {};
      return { ...state, params: { ...state.params, [action.driverId]: { ...current, [action.key]: action.value } } };
    }
    case 'resetParams':
      return { ...state, params: { ...state.params, [action.driver.id]: defaultParams(action.driver.params) } };
    case 'setMeshParam':
      return {
        ...state,
        meshParams: { ...state.meshParams, [action.key]: action.value },
        meshNotice: null,
        // An explicit mode choice wins over the pending suggestion.
        pendingMeshMode: action.key === 'mode' ? null : state.pendingMeshMode,
      };
    case 'resetMeshParams':
      return { ...state, meshParams: defaultParams(MESH_PARAMS), meshNotice: null, pendingMeshMode: null };
    case 'jobStart':
      return { ...state, status: 'running', progress: null, error: null };
    case 'jobProgress':
      return state.status === 'running' ? { ...state, progress: action.progress } : state;
    case 'jobDone': {
      const next: AppState = { ...state, status: 'done', progress: null, result: action.result };
      // generate() built the new model with the pending mode; the params follow
      // only now, so the previous model was never re-meshed while the job ran.
      if (state.pendingMeshMode) {
        next.meshParams = { ...state.meshParams, mode: state.pendingMeshMode };
        next.pendingMeshMode = null;
      }
      if (action.bgMode === 'ai') {
        next.aiMask = { source: action.source, mask: action.inputMask };
        if (state.source === action.source && state.bgMode === 'ai') {
          next.mask = action.inputMask;
          next.maskNote = null;
        }
      }
      return next;
    }
    case 'jobFailed':
      return { ...state, status: 'error', progress: null, error: action.error, errorTitle: 'errorTitle' };
    case 'jobCancelled':
      return { ...state, status: 'cancelled', progress: null };
    case 'statsUpdated':
      return state.result ? { ...state, result: { ...state.result, stats: action.stats } } : state;
    case 'setView':
      return { ...state, view: { ...state.view, ...action.view } };
    case 'dismissError':
      return { ...state, error: null, status: state.status === 'error' ? 'idle' : state.status };
    case 'setStlSize':
      return Number.isFinite(action.mm) && action.mm > 0 ? { ...state, stlSizeMm: action.mm } : state;
  }
}

/** Localised label of a mesh mode, as shown in the mesh form's select. */
export function meshModeLabel(mode: MeshMode): I18nText | null {
  const option = MESH_PARAMS.find((p) => p.key === 'mode');
  return (option?.kind === 'select' ? option.options.find((o) => o.value === mode)?.label : undefined) ?? null;
}

/** Mesh params for the next generation (the pending suggested mode applied). */
export function meshParamsForJob(state: AppState): ParamValues {
  return state.pendingMeshMode ? { ...state.meshParams, mode: state.pendingMeshMode } : state.meshParams;
}

/**
 * Whether Generate may run: an image is loaded, no new image is being decoded
 * and the driver is not known to be unavailable ('checking' does not block).
 * Shared by the Generate button and the Ctrl/Cmd+Enter shortcut.
 */
export function canGenerate(state: AppState, availability: Availability | 'checking' | null): boolean {
  const unavailable = !!availability && availability !== 'checking' && !availability.ok;
  return !!state.source && !state.loadingImage && !unavailable;
}

interface StoredSettings {
  lang?: unknown;
  theme?: unknown;
  driverId?: unknown;
  bgMode?: unknown;
  view?: unknown;
  stlSizeMm?: unknown;
  showMask?: unknown;
}

export interface InitEnv {
  store: KeyValueStore | null;
  languages: readonly string[] | string | undefined;
  drivers: Driver[];
  defaultDriverId: string;
  prefersLight?: boolean;
}

export function createInitialState(env: InitEnv): AppState {
  const settings = (loadJSON(env.store, 'settings') ?? {}) as StoredSettings;
  const lang: Lang = settings.lang === 'tr' || settings.lang === 'en' ? settings.lang : detectLang(env.languages);
  const explicitTheme = settings.theme === 'light' || settings.theme === 'dark';
  const theme: Theme = explicitTheme ? (settings.theme as Theme) : env.prefersLight ? 'light' : 'dark';
  const known = (id: unknown) => typeof id === 'string' && env.drivers.some((d) => d.id === id);
  const driverId = known(settings.driverId)
    ? (settings.driverId as string)
    : known(env.defaultDriverId)
      ? env.defaultDriverId
      : (env.drivers[0]?.id ?? env.defaultDriverId);
  const params: Record<string, ParamValues> = {};
  for (const d of env.drivers) params[d.id] = sanitizeParams(d.params, loadJSON(env.store, `params:${d.id}`));
  const storedView = settings.view && typeof settings.view === 'object' ? (settings.view as Record<string, unknown>) : {};
  const view: ViewSettings = { ...DEFAULT_VIEW, darkBackground: theme === 'dark' };
  for (const k of Object.keys(DEFAULT_VIEW) as (keyof ViewSettings)[]) if (typeof storedView[k] === 'boolean') view[k] = storedView[k] as boolean;
  const stl = typeof settings.stlSizeMm === 'number' && settings.stlSizeMm > 0 && settings.stlSizeMm <= 10_000 ? settings.stlSizeMm : DEFAULT_STL_SIZE_MM;
  return {
    lang,
    theme,
    explicitTheme,
    source: null,
    loadingImage: false,
    bgMode: isBackgroundMode(settings.bgMode) ? settings.bgMode : 'auto',
    mask: null,
    maskNote: null,
    aiMask: null,
    showMask: typeof settings.showMask === 'boolean' ? settings.showMask : false,
    driverId,
    params,
    meshParams: sanitizeParams(MESH_PARAMS, loadJSON(env.store, 'mesh')),
    meshNotice: null,
    pendingMeshMode: null,
    status: 'idle',
    progress: null,
    error: null,
    errorTitle: 'errorTitle',
    result: null,
    view,
    stlSizeMm: stl,
  };
}

/**
 * Persist settings, mesh params and every driver's non-secret params. The
 * theme is saved only once the user chose it, and the viewer background only
 * when it differs from the theme's, so both keep following the OS otherwise.
 */
export function saveState(store: KeyValueStore | null, state: AppState, drivers: Driver[]): void {
  const { darkBackground, ...view } = state.view;
  saveJSON(store, 'settings', {
    lang: state.lang,
    theme: state.explicitTheme ? state.theme : undefined,
    driverId: state.driverId,
    bgMode: state.bgMode,
    view: darkBackground === (state.theme === 'dark') ? view : state.view,
    stlSizeMm: state.stlSizeMm,
    showMask: state.showMask,
  });
  saveJSON(store, 'mesh', state.meshParams);
  for (const d of drivers) {
    const values = state.params[d.id];
    if (values) saveJSON(store, `params:${d.id}`, persistableParams(d.params, values));
  }
}
