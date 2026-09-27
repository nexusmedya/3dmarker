// @vitest-environment jsdom
/**
 * ViewsPanel: slots, upload (picker + drop), generate / clear / generate-missing
 * callbacks, busy + cancel, AI-not-ready state; consistency badges, the align
 * panel (sliders, flip, trust, auto / reset, Esc) and "Copy prompt".
 */
import { StrictMode, act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VIEW_ALIGN, type ViewAlign } from '../../core/types';
import type { ViewAlignment } from '../../core/fusion/types';
import { ALIGN_TEXT, SHARED_AXES, alignedBox } from '../../core/fusion/align';
import { ViewsPanel, bboxOfFit, liveAlignment } from './ViewsPanel';
import type { ViewSlotInfo } from './types';
import { byTestId, chooseFile, cleanup, click, dropFiles, image, keyDown, mount, queryTestId, typeInto } from './testing';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

const slot = (image_: ViewSlotInfo['image'], origin: ViewSlotInfo['origin'], name = 'x.png', align: ViewAlign = DEFAULT_VIEW_ALIGN): ViewSlotInfo => ({
  image: image_,
  origin,
  name,
  align,
});

/** A registration result: suggested dy 0.03 / scale 0.95, applied likewise, a cut bottom edge when asked. */
function check(id: ViewAlignment['id'], over: Partial<ViewAlignment> = {}): ViewAlignment {
  const suggested = { dx: 0, dy: 0.03, scale: 0.95, flipX: false };
  return {
    id,
    status: 'aligned',
    level: 'good',
    score: 88,
    confidence: 0.9,
    applied: suggested,
    suggested,
    residual: { dx: 0, dy: 0, scale: 1 },
    cut: { top: false, bottom: false, left: false, right: false },
    fitBox: alignedBox({ x0: 1, y0: 1, x1: 3, y1: 4 }, suggested, SHARED_AXES[id]),
    trust: 'full',
    notes: [{ code: 'autoAligned', text: { tr: 'Otomatik hizalandı: %3 aşağı', en: 'Auto-aligned: 3 % down' } }],
    guides: { rows: [1, 2, 4], cols: [1, 3] },
    ...over,
  };
}

/** Props with align support wired (spies) and the back / left slots filled. */
function alignProps(over: Partial<Props> = {}): Props & { onAlign: ReturnType<typeof vi.fn>; onAlignAuto: ReturnType<typeof vi.fn>; onAlignReset: ReturnType<typeof vi.fn> } {
  const onAlign = vi.fn(), onAlignAuto = vi.fn(), onAlignReset = vi.fn();
  return {
    ...props({ views: { back: slot(image(), 'upload', 'back.png'), left: slot(image(), 'upload', 'left.png') }, checks: { back: check('back') }, ...over }),
    onAlign,
    onAlignAuto,
    onAlignReset,
  };
}

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

describe('ViewsPanel consistency badges', () => {
  it('shows score, level, cut edges and the note from a check; pending while checking; none without checks', () => {
    const p = alignProps({ checks: { back: check('back', { cut: { top: false, bottom: true, left: false, right: false }, score: 62, level: 'fair' }) } });
    mount(createElement(ViewsPanel, p));
    const badge = byTestId('view-check-back');
    expect(badge.dataset).toMatchObject({ level: 'fair', score: '62', cut: 'bottom' });
    expect(badge.textContent).toContain('62');
    expect(badge.title).toBe('Auto-aligned: 3 % down');
    expect(badge.getAttribute('aria-label')).toBe('Consistency 62 %, fair: Auto-aligned: 3 % down');
    const pending = byTestId('view-check-left');
    expect(pending.dataset.level).toBe('pending');
    expect(pending.getAttribute('aria-busy')).toBe('true');
    expect(pending.textContent).toBe('…');
    expect(queryTestId('view-check-right')).toBeNull(); // empty slot
    // Without a checks prop the badges are not shown at all.
    const plain = mount(createElement(ViewsPanel, props({ views: { back: slot(image(), 'upload') } })));
    expect(plain.host.querySelector('[data-testid="view-check-back"]')).toBeNull();
    expect(plain.host.querySelector('[data-testid="view-back"]')).not.toBeNull();
  });

  it('marks the trust on the slot and hides the badge of a view switched off', () => {
    const p = alignProps({
      views: {
        back: slot(image(), 'upload', 'b', { ...DEFAULT_VIEW_ALIGN, trust: 'color' }),
        left: slot(image(), 'upload', 'l', { ...DEFAULT_VIEW_ALIGN, trust: 'off' }),
      },
      checks: { back: check('back'), left: check('left') },
    });
    mount(createElement(ViewsPanel, p));
    expect(byTestId('view-back').dataset.trust).toBe('color');
    expect(byTestId('view-trust-back').textContent).toBe('Colour only');
    expect(queryTestId('view-check-back')).not.toBeNull();
    expect(byTestId('view-left').dataset.trust).toBe('off');
    expect(byTestId('view-left').className).toContain('is-off');
    expect(byTestId('view-trust-left').textContent).toBe('Off');
    expect(queryTestId('view-check-left')).toBeNull();
    expect(queryTestId('view-trust-right')).toBeNull();
  });

  it('re-scores a manual correction live and keeps the check\'s score in auto mode', () => {
    const c = check('back');
    expect(liveAlignment(c, DEFAULT_VIEW_ALIGN)).toEqual({ score: 88, level: 'good' });
    const manual = liveAlignment(c, { ...DEFAULT_VIEW_ALIGN, mode: 'manual', dy: -0.06 });
    // residual dy = 0.03 − (−0.06) = 0.09 → −0.5; scale 0.95 / 1 → −0.3·(|ln 0.95| / 0.15) = −0.103; 100·0.9·0.397 = 36.
    expect(manual).toEqual({ score: 36, level: 'poor' });
    expect(liveAlignment(c, { ...DEFAULT_VIEW_ALIGN, mode: 'manual', dy: 0.03, scale: 0.95 })).toEqual({ score: 90, level: 'good' });
    // A check computed under a manual request re-scores against its suggestion once the mode is auto again.
    expect(liveAlignment({ ...c, status: 'manual', score: 10, level: 'poor' }, DEFAULT_VIEW_ALIGN).score).toBe(90);
    // A slot check (the front uploaded as the left view) holds whatever the placement.
    const wrong = { ...check('left'), score: 30, level: 'poor' as const, notes: [{ code: 'wrongSlot' as const, text: ALIGN_TEXT.wrongSlot }] };
    expect(liveAlignment(wrong, { ...DEFAULT_VIEW_ALIGN, mode: 'manual', dy: 0.03, scale: 0.95 })).toEqual({ score: 30, level: 'poor' });
    // The inverse of alignedBox recovers the silhouette bbox.
    const bbox = { x0: 10, y0: 20, x1: 110, y1: 220 };
    for (const id of ['back', 'left', 'top'] as const) {
      const a = { dx: 0.02, dy: -0.03, scale: 1.1 };
      const back = bboxOfFit(alignedBox(bbox, a, SHARED_AXES[id]), a, SHARED_AXES[id]);
      for (const k of ['x0', 'y0', 'x1', 'y1'] as const) expect(back[k]).toBeCloseTo(bbox[k], 6);
    }
  });
});

describe('ViewsPanel align panel', () => {
  it('opens and closes from the slot button (aria-expanded), Esc closes and refocuses it', () => {
    const p = alignProps();
    mount(createElement(ViewsPanel, p));
    expect(queryTestId('view-align-panel')).toBeNull();
    expect(queryTestId('view-align-right')).toBeNull(); // empty slot: nothing to align
    const trigger = byTestId<HTMLButtonElement>('view-align-back');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    click(trigger);
    const panel = byTestId('view-align-panel');
    expect(panel.dataset.view).toBe('back');
    expect(panel.getAttribute('role')).toBe('group');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id);
    expect(byTestId('align-overlay').getAttribute('role')).toBe('img');
    expect(byTestId('align-overlay').getAttribute('aria-label')).toContain('88 · good · Auto-aligned');
    // One panel at a time: the left slot's button switches it.
    click(byTestId('view-align-left'));
    expect(byTestId('view-align-panel').dataset.view).toBe('left');
    expect(byTestId('align-status').textContent).toBe('Checking…'); // no check for the left yet
    click(byTestId('view-align-back'));
    keyDown(byTestId('view-align-panel'), 'Escape');
    expect(queryTestId('view-align-panel')).toBeNull();
    expect(document.activeElement).toBe(byTestId('view-align-back'));
    click(byTestId('view-align-back'));
    click(byTestId('align-close'));
    expect(queryTestId('view-align-panel')).toBeNull();
  });

  it('sliders start at the suggestion in auto mode and patch in fractions; the X offset is hidden for a side view', async () => {
    const p = alignProps();
    mount(createElement(ViewsPanel, p));
    click(byTestId('view-align-back'));
    expect(byTestId<HTMLInputElement>('align-dy').value).toBe('3');
    expect(byTestId<HTMLInputElement>('align-scale').value).toBe('95');
    expect(byTestId<HTMLInputElement>('align-dx').value).toBe('0');
    // In auto mode an edit carries the shown starting values too, so the others do not snap to the defaults.
    typeInto(byTestId<HTMLInputElement>('align-dy'), '-6');
    expect(p.onAlign).toHaveBeenLastCalledWith('back', { dx: 0, dy: -0.06, scale: 0.95 });
    typeInto(byTestId<HTMLInputElement>('align-scale'), '105');
    expect(p.onAlign).toHaveBeenLastCalledWith('back', { dx: 0, dy: 0.03, scale: 1.05 });
    // Out-of-range text is clamped on blur only.
    typeInto(byTestId<HTMLInputElement>('align-dx'), '40');
    const calls = p.onAlign.mock.calls.length;
    act(() => byTestId('align-dx').dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(p.onAlign.mock.calls.length).toBe(calls + 1);
    expect(p.onAlign).toHaveBeenLastCalledWith('back', { dx: 0.2, dy: 0.03, scale: 0.95 });
    // Slider drags are coalesced to one dispatch per frame.
    typeInto(byTestId<HTMLInputElement>('align-dy-range'), '2');
    typeInto(byTestId<HTMLInputElement>('align-dy-range'), '2.5');
    await act(() => new Promise<void>((r) => setTimeout(r, 40)));
    expect(p.onAlign).toHaveBeenLastCalledWith('back', { dx: 0, dy: 0.025, scale: 0.95 });
    // A side view shares only the vertical axis with the front.
    click(byTestId('view-align-left'));
    expect(queryTestId('align-dx')).toBeNull();
    expect(queryTestId('align-dy')).not.toBeNull();
    expect(queryTestId('align-scale')).not.toBeNull();
  });

  it('manual mode patches one value at a time; slider drags still reach the shell under StrictMode', async () => {
    const p = alignProps({ views: { back: slot(image(), 'upload', 'b', { ...DEFAULT_VIEW_ALIGN, mode: 'manual', dy: -0.02, scale: 1.1 }) } });
    // StrictMode mounts, cleans up and remounts effects: a throttle cancelled in the cleanup must not stay dead.
    mount(createElement(StrictMode, null, createElement(ViewsPanel, p)));
    click(byTestId('view-align-back'));
    typeInto(byTestId<HTMLInputElement>('align-dy'), '-6');
    expect(p.onAlign).toHaveBeenLastCalledWith('back', { dy: -0.06 });
    typeInto(byTestId<HTMLInputElement>('align-scale-range'), '120');
    await act(() => new Promise<void>((r) => setTimeout(r, 40)));
    expect(p.onAlign).toHaveBeenLastCalledWith('back', { scale: 1.2 });
    typeInto(byTestId<HTMLInputElement>('align-dx-range'), '4');
    typeInto(byTestId<HTMLInputElement>('align-dy-range'), '5');
    await act(() => new Promise<void>((r) => setTimeout(r, 40)));
    expect(p.onAlign).toHaveBeenLastCalledWith('back', { dx: 0.04, dy: 0.05 }); // merged while coalesced
    // Whatever is still pending when the panel closes is dispatched at once.
    typeInto(byTestId<HTMLInputElement>('align-dy-range'), '7');
    click(byTestId('align-close'));
    expect(p.onAlign).toHaveBeenLastCalledWith('back', { dy: 0.07 });
  });

  it('shows manual values with a live status, flips, changes the trust, auto-aligns and resets', () => {
    const p = alignProps({ views: { back: slot(image(), 'upload', 'b', { ...DEFAULT_VIEW_ALIGN, mode: 'manual', dy: -0.06, trust: 'color' }) } });
    mount(createElement(ViewsPanel, p));
    click(byTestId('view-align-back'));
    expect(byTestId<HTMLInputElement>('align-dy').value).toBe('-6');
    expect(byTestId('align-status').textContent).toBe('36 · poor · Auto-aligned: 3 % down');
    expect(byTestId('view-check-back').dataset.score).toBe('36'); // the badge follows the manual correction
    click(byTestId('align-flip'));
    expect(p.onAlign).toHaveBeenLastCalledWith('back', { flipX: true });
    const group = byTestId('align-trust');
    expect(group.getAttribute('role')).toBe('radiogroup');
    expect(byTestId<HTMLInputElement>('align-trust-color').checked).toBe(true);
    click(byTestId('align-trust-off'));
    expect(p.onAlign).toHaveBeenLastCalledWith('back', { trust: 'off' });
    click(byTestId('align-auto'));
    expect(p.onAlignAuto).toHaveBeenCalledWith('back');
    click(byTestId('align-reset'));
    expect(p.onAlignReset).toHaveBeenCalledWith('back');
    // Auto-align is off when the registration could not match the view (nothing to return to)…
    const weak = alignProps({ checks: { back: check('back', { confidence: 0.2, status: 'weak' }) } });
    const m = mount(createElement(ViewsPanel, weak));
    click(m.host.querySelector('[data-testid="view-align-back"]')!);
    const auto = m.host.querySelector<HTMLButtonElement>('[data-testid="align-auto"]')!;
    expect(auto.disabled).toBe(true);
    expect(auto.title).toBe('Could not match this view to the front');
    // …but never while the view is manual: a check made for a manual placement scores that placement, and
    // going back to automatic is always possible.
    const manualSlot = { back: slot(image(), 'upload', 'b', { ...DEFAULT_VIEW_ALIGN, mode: 'manual', dy: -0.1 }) };
    for (const c of [check('back', { confidence: 0.2, status: 'manual' }), check('back', { confidence: 0.2, status: 'weak' })]) {
      const m2 = mount(createElement(ViewsPanel, alignProps({ views: manualSlot, checks: { back: c } })));
      click(m2.host.querySelector('[data-testid="view-align-back"]')!);
      const auto2 = m2.host.querySelector<HTMLButtonElement>('[data-testid="align-auto"]')!;
      expect(auto2.disabled).toBe(false);
      expect(auto2.title).toBe('');
      m2.unmount();
    }
  });

  it('renders the align panel and the guide in Turkish', () => {
    const p = alignProps();
    mount(createElement(ViewsPanel, p), 'tr');
    click(byTestId('view-align-back'));
    const panel = byTestId('view-align-panel');
    expect(panel.textContent).toContain('Arka görünümü hizala');
    expect(panel.textContent).toContain('Dikey kayma');
    expect(panel.textContent).toContain('Yalnız renk');
    expect(byTestId('align-status').textContent).toBe('88 · iyi · Otomatik hizalandı: %3 aşağı');
    expect(byTestId('view-check-back').getAttribute('aria-label')).toBe('Tutarlılık %88, iyi: Otomatik hizalandı: %3 aşağı');
    expect(byTestId('views-guide').textContent).toContain('Görünümleri tutarlı yapmak için');
  });
});

describe('ViewsPanel copy prompt', () => {
  it('copies the prompt of an empty slot to the clipboard and announces it; hidden without a prompt or a front', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const prompt = vi.fn((v: string) => `PROMPT for ${v}`);
    mount(createElement(ViewsPanel, props({ prompt })));
    expect(queryTestId('view-prompt-front')).toBeNull();
    await act(async () => {
      byTestId('view-prompt-top').click();
    });
    expect(prompt).toHaveBeenCalledWith('top');
    expect(writeText).toHaveBeenCalledWith('PROMPT for top');
    expect(byTestId('views-hint').textContent).toContain('Prompt copied');
    expect(queryTestId('view-prompt-text')).toBeNull();
    mount(createElement(ViewsPanel, props({ prompt, front: null })));
    expect(document.querySelectorAll('[data-testid="view-prompt-top"]')).toHaveLength(1); // only the first panel has one
    mount(createElement(ViewsPanel, props()));
    expect(document.querySelectorAll('[data-testid="view-prompt-top"]')).toHaveLength(1);
  });

  it('falls back to a selectable text box when the clipboard refuses, in Turkish too', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) } });
    mount(createElement(ViewsPanel, props({ prompt: () => 'THE PROMPT' })), 'tr');
    await act(async () => {
      byTestId('view-prompt-back').click();
    });
    expect(byTestId('views-hint').textContent).toContain('Panoya yazılamadı');
    const box = byTestId<HTMLTextAreaElement>('view-prompt-text');
    expect(box.value).toBe('THE PROMPT');
    expect(box.readOnly).toBe(true);
    click(byTestId('view-prompt-select'));
    expect(box.selectionEnd - box.selectionStart).toBe('THE PROMPT'.length);
  });
});
