// @vitest-environment jsdom
/**
 * Image enhancement in the studio (real ControlPanel + useStudio, jsdom):
 * the card opens itself for a small sprite and the upload card hints at it,
 * presets show their resulting size, a local enhancer produces a before /
 * after result that Apply makes the source (Revert brings the original back),
 * and AI presets go through the ML worker client (mocked here) with tile progress.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RGBAImage } from '../core/types';
import type { SourceImage } from '../app/pipeline';

const mocks = vi.hoisted(() => ({ prepareSource: vi.fn(), requestUpscale: vi.fn() }));
vi.mock('../app/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/pipeline')>();
  return { ...actual, prepareSource: mocks.prepareSource };
});
vi.mock('../drivers/ml/workerClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../drivers/ml/workerClient')>();
  return { ...actual, requestUpscale: mocks.requestUpscale };
});

import { LangProvider } from './i18n';
import { ControlPanel } from './ControlPanel';
import { enhanceProgress, useStudio, type Studio } from './useStudio';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 32 × 32 four-colour sprite with a transparent border. */
function sprite(): RGBAImage {
  const w = 32;
  const data = new Uint8ClampedArray(w * w * 4);
  const pal = [[220, 40, 40], [40, 200, 60], [30, 60, 220], [250, 230, 30]];
  for (let y = 2; y < w - 2; y++) for (let x = 2; x < w - 2; x++) data.set([...pal[((x >> 3) + (y >> 3)) % 4], 255], (y * w + x) * 4);
  return { width: w, height: w, data };
}

const spriteSource = (name: string): SourceImage => ({ name, file: new Blob([name]), image: sprite() });

let root: Root | null = null;
let host: HTMLDivElement;
let studio!: Studio;

function Shell() {
  studio = useStudio();
  return createElement(LangProvider, { value: 'en' }, createElement(ControlPanel, { studio }));
}

const q = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector(`[data-testid="${id}"]`) as T | null;
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await wait(20);
  }
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  mocks.prepareSource.mockReset().mockImplementation(async (_f: Blob, name: string) => spriteSource(name));
  mocks.requestUpscale.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } })));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
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

describe('EnhanceCard in the studio', () => {
  it('suggests itself for a small pixel-art image, applies the pixel scaler and reverts', async () => {
    expect(q('enhance-card')).toBeNull(); // no image yet
    await act(async () => void (await studio.actions.loadFile(new Blob(['x']), 'hero.png')));
    await until(() => q<HTMLDetailsElement>('enhance-card')?.open === true);
    expect(q('enhance-suggestion')!.textContent).toMatch(/pixelated/);
    expect(q<HTMLButtonElement>('enhance-preset-pixel')!.getAttribute('aria-pressed')).toBe('true');
    // Every preset shows its resulting size.
    for (const id of ['auto', 'ai-x2', 'ai-x4', 'pixel', 'sharpen', 'denoise']) expect(q(`enhance-preset-${id}`)).not.toBeNull();
    expect(q('enhance-preset-ai-x4')!.textContent).toContain('128 × 128');
    expect(q('enhance-size')!.textContent).toContain('32 × 32 → 1024 × 1024 px');

    await act(async () => q('enhance-run')!.click());
    await until(() => !!q('enhance-result'));
    expect(studio.state.enhanced?.source.image.width).toBe(1024);
    expect(q('enhance-compare')).not.toBeNull();
    expect(studio.state.source?.name).toBe('hero.png'); // not applied yet

    await act(async () => q('enhance-apply')!.click());
    expect(studio.state.source?.name).toBe('hero-enhanced.png');
    expect(studio.state.source?.image.width).toBe(1024);
    expect(studio.state.enhanceApplied?.before.name).toBe('hero.png');
    // The enhanced sprite keeps its transparent border: the auto mask comes from its alpha.
    expect(studio.state.mask?.width).toBe(1024);
    expect(q('enhance-applied')).not.toBeNull();

    await act(async () => q('enhance-revert')!.click());
    expect(studio.state.source?.name).toBe('hero.png');
    expect(studio.state.mask?.width).toBe(32);
  });

  it('the upload card hint opens a closed card', async () => {
    await act(async () => void (await studio.actions.loadFile(new Blob(['x']), 'hero.png')));
    await until(() => q<HTMLDetailsElement>('enhance-card')?.open === true);
    await act(async () => {
      q<HTMLDetailsElement>('enhance-card')!.open = false;
      q('enhance-card')!.dispatchEvent(new Event('toggle'));
    });
    await until(() => !!q('enhance-hint'));
    expect(q('enhance-hint')!.textContent).toMatch(/pixelated/);
    await act(async () => q('enhance-hint-open')!.click());
    expect(q<HTMLDetailsElement>('enhance-card')!.open).toBe(true);
  });

  it('AI presets run in the ML worker with tile progress; alpha is put back', async () => {
    mocks.requestUpscale.mockImplementation(async (job: { image: RGBAImage; scale: number; model: string }, opts: { onProgress?: (p: object) => void }) => {
      opts.onProgress?.({ stage: 'inference', device: 'wasm', done: 1, total: 2 });
      const { width, height } = job.image;
      // Opaque input (transparent pixels bled): return a flat opaque image at ×scale.
      for (let i = 3; i < job.image.data.length; i += 4) expect(job.image.data[i]).toBe(255);
      const W = width * job.scale, H = height * job.scale;
      return { kind: 'image', data: new Uint8ClampedArray(W * H * 4).fill(200), width: W, height: H, scale: job.scale, device: 'wasm', dtype: 'q8' };
    });
    await act(async () => void (await studio.actions.loadFile(new Blob(['x']), 'hero.png')));
    await until(() => q<HTMLDetailsElement>('enhance-card')?.open === true);
    await act(async () => q('enhance-preset-ai-x2')!.click());
    expect(q('enhance-plan')!.textContent).toContain('Swin2SR ×2');
    await act(async () => q('enhance-run')!.click());
    await until(() => !!q('enhance-result'));
    expect(mocks.requestUpscale).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'Xenova/swin2SR-classical-sr-x2-64', scale: 2, device: 'auto' }),
      expect.anything(),
    );
    const out = studio.state.enhanced!.source.image;
    expect(out.width).toBe(64);
    expect(out.data[3]).toBe(0); // transparent corner stays transparent
    expect(out.data[(32 * 64 + 32) * 4 + 3]).toBe(255);
    await act(async () => q('enhance-discard')!.click());
    expect(studio.state.enhanced).toBeNull();
  });

  it('maps worker progress to card labels', () => {
    expect(enhanceProgress({ stage: 'inference', done: 3, total: 12 })).toEqual({
      label: { tr: 'Yapay zekâ büyütüyor: parça 3/12', en: 'AI upscaling: tile 3/12' },
      ratio: 0.25,
    });
    expect(enhanceProgress({ stage: 'download', ratio: 0.4 }).ratio).toBe(0.4);
  });
});
