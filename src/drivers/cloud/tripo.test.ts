import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbortError, defaultParams, type DriverInput, type ParamValues, type Progress } from '../../core/types';
import { LocalizedError } from '../heuristic/inflate';
import { CLIENT_HEADER, MAX_IMAGE_BYTES } from './api';
import { buildTaskForm, createTripoDriver, isGlb, tripoDriver, tripoParamsFrom } from './tripo';

function glb(size = 256): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, size, true);
  return b;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

type Reply = Response | (() => Response) | Error;

/**
 * Stub the global fetch with a scripted server: POST /api/tripo/tasks →
 * `create`, successive status polls → `states`, model download → `model`.
 */
function stubServer(opts: { create?: Reply; states?: Reply[]; model?: Reply; status?: Reply } = {}) {
  const calls: Call[] = [];
  const states = [...(opts.states ?? [json({ status: 'success', progress: 100 })])];
  const answer = (r: Reply): Response => {
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : r.clone(); // replies may be served repeatedly
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body });
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (url === '/api/tripo/status') return answer(opts.status ?? json({ configured: true }));
    if (url === '/api/tripo/tasks') return answer(opts.create ?? json({ taskId: 'task-1' }));
    if (url === '/api/tripo/tasks/task-1') return answer(states.length > 1 ? states.shift()! : states[0]);
    if (url === '/api/tripo/tasks/task-1/model') {
      return answer(opts.model ?? (() => new Response(glb(), { headers: { 'content-length': '256' } })));
    }
    return json({ error: 'Not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

function input(params: ParamValues = {}, file: Blob = new File([new Uint8Array([0x89, 0x50])], 'cat.png', { type: 'image/png' })) {
  const progress: Progress[] = [];
  const ctl = new AbortController();
  const inp: DriverInput = {
    image: { width: 1, height: 1, data: new Uint8ClampedArray(4) },
    mask: null,
    file,
    params: { ...defaultParams(tripoDriver.params), ...params },
    signal: ctl.signal,
    onProgress: (p) => progress.push(p),
  };
  return { inp, progress, ctl };
}

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

const driver = () => createTripoDriver({ pollIntervalMs: 1 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tripoDriver', () => {
  it('declares the cloud contract', () => {
    expect(tripoDriver.id).toBe('tripo3d-cloud');
    expect(tripoDriver.category).toBe('cloud');
    expect(tripoDriver.badges).toEqual(['api-key', 'full-3d', 'closed-mesh']);
    expect(tripoDriver.producesDepth).toBe(false);
    const key = tripoDriver.params.find((p) => p.key === 'apiKey');
    expect(key).toMatchObject({ kind: 'text', secret: true, default: '' });
    expect(defaultParams(tripoDriver.params)).toEqual({ apiKey: '', modelVersion: 'default', texture: true, pbr: true, faceLimit: 0 });
  });

  it('uploads, polls with progress and returns the GLB', async () => {
    const { calls } = stubServer({
      states: [json({ status: 'queued', progress: 0 }), json({ status: 'running', progress: 50 }), json({ status: 'success', progress: 100 })],
    });
    const { inp, progress } = input();
    const res = await driver().run(inp);
    expect(res.kind).toBe('model');
    expect(res.kind === 'model' && new Uint8Array(res.glb)).toEqual(glb());

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/tripo/tasks',
      'GET /api/tripo/tasks/task-1',
      'GET /api/tripo/tasks/task-1',
      'GET /api/tripo/tasks/task-1',
      'GET /api/tripo/tasks/task-1/model',
    ]);
    const form = calls[0].body as FormData;
    expect((form.get('image') as File).name).toBe('cat.png');
    expect(form.get('texture')).toBe('true');
    expect(form.get('pbr')).toBe('true');
    expect(form.has('model_version')).toBe(false);
    expect(form.has('face_limit')).toBe(false);
    expect(calls.every((c) => !c.headers.has('x-tripo-key'))).toBe(true);

    const labels = progress.map((p) => p.label.en);
    expect(labels[0]).toMatch(/Uploading/);
    expect(labels).toContain('Waiting in the Tripo3D queue');
    expect(labels).toContain('Generating 3D model… 50%');
    expect(progress.find((p) => p.label.en.includes('50%'))!.label.tr).toBe('3B model oluşturuluyor… %50');
    expect(labels).toContain('Downloading model');
    expect(labels.at(-1)).toBe('Done');
    const ratios = progress.map((p) => p.ratio ?? 0);
    expect(ratios).toEqual([...ratios].sort((a, b) => a - b));
    expect(ratios.at(-1)).toBe(1);
  });

  it('sends the user key and options on every request', async () => {
    const { calls } = stubServer({ states: [json({ status: 'running', progress: 10 }), json({ status: 'success', progress: 100 })] });
    const { inp } = input({ apiKey: '  tsk_mine_123456  ', modelVersion: 'v2.5-20250123', texture: false, faceLimit: 12345.4 });
    await driver().run(inp);
    expect(calls.map((c) => c.headers.get('x-tripo-key'))).toEqual(Array(calls.length).fill('tsk_mine_123456'));
    const form = calls[0].body as FormData;
    expect(form.get('model_version')).toBe('v2.5-20250123');
    expect(form.get('texture')).toBe('false');
    expect(form.get('face_limit')).toBe('12345');
  });

  it('turns failed and cancelled tasks into bilingual errors', async () => {
    stubServer({ states: [json({ status: 'failed', progress: 3, error: 'The image was rejected by Tripo content moderation' })] });
    const e = await failure(driver().run(input().inp));
    expect(e).toBeInstanceOf(LocalizedError);
    expect((e as LocalizedError).i18n.en).toMatch(/could not generate.*moderation/);
    expect((e as LocalizedError).i18n.tr).toMatch(/model üretemedi/);

    stubServer({ states: [json({ status: 'cancelled', progress: 0 })] });
    const c = await failure(driver().run(input().inp));
    expect((c as LocalizedError).i18n.en).toMatch(/cancelled/);
  });

  it('localises the failure reason instead of echoing the English detail', async () => {
    const cases: [string, string, RegExp][] = [
      ['failed', 'Tripo could not generate a model from this image', /^Tripo3D bu görselden model üretemedi\.$/],
      ['banned', 'The image was rejected by Tripo content moderation', /içerik denetimi/],
      ['expired', 'The task expired on Tripo', /süresi doldu/],
    ];
    const en: string[] = [];
    for (const [reason, error, tr] of cases) {
      stubServer({ states: [json({ status: 'failed', progress: 3, reason, error })] });
      const e = (await failure(driver().run(input().inp))) as LocalizedError;
      expect(e.i18n.tr).toMatch(tr);
      expect(e.i18n.tr).not.toMatch(/Tripo could|rejected|expired on/);
      en.push(e.i18n.en);
    }
    expect(en).toEqual([
      'Tripo3D could not generate a model from this image.',
      'The image was rejected by Tripo3D content moderation.',
      'The task expired on Tripo3D.',
    ]);
  });

  it('maps server errors on task creation', async () => {
    const cases: [Response, RegExp][] = [
      [json({ error: 'no key' }, 401), /No Tripo3D key is configured/],
      [json({ error: 'too big' }, 413), /20 MB/],
      [json({ error: 'bad type' }, 415), /PNG, JPEG or WEBP/],
      [json({ error: 'slow' }, 429, { 'retry-after': '600' }), /in 10 min/],
      [json({ error: 'Tripo refused the request: You need more credits' }, 403), /out of credits.*more credits/],
      [json({ error: 'Tripo API error: boom' }, 502), /Tripo3D error: Tripo API error: boom/],
      [new Response('<html>proxy error</html>', { status: 500 }), /Tripo3D error: HTTP 500/],
    ];
    for (const [res, re] of cases) {
      stubServer({ create: res });
      const e = await failure(driver().run(input().inp));
      expect(e, re.source).toBeInstanceOf(LocalizedError);
      expect((e as LocalizedError).i18n.en).toMatch(re);
    }
    stubServer({ create: json({ error: 'Tripo rejected the API key' }, 401) });
    const rejected = await failure(driver().run(input({ apiKey: 'tsk_wrong_12345' }).inp));
    expect((rejected as LocalizedError).i18n.en).toMatch(/invalid or was rejected/);

    stubServer({ create: new TypeError('Failed to fetch') });
    const down = await failure(driver().run(input().inp));
    expect((down as LocalizedError).i18n.en).toMatch(/Could not reach the API server/);
  });

  it('rejects oversized and unsupported files before uploading', async () => {
    const { calls } = stubServer();
    const big = new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'big.png', { type: 'image/png' });
    expect(((await failure(driver().run(input({}, big).inp))) as LocalizedError).i18n.en).toMatch(/20 MB/);
    const gif = new File([new Uint8Array(8)], 'a.gif', { type: 'image/gif' });
    expect(((await failure(driver().run(input({}, gif).inp))) as LocalizedError).i18n.en).toMatch(/PNG, JPEG or WEBP/);
    expect(calls).toHaveLength(0);
    // Unknown type (empty) is left for the server to sniff.
    await driver().run(input({}, new Blob([new Uint8Array(4)])).inp);
    expect((calls[0].body as FormData).get('image')).toBeInstanceOf(Blob);
  });

  it('tolerates transient polling errors up to the limit', async () => {
    stubServer({
      states: [json({ error: 'x' }, 503), new TypeError('network'), json({ error: 'slow' }, 429), json({ status: 'success', progress: 100 })],
    });
    const res = await createTripoDriver({ pollIntervalMs: 1, maxPollErrors: 3 }).run(input().inp);
    expect(res.kind).toBe('model');

    stubServer({ states: [json({ error: 'x' }, 503), json({ error: 'x' }, 503), json({ error: 'x' }, 503)] });
    const e = await failure(createTripoDriver({ pollIntervalMs: 1, maxPollErrors: 2 }).run(input().inp));
    expect((e as LocalizedError).i18n.en).toMatch(/Tripo3D error/);
  });

  it('fails fast on non-transient polling errors', async () => {
    const { calls } = stubServer({ states: [json({ error: 'Task not found' }, 404)] });
    const e = await failure(driver().run(input().inp));
    expect((e as LocalizedError).i18n.en).toMatch(/Task not found/);
    expect(calls).toHaveLength(2);
  });

  it('stops polling when aborted', async () => {
    const { calls } = stubServer({ states: [json({ status: 'running', progress: 20 })] });
    const { inp, ctl } = input();
    const d = createTripoDriver({ pollIntervalMs: 5 });
    const p = d.run({
      ...inp,
      onProgress: (pr) => {
        if (pr.label.en.includes('20%')) ctl.abort();
      },
    });
    expect(await failure(p)).toBeInstanceOf(AbortError);
    const n = calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(n);
    expect(calls.some((c) => c.url.endsWith('/model'))).toBe(false);
  });

  it('rejects immediately when already aborted', async () => {
    const { calls } = stubServer();
    const { inp, ctl } = input();
    ctl.abort();
    expect(await failure(driver().run(inp))).toBeInstanceOf(AbortError);
    expect(calls).toHaveLength(0);
  });

  it('aborts an in-flight upload', async () => {
    const ctl = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
      ),
    );
    const { inp } = input();
    const p = driver().run({ ...inp, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 5);
    expect(await failure(p)).toBeInstanceOf(AbortError);
  });

  it('gives up after maxWaitMs', async () => {
    stubServer({ states: [json({ status: 'running', progress: 1 })] });
    const e = await failure(createTripoDriver({ pollIntervalMs: 2, maxWaitMs: 20 }).run(input().inp));
    expect((e as LocalizedError).i18n.en).toMatch(/did not finish/);
  });

  it('rejects a download that is not a GLB', async () => {
    stubServer({ model: new Response('<html>oops</html>') });
    const e = await failure(driver().run(input().inp));
    expect((e as LocalizedError).i18n.en).toMatch(/valid GLB/);
  });

  it('downloads without a content-length', async () => {
    stubServer({ model: () => new Response(glb(64)) });
    const res = await driver().run(input().inp);
    expect(res.kind === 'model' && res.glb.byteLength).toBe(64);
  });

  it('sends the client header on every request', async () => {
    const { calls } = stubServer();
    await driver().run(input().inp);
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.every((c) => c.headers.get(CLIENT_HEADER) === '1')).toBe(true);
  });

  it('rejects a malformed own key before sending anything', async () => {
    const { calls } = stubServer();
    for (const apiKey of ['tsk_abc…', '“tsk_abcdefgh”', 'tsk abcdefgh', 'short']) {
      const e = await failure(driver().run(input({ apiKey }).inp));
      expect(e, apiKey).toBeInstanceOf(LocalizedError);
      expect((e as LocalizedError).i18n.en).toMatch(/invalid format/);
      expect((e as LocalizedError).i18n.en).not.toMatch(/Could not reach/);
      expect((e as LocalizedError).i18n.tr).toMatch(/geçersiz biçimde/);
    }
    expect(calls).toHaveLength(0);
    // Invisible characters picked up when copying are dropped.
    await driver().run(input({ apiKey: '\u200Btsk_abcdefgh\u200B\uFEFF ' }).inp);
    expect(calls[0].headers.get('x-tripo-key')).toBe('tsk_abcdefgh');
  });

  describe('model download retries', () => {
    const modelCalls = (calls: Call[]) => calls.filter((c) => c.url.endsWith('/model')).length;
    /** 256-byte GLB whose body breaks off after the first half. */
    const broken = () => {
      const data = glb();
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent) return c.error(new TypeError('terminated'));
          sent = true;
          c.enqueue(data.slice(0, 128));
        },
      });
      return new Response(body, { headers: { 'content-length': '256' } });
    };
    const good = () => new Response(glb(), { headers: { 'content-length': '256' } });
    const sequence = (...replies: (() => Response)[]) => {
      let n = 0;
      return () => replies[Math.min(n++, replies.length - 1)]();
    };

    it('retries a download that breaks off, without creating a new task', async () => {
      const { calls } = stubServer({ model: sequence(broken, good) });
      const { inp, progress } = input();
      const res = await driver().run(inp);
      expect(res.kind === 'model' && new Uint8Array(res.glb)).toEqual(glb());
      expect(modelCalls(calls)).toBe(2);
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
      const ratios = progress.map((p) => p.ratio ?? 0);
      expect(ratios).toEqual([...ratios].sort((a, b) => a - b));
      expect(ratios.at(-1)).toBe(1);
    });

    it('retries 5xx and 429 answers', async () => {
      const { calls } = stubServer({
        model: sequence(
          () => json({ error: 'Model download failed (HTTP 503)' }, 502),
          () => json({ error: 'Too many requests' }, 429, { 'retry-after': '0' }),
          good,
        ),
      });
      expect((await driver().run(input().inp)).kind).toBe('model');
      expect(modelCalls(calls)).toBe(3);
    });

    it('says the download broke off (not that the server is unreachable) once the retries are used up', async () => {
      const { calls } = stubServer({ model: broken });
      const e = await failure(createTripoDriver({ pollIntervalMs: 1, maxDownloadAttempts: 3 }).run(input().inp));
      expect((e as LocalizedError).i18n.en).toMatch(/download was interrupted/);
      expect((e as LocalizedError).i18n.en).not.toMatch(/API server/);
      expect((e as LocalizedError).i18n.tr).toMatch(/indirmesi yarıda kesildi/);
      expect(modelCalls(calls)).toBe(3);

      const down = stubServer({ model: new TypeError('Failed to fetch') });
      const d = await failure(driver().run(input().inp));
      expect((d as LocalizedError).i18n.en).toMatch(/download was interrupted/);
      expect(modelCalls(down.calls)).toBe(3);
    });

    it('does not retry definitive answers', async () => {
      for (const [reply, re] of [
        [json({ error: 'Task not found' }, 404), /Task not found/],
        [json({ error: 'Tripo rejected the API key' }, 401), /No Tripo3D key/],
        [new Response('<html>oops</html>'), /valid GLB/],
      ] as const) {
        const { calls } = stubServer({ model: reply });
        const e = await failure(driver().run(input().inp));
        expect((e as LocalizedError).i18n.en).toMatch(re);
        expect(modelCalls(calls)).toBe(1);
      }
    });

    it('can be aborted while waiting to retry', async () => {
      const { calls } = stubServer({ model: broken });
      const { inp, ctl } = input();
      const d = createTripoDriver({ pollIntervalMs: 1, downloadRetryDelayMs: 10_000 });
      const p = d.run({
        ...inp,
        onProgress: (pr) => {
          if (pr.label.en === 'Downloading model') setTimeout(() => ctl.abort(), 20);
        },
      });
      expect(await failure(p)).toBeInstanceOf(AbortError);
      expect(modelCalls(calls)).toBe(1);
    });
  });
});

describe('tripoDriver.isAvailable', () => {
  it('is available with a server key', async () => {
    stubServer({ status: json({ configured: true }) });
    expect(await tripoDriver.isAvailable!()).toEqual({ ok: true });
  });

  it('is available but explains that a key is needed without one', async () => {
    stubServer({ status: json({ configured: false }) });
    const a = await tripoDriver.isAvailable!();
    expect(a.ok).toBe(true);
    expect(a.reason?.en).toMatch(/enter your own API key/);
    expect(a.reason?.tr).toMatch(/kendi API anahtarınızı/);
  });

  it('is unavailable when the API server is unreachable', async () => {
    stubServer({ status: new TypeError('Failed to fetch') });
    expect((await tripoDriver.isAvailable!()).ok).toBe(false);
    stubServer({ status: new Response('<html>', { status: 502 }) });
    const a = await tripoDriver.isAvailable!();
    expect(a).toEqual({ ok: false, reason: expect.objectContaining({ en: expect.stringMatching(/API server/) }) });
  });
});

describe('helpers', () => {
  it('tripoParamsFrom falls back to defaults', () => {
    expect(tripoParamsFrom({ faceLimit: -5, texture: 'yes', modelVersion: '' })).toEqual({
      apiKey: '',
      modelVersion: 'default',
      texture: true,
      pbr: true,
      faceLimit: 0,
    });
  });

  it('buildTaskForm names anonymous blobs', () => {
    const form = buildTaskForm(new Blob([new Uint8Array(1)]), tripoParamsFrom({}));
    expect((form.get('image') as File).name).toBe('image');
  });

  it('isGlb', () => {
    expect(isGlb(glb().buffer)).toBe(true);
    expect(isGlb(new ArrayBuffer(4))).toBe(false);
    expect(isGlb(new TextEncoder().encode('glTF\x01\0\0\0xxxx').buffer as ArrayBuffer)).toBe(false);
  });
});
