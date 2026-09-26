// @vitest-environment jsdom
/** StylePicker: grid size, search / category filtering, selection, keyboard (radio group) and disabled state. */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STYLES } from '../../ai/styles';
import { StylePicker } from './StylePicker';
import { byTestId, cleanup, click, keyDown, mount, queryTestId, typeInto } from './testing';

afterEach(cleanup);

const radios = () => Array.from(document.querySelectorAll<HTMLElement>('[role="radio"]'));

function render(value: string | null, onChange = vi.fn(), disabled = false, lang: 'tr' | 'en' = 'en') {
  const m = mount(createElement(StylePicker, { value, onChange, disabled }), lang);
  return { ...m, onChange };
}

describe('StylePicker', () => {
  it('shows "None" plus at least 48 styles as a radio group', () => {
    render(null);
    expect(STYLES.length).toBeGreaterThanOrEqual(48);
    expect(radios()).toHaveLength(STYLES.length + 1);
    expect(byTestId('style-none').getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('[role="radiogroup"]')?.getAttribute('aria-labelledby')).toBeTruthy();
    // Roving tabindex: only the checked radio is tabbable.
    expect(radios().filter((r) => r.tabIndex === 0)).toEqual([byTestId('style-none')]);
  });

  it('selects on click and marks the current value', () => {
    const { onChange, render: rerender } = render(null);
    click(byTestId('style-marble'));
    expect(onChange).toHaveBeenLastCalledWith('marble');
    rerender(createElement(StylePicker, { value: 'marble', onChange }));
    expect(byTestId('style-marble').getAttribute('aria-checked')).toBe('true');
    expect(byTestId('style-marble').tabIndex).toBe(0);
    expect(byTestId('style-none').tabIndex).toBe(-1);
    click(byTestId('style-none'));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('filters by search text (either language, no diacritics) and by category', () => {
    render(null, vi.fn(), false, 'tr');
    typeInto(byTestId<HTMLInputElement>('style-search'), 'seker');
    expect(queryTestId('style-candy')).not.toBeNull();
    expect(queryTestId('style-marble')).toBeNull();
    expect(queryTestId('style-none')).not.toBeNull(); // "None" is always offered
    typeInto(byTestId<HTMLInputElement>('style-search'), 'qqqq');
    expect(radios()).toHaveLength(1);
    expect(document.body.textContent).toContain('“qqqq” ile eşleşen stil yok.');
    typeInto(byTestId<HTMLInputElement>('style-search'), '');
    click(byTestId('style-cat-toy'));
    expect(byTestId('style-cat-toy').getAttribute('aria-pressed')).toBe('true');
    const shown = radios().map((r) => r.dataset.testid!.replace('style-', '')).filter((id) => id !== 'none');
    expect(shown.length).toBe(STYLES.filter((s) => s.category === 'toy').length);
    expect(shown).toContain('vinyl-figure');
    click(byTestId('style-cat-all'));
    expect(radios()).toHaveLength(STYLES.length + 1);
  });

  it('moves and selects with the arrow keys, Home and End', () => {
    const { onChange } = render(null);
    const grid = document.querySelector('[role="radiogroup"]')!;
    byTestId('style-none').focus();
    keyDown(grid, 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith(STYLES[0].id);
    expect(document.activeElement).toBe(byTestId(`style-${STYLES[0].id}`));
    keyDown(grid, 'End');
    expect(onChange).toHaveBeenLastCalledWith(STYLES[STYLES.length - 1].id);
    keyDown(grid, 'ArrowRight'); // wraps to "None"
    expect(onChange).toHaveBeenLastCalledWith(null);
    keyDown(grid, 'ArrowLeft'); // wraps to the last style
    expect(onChange).toHaveBeenLastCalledWith(STYLES[STYLES.length - 1].id);
    keyDown(grid, 'Home');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('does nothing while disabled', () => {
    const { onChange } = render('marble', vi.fn(), true);
    click(byTestId('style-gold'));
    keyDown(document.querySelector('[role="radiogroup"]')!, 'ArrowRight');
    expect(onChange).not.toHaveBeenCalled();
    expect(byTestId<HTMLInputElement>('style-search').disabled).toBe(true);
    expect(radios().every((r) => r.tabIndex === -1)).toBe(true);
  });
});
