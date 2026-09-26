/**
 * Reducer / persistence tests for the studio's AI side, steps and model edit
 * flags: provider settings (keys never leak to localStorage unless
 * remembered), the server probe, prep options, the AI job, prepared image
 * accept / revert, extra views, human analysis, sculpt / rig flags and the
 * Generate guard for drivers that require extra views.
 */
import { describe, expect, it } from 'vitest';
import type { Driver, Mask, RGBAImage } from '../core/types';
import type { HumanAnalysis } from '../core/human/types';
import type { AiSettings } from '../ai/types';
import { DEFAULT_PREP_OPTIONS } from '../ai/types';
import { createProviderConfig, saveAiSettings } from '../ai/settings';
import { STYLES } from '../ai/styles';
import {
  canGenerate,
  createInitialState,
  extraViewSet,
  generateBlock,
  hasUnsavedModelEdits,
  presentViews,
  reducer,
  remeshPaused,
  sanitizePrep,
  saveState,
  type AppState,
  type ViewEntry,
} from './store';
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
  removeItem(k: string) {
    this.map.delete(k);
  }
  dump() {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('\n');
  }
}

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

const plain = driver('plain');
const fusion = driver('fusion', { category: 'multiview', views: 'required', minViews: [], producesDepth: false });
const needsSides = driver('sides', { category: 'multiview', views: 'required', minViews: ['front', 'left', 'right'], producesDepth: false });
const optional = driver('opt', { category: 'cloud', views: 'optional', producesDepth: false });
const drivers = [plain, fusion, needsSides, optional];

const init = (store: KeyValueStore | null = null, session: KeyValueStore | null = null): AppState =>
  createInitialState({ store, session, languages: ['en'], drivers, defaultDriverId: 'plain' });

const img = (w = 2, h = 2): RGBAImage => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) });
const src = (name = 'a.png'): SourceImage => ({ name, file: new Blob([name]), image: img() });
const mask = (): Mask => ({ width: 2, height: 2, data: new Uint8Array([1, 1, 0, 0]) });
const view = (name: string, origin: ViewEntry['origin'] = 'upload'): ViewEntry => ({ file: new Blob([name]), image: img(), mask: mask(), origin, name });
const stats = { vertices: 3, triangles: 1, watertight: false };

function loaded(s: AppState = init(), source = src()): AppState {
  return reducer(s, { type: 'imageLoaded', source, mask: null, maskNote: null });
}

function withKey(rememberKeys: boolean): AiSettings {
  const p = createProviderConfig('openai', { id: 'mine', label: 'Mine', apiKey: 'sk-secret-123' });
  return { providers: [p], defaults: { 'image-edit': 'mine' }, rememberKeys };
}

describe('AI settings persistence', () => {
  it('keeps keys out of localStorage unless remembered, and restores them from the right store', () => {
    const local = new MemoryStore();
    const session = new MemoryStore();
    let s = init(local, session);
    expect(s.aiSettings.providers).toEqual([]);
    s = reducer(s, { type: 'setAiSettings', settings: withKey(false) });
    saveState(local, s, drivers);
    saveAiSettings(local, session, s.aiSettings);
    expect(local.dump()).not.toContain('sk-secret-123');
    expect(session.dump()).toContain('sk-secret-123');
    // Same tab (session survives): the key is back.
    const again = init(local, session);
    expect(again.aiSettings.providers[0]).toMatchObject({ id: 'mine', apiKey: 'sk-secret-123' });
    // Tab closed (fresh session): the provider is there, its key is not.
    const closed = init(local, new MemoryStore());
    expect(closed.aiSettings.providers[0]).toMatchObject({ id: 'mine', apiKey: '' });

    // Remembering moves the key to localStorage and out of sessionStorage.
    s = reducer(s, { type: 'setAiSettings', settings: withKey(true) });
    saveAiSettings(local, session, s.aiSettings);
    expect(local.dump()).toContain('sk-secret-123');
    expect(session.dump()).not.toContain('sk-secret-123');
    expect(init(local, new MemoryStore()).aiSettings.providers[0].apiKey).toBe('sk-secret-123');
  });

  it('tolerates missing storage', () => {
    expect(init(null, null).aiSettings).toEqual({ providers: [], defaults: {}, rememberKeys: false });
  });

  it('server probe: merges managed providers, or records that there is no server', () => {
    let s = reducer(init(), { type: 'setAiSettings', settings: withKey(false) });
    expect(s.serverChecked).toBe(false);
    const managed = createProviderConfig('gemini', { id: 'server-gemini', managed: true });
    const withServer = reducer(s, { type: 'serverProbed', providers: [managed] });
    expect(withServer.serverAvailable).toBe(true);
    expect(withServer.serverChecked).toBe(true);
    expect(withServer.aiSettings.providers.map((p) => p.id)).toEqual(['mine', 'server-gemini']);
    // Managed entries are never persisted.
    const local = new MemoryStore();
    const session = new MemoryStore();
    saveAiSettings(local, session, withServer.aiSettings);
    expect(local.dump()).not.toContain('server-gemini');

    s = reducer(s, { type: 'serverProbed', providers: null });
    expect(s.serverAvailable).toBe(false);
    expect(s.serverChecked).toBe(true);
    expect(s.aiSettings.providers.map((p) => p.id)).toEqual(['mine']);
  });

  it('opens / closes the providers dialog and remembers the chosen image-edit provider', () => {
    const store = new MemoryStore();
    let s = reducer(init(store), { type: 'setAiSettingsOpen', open: true });
    expect(s.aiSettingsOpen).toBe(true);
    s = reducer(s, { type: 'setAiProvider', id: 'mine' });
    saveState(store, s, drivers);
    const again = init(store);
    expect(again.aiProviderId).toBe('mine');
    expect(again.aiSettingsOpen).toBe(false);
  });
});

describe('prep options', () => {
  it('are sanitised on every change and persisted', () => {
    const store = new MemoryStore();
    let s = init(store);
    expect(s.prep).toEqual(DEFAULT_PREP_OPTIONS);
    s = reducer(s, { type: 'setPrep', patch: { styleId: STYLES[0].id, tPose: true } });
    expect(s.prep).toMatchObject({ styleId: STYLES[0].id, tPose: true, subject: 'auto' });
    s = reducer(s, { type: 'setPrep', patch: { styleId: 'no-such-style' } });
    expect(s.prep.styleId).toBeNull();
    s = reducer(s, { type: 'setPrep', patch: { subject: 'bogus' as never, extraPrompt: 'x'.repeat(5000) } });
    expect(s.prep.subject).toBe('auto');
    expect(s.prep.extraPrompt).toHaveLength(1000);
    s = reducer(s, { type: 'setPrep', patch: { subject: 'human', completeBody: true, removeBackground: false } });
    saveState(store, s, drivers);
    expect(init(store).prep).toMatchObject({ subject: 'human', completeBody: true, removeBackground: false, tPose: true });
  });

  it('sanitizePrep drops junk', () => {
    expect(sanitizePrep(null)).toEqual(DEFAULT_PREP_OPTIONS);
    expect(sanitizePrep({ subject: 'animal', styleId: 42, tPose: 'yes', removeBackground: false })).toEqual({
      ...DEFAULT_PREP_OPTIONS,
      subject: 'animal',
      removeBackground: false,
    });
  });
});

describe('steps', () => {
  it('a reload starts at the image step (no image survives it, later steps would open empty)', () => {
    const store = new MemoryStore();
    let s = reducer(init(store), { type: 'setStep', step: 'rig' });
    expect(s.step).toBe('rig');
    expect(reducer(s, { type: 'setStep', step: 'rig' })).toBe(s);
    saveState(store, s, drivers);
    expect(init(store).step).toBe('image');
    store.setItem('3dmarker:settings', JSON.stringify({ step: 'views' })); // stored by an older version
    expect(init(store).step).toBe('image');
  });
});

describe('AI job, prepared image and views', () => {
  it('one job: start clears its error, progress, failure goes to the job’s panel, cancel', () => {
    let s = loaded();
    s = reducer(s, { type: 'aiJobFailed', kind: 'prep', error: { tr: 'eski', en: 'old' } });
    s = reducer(s, { type: 'aiJobStart', kind: 'prep' });
    expect(s.aiJob).toEqual({ kind: 'prep', target: null, progress: null });
    expect(s.prepError).toBeNull();
    s = reducer(s, { type: 'aiJobProgress', progress: { label: { tr: 'x', en: 'x' }, ratio: 0.2 } });
    expect(s.aiJob?.progress?.ratio).toBe(0.2);
    s = reducer(s, { type: 'aiJobFailed', kind: 'prep', error: { tr: 'hata', en: 'failed' } });
    expect(s.aiJob).toBeNull();
    expect(s.prepError?.en).toBe('failed');
    expect(s.viewsError).toBeNull();

    s = reducer(s, { type: 'aiJobStart', kind: 'views', target: 'all' });
    expect(s.prepError?.en).toBe('failed'); // the other panel's error stays
    s = reducer(s, { type: 'aiJobFailed', kind: 'views', error: { tr: 'v', en: 'v' } });
    expect(s.viewsError?.en).toBe('v');
    s = reducer(s, { type: 'dismissAiError', kind: 'views' });
    expect(s.viewsError).toBeNull();

    s = reducer(s, { type: 'aiJobStart', kind: 'views', target: 'back' });
    s = reducer(s, { type: 'aiJobCancelled' });
    expect(s.aiJob).toBeNull();
    // Late progress after the job ended is ignored.
    expect(reducer(s, { type: 'aiJobProgress', progress: { label: { tr: 'y', en: 'y' } } })).toBe(s);
  });

  it('accept makes the prepared image the source (uploaded views kept, original remembered); revert restores it', () => {
    const original = src('cat.png');
    let s = loaded(init(), original);
    s = reducer(s, { type: 'viewSet', view: 'back', entry: view('back.png') });
    // Made by AI from the old front: it no longer matches the prepared one.
    s = reducer(s, { type: 'viewSet', view: 'left', entry: view('cat-left.png', 'ai') });
    s = reducer(s, { type: 'aiJobStart', kind: 'prep' });
    const prepared = src('cat-ai.png');
    s = reducer(s, { type: 'prepReady', prepared });
    expect(s.aiJob).toBeNull();
    expect(s.prepared).toBe(prepared);
    expect(s.source).toBe(original); // not yet accepted

    const m = mask();
    s = reducer(s, { type: 'prepAccept', mask: m, maskNote: null });
    expect(s.source).toBe(prepared);
    expect(s.original).toBe(original);
    expect(s.prepared).toBeNull();
    expect(s.mask).toBe(m);
    expect(presentViews(s.views)).toEqual(['back']);

    // AI views made for the prepared front are dropped again when reverting to the original.
    s = reducer(s, { type: 'viewSet', view: 'right', entry: view('cat-ai-right.png', 'ai') });
    const reverted = reducer(s, { type: 'revertOriginal', mask: null, maskNote: null });
    expect(reverted.source).toBe(original);
    expect(presentViews(reverted.views)).toEqual(['back']);
    s = reducer(s, { type: 'viewClear', view: 'right' });

    // A second preparation keeps the first original.
    const second = src('cat-ai-2.png');
    s = reducer(reducer(s, { type: 'prepReady', prepared: second }), { type: 'prepAccept', mask: null, maskNote: 'no-alpha' });
    expect(s.source).toBe(second);
    expect(s.original).toBe(original);

    s = reducer(s, { type: 'revertOriginal', mask: null, maskNote: 'no-alpha' });
    expect(s.source).toBe(original);
    expect(s.original).toBeNull();
    expect(s.maskNote).toBe('no-alpha');
    expect(reducer(s, { type: 'revertOriginal', mask: null, maskNote: null })).toBe(s);
  });

  it('discarding the prepared image keeps the source', () => {
    const original = src();
    let s = reducer(loaded(init(), original), { type: 'prepReady', prepared: src('p.png') });
    s = reducer(s, { type: 'prepDiscard' });
    expect(s.prepared).toBeNull();
    expect(s.source).toBe(original);
    expect(reducer(s, { type: 'prepAccept', mask: null, maskNote: null })).toBe(s); // nothing to accept
  });

  it('views: set / replace / clear; a brand-new image (or none) starts over', () => {
    let s = loaded();
    s = reducer(s, { type: 'viewSet', view: 'left', entry: view('l1') });
    s = reducer(s, { type: 'viewSet', view: 'back', entry: view('b', 'ai') });
    const l2 = view('l2');
    s = reducer(s, { type: 'viewSet', view: 'left', entry: l2 });
    expect(presentViews(s.views)).toEqual(['back', 'left']);
    expect(s.views.left).toBe(l2);
    s = reducer(s, { type: 'viewClear', view: 'back' });
    expect(presentViews(s.views)).toEqual(['left']);
    expect(reducer(s, { type: 'viewClear', view: 'top' })).toBe(s);

    const set = extraViewSet(s.views);
    expect(Object.keys(set)).toEqual(['left']);
    expect(set.left).toMatchObject({ id: 'left', image: l2.image, mask: l2.mask, file: l2.file, origin: 'upload' });

    s = reducer(s, { type: 'prepReady', prepared: src('p.png') });
    const fresh = loaded(s, src('new.png'));
    expect(fresh.views).toEqual({});
    expect(fresh.prepared).toBeNull();
    expect(fresh.original).toBeNull();
    const cleared = reducer(s, { type: 'clearImage' });
    expect(cleared.views).toEqual({});
    expect(cleared.prepared).toBeNull();
  });

  it('human analysis: results for an image that is no longer the front are dropped', () => {
    const a = src('a.png');
    let s = loaded(init(), a);
    s = reducer(s, { type: 'humanStart', image: a.image });
    expect(s.human).toEqual({ image: a.image, analysis: 'analyzing' });
    const analysis: HumanAnalysis = { width: 2, height: 2, faces: [], hands: [], poses: [], isHuman: false };
    const done = reducer(s, { type: 'humanDone', image: a.image, analysis });
    expect(done.human?.analysis).toBe(analysis);

    const b = loaded(s, src('b.png'));
    expect(b.human).toBeNull();
    expect(reducer(b, { type: 'humanDone', image: a.image, analysis })).toBe(b);
    // Cancelling clears only a pending analysis of that image.
    expect(reducer(s, { type: 'humanCancelled', image: a.image }).human).toBeNull();
    expect(reducer(done, { type: 'humanCancelled', image: a.image }).human?.analysis).toBe(analysis);
  });
});

describe('model edit flags', () => {
  const result = { driverId: 'plain', kind: 'depth' as const, stats, depthPreview: null, elapsedMs: 1, sourceName: 'a.png' };

  it('sculpt edits pause re-meshing until discarded or a new model arrives; rigging does too', () => {
    let s: AppState = { ...loaded(), result };
    expect(remeshPaused(s)).toBe(false);
    s = reducer(s, { type: 'setSculptActive', active: true });
    expect(remeshPaused(s)).toBe(true);
    const edited = { vertices: 3, triangles: 1, watertight: true };
    s = reducer(s, { type: 'sculptEdited', stats: edited });
    expect(s.sculpted).toBe(true);
    expect(s.result?.stats).toBe(edited);
    s = reducer(s, { type: 'setSculptActive', active: false });
    expect(remeshPaused(s)).toBe(true); // the edits are still there
    s = reducer(s, { type: 'sculptDiscarded', stats });
    expect(s.sculpted).toBe(false);
    expect(remeshPaused(s)).toBe(false);

    s = reducer(s, { type: 'setRigged', rigged: true });
    expect(remeshPaused(s)).toBe(true);
    expect(reducer(s, { type: 'setRigged', rigged: true })).toBe(s);
    s = reducer(reducer(s, { type: 'sculptEdited', stats }), { type: 'setDepthEditor', open: true });
    // A new model resets every flag.
    s = reducer(reducer(s, { type: 'jobStart' }), { type: 'jobDone', result, source: s.source!, bgMode: 'auto', inputMask: null });
    expect(s).toMatchObject({ sculpted: false, sculptActive: false, rigged: false, depthEditorOpen: false });
  });

  it('a depth edit rebuilds the model: new stats / preview, flags reset, editor closed', () => {
    let s: AppState = { ...loaded(), result };
    s = reducer(reducer(s, { type: 'sculptEdited', stats }), { type: 'setDepthEditor', open: true });
    const preview = img(4, 4);
    const next = { vertices: 10, triangles: 12, watertight: true };
    s = reducer(s, { type: 'depthEdited', stats: next, depthPreview: preview });
    expect(s.result).toMatchObject({ stats: next, depthPreview: preview, driverId: 'plain' });
    expect(s).toMatchObject({ sculpted: false, depthEditorOpen: false, depthEdited: true });
    expect(hasUnsavedModelEdits(s)).toBe(true);
    s = reducer(reducer(s, { type: 'jobStart' }), { type: 'jobDone', result, source: s.source!, bgMode: 'auto', inputMask: null });
    expect(s.depthEdited).toBe(false);
    expect(hasUnsavedModelEdits(s)).toBe(false);
  });

  it('undoing / resetting a session back to 0 strokes leaves the model unsculpted, unless it started sculpted', () => {
    let s: AppState = { ...loaded(), result };
    s = reducer(reducer(s, { type: 'sculptSessionStart' }), { type: 'setSculptActive', active: true });
    s = reducer(s, { type: 'sculptEdited', stats, strokes: 1 });
    expect(s.sculpted).toBe(true);
    s = reducer(s, { type: 'sculptEdited', stats, strokes: 0 }); // Reset
    expect(s.sculpted).toBe(false);
    expect(remeshPaused(reducer(s, { type: 'setSculptActive', active: false }))).toBe(false);
    s = reducer(s, { type: 'sculptEdited', stats, strokes: 2 }); // redo
    expect(s.sculpted).toBe(true);

    // A new session on the sculpted geometry: its 0 strokes still carry the earlier edits.
    s = reducer(s, { type: 'sculptSessionStart' });
    s = reducer(s, { type: 'sculptEdited', stats, strokes: 1 });
    s = reducer(s, { type: 'sculptEdited', stats, strokes: 0 });
    expect(s.sculpted).toBe(true);
    // Discarding (fresh geometry) starts over.
    s = reducer(s, { type: 'sculptDiscarded', stats });
    s = reducer(reducer(s, { type: 'sculptSessionStart' }), { type: 'sculptEdited', stats, strokes: 0 });
    expect(s.sculpted).toBe(false);
    // Without a stroke count an edit always counts.
    expect(reducer(s, { type: 'sculptEdited', stats }).sculpted).toBe(true);
  });

  it('the regenerate confirmation is asked for edited models and closed by a new job', () => {
    let s: AppState = { ...loaded(), result };
    expect(hasUnsavedModelEdits(s)).toBe(false);
    expect(hasUnsavedModelEdits(reducer(s, { type: 'setRigged', rigged: true }))).toBe(true);
    s = reducer(s, { type: 'sculptEdited', stats });
    expect(hasUnsavedModelEdits(s)).toBe(true);
    s = reducer(s, { type: 'setRegenConfirm', open: true });
    expect(s.regenConfirm).toBe(true);
    expect(reducer(s, { type: 'setRegenConfirm', open: true })).toBe(s);
    expect(reducer(s, { type: 'setRegenConfirm', open: false }).regenConfirm).toBe(false);
    expect(reducer(s, { type: 'jobStart' }).regenConfirm).toBe(false);
  });
});

describe('Generate guard with extra views', () => {
  it('drivers that require views need at least one, plus their minViews', () => {
    const empty = init();
    expect(generateBlock(empty, null, fusion)).toEqual({ kind: 'no-image' });
    let s = loaded();
    expect(canGenerate(s, null, plain)).toBe(true);
    expect(canGenerate(s, null, optional)).toBe(true); // optional views never block
    expect(generateBlock(s, null, fusion)).toEqual({ kind: 'views', missing: [] });
    expect(canGenerate(s, null, fusion)).toBe(false);
    expect(generateBlock(s, null, needsSides)).toEqual({ kind: 'views', missing: ['left', 'right'] });

    s = reducer(s, { type: 'viewSet', view: 'left', entry: view('l') });
    expect(canGenerate(s, null, fusion)).toBe(true);
    expect(generateBlock(s, null, needsSides)).toEqual({ kind: 'views', missing: ['right'] });
    s = reducer(s, { type: 'viewSet', view: 'right', entry: view('r') });
    expect(canGenerate(s, null, needsSides)).toBe(true);
    // Without a driver the old two-argument guard still applies.
    expect(canGenerate(loaded(), null)).toBe(true);
  });

  it('an unavailable driver, a decode or a running AI job block too (in that order)', () => {
    const s = loaded();
    expect(generateBlock(reducer(s, { type: 'imageLoading' }), null, plain)).toEqual({ kind: 'loading' });
    expect(generateBlock(s, { ok: false, reason: { tr: 'r', en: 'r' } }, plain)).toEqual({ kind: 'unavailable', reason: { tr: 'r', en: 'r' } });
    expect(generateBlock(s, { ok: false }, plain)).toEqual({ kind: 'unavailable', reason: null });
    const busy = reducer(s, { type: 'aiJobStart', kind: 'views', target: 'back' });
    expect(generateBlock(busy, 'checking', plain)).toEqual({ kind: 'ai-busy' });
    expect(canGenerate(reducer(busy, { type: 'aiJobDone' }), 'checking', plain)).toBe(true);
  });
});
