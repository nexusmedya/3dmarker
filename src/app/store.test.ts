import { describe, expect, it } from 'vitest';
import type { Driver, Mask, ParamSpec } from '../core/types';
import { MESH_PARAMS } from '../core/mesh/options';
import { DRIVERS } from '../drivers';
import { canGenerate, createInitialState, meshParamsForJob, reducer, saveState, type Action, type AppState } from './store';
import type { KeyValueStore } from './persist';
import type { SourceImage } from './pipeline';

class MemoryStore implements KeyValueStore {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

const SECRET_PARAMS: ParamSpec[] = [
  { kind: 'text', key: 'apiKey', label: { tr: 'a', en: 'a' }, default: '', secret: true },
  { kind: 'number', key: 'n', label: { tr: 'n', en: 'n' }, min: 0, max: 10, step: 1, default: 5 },
];

function driver(id: string, extra: Partial<Driver> = {}): Driver {
  return {
    id,
    name: { tr: id, en: id },
    description: { tr: '', en: '' },
    category: 'heuristic',
    badges: [],
    params: [],
    producesDepth: true,
    run: async () => {
      throw new Error('unused');
    },
    ...extra,
  };
}

const ml = driver('ml-a', { category: 'ml' });
const inflate = driver('silhouette-inflate');
const lum = driver('lum');
const cloud = driver('cloud', { category: 'cloud', params: SECRET_PARAMS, producesDepth: false });
const drivers = [ml, inflate, lum, cloud];

const init = (store: KeyValueStore | null = null, languages: string[] = ['en-US']): AppState =>
  createInitialState({ store, languages, drivers, defaultDriverId: 'ml-a' });

const src = (): SourceImage => ({ name: 'a.png', file: new Blob(), image: { width: 1, height: 1, data: new Uint8ClampedArray(4) } });
const mask = (): Mask => ({ width: 1, height: 1, data: new Uint8Array([1]) });

describe('createInitialState', () => {
  it('defaults: language from navigator, dark theme, default driver and params', () => {
    const s = init(null, ['tr-TR', 'en']);
    expect(s.lang).toBe('tr');
    expect(s.theme).toBe('dark');
    expect(s.driverId).toBe('ml-a');
    expect(s.params.cloud).toEqual({ apiKey: '', n: 5 });
    expect(s.meshParams.mode).toBe('relief');
    expect(Object.keys(s.meshParams).sort()).toEqual(MESH_PARAMS.map((p) => p.key).sort());
    expect(s.bgMode).toBe('auto');
    expect(init(null, ['de-DE']).lang).toBe('en');
  });

  it('restores persisted settings and ignores invalid values', () => {
    const store = new MemoryStore();
    store.setItem('3dmarker:settings', JSON.stringify({ lang: 'en', theme: 'light', driverId: 'lum', bgMode: 'border', view: { wireframe: true, clay: 'x' }, stlSizeMm: 80 }));
    store.setItem('3dmarker:params:cloud', JSON.stringify({ n: 99, apiKey: 'leaked?' }));
    store.setItem('3dmarker:mesh', JSON.stringify({ mode: 'bogus', resolution: 128 }));
    const s = init(store, ['tr']);
    expect(s.lang).toBe('en');
    expect(s.theme).toBe('light');
    expect(s.driverId).toBe('lum');
    expect(s.bgMode).toBe('border');
    expect(s.view.wireframe).toBe(true);
    expect(s.view.clay).toBe(false);
    expect(s.view.darkBackground).toBe(false); // follows the light theme by default
    expect(s.stlSizeMm).toBe(80);
    expect(s.params.cloud.n).toBe(10); // clamped
    expect(s.meshParams.mode).toBe('relief');
    expect(s.meshParams.resolution).toBe(128);
  });

  it('follows the OS light preference until the user picks a theme, without freezing it into storage', () => {
    const store = new MemoryStore();
    const light = createInitialState({ store, languages: 'en', drivers, defaultDriverId: 'ml-a', prefersLight: true });
    expect(light.theme).toBe('light');
    expect(light.view.darkBackground).toBe(false);
    saveState(store, light, drivers);
    const saved = JSON.parse(store.getItem('3dmarker:settings')!);
    expect(saved.theme).toBeUndefined();
    expect(saved.view.darkBackground).toBeUndefined(); // follows the theme
    expect(saved.view.texture).toBe(true);
    // Next visit with a dark OS: dark theme and background.
    const dark = createInitialState({ store, languages: 'en', drivers, defaultDriverId: 'ml-a', prefersLight: false });
    expect(dark.theme).toBe('dark');
    expect(dark.view.darkBackground).toBe(true);
    // An explicit choice is persisted and wins over the OS preference.
    let s = reducer(dark, { type: 'setTheme', theme: 'dark' });
    s = reducer(s, { type: 'setView', view: { darkBackground: false } });
    saveState(store, s, drivers);
    const again = createInitialState({ store, languages: 'en', drivers, defaultDriverId: 'ml-a', prefersLight: true });
    expect(again.theme).toBe('dark');
    expect(again.explicitTheme).toBe(true);
    expect(again.view.darkBackground).toBe(false); // the toolbar override is kept
  });

  it('falls back when the stored driver no longer exists', () => {
    const store = new MemoryStore();
    store.setItem('3dmarker:settings', JSON.stringify({ driverId: 'gone' }));
    expect(init(store).driverId).toBe('ml-a');
  });

  it('works with the real driver registry', () => {
    const s = createInitialState({ store: null, languages: 'en', drivers: DRIVERS, defaultDriverId: 'depth-anything-v2-small' });
    expect(s.driverId).toBe('depth-anything-v2-small');
    for (const d of DRIVERS) expect(Object.keys(s.params[d.id]).sort()).toEqual(d.params.map((p) => p.key).sort());
  });
});

describe('saveState', () => {
  it('never persists secret params', () => {
    const store = new MemoryStore();
    let s = init(store);
    s = reducer(s, { type: 'setParam', driverId: 'cloud', key: 'apiKey', value: 'tsk_secret' });
    s = reducer(s, { type: 'setParam', driverId: 'cloud', key: 'n', value: 3 });
    saveState(store, s, drivers);
    const raw = [...store.map.values()].join('\n');
    expect(raw).not.toContain('tsk_secret');
    expect(JSON.parse(store.getItem('3dmarker:params:cloud')!)).toEqual({ n: 3 });
    const restored = init(store);
    expect(restored.params.cloud).toEqual({ apiKey: '', n: 3 });
  });
});

describe('reducer', () => {
  it('suggests double-sided for silhouette inflate and relief for ML drivers (once per switch)', () => {
    let s = reducer(init(), { type: 'selectDriver', driver: inflate });
    expect(s.driverId).toBe('silhouette-inflate');
    expect(s.meshParams.mode).toBe('double');
    expect(s.meshNotice?.en).toContain('Double');
    // The user may override it afterwards.
    s = reducer(s, { type: 'setMeshParam', key: 'mode', value: 'solid' });
    expect(s.meshParams.mode).toBe('solid');
    expect(s.meshNotice).toBeNull();
    // Heuristic without a suggestion keeps the mode.
    s = reducer(s, { type: 'selectDriver', driver: lum });
    expect(s.meshParams.mode).toBe('solid');
    s = reducer(s, { type: 'selectDriver', driver: ml });
    expect(s.meshParams.mode).toBe('relief');
  });

  it('defers the suggested mesh mode while a depth result is on screen (no silent re-mesh)', () => {
    const stats = { vertices: 1, triangles: 1, watertight: true };
    const done = (driverId: string): Action => ({
      type: 'jobDone',
      result: { driverId, kind: 'depth', stats, depthPreview: null, elapsedMs: 1, sourceName: 'a.png' },
      source: src(),
      bgMode: 'auto',
      inputMask: null,
    });
    let s = reducer(init(), { type: 'selectDriver', driver: inflate });
    s = reducer(reducer(s, { type: 'jobStart' }), done('silhouette-inflate'));
    expect(s.meshParams.mode).toBe('double');
    const shownParams = s.meshParams;

    // Browsing the driver select must not touch the params the displayed model uses.
    s = reducer(s, { type: 'selectDriver', driver: ml });
    expect(s.meshParams).toBe(shownParams);
    expect(s.pendingMeshMode).toBe('relief');
    expect(s.meshNotice).toBeNull();
    expect(meshParamsForJob(s)).toEqual({ ...shownParams, mode: 'relief' });

    // The next job applies it when it replaces the model.
    s = reducer(s, { type: 'jobStart' });
    expect(s.meshParams).toBe(shownParams);
    s = reducer(s, done('ml-a'));
    expect(s.meshParams.mode).toBe('relief');
    expect(s.pendingMeshMode).toBeNull();

    // A failed / cancelled job keeps it pending; the user's own mode choice wins.
    s = reducer(s, { type: 'selectDriver', driver: inflate });
    expect(s.pendingMeshMode).toBe('double');
    s = reducer(reducer(reducer(s, { type: 'jobStart' }), { type: 'jobCancelled' }), { type: 'setMeshParam', key: 'resolution', value: 64 });
    expect(s.pendingMeshMode).toBe('double');
    s = reducer(s, { type: 'setMeshParam', key: 'mode', value: 'solid' });
    expect(s.pendingMeshMode).toBeNull();
    expect(meshParamsForJob(s).mode).toBe('solid');
    s = reducer(reducer(s, { type: 'jobStart' }), done('silhouette-inflate'));
    expect(s.meshParams.mode).toBe('solid');

    // Switching to a driver without a suggestion (or back to the matching one) drops it; so does reset.
    s = reducer(s, { type: 'selectDriver', driver: ml });
    expect(s.pendingMeshMode).toBe('relief');
    s = reducer(s, { type: 'selectDriver', driver: lum });
    expect(s.pendingMeshMode).toBeNull();
    expect(s.meshParams.mode).toBe('solid');
    s = reducer(s, { type: 'selectDriver', driver: ml });
    s = reducer(s, { type: 'resetMeshParams' });
    expect(s.pendingMeshMode).toBeNull();

    // Geometry / model results are not re-meshed, so the mode still applies at once.
    s = { ...s, result: { ...s.result!, kind: 'geometry' }, pendingMeshMode: null };
    s = reducer(s, { type: 'selectDriver', driver: inflate });
    expect(s.meshParams.mode).toBe('double');
    expect(s.pendingMeshMode).toBeNull();
  });

  it('removing the image while another one decodes clears the loading state', () => {
    let s = reducer(init(), { type: 'imageLoaded', source: src(), mask: null, maskNote: null });
    s = reducer(s, { type: 'imageLoading' });
    expect(s.loadingImage).toBe(true);
    s = reducer(s, { type: 'clearImage' });
    expect(s.source).toBeNull();
    expect(s.loadingImage).toBe(false);
  });

  it('canGenerate: the Generate button and the keyboard shortcut share one guard', () => {
    const empty = init();
    const loaded = reducer(empty, { type: 'imageLoaded', source: src(), mask: null, maskNote: null });
    expect(canGenerate(empty, null)).toBe(false); // no image
    expect(canGenerate(loaded, null)).toBe(true);
    expect(canGenerate(reducer(loaded, { type: 'imageLoading' }), null)).toBe(false); // a new image is decoding
    expect(canGenerate(loaded, { ok: false })).toBe(false);
    expect(canGenerate(loaded, { ok: false, reason: { tr: 'x', en: 'x' } })).toBe(false);
    expect(canGenerate(loaded, 'checking')).toBe(true); // like the button: a pending check does not block
    expect(canGenerate(loaded, { ok: true, reason: { tr: 'x', en: 'x' } })).toBe(true);
  });

  it('keeps per-driver params and resets them to defaults', () => {
    let s = reducer(init(), { type: 'setParam', driverId: 'cloud', key: 'n', value: 7 });
    s = reducer(s, { type: 'selectDriver', driver: ml });
    expect(s.params.cloud.n).toBe(7);
    s = reducer(s, { type: 'resetParams', driver: cloud });
    expect(s.params.cloud.n).toBe(5);
  });

  it('job lifecycle: start → progress → done / failed / cancelled', () => {
    let s = reducer(init(), { type: 'jobStart' });
    expect(s.status).toBe('running');
    s = reducer(s, { type: 'jobProgress', progress: { label: { tr: 'x', en: 'x' }, ratio: 0.5 } });
    expect(s.progress?.ratio).toBe(0.5);
    const failed = reducer(s, { type: 'jobFailed', error: { tr: 'hata', en: 'error' } });
    expect(failed.status).toBe('error');
    expect(failed.progress).toBeNull();
    expect(reducer(failed, { type: 'dismissError' }).error).toBeNull();
    const cancelled = reducer(s, { type: 'jobCancelled' });
    expect(cancelled.status).toBe('cancelled');
    // Late progress after cancellation is ignored.
    expect(reducer(cancelled, { type: 'jobProgress', progress: { label: { tr: 'y', en: 'y' } } }).progress).toBeNull();
  });

  it('caches the AI mask for the current source and restores it when switching back to AI mode', () => {
    const source = src();
    let s = reducer(init(), { type: 'imageLoaded', source, mask: null, maskNote: 'no-alpha' });
    s = reducer(s, { type: 'setBgMode', mode: 'ai', mask: null, maskNote: 'deferred' });
    const aiMask = mask();
    s = reducer(s, { type: 'jobStart' });
    s = reducer(s, {
      type: 'jobDone',
      result: { driverId: 'ml-a', kind: 'depth', stats: { vertices: 1, triangles: 1, watertight: false }, depthPreview: null, elapsedMs: 1, sourceName: 'a.png' },
      source,
      bgMode: 'ai',
      inputMask: aiMask,
    });
    expect(s.mask).toBe(aiMask);
    expect(s.aiMask?.mask).toBe(aiMask);
    s = reducer(s, { type: 'setBgMode', mode: 'none', mask: null, maskNote: null });
    expect(s.mask).toBeNull();
    s = reducer(s, { type: 'setBgMode', mode: 'ai', mask: null, maskNote: 'deferred' });
    expect(s.mask).toBe(aiMask);
    expect(s.maskNote).toBeNull();
    // A new image drops the cache.
    s = reducer(s, { type: 'imageLoaded', source: src(), mask: null, maskNote: 'deferred' });
    expect(s.aiMask).toBeNull();
  });

  it('theme changes carry the viewer background along; the toolbar can override it', () => {
    let s = reducer(init(), { type: 'setTheme', theme: 'light' });
    expect(s.view.darkBackground).toBe(false);
    s = reducer(s, { type: 'setView', view: { darkBackground: true } });
    expect(s.theme).toBe('light');
    expect(s.view.darkBackground).toBe(true);
  });

  it('updates stats after re-meshing and validates the STL size', () => {
    let s = init();
    expect(reducer(s, { type: 'statsUpdated', stats: { vertices: 1, triangles: 2, watertight: true } })).toBe(s);
    s = { ...s, result: { driverId: 'x', kind: 'depth', stats: { vertices: 0, triangles: 0, watertight: false }, depthPreview: null, elapsedMs: 0, sourceName: 'x' } };
    s = reducer(s, { type: 'statsUpdated', stats: { vertices: 1, triangles: 2, watertight: true } });
    expect(s.result?.stats.triangles).toBe(2);
    expect(reducer(s, { type: 'setStlSize', mm: -5 }).stlSizeMm).toBe(s.stlSizeMm);
    expect(reducer(s, { type: 'setStlSize', mm: 42 }).stlSizeMm).toBe(42);
  });
});
