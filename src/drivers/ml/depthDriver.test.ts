import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AbortError, defaultParams, type DriverInput, type Mask, type Progress } from '../../core/types';
import { MESH_PARAMS } from '../../core/mesh/options';
import type { DepthJob, DepthPayload, MlProgress } from '../../workers/mlProtocol';
import type { MlRequestOptions } from './workerClient';

vi.mock('./workerClient', () => ({
  isMlSupported: () => true,
  requestDepth: vi.fn(),
}));

const { requestDepth } = await import('./workerClient');
const { ML_DRIVERS } = await import('./index');
const mockedRequest = vi.mocked(requestDepth);

/** Fake worker: disparity = x coordinate of the image it received (right = nearest). */
function fakeDepth(job: Omit<DepthJob, 'id' | 'type'>, opts: MlRequestOptions): Promise<DepthPayload> {
  const { width, height } = job.image;
  opts.onProgress?.({ stage: 'inference', device: 'webgpu' } satisfies MlProgress);
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = i % width;
  return Promise.resolve({ kind: 'depth', data, dims: [1, height, width], device: 'webgpu', dtype: 'fp16' });
}

function input(over: Partial<DriverInput> = {}): DriverInput & { progress: Progress[] } {
  const width = 300, height = 150;
  const progress: Progress[] = [];
  return {
    image: { width, height, data: new Uint8ClampedArray(width * height * 4).fill(200) },
    mask: null,
    file: new Blob(),
    views: {},
    params: {},
    signal: new AbortController().signal,
    onProgress: (p) => progress.push(p),
    progress,
    ...over,
  };
}

const driver = (id: string) => {
  const d = ML_DRIVERS.find((x) => x.id === id);
  if (!d) throw new Error(`missing driver ${id}`);
  return d;
};

beforeEach(() => {
  mockedRequest.mockReset();
  mockedRequest.mockImplementation(fakeDepth);
});

describe('ML_DRIVERS', () => {
  it('registers the three depth models with the default first', () => {
    expect(ML_DRIVERS.map((d) => d.id)).toEqual(['depth-anything-v2-small', 'depth-anything-v2-base', 'dpt-hybrid-midas']);
    for (const d of ML_DRIVERS) {
      expect(d.category).toBe('ml');
      expect(d.producesDepth).toBe(true);
      expect(d.badges).toEqual(expect.arrayContaining(['download', 'webgpu']));
      expect(d.downloadSizeMB).toBeGreaterThan(0);
      expect(d.name.tr && d.name.en && d.description.tr && d.description.en).toBeTruthy();
    }
  });

  it('param keys are unique and do not clash with mesh params', () => {
    const meshKeys = new Set(MESH_PARAMS.map((p) => p.key));
    for (const d of ML_DRIVERS) {
      const keys = d.params.map((p) => p.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const k of keys) expect(meshKeys.has(k)).toBe(false);
    }
  });

  it('offers the detail select only for dynamic-size models', () => {
    expect(driver('depth-anything-v2-small').params.some((p) => p.key === 'detail')).toBe(true);
    expect(driver('dpt-hybrid-midas').params.some((p) => p.key === 'detail')).toBe(false);
  });

  it('reports availability', async () => {
    await expect(driver('depth-anything-v2-small').isAvailable!()).resolves.toEqual({ ok: true });
  });
});

describe('depth driver run()', () => {
  it('sends a patch-aligned image of the chosen size and returns depth at input size', async () => {
    const d = driver('depth-anything-v2-small');
    const inp = input({ params: defaultParams(d.params) });
    const res = await d.run(inp);
    const [job] = mockedRequest.mock.calls[0];
    expect(job).toMatchObject({ model: 'onnx-community/depth-anything-v2-small', exactSize: true, device: 'auto', precision: 'auto' });
    expect(job.image.width % 14).toBe(0);
    expect(job.image.height % 14).toBe(0);
    expect((job.image.width * job.image.height) / 518 ** 2).toBeCloseTo(1, 1);
    expect(res.kind).toBe('depth');
    if (res.kind !== 'depth') return;
    expect(res.depth.width).toBe(300);
    expect(res.depth.height).toBe(150);
    expect(res.depth.data[300 * 75 + 299]).toBeGreaterThan(res.depth.data[300 * 75]); // right is nearer
    expect(res.mask).toBeNull();
    const labels = inp.progress.map((p) => p.label.en);
    expect(labels[0]).toBe('Preparing image…');
    expect(labels).toContain('Estimating depth (WebGPU)…');
    expect(labels.at(-1)).toBe('Post-processing…');
  });

  it('honours detail, precision and device params', async () => {
    const d = driver('depth-anything-v2-base');
    await d.run(input({ params: { detail: '392', precision: 'fp32', device: 'wasm', edgeRefine: true } }));
    const [job] = mockedRequest.mock.calls[0];
    expect(job).toMatchObject({ precision: 'fp32', device: 'wasm' });
    expect((job.image.width * job.image.height) / 392 ** 2).toBeCloseTo(1, 1);
  });

  it('ignores an unknown detail value', async () => {
    const d = driver('depth-anything-v2-small');
    await d.run(input({ params: { detail: '123' } }));
    const [job] = mockedRequest.mock.calls[0];
    expect((job.image.width * job.image.height) / 518 ** 2).toBeCloseTo(1, 1);
  });

  it('keeps the processor size for DPT (exactSize false)', async () => {
    await driver('dpt-hybrid-midas').run(input());
    const [job] = mockedRequest.mock.calls[0];
    expect(job).toMatchObject({ model: 'Xenova/dpt-hybrid-midas', exactSize: false });
  });

  it('passes the mask through and zeroes the background', async () => {
    const mask: Mask = { width: 300, height: 150, data: new Uint8Array(300 * 150) };
    for (let i = 0; i < mask.data.length; i++) mask.data[i] = i % 300 < 150 ? 1 : 0;
    const res = await driver('depth-anything-v2-small').run(input({ mask }));
    if (res.kind !== 'depth') throw new Error('expected depth');
    expect(res.mask).toBe(mask);
    expect(res.depth.data[299]).toBe(0);
    expect(res.depth.data[149]).toBeGreaterThan(0.9);
  });

  it('throws AbortError when aborted before or during the request', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(driver('depth-anything-v2-small').run(input({ signal: ac.signal }))).rejects.toBeInstanceOf(AbortError);
    expect(mockedRequest).not.toHaveBeenCalled();

    const ac2 = new AbortController();
    mockedRequest.mockImplementation(async (job, opts) => {
      ac2.abort();
      return fakeDepth(job, opts);
    });
    await expect(driver('depth-anything-v2-small').run(input({ signal: ac2.signal }))).rejects.toBeInstanceOf(AbortError);
  });

  it('lets the post-processing label paint before the synchronous step, and honours a cancel meanwhile', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    try {
      const ac = new AbortController();
      const inp = input({ signal: ac.signal });
      let settled = false;
      const run = driver('depth-anything-v2-small').run(inp);
      run.then(
        () => (settled = true),
        () => (settled = true),
      );
      await vi.waitFor(() => expect(frames.length).toBe(1));
      expect(inp.progress.at(-1)?.label.en).toBe('Post-processing…');
      expect(settled).toBe(false);
      ac.abort(); // e.g. Esc, dispatched while the label is being painted
      frames.shift()!(0);
      await vi.waitFor(() => expect(frames.length).toBe(1));
      frames.shift()!(0);
      await expect(run).rejects.toBeInstanceOf(AbortError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
