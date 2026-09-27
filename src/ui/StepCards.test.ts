// @vitest-environment jsdom
/** OriginalNote asks before dropping AI views; RevertedNote offers the way back. */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OriginalNote, RevertedNote } from './StepCards';
import { byTestId, cleanup, click, mount, queryTestId } from './ai/testing';

afterEach(cleanup);

describe('OriginalNote', () => {
  it('reverts at once when no AI views would be lost', () => {
    const onRevert = vi.fn();
    mount(createElement(OriginalNote, { onRevert, aiViewCount: 0 }));
    click(byTestId('revert-original'));
    expect(onRevert).toHaveBeenCalledOnce();
  });

  it('asks first when AI views would be dropped; Cancel keeps them', () => {
    const onRevert = vi.fn();
    mount(createElement(OriginalNote, { onRevert, aiViewCount: 5 }), 'tr');
    click(byTestId('revert-original'));
    expect(onRevert).not.toHaveBeenCalled();
    expect(byTestId('revert-original-confirm').textContent).toContain('5 görünüm');
    click(byTestId('revert-original-keep'));
    expect(queryTestId('revert-original-confirm')).toBeNull();
    click(byTestId('revert-original'));
    click(byTestId('revert-original-go'));
    expect(onRevert).toHaveBeenCalledOnce();
  });
});

describe('RevertedNote', () => {
  it('restores the AI image with its view count', () => {
    const onRestore = vi.fn();
    mount(createElement(RevertedNote, { onRestore, aiViewCount: 3 }));
    expect(byTestId('restore-prepared').textContent).toContain('+3 views');
    click(byTestId('restore-prepared'));
    expect(onRestore).toHaveBeenCalledOnce();
  });
});
