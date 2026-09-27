/** Reducer: image enhancement pending result, Apply / Revert, the enhance AI job and staleness on front changes. */
import { describe, expect, it } from 'vitest';
import type { Driver, Mask, RGBAImage } from '../core/types';
import { DEFAULT_VIEW_ALIGN } from '../core/types';
import type { EnhancePlan } from '../core/enhance/presets';
import { createInitialState, generateBlock, reducer, type AppState, type EnhancePending, type ViewEntry } from './store';
import type { SourceImage } from './pipeline';

const plain: Driver = {
  id: 'plain',
  name: { tr: 'p', en: 'p' },
  description: { tr: '', en: '' },
  category: 'heuristic',
  badges: [],
  params: [],
  producesDepth: true,
  run: async () => {
    throw new Error('unused');
  },
};

const init = (): AppState => createInitialState({ store: null, languages: ['en'], drivers: [plain], defaultDriverId: 'plain' });
const img = (w = 2, h = 2): RGBAImage => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) });
const src = (name = 'a.png', w = 2): SourceImage => ({ name, file: new Blob([name]), image: img(w, w) });
const mask = (): Mask => ({ width: 2, height: 2, data: new Uint8Array([1, 1, 0, 0]) });
const view = (origin: ViewEntry['origin']): ViewEntry => ({ file: new Blob(['v']), image: img(), mask: mask(), origin, name: 'v.png', align: DEFAULT_VIEW_ALIGN });
const plan: EnhancePlan = { kind: 'filter', ops: ['sharpen'], scale: 1, width: 4, height: 4 };

function pending(from: SourceImage, name = 'a-enhanced.png'): EnhancePending {
  return { source: src(name, 4), from, preset: 'sharpen', plan, fallback: null, elapsedMs: 5 };
}

function loaded(): AppState {
  let s = reducer(init(), { type: 'imageLoaded', source: src(), mask: null, maskNote: 'no-alpha' });
  s = reducer(s, { type: 'viewSet', view: 'back', entry: view('ai') });
  s = reducer(s, { type: 'viewSet', view: 'left', entry: view('upload') });
  return s;
}

describe('enhancement reducer', () => {
  it('the enhance job blocks generation and reports its own error', () => {
    let s = loaded();
    s = reducer(s, { type: 'aiJobStart', kind: 'enhance' });
    expect(generateBlock(s, null)).toEqual({ kind: 'ai-busy' });
    s = reducer(s, { type: 'aiJobFailed', kind: 'enhance', error: { tr: 'x', en: 'x' } });
    expect(s.enhanceError).toEqual({ tr: 'x', en: 'x' });
    expect(s.prepError).toBeNull();
    s = reducer(s, { type: 'aiJobStart', kind: 'enhance' });
    expect(s.enhanceError).toBeNull();
    s = reducer(s, { type: 'aiJobFailed', kind: 'enhance', error: { tr: 'y', en: 'y' } });
    s = reducer(s, { type: 'dismissAiError', kind: 'enhance' });
    expect(s.enhanceError).toBeNull();
  });

  it('apply makes the result the front, keeps every view, recomputes masks; revert brings the original back', () => {
    let s = loaded();
    const original = s.source!;
    s = reducer(s, { type: 'viewChecked', view: 'left', front: original.image, image: s.views.left!.image, check: {} as never });
    s = reducer(s, { type: 'enhanceReady', pending: pending(original) });
    expect(s.enhanced?.from).toBe(original);
    const m = mask();
    s = reducer(s, { type: 'enhanceApply', mask: m, maskNote: null });
    expect(s.source?.name).toBe('a-enhanced.png');
    expect(s.mask).toBe(m);
    expect(s.enhanced).toBeNull();
    expect(s.enhanceApplied).toMatchObject({ before: original, preset: 'sharpen' });
    expect(Object.keys(s.views).sort()).toEqual(['back', 'left']); // AI views too: same picture
    expect(s.viewChecks).toEqual({});
    // A second enhancement on top keeps the first "before".
    const first = s.source!;
    s = reducer(s, { type: 'enhanceReady', pending: pending(first, 'a-enhanced-2.png') });
    s = reducer(s, { type: 'enhanceApply', mask: null, maskNote: 'no-alpha' });
    expect(s.enhanceApplied?.before).toBe(original);
    s = reducer(s, { type: 'enhanceRevert', mask: null, maskNote: 'no-alpha' });
    expect(s.source).toBe(original);
    expect(s.enhanceApplied).toBeNull();
  });

  it('results for a replaced front are dropped; a new image clears everything', () => {
    let s = loaded();
    const old = s.source!;
    s = reducer(s, { type: 'aiJobStart', kind: 'enhance' });
    s = reducer(s, { type: 'imageLoaded', source: src('b.png'), mask: null, maskNote: null });
    s = reducer(s, { type: 'enhanceReady', pending: pending(old) });
    expect(s.enhanced).toBeNull();
    expect(s.aiJob).toBeNull();
    // Apply without a matching pending result is a no-op.
    expect(reducer(s, { type: 'enhanceApply', mask: null, maskNote: null })).toBe(s);
    s = reducer(s, { type: 'enhanceReady', pending: pending(s.source!) });
    s = reducer(s, { type: 'enhanceApply', mask: null, maskNote: null });
    s = reducer(s, { type: 'clearImage' });
    expect(s.enhanceApplied).toBeNull();
  });

  it('an accepted AI preparation makes the enhancement state stale', () => {
    let s = loaded();
    s = reducer(s, { type: 'enhanceReady', pending: pending(s.source!) });
    s = reducer(s, { type: 'enhanceApply', mask: null, maskNote: null });
    s = reducer(s, { type: 'prepReady', prepared: src('a-ai.png') });
    s = reducer(s, { type: 'prepAccept', mask: null, maskNote: null });
    expect(s.enhanceApplied).toBeNull();
    expect(s.original?.name).toBe('a-enhanced.png');
    // Revert (enhancement) no longer applies.
    expect(reducer(s, { type: 'enhanceRevert', mask: null, maskNote: null })).toBe(s);
  });
});
