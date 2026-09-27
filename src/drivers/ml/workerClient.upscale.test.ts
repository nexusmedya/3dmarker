/** The upscale job through MlWorkerClient: tile progress, cancellation between tiles keeps the worker. */
import { describe, expect, it } from 'vitest';
import { AbortError } from '../../core/types';
import type { MlRequest, MlResponse } from '../../workers/mlProtocol';
import { MlWorkerClient, type MlJobInput, type WorkerLike } from './workerClient';

class FakeWorker implements WorkerLike {
  sent: MlRequest[] = [];
  terminated = false;
  onmessage: ((e: MessageEvent<MlResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  postMessage(msg: MlRequest) {
    this.sent.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  reply(msg: MlResponse) {
    this.onmessage?.({ data: msg } as MessageEvent<MlResponse>);
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const client = new MlWorkerClient(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
  return { client, workers };
}

const upscale = (): MlJobInput => ({
  type: 'upscale',
  model: 'Xenova/swin2SR-classical-sr-x2-64',
  device: 'auto',
  precision: 'auto',
  scale: 2,
  image: { width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) },
});

describe('MlWorkerClient upscale jobs', () => {
  it('forwards tile progress and resolves with the image', async () => {
    const { client, workers } = setup();
    const seen: unknown[] = [];
    const p = client.run(upscale(), { onProgress: (x) => seen.push(x) });
    expect(workers[0].sent[0]).toMatchObject({ type: 'upscale', scale: 2 });
    workers[0].reply({ type: 'progress', id: 1, stage: 'inference', device: 'webgpu', done: 1, total: 4 });
    workers[0].reply({
      type: 'result',
      id: 1,
      result: { kind: 'image', data: new Uint8ClampedArray(16), width: 2, height: 2, scale: 2, device: 'webgpu', dtype: 'fp16' },
    });
    await expect(p).resolves.toMatchObject({ kind: 'image', width: 2, scale: 2 });
    expect(seen).toEqual([expect.objectContaining({ done: 1, total: 4 })]);
  });

  it('a WebGPU job cancelled between tiles keeps its worker (the AbortError is not an ORT failure)', async () => {
    const { client, workers } = setup();
    const ac = new AbortController();
    const p = client.run(upscale(), { signal: ac.signal });
    workers[0].reply({ type: 'progress', id: 1, stage: 'inference', device: 'webgpu', done: 1, total: 4 });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortError);
    expect(workers[0].sent.at(-1)).toEqual({ type: 'cancel', id: 1 });
    workers[0].reply({ type: 'error', id: 1, error: { name: 'AbortError', message: 'Upscale cancelled' } });
    expect(workers[0].terminated).toBe(false);
    void client.run(upscale());
    expect(workers).toHaveLength(1);
  });
});
