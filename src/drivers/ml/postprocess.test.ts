import { describe, expect, it } from 'vitest';
import type { Mask, RGBAImage } from '../../core/types';
import {
  depthDims,
  DownloadProgressTracker,
  mlProgressToProgress,
  orientDepth,
  processDepth,
  refineRadius,
} from './postprocess';

const mask = (w: number, h: number, fn: (x: number, y: number) => boolean): Mask => {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fn(x, y) ? 1 : 0;
  return { width: w, height: h, data };
};

/** Horizontal ramp: value = x. */
const ramp = (w: number, h: number) => {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = x;
  return data;
};

describe('depthDims', () => {
  it('accepts [h, w], [1, h, w] and [1, 1, h, w]', () => {
    expect(depthDims([3, 5])).toEqual({ width: 5, height: 3 });
    expect(depthDims([1, 3, 5])).toEqual({ width: 5, height: 3 });
    expect(depthDims([1, 1, 3, 5])).toEqual({ width: 5, height: 3 });
  });

  it('rejects batches and degenerate dims', () => {
    expect(() => depthDims([2, 3, 5])).toThrow(/Batched/);
    expect(() => depthDims([5])).toThrow();
    expect(() => depthDims([0, 5])).toThrow();
  });
});

describe('orientDepth', () => {
  it('keeps disparity (larger = nearer) and flips metric depth', () => {
    expect([...orientDepth([1, 2, 3], 'disparity')]).toEqual([1, 2, 3]);
    expect([...orientDepth([1, 2, 3], 'metric')]).toEqual([-1, -2, -3]);
  });

  it('replaces non-finite values with the farthest finite value', () => {
    expect([...orientDepth([NaN, 2, Infinity, 5], 'disparity')]).toEqual([2, 2, 2, 5]);
    expect([...orientDepth([NaN, NaN], 'disparity')]).toEqual([0, 0]);
  });
});

describe('processDepth', () => {
  it('normalises disparity to [0, 1] with 1 = nearest', () => {
    const d = processDepth({ data: ramp(4, 2), dims: [2, 4] }, {
      width: 4, height: 2, convention: 'disparity', mask: null, robust: false,
    });
    expect(d.width).toBe(4);
    expect(d.height).toBe(2);
    expect(Array.from(d.data.slice(0, 4))).toEqual([0, 1 / 3, 2 / 3, 1].map((v) => Math.fround(v)));
  });

  it('inverts metric depth so the smallest distance becomes 1', () => {
    const d = processDepth({ data: ramp(4, 1), dims: [1, 1, 1, 4] }, {
      width: 4, height: 1, convention: 'metric', mask: null, robust: false,
    });
    expect(d.data[0]).toBe(1);
    expect(d.data[3]).toBe(0);
  });

  it('resizes to the requested size', () => {
    const d = processDepth({ data: ramp(8, 4), dims: [1, 4, 8] }, {
      width: 32, height: 16, convention: 'disparity', mask: null, robust: false,
    });
    expect(d.data.length).toBe(32 * 16);
    // monotonic left → right, full range
    for (let x = 1; x < 32; x++) expect(d.data[x]).toBeGreaterThanOrEqual(d.data[x - 1]);
    expect(d.data[0]).toBe(0);
    expect(d.data[31]).toBe(1);
  });

  it('uses only foreground statistics and zeroes the background', () => {
    const w = 20, h = 20;
    const data = new Float32Array(w * h).fill(100); // background: very near
    const m = mask(w, h, (x, y) => x >= 5 && x < 15 && y >= 5 && y < 15);
    for (let i = 0; i < data.length; i++) if (m.data[i]) data[i] = (i % w) - 5; // 0..9 inside
    const d = processDepth({ data, dims: [h, w] }, { width: w, height: h, convention: 'disparity', mask: m, robust: false });
    for (let i = 0; i < d.data.length; i++) {
      if (!m.data[i]) expect(d.data[i]).toBe(0);
    }
    expect(d.data[10 * w + 5]).toBe(0);
    expect(d.data[10 * w + 14]).toBe(1);
  });

  it('resizes a mask of a different size', () => {
    const m = mask(4, 4, (x) => x < 2);
    const d = processDepth({ data: ramp(8, 8), dims: [8, 8] }, { width: 8, height: 8, convention: 'disparity', mask: m, robust: false });
    expect(d.data[7]).toBe(0); // right half is background
    expect(d.data[3]).toBe(1); // right-most foreground column is nearest
  });

  it('robust normalisation ignores outliers', () => {
    const w = 50, h = 10;
    const data = ramp(w, h);
    data[0] = 1e6; // one crazy spike
    const d = processDepth({ data, dims: [h, w] }, { width: w, height: h, convention: 'disparity', mask: null });
    expect(d.data[0]).toBe(1); // clamped
    expect(d.data[w * 5 + 25]).toBeGreaterThan(0.4); // the rest still spans the range
    expect(d.data[w * 5 + 25]).toBeLessThan(0.6);
  });

  it('rejects data that does not match dims', () => {
    expect(() => processDepth({ data: new Float32Array(5), dims: [2, 3] }, {
      width: 3, height: 2, convention: 'disparity', mask: null,
    })).toThrow(/does not match/);
  });

  it('runs edge-aware refinement when requested and stays in [0, 1]', () => {
    const w = 16, h = 16;
    const img: RGBAImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let i = 0; i < w * h; i++) {
      const v = i % w < 8 ? 20 : 230;
      img.data.set([v, v, v, 255], i * 4);
    }
    const d = processDepth({ data: ramp(4, 4), dims: [4, 4] }, {
      width: w, height: h, convention: 'disparity', mask: null, robust: false, refine: { image: img },
    });
    for (const v of d.data) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('refineRadius', () => {
  it('scales with the upsampling factor, clamped to [2, 16]', () => {
    expect(refineRadius(518, 518, 518, 518)).toBe(2);
    expect(refineRadius(256, 256, 1024, 1024)).toBe(8);
    expect(refineRadius(64, 64, 4096, 4096)).toBe(16);
  });
});

describe('DownloadProgressTracker', () => {
  it('sums per-file progress', () => {
    const t = new DownloadProgressTracker();
    t.update({ status: 'initiate', file: 'config.json' });
    t.update({ status: 'initiate', file: 'onnx/model.onnx' });
    t.update({ status: 'progress', file: 'config.json', loaded: 100, total: 100 });
    const s = t.update({ status: 'progress', file: 'onnx/model.onnx', loaded: 100, total: 900 });
    expect(s).toMatchObject({ loadedBytes: 200, totalBytes: 1000, done: false });
    expect(s!.ratio).toBeCloseTo(0.2);
  });

  it('marks completion when every started file is done', () => {
    const t = new DownloadProgressTracker();
    t.update({ status: 'initiate', file: 'a' });
    t.update({ status: 'progress', file: 'a', loaded: 5, total: 10 });
    expect(t.update({ status: 'done', file: 'a' })).toMatchObject({ ratio: 1, done: true, loadedBytes: 10 });
  });

  it('reports done with unknown sizes (e.g. cached files without content-length)', () => {
    const t = new DownloadProgressTracker();
    t.update({ status: 'initiate', file: 'a' });
    expect(t.state().ratio).toBeUndefined();
    expect(t.update({ status: 'done', file: 'a' })).toMatchObject({ ratio: 1, done: true });
  });

  it('prefers the library aggregate when it knows more bytes', () => {
    const t = new DownloadProgressTracker();
    t.update({ status: 'progress', file: 'config.json', loaded: 100, total: 100 });
    const s = t.update({ status: 'progress_total', loaded: 100, total: 10_000 });
    expect(s).toMatchObject({ loadedBytes: 100, totalBytes: 10_000 });
    expect(s!.ratio).toBeCloseTo(0.01);
  });

  it('ignores events without byte or file information', () => {
    const t = new DownloadProgressTracker();
    expect(t.update({ status: 'ready' })).toBeNull();
    expect(t.update({ status: 'progress' })).toBeNull();
  });
});

describe('mlProgressToProgress', () => {
  const action = { tr: 'Derinlik hesaplanıyor', en: 'Estimating depth' };

  it('shows ratio and MB while downloading', () => {
    const p = mlProgressToProgress({ stage: 'download', ratio: 0.5, loadedBytes: 25 * 1024 * 1024, totalBytes: 50 * 1024 * 1024 }, action);
    expect(p.ratio).toBe(0.5);
    expect(p.label.en).toContain('25 / 50 MB');
    expect(p.label.tr).toContain('25 / 50 MB');
  });

  it('names the device during inference and is indeterminate', () => {
    const p = mlProgressToProgress({ stage: 'inference', device: 'webgpu' }, action);
    expect(p.ratio).toBeUndefined();
    expect(p.label).toEqual({ tr: 'Derinlik hesaplanıyor (WebGPU)…', en: 'Estimating depth (WebGPU)…' });
  });

  it('has a loading label', () => {
    expect(mlProgressToProgress({ stage: 'load', device: 'wasm' }, action).label.en).toBe('Initialising model (WASM)…');
  });
});
