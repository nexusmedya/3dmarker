// @vitest-environment jsdom
/**
 * DepthMapEditor in a DOM (no 2D canvas in jsdom: painting still edits the
 * depth, the view just is not drawn): open / closed, painting through
 * pointer events, undo, keyboard isolation from the page, Apply / Cancel.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DepthMap, Mask, RGBAImage } from '../../core/types';
import { LangProvider } from '../i18n';
import { DepthMapEditor } from './DepthMapEditor';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  // jsdom has no 2D canvas; keep its "not implemented" noise out of the output.
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = '';
});

const W = 50, H = 40;
const depth: DepthMap = { width: W, height: H, data: new Float32Array(W * H).fill(0.5) };
const image: RGBAImage = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(200) };
const mask: Mask = { width: W, height: H, data: new Uint8Array(W * H).fill(1) };

function mount(open = true) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const onApply = vi.fn();
  const onClose = vi.fn();
  const render = (o: boolean) =>
    act(() => root!.render(createElement(LangProvider, { value: 'en' }, createElement(DepthMapEditor, { open: o, depth, mask, image, onApply, onClose }))));
  render(open);
  return { onApply, onClose, render };
}

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;

describe('DepthMapEditor', () => {
  it('renders nothing while closed and a modal dialog when open', () => {
    const { render } = mount(false);
    expect(q('[data-testid="depth-editor"]')).toBeNull();
    render(true);
    const dialog = q('[data-testid="depth-editor"]')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(dialog);
    expect(document.body.style.overflow).toBe('hidden');
    for (const b of ['raise', 'lower', 'smooth', 'flatten', 'erase']) expect(q(`[data-testid="depth-brush-${b}"]`)).not.toBeNull();
    render(false);
    expect(document.body.style.overflow).toBe('');
  });

  it('paints, undoes, keeps page shortcuts out and applies a new depth map', () => {
    const { onApply, onClose } = mount();
    const stage = q('[data-testid="depth-stage"]')!;
    // Stage at 0,0 with zoom 1 (jsdom has no layout, fit() keeps the default view).
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 400, right: 500, bottom: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const fire = (type: string, x: number, y: number, init: PointerEventInit = {}) =>
      stage.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y, ...init }));
    act(() => {
      fire('pointerdown', 20, 20);
      fire('pointermove', 30, 20);
      fire('pointerup', 30, 20);
    });
    expect(q('[data-testid="depth-edits"]')!.dataset.edits).toBe('1');
    expect((q('[data-testid="depth-undo"]') as HTMLButtonElement).disabled).toBe(false);

    const pageKeys = vi.fn();
    window.addEventListener('keydown', pageKeys);
    const dialog = q('[data-testid="depth-editor"]')!;
    act(() => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(q('[data-testid="depth-edits"]')!.dataset.edits).toBe('0');
    act(() => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(pageKeys).not.toHaveBeenCalled();
    window.removeEventListener('keydown', pageKeys);

    act(() => (q('[data-testid="depth-redo"]') as HTMLButtonElement).click());
    act(() => (q('[data-testid="depth-apply"]') as HTMLButtonElement).click());
    expect(onApply).toHaveBeenCalledTimes(1);
    const out = onApply.mock.calls[0][0] as DepthMap;
    expect(out.width).toBe(W);
    expect(out.data).not.toBe(depth.data);
    expect(out.data[20 * W + 25]).toBeGreaterThan(0.5);
    expect(depth.data[20 * W + 25]).toBe(0.5); // input untouched
    expect(onClose).toHaveBeenCalled();
  });

  it('pressing the Fit button on the stage does not paint', () => {
    mount();
    const stage = q('[data-testid="depth-stage"]')!;
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 400, right: 500, bottom: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const fit = q('[data-testid="depth-fit"]')!;
    expect(stage.contains(fit)).toBe(true);
    const fire = (type: string) =>
      fit.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, clientX: 20, clientY: 10 }));
    let prevented = false;
    act(() => {
      fire('pointerdown');
      prevented = fire('pointerup') === false;
      fit.click();
    });
    expect(prevented).toBe(false);
    expect(q('[data-testid="depth-edits"]')!.dataset.edits).toBe('0');
    expect((q('[data-testid="depth-undo"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Escape and Cancel close without applying', () => {
    const { onApply, onClose } = mount();
    act(() => {
      q('[data-testid="depth-editor"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => (q('[data-testid="depth-cancel"]') as HTMLButtonElement).click());
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onApply).not.toHaveBeenCalled();
  });
});
