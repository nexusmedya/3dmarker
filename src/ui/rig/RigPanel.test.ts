// @vitest-environment jsdom
/**
 * RigPanel in a DOM (jsdom) with a fake viewer: auto-rig (human detection
 * mocked out → silhouette heuristic), play a clip through the frame loop,
 * export selection → model.animations, FBX import, remove rig, model switch.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnimationClip, BoxGeometry, NumberKeyframeTrack, PerspectiveCamera, Vector3 } from 'three';
import type { Mesh, Object3D } from 'three';

const analyzeHuman = vi.hoisted(() => vi.fn());
vi.mock('../../core/human/analyze', () => ({ analyzeHuman }));

import { buildGeometryModel, type BuiltModel } from '../../app/pipeline';
import type { ViewerCore } from '../../app/viewer';
import { asciiFbx, mixamoBones } from '../../rig/fbxFixture';
import { makeDog, makeMannequin } from '../../rig/testing';
import { LangProvider } from '../i18n';
import { detectForRig, RigPanel } from './RigPanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeCore() {
  const listeners = new Set<(dt: number) => boolean | void>();
  let object: Object3D | null = null;
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400, x: 0, y: 0, toJSON: () => ({}) });
  const core = {
    canvas,
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

function mount(model: BuiltModel, core: ReturnType<typeof fakeCore>, lang: 'en' | 'tr' = 'en') {
  const coreRef = { current: core as unknown as ViewerCore };
  core.setObject(model.object);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  return act(async () =>
    root!.render(
      createElement(LangProvider, { value: lang }, createElement(RigPanel, { coreRef, model, frontImage: image, frontMask: null, enabled: true, onModelChanged: vi.fn(), onActiveChange: vi.fn() })),
    ),
  );
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

  it('a detector that cannot load is reported as such (not "no person detected"), with a retry', async () => {
    const failed = {
      width: 8, height: 8, faces: [], hands: [], poses: [], isHuman: false,
      unavailableReason: 'Could not load the human detection (body) model: Failed to fetch',
      unavailableText: { tr: 'İnsan algılama (vücut) modeli yüklenemedi: Failed to fetch', en: 'Could not load the human detection (body) model: Failed to fetch' },
      failed: { pose: 'Failed to fetch', hands: 'Failed to fetch' },
    };
    analyzeHuman.mockResolvedValue(failed);
    const core = fakeCore();
    // A box: no T-pose, so the proportional fallback (the wording the bug was in).
    await mount(buildGeometryModel(new BoxGeometry(0.6, 2, 0.4), null), core, 'tr');
    await click('rig-auto');
    await waitFor(() => !!q('rig-status'));
    expect(q('rig-status')!.dataset.method).toBe('proportional');
    expect(q('rig-status')!.textContent).not.toContain('insan algılanmadı');
    const warn = q('rig-detect-warning');
    expect(warn).toBeTruthy();
    expect(warn!.textContent).toContain('İnsan algılama modeli yüklenemedi');
    expect(warn!.textContent).toContain('Failed to fetch');
    expect(q('rig-shape-warning')).toBeTruthy(); // a box is no human figure

    await click('rig-detect-retry');
    await waitFor(() => analyzeHuman.mock.calls.length === 2 && !(q('rig-detect-retry') as HTMLButtonElement).disabled);
    expect(q('rig-detect-warning')).toBeTruthy();

    // Detection that ran and found nobody keeps the "no person detected" wording.
    analyzeHuman.mockResolvedValue({ width: 8, height: 8, faces: [], hands: [], poses: [], isHuman: false });
    await click('rig-remove');
    await click('rig-auto');
    await waitFor(() => !!q('rig-status'));
    expect(q('rig-status')!.textContent).toContain('insan algılanmadı');
    expect(q('rig-detect-warning')).toBe(null);
  }, 30_000);

  it('joint edits can be undone, redone and reset to the automatic layout, keeping imported clips', async () => {
    analyzeHuman.mockResolvedValue({ width: 8, height: 8, faces: [], hands: [], poses: [], isHuman: false });
    const core = fakeCore();
    core.camera.position.set(0, 0, 4);
    core.camera.updateMatrixWorld(true);
    const model = newModel();
    await mount(model, core);
    await click('rig-auto');
    await waitFor(() => !!q('rig-status'));
    const file = new File([asciiFbx(mixamoBones(), { LeftArm: [[0, 0, 0, 0], [1, 0, 0, -90]] })], 'Wave Hello.fbx');
    const input = q('anim-import') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await waitFor(() => !!q('anim-import-wave-hello'));

    await click('rig-edit-joints');
    const elbow = () => {
      model.object.updateMatrixWorld(true);
      return model.object.getObjectByName('LeftForeArm')!.getWorldPosition(new Vector3());
    };
    const start = elbow();
    // Select the elbow by clicking its marker.
    const p = start.clone().project(core.camera);
    const [x, y] = [((p.x + 1) / 2) * 400, ((1 - p.y) / 2) * 400];
    for (const type of ['pointerdown', 'pointerup']) {
      const ev = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
      Object.defineProperty(ev, 'pointerId', { value: 1 });
      await act(async () => core.canvas.dispatchEvent(ev));
    }
    expect(q('rig-nudge-y-plus')).toBeTruthy();
    expect((q('rig-undo') as HTMLButtonElement).disabled).toBe(true);
    const idle = () => !q('rig-reweight') && !(q('rig-undo') as HTMLButtonElement).disabled;
    await click('rig-nudge-y-plus');
    await click('rig-nudge-y-plus');
    await waitFor(idle);
    const moved = elbow();
    expect(moved.y).toBeGreaterThan(start.y + 1e-3);

    await click('rig-undo');
    await waitFor(() => !q('rig-reweight') && !(q('rig-redo') as HTMLButtonElement).disabled);
    expect(elbow().distanceTo(start)).toBeLessThan(1e-6);
    expect((q('rig-undo') as HTMLButtonElement).disabled).toBe(true);

    // Ctrl+Shift+Z redoes.
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, shiftKey: true })));
    await waitFor(idle);
    expect(elbow().distanceTo(moved)).toBeLessThan(1e-6);

    await click('rig-reset-joints');
    await waitFor(() => !q('rig-reweight'));
    expect(elbow().distanceTo(start)).toBeLessThan(1e-6);
    expect(q('anim-import-wave-hello')).toBeTruthy(); // imported clips survive (retargeted)
  }, 60_000);
});

describe('RigPanel: animal templates and the rig editor', () => {
  const setValue = async (el: HTMLInputElement | HTMLSelectElement, value: string, event: 'input' | 'change' = 'change') => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event(event, { bubbles: true }));
    });
  };
  const key = (k: string, mods: Partial<KeyboardEventInit> = {}) => act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, ...mods })));

  it('auto-suggests a quadruped for a dog, plays animal clips, edits bones with undo / redo, keys a pose and saves a custom clip', async () => {
    analyzeHuman.mockResolvedValue({ width: 8, height: 8, faces: [], hands: [], poses: [], isHuman: false });
    const core = fakeCore();
    core.camera.position.set(0, 0, 5);
    core.camera.updateMatrixWorld(true);
    const model = buildGeometryModel(makeDog().mesh.geometry, null);
    await mount(model, core);
    expect((q('rig-template') as HTMLSelectElement).value).toBe('auto');
    await click('rig-auto');
    await waitFor(() => !!q('rig-status'));
    expect(q('rig-status')!.dataset.template).toBe('quadruped');
    expect(q('rig-status')!.dataset.method).toBe('side');
    expect(q('rig-template-badge')!.textContent).toContain('Quadruped');
    expect(q('anim-quad-walk')).toBeTruthy();
    expect(q('anim-walk')).toBe(null); // no humanoid clips
    expect((q('anim-import') as HTMLInputElement).disabled).toBe(true);
    expect(q('rig-edit-joints')).toBe(null); // the humanoid joint editor is for humanoids
    await click('anim-quad-trot');
    expect(q('anim-now')!.textContent).toContain('Trot');

    // Open the rig editor: playback stops.
    await click('rig-editor-toggle');
    expect(q('rig-editor-panel')).toBeTruthy();
    expect(q('anim-now')!.textContent).toContain('Pick an animation');
    const bones = () => Number(q('rig-editor-panel')!.dataset.bones);
    const n0 = bones();
    expect(q('rig-ed-bone-LeftFrontFoot')).toBeTruthy();

    // Add a child to the head, undo (Ctrl+Z), redo (Ctrl+Y).
    await click('rig-ed-bone-Head');
    expect((q('rig-ed-name') as HTMLInputElement).value).toBe('Head');
    await click('rig-ed-add');
    await waitFor(() => bones() === n0 + 1);
    expect(q('rig-status')!.dataset.bones).toBe(String(n0 + 1));
    await key('z', { ctrlKey: true });
    await waitFor(() => bones() === n0);
    await key('y', { ctrlKey: true });
    await waitFor(() => bones() === n0 + 1);
    // Delete a leg's toe with symmetry: both toes go.
    await click('rig-ed-bone-LeftHindToe');
    await click('rig-ed-delete');
    await waitFor(() => bones() === n0 - 1);
    expect(q('rig-ed-bone-RightHindToe')).toBe(null);
    // Rename (sanitised) through the properties.
    await click('rig-ed-bone-Tail');
    const name = q('rig-ed-name') as HTMLInputElement;
    await setValue(name, 'Tail Base', 'input');
    await act(async () => name.dispatchEvent(new FocusEvent('blur', { bubbles: false })));
    await act(async () => name.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    await waitFor(() => !!q('rig-ed-bone-Tail_Base'));
    expect(model.object.getObjectByName('Tail_Base')).toBeTruthy();

    // Pose mode (Tab), rotate the head, key everything at 0 and 1 s, save the clip.
    await key('Tab');
    expect(q('rig-editor-panel')!.dataset.mode).toBe('pose');
    await click('rig-ed-key-all');
    expect(host.querySelectorAll('[data-testid="rig-ed-keys-all-key"]')).toHaveLength(1);
    await setValue(q('rig-ed-time') as HTMLInputElement, '1', 'input');
    model.object.getObjectByName('Head')!.rotation.x = 0.6;
    await key('i'); // insert key: nothing selected → all bones
    expect(host.querySelectorAll('[data-testid="rig-ed-keys-all-key"]')).toHaveLength(2);
    await click('rig-ed-save');
    await waitFor(() => !!q('anim-custom-custom-1'));
    expect(model.animations!.some((c) => c.name === 'Custom 1')).toBe(true);
    // Undo the second key (history covers keyframes too).
    await key('z', { ctrlKey: true });
    await waitFor(() => host.querySelectorAll('[data-testid="rig-ed-keys-all-key"]').length === 1);

    // Weight tools: normalise is undoable.
    await click('rig-ed-mode-paint');
    expect(q('rig-editor-panel')!.dataset.mode).toBe('paint');
    await click('rig-ed-bone-Chest');
    await click('rig-ed-normalize');

    // Closing the editor keeps the edited skeleton; the saved clip plays.
    await click('rig-editor-toggle');
    expect(q('rig-editor-panel')).toBe(null);
    await click('anim-custom-custom-1');
    expect(q('anim-now')!.textContent).toContain('Custom 1');
  }, 60_000);

  it('rigs with an explicitly chosen template (snake chain / custom single bone) without person detection', async () => {
    const core = fakeCore();
    await mount(buildGeometryModel(makeDog().mesh.geometry, null), core);
    await setValue(q('rig-template') as HTMLSelectElement, 'custom');
    await click('rig-auto');
    await waitFor(() => !!q('rig-status'));
    expect(analyzeHuman).not.toHaveBeenCalled();
    expect(q('rig-status')!.dataset.template).toBe('custom');
    expect(q('rig-status')!.dataset.bones).toBe('1');
    await click('rig-remove');
    await setValue(q('rig-template') as HTMLSelectElement, 'snake');
    await click('rig-auto');
    await waitFor(() => !!q('rig-status'));
    expect(q('rig-status')!.dataset.template).toBe('snake');
    expect(q('anim-snake-slither')).toBeTruthy();
  }, 60_000);
});

describe('detectForRig', () => {
  afterEach(() => vi.useRealTimers());
  const hang = (_img: unknown, o: { signal: AbortSignal }) =>
    new Promise((_r, reject) => o.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));

  it('gives up on a stalled detector after the budget and reports it unavailable', async () => {
    vi.useFakeTimers();
    analyzeHuman.mockImplementation(hang);
    const res = detectForRig(image, new AbortController().signal, undefined, 10_000);
    await vi.advanceTimersByTimeAsync(9_000);
    let settled = false;
    void res.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    const r = await res;
    expect(r.detection).toBe('unavailable');
    expect(r.pose).toBe(null);
    expect(r.detail?.en).toContain('stopped responding');
  });

  it('progress (a slow but live download) re-arms the budget; cancelling the rig still aborts', async () => {
    vi.useFakeTimers();
    let progress: ((p: unknown) => void) | undefined;
    analyzeHuman.mockImplementation((img: unknown, o: { signal: AbortSignal; onProgress?: (p: unknown) => void }) => {
      progress = o.onProgress;
      return hang(img, o);
    });
    const ac = new AbortController();
    const res = detectForRig(image, ac.signal, undefined, 10_000);
    const outcome = res.then(() => 'resolved', (e: unknown) => (e as Error).name);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(8_000);
      progress?.({ label: { tr: '', en: '' }, ratio: i / 3 });
    }
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toBe('AbortError');
  });
});
