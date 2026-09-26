import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_HOSTS,
  DEFAULT_MULTIVIEW_ORDER,
  TripoClient,
  TripoError,
  isTrustedModelUrl,
  openModelDownload,
  parseHostList,
  parseMultiviewOrder,
  redactSecrets,
  resolveModelUrl,
} from './tripo';

const KEY = 'tsk_providerTestKey_123';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function client(handler: (url: string, init: RequestInit) => Response | Promise<Response>, timeouts = {}) {
  const urls: string[] = [];
  const c = new TripoClient({
    apiKey: KEY,
    baseUrl: 'https://tripo.test/v2/openapi/',
    timeouts,
    fetch: async (input, init) => {
      urls.push(String(input));
      return handler(String(input), init ?? {});
    },
  });
  return { c, urls };
}

async function rejection(p: Promise<unknown>): Promise<TripoError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TripoError);
    return e as TripoError;
  }
  throw new Error('expected a rejection');
}

describe('TripoClient', () => {
  it('uploads, falling back to /upload/sts when /upload is missing', async () => {
    const { c, urls } = client((url) =>
      url.endsWith('/upload') ? json({ code: 404, message: 'no route' }, 404) : json({ code: 0, data: { file_token: 'ft' } }),
    );
    expect(await c.uploadImage(new Uint8Array([1, 2, 3]), 'image/jpeg')).toBe('ft');
    expect(urls).toEqual(['https://tripo.test/v2/openapi/upload', 'https://tripo.test/v2/openapi/upload/sts']);
  });

  it('does not fall back on other errors', async () => {
    const { c, urls } = client(() => json({ code: 1002, message: 'bad auth' }, 401));
    const e = await rejection(c.uploadImage(new Blob(['x']), 'image/png'));
    expect(e.kind).toBe('http');
    expect(e.httpStatus).toBe(401);
    expect(e.code).toBe(1002);
    expect(urls).toHaveLength(1);
  });

  it('sends the documented task body', async () => {
    let body: unknown;
    const { c } = client((_url, init) => {
      body = JSON.parse(init.body as string);
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
      return json({ code: 0, data: { task_id: 't-1' } });
    });
    expect(await c.createImageToModelTask('tok', { fileType: 'png', faceLimit: 0, texture: true })).toBe('t-1');
    expect(body).toEqual({ type: 'image_to_model', file: { type: 'png', file_token: 'tok' }, texture: true });
  });

  it('sends the multi-view task body: four files in order, {} for missing views', async () => {
    let body: unknown;
    const { c } = client((_url, init) => {
      body = JSON.parse(init.body as string);
      return json({ code: 0, data: { task_id: 'mv-1' } });
    });
    const files = { front: { fileType: 'png' as const, fileToken: 'f' }, back: { fileType: 'jpg' as const, fileToken: 'b' } };
    expect(await c.createMultiviewToModelTask(files, { modelVersion: 'v2.5-20250123', pbr: false, faceLimit: 10000 })).toBe('mv-1');
    expect(body).toEqual({
      type: 'multiview_to_model',
      files: [{ type: 'png', file_token: 'f' }, {}, { type: 'jpg', file_token: 'b' }, {}],
      model_version: 'v2.5-20250123',
      pbr: false,
      face_limit: 10000,
    });
    await c.createMultiviewToModelTask(files, {}, undefined, ['front', 'right', 'back', 'left']);
    expect((body as { files: unknown[] }).files).toEqual([{ type: 'png', file_token: 'f' }, {}, { type: 'jpg', file_token: 'b' }, {}]);
    await c.createMultiviewToModelTask({ ...files, left: { fileType: 'webp', fileToken: 'l' } }, {}, undefined, ['front', 'right', 'back', 'left']);
    expect((body as { files: unknown[] }).files[3]).toEqual({ type: 'webp', file_token: 'l' });
    const e = await rejection(c.createMultiviewToModelTask({ back: files.back }, {}));
    expect(e.message).toMatch(/front/);
  });

  it('parseMultiviewOrder accepts only permutations of the four views', () => {
    expect(DEFAULT_MULTIVIEW_ORDER).toEqual(['front', 'left', 'back', 'right']);
    expect(parseMultiviewOrder(' Front, right ,back,left')).toEqual(['front', 'right', 'back', 'left']);
    expect(parseMultiviewOrder(undefined)).toBeNull();
    expect(parseMultiviewOrder('front,left,back')).toBeNull();
    expect(parseMultiviewOrder('front,left,back,back')).toBeNull();
    expect(parseMultiviewOrder('front,left,back,top')).toBeNull();
  });

  it('normalises task responses', async () => {
    const { c, urls } = client(() => json({ code: 0, data: { status: 'running', progress: 250, output: null } }));
    expect(await c.getTask('abc')).toEqual({ task_id: 'abc', type: undefined, status: 'running', progress: 100, output: {} });
    expect(urls[0]).toBe('https://tripo.test/v2/openapi/task/abc');
  });

  it('treats a non-zero code on HTTP 200 as an API error and redacts the key', async () => {
    const { c } = client(() => json({ code: 2010, message: `no credits for ${KEY}`, suggestion: 'buy more' }));
    const e = await rejection(c.getTask('abc'));
    expect(e.kind).toBe('api');
    expect(e.code).toBe(2010);
    expect(e.message).toBe('no credits for [redacted] (buy more) [code 2010]');
  });

  it('flags invalid responses', async () => {
    expect((await rejection(client(() => new Response('<html>')).c.getTask('a'))).kind).toBe('invalid-response');
    expect((await rejection(client(() => json({ code: 0, data: {} })).c.getTask('a'))).kind).toBe('invalid-response');
    expect((await rejection(client(() => json({ code: 0, data: {} })).c.createImageToModelTask('t', { fileType: 'png' }))).kind).toBe(
      'invalid-response',
    );
  });

  it('times out', async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    const e = await rejection(client(hang, { requestMs: 5 }).c.getTask('a'));
    expect(e.kind).toBe('timeout');
  });

  it('distinguishes caller aborts and network failures', async () => {
    const ctl = new AbortController();
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    const p = client(hang).c.getTask('a', ctl.signal);
    ctl.abort();
    expect((await rejection(p)).kind).toBe('aborted');
    const down = client(() => Promise.reject(new TypeError('fetch failed')));
    expect((await rejection(down.c.getTask('a'))).kind).toBe('network');
  });
});

describe('model URL helpers', () => {
  it('resolveModelUrl prefers pbr_model, then model, then base_model', () => {
    expect(resolveModelUrl({ output: { model: 'm', pbr_model: 'p', base_model: 'b' } })).toBe('p');
    expect(resolveModelUrl({ output: { model: 'm', base_model: 'b' } })).toBe('m');
    expect(resolveModelUrl({ output: { base_model: { url: 'b' } } })).toBe('b');
    expect(resolveModelUrl({ output: { rendered_image: 'r', model: '' } })).toBeNull();
  });

  it('isTrustedModelUrl matches exact hosts and subdomains over https only', () => {
    const ok = (u: string) => isTrustedModelUrl(new URL(u), DEFAULT_MODEL_HOSTS);
    expect(ok('https://tripo3d.ai/a.glb')).toBe(true);
    expect(ok('https://tripo-data.rg1.data.tripo3d.com/a.glb?x=1')).toBe(true);
    expect(ok('https://tripo-data.cdn.bcebos.com/a.glb')).toBe(true);
    expect(ok('https://TRIPO3D.AI./a.glb')).toBe(true);
    expect(ok('https://other.cdn.bcebos.com/a.glb')).toBe(false);
    expect(ok('https://eviltripo3d.ai/a.glb')).toBe(false);
    expect(ok('https://tripo3d.ai.evil.com/a.glb')).toBe(false);
    expect(ok('http://tripo3d.ai/a.glb')).toBe(false);
    expect(ok('https://a:b@tripo3d.ai/a.glb')).toBe(false);
  });

  it('parseHostList', () => {
    expect(parseHostList(undefined)).toBeNull();
    expect(parseHostList('  ')).toBeNull();
    expect(parseHostList('A.com, *.b.org ,,.c.net')).toEqual(['a.com', 'b.org', 'c.net']);
  });

  it('redactSecrets', () => {
    expect(redactSecrets('key=abc123 and tsk_Other-9', ['abc123'])).toBe('key=[redacted] and [redacted]');
    expect(redactSecrets('x'.repeat(400))).toHaveLength(301);
  });

  it('openModelDownload stops after too many redirects', async () => {
    let n = 0;
    const loop: typeof fetch = async () => {
      n++;
      return new Response(null, { status: 302, headers: { location: `https://tripo3d.ai/r${n}` } });
    };
    const e = await rejection(openModelDownload('https://tripo3d.ai/start', { allowedHosts: ['tripo3d.ai'], fetch: loop, maxRedirects: 2 }));
    expect(e.message).toMatch(/redirects/);
    expect(n).toBe(3);
  });
});

describe('openModelDownload timeouts', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Upstream whose body yields `chunks` chunks, `gapMs` apart, then stalls if `stall`. Errors like undici when aborted. */
  function cdn(up: { chunks: number; gapMs: number; stall?: boolean; headersAfterMs?: number }) {
    const state = { sent: 0, cancelled: false, fetches: 0, settled: 0 };
    const f: typeof fetch = async (_input, init) => {
      state.fetches++;
      const signal = init?.signal ?? undefined;
      const abortable = <T>(p: Promise<T>) =>
        new Promise<T>((resolve, reject) => {
          if (signal?.aborted) return reject(signal.reason);
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          p.then(resolve, reject);
        });
      if (up.headersAfterMs) await abortable(sleep(up.headersAfterMs));
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(c) {
            if (state.sent >= up.chunks) {
              if (up.stall) await abortable(new Promise(() => {}));
              return c.close();
            }
            await abortable(sleep(up.gapMs));
            state.sent++;
            c.enqueue(new Uint8Array(8).fill(state.sent));
          },
          cancel() {
            state.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { headers: { 'content-length': String(up.chunks * 8) } });
    };
    const opts = (extra: object = {}) => ({
      allowedHosts: ['tripo3d.ai'],
      fetch: f,
      timeoutMs: 40,
      idleTimeoutMs: 60,
      onSettled: () => void state.settled++,
      ...extra,
    });
    return { opts, state };
  }

  it('lets a slow but steady body run past the header timeout', async () => {
    const { opts, state } = cdn({ chunks: 8, gapMs: 15 }); // ~120 ms in total, 3× the header timeout
    const res = await openModelDownload('https://tripo3d.ai/m.glb', opts());
    expect(res.headers.get('content-length')).toBe('64');
    expect(state.settled).toBe(0);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.byteLength).toBe(64);
    expect(buf[63]).toBe(8);
    expect(state.cancelled).toBe(false);
    expect(state.settled).toBe(1);
  });

  it('fails a body that stalls longer than the idle timeout', async () => {
    const { opts, state } = cdn({ chunks: 2, gapMs: 5, stall: true });
    const res = await openModelDownload('https://tripo3d.ai/m.glb', opts());
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect((await reader.read()).done).toBe(false);
    const e = await rejection(reader.read());
    expect(e.kind).toBe('timeout');
    expect(state.cancelled).toBe(true);
    expect(state.settled).toBe(1);
  });

  it('still caps the whole transfer', async () => {
    const { opts } = cdn({ chunks: 100, gapMs: 10 });
    const res = await openModelDownload('https://tripo3d.ai/m.glb', opts({ totalTimeoutMs: 80 }));
    expect((await rejection(res.arrayBuffer())).kind).toBe('timeout');
  });

  it('times out when the headers never arrive', async () => {
    const { opts, state } = cdn({ chunks: 1, gapMs: 1, headersAfterMs: 10_000 });
    const started = Date.now();
    const e = await rejection(openModelDownload('https://tripo3d.ai/m.glb', opts()));
    expect(e.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(state.settled).toBe(1);
    // Refused hosts settle too.
    await rejection(openModelDownload('https://evil.example/m.glb', opts()));
    expect(state.settled).toBe(2);
    expect(state.fetches).toBe(1);
  });

  it('cancels the upstream when the caller aborts mid-body', async () => {
    const ctl = new AbortController();
    const { opts, state } = cdn({ chunks: 50, gapMs: 5 });
    const res = await openModelDownload('https://tripo3d.ai/m.glb', opts({ signal: ctl.signal }));
    const reader = res.body!.getReader();
    await reader.read();
    ctl.abort();
    expect((await rejection(reader.read())).kind).toBe('aborted');
    expect(state.cancelled).toBe(true);
    expect(state.settled).toBe(1);
    const sent = state.sent;
    await sleep(30);
    expect(state.sent).toBe(sent);
  });
});
