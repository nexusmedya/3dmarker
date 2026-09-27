// @vitest-environment jsdom
/** The step-4 human-detail card: failures are explained, with a retry; partial failures too. */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeAnalysis, syntheticFace } from '../core/human/testing';
import type { HumanAnalysis } from '../core/human/types';
import { HumanDetailNote, humanNoteState } from './HumanDetailNote';
import { byTestId, cleanup, click, mount, queryTestId } from './ai/testing';

afterEach(cleanup);

const blocked: HumanAnalysis = {
  ...fakeAnalysis(100, 100),
  unavailableReason: 'Could not load the human detection (face) model: Failed to fetch',
  unavailableText: {
    tr: 'İnsan algılama (yüz) modeli yüklenemedi: Failed to fetch',
    en: 'Could not load the human detection (face) model: Failed to fetch',
  },
  failed: { faces: 'x', hands: 'x', pose: 'x' },
};

describe('HumanDetailNote', () => {
  it('explains an unavailable detection in Turkish, says generation goes on, and retries', () => {
    const onDetect = vi.fn(), onRetry = vi.fn();
    mount(createElement(HumanDetailNote, { human: blocked, enabled: true, onDetect, onRetry }), 'tr');
    expect(byTestId('human-detail').dataset.state).toBe('unavailable');
    const box = byTestId('human-unavailable');
    expect(box.getAttribute('role')).toBe('alert');
    expect(byTestId('human-unavailable-reason').textContent).toBe('İnsan algılama (yüz) modeli yüklenemedi: Failed to fetch');
    expect(box.textContent).toContain('3B üretim yine çalışır');
    expect(byTestId('human-retry').textContent).toContain('Yeniden dene');
    click(byTestId('human-retry'));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onDetect).not.toHaveBeenCalled();
    expect(queryTestId('human-partial')).toBeNull();
  });

  it('falls back to the English reason and to onDetect without onRetry; the retry obeys disabled', () => {
    const onDetect = vi.fn();
    const { unavailableText: _drop, ...plain } = blocked;
    mount(createElement(HumanDetailNote, { human: plain, enabled: true, onDetect, disabled: true }));
    expect(byTestId('human-unavailable-reason').textContent).toBe(blocked.unavailableReason);
    expect(byTestId<HTMLButtonElement>('human-retry').disabled).toBe(true);
    cleanup();
    mount(createElement(HumanDetailNote, { human: plain, enabled: true, onDetect }));
    click(byTestId('human-retry'));
    expect(onDetect).toHaveBeenCalledOnce();
  });

  it('shows a partial failure next to what was found', () => {
    const partial: HumanAnalysis = { ...fakeAnalysis(400, 300, { faces: [syntheticFace(200, 140, 35, 45)] }), failed: { hands: 'HTTP 403' } };
    const onRetry = vi.fn();
    mount(createElement(HumanDetailNote, { human: partial, enabled: true, onDetect: vi.fn(), onRetry }));
    const note = byTestId('human-detail');
    expect(note.dataset.state).toBe('human');
    expect(note.dataset.partial).toBe('true');
    expect(byTestId('human-partial').textContent).toContain('Hand detection unavailable');
    click(byTestId('human-retry'));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('no retry when detection worked; state mapping', () => {
    mount(createElement(HumanDetailNote, { human: fakeAnalysis(10, 10), enabled: true, onDetect: vi.fn() }));
    expect(byTestId('human-detail').dataset.state).toBe('none');
    expect(queryTestId('human-retry')).toBeNull();
    expect(humanNoteState(blocked, false)).toBe('off');
    expect(humanNoteState('analyzing', true)).toBe('analyzing');
    expect(humanNoteState(null, true)).toBe('pending');
    expect(humanNoteState(blocked, true)).toBe('unavailable');
  });
});
