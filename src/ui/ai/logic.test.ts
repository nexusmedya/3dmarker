import { describe, expect, it } from 'vitest';
import { STYLES } from '../../ai/styles';
import { createProviderConfig, DEFAULT_AI_SETTINGS } from '../../ai/settings';
import type { AiSettings } from '../../ai/types';
import type { HumanAnalysis } from '../../core/human/types';
import { addProvider, defaultsOf, detectionState, filterStyles, foldText, isSuggestedModel, removeProvider, setDefaultProvider, uniqueLabel, updateProvider } from './logic';
import { missingViews } from './types';

describe('style search', () => {
  it('folds case, diacritics and the Turkish i', () => {
    expect(foldText('Şeker')).toBe('seker');
    expect(foldText('IŞIK İpek')).toBe('isik ipek');
    expect(foldText('Örgü yün')).toBe('orgu yun');
  });

  it('matches names in either language, ids and category names, every word', () => {
    const ids = (q: string, c: Parameters<typeof filterStyles>[2] = 'all') => filterStyles(STYLES, q, c).map((s) => s.id);
    expect(ids('')).toHaveLength(STYLES.length);
    expect(ids('mermer')).toEqual(['marble']);
    expect(ids('MARBLE')).toEqual(['marble']);
    expect(ids('seker')).toContain('candy'); // "Şeker" without the cedilla
    expect(ids('vinyl figure')).toEqual(['vinyl-figure']);
    expect(ids('oyuncak', 'all').length).toBeGreaterThan(5); // category name "Oyuncak" (Toy)
    expect(ids('', 'toy').every((id) => STYLES.find((s) => s.id === id)!.category === 'toy')).toBe(true);
    expect(ids('marble', 'toy')).toEqual([]);
    expect(ids('zzzz')).toEqual([]);
  });
});

describe('provider settings edits', () => {
  const base = (): AiSettings => ({ ...DEFAULT_AI_SETTINGS, providers: [], defaults: {} });

  it('adds with a unique label and fills the defaults', () => {
    const a = addProvider(base(), 'openai');
    expect(a.settings.providers).toHaveLength(1);
    expect(a.settings.providers[0]).toMatchObject({ id: a.id, kind: 'openai', label: 'OpenAI', apiKey: '', enabled: true });
    expect(a.settings.defaults['image-edit']).toBe(a.id);
    expect(a.settings.defaults['background-removal']).toBe(a.id);
    const b = addProvider(a.settings, 'openai');
    expect(b.settings.providers[1].label).toBe('OpenAI 2');
    expect(b.settings.defaults['image-edit']).toBe(a.id); // an existing default is kept
    expect(uniqueLabel(b.settings.providers, 'openai')).toBe('openai 3');
  });

  it('patches one entry without re-sanitising while typing', () => {
    const a = addProvider(base(), 'gemini');
    const s = updateProvider(a.settings, a.id, { label: 'Work ', apiKey: 'AIza ' });
    expect(s.providers[0].label).toBe('Work ');
    expect(s.providers[0].apiKey).toBe('AIza ');
    expect(updateProvider(s, 'nope', { label: 'x' })).toBe(s);
  });

  it('removes an entry and re-points its defaults; managed entries stay', () => {
    const a = addProvider(base(), 'openai');
    const b = addProvider(a.settings, 'gemini');
    const s = setDefaultProvider(b.settings, 'image-edit', b.id);
    expect(defaultsOf(s, b.id)).toEqual(['image-edit']);
    const r = removeProvider(s, b.id);
    expect(r.providers.map((p) => p.id)).toEqual([a.id]);
    expect(r.defaults['image-edit']).toBe(a.id);
    const managed = createProviderConfig('tripo', { id: 'server-tripo', managed: true });
    const withManaged: AiSettings = { ...r, providers: [...r.providers, managed] };
    expect(removeProvider(withManaged, 'server-tripo')).toBe(withManaged);
  });

  it('knows the suggested models', () => {
    expect(isSuggestedModel('openai', 'image-edit', 'gpt-image-1')).toBe(true);
    expect(isSuggestedModel('openai', 'image-edit', 'my-model')).toBe(false);
  });
});

describe('detection state', () => {
  const analysis = (over: Partial<HumanAnalysis>): HumanAnalysis => ({ width: 1, height: 1, faces: [], hands: [], poses: [], isHuman: false, ...over });

  it('maps the analysis to a chip state', () => {
    expect(detectionState(null)).toEqual({ kind: 'none' });
    expect(detectionState('analyzing')).toEqual({ kind: 'analyzing' });
    const box = { x: 0, y: 0, width: 1, height: 1 };
    expect(detectionState(analysis({ isHuman: true, faces: [{ landmarks: [], box }], hands: [{ landmarks: [], box, handedness: 'Left' }] }))).toEqual({
      kind: 'human',
      faces: 1,
      hands: 1,
      poses: 0,
    });
    expect(detectionState(analysis({}))).toEqual({ kind: 'not-human' });
    expect(detectionState(analysis({ unavailableReason: 'no webgl' }))).toEqual({ kind: 'unavailable', reason: { tr: 'no webgl', en: 'no webgl' } });
    expect(detectionState(analysis({ unavailableReason: 'x', unavailableText: { tr: 'yok', en: 'none' } }))).toEqual({ kind: 'unavailable', reason: { tr: 'yok', en: 'none' } });
  });
});

describe('missingViews', () => {
  it('lists the empty slots in display order', () => {
    expect(missingViews({})).toEqual(['back', 'left', 'right', 'top', 'bottom']);
    expect(missingViews({ back: 1, top: 1 })).toEqual(['left', 'right', 'bottom']);
  });
});
