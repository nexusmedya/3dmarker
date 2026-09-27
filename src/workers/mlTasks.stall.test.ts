/**
 * withStallTimeout: model downloads fail with ModelStalledError when a host
 * stops answering (fetch itself never times out), but a slow download that
 * keeps sending bytes, or a slow consumer, never trips it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_STALLED_ERROR } from './mlProtocol';
import { withStallTimeout } from './mlTasks';

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const URL_ = 'https://huggingface.co/m/resolve/main/config.json';

/** A response whose body emits `chunks` bytes, one every `everyMs`, then (optionally) hangs. */
function drip(chunks: number, everyMs: number, hang = false): Response {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull: (ctrl) =>
      new Promise<void>((resolve) => {
        if (sent === chunks) {
          if (!hang) ctrl.close();
          if (!hang) resolve();
          return; // hanging: never resolves
        }
        setTimeout(() => {
          sent++;
          ctrl.enqueue(new Uint8Array([sent]));
          resolve();
        }, everyMs);
      }),
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
}

async function readAll(res: Response): Promise<number[]> {
  const reader = res.body!.getReader();
  const out: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(...value);
  }
}

describe('withStallTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rejects with ModelStalledError when the response headers never arrive, and aborts the request', async () => {
    let signal: AbortSignal | undefined;
    const never: FetchFn = (_u, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    };
    const p = withStallTimeout(never, () => 30_000)(URL_).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = (await p) as Error;
    expect(err.name).toBe(MODEL_STALLED_ERROR);
    expect(err.message).toContain(URL_);
    expect(signal!.aborted).toBe(true);
  });

  it('rejects the body read when bytes stop arriving mid-download', async () => {
    const f = withStallTimeout(async () => drip(3, 1_000, true), () => 5_000);
    const res = await f(URL_);
    const p = readAll(res).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3_000 + 4_999);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(((await p) as Error).name).toBe(MODEL_STALLED_ERROR);
  });

  it('never times out a slow download that keeps sending chunks', async () => {
    const f = withStallTimeout(async () => drip(10, 4_000), () => 5_000); // 40 s in total, 4 s apart
    const res = await f(URL_);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    const p = readAll(res);
    await vi.advanceTimersByTimeAsync(41_000);
    await expect(p).resolves.toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('does not time out while the consumer is not reading', async () => {
    const f = withStallTimeout(async () => drip(2, 10), () => 1_000);
    const res = await f(URL_);
    await vi.advanceTimersByTimeAsync(60_000); // nobody reads: no timer runs
    const p = readAll(res);
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toEqual([1, 2]);
  });

  it('passes through when disabled, and keeps the caller abort working', async () => {
    const res = new Response('x');
    const plain: FetchFn = vi.fn(async () => res);
    expect(await withStallTimeout(plain, () => 0)(URL_)).toBe(res);

    const ac = new AbortController();
    const honoursSignal: FetchFn = (_u, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    const p = withStallTimeout(honoursSignal, () => 30_000)(URL_, { signal: ac.signal }).catch((e: unknown) => e);
    ac.abort(new DOMException('stop', 'AbortError'));
    expect(((await p) as Error).name).toBe('AbortError');
  });
});

describe('initEnv', () => {
  it('routes transformers.js downloads through the stall timeout (configurable)', async () => {
    vi.resetModules();
    const { env } = await import('@huggingface/transformers');
    const saved = env.fetch;
    const never = vi.fn(() => new Promise<Response>(() => {}));
    env.fetch = never;
    vi.useFakeTimers();
    try {
      const tasks = await import('./mlTasks');
      tasks.initEnv();
      tasks.initEnv(); // idempotent: no double wrapping
      tasks.configureEnv({ stallTimeoutMs: 2_000 });
      const p = env.fetch(URL_).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(((await p) as Error).name).toBe(MODEL_STALLED_ERROR);
      expect(never).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      env.fetch = saved;
    }
  });
});
