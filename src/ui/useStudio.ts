/**
 * Studio controller hook: owns the reducer state, the current model (outside
 * the reducer — it holds GPU resources), image loading, generation with
 * cancellation, live re-meshing, persistence and global shortcuts — plus the
 * AI side: provider settings (persisted, published to drivers through
 * setCurrentAiSettings), the server probe, human analysis of the front image,
 * one AI job at a time (front preparation or view generation), the extra
 * views with their pre-run consistency checks, alignment and "copy prompt",
 * and the sculpt / depth-edit / rig hooks of the model on screen.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Mesh, Object3D } from 'three';
import type { DepthMap, Driver, Lang, Mask, ParamValue, Progress, RGBAImage, ViewAlign, ViewId } from '../core/types';
import { AbortError, DEFAULT_VIEW_ALIGN, defaultParams, throwIfAborted } from '../core/types';
import type { MeshStats } from '../core/mesh/stats';
import { depthToRGBA } from '../core/image/ops';
import { analyzeHuman } from '../core/human/analyze';
import type { HumanAnalysis } from '../core/human/types';
import { prepareView, type PreparedView } from '../core/fusion/frame';
import { ALIGN_TEXT, alignView } from '../core/fusion/align';
import type { ViewAlignment } from '../core/fusion/types';
import { DEFAULT_DRIVER_ID, DRIVERS, getDriver } from '../drivers';
import type { AiSettings, PrepOptions, ProviderConfig } from '../ai/types';
import { buildUserViewPrompt, measureFrontFraming } from '../ai/viewPrompts';
import {
  AI_KEYS_KEY,
  AI_SETTINGS_KEY,
  browserSessionStorage,
  canRenderViews,
  fetchServerProviders,
  loadAiSettings,
  mergeServerProviders,
  providerUsable,
  resolveProvider,
  saveAiSettings,
  setCurrentAiSettings,
  usableProviders,
} from '../ai/settings';
import { isHumanoid, prepNeeded } from '../ai/prompts';
import { generateViewImage, prepareFrontImage } from '../ai/generate';
import {
  buildDepthModel,
  createImageTexture,
  fusionReportOf,
  isAbortError,
  meshKeyOf,
  opaqueTextureImage,
  prepareSource,
  quickMask,
  resolveMask,
  runPipeline,
  statsForObject,
  type BackgroundMode,
  type BuiltModel,
  type SourceImage,
} from '../app/pipeline';
import {
  OTHER_VIEWS,
  canGenerate,
  createInitialState,
  extraViewSet,
  hasUnsavedModelEdits,
  meshParamsForJob,
  reducer,
  remeshPaused,
  saveState,
  type AiJobKind,
  type AppState,
  type OtherViewId,
  type Theme,
  type ViewEntry,
  type ViewSettings,
} from '../app/store';
import type { StepId } from '../app/steps';
import { browserStorage } from '../app/persist';
import { baseName, errorToText } from '../app/format';
import { UI, t } from '../app/i18n';
import { throttleLatest } from '../app/throttle';
import { disposeObject } from '../app/dispose';
import { renderSample, type SampleSpec } from '../app/samples';
import type { ViewerCore } from '../app/viewer';
import { useAvailability } from './useAvailability';

/** Delay before re-meshing after a mesh slider moves. */
export const REMESH_DEBOUNCE_MS = 150;
/** A view's consistency check is redone this long after its alignment request last changed. */
export const CHECK_REFRESH_MS = 250;

/** OS colour-scheme preference (used until the user picks a theme). */
function prefersLightScheme(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
}

/** Rejects with AbortError as soon as `signal` aborts (the promise itself keeps running). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Decodes an extra view (upload or AI output) to the working size with its
 * mask: the alpha channel of transparent images, else a plain border colour
 * flood-filled away; null when neither works (the whole image is used).
 */
export async function decodeView(file: Blob, name: string, origin: ViewEntry['origin']): Promise<ViewEntry> {
  const src = await prepareSource(file, name);
  const { mask } = quickMask(src.image, 'border');
  return { file, image: src.image, mask, origin, name, align: DEFAULT_VIEW_ALIGN };
}

/**
 * Placeholder registration for a view that could not be checked (an empty
 * silhouette or a failure): 'weak', identity, so the check is not retried in a loop.
 */
export function weakAlignment(view: OtherViewId, image: RGBAImage, align: ViewAlign): ViewAlignment {
  const identity = { dx: 0, dy: 0, scale: 1, flipX: align.flipX };
  return {
    id: view,
    status: 'weak',
    level: 'poor',
    score: 0,
    confidence: 0,
    applied: identity,
    suggested: identity,
    residual: { dx: 0, dy: 0, scale: 1 },
    cut: { top: false, bottom: false, left: false, right: false },
    fitBox: { x0: 0, y0: 0, x1: image.width, y1: image.height },
    trust: align.trust,
    notes: [{ code: 'weak', text: ALIGN_TEXT.weak }],
    guides: { rows: [], cols: [] },
  };
}

/** "cat.png" → "cat-ai.png" (prepared front) / "cat-back.png" (a generated view). */
export function aiFileName(sourceName: string, tag: string): string {
  return `${baseName(sourceName) || 'image'}-${tag}.png`;
}

/** The image-edit provider to use now (the chosen one, else the default / first usable). */
function editProviderOf(s: AppState): ProviderConfig | null {
  return resolveProvider(s.aiSettings, 'image-edit', s.aiProviderId, s.serverAvailable);
}

/**
 * The image-edit provider for new views: the chosen one when it can render
 * views (Stability keeps the composition), else the first usable one that can.
 */
export function viewProviderOf(s: Pick<AppState, 'aiSettings' | 'aiProviderId' | 'serverAvailable'>): ProviderConfig | null {
  const chosen = resolveProvider(s.aiSettings, 'image-edit', s.aiProviderId, s.serverAvailable);
  if (chosen && canRenderViews(chosen)) return chosen;
  return usableProviders(s.aiSettings, 'image-edit', s.serverAvailable).find(canRenderViews) ?? null;
}

/** Background removal of AI outputs: a provider offering it, else null (the local model). */
function bgProviderOf(s: AppState): ProviderConfig | null {
  return resolveProvider(s.aiSettings, 'background-removal', null, s.serverAvailable);
}

/** Changes when any provider becomes (un)usable: drivers reading the AI settings re-check their availability. */
export function aiUsabilityKey(settings: AiSettings, serverAvailable: boolean): string {
  const usable = settings.providers.filter((p) => providerUsable(p, serverAvailable).ok).map((p) => p.id);
  return `${serverAvailable ? 1 : 0}|${usable.join(',')}|${JSON.stringify(settings.defaults)}`;
}

/** Identity of an object's meshes and geometries (changes when a rig swaps them). */
export function meshSignature(root: Object3D): string {
  const parts: string[] = [];
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (mesh.isMesh) parts.push(`${mesh.uuid}:${mesh.geometry?.uuid ?? ''}`);
  });
  return parts.join('|');
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number']);

/**
 * Keys typed here belong to the field or the dialog, not to the page
 * shortcuts: text fields, contentEditable, and anything inside a dialog.
 */
export function isShortcutExcluded(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || el.isContentEditable) return true;
  if (tag === 'INPUT' && TEXT_INPUT_TYPES.has(((el as HTMLInputElement).type || 'text').toLowerCase())) return true;
  return typeof el.closest === 'function' && !!el.closest('dialog, [role="dialog"], [role="alertdialog"]');
}

/** The model on screen and the input it was built from (texture image / rig front image). */
export interface ModelSource {
  source: SourceImage;
  mask: Mask | null;
}

export function useStudio() {
  const store = useMemo(() => browserStorage(), []);
  const session = useMemo(() => browserSessionStorage(), []);
  const [state, dispatch] = useReducer(reducer, undefined, () =>
    createInitialState({
      store,
      session,
      languages: typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : navigator.language) : undefined,
      drivers: DRIVERS,
      defaultDriverId: DEFAULT_DRIVER_ID,
      prefersLight: prefersLightScheme(),
    }),
  );
  const [model, setModelState] = useState<BuiltModel | null>(null);
  const [modelSource, setModelSource] = useState<ModelSource | null>(null);
  const [geometryVersion, setGeometryVersion] = useState(0);
  /** Bumped when the model object changes in place (rig / unrig) so readers re-render. */
  const [modelVersion, setModelVersion] = useState(0);
  /** Bumped to remount the sculpt panel (its session) after its edits were thrown away. */
  const [sculptEpoch, setSculptEpoch] = useState(0);
  const coreRef = useRef<ViewerCore | null>(null);
  const jobRef = useRef<AbortController | null>(null);
  const aiJobRef = useRef<AbortController | null>(null);
  const humanRef = useRef<{ image: RGBAImage; ctrl: AbortController; promise: Promise<HumanAnalysis | null> } | null>(null);
  const loadSeq = useRef(0);
  /** Bumped by a brand-new image: view uploads still decoding belong to the old subject. */
  const viewSeq = useRef(0);
  /** Set synchronously while an image decodes (stateRef only catches up on render). */
  const loadingRef = useRef(false);
  /** View uploads still decoding: no job starts meanwhile (it would miss / overwrite the view). */
  const viewDecodes = useRef(0);
  /** Uploaded views whose AI background removal could not start yet (another job ran). */
  const bgPending = useRef(new Map<OtherViewId, ViewEntry>());
  /** The front prepared for the view consistency checks (one prepareView per front image / mask). */
  const frontPrepRef = useRef<{ image: RGBAImage; mask: Mask | null; prepared: PreparedView | null } | null>(null);
  /** The alignment request each view's check was computed for (by identity; the reducer makes a new one per edit). */
  const checkedFor = useRef<Partial<Record<OtherViewId, ViewAlign>>>({});
  const stateRef = useRef(state);
  stateRef.current = state;
  const modelRef = useRef(model);
  modelRef.current = model;
  const modelSourceRef = useRef(modelSource);
  modelSourceRef.current = modelSource;

  const setModel = useCallback((built: BuiltModel | null, input: ModelSource | null) => {
    modelRef.current = built;
    modelSourceRef.current = input;
    setModelState(built);
    setModelSource(input);
  }, []);

  // Publish the AI settings for drivers (outside React) before availability checks read them.
  useEffect(() => {
    setCurrentAiSettings(state.aiSettings, state.serverAvailable);
  }, [state.aiSettings, state.serverAvailable]);

  const driver: Driver = getDriver(state.driverId) ?? DRIVERS[0];
  const aiKey = useMemo(() => aiUsabilityKey(state.aiSettings, state.serverAvailable), [state.aiSettings, state.serverAvailable]);
  const availability = useAvailability(driver, driver.category === 'cloud' ? aiKey : undefined);
  const availabilityRef = useRef(availability);
  availabilityRef.current = availability;

  // Persist settings / params (secrets are stripped by saveState).
  useEffect(() => {
    saveState(store, stateRef.current, DRIVERS);
  }, [store, state.lang, state.theme, state.explicitTheme, state.driverId, state.bgMode, state.view, state.stlSizeMm, state.showMask, state.meshParams, state.params, state.prep, state.aiProviderId]);

  // AI provider settings: keys to exactly one store (local when remembered, else session).
  // Settings just reloaded from another tab's write are not written back
  // (two open tabs would otherwise echo each other's writes forever).
  const aiFromStorageRef = useRef<AiSettings | null>(null);
  useEffect(() => {
    if (aiFromStorageRef.current === state.aiSettings) return;
    const saved = saveAiSettings(store, session, state.aiSettings);
    // Another tab may have turned "remember keys" off meanwhile: show what was saved.
    if (saved.rememberKeys !== state.aiSettings.rememberKeys) dispatch({ type: 'setAiSettings', settings: saved });
  }, [store, session, state.aiSettings]);

  // Another tab changed the AI settings: reload them (keeping this tab's server-managed entries).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && !e.key.endsWith(AI_SETTINGS_KEY) && !e.key.endsWith(AI_KEYS_KEY)) return;
      const cur = stateRef.current.aiSettings;
      const managed = cur.providers.filter((p) => p.managed);
      const loaded = loadAiSettings(store, session);
      const next = managed.length ? mergeServerProviders(loaded, managed) : loaded;
      aiFromStorageRef.current = next;
      dispatch({ type: 'setAiSettings', settings: next });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [store, session]);

  // Is there a server (managed providers, proxy)? Static hosting answers 404 / HTML → no.
  useEffect(() => {
    const ctrl = new AbortController();
    void fetchServerProviders(ctrl.signal).then((providers) => {
      if (!ctrl.signal.aborted) dispatch({ type: 'serverProbed', providers });
    });
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    document.documentElement.lang = state.lang;
    document.title = t('docTitle', state.lang);
  }, [state.lang]);
  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
  }, [state.theme]);

  const cancel = useCallback(() => {
    const job = jobRef.current;
    if (!job) return;
    jobRef.current = null;
    job.abort();
    dispatch({ type: 'jobCancelled' });
  }, []);

  const cancelAi = useCallback(() => {
    const job = aiJobRef.current;
    if (!job) return;
    aiJobRef.current = null;
    job.abort();
    dispatch({ type: 'aiJobCancelled' });
  }, []);

  // ---------------------------------------------------------------- human analysis

  /**
   * Human analysis of `image` (MediaPipe; cached per image by analyzeHuman,
   * shared with the depth driver). One run per image; a failed / unavailable
   * detection is retried on the next request.
   */
  const analyze = useCallback((image: RGBAImage): Promise<HumanAnalysis | null> => {
    const cur = humanRef.current;
    if (cur && cur.image === image) return cur.promise;
    cur?.ctrl.abort();
    const ctrl = new AbortController();
    dispatch({ type: 'humanStart', image });
    // Only the current request reports: a superseded one (image changed and
    // maybe back again, e.g. revert to the original) must not touch the state.
    const promise = analyzeHuman(image, { signal: ctrl.signal }).then(
      (analysis) => {
        if (humanRef.current?.ctrl === ctrl) {
          if (analysis.unavailableReason || analysis.failed) humanRef.current = null;
          dispatch({ type: 'humanDone', image, analysis });
        }
        return analysis;
      },
      (e: unknown) => {
        if (humanRef.current?.ctrl === ctrl) {
          humanRef.current = null;
          dispatch({ type: 'humanCancelled', image });
        }
        if (!isAbortError(e)) console.warn('[human] analysis failed', e);
        return null;
      },
    );
    humanRef.current = { image, ctrl, promise };
    return promise;
  }, []);

  // A new front image stops the analysis of the previous one.
  const frontImage = state.source?.image ?? null;
  useEffect(() => {
    const cur = humanRef.current;
    if (cur && cur.image !== frontImage) {
      humanRef.current = null;
      cur.ctrl.abort();
    }
  }, [frontImage]);

  // Derived AI info for the panels.
  const editProviders = useMemo(() => usableProviders(state.aiSettings, 'image-edit', state.serverAvailable), [state.aiSettings, state.serverAvailable]);
  const editProvider = useMemo(
    () => resolveProvider(state.aiSettings, 'image-edit', state.aiProviderId, state.serverAvailable),
    [state.aiSettings, state.aiProviderId, state.serverAvailable],
  );
  const viewProvider = useMemo(
    () => viewProviderOf({ aiSettings: state.aiSettings, aiProviderId: state.aiProviderId, serverAvailable: state.serverAvailable }),
    [state.aiSettings, state.aiProviderId, state.serverAvailable],
  );
  const canPrep = editProviders.length > 0;

  // The AI prep step shows whether the subject is a person (steers T-pose / body completion).
  // Only once a provider can run the preparation: the detection models are a ~20 MB download.
  useEffect(() => {
    if (state.step === 'prep' && frontImage && canPrep) void analyze(frontImage);
  }, [state.step, frontImage, analyze, canPrep]);

  /** isHuman for the AI prompts: detection only matters for subject 'auto'. */
  const isHumanFor = useCallback(
    async (prep: PrepOptions, image: RGBAImage, signal: AbortSignal, onProgress: (p: Progress) => void): Promise<boolean> => {
      if (prep.subject !== 'auto') return prep.subject === 'human';
      onProgress({ label: UI.detectingPeople });
      const a = await abortable(analyze(image), signal);
      return !!a?.isHuman;
    },
    [analyze],
  );

  // ---------------------------------------------------------------- images

  /** Loads a new front image; resolves true when it became the source (false: failed or superseded). */
  const loadFile = useCallback(
    async (file: Blob, name: string): Promise<boolean> => {
      const seq = ++loadSeq.current;
      cancel();
      loadingRef.current = true;
      dispatch({ type: 'imageLoading' });
      try {
        const source = await prepareSource(file, name);
        if (seq !== loadSeq.current) return false;
        loadingRef.current = false;
        const { mask, note } = quickMask(source.image, stateRef.current.bgMode);
        // A job started from the previous image while this one decoded must not
        // finish under the new image's name; AI work on the old subject stops too.
        cancel();
        cancelAi();
        viewSeq.current++;
        dispatch({ type: 'imageLoaded', source, mask, maskNote: note });
        return true;
      } catch (e) {
        if (seq !== loadSeq.current) return false;
        loadingRef.current = false;
        dispatch({ type: 'imageFailed', error: errorToText(e) });
        return false;
      }
    },
    [cancel, cancelAi],
  );

  /** A procedural sample; samples with extra views (the T-pose mannequin) fill the view slots too. */
  const loadSample = useCallback(
    async (spec: SampleSpec) => {
      try {
        const blob = await renderSample(spec);
        if (!(await loadFile(new File([blob], spec.fileName, { type: 'image/png' }), spec.fileName))) return;
        const seq = viewSeq.current;
        for (const [view, draw] of Object.entries(spec.views ?? {}) as [OtherViewId, NonNullable<SampleSpec['draw']>][]) {
          const name = aiFileName(spec.fileName, view);
          const entry = await decodeView(new File([await renderSample(spec, draw)], name, { type: 'image/png' }), name, 'upload');
          if (seq !== viewSeq.current) return; // another image (or a clear) came in meanwhile
          dispatch({ type: 'viewSet', view, entry });
        }
      } catch (e) {
        dispatch({ type: 'imageFailed', error: errorToText(e) });
      }
    },
    [loadFile],
  );

  const clearImage = useCallback(() => {
    loadSeq.current++;
    viewSeq.current++;
    loadingRef.current = false;
    cancel();
    cancelAi();
    dispatch({ type: 'clearImage' });
  }, [cancel, cancelAi]);

  const setBgMode = useCallback((mode: BackgroundMode) => {
    const src = stateRef.current.source;
    const { mask, note } = src ? quickMask(src.image, mode) : { mask: null, note: null };
    dispatch({ type: 'setBgMode', mode, mask, maskNote: note });
  }, []);

  // ---------------------------------------------------------------- 3D generation

  /**
   * Generates a new model. When the model on screen carries sculpt / rig /
   * depth edits, the first call only asks for confirmation (GeneratePanel
   * shows it); `confirmed` goes ahead and replaces them.
   */
  const generate = useCallback(async (opts?: { confirmed?: boolean }) => {
    const s = stateRef.current;
    const drv = getDriver(s.driverId);
    // Same guard as the Generate button (the Ctrl/Cmd+Enter shortcut lands here too).
    if (!s.source || !drv || jobRef.current || aiJobRef.current || loadingRef.current || viewDecodes.current > 0) return;
    if (!canGenerate(s, availabilityRef.current, drv)) return;
    if (!opts?.confirmed && hasUnsavedModelEdits(s)) {
      dispatch({ type: 'setRegenConfirm', open: true });
      return;
    }
    const ctrl = new AbortController();
    jobRef.current = ctrl;
    const source = s.source;
    const bgMode = s.bgMode;
    // Non-AI masks are already computed for the preview; the AI mask is reused when cached.
    const mask = bgMode === 'ai' ? (s.aiMask && s.aiMask.source === source ? s.aiMask.mask : undefined) : s.mask;
    const isCurrent = () => jobRef.current === ctrl;
    const progress = throttleLatest((p: Progress) => {
      if (isCurrent()) dispatch({ type: 'jobProgress', progress: p });
    });
    const params = s.params[drv.id] ?? defaultParams(drv.params);
    dispatch({ type: 'jobStart' });
    const t0 = performance.now();
    try {
      const out = await runPipeline({
        source,
        bgMode,
        driver: drv,
        params,
        meshParams: meshParamsForJob(s),
        signal: ctrl.signal,
        onProgress: progress.push,
        mask,
        views: extraViewSet(s.views),
      });
      progress.cancel();
      if (!isCurrent()) {
        disposeObject(out.model.object);
        return;
      }
      jobRef.current = null;
      const built = out.model;
      setModel(built, { source, mask: out.inputMask });
      dispatch({
        type: 'jobDone',
        result: {
          driverId: drv.id,
          kind: built.kind,
          stats: built.stats,
          depthPreview: built.depth ? depthToRGBA(built.depth, built.mask) : null,
          elapsedMs: performance.now() - t0,
          sourceName: source.name,
          fusion: fusionReportOf(built.object),
        },
        source,
        bgMode,
        inputMask: out.inputMask,
      });
      // Human-detail drivers analysed the image already (cached): show what they found.
      if (drv.badges.includes('human-detail') && params.humanDetail !== false && stateRef.current.source === source) void analyze(source.image);
    } catch (e) {
      progress.cancel();
      if (!isCurrent()) return;
      jobRef.current = null;
      if (ctrl.signal.aborted || isAbortError(e)) dispatch({ type: 'jobCancelled' });
      else {
        console.error(e);
        dispatch({ type: 'jobFailed', error: errorToText(e) });
      }
    }
  }, [analyze, setModel]);

  // Live re-meshing: rebuild the surface from the cached depth (never re-runs the driver).
  // Paused while the model carries sculpt edits, is being sculpted or is rigged.
  const paused = remeshPaused(state);
  useEffect(() => {
    if (!model?.remesh || paused || model.meshKey === meshKeyOf(state.meshParams)) return;
    const params = state.meshParams;
    const id = window.setTimeout(() => {
      try {
        const stats = model.remesh!(params);
        setGeometryVersion((v) => v + 1);
        dispatch({ type: 'statsUpdated', stats });
      } catch (e) {
        console.error(e);
        dispatch({ type: 'jobFailed', error: errorToText(e) });
      }
    }, REMESH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [model, state.meshParams, paused]);

  // ---------------------------------------------------------------- AI jobs

  /** Starts the one AI job (null when another job / a decode is in the way). */
  const startAiJob = useCallback((kind: AiJobKind, target: OtherViewId | 'all' | null) => {
    if (aiJobRef.current || jobRef.current || loadingRef.current || viewDecodes.current > 0) return null;
    const ctrl = new AbortController();
    aiJobRef.current = ctrl;
    const isCurrent = () => aiJobRef.current === ctrl;
    const progress = throttleLatest((p: Progress) => {
      if (isCurrent()) dispatch({ type: 'aiJobProgress', progress: p });
    });
    dispatch({ type: 'aiJobStart', kind, target });
    /** Ends the job (true when it was still the current one). */
    const finish = (e?: unknown): boolean => {
      progress.cancel();
      if (!isCurrent()) return false;
      aiJobRef.current = null;
      if (e === undefined) dispatch({ type: 'aiJobDone' });
      else if (ctrl.signal.aborted || isAbortError(e)) dispatch({ type: 'aiJobCancelled' });
      else {
        console.error(e);
        dispatch({ type: 'aiJobFailed', kind, error: errorToText(e) });
      }
      return true;
    };
    return { signal: ctrl.signal, onProgress: progress.push, isCurrent, finish };
  }, []);

  const runPrep = useCallback(async () => {
    const s = stateRef.current;
    const source = s.source;
    if (!source) return;
    const needed = prepNeeded(s.prep);
    if (!needed && !s.prep.removeBackground) {
      dispatch({ type: 'aiJobFailed', kind: 'prep', error: UI.aiNothingToDo });
      return;
    }
    // Background removal alone needs no image-edit provider (see prepareFrontImage).
    const cfg = needed ? editProviderOf(s) : null;
    if (needed && !cfg) {
      dispatch({ type: 'aiJobFailed', kind: 'prep', error: s.aiSettings.providers.length ? UI.aiNoEditProvider : UI.aiNoProviders });
      return;
    }
    const job = startAiJob('prep', null);
    if (!job) return;
    try {
      const isHuman = await isHumanFor(s.prep, source.image, job.signal, job.onProgress);
      const blob = await prepareFrontImage(source.file, s.prep, cfg, {
        signal: job.signal,
        onProgress: job.onProgress,
        isHuman,
        bgProvider: bgProviderOf(s),
      });
      throwIfAborted(job.signal);
      const prepared = await prepareSource(blob, aiFileName(source.name, 'ai'));
      throwIfAborted(job.signal);
      if (!job.isCurrent()) return;
      job.finish();
      dispatch({ type: 'prepReady', prepared, options: s.prep });
    } catch (e) {
      job.finish(e);
    }
  }, [startAiJob, isHumanFor]);

  /** Generates `targets` one after the other; each view shows up as soon as it is ready. */
  const runViews = useCallback(
    async (targets: OtherViewId[], busy: OtherViewId | 'all') => {
      const s = stateRef.current;
      const source = s.source;
      if (!source || targets.length === 0) return;
      const cfg = viewProviderOf(s);
      if (!cfg) {
        const error = editProviderOf(s) ? UI.aiNoViewProvider : s.aiSettings.providers.length ? UI.aiNoEditProvider : UI.aiNoProviders;
        dispatch({ type: 'aiJobFailed', kind: 'views', error });
        return;
      }
      const job = startAiJob('views', busy);
      if (!job) return;
      try {
        const isHuman = await isHumanFor(s.prep, source.image, job.signal, job.onProgress);
        const others: Partial<Record<ViewId, Blob>> = {};
        for (const v of OTHER_VIEWS) {
          const e = s.views[v];
          if (e) others[v] = e.file;
        }
        for (const view of targets) {
          throwIfAborted(job.signal);
          const refs = { ...others };
          delete refs[view]; // a view being redone is not its own reference
          const blob = await generateViewImage(view, { front: source.file, others: refs }, s.prep, cfg, {
            signal: job.signal,
            onProgress: job.onProgress,
            isHuman,
            bgProvider: bgProviderOf(s),
            frontPrep: s.frontPrep,
          });
          throwIfAborted(job.signal);
          const entry = await decodeView(blob, aiFileName(source.name, view), 'ai');
          throwIfAborted(job.signal);
          if (!job.isCurrent()) return;
          dispatch({ type: 'viewSet', view, entry });
          others[view] = blob;
        }
        job.finish();
      } catch (e) {
        job.finish(e);
      }
    },
    [startAiJob, isHumanFor],
  );

  const generateView = useCallback((view: OtherViewId) => void runViews([view], view), [runViews]);
  const generateMissing = useCallback(() => {
    const views = stateRef.current.views;
    void runViews(
      OTHER_VIEWS.filter((v) => !views[v]),
      'all',
    );
  }, [runViews]);

  /**
   * Background removal (local MODNet) for an uploaded view without a usable
   * mask, in the AI background mode. When another job is running it is queued
   * and runs once that job ends.
   */
  const removeViewBackground = useCallback(
    async (view: OtherViewId, entry: ViewEntry) => {
      const job = startAiJob('views', view);
      if (!job) {
        bgPending.current.set(view, entry);
        return;
      }
      bgPending.current.delete(view);
      try {
        job.onProgress({ label: UI.removingViewBg });
        const mask = await resolveMask(entry.image, 'ai', { signal: job.signal, onProgress: job.onProgress });
        throwIfAborted(job.signal);
        if (!job.isCurrent()) return;
        if (stateRef.current.views[view] === entry) dispatch({ type: 'viewSet', view, entry: { ...entry, mask } });
        job.finish();
      } catch (e) {
        job.finish(e);
      }
    },
    [startAiJob],
  );

  /**
   * Runs the next queued background removal once nothing is in the way (one
   * at a time; a view replaced, cleared or no longer in the AI mode is skipped).
   */
  const drainBgQueue = useCallback(() => {
    if (jobRef.current || aiJobRef.current || loadingRef.current || viewDecodes.current > 0) return;
    const s = stateRef.current;
    for (const [view, entry] of bgPending.current) {
      bgPending.current.delete(view);
      if (s.bgMode === 'ai' && s.views[view] === entry && !entry.mask) {
        void removeViewBackground(view, entry);
        return;
      }
    }
  }, [removeViewBackground]);

  const uploadView = useCallback(
    async (view: OtherViewId, file: File) => {
      if (aiJobRef.current) return; // the slots are locked while an AI job runs
      const seq = viewSeq.current;
      viewDecodes.current++;
      let entry: ViewEntry;
      try {
        entry = await decodeView(file, file.name || `${view}.png`, 'upload');
      } catch (e) {
        if (seq !== viewSeq.current) return;
        dispatch({ type: 'aiJobFailed', kind: 'views', error: errorToText(e) });
        return;
      } finally {
        viewDecodes.current--;
      }
      // A views job would not use the upload as a reference and could overwrite it.
      if (seq !== viewSeq.current || !stateRef.current.source || aiJobRef.current) return;
      dispatch({ type: 'viewSet', view, entry });
      // Queued (see drainBgQueue) when another job or decode is in the way.
      if (!entry.mask && stateRef.current.bgMode === 'ai') void removeViewBackground(view, entry);
      else drainBgQueue();
    },
    [removeViewBackground, drainBgQueue],
  );

  // Queued background removals start when the job in the way ends.
  const jobsIdle = state.status !== 'running' && !state.aiJob && !state.loadingImage;
  useEffect(() => {
    if (jobsIdle) drainBgQueue();
  }, [jobsIdle, drainBgQueue]);

  const clearView = useCallback((view: OtherViewId) => {
    if (aiJobRef.current) return;
    dispatch({ type: 'viewClear', view });
  }, []);

  // ---------------------------------------------------------------- view consistency checks

  /**
   * Pre-run check of every extra view against the front: a direct call to
   * the fusion's registration (prepareView + alignView, a few ms per view),
   * one view per tick, after the render that showed the "checking" badge.
   * It uses the preview mask (in the 'ai' background mode possibly null → the
   * alpha channel, a plain border or the whole image); the fusion's own
   * report after a run is authoritative. A view that cannot be checked gets
   * a synthetic 'weak' result so it is not retried in a loop.
   *
   * A view whose request changed since its check (a manual offset / scale,
   * a trust) is checked again once the edits settle (CHECK_REFRESH_MS): the
   * badge re-scores the manual values live meanwhile, but only the core knows
   * the confidence at the new placement, so this is what the fusion's report
   * will say. Views without a check come first.
   */
  useEffect(() => {
    if (state.loadingImage || !frontImage) return;
    const active = (v: OtherViewId) => {
      const e = state.views[v];
      return !!e && e.align.trust !== 'off';
    };
    const missing = OTHER_VIEWS.find((v) => active(v) && !state.viewChecks[v]);
    const pending = missing ?? OTHER_VIEWS.find((v) => active(v) && checkedFor.current[v] !== state.views[v]!.align);
    if (!pending) return;
    const entry = state.views[pending]!;
    const mask = state.mask;
    const id = window.setTimeout(
      () => {
        let check: ViewAlignment;
        try {
          let fp = frontPrepRef.current;
          if (!fp || fp.image !== frontImage || fp.mask !== mask) {
            fp = { image: frontImage, mask, prepared: prepareView({ id: 'front', image: frontImage, mask }) };
            frontPrepRef.current = fp;
          }
          const view = prepareView({ id: pending, image: entry.image, mask: entry.mask, align: entry.align });
          check = fp.prepared && view ? alignView(fp.prepared, view, { mode: 'auto' }) : weakAlignment(pending, entry.image, entry.align);
        } catch (e) {
          console.warn('[align]', e);
          check = weakAlignment(pending, entry.image, entry.align);
        }
        checkedFor.current[pending] = entry.align;
        dispatch({ type: 'viewChecked', view: pending, front: frontImage, image: entry.image, check });
      },
      missing ? 0 : CHECK_REFRESH_MS,
    );
    return () => window.clearTimeout(id);
  }, [frontImage, state.mask, state.views, state.viewChecks, state.loadingImage]);

  const setViewAlign = useCallback((view: OtherViewId, patch: Partial<ViewAlign>) => dispatch({ type: 'viewAlign', view, patch }), []);
  const autoAlignView = useCallback((view: OtherViewId) => dispatch({ type: 'viewAlignAuto', view }), []);
  const resetViewAlign = useCallback((view: OtherViewId) => dispatch({ type: 'viewAlignReset', view }), []);

  /** English prompt for drawing `view` with the front's exact framing (null without a front). */
  const viewPromptText = useCallback((view: OtherViewId): string | null => {
    const s = stateRef.current;
    if (!s.source) return null;
    const analysis = s.human && s.human.image === s.source.image && s.human.analysis !== 'analyzing' ? s.human.analysis : null;
    const isHuman = analysis ? analysis.isHuman || isHumanoid(s.prep, { isHuman: false }) : isHumanoid(s.prep, { isHuman: false });
    const tPose = s.frontPrep?.tPose ?? s.prep.tPose;
    return buildUserViewPrompt(view, { front: measureFrontFraming(s.source.image, s.mask), isHuman, tPose });
  }, []);

  /** Copies the view prompt to the clipboard; false when there is none or the clipboard refused. */
  const copyViewPrompt = useCallback(
    async (view: OtherViewId): Promise<boolean> => {
      const text = viewPromptText(view);
      if (!text) return false;
      try {
        const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
        if (!clipboard?.writeText) return false;
        await clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
    [viewPromptText],
  );

  const acceptPrepared = useCallback(() => {
    const s = stateRef.current;
    if (!s.prepared || !s.source || jobRef.current || aiJobRef.current || loadingRef.current) return;
    const { mask, note } = quickMask(s.prepared.image, s.bgMode);
    dispatch({ type: 'prepAccept', mask, maskNote: note });
  }, []);

  const revertOriginal = useCallback(() => {
    const s = stateRef.current;
    if (!s.original || jobRef.current || aiJobRef.current || loadingRef.current) return;
    const { mask, note } = quickMask(s.original.image, s.bgMode);
    dispatch({ type: 'revertOriginal', mask, maskNote: note });
  }, []);

  const detectHuman = useCallback(() => {
    const src = stateRef.current.source;
    if (src) void analyze(src.image);
  }, [analyze]);

  // ---------------------------------------------------------------- model edits

  /** `strokes`: the session's stroke count after the edit (0 after undoing / resetting everything). */
  const onSculptEdited = useCallback((stats: MeshStats, strokes?: number) => dispatch({ type: 'sculptEdited', stats, strokes }), []);
  /** A new sculpt session starts from the geometry as it is now. */
  const onSculptSession = useCallback(() => dispatch({ type: 'sculptSessionStart' }), []);
  const onSculptActive = useCallback((active: boolean) => dispatch({ type: 'setSculptActive', active }), []);

  /** Throws the sculpt edits away: rebuilds the depth surface from the cached depth. */
  const discardSculpt = useCallback(() => {
    const m = modelRef.current;
    const s = stateRef.current;
    if (!m?.remesh || s.rigged) return;
    try {
      const stats = m.remesh(s.meshParams);
      setGeometryVersion((v) => v + 1);
      setSculptEpoch((v) => v + 1); // a fresh sculpt session for the new geometry
      dispatch({ type: 'sculptDiscarded', stats });
    } catch (e) {
      console.error(e);
      dispatch({ type: 'jobFailed', error: errorToText(e) });
    }
  }, []);

  // The rig reports every change (meshes swapped, clips picked for export);
  // stats are recomputed only when the meshes themselves changed.
  const meshSig = useRef('');
  const onRigChanged = useCallback(() => {
    const m = modelRef.current;
    setModelVersion((v) => v + 1);
    if (!m) return;
    const sig = meshSignature(m.object);
    if (sig === meshSig.current) return;
    meshSig.current = sig;
    dispatch({ type: 'statsUpdated', stats: statsForObject(m.object) });
  }, []);
  const onRigged = useCallback((rigged: boolean) => dispatch({ type: 'setRigged', rigged }), []);

  /** Depth map editor result: a new depth model (texture from the same image), re-meshable as before. */
  const applyDepthEdit = useCallback(
    (depth: DepthMap) => {
      const m = modelRef.current;
      const input = modelSourceRef.current;
      if (!m?.depth || !input || jobRef.current) return;
      const texture = createImageTexture(opaqueTextureImage(input.source.image));
      try {
        const built = buildDepthModel(depth, m.mask, texture, stateRef.current.meshParams);
        setModel(built, input);
        dispatch({ type: 'depthEdited', stats: built.stats, depthPreview: depthToRGBA(depth, m.mask) });
      } catch (e) {
        texture.dispose();
        console.error(e);
        dispatch({ type: 'jobFailed', error: errorToText(e) });
      }
    },
    [setModel],
  );

  // ---------------------------------------------------------------- global input

  // Paste an image from the clipboard anywhere on the page.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (!file) continue;
          e.preventDefault();
          const ext = item.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
          void loadFile(file, file.name && file.name !== 'image.png' ? file.name : `pasted-image.${ext}`);
          return;
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [loadFile]);

  // Ctrl/Cmd + Enter generates (asking first when that discards edits), Escape
  // closes that question, else cancels (the 3D job first, else the AI job).
  // Not while typing in a field or a dialog, and not in sculpt mode, where Ctrl
  // is held down to invert the brush.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        if (e.defaultPrevented || isShortcutExcluded(e.target) || stateRef.current.sculptActive) return;
        e.preventDefault();
        void generate();
      } else if (e.key === 'Escape') {
        if (stateRef.current.regenConfirm) dispatch({ type: 'setRegenConfirm', open: false });
        else if (jobRef.current) cancel();
        else if (aiJobRef.current) cancelAi();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [generate, cancel, cancelAi]);

  // Abort running work when the app unmounts.
  useEffect(
    () => () => {
      jobRef.current?.abort();
      aiJobRef.current?.abort();
      humanRef.current?.ctrl.abort();
    },
    [],
  );

  const actions = useMemo(
    () => ({
      loadFile,
      loadSample,
      clearImage,
      setBgMode,
      generate,
      confirmRegenerate: () => void generate({ confirmed: true }),
      cancelRegenerate: () => dispatch({ type: 'setRegenConfirm', open: false }),
      cancel,
      setLang: (lang: Lang) => dispatch({ type: 'setLang', lang }),
      setTheme: (theme: Theme) => dispatch({ type: 'setTheme', theme }),
      setShowMask: (show: boolean) => dispatch({ type: 'setShowMask', show }),
      selectDriver: (id: string) => {
        const d = getDriver(id);
        if (d) dispatch({ type: 'selectDriver', driver: d });
      },
      setParam: (driverId: string, key: string, value: ParamValue) => dispatch({ type: 'setParam', driverId, key, value }),
      resetParams: (d: Driver) => dispatch({ type: 'resetParams', driver: d }),
      setMeshParam: (key: string, value: ParamValue) => dispatch({ type: 'setMeshParam', key, value }),
      resetMeshParams: () => dispatch({ type: 'resetMeshParams' }),
      setView: (view: Partial<ViewSettings>) => dispatch({ type: 'setView', view }),
      dismissError: () => dispatch({ type: 'dismissError' }),
      setStlSize: (mm: number) => dispatch({ type: 'setStlSize', mm }),
      // Steps
      setStep: (step: StepId) => dispatch({ type: 'setStep', step }),
      // AI settings
      setAiSettings: (settings: AiSettings) => dispatch({ type: 'setAiSettings', settings }),
      openAiSettings: () => dispatch({ type: 'setAiSettingsOpen', open: true }),
      closeAiSettings: () => dispatch({ type: 'setAiSettingsOpen', open: false }),
      setPrep: (patch: Partial<PrepOptions>) => dispatch({ type: 'setPrep', patch }),
      setAiProvider: (id: string | null) => dispatch({ type: 'setAiProvider', id }),
      // AI jobs
      runPrep,
      cancelAi,
      acceptPrepared,
      discardPrepared: () => dispatch({ type: 'prepDiscard' }),
      revertOriginal,
      generateView,
      generateMissing,
      uploadView,
      clearView,
      setViewAlign,
      autoAlignView,
      resetViewAlign,
      viewPromptText,
      copyViewPrompt,
      detectHuman,
      // Model edits
      onSculptEdited,
      onSculptSession,
      onSculptActive,
      discardSculpt,
      onRigChanged,
      onRigged,
      openDepthEditor: () => dispatch({ type: 'setDepthEditor', open: true }),
      closeDepthEditor: () => dispatch({ type: 'setDepthEditor', open: false }),
      applyDepthEdit,
    }),
    [
      loadFile,
      loadSample,
      clearImage,
      setBgMode,
      generate,
      cancel,
      runPrep,
      cancelAi,
      acceptPrepared,
      revertOriginal,
      generateView,
      generateMissing,
      uploadView,
      clearView,
      setViewAlign,
      autoAlignView,
      resetViewAlign,
      viewPromptText,
      copyViewPrompt,
      detectHuman,
      onSculptEdited,
      onSculptSession,
      onSculptActive,
      discardSculpt,
      onRigChanged,
      onRigged,
      applyDepthEdit,
    ],
  );

  return {
    state,
    driver,
    availability,
    model,
    modelSource,
    modelVersion,
    geometryVersion,
    sculptEpoch,
    coreRef,
    editProviders,
    editProvider,
    viewProvider,
    actions,
  };
}

export type Studio = ReturnType<typeof useStudio>;
