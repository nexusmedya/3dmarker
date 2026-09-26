// @vitest-environment jsdom
/**
 * RigPanel in a DOM (jsdom) with a fake viewer: auto-rig (human detection
 * mocked out → silhouette heuristic), play a clip through the frame loop,
 * export selection → model.animations, FBX import, remove rig, model switch.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnimationClip, NumberKeyframeTrack, PerspectiveCamera } from 'three';
import type { Mesh, Object3D } from 'three';

const analyzeHuman = vi.hoisted(() => vi.fn());
vi.mock('../../core/human/analyze', () => ({ analyzeHuman }));

import { buildGeometryModel, type BuiltModel } from '../../app/pipeline';
import type { ViewerCore } from '../../app/viewer';
import { asciiFbx, mixamoBones } from '../../rig/fbxFixture';
import { makeMannequin } from '../../rig/testing';
import { LangProvider } from '../i18n';
import { RigPanel } from './RigPanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeCore() {
  const listeners = new Set<(dt: number) => boolean | void>();
  let object: Object3D | null = null;
  const core = {
    canvas: document.createElement('canvas'),
    camera: new PerspectiveCamera(),
    setObject: (o: Object3D | null) => (object = o),
    getObject: () => object,
    addOverlay: vi.fn(),
    removeOverlay: vi.fn(),
    invalidate: vi.fn(),
    refresh: vi.fn(),
    rescanObject: vi.fn(),
    getExportObject: () => object?.clone(true) ?? null,
    addFrameListener(fn: (dt: number) => boolean | void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setOrbitEnabled: vi.fn(),
    tick(dt: number) {
      let animating = false;
      for (const fn of listeners) if (fn(dt) === true) animating = true;
      return animating;
    },
  };
  return core;
}

const newModel = (): BuiltModel => buildGeometryModel(makeMannequin(1).mesh.geometry, null);
const image = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) };

let root: Root | null = null;
let host: HTMLElement;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  analyzeHuman.mockReset();
});

async function waitFor(pred: () => boolean, ms = 10_000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await act(async () => new Promise((r) => setTimeout(r, 20)));
  }
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function click(id: string) {
  const el = q(id);
  if (!el) throw new Error(`missing ${id}`);
  await act(async () => el.click());
}

describe('RigPanel', () => {
  it('auto-rigs, plays, selects clips for export, imports and removes the rig', async () => {
    analyzeHuman.mockResolvedValue({ width: 8, height: 8, faces: [], hands: [], poses: [], isHuman: false });
    const core = fakeCore();
    const coreRef = { current: core as unknown as ViewerCore };
    let model = newModel();
    core.setObject(model.object);
    const onModelChanged = vi.fn();
    const onActiveChange = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const render = () =>
      act(async () =>
        root!.render(
          createElement(LangProvider, { value: 'en' }, createElement(RigPanel, { coreRef, model, frontImage: image, frontMask: null, enabled: true, onModelChanged, onActiveChange })),
        ),
      );
    await render();
    expect(q('rig-auto')!.textContent).toContain('Auto-rig');

    await click('rig-auto');
    await waitFor(() => !!q('rig-status'));
    expect(analyzeHuman).toHaveBeenCalledTimes(1);
    expect(q('rig-status')!.dataset.bones).toBe('23');
    expect(q('rig-status')!.dataset.method).toBe('silhouette');
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
    expect(onModelChanged).toHaveBeenCalled();
    expect(core.rescanObject).toHaveBeenCalled();
    const total = model.animations!.length;
    expect(total).toBeGreaterThanOrEqual(36);
    expect(q('anim-walk')).toBeTruthy();

    // Play through the viewer's frame loop.
    await click('anim-walk');
    expect(q('anim-now')!.textContent).toContain('Walk');
    let animating = false;
    await act(async () => {
      animating = core.tick(0.2) === true;
    });
    expect(animating).toBe(true);
    await click('anim-play'); // pause
    await act(async () => {
      animating = core.tick(0.2) === true;
    });
    expect(animating).toBe(false);
    await click('anim-stop');
    expect(q('anim-now')!.textContent).toContain('Pick an animation');

    // Search filter.
    const search = q('anim-search') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(search, 'zombie');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(q('anim-zombie-walk')).toBeTruthy();
    expect(q('anim-walk')).toBe(null);

    // Export selection.
    await click('anim-export-zombie-walk');
    expect(model.animations!.length).toBe(total - 1);
    await click('anim-export-none');
    expect(model.animations!.length).toBe(0);
    await click('anim-export-all');
    expect(model.animations!.length).toBe(total);

    // Import an FBX (Mixamo naming).
    const file = new File([asciiFbx(mixamoBones(), { LeftArm: [[0, 0, 0, 0], [1, 0, 0, -90]] })], 'Wave Hello.fbx');
    const input = q('anim-import') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await waitFor(() => model.animations!.length === total + 1);
    expect(q('anim-now')!.textContent).toContain('Wave Hello');
    expect(model.animations!.some((c) => c.name === 'Wave Hello')).toBe(true);

    // Remove the rig: the original surface comes back.
    await click('rig-remove');
    expect(q('rig-auto')).toBeTruthy();
    expect(model.animations).toBeUndefined();
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
    expect((model.object as Mesh).geometry.getAttribute('position').count).toBeGreaterThan(0);
    expect(model.object.children).toHaveLength(0);

    // Rig again, then switch models: the rig is torn down (restored while still on screen).
    await click('rig-auto');
    await waitFor(() => !!q('rig-status'));
    const old = model;
    model = newModel();
    await render();
    expect(old.object.children).toHaveLength(0);
    expect(old.animations).toBeUndefined();
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
    expect(q('rig-auto')).toBeTruthy();
  }, 30_000);

  it('plays one-shot clips once (holding the last frame) even with Loop on, and keeps the model\'s own clips across rig / unrig', async () => {
    analyzeHuman.mockResolvedValue({ width: 8, height: 8, faces: [], hands: [], poses: [], isHuman: false });
    const core = fakeCore();
    const coreRef = { current: core as unknown as ViewerCore };
    const model = newModel();
    const spin = new AnimationClip('spin', 1, [new NumberKeyframeTrack('.rotation[y]', [0, 1], [0, Math.PI])]);
    model.animations = [spin];
    core.setObject(model.object);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        createElement(LangProvider, { value: 'en' }, createElement(RigPanel, { coreRef, model, frontImage: null, frontMask: null, enabled: true, onModelChanged: vi.fn(), onActiveChange: vi.fn() })),
      ),
    );
    await click('rig-auto');
    await waitFor(() => !!q('rig-status'));
    expect(model.animations).toContain(spin); // still exported while rigged

    expect((q('anim-loop') as HTMLInputElement | null)?.checked ?? true).toBe(true);
    await click('anim-fall-die');
    let animating = true;
    for (let i = 0; i < 40 && animating; i++) {
      await act(async () => {
        animating = core.tick(0.1) === true;
      });
    }
    expect(animating).toBe(false); // finished instead of looping back to standing

    await click('rig-remove');
    expect(model.animations).toEqual([spin]);
  }, 30_000);

  it('explains why it is unavailable without a model and for skinned GLBs', async () => {
    const core = fakeCore();
    const coreRef = { current: core as unknown as ViewerCore };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        createElement(LangProvider, { value: 'tr' }, createElement(RigPanel, { coreRef, model: null, frontImage: null, frontMask: null, enabled: true, onModelChanged: vi.fn(), onActiveChange: vi.fn() })),
      ),
    );
    expect(host.textContent).toContain('Önce bir 3B model oluşturun');
    expect(q('rig-auto')).toBe(null);
  });
});
