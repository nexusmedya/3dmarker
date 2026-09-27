// @vitest-environment jsdom
/**
 * useStudio in a DOM (jsdom): generation guards shared by the Generate button
 * and the Ctrl/Cmd+Enter shortcut, image-loading races, theme / title wiring.
 * The pipeline's decode and run steps are replaced by controllable promises.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceImage } from '../app/pipeline';

const mocks = vi.hoisted(() => ({ prepareSource: vi.fn(), runPipeline: vi.fn(), resolveMask: vi.fn(), quickMask: vi.fn(), renderSample: vi.fn() }));
vi.mock('../app/samples', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/samples')>();
  return { ...actual, renderSample: mocks.renderSample };
});
vi.mock('../app/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/pipeline')>();
  mocks.quickMask.mockImplementation(actual.quickMask);
  return { ...actual, prepareSource: mocks.prepareSource, runPipeline: mocks.runPipeline, resolveMask: mocks.resolveMask, quickMask: mocks.quickMask };
});

import { Object3D } from 'three';
import type { PipelineResult } from '../app/pipeline';
import { useStudio, type Studio } from './useStudio';
import { SAMPLES } from '../app/samples';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

const sourceOf = (name: string): SourceImage => ({
  name,
  file: new Blob(),
  image: { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(255) },
});

let root: Root | null = null;
let studio!: Studio;

function Probe() {
  studio = useStudio();
  return null;
}

async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Probe)));
}

const ctrlEnter = () => act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true })));

/** Load `name` through a decode that resolves at once. */
async function loadNow(name: string) {
  mocks.prepareSource.mockImplementationOnce(async () => sourceOf(name));
  await act(async () => studio.actions.loadFile(new Blob(), name));
}

beforeEach(() => {
  localStorage.clear();
  mocks.prepareSource.mockReset();
  mocks.runPipeline.mockReset();
  mocks.resolveMask.mockReset();
  mocks.renderSample.mockReset();
});

const STATS = { vertices: 3, triangles: 1, watertight: false };

/** A finished pipeline run (a plain object as the model). */
const pipelineResult = (): PipelineResult =>
  ({
    model: { kind: 'geometry', object: new Object3D(), stats: STATS, depth: null, mask: null, meshKey: null, remesh: null },
    inputMask: null,
  }) as unknown as PipelineResult;

/** Load an image and generate a model from it (silhouette driver: always available). */
async function withModel() {
  await mount();
  await act(async () => studio.actions.selectDriver('silhouette-extrude'));
  await loadNow('a.png');
  mocks.runPipeline.mockImplementation(async () => pipelineResult());
  await act(async () => studio.actions.generate());
  expect(studio.state.status).toBe('done');
  mocks.runPipeline.mockClear();
}

const keyOn = (target: EventTarget, init: KeyboardEventInit) =>
  act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })));

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

describe('useStudio generation guards', () => {
  it('Ctrl+Enter does not generate from the previous image while a new one decodes', async () => {
    await mount();
    await act(async () => studio.actions.selectDriver('silhouette-extrude'));
    await loadNow('old.png');
    expect(studio.state.source?.name).toBe('old.png');

    const decode = deferred<SourceImage>();
    mocks.prepareSource.mockImplementationOnce(() => decode.promise);
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = studio.actions.loadFile(new Blob(), 'new.png');
      // Same task as the paste: before React re-renders with loadingImage.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    });
    await ctrlEnter(); // and after the re-render
    expect(mocks.runPipeline).not.toHaveBeenCalled();
    expect(studio.state.status).toBe('idle');

    await act(async () => {
      decode.resolve(sourceOf('new.png'));
      await pending;
    });
    expect(studio.state.source?.name).toBe('new.png');

    // Once the new image is in, the shortcut generates from it.
    const run = deferred<never>();
    mocks.runPipeline.mockImplementationOnce(() => run.promise);
    await ctrlEnter();
    expect(mocks.runPipeline).toHaveBeenCalledOnce();
    expect(mocks.runPipeline.mock.calls[0][0].source.name).toBe('new.png');
    expect(studio.state.status).toBe('running');
    // Loading yet another image aborts that job.
    const signal: AbortSignal = mocks.runPipeline.mock.calls[0][0].signal;
    await loadNow('third.png');
    expect(signal.aborted).toBe(true);
    expect(studio.state.status).toBe('idle');
    await act(async () => run.reject(new DOMException('aborted', 'AbortError')));
    expect(studio.state.result).toBeNull();
  });

  it('Ctrl+Enter respects the driver availability like the Generate button', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await mount();
    await loadNow('a.png');
    await act(async () => studio.actions.selectDriver('tripo3d-cloud'));
    await vi.waitFor(() => expect(studio.availability).toMatchObject({ ok: false }));
    await ctrlEnter();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it('removing the image during a decode leaves no stuck loading state', async () => {
    await mount();
    await loadNow('a.png');
    const decode = deferred<SourceImage>();
    mocks.prepareSource.mockImplementationOnce(() => decode.promise);
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = studio.actions.loadFile(new Blob(), 'big.png');
    });
    expect(studio.state.loadingImage).toBe(true);
    await act(async () => studio.actions.clearImage());
    await act(async () => {
      decode.resolve(sourceOf('big.png'));
      await pending;
    });
    expect(studio.state.source).toBeNull();
    expect(studio.state.loadingImage).toBe(false);
  });
});

describe('useStudio: generating over an edited model', () => {
  it('Ctrl+Enter and Generate ask before replacing a sculpted model; confirming regenerates', async () => {
    await withModel();
    await act(async () => studio.actions.onSculptEdited(STATS, 1));
    expect(studio.state.sculpted).toBe(true);

    await ctrlEnter();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
    expect(studio.state.regenConfirm).toBe(true);
    // Escape closes the question (and cancels nothing).
    await keyOn(window, { key: 'Escape' });
    expect(studio.state.regenConfirm).toBe(false);

    await act(async () => studio.actions.generate()); // the Generate button
    expect(mocks.runPipeline).not.toHaveBeenCalled();
    expect(studio.state.regenConfirm).toBe(true);
    await act(async () => studio.actions.cancelRegenerate());
    expect(studio.state).toMatchObject({ regenConfirm: false, sculpted: true });

    await act(async () => studio.actions.generate());
    await act(async () => studio.actions.confirmRegenerate());
    expect(mocks.runPipeline).toHaveBeenCalledOnce();
    expect(studio.state).toMatchObject({ status: 'done', sculpted: false, regenConfirm: false });
  });

  it('a rigged model asks too; an unedited one regenerates at once', async () => {
    await withModel();
    await act(async () => studio.actions.onRigged(true));
    await ctrlEnter();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
    expect(studio.state.regenConfirm).toBe(true);
    await act(async () => studio.actions.onRigged(false));
    await act(async () => studio.actions.cancelRegenerate());
    await ctrlEnter();
    expect(mocks.runPipeline).toHaveBeenCalledOnce();
  });

  it('Ctrl+Enter does nothing in sculpt mode (Ctrl inverts the brush), in text fields or in dialogs', async () => {
    await withModel();
    await act(async () => studio.actions.onSculptActive(true));
    await ctrlEnter();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
    expect(studio.state).toMatchObject({ regenConfirm: false, status: 'done' });
    await act(async () => studio.actions.onSculptActive(false));

    const text = document.createElement('textarea');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const button = document.createElement('button');
    dialog.append(button);
    document.body.append(text, dialog);
    try {
      await keyOn(text, { key: 'Enter', ctrlKey: true });
      await keyOn(button, { key: 'Enter', metaKey: true });
      expect(mocks.runPipeline).not.toHaveBeenCalled();
      await keyOn(document.body, { key: 'Enter', ctrlKey: true });
      expect(mocks.runPipeline).toHaveBeenCalledOnce();
    } finally {
      text.remove();
      dialog.remove();
    }
  });
});

describe('useStudio view uploads', () => {
  it('no job starts while an uploaded view decodes', async () => {
    await mount();
    await act(async () => studio.actions.selectDriver('silhouette-extrude'));
    await loadNow('a.png');
    const decode = deferred<SourceImage>();
    mocks.prepareSource.mockImplementationOnce(() => decode.promise);
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = studio.actions.uploadView('back', new File(['b'], 'back.png'));
    });
    await ctrlEnter();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
    await act(async () => {
      decode.resolve(sourceOf('back.png'));
      await pending;
    });
    expect(studio.state.views.back?.name).toBe('back.png');
    mocks.runPipeline.mockImplementationOnce(() => new Promise(() => {}));
    await ctrlEnter();
    expect(mocks.runPipeline).toHaveBeenCalledOnce();
    expect(mocks.runPipeline.mock.calls[0][0].views.back).toBeDefined(); // the upload is part of the job
  });

  it('AI background removal of an upload blocked by a running job is queued, not dropped', async () => {
    await mount();
    await act(async () => studio.actions.selectDriver('silhouette-extrude'));
    await act(async () => studio.actions.setBgMode('ai'));
    await loadNow('a.png');
    const run = deferred<PipelineResult>();
    mocks.runPipeline.mockImplementationOnce(() => run.promise);
    let job!: Promise<unknown>;
    await act(async () => {
      job = studio.actions.generate();
    });
    expect(studio.state.status).toBe('running');

    mocks.quickMask.mockImplementationOnce(() => ({ mask: null, note: 'border-failed' })); // no usable border
    mocks.prepareSource.mockImplementationOnce(async () => sourceOf('back.jpg'));
    const cut = { width: 2, height: 2, data: new Uint8Array([1, 1, 1, 0]) };
    mocks.resolveMask.mockResolvedValue(cut);
    await act(async () => studio.actions.uploadView('back', new File(['b'], 'back.jpg')));
    expect(studio.state.views.back?.mask).toBeNull();
    expect(mocks.resolveMask).not.toHaveBeenCalled(); // the 3D job is in the way

    await act(async () => {
      run.resolve(pipelineResult());
      await job;
    });
    await vi.waitFor(() => expect(studio.state.views.back?.mask).toBe(cut));
    expect(mocks.resolveMask).toHaveBeenCalledOnce();
    expect(studio.state.aiJob).toBeNull();
  });
});

describe('useStudio model download failure', () => {
  it('flags an offline failure and "try the offline driver" switches and regenerates', async () => {
    await mount();
    await act(async () => studio.actions.selectDriver('silhouette-extrude'));
    await loadNow('a.png');
    mocks.runPipeline.mockImplementationOnce(async () => {
      throw new Error('Failed to fetch');
    });
    await act(async () => studio.actions.generate());
    expect(studio.state.status).toBe('error');
    expect(studio.state.errorOffline).toBe(true);

    mocks.runPipeline.mockImplementation(async () => pipelineResult());
    await act(async () => studio.actions.generateOffline());
    expect(studio.state.driverId).toBe('silhouette-inflate');
    expect(mocks.runPipeline).toHaveBeenCalledTimes(2);
    expect(studio.state.status).toBe('done');
  });

  it('other failures are not offline', async () => {
    await mount();
    await act(async () => studio.actions.selectDriver('silhouette-extrude'));
    await loadNow('a.png');
    mocks.runPipeline.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await act(async () => studio.actions.generate());
    expect(studio.state.errorOffline).toBe(false);
  });
});

describe('useStudio samples', () => {
  const sample = (id: string) => SAMPLES.find((x) => x.id === id)!;

  it('selects the sample\'s recommended driver', async () => {
    await mount();
    await act(async () => studio.actions.selectDriver('depth-anything-v2-small'));
    mocks.renderSample.mockImplementation(async () => new Blob());
    mocks.prepareSource.mockImplementation(async (_b: Blob, name: string) => sourceOf(name));
    await act(async () => studio.actions.loadSample(sample('mascot')));
    expect(studio.state.source?.name).toBe(sample('mascot').fileName);
    expect(studio.state.driverId).toBe('silhouette-inflate');
  });

  it('blocks Generate while the sample renders, and the last pick wins', async () => {
    await withModel();
    const slow = deferred<Blob>();
    mocks.renderSample.mockImplementationOnce(() => slow.promise).mockImplementationOnce(async () => new Blob());
    mocks.prepareSource.mockImplementation(async (_b: Blob, name: string) => sourceOf(name));
    let first!: Promise<unknown>;
    await act(async () => {
      first = studio.actions.loadSample(sample('landscape'));
    });
    expect(studio.state.loadingImage).toBe(true);
    await ctrlEnter();
    await act(async () => studio.actions.generate());
    expect(mocks.runPipeline).not.toHaveBeenCalled();

    await act(async () => studio.actions.loadSample(sample('mascot')));
    await act(async () => {
      slow.resolve(new Blob());
      await first;
    });
    expect(studio.state.source?.name).toBe(sample('mascot').fileName);
    expect(studio.state.loadingImage).toBe(false);
  });
});

describe('useStudio document wiring', () => {
  it('starts in the OS light theme without persisting it, and localises the tab title', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((q: string) => ({ matches: q === '(prefers-color-scheme: light)', media: q, addEventListener() {}, removeEventListener() {} })),
    );
    await mount();
    expect(studio.state.theme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(JSON.parse(localStorage.getItem('3dmarker:settings') ?? '{}').theme).toBeUndefined();

    await act(async () => studio.actions.setLang('tr'));
    expect(document.title).toBe('3D Marker — Görselden 3D');
    await act(async () => studio.actions.setLang('en'));
    expect(document.title).toBe('3D Marker — Image to 3D');
  });
});
