/**
 * jsdom helpers for the AI component tests: mount under a LangProvider with
 * React 19's createRoot + act, and fire the events React listens to.
 * (Imported by *.test.ts only.)
 */
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Lang, RGBAImage } from '../../core/types';
import { LangProvider } from '../i18n';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  host: HTMLElement;
  root: Root;
  render: (el: ReactElement) => void;
  unmount: () => void;
}

const mounted: Mounted[] = [];

export function mount(el: ReactElement, lang: Lang = 'en'): Mounted {
  // jsdom has no 2D canvas; RGBACanvas copes with a null context.
  if (typeof HTMLCanvasElement !== 'undefined') HTMLCanvasElement.prototype.getContext = (() => null) as never;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const m: Mounted = {
    host,
    root,
    render: (next) => act(() => root.render(createElement(LangProvider, { value: lang }, next))),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
  m.render(el);
  mounted.push(m);
  return m;
}

/** Unmounts everything mounted so far (call from afterEach). */
export function cleanup(): void {
  while (mounted.length) mounted.pop()!.unmount();
  document.body.innerHTML = '';
}

/** Element by data-testid anywhere in the document (dialogs render in a portal). */
export function byTestId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`No element with data-testid="${id}"`);
  return el;
}

export function queryTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`);
}

export function click(el: Element): void {
  act(() => {
    (el as HTMLElement).click();
  });
}

/** Types into a controlled <input> / <textarea> (native setter + input event, as React expects). */
export function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export function selectValue(el: HTMLSelectElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

export function keyDown(el: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    el.dispatchEvent(ev);
  });
  return ev;
}

/** Sets `files` on a file input and fires change. */
export function chooseFile(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Fires a drop of `files` on `el` (dragover first, as a browser would). */
export function dropFiles(el: Element, files: File[]): void {
  const dataTransfer = { files, types: ['Files'], dropEffect: 'none' };
  for (const type of ['dragover', 'drop']) {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer });
    act(() => {
      el.dispatchEvent(ev);
    });
  }
}

export function image(width = 4, height = 4): RGBAImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(200) };
}
