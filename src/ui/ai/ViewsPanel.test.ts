// @vitest-environment jsdom
/** ViewsPanel: slots, upload (picker + drop), generate / clear / generate-missing callbacks, busy + cancel, AI-not-ready state. */
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewsPanel } from './ViewsPanel';
import type { ViewSlotInfo } from './types';
import { byTestId, chooseFile, cleanup, click, dropFiles, image, mount, queryTestId } from './testing';

afterEach(cleanup);

type Props = Parameters<typeof ViewsPanel>[0];

function props(over: Partial<Props> = {}): Props {
  return {
    front: image(),
    views: {},
    onUpload: vi.fn(),
    onGenerate: vi.fn(),
    onGenerateMissing: vi.fn(),
    onClear: vi.fn(),
    busy: null,
    progress: null,
    error: null,
    onCancel: vi.fn(),
    aiReady: true,
    aiReason: null,
    onOpenSettings: vi.fn(),
    ...over,
  };
}

const slot = (image_: ViewSlotInfo['image'], origin: ViewSlotInfo['origin'], name = 'x.png'): ViewSlotInfo => ({ image: image_, origin, name });

describe('ViewsPanel', () => {
  it('shows the six slots with origin badges and the count', () => {
    const p = props({ views: { back: slot(image(), 'upload', 'back.png'), left: slot(image(), 'ai') } });
    mount(createElement(ViewsPanel, p));
    for (const v of ['front', 'back', 'left', 'right', 'top', 'bottom']) expect(queryTestId(`view-${v}`)).not.toBeNull();
    expect(byTestId('view-front').textContent).toContain('Source');
    expect(byTestId('view-back').textContent).toContain('Uploaded');
    expect(byTestId('view-left').textContent).toContain('AI');
    expect(byTestId('view-back').dataset.filled).toBe('true');
    expect(byTestId('view-right').dataset.filled).toBe('false');
    expect(byTestId('views-count').textContent).toBe('3/6 views');
    // The front is read-only.
    expect(queryTestId('view-upload-front')).toBeNull();
    expect(queryTestId('view-generate-front')).toBeNull();
    // Clear only where there is an image.
    expect(queryTestId('view-clear-back')).not.toBeNull();
    expect(queryTestId('view-clear-right')).toBeNull();
  });

  it('offers multi-view fusion once a view is given, when the shell asks for it', () => {
    const onUseFusion = vi.fn();
    const m = mount(createElement(ViewsPanel, props({ onUseFusion })));
    expect(queryTestId('views-use-fusion')).toBeNull(); // no extra view yet
    m.render(createElement(ViewsPanel, props({ onUseFusion, views: { back: slot(image(), 'upload') } })));
    click(byTestId('views-use-fusion'));
    expect(onUseFusion).toHaveBeenCalledTimes(1);
    m.render(createElement(ViewsPanel, props({ views: { back: slot(image(), 'upload') } })));
    expect(queryTestId('views-use-fusion')).toBeNull(); // the driver uses the views already
  });

  it('uploads through the picker and by dropping a file on a slot', () => {
    const p = props();
    mount(createElement(ViewsPanel, p));
    const file = new File(['x'], 'back.png', { type: 'image/png' });
    const input = byTestId('view-upload-back').querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    chooseFile(input, file);
    expect(p.onUpload).toHaveBeenCalledWith('back', file);
    const top = new File(['y'], 'top.webp', { type: 'image/webp' });
    dropFiles(byTestId('view-top'), [new File(['z'], 'notes.txt', { type: 'text/plain' }), top]);
    expect(p.onUpload).toHaveBeenLastCalledWith('top', top);
  });

  it('generates one view, all missing views, and clears', () => {
    const p = props({ views: { back: slot(image(), 'ai') } });
    mount(createElement(ViewsPanel, p));
    click(byTestId('view-generate-left'));
    expect(p.onGenerate).toHaveBeenCalledWith('left');
    const missing = byTestId<HTMLButtonElement>('views-generate-missing');
    expect(missing.textContent).toContain('Generate missing views (4)');
    click(missing);
    expect(p.onGenerateMissing).toHaveBeenCalledTimes(1);
    click(byTestId('view-clear-back'));
    expect(p.onClear).toHaveBeenCalledWith('back');
  });

  it('shows the reason and a settings button when AI is not ready; upload still works', () => {
    const p = props({ aiReady: false, aiReason: 'No API key entered.' });
    mount(createElement(ViewsPanel, p));
    expect(byTestId('views-ai-reason').textContent).toContain('No API key entered.');
    expect(byTestId<HTMLButtonElement>('views-generate-missing').disabled).toBe(true);
    expect(byTestId<HTMLButtonElement>('view-generate-back').disabled).toBe(true);
    click(byTestId('views-settings'));
    expect(p.onOpenSettings).toHaveBeenCalledTimes(1);
    const input = byTestId('view-upload-right').querySelector('input') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    const f = new File(['x'], 'r.png', { type: 'image/png' });
    chooseFile(input, f);
    expect(p.onUpload).toHaveBeenCalledWith('right', f);
  });

  it('needs the front image for AI', () => {
    mount(createElement(ViewsPanel, props({ front: null })));
    expect(byTestId('view-front').textContent).toContain('Upload an image first');
    expect(byTestId<HTMLButtonElement>('views-generate-missing').disabled).toBe(true);
    expect(byTestId<HTMLButtonElement>('view-generate-bottom').disabled).toBe(true);
  });

  it('shows busy slots, progress and cancel while generating', () => {
    const p = props({ busy: 'all', progress: { label: { tr: 'Arka', en: 'Back view' }, ratio: 0.4 }, views: { left: slot(image(), 'upload') } });
    mount(createElement(ViewsPanel, p));
    expect(byTestId('view-back').getAttribute('aria-busy')).toBe('true');
    expect(byTestId('view-left').getAttribute('aria-busy')).toBeNull(); // already has an image
    expect(queryTestId('views-generate-missing')).toBeNull();
    expect(byTestId('views-progress').textContent).toContain('Back view');
    expect(byTestId<HTMLButtonElement>('view-generate-right').disabled).toBe(true);
    expect((byTestId('view-upload-right').querySelector('input') as HTMLInputElement).disabled).toBe(true);
    click(byTestId('views-cancel'));
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows the per-slot percentage for a single view and the error', () => {
    const p = props({ busy: 'top', progress: { label: { tr: 'x', en: 'x' }, ratio: 0.25 }, error: { tr: 'Hata', en: 'Boom' } });
    const m = mount(createElement(ViewsPanel, p));
    expect(byTestId('view-top').textContent).toContain('25%');
    expect(queryTestId('views-error')).toBeNull(); // hidden while busy
    m.render(createElement(ViewsPanel, { ...p, busy: null }));
    expect(byTestId('views-error').textContent).toContain('Boom');
  });

  it('explains the orientation of a slot on hover', () => {
    mount(createElement(ViewsPanel, props()), 'tr');
    act(() => {
      byTestId('view-left').dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    });
    expect(byTestId('views-hint').textContent).toContain('öznenin sol yanı');
    // Keyboard users get the same hint on focus.
    act(() => byTestId<HTMLButtonElement>('view-generate-bottom').focus());
    expect(byTestId('views-hint').textContent).toContain('aşağıdan görünüm');
  });
});
