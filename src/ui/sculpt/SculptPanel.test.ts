// @vitest-environment jsdom
/**
 * SculptPanel in a DOM with a fake viewer host (no WebGL): disabled states,
 * the mode toggle creating / disposing the session, brush buttons, a stroke
 * through pointer events → onEdited stats, and undo from the panel.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mesh, MeshBasicMaterial } from 'three';
import type { MutableRefObject } from 'react';
import type { ViewerCore } from '../../app/viewer';
import type { BuiltModel } from '../../app/pipeline';
import { LangProvider } from '../i18n';
import { SculptPanel } from './SculptPanel';
import { fakeHost, gridGeometry } from '../../sculpt/testing';
import { computeMeshStats } from '../../core/mesh/stats';

vi.mock('../../core/mesh/stats', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../core/mesh/stats')>();
  return { ...mod, computeMeshStats: vi.fn(mod.computeMeshStats) };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = '';
});

function modelOf(mesh: Mesh): BuiltModel {
  return { kind: 'geometry', object: mesh, stats: { vertices: 0, triangles: 0, watertight: false }, depth: null, mask: null, meshKey: null, remesh: null };
}

function mount(props: Partial<Parameters<typeof SculptPanel>[0]> & { lang?: 'tr' | 'en' }) {
  const hostEl = document.createElement('div');
  const canvas = document.createElement('canvas');
  hostEl.appendChild(canvas);
  document.body.appendChild(hostEl);
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const core = fakeHost(canvas);
  const coreRef = { current: core as unknown as ViewerCore } as MutableRefObject<ViewerCore | null>;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const onEdited = vi.fn();
  const onActiveChange = vi.fn();
  const render = (p: Partial<Parameters<typeof SculptPanel>[0]> & { mounted?: boolean } = {}) =>
    act(() =>
      root!.render(
        createElement(
          LangProvider,
          { value: props.lang ?? 'en' },
          p.mounted === false ? null : createElement(SculptPanel, { coreRef, model: null, enabled: true, onEdited, onActiveChange, ...props, ...p }),
        ),
      ),
    );
  render();
  return { core, canvas, onEdited, onActiveChange, render };
}

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const flush = () => act(async () => new Promise((r) => setTimeout(r, 300))); // yieldToPaint: two frames or its 250 ms fallback

describe('SculptPanel', () => {
  it('is disabled with an explanation without a model or when not enabled', () => {
    const { render } = mount({ lang: 'tr' });
    expect((q('[data-testid="sculpt-toggle"]') as HTMLButtonElement).disabled).toBe(true);
    expect(q('[data-testid="sculpt-blocked"]')!.textContent).toContain('önce bir model');
    render({ model: modelOf(new Mesh(gridGeometry(4), new MeshBasicMaterial())), enabled: false });
    expect((q('[data-testid="sculpt-toggle"]') as HTMLButtonElement).disabled).toBe(true);
    expect(q('[data-testid="sculpt-blocked"]')!.textContent).toContain('iskelet');
  });

  it('toggles sculpt mode, picks brushes, sculpts, reports stats and undoes', async () => {
    const mesh = new Mesh(gridGeometry(32), new MeshBasicMaterial());
    const { core, canvas, onEdited, onActiveChange, render } = mount({ model: modelOf(mesh) });
    const toggle = q('[data-testid="sculpt-toggle"]') as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    expect(q('[data-testid="brush-draw"]')).toBeNull();
    await act(async () => toggle.click());
    await flush();
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
    expect(q('[data-testid="sculpt-panel"]')!.dataset.active).toBe('true');
    expect(core.overlays.size).toBe(1);
    for (const b of ['draw', 'clay', 'smooth', 'flatten', 'inflate', 'pinch', 'grab', 'crease']) expect(q(`[data-testid="brush-${b}"]`)).not.toBeNull();

    act(() => q('[data-testid="brush-clay"]')!.click());
    expect(q('[data-testid="brush-clay"]')!.getAttribute('aria-pressed')).toBe('true');
    // Keyboard shortcut from the session updates the panel.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
    });
    expect(q('[data-testid="brush-draw"]')!.getAttribute('aria-pressed')).toBe('true');

    const z0 = (mesh.geometry.getAttribute('position').array as Float32Array).slice();
    const fire = (type: string, x: number) =>
      canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: 50, pointerType: 'mouse' }));
    act(() => {
      fire('pointerdown', 50);
      fire('pointermove', 55);
      fire('pointerup', 55);
    });
    expect(q('[data-testid="sculpt-strokes"]')!.dataset.strokes).toBe('1');
    await act(async () => new Promise((r) => setTimeout(r, 400)));
    expect(onEdited).toHaveBeenCalledTimes(1);
    expect(onEdited.mock.calls[0][0]).toMatchObject({ vertices: 33 * 33, triangles: 32 * 32 * 2 });

    const undo = q('[data-testid="sculpt-undo"]') as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    act(() => undo.click());
    expect(mesh.geometry.getAttribute('position').array).toEqual(z0);
    expect(q('[data-testid="sculpt-strokes"]')!.dataset.strokes).toBe('0');
    expect((q('[data-testid="sculpt-redo"]') as HTMLButtonElement).disabled).toBe(false);

    await act(async () => toggle.click());
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
    expect(core.overlays.size).toBe(0);

    // A new model disposes the session (the BVH goes away, edits stay).
    const mesh2 = new Mesh(gridGeometry(8), new MeshBasicMaterial());
    render({ model: modelOf(mesh2) });
    expect(mesh.geometry.boundsTree).toBeUndefined();
  });

  const stroke = (canvas: HTMLCanvasElement, x = 50) => {
    const fire = (type: string, cx: number) =>
      canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, clientX: cx, clientY: 50, pointerType: 'mouse' }));
    act(() => {
      fire('pointerdown', x);
      fire('pointermove', x + 5);
      fire('pointerup', x + 5);
    });
  };
  const startSculpt = async () => {
    await act(async () => (q('[data-testid="sculpt-toggle"]') as HTMLButtonElement).click());
    await flush();
  };

  it('keeps undo history and the pre-sculpt mesh after leaving the step (geometry models)', async () => {
    const mesh = new Mesh(gridGeometry(32), new MeshBasicMaterial());
    const model = modelOf(mesh);
    const { canvas, render, core } = mount({ model });
    const z0 = (mesh.geometry.getAttribute('position').array as Float32Array).slice();
    await startSculpt();
    stroke(canvas, 40);
    stroke(canvas, 55);
    expect(q('[data-testid="sculpt-strokes"]')!.dataset.strokes).toBe('2');

    // Leave the Edit step (panel unmounted), then come back.
    render({ model, mounted: false });
    expect(core.overlays.size).toBe(0);
    expect(core.orbit.at(-1)).toBe(true);
    render({ model });
    await startSculpt();
    expect(q('[data-testid="sculpt-strokes"]')!.dataset.strokes).toBe('2');
    const undo = q('[data-testid="sculpt-undo"]') as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    const reset = q('[data-testid="sculpt-reset"]') as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    act(() => reset.click());
    expect(mesh.geometry.getAttribute('position').array).toEqual(z0);
    act(() => undo.click());
    expect(mesh.geometry.getAttribute('position').array).not.toEqual(z0);

    // Busy / rigged (not enabled) only ends sculpt mode.
    render({ model, enabled: false });
    expect(q('[data-testid="sculpt-panel"]')!.dataset.active).toBe('false');
    render({ model, enabled: true });
    await startSculpt();
    expect(q('[data-testid="sculpt-strokes"]')!.dataset.strokes).toBe('2');

    // Another model: the kept session goes (BVH released), even while unmounted.
    render({ model, mounted: false });
    expect(mesh.geometry.boundsTree).toBeDefined();
    render({ model: modelOf(new Mesh(gridGeometry(4), new MeshBasicMaterial())) });
    expect(mesh.geometry.boundsTree).toBeUndefined();
  });

  it('subdivides a coarse mesh at start, reports its new size and warns about strokes that reach no vertex', async () => {
    // Dense meshes (the grids above, 32 × 32) are used as they are: this one is two triangles.
    const mesh = new Mesh(gridGeometry(1), new MeshBasicMaterial());
    const { canvas, onEdited } = mount({ model: modelOf(mesh), lang: 'tr' });
    await startSculpt();
    expect(q('[data-testid="sculpt-refined"]')!.textContent).toMatch(/2 → [\d.]+ üçgen/);
    expect(onEdited).toHaveBeenCalledTimes(1);
    expect(onEdited.mock.calls[0][1]).toBe(0); // not an edit
    expect(onEdited.mock.calls[0][0].triangles).toBeGreaterThan(200);
    expect(q('[data-testid="sculpt-coarse"]')).toBeNull();
    expect(q('[data-testid="sculpt-empty-stroke"]')).toBeNull();

    // The smallest brush is finer than the refined spacing: warned up front and after a stroke that hits nothing.
    const radius = q('[data-testid="sculpt-radius"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(radius, '0.01');
      radius.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(q('[data-testid="sculpt-coarse"]')!.textContent).toContain('seyrek');
    const fire = (type: string, x: number, y: number) =>
      canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y, pointerType: 'mouse' }));
    for (let k = 0; k < 40 && !q('[data-testid="sculpt-empty-stroke"]'); k++) {
      const x = 42 + (k % 8) * 2.1, y = 42 + Math.floor(k / 8) * 3.3;
      act(() => {
        fire('pointerdown', x, y);
        fire('pointerup', x, y);
      });
    }
    expect(q('[data-testid="sculpt-empty-stroke"]')!.textContent).toContain('hiçbir noktaya değmedi');
  });

  it('computes mesh stats once per session, not after every stroke', async () => {
    const mesh = new Mesh(gridGeometry(32), new MeshBasicMaterial());
    const { canvas, onEdited } = mount({ model: modelOf(mesh) });
    const spy = vi.mocked(computeMeshStats);
    spy.mockClear();
    await startSculpt();
    const afterStart = spy.mock.calls.length;
    expect(afterStart).toBe(1);
    stroke(canvas, 40);
    await act(async () => new Promise((r) => setTimeout(r, 400)));
    stroke(canvas, 55);
    act(() => (q('[data-testid="sculpt-undo"]') as HTMLButtonElement).click());
    await act(async () => new Promise((r) => setTimeout(r, 400)));
    expect(onEdited).toHaveBeenCalledTimes(2);
    expect(onEdited.mock.calls[1][0]).toMatchObject({ vertices: 33 * 33, triangles: 32 * 32 * 2 });
    expect(spy.mock.calls.length).toBe(afterStart);
  });
});
