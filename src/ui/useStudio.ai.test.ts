// @vitest-environment jsdom
/**
 * useStudio's AI / multi-view / edit wiring in a DOM (jsdom): provider
 * settings persistence and publication, the server probe, AI preparation
 * with accept / revert, uploading and generating views, passing views to
 * the drivers, the Generate guard for multi-view drivers, human analysis on
 * the prep step, and the sculpt / rig / depth-edit hooks of the model.
 * Decoding, the pipeline run, the AI calls and MediaPipe are mocked.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BoxGeometry, Mesh } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DepthMap } from '../core/types';
import type { HumanAnalysis } from '../core/human/types';
import type { AiSettings } from '../ai/types';
import type { BuiltModel, SourceImage } from '../app/pipeline';

const mocks = vi.hoisted(() => ({
  prepareSource: vi.fn(),
  runPipeline: vi.fn(),
  prepareFrontImage: vi.fn(),
  generateViewImage: vi.fn(),
  analyzeHuman: vi.fn(),
}));
vi.mock('../app/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/pipeline')>();
  return { ...actual, prepareSource: mocks.prepareSource, runPipeline: mocks.runPipeline };
});
vi.mock('../ai/generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/generate')>();
  return { ...actual, prepareFrontImage: mocks.prepareFrontImage, generateViewImage: mocks.generateViewImage };
});
vi.mock('../core/human/analyze', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/human/analyze')>();
  return { ...actual, analyzeHuman: mocks.analyzeHuman };
});

import { buildDepthModel } from '../app/pipeline';
import { createProviderConfig, currentAiSettings } from '../ai/settings';
import { STYLES } from '../ai/styles';
import { REMESH_DEBOUNCE_MS, aiFileName, meshSignature, useStudio, type Studio } from './useStudio';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sourceOf = (name: string): SourceImage => ({
  name,
  file: new Blob([name]),
  image: { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(255) },
});

const human = (isHuman: boolean): HumanAnalysis => ({ width: 2, height: 2, faces: [], hands: [], poses: [], isHuman });

function withKey(rememberKeys = false): AiSettings {
  return { providers: [createProviderConfig('openai', { id: 'mine', label: 'Mine', apiKey: 'sk-test-key-42' })], defaults: {}, rememberKeys };
}

function dome(n: number): DepthMap {
  const data = new Float32Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / n - 0.5, dy = (y + 0.5) / n - 0.5;
      data[y * n + x] = Math.max(0, 1 - 4 * (dx * dx + dy * dy));
    }
  return { width: n, height: n, data };
}

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

/** Decodes by name: every prepareSource call yields a small opaque image named as asked. */
function decodeByName() {
  mocks.prepareSource.mockImplementation(async (_f: Blob, name: string) => sourceOf(name));
}

async function load(name: string) {
  await act(async () => studio.actions.loadFile(new Blob([name]), name));
}

const ctrlEnter = () => act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true })));
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  for (const m of Object.values(mocks)) m.mockReset();
  decodeByName();
  mocks.analyzeHuman.mockResolvedValue(human(false));
  // No server (static hosting) unless a test says otherwise.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html>', { status: 404, headers: { 'content-type': 'text/html' } })));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

describe('AI settings', () => {
  it('keys go to sessionStorage only (not remembered) and drivers see the settings', async () => {
    await mount();
    await vi.waitFor(() => expect(studio.state.serverChecked).toBe(true));
    expect(studio.state.serverAvailable).toBe(false);
    await act(async () => studio.actions.setAiSettings(withKey(false)));
    const local = JSON.stringify(Object.entries(localStorage));
    expect(local).not.toContain('sk-test-key-42');
    // The provider itself is remembered (without its key).
    expect(JSON.parse(localStorage.getItem('3dmarker:ai-settings') ?? '{}').providers).toEqual([expect.objectContaining({ id: 'mine' })]);
    expect(JSON.stringify(Object.entries(sessionStorage))).toContain('sk-test-key-42');
    expect(currentAiSettings().settings).toBe(studio.state.aiSettings);
    expect(studio.editProvider?.id).toBe('mine');
    expect(studio.editProviders.map((p) => p.id)).toEqual(['mine']);

    await act(async () => studio.actions.setAiSettings(withKey(true)));
    expect(JSON.stringify(Object.entries(localStorage))).toContain('sk-test-key-42');
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain('sk-test-key-42');

    await act(async () => studio.actions.openAiSettings());
    expect(studio.state.aiSettingsOpen).toBe(true);
    await act(async () => studio.actions.closeAiSettings());
    expect(studio.state.aiSettingsOpen).toBe(false);
  });

  it('merges the server’s managed providers when there is a server', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ providers: [{ id: 'server-gemini', kind: 'gemini', label: 'Gemini (server)' }], proxyKinds: ['gemini'], byok: true }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    await vi.waitFor(() => expect(studio.state.serverAvailable).toBe(true));
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('/api/ai/providers');
    expect(studio.state.aiSettings.providers).toEqual([expect.objectContaining({ id: 'server-gemini', managed: true, apiKey: '' })]);
    expect(currentAiSettings()).toMatchObject({ serverAvailable: true });
    expect(studio.editProvider?.id).toBe('server-gemini');
    // Managed entries are never written to storage (only a default may name one).
    expect(JSON.parse(localStorage.getItem('3dmarker:ai-settings') ?? '{}').providers).toEqual([]);
  });
});

describe('AI preparation', () => {
  it('prepares with the provider, then accept makes it the source and revert restores the original', async () => {
    mocks.analyzeHuman.mockResolvedValue(human(true));
    mocks.prepareFrontImage.mockResolvedValue(new Blob(['prepared'], { type: 'image/png' }));
    await mount();
    await act(async () => {
      studio.actions.setAiSettings(withKey());
      studio.actions.setPrep({ styleId: STYLES[0].id, tPose: true });
      studio.actions.selectDriver('silhouette-inflate');
    });
    await load('cat.png');
    const original = studio.state.source!;
    await act(async () => studio.actions.runPrep());
    expect(mocks.prepareFrontImage).toHaveBeenCalledOnce();
    const [file, prep, cfg, ctx] = mocks.prepareFrontImage.mock.calls[0];
    expect(file).toBe(original.file);
    expect(prep).toMatchObject({ styleId: STYLES[0].id, tPose: true });
    expect(cfg.id).toBe('mine');
    expect(ctx.isHuman).toBe(true); // subject 'auto' → detection
    expect(ctx.bgProvider === null || ctx.bgProvider.id === 'mine').toBe(true); // a provider offering it, else the local model
    expect(mocks.analyzeHuman).toHaveBeenCalledWith(original.image, expect.anything());
    expect(studio.state.aiJob).toBeNull();
    expect(studio.state.prepared?.name).toBe('cat-ai.png');
    expect(studio.state.source).toBe(original);

    await act(async () => studio.actions.acceptPrepared());
    expect(studio.state.source?.name).toBe('cat-ai.png');
    expect(studio.state.original).toBe(original);

    // Generate uses the prepared front.
    mocks.runPipeline.mockImplementationOnce(() => new Promise(() => {}));
    await ctrlEnter();
    expect(mocks.runPipeline.mock.calls[0][0].source.name).toBe('cat-ai.png');
    await act(async () => studio.actions.cancel());

    await act(async () => studio.actions.revertOriginal());
    expect(studio.state.source).toBe(original);
    expect(studio.state.original).toBeNull();
  });

  it('reports a missing provider or nothing to do instead of calling the API; errors land in the prep panel', async () => {
    await mount();
    await load('a.png');
    await act(async () => studio.actions.runPrep());
    expect(studio.state.prepError?.en).toMatch(/No AI provider/);
    await act(async () => studio.actions.setAiSettings(withKey()));
    await act(async () => studio.actions.runPrep());
    expect(studio.state.prepError?.en).toMatch(/Pick a style/);
    expect(mocks.prepareFrontImage).not.toHaveBeenCalled();

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.prepareFrontImage.mockRejectedValueOnce(Object.assign(new Error('x'), { i18n: { tr: 'kota doldu', en: 'quota exceeded' } }));
    await act(async () => studio.actions.setPrep({ completeBody: true, subject: 'object' }));
    await act(async () => studio.actions.runPrep());
    expect(mocks.analyzeHuman).not.toHaveBeenCalled(); // an explicit subject needs no detection
    expect(studio.state.prepError).toEqual({ tr: 'kota doldu', en: 'quota exceeded' });
    expect(studio.state.aiJob).toBeNull();
    logged.mockRestore();
  });

  it('Escape cancels a running AI job', async () => {
    let signal!: AbortSignal;
    mocks.prepareFrontImage.mockImplementation((_f, _o, _c, ctx: { signal: AbortSignal }) => {
      signal = ctx.signal;
      return new Promise(() => {});
    });
    await mount();
    await act(async () => {
      studio.actions.setAiSettings(withKey());
      studio.actions.setPrep({ styleId: STYLES[1].id, subject: 'object' });
    });
    await load('a.png');
    await act(async () => void studio.actions.runPrep());
    expect(studio.state.aiJob?.kind).toBe('prep');
    // Generate waits for the AI job.
    await ctrlEnter();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
    await act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(signal.aborted).toBe(true);
    expect(studio.state.aiJob).toBeNull();
  });
});

describe('views', () => {
  it('uploads, generates the missing ones in order with growing references, and hands them to the driver', async () => {
    mocks.generateViewImage.mockImplementation(async (view: string) => new Blob([`ai-${view}`], { type: 'image/png' }));
    await mount();
    await act(async () => {
      studio.actions.setAiSettings(withKey());
      studio.actions.setPrep({ subject: 'object' });
      studio.actions.selectDriver('multiview-fusion');
    });
    await load('toy.png');
    const front = studio.state.source!;

    // The multi-view driver needs at least one extra view.
    await ctrlEnter();
    expect(mocks.runPipeline).not.toHaveBeenCalled();

    const back = new File(['back'], 'back.png', { type: 'image/png' });
    await act(async () => studio.actions.uploadView('back', back));
    expect(studio.state.views.back).toMatchObject({ origin: 'upload', name: 'back.png', file: back });

    await act(async () => studio.actions.generateMissing());
    expect(mocks.generateViewImage.mock.calls.map((c) => c[0])).toEqual(['left', 'right', 'top', 'bottom']);
    const [, refsLeft] = mocks.generateViewImage.mock.calls[0];
    expect(refsLeft.front).toBe(front.file);
    expect(Object.keys(refsLeft.others)).toEqual(['back']);
    const [, refsBottom] = mocks.generateViewImage.mock.calls[3];
    expect(Object.keys(refsBottom.others).sort()).toEqual(['back', 'left', 'right', 'top']);
    expect(studio.state.views.bottom).toMatchObject({ origin: 'ai', name: aiFileName('toy.png', 'bottom') });
    expect(studio.state.aiJob).toBeNull();

    // Regenerating a view does not use its old image as a reference.
    await act(async () => studio.actions.generateView('left'));
    expect(Object.keys(mocks.generateViewImage.mock.calls[4][1].others).sort()).toEqual(['back', 'bottom', 'right', 'top']);

    mocks.runPipeline.mockImplementationOnce(() => new Promise(() => {}));
    await ctrlEnter();
    expect(mocks.runPipeline).toHaveBeenCalledOnce();
    const views = mocks.runPipeline.mock.calls[0][0].views;
    expect(Object.keys(views).sort()).toEqual(['back', 'bottom', 'left', 'right', 'top']);
    expect(views.back).toMatchObject({ id: 'back', file: back, origin: 'upload' });
    await act(async () => studio.actions.cancel());

    await act(async () => studio.actions.clearView('top'));
    expect(studio.state.views.top).toBeUndefined();
    // A brand-new image starts over.
    await load('other.png');
    expect(studio.state.views).toEqual({});
  });

  it('a view upload that finishes after a new front image is dropped', async () => {
    await mount();
    await load('a.png');
    let finish!: (s: SourceImage) => void;
    mocks.prepareSource.mockImplementationOnce(() => new Promise<SourceImage>((r) => (finish = r)));
    let pending!: Promise<void>;
    await act(async () => {
      pending = studio.actions.uploadView('left', new File(['l'], 'l.png'));
    });
    await load('b.png');
    await act(async () => {
      finish(sourceOf('l.png'));
      await pending;
    });
    expect(studio.state.views).toEqual({});
  });
});

describe('human analysis', () => {
  it('runs when the prep step opens with a usable provider (once per image) and follows the front image', async () => {
    mocks.analyzeHuman.mockResolvedValue(human(true));
    await mount();
    await load('p.png');
    expect(mocks.analyzeHuman).not.toHaveBeenCalled();
    await act(async () => studio.actions.setStep('prep'));
    // No provider could run the preparation yet: no model download for the detection either.
    await wait(20);
    expect(mocks.analyzeHuman).not.toHaveBeenCalled();
    await act(async () => studio.actions.setAiSettings(withKey(false)));
    await vi.waitFor(() => expect(studio.state.human?.analysis).toMatchObject({ isHuman: true }));
    expect(studio.state.human?.image).toBe(studio.state.source?.image);
    await act(async () => studio.actions.setStep('views'));
    await act(async () => studio.actions.setStep('prep'));
    expect(mocks.analyzeHuman).toHaveBeenCalledOnce();
    await load('q.png');
    await vi.waitFor(() => expect(mocks.analyzeHuman).toHaveBeenCalledTimes(2));
    expect(mocks.analyzeHuman.mock.calls[1][0]).toBe(studio.state.source?.image);
  });
});

describe('model edits', () => {
  async function generateDepthModel(): Promise<BuiltModel> {
    const model = buildDepthModel(dome(12), null, null, { resolution: 12 });
    mocks.runPipeline.mockResolvedValueOnce({ model, inputMask: null });
    await act(async () => studio.actions.selectDriver('silhouette-inflate'));
    await load('m.png');
    await ctrlEnter();
    await vi.waitFor(() => expect(studio.model).toBe(model));
    return model;
  }

  it('sculpt edits pause live re-meshing; discarding them rebuilds from the depth', async () => {
    await mount();
    const model = await generateDepthModel();
    const remesh = vi.spyOn(model, 'remesh' as never) as unknown as ReturnType<typeof vi.fn>;
    const epoch = studio.sculptEpoch;
    await act(async () => studio.actions.onSculptEdited({ vertices: 1, triangles: 1, watertight: false }));
    expect(studio.state.sculpted).toBe(true);
    expect(studio.state.result?.stats.triangles).toBe(1);
    await act(async () => studio.actions.setMeshParam('resolution', 8));
    await wait(REMESH_DEBOUNCE_MS + 60);
    expect(remesh).not.toHaveBeenCalled();

    await act(async () => studio.actions.discardSculpt());
    expect(remesh).toHaveBeenCalledOnce();
    expect(studio.state.sculpted).toBe(false);
    expect(studio.sculptEpoch).toBe(epoch + 1);
    expect(studio.state.result?.stats.triangles).toBeGreaterThan(1);
  });

  it('rigging pauses re-meshing; rig changes refresh the stats only when the meshes change', async () => {
    await mount();
    const model = await generateDepthModel();
    await act(async () => studio.actions.onRigged(true));
    expect(studio.state.rigged).toBe(true);
    const version = studio.modelVersion;
    await act(async () => studio.actions.onRigChanged());
    expect(studio.modelVersion).toBe(version + 1);
    const tris = studio.state.result!.stats.triangles;
    (model.object as Mesh).add(new Mesh(new BoxGeometry(1, 1, 1)));
    const sig = meshSignature(model.object);
    await act(async () => studio.actions.onRigChanged());
    expect(studio.state.result!.stats.triangles).toBe(tris + 12);
    expect(meshSignature(model.object)).toBe(sig);
    await act(async () => studio.actions.onRigged(false));
    expect(studio.state.rigged).toBe(false);
  });

  it('a depth edit builds a new re-meshable model from the same image', async () => {
    await mount();
    const model = await generateDepthModel();
    await act(async () => studio.actions.openDepthEditor());
    expect(studio.state.depthEditorOpen).toBe(true);
    const edited = dome(12);
    edited.data[6 * 12 + 6] = 0.2;
    await act(async () => studio.actions.applyDepthEdit(edited));
    expect(studio.model).not.toBe(model);
    expect(studio.model?.depth).toBe(edited);
    expect(studio.model?.remesh).toBeTypeOf('function');
    expect(studio.state.depthEditorOpen).toBe(false);
    expect(studio.state.result?.depthPreview).not.toBeNull();
    expect(studio.modelSource?.source.name).toBe('m.png');
  });
});
