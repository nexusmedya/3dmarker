import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AbortError, type Progress, type RGBAImage } from '../types';
import type { AlphaPayload, BackgroundRemovalJob } from '../../workers/mlProtocol';
import type { MlRequestOptions } from '../../drivers/ml/workerClient';

vi.mock('../../drivers/ml/workerClient', () => ({ requestForegroundAlpha: vi.fn() }));

const { requestForegroundAlpha } = await import('../../drivers/ml/workerClient');
const { removeBackground, DEFAULT_BACKGROUND_MODEL } = await import('./removeBackground');
const mocked = vi.mocked(requestForegroundAlpha);

/** Fake matte: foreground = bright pixels of the image the worker received. */
function fakeMatte(job: Omit<BackgroundRemovalJob, 'id' | 'type'>, opts: MlRequestOptions): Promise<AlphaPayload> {
  const { width, height, data } = job.image;
  opts.onProgress?.({ stage: 'inference', device: 'wasm' });
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4] > 128 ? 255 : 0;
  return Promise.resolve({ kind: 'alpha', data: alpha, width, height, device: 'wasm', dtype: 'q8' });
}

/** Left half black, right half white; optional alpha for the top row. */
function image(w: number, h: number, topAlpha = 255): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = x < w / 2 ? 0 : 255;
      data.set([v, v, v, y === 0 ? topAlpha : 255], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
}

const opts = (signal = new AbortController().signal) => {
  const progress: Progress[] = [];
  return { signal, onProgress: (p: Progress) => progress.push(p), progress };
};

beforeEach(() => {
  mocked.mockReset();
  mocked.mockImplementation(fakeMatte);
});

describe('removeBackground', () => {
  it('returns a mask at the input size from the model matte', async () => {
    const o = opts();
    const mask = await removeBackground(image(40, 20), o);
    expect(mask.width).toBe(40);
    expect(mask.height).toBe(20);
    expect(mask.data[5 * 40 + 0]).toBe(0);
    expect(mask.data[5 * 40 + 39]).toBe(1);
    const [job] = mocked.mock.calls[0];
    expect(job.model).toBe(DEFAULT_BACKGROUND_MODEL);
    expect(o.progress.map((p) => p.label.en)).toContain('Removing background (WASM)…');
  });

  it('downscales large images before sending and upsamples the matte back', async () => {
    const mask = await removeBackground(image(2048, 512), opts());
    const [job] = mocked.mock.calls[0];
    expect(Math.max(job.image.width, job.image.height)).toBe(1024);
    expect(mask.width).toBe(2048);
    expect(mask.data[100 * 2048 + 2047]).toBe(1);
    expect(mask.data[100 * 2048]).toBe(0);
  });

  it('never marks already-transparent pixels as foreground', async () => {
    const mask = await removeBackground(image(40, 20, 0), opts());
    expect(mask.data[39]).toBe(0); // top row was transparent
    expect(mask.data[40 + 39]).toBe(1);
  });

  it('passes a custom model and respects abort', async () => {
    await removeBackground(image(8, 8), { ...opts(), model: 'someone/birefnet' });
    expect(mocked.mock.calls[0][0].model).toBe('someone/birefnet');

    const ac = new AbortController();
    ac.abort();
    await expect(removeBackground(image(8, 8), opts(ac.signal))).rejects.toBeInstanceOf(AbortError);
  });
});
