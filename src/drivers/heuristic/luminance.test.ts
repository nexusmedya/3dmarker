import { describe, expect, it, vi } from 'vitest';
import type { DriverInput, Mask, RGBAImage } from '../../core/types';
import { AbortError, defaultParams } from '../../core/types';
import {
  autoLevels, contrastCurve, luminanceDepth, luminanceDriver, sourceChannel, type LuminanceOptions,
} from './luminance';

function imageOf(w: number, h: number, px: (x: number, y: number) => [number, number, number]): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([...px(x, y), 255], (y * w + x) * 4);
  return { width: w, height: h, data };
}

const opts = (o: Partial<LuminanceOptions> = {}): LuminanceOptions => ({
  source: 'luminance', invert: false, contrast: 1, blur: 0, detail: 0, ...o,
});

// Horizontal grey ramp 0..255.
const ramp = imageOf(256, 8, (x) => [x, x, x]);

describe('luminanceDepth', () => {
  it('maps brightness to height (bright = near) spanning [0, 1]', () => {
    const { data, width } = luminanceDepth(ramp, null, opts());
    for (let x = 1; x < 256; x++) expect(data[4 * width + x]).toBeGreaterThanOrEqual(data[4 * width + x - 1]);
    expect(data[4 * width]).toBe(0);
    expect(data[4 * width + 255]).toBe(1);
    expect(data[4 * width + 128]).toBeCloseTo(0.5, 1);
  });

  it('inverts (dark = near)', () => {
    const a = luminanceDepth(ramp, null, opts()).data;
    const b = luminanceDepth(ramp, null, opts({ invert: true })).data;
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(1 - a[i], 6);
  });

  it('uses only the foreground for statistics and zeroes the background', () => {
    // Foreground tones 100..150 must still be stretched to the full range.
    const img = imageOf(64, 4, (x) => [100 + (x % 51), 100 + (x % 51), 100 + (x % 51)]);
    const data = new Uint8Array(64 * 4);
    for (let i = 0; i < data.length; i++) data[i] = i % 64 < 51 ? 1 : 0;
    const mask: Mask = { width: 64, height: 4, data };
    const d = luminanceDepth(img, mask, opts({ blur: 2, detail: 1 })).data;
    let lo = 1, hi = 0;
    for (let i = 0; i < d.length; i++) {
      if (!data[i]) { expect(d[i]).toBe(0); continue; }
      lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]);
    }
    expect(lo).toBeLessThan(0.05);
    expect(hi).toBeGreaterThan(0.95);
  });

  it('supports saturation and lightness sources', () => {
    // Red square on grey: only saturation sees it as raised.
    const img = imageOf(32, 32, (x, y) => (x >= 8 && x < 24 && y >= 8 && y < 24 ? [220, 20, 20] : [128, 128, 128]));
    const sat = luminanceDepth(img, null, opts({ source: 'saturation' })).data;
    expect(sat[16 * 32 + 16]).toBe(1);
    expect(sat[0]).toBe(0);
    const blue: RGBAImage = imageOf(1, 1, () => [0, 0, 255]);
    expect(sourceChannel(blue, 'lightness')[0]).toBeCloseTo(0.5, 3);
    expect(sourceChannel(blue, 'luminance')[0]).toBeCloseTo(0.0722, 3);
    expect(sourceChannel(blue, 'saturation')[0]).toBeCloseTo(1, 3);
  });

  it('detail boost sharpens edges; blur smooths them', () => {
    const step = imageOf(64, 4, (x) => (x < 32 ? [60, 60, 60] : [190, 190, 190]));
    const row = (d: Float32Array) => Array.from(d.subarray(2 * 64, 3 * 64));
    const blurred = row(luminanceDepth(step, null, opts({ blur: 20 })).data);
    expect(blurred[31]).toBeGreaterThan(0.05);
    expect(blurred[31]).toBeLessThan(0.95);
    const sharp = row(luminanceDepth(step, null, opts({ blur: 20, detail: 2 })).data);
    // Unsharp mask steepens the transition around the edge.
    expect(sharp[34] - sharp[29]).toBeGreaterThan(blurred[34] - blurred[29]);
  });

  it('contrast curve keeps 0, ½, 1 and steepens mid-tones', () => {
    for (const c of [0.3, 1, 2.5]) {
      expect(contrastCurve(0, c)).toBe(0);
      expect(contrastCurve(1, c)).toBe(1);
      expect(contrastCurve(0.5, c)).toBeCloseTo(0.5, 10);
    }
    expect(contrastCurve(0.25, 2)).toBeLessThan(0.25);
    expect(contrastCurve(0.25, 0.5)).toBeGreaterThan(0.25);
    let prev = 0;
    for (let v = 0; v <= 1; v += 0.01) {
      const t = contrastCurve(v, 3);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it('is fast enough for 1024×1024', () => {
    const img = imageOf(1024, 1024, (x, y) => [(x ^ y) & 255, x & 255, y & 255]);
    const t0 = performance.now();
    luminanceDepth(img, null, opts({ blur: 1, detail: 0.5, contrast: 1.5 }));
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe('autoLevels', () => {
  it('ignores rare outliers and handles constant input', () => {
    const d = new Float32Array(1000);
    for (let i = 0; i < d.length; i++) d[i] = 0.4 + (i % 100) / 1000; // 0.4 .. 0.499
    d[0] = 50; // hot pixel
    const out = autoLevels(d, null);
    expect(out[0]).toBe(1);
    expect(out[99]).toBeGreaterThan(0.95);
    expect(out[1]).toBeLessThan(0.05);
    expect(Array.from(autoLevels(new Float32Array(10).fill(0.3), null))).toEqual(new Array(10).fill(0.5));
  });
});

describe('luminanceDriver', () => {
  const run = (image: RGBAImage, mask: Mask | null, signal = new AbortController().signal) =>
    luminanceDriver.run({
      image, mask, file: new Blob(), signal, onProgress: () => {}, params: defaultParams(luminanceDriver.params),
    } satisfies DriverInput);

  it('declares its contract', () => {
    expect(luminanceDriver.id).toBe('luminance-heightmap');
    expect(luminanceDriver.badges).toEqual(['offline']);
    expect(luminanceDriver.producesDepth).toBe(true);
    expect(Object.keys(defaultParams(luminanceDriver.params)).sort()).toEqual(['blur', 'contrast', 'detail', 'invert', 'source']);
  });

  it('returns a depth result and passes the mask through', async () => {
    const mask: Mask = { width: 256, height: 8, data: new Uint8Array(256 * 8).fill(1) };
    const res = await run(ramp, mask);
    expect(res.kind).toBe('depth');
    if (res.kind !== 'depth') return;
    expect(res.mask).toBe(mask);
    expect(res.depth.data[4 * 256 + 250]).toBeGreaterThan(res.depth.data[4 * 256 + 5]);
    const noMask = await run(ramp, null);
    expect(noMask.kind === 'depth' && noMask.mask).toBeNull();
  });

  it('honours the abort signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(run(ramp, null, ac.signal)).rejects.toBeInstanceOf(AbortError);
  });

  it('waits for a paint after its progress label, before the synchronous step', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    try {
      const labels: string[] = [];
      let settled = false;
      const job = luminanceDriver
        .run({
          image: ramp, mask: null, file: new Blob(), signal: new AbortController().signal,
          onProgress: (p) => labels.push(p.label.en), params: defaultParams(luminanceDriver.params),
        })
        .finally(() => (settled = true));
      await vi.waitFor(() => expect(frames.length).toBe(1));
      expect(labels).toEqual(['Computing height map']);
      expect(settled).toBe(false);
      frames.shift()!(0);
      await vi.waitFor(() => expect(frames.length).toBe(1));
      frames.shift()!(0);
      expect((await job).kind).toBe('depth');
      expect(labels).toEqual(['Computing height map', 'Done']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
