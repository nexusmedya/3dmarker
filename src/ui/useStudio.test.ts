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

const mocks = vi.hoisted(() => ({ prepareSource: vi.fn(), runPipeline: vi.fn() }));
vi.mock('../app/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/pipeline')>();
  return { ...actual, prepareSource: mocks.prepareSource, runPipeline: mocks.runPipeline };
});

import { useStudio, type Studio } from './useStudio';

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
});

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
