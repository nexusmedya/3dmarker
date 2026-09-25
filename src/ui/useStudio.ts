/**
 * Studio controller hook: owns the reducer state, the current model (outside
 * the reducer — it holds GPU resources), image loading, generation with
 * cancellation, live re-meshing, persistence and global shortcuts.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Driver, Lang, ParamValue, Progress } from '../core/types';
import { defaultParams } from '../core/types';
import { depthToRGBA } from '../core/image/ops';
import { DEFAULT_DRIVER_ID, DRIVERS, getDriver } from '../drivers';
import {
  isAbortError,
  meshKeyOf,
  prepareSource,
  quickMask,
  runPipeline,
  type BackgroundMode,
  type BuiltModel,
} from '../app/pipeline';
import { createInitialState, reducer, saveState, type Theme, type ViewSettings } from '../app/store';
import { browserStorage } from '../app/persist';
import { errorToText } from '../app/format';
import { throttleLatest } from '../app/throttle';
import { disposeObject } from '../app/dispose';
import { renderSample, type SampleSpec } from '../app/samples';
import type { ViewerCore } from '../app/viewer';

/** Delay before re-meshing after a mesh slider moves. */
export const REMESH_DEBOUNCE_MS = 150;

export function useStudio() {
  const store = useMemo(() => browserStorage(), []);
  const [state, dispatch] = useReducer(reducer, undefined, () =>
    createInitialState({
      store,
      languages: typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : navigator.language) : undefined,
      drivers: DRIVERS,
      defaultDriverId: DEFAULT_DRIVER_ID,
    }),
  );
  const [model, setModel] = useState<BuiltModel | null>(null);
  const [geometryVersion, setGeometryVersion] = useState(0);
  const coreRef = useRef<ViewerCore | null>(null);
  const jobRef = useRef<AbortController | null>(null);
  const loadSeq = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const driver: Driver = getDriver(state.driverId) ?? DRIVERS[0];

  // Persist settings / params (secrets are stripped by saveState).
  useEffect(() => {
    saveState(store, stateRef.current, DRIVERS);
  }, [store, state.lang, state.theme, state.driverId, state.bgMode, state.view, state.stlSizeMm, state.showMask, state.meshParams, state.params]);

  useEffect(() => {
    document.documentElement.lang = state.lang;
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

  const loadFile = useCallback(
    async (file: Blob, name: string) => {
      const seq = ++loadSeq.current;
      cancel();
      dispatch({ type: 'imageLoading' });
      try {
        const source = await prepareSource(file, name);
        if (seq !== loadSeq.current) return;
        const { mask, note } = quickMask(source.image, stateRef.current.bgMode);
        dispatch({ type: 'imageLoaded', source, mask, maskNote: note });
      } catch (e) {
        if (seq !== loadSeq.current) return;
        dispatch({ type: 'imageFailed', error: errorToText(e) });
      }
    },
    [cancel],
  );

  const loadSample = useCallback(
    async (spec: SampleSpec) => {
      try {
        const blob = await renderSample(spec);
        await loadFile(new File([blob], spec.fileName, { type: 'image/png' }), spec.fileName);
      } catch (e) {
        dispatch({ type: 'imageFailed', error: errorToText(e) });
      }
    },
    [loadFile],
  );

  const clearImage = useCallback(() => {
    loadSeq.current++;
    cancel();
    dispatch({ type: 'clearImage' });
  }, [cancel]);

  const setBgMode = useCallback((mode: BackgroundMode) => {
    const src = stateRef.current.source;
    const { mask, note } = src ? quickMask(src.image, mode) : { mask: null, note: null };
    dispatch({ type: 'setBgMode', mode, mask, maskNote: note });
  }, []);

  const generate = useCallback(async () => {
    const s = stateRef.current;
    const drv = getDriver(s.driverId);
    if (!s.source || !drv || jobRef.current) return;
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
    dispatch({ type: 'jobStart' });
    const t0 = performance.now();
    try {
      const out = await runPipeline({
        source,
        bgMode,
        driver: drv,
        params: s.params[drv.id] ?? defaultParams(drv.params),
        meshParams: s.meshParams,
        signal: ctrl.signal,
        onProgress: progress.push,
        mask,
      });
      progress.cancel();
      if (!isCurrent()) {
        disposeObject(out.model.object);
        return;
      }
      jobRef.current = null;
      const built = out.model;
      setModel(built);
      dispatch({
        type: 'jobDone',
        result: {
          driverId: drv.id,
          kind: built.kind,
          stats: built.stats,
          depthPreview: built.depth ? depthToRGBA(built.depth, built.mask) : null,
          elapsedMs: performance.now() - t0,
          sourceName: source.name,
        },
        source,
        bgMode,
        inputMask: out.inputMask,
      });
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
  }, []);

  // Live re-meshing: rebuild the surface from the cached depth (never re-runs the driver).
  useEffect(() => {
    if (!model?.remesh || model.meshKey === meshKeyOf(state.meshParams)) return;
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
  }, [model, state.meshParams]);

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

  // Ctrl/Cmd + Enter generates, Escape cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void generate();
      } else if (e.key === 'Escape' && jobRef.current) cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [generate, cancel]);

  // Abort a running job when the app unmounts.
  useEffect(() => () => jobRef.current?.abort(), []);

  const actions = useMemo(
    () => ({
      loadFile,
      loadSample,
      clearImage,
      setBgMode,
      generate,
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
    }),
    [loadFile, loadSample, clearImage, setBgMode, generate, cancel],
  );

  return { state, driver, model, geometryVersion, coreRef, actions };
}

export type Studio = ReturnType<typeof useStudio>;
