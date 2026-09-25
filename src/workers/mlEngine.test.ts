import { describe, expect, it, vi } from 'vitest';
import { dtypeCandidates, isMissingWeightsError, MlEngine, SerialQueue, type EngineDeps, type GpuInfo, type LoadRequest } from './mlEngine';
import type { MlProgress } from './mlProtocol';

class ModelFileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelFileNotFoundError';
  }
}

interface FakePipe { key: string; disposed: boolean }

function setup(opts: {
  gpu?: GpuInfo;
  missing?: string[]; // `${device}|${dtype}` combos whose weights 404
  failLoad?: string[]; // `${device}|${dtype}` combos whose load throws
  maxCached?: number;
} = {}) {
  const loads: string[] = [];
  const disposed: string[] = [];
  const deps: EngineDeps<FakePipe> = {
    detectGpu: async () => opts.gpu ?? { available: true, fp16: true },
    maxCached: opts.maxCached,
    load: async (req: LoadRequest) => {
      const combo = `${req.device}|${req.dtype}`;
      loads.push(`${req.task}|${req.model}|${combo}`);
      req.onLoadProgress({ status: 'initiate', file: 'onnx/model.onnx' });
      req.onLoadProgress({ status: 'progress', file: 'onnx/model.onnx', loaded: 50, total: 100 });
      if (opts.missing?.includes(combo)) throw new ModelFileNotFoundError(`Could not locate file: ".../onnx/model_${req.dtype}.onnx".`);
      if (opts.failLoad?.includes(combo)) throw new Error(`load failed on ${combo}`);
      req.onLoadProgress({ status: 'progress', file: 'onnx/model.onnx', loaded: 100, total: 100 });
      req.onLoadProgress({ status: 'done', file: 'onnx/model.onnx' });
      return { key: `${req.model}|${combo}`, disposed: false };
    },
    dispose: (p) => {
      p.disposed = true;
      disposed.push(p.key);
    },
  };
  return { engine: new MlEngine(deps), loads, disposed };
}

const spec = (model = 'm', over: Partial<{ device: 'auto' | 'wasm'; precision: 'auto' | 'fp32' }> = {}) => ({
  task: 'depth-estimation' as const,
  model,
  device: over.device ?? ('auto' as const),
  precision: over.precision ?? ('auto' as const),
});

describe('dtypeCandidates', () => {
  it('prefers fp16 on WebGPU with shader-f16, fp32 otherwise, q8 on WASM', () => {
    expect(dtypeCandidates('webgpu', 'auto', true)).toEqual(['fp16', 'fp32']);
    expect(dtypeCandidates('webgpu', 'auto', false)).toEqual(['fp32']);
    expect(dtypeCandidates('wasm', 'auto', true)).toEqual(['q8', 'fp32']);
    expect(dtypeCandidates('wasm', 'fp32', true)).toEqual(['fp32']);
  });
});

describe('isMissingWeightsError', () => {
  it('matches only missing .onnx files', () => {
    expect(isMissingWeightsError(new ModelFileNotFoundError('x "onnx/model_fp16.onnx"'))).toBe(true);
    expect(isMissingWeightsError(new ModelFileNotFoundError('x "config.json"'))).toBe(false);
    expect(isMissingWeightsError(new Error('onnx/model.onnx'))).toBe(false);
  });
});

describe('MlEngine', () => {
  it('runs on WebGPU with fp16 and caches the pipeline', async () => {
    const { engine, loads } = setup();
    const r1 = await engine.run(spec(), () => {}, async (p, d) => `${p.key}@${d}`);
    expect(r1).toEqual({ result: 'm|webgpu|fp16@webgpu', device: 'webgpu', dtype: 'fp16' });
    const r2 = await engine.run(spec(), () => {}, async (p) => p.key);
    expect(r2.result).toBe('m|webgpu|fp16');
    expect(loads).toHaveLength(1);
  });

  it('uses WASM with q8 when no GPU adapter is available', async () => {
    const { engine } = setup({ gpu: { available: false, fp16: false } });
    const r = await engine.run(spec(), () => {}, async (p) => p.key);
    expect(r).toMatchObject({ device: 'wasm', dtype: 'q8' });
  });

  it('honours device=wasm and precision=fp32', async () => {
    const { engine } = setup();
    const r = await engine.run(spec('m', { device: 'wasm', precision: 'fp32' }), () => {}, async (p) => p.key);
    expect(r).toMatchObject({ device: 'wasm', dtype: 'fp32', result: 'm|wasm|fp32' });
  });

  it('falls back to the next dtype when weights are missing', async () => {
    const { engine, loads } = setup({ missing: ['webgpu|fp16'] });
    const r = await engine.run(spec(), () => {}, async (p) => p.key);
    expect(r).toMatchObject({ device: 'webgpu', dtype: 'fp32' });
    expect(loads).toEqual(['depth-estimation|m|webgpu|fp16', 'depth-estimation|m|webgpu|fp32']);
    // resolved choice is remembered
    await engine.run(spec(), () => {}, async () => null);
    expect(loads).toHaveLength(2);
  });

  it('retries once on WASM when WebGPU loading fails, then remembers it', async () => {
    const { engine, loads } = setup({ failLoad: ['webgpu|fp16'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await engine.run(spec(), () => {}, async (p) => p.key);
    expect(r).toMatchObject({ device: 'wasm', dtype: 'q8' });
    await engine.run(spec(), () => {}, async () => null);
    expect(loads).toEqual(['depth-estimation|m|webgpu|fp16', 'depth-estimation|m|wasm|q8']);
    warn.mockRestore();
  });

  it('retries on WASM when WebGPU inference throws and disposes the WebGPU pipeline', async () => {
    const { engine, disposed } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await engine.run(spec(), () => {}, async (p, device) => {
      if (device === 'webgpu') throw new Error('GPU device lost');
      return p.key;
    });
    expect(r.result).toBe('m|wasm|q8');
    expect(disposed).toEqual(['m|webgpu|fp16']);
    warn.mockRestore();
  });

  it('propagates WASM errors (no infinite retries)', async () => {
    const { engine } = setup({ gpu: { available: false, fp16: false }, failLoad: ['wasm|q8'] });
    await expect(engine.run(spec(), () => {}, async () => null)).rejects.toThrow('load failed on wasm|q8');
  });

  it('evicts the least-recently-used pipeline beyond maxCached', async () => {
    const { engine, disposed } = setup({ maxCached: 2 });
    await engine.run(spec('a'), () => {}, async () => null);
    await engine.run(spec('b'), () => {}, async () => null);
    await engine.run(spec('a'), () => {}, async () => null); // a is now most recent
    await engine.run(spec('c'), () => {}, async () => null);
    expect(disposed).toEqual(['b|webgpu|fp16']);
    expect(engine.cachedCount).toBe(2);
    await engine.disposeAll();
    expect(engine.cachedCount).toBe(0);
  });

  it('emits load → download → load → inference progress', async () => {
    const { engine } = setup();
    const events: MlProgress[] = [];
    await engine.run(spec(), (p) => events.push(p), async () => null);
    expect(events.map((e) => e.stage)).toEqual(['load', 'download', 'download', 'load', 'load', 'inference']);
    expect(events[2]).toMatchObject({ stage: 'download', ratio: 0.5, loadedBytes: 50, totalBytes: 100, device: 'webgpu' });
    // cached: only inference
    events.length = 0;
    await engine.run(spec(), (p) => events.push(p), async () => null);
    expect(events).toEqual([{ stage: 'inference', device: 'webgpu' }]);
  });
});

describe('SerialQueue', () => {
  it('runs jobs one at a time in order', async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    const job = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([q.run(1, job('a', 20)), q.run(2, job('b', 1))]);
    expect(results).toEqual(['a', 'b']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('skips jobs cancelled while queued and survives failures', async () => {
    const q = new SerialQueue();
    const ran: number[] = [];
    const p1 = q.run(1, async () => { ran.push(1); throw new Error('boom'); });
    const p2 = q.run(2, async () => { ran.push(2); return 2; });
    const p3 = q.run(3, async () => { ran.push(3); return 3; });
    q.cancel(2);
    await expect(p1).rejects.toThrow('boom');
    expect(await p2).toBeUndefined();
    expect(await p3).toBe(3);
    expect(ran).toEqual([1, 3]);
  });
});
