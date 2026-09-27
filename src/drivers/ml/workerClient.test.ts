import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbortError } from '../../core/types';
import type { MlRequest, MlResponse } from '../../workers/mlProtocol';
import { mlEnvConfigFrom, MlWorkerClient, STALL_MEMORY_MS, type MlJobInput, type WorkerLike } from './workerClient';

class FakeWorker implements WorkerLike {
  sent: { msg: MlRequest; transfer?: Transferable[] }[] = [];
  terminated = false;
  onmessage: ((e: MessageEvent<MlResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  postMessage(msg: MlRequest, transfer?: Transferable[]) {
    this.sent.push({ msg, transfer });
  }
  terminate() {
    this.terminated = true;
  }
  reply(msg: MlResponse) {
    this.onmessage?.({ data: msg } as MessageEvent<MlResponse>);
  }
  jobs() {
    return this.sent.map((s) => s.msg).filter((m): m is Extract<MlRequest, { id: number; model: string }> => 'model' in m);
  }
}

function setup(config = {}) {
  const workers: FakeWorker[] = [];
  const client = new MlWorkerClient(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  }, config);
  return { client, workers };
}

const job = (): MlJobInput => ({
  type: 'depth',
  model: 'onnx-community/depth-anything-v2-small',
  device: 'auto',
  precision: 'auto',
  exactSize: true,
  image: { width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) },
});

const depthResult = (id: number): MlResponse => ({
  type: 'result',
  id,
  result: { kind: 'depth', data: new Float32Array([0.5]), dims: [1, 1], device: 'wasm', dtype: 'q8' },
});

describe('MlWorkerClient', () => {
  it('starts the worker lazily, sends config first, transfers the pixels and resolves', async () => {
    const { client, workers } = setup({ remoteHost: 'https://mirror.example/' });
    expect(workers).toHaveLength(0);
    const input = job();
    const pixels = input.image.data;
    const p = client.run(input);
    const w = workers[0];
    expect(w.sent[0].msg).toEqual({ type: 'configure', config: { remoteHost: 'https://mirror.example/' } });
    const sent = w.sent[1];
    expect(sent.msg).toMatchObject({ type: 'depth', id: 1, exactSize: true });
    expect(sent.transfer).toEqual([pixels.buffer]);
    w.reply(depthResult(1));
    await expect(p).resolves.toMatchObject({ kind: 'depth', dtype: 'q8' });
    expect(client.pendingCount).toBe(0);
  });

  it('copies pixels that are a view into a larger buffer before transferring', () => {
    const { client, workers } = setup();
    const big = new Uint8ClampedArray(16);
    const input = job();
    input.image.data = big.subarray(4, 8);
    void client.run(input);
    const t = workers[0].sent[0].transfer!;
    expect(t[0]).not.toBe(big.buffer);
    expect((t[0] as ArrayBuffer).byteLength).toBe(4);
  });

  it('forwards progress and rejects with deserialised errors', async () => {
    const { client, workers } = setup();
    const progress: string[] = [];
    const p = client.run(job(), { onProgress: (e) => progress.push(e.stage) });
    workers[0].reply({ type: 'progress', id: 1, stage: 'load' });
    workers[0].reply({ type: 'progress', id: 1, stage: 'inference', device: 'wasm' });
    workers[0].reply({ type: 'error', id: 1, error: { name: 'ModelFileNotFoundError', message: 'nope' } });
    await expect(p).rejects.toMatchObject({ name: 'ModelFileNotFoundError', message: 'nope' });
    expect(progress).toEqual(['load', 'inference']);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const { client, workers } = setup();
    const ac = new AbortController();
    ac.abort();
    await expect(client.run(job(), { signal: ac.signal })).rejects.toBeInstanceOf(AbortError);
    expect(workers).toHaveLength(0);
  });

  it('on abort: rejects, tells the worker to cancel and ignores the late result', async () => {
    const { client, workers } = setup();
    const ac = new AbortController();
    const p = client.run(job(), { signal: ac.signal });
    workers[0].reply({ type: 'progress', id: 1, stage: 'inference', device: 'webgpu' });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortError);
    expect(workers[0].sent.at(-1)!.msg).toEqual({ type: 'cancel', id: 1 });
    workers[0].reply(depthResult(1)); // ignored
    expect(workers[0].terminated).toBe(false);
  });

  it('terminates the worker when the only pending job is aborted mid-download', async () => {
    const { client, workers } = setup();
    const ac = new AbortController();
    const p = client.run(job(), { signal: ac.signal });
    workers[0].reply({ type: 'progress', id: 1, stage: 'download', ratio: 0.1 });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortError);
    expect(workers[0].terminated).toBe(true);
    // next request gets a fresh worker
    const p2 = client.run(job());
    expect(workers).toHaveLength(2);
    workers[1].reply(depthResult(2));
    await expect(p2).resolves.toMatchObject({ kind: 'depth' });
  });

  it('terminates the worker when the only pending job is aborted during WASM inference', async () => {
    const { client, workers } = setup();
    const ac = new AbortController();
    const p = client.run(job(), { signal: ac.signal });
    workers[0].reply({ type: 'progress', id: 1, stage: 'load', device: 'wasm' });
    workers[0].reply({ type: 'progress', id: 1, stage: 'inference', device: 'wasm' });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortError);
    expect(workers[0].terminated).toBe(true);
    // the next job does not queue behind the abandoned inference
    const p2 = client.run(job());
    expect(workers).toHaveLength(2);
    workers[1].reply(depthResult(2));
    await expect(p2).resolves.toMatchObject({ kind: 'depth' });
  });

  it('keeps the worker when a WASM inference is aborted while another job is pending', async () => {
    const { client, workers } = setup();
    const ac = new AbortController();
    const p1 = client.run(job(), { signal: ac.signal });
    const p2 = client.run(job());
    workers[0].reply({ type: 'progress', id: 1, stage: 'inference', device: 'wasm' });
    ac.abort();
    await expect(p1).rejects.toBeInstanceOf(AbortError);
    expect(workers[0].terminated).toBe(false);
    expect(workers[0].sent.at(-1)!.msg).toEqual({ type: 'cancel', id: 1 });
    workers[0].reply(depthResult(2));
    await expect(p2).resolves.toBeDefined();
  });

  it('keeps the worker when the job is aborted while its session loads', async () => {
    const { client, workers } = setup();
    const ac = new AbortController();
    const p = client.run(job(), { signal: ac.signal });
    workers[0].reply({ type: 'progress', id: 1, stage: 'load', device: 'wasm' });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortError);
    expect(workers[0].terminated).toBe(false);
  });

  it('keeps the worker when other jobs are still pending', async () => {
    const { client, workers } = setup();
    const ac = new AbortController();
    const p1 = client.run(job(), { signal: ac.signal });
    const p2 = client.run(job());
    workers[0].reply({ type: 'progress', id: 1, stage: 'download', ratio: 0.1 });
    ac.abort();
    await expect(p1).rejects.toBeInstanceOf(AbortError);
    expect(workers[0].terminated).toBe(false);
    workers[0].reply(depthResult(2));
    await expect(p2).resolves.toBeDefined();
  });

  it('rejects all pending requests when the worker crashes, then recovers', async () => {
    const { client, workers } = setup();
    const p1 = client.run(job());
    const p2 = client.run(job());
    workers[0].onerror!({ message: 'SyntaxError in worker', preventDefault() {} } as ErrorEvent);
    await expect(p1).rejects.toThrow('ML worker error: SyntaxError in worker');
    await expect(p2).rejects.toThrow('ML worker error');
    expect(workers[0].terminated).toBe(true);
    void client.run(job());
    expect(workers).toHaveLength(2);
  });

  it('terminate() rejects pending requests with AbortError', async () => {
    const { client, workers } = setup();
    const p = client.run(job());
    client.terminate();
    await expect(p).rejects.toBeInstanceOf(AbortError);
    expect(workers[0].terminated).toBe(true);
  });

  it('configure() merges and forwards to a live worker', () => {
    const { client, workers } = setup();
    void client.run(job());
    client.configure({ wasmPrefix: '/ort/' });
    expect(workers[0].sent.at(-1)!.msg).toEqual({ type: 'configure', config: { wasmPrefix: '/ort/' } });
  });
});

describe('MlWorkerClient recovery (ONNX Runtime keeps failures in module state)', () => {
  const ortError = (id: number, name = 'Error'): MlResponse => ({
    type: 'error',
    id,
    error: { name, message: 'failed to call OrtRun(). ERROR_CODE: 2, ERROR_MESSAGE: Reshape mismatch' },
  });

  it('replaces the worker after an error, re-sending the config', async () => {
    const { client, workers } = setup({ remoteHost: 'https://m/' });
    const p1 = client.run({ ...job(), device: 'wasm' });
    workers[0].reply(ortError(1));
    await expect(p1).rejects.toThrow('OrtRun');
    expect(workers[0].terminated).toBe(true);
    const p2 = client.run({ ...job(), device: 'wasm' });
    expect(workers).toHaveLength(2);
    expect(workers[1].sent[0].msg).toEqual({ type: 'configure', config: { remoteHost: 'https://m/' } });
    workers[1].reply(depthResult(2));
    await expect(p2).resolves.toMatchObject({ kind: 'depth' });
  });

  it('keeps the worker after a missing-weights error (raised before ORT runs)', async () => {
    const { client, workers } = setup();
    const p = client.run(job());
    workers[0].reply({ type: 'error', id: 1, error: { name: 'ModelFileNotFoundError', message: 'x/onnx/model.onnx' } });
    await expect(p).rejects.toMatchObject({ name: 'ModelFileNotFoundError' });
    expect(workers[0].terminated).toBe(false);
    void client.run(job());
    expect(workers).toHaveLength(1);
  });

  it('replaces the worker when an aborted job fails there later', async () => {
    const { client, workers } = setup();
    const ac = new AbortController();
    const p = client.run(job(), { signal: ac.signal });
    workers[0].reply({ type: 'progress', id: 1, stage: 'inference', device: 'webgpu' });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortError);
    workers[0].reply(ortError(1, 'WebGpuFailedError'));
    expect(workers[0].terminated).toBe(true);
    void client.run(job());
    expect(workers).toHaveLength(2);
  });

  it('lets jobs in flight on a failed worker settle there, sending new jobs to a fresh one', async () => {
    const { client, workers } = setup();
    const p1 = client.run(job());
    const p2 = client.run(job());
    workers[0].reply(ortError(1));
    await expect(p1).rejects.toThrow('OrtRun');
    expect(workers[0].terminated).toBe(false); // job 2 still runs there
    const p3 = client.run(job());
    expect(workers).toHaveLength(2);
    expect(workers[1].jobs().map((j) => j.id)).toEqual([3]);
    workers[0].reply(depthResult(2));
    await expect(p2).resolves.toBeDefined();
    expect(workers[0].terminated).toBe(true);
    workers[1].reply(depthResult(3));
    await expect(p3).resolves.toBeDefined();
    expect(workers[1].terminated).toBe(false);
  });

  it('retries a WebGPU failure on WASM in a fresh worker, then sends that model straight to WASM', async () => {
    const { client, workers } = setup();
    const progress: string[] = [];
    const input = job();
    input.image.data = new Uint8ClampedArray([9, 8, 7, 255]);
    const p = client.run(input, { onProgress: (e) => progress.push(`${e.stage}@${e.device}`) });
    workers[0].reply({ type: 'progress', id: 1, stage: 'inference', device: 'webgpu' });
    workers[0].reply(ortError(1, 'WebGpuFailedError'));
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
    const retry = workers[1].sent[0];
    expect(retry.msg).toMatchObject({ type: 'depth', id: 1, device: 'wasm', model: input.model, exactSize: true });
    expect([...(retry.msg as { image: { data: Uint8ClampedArray } }).image.data]).toEqual([9, 8, 7, 255]);
    expect(retry.transfer).toHaveLength(1);
    workers[1].reply({ type: 'progress', id: 1, stage: 'inference', device: 'wasm' });
    workers[1].reply(depthResult(1));
    await expect(p).resolves.toMatchObject({ kind: 'depth' });
    expect(progress).toEqual(['inference@webgpu', 'inference@wasm']);
    expect(client.pendingCount).toBe(0);

    // later 'auto' jobs for that model skip WebGPU; other models still try it
    void client.run(job());
    void client.run({ ...job(), model: 'other/model' });
    expect(workers[1].jobs().slice(1).map((j) => [j.model, j.device])).toEqual([
      [input.model, 'wasm'],
      ['other/model', 'auto'],
    ]);
  });

  it('rejects with the WASM error when the retry fails too, and does not pin the model to WASM', async () => {
    const { client, workers } = setup();
    const p = client.run(job());
    workers[0].reply({ type: 'error', id: 1, error: { name: 'WebGpuFailedError', message: 'Failed to fetch' } });
    workers[1].reply({ type: 'error', id: 1, error: { name: 'TypeError', message: 'Failed to fetch dynamically imported module: x' } });
    await expect(p).rejects.toMatchObject({ name: 'TypeError', message: 'Failed to fetch dynamically imported module: x' });
    expect(workers[1].terminated).toBe(true);
    void client.run(job());
    expect(workers[2].jobs()[0].device).toBe('auto');
  });

  it('aborting during the WASM retry rejects and stops the retry worker', async () => {
    const { client, workers } = setup();
    const ac = new AbortController();
    const p = client.run(job(), { signal: ac.signal });
    workers[0].reply(ortError(1, 'WebGpuFailedError'));
    workers[1].reply({ type: 'progress', id: 1, stage: 'inference', device: 'wasm' });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortError);
    expect(workers[1].terminated).toBe(true);
    expect(client.pendingCount).toBe(0);
  });
});

describe('MlWorkerClient stalled downloads', () => {
  afterEach(() => vi.useRealTimers());

  it('kills a worker that stays silent while loading, rejects its jobs and fails fast for a while', async () => {
    vi.useFakeTimers();
    const { client, workers } = setup({ stallTimeoutMs: 1_000 });
    const p = client.run(job()).catch((e: unknown) => e);
    const queued = client.run({ ...job(), model: 'other/model' }).catch((e: unknown) => e);
    workers[0].reply({ type: 'progress', id: 1, stage: 'download', device: 'wasm' });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(workers[0].terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0].terminated).toBe(true);
    expect(((await p) as Error).name).toBe('ModelStalledError');
    expect(((await queued) as Error).name).toBe('ModelStalledError'); // it would have waited behind the stuck load
    expect(client.pendingCount).toBe(0);

    // Remembered: the same model fails at once without a worker round trip…
    const again = await client.run(job()).catch((e: unknown) => e);
    expect((again as Error).name).toBe('ModelStalledError');
    expect(workers).toHaveLength(1);
    // …until the memory expires.
    vi.setSystemTime(Date.now() + STALL_MEMORY_MS);
    const later = client.run(job());
    expect(workers).toHaveLength(2);
    workers[1].reply(depthResult(3));
    await expect(later).resolves.toMatchObject({ kind: 'depth' });
  });

  it('re-arms on every progress message and never times out inference', async () => {
    vi.useFakeTimers();
    const { client, workers } = setup({ stallTimeoutMs: 1_000 });
    const p = client.run(job());
    for (let i = 0; i < 5; i++) {
      workers[0].reply({ type: 'progress', id: 1, stage: 'download', ratio: i / 5, device: 'wasm' });
      await vi.advanceTimersByTimeAsync(1_500);
    }
    workers[0].reply({ type: 'progress', id: 1, stage: 'inference', device: 'wasm' });
    await vi.advanceTimersByTimeAsync(60_000); // long WASM inference
    expect(workers[0].terminated).toBe(false);
    workers[0].reply(depthResult(1));
    await expect(p).resolves.toMatchObject({ kind: 'depth' });
  });

  it("remembers a stall the worker reported and passes the worker's error on", async () => {
    const { client, workers } = setup();
    const p = client.run(job());
    workers[0].reply({ type: 'progress', id: 1, stage: 'download', device: 'wasm' });
    workers[0].reply({ type: 'error', id: 1, error: { name: 'ModelStalledError', message: 'No data from https://hf/x for 30 s' } });
    await expect(p).rejects.toMatchObject({ name: 'ModelStalledError', message: 'No data from https://hf/x for 30 s' });
    await expect(client.run(job())).rejects.toMatchObject({ name: 'ModelStalledError' });
    expect(workers).toHaveLength(1);
    client.terminate();
  });

  it('stallTimeoutMs 0 disables the watchdog', async () => {
    vi.useFakeTimers();
    const { client, workers } = setup({ stallTimeoutMs: 0 });
    const p = client.run(job());
    workers[0].reply({ type: 'progress', id: 1, stage: 'load', device: 'wasm' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(workers[0].terminated).toBe(false);
    workers[0].reply(depthResult(1));
    await expect(p).resolves.toMatchObject({ kind: 'depth' });
  });
});

describe('mlEnvConfigFrom', () => {
  it('reads VITE_MODEL_STALL_MS', () => {
    expect(mlEnvConfigFrom({ VITE_MODEL_STALL_MS: '5000' })).toEqual({ stallTimeoutMs: 5000 });
    expect(mlEnvConfigFrom({ VITE_MODEL_STALL_MS: 'x' })).toEqual({});
  });

  it('reads Vite env vars and ignores empty values', () => {
    expect(mlEnvConfigFrom({ VITE_MODEL_HOST: 'https://m/', VITE_ORT_WASM_PREFIX: '/ort/' })).toEqual({
      remoteHost: 'https://m/',
      wasmPrefix: '/ort/',
    });
    expect(mlEnvConfigFrom({ VITE_MODEL_HOST: '', MODE: 'test' })).toEqual({});
  });
});
