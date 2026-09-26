// @vitest-environment jsdom
/**
 * The studio panel with its real step components (AI prep, views, sculpt,
 * rig…) in jsdom: step switching, the Generate guard for multi-view drivers
 * with its "Go to Views" action, the AI readiness reason, and the
 * human-detail note of step 4. Decoding and MediaPipe are mocked.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceImage } from '../app/pipeline';

const mocks = vi.hoisted(() => ({ prepareSource: vi.fn(), analyzeHuman: vi.fn() }));
vi.mock('../app/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/pipeline')>();
  return { ...actual, prepareSource: mocks.prepareSource };
});
vi.mock('../core/human/analyze', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/human/analyze')>();
  return { ...actual, analyzeHuman: mocks.analyzeHuman };
});

import { createProviderConfig } from '../ai/settings';
import { LangProvider } from './i18n';
import { ControlPanel } from './ControlPanel';
import { useStudio, type Studio } from './useStudio';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sourceOf = (name: string): SourceImage => ({
  name,
  file: new Blob([name]),
  image: { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(255) },
});

let root: Root | null = null;
let host: HTMLDivElement;
let studio!: Studio;

function Shell() {
  studio = useStudio();
  return createElement(LangProvider, { value: 'en' }, createElement(ControlPanel, { studio }));
}

const q = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector(`[data-testid="${id}"]`) as T | null;
const panel = (id: string) => host.querySelector(`#step-panel-${id}`) as HTMLElement;

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  mocks.prepareSource.mockReset().mockImplementation(async (_f: Blob, name: string) => sourceOf(name));
  mocks.analyzeHuman.mockReset().mockResolvedValue({ width: 2, height: 2, faces: [], hands: [], poses: [], isHuman: false });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } })));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Shell)));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ControlPanel', () => {
  it('switches steps; every step’s component is there', async () => {
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(6);
    expect(panel('image').hidden).toBe(false);
    expect(q('sample-0')).not.toBeNull();
    expect(q('generate-driver')?.textContent).toContain('Driver:');

    await act(async () => q('step-prep')!.click());
    expect(panel('image').hidden).toBe(true);
    expect(panel('prep').hidden).toBe(false);
    expect(q('ai-prep')).not.toBeNull();
    expect(q('ai-prep-empty')).not.toBeNull(); // no provider yet

    await act(async () => q('step-edit')!.click());
    expect(q('sculpt-panel')).not.toBeNull();
    expect(q<HTMLButtonElement>('depth-edit-open')!.disabled).toBe(true); // no depth model yet

    await act(async () => q('step-rig')!.click());
    expect(q('rig-panel')).not.toBeNull();
    // Leaving the edit step unmounts the sculpt panel (ends sculpt mode); the rig stays mounted.
    await act(async () => q('step-image')!.click());
    expect(q('sculpt-panel')).toBeNull();
    expect(q('rig-panel')).not.toBeNull();
    expect(studio.state.step).toBe('image');
  });

  it('multi-view drivers: Generate is blocked with a reason and a link to the views step', async () => {
    await act(async () => studio.actions.loadFile(new Blob(['a']), 'a.png'));
    await act(async () => studio.actions.selectDriver('multiview-fusion'));
    expect(q<HTMLButtonElement>('generate')!.disabled).toBe(true);
    expect(q('generate-blocked')!.textContent).toContain('at least one more view');
    await act(async () => q('generate-blocked-action')!.click());
    expect(studio.state.step).toBe('views');
    expect(q('generate-blocked-action')).toBeNull(); // already there
    expect(q('views-ai-reason')!.textContent).toContain('No AI provider has been added yet');
  });

  it('names why a configured provider cannot run (e.g. it needs the server proxy)', async () => {
    const stability = createProviderConfig('stability', { id: 'st', label: 'My Stability', apiKey: 'sk-x' });
    await act(async () => studio.actions.setAiSettings({ providers: [stability], defaults: {}, rememberKeys: false }));
    await act(async () => studio.actions.setStep('views'));
    expect(q('views-ai-reason')!.textContent).toMatch(/My Stability: .*server/);
  });

  it('step 4 shows the human-detail note for drivers with that badge', async () => {
    await act(async () => studio.actions.loadFile(new Blob(['p']), 'p.png'));
    await act(async () => studio.actions.selectDriver('depth-anything-v2-small'));
    await act(async () => studio.actions.setStep('3d'));
    expect(q('human-detail')?.dataset.state).toBe('pending');
    await act(async () => q('human-detect')!.click());
    await vi.waitFor(() => expect(q('human-detail')?.dataset.state).toBe('none'));
    await act(async () => studio.actions.setParam('depth-anything-v2-small', 'humanDetail', false));
    expect(q('human-detail')?.dataset.state).toBe('off');
    await act(async () => studio.actions.selectDriver('silhouette-extrude'));
    expect(q('human-detail')).toBeNull();
  });
});
