// @vitest-environment jsdom
/** AiPrepPanel: empty states, disabled states (source / provider / options / humanoid-only toggles), detection chip, run / cancel, result accept / discard. */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREP_OPTIONS, type PrepOptions } from '../../ai/types';
import { createProviderConfig } from '../../ai/settings';
import type { HumanAnalysis } from '../../core/human/types';
import { AiPrepPanel } from './AiPrepPanel';
import { byTestId, cleanup, click, image, mount, queryTestId, selectValue, typeInto } from './testing';

afterEach(cleanup);

type Props = Parameters<typeof AiPrepPanel>[0];

const openai = createProviderConfig('openai', { id: 'p-1', apiKey: 'sk', label: 'Mine' });
const gemini = createProviderConfig('gemini', { id: 'p-2', apiKey: 'k' });

function props(over: Partial<Props> = {}, prep: Partial<PrepOptions> = {}): Props {
  return {
    hasSource: true,
    prep: { ...DEFAULT_PREP_OPTIONS, styleId: 'marble', ...prep },
    onPrep: vi.fn(),
    providers: [openai, gemini],
    providerId: null,
    onProvider: vi.fn(),
    onOpenSettings: vi.fn(),
    human: null,
    status: 'idle',
    progress: null,
    error: null,
    onRun: vi.fn(),
    onCancel: vi.fn(),
    prepared: null,
    original: null,
    onAccept: vi.fn(),
    onDiscard: vi.fn(),
    ...over,
  };
}

const box = { x: 0, y: 0, width: 1, height: 1 };
const humanAnalysis: HumanAnalysis = {
  width: 10,
  height: 10,
  faces: [{ landmarks: [], box }],
  hands: [{ landmarks: [], box, handedness: 'Left' }, { landmarks: [], box, handedness: 'Right' }],
  poses: [{ landmarks: [], box }],
  isHuman: true,
};

const run = () => byTestId<HTMLButtonElement>('ai-prep-run');
const tpose = () => byTestId<HTMLInputElement>('ai-prep-tpose');

describe('AiPrepPanel', () => {
  it('offers to set up a provider when there is none', () => {
    const p = props({ providers: [] });
    mount(createElement(AiPrepPanel, p));
    expect(queryTestId('ai-prep-empty')).not.toBeNull();
    expect(queryTestId('ai-prep-provider')).toBeNull();
    click(byTestId('ai-prep-setup'));
    expect(p.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(run().disabled).toBe(true);
    expect(byTestId('ai-prep-blocked').textContent).toBe('Add an AI provider first.');
  });

  it('needs a source image and something to do', () => {
    const m = mount(createElement(AiPrepPanel, props({ hasSource: false })));
    expect(run().disabled).toBe(true);
    expect(byTestId('ai-prep-blocked').textContent).toBe('Upload an image first.');
    m.render(createElement(AiPrepPanel, props({}, { styleId: null })));
    expect(run().disabled).toBe(true);
    expect(byTestId('ai-prep-blocked').textContent).toContain('Pick a style');
    m.render(createElement(AiPrepPanel, props({}, { styleId: null, extraPrompt: 'smiling' })));
    expect(run().disabled).toBe(false);
  });

  it('runs, selects the provider and opens the settings', () => {
    const p = props({ providerId: 'p-2' });
    mount(createElement(AiPrepPanel, p));
    const sel = byTestId<HTMLSelectElement>('ai-prep-provider');
    expect(sel.value).toBe('p-2');
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual(['Mine · OpenAI', 'Google Gemini']);
    selectValue(sel, 'p-1');
    expect(p.onProvider).toHaveBeenCalledWith('p-1');
    click(run());
    expect(p.onRun).toHaveBeenCalledTimes(1);
    click(byTestId('ai-prep-settings'));
    expect(p.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('enables T-pose only for humanoids and reports the options', () => {
    const p = props({}, { subject: 'object', tPose: true });
    const m = mount(createElement(AiPrepPanel, p));
    expect(tpose().disabled).toBe(true);
    expect(tpose().checked).toBe(false); // not applied to an object
    expect(document.body.textContent).toContain('Only for people and humanoid characters');
    expect(document.body.textContent).toContain('Complete missing parts'); // objects: completion of cropped parts

    m.render(createElement(AiPrepPanel, { ...p, prep: { ...p.prep, subject: 'character' } }));
    expect(tpose().disabled).toBe(false);
    expect(tpose().checked).toBe(true);
    expect(document.body.textContent).toContain('Complete the full body');

    click(byTestId('ai-prep-complete'));
    expect(p.onPrep).toHaveBeenLastCalledWith({ completeBody: true });
    click(byTestId('ai-prep-removebg'));
    expect(p.onPrep).toHaveBeenLastCalledWith({ removeBackground: false });
    selectValue(byTestId<HTMLSelectElement>('ai-prep-subject'), 'human');
    expect(p.onPrep).toHaveBeenLastCalledWith({ subject: 'human' });
    typeInto(byTestId<HTMLTextAreaElement>('ai-prep-extra'), 'red scarf');
    expect(p.onPrep).toHaveBeenLastCalledWith({ extraPrompt: 'red scarf' });
    click(byTestId('style-gold'));
    expect(p.onPrep).toHaveBeenLastCalledWith({ styleId: 'gold' });
  });

  it('uses the detection for "auto" and shows the chip', () => {
    const m = mount(createElement(AiPrepPanel, props({ human: 'analyzing' })));
    expect(byTestId('ai-prep-detect').textContent).toContain('Detecting people');
    expect(tpose().disabled).toBe(true);
    m.render(createElement(AiPrepPanel, props({ human: humanAnalysis })));
    expect(byTestId('ai-prep-detect').textContent).toContain('Human detected');
    expect(byTestId('ai-prep-detect').textContent).toContain('1 face · 2 hands · 1 body');
    expect(tpose().disabled).toBe(false);
    m.render(createElement(AiPrepPanel, props({ human: { ...humanAnalysis, faces: [], hands: [], poses: [], isHuman: false, unavailableText: { tr: 'WebGL yok', en: 'No WebGL' } } })));
    expect(byTestId('ai-prep-detect').dataset.state).toBe('unavailable');
    expect(byTestId('ai-prep-detect').textContent).toContain('No WebGL');
  });

  it('counts in Turkish', () => {
    mount(createElement(AiPrepPanel, props({ human: humanAnalysis })), 'tr');
    expect(byTestId('ai-prep-detect').textContent).toContain('İnsan algılandı');
    expect(byTestId('ai-prep-detect').textContent).toContain('1 yüz · 2 el · 1 gövde');
  });

  it('locks the form while running and cancels', () => {
    const p = props({ status: 'running', progress: { label: { tr: 'Hazırlanıyor', en: 'Preparing image' }, ratio: 0.5 } });
    mount(createElement(AiPrepPanel, p));
    expect(queryTestId('ai-prep-run')).toBeNull();
    expect(byTestId('ai-prep-progress').textContent).toContain('Preparing image');
    expect(byTestId<HTMLSelectElement>('ai-prep-subject').disabled).toBe(true);
    expect(byTestId<HTMLInputElement>('ai-prep-removebg').disabled).toBe(true);
    click(byTestId('ai-prep-cancel'));
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });

  it('honours the disabled prop', () => {
    mount(createElement(AiPrepPanel, props({ disabled: true })));
    expect(run().disabled).toBe(true);
    expect(byTestId<HTMLSelectElement>('ai-prep-provider').disabled).toBe(true);
    expect(byTestId<HTMLTextAreaElement>('ai-prep-extra').disabled).toBe(true);
  });

  it('shows the error and the before / after result with accept / discard', () => {
    const p = props({ error: { tr: 'Kota doldu', en: 'Quota exceeded' }, status: 'error' });
    const m = mount(createElement(AiPrepPanel, p));
    expect(byTestId('ai-prep-error').textContent).toContain('Quota exceeded');
    const q = { ...p, error: null, status: 'idle' as const, prepared: { image: image(8, 8), name: 'cat-ai.png' }, original: image(4, 6) };
    m.render(createElement(AiPrepPanel, q));
    expect(byTestId('ai-prep-result').textContent).toContain('cat-ai.png');
    expect(queryTestId('ai-prep-compare-range')).not.toBeNull();
    expect(run().textContent).toContain('Prepare again');
    click(byTestId('ai-prep-accept'));
    expect(q.onAccept).toHaveBeenCalledTimes(1);
    click(byTestId('ai-prep-discard'));
    expect(q.onDiscard).toHaveBeenCalledTimes(1);
    // Side-by-side mode.
    click(Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent?.includes('Side by side'))!);
    expect(queryTestId('ai-prep-compare-range')).toBeNull();
    expect(document.querySelectorAll('.ai-compare-fig')).toHaveLength(2);
  });
});
