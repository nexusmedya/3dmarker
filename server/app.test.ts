import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES } from '../src/drivers/cloud/api';
import { createApp, parseTaskFields, rateKeyForIp, toTaskState, type ServerEnv } from './app';

const SERVER_KEY = 'tsk_serverSecret_9f8e7d6c5b';
const USER_KEY = 'tsk_userSecret_1a2b3c4d5e';
const API = 'https://api.tripo3d.ai/v2/openapi';
const MODEL_URL = 'https://tripo-data.rg1.data.tripo3d.com/tcli_x/model.glb?auth_key=signed123';

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const GIF_HEAD = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0];
const WEBP_HEAD = [0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];

function bytes(head: number[], size = 64): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(Math.max(size, head.length));
  b.set(head);
  return b;
}

function glb(size = 64): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, size, true);
  for (let i = 12; i < size; i++) b[i] = i & 0xff;
  return b;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  redirect?: RequestRedirect;
}

interface TripoState {
  status: string;
  progress: number;
  output: Record<string, unknown>;
}

/** Fake Tripo API + CDN. `override` can answer any request first. */
function mockTripo(opts: { task?: Partial<TripoState>; override?: (c: Call) => Response | undefined } = {}) {
  const calls: Call[] = [];
  const task: TripoState = { status: 'success', progress: 100, output: { pbr_model: MODEL_URL }, ...opts.task };
  const fetchMock: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
      redirect: init?.redirect,
    };
    calls.push(call);
    const custom = opts.override?.(call);
    if (custom) return custom;
    if (url === `${API}/upload` && call.method === 'POST') return json({ code: 0, data: { image_token: 'img-token-1' } });
    if (url === `${API}/task` && call.method === 'POST') return json({ code: 0, data: { task_id: 'task-123' } });
    const m = url.match(/\/task\/([^/?]+)$/);
    if (m && url.startsWith(API)) return json({ code: 0, data: { task_id: m[1], type: 'image_to_model', ...task } });
    if (url === MODEL_URL) return new Response(glb(), { headers: { 'content-length': '64' } });
    return new Response('not found', { status: 404 });
  };
  return { fetch: fetchMock, calls, task };
}

interface Setup {
  env?: ServerEnv;
  task?: Partial<TripoState>;
  override?: (c: Call) => Response | undefined;
  now?: () => number;
}

function setup(s: Setup = {}) {
  const tripo = mockTripo({ task: s.task, override: s.override });
  const logs: string[] = [];
  const logger = {
    info: (...a: unknown[]) => void logs.push(a.join(' ')),
    warn: (...a: unknown[]) => void logs.push(a.join(' ')),
    error: (...a: unknown[]) => void logs.push(a.join(' ')),
  };
  const app = createApp({ fetch: tripo.fetch, env: s.env ?? {}, logger, now: s.now });
  const bodies: string[] = [];
  /** app.request that also records every response body (for the "no key leaks" checks). */
  const request = async (path: string, init?: RequestInit) => {
    const res = await app.request(path, init);
    const buf = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(buf);
    bodies.push(text);
    return { res, status: res.status, text, buf, json: () => JSON.parse(text) };
  };
  return { app, request, calls: tripo.calls, task: tripo.task, logs, bodies };
}

function imageForm(data: Uint8Array<ArrayBuffer> = bytes(PNG_HEAD), type = 'image/png', fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append('image', new Blob([data], { type }), 'photo.png');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
}

const post = (form: FormData, headers: Record<string, string> = {}): RequestInit => ({ method: 'POST', body: form, headers });

describe('health and status', () => {
  it('reports health', async () => {
    const { request } = setup();
    const r = await request('/api/health');
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(r.res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.res.headers.get('cache-control')).toBe('no-store');
  });

  it('reports whether the server has a key', async () => {
    expect((await setup().request('/api/tripo/status')).json()).toEqual({ configured: false });
    expect((await setup({ env: { TRIPO_API_KEY: '   ' } }).request('/api/tripo/status')).json()).toEqual({ configured: false });
    expect((await setup({ env: { TRIPO_API_KEY: SERVER_KEY } }).request('/api/tripo/status')).json()).toEqual({ configured: true });
  });

  it('answers unknown API paths with a JSON 404', async () => {
    const r = await setup().request('/api/nope');
    expect(r.status).toBe(404);
    expect(r.json()).toEqual({ error: 'Not found' });
  });

  it('sends COEP only when cross-origin isolation is enabled', async () => {
    const off = await setup().request('/api/health');
    expect(off.res.headers.get('cross-origin-embedder-policy')).toBeNull();
    const on = await setup({ env: { CROSS_ORIGIN_ISOLATION: '1' } }).request('/api/health');
    expect(on.res.headers.get('cross-origin-embedder-policy')).toBe('credentialless');
    expect(on.res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });
});

describe('POST /api/tripo/tasks', () => {
  it('returns 401 without any key and never calls Tripo', async () => {
    const { request, calls } = setup();
    const r = await request('/api/tripo/tasks', post(imageForm()));
    expect(r.status).toBe(401);
    expect(r.json().error).toMatch(/key/i);
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed user key', async () => {
    const { request, calls } = setup();
    const r = await request('/api/tripo/tasks', post(imageForm(), { 'x-tripo-key': 'short' }));
    expect(r.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('uploads and creates a task with the server key (happy path)', async () => {
    const { request, calls } = setup({ env: { TRIPO_API_KEY: SERVER_KEY } });
    const r = await request(
      '/api/tripo/tasks',
      post(imageForm(bytes(PNG_HEAD), 'image/png', { model_version: 'v2.5-20250123', texture: 'false', pbr: 'true', face_limit: '20000' })),
    );
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ taskId: 'task-123' });

    const [upload, create] = calls;
    expect(upload.url).toBe(`${API}/upload`);
    expect(upload.headers.get('authorization')).toBe(`Bearer ${SERVER_KEY}`);
    const file = (upload.body as FormData).get('file') as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe('image/png');
    expect(file.size).toBe(64);

    expect(create.url).toBe(`${API}/task`);
    expect(create.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(create.body as string)).toEqual({
      type: 'image_to_model',
      file: { type: 'png', file_token: 'img-token-1' },
      model_version: 'v2.5-20250123',
      texture: false,
      pbr: true,
      face_limit: 20000,
    });
    expect(r.res.headers.get('x-ratelimit-limit')).toBe('10');
    expect(r.res.headers.get('x-ratelimit-remaining')).toBe('9');
  });

  it('omits defaulted optional fields', async () => {
    const { request, calls } = setup({ env: { TRIPO_API_KEY: SERVER_KEY } });
    await request('/api/tripo/tasks', post(imageForm(bytes(WEBP_HEAD), 'application/octet-stream', { model_version: 'default', face_limit: '0' })));
    expect(JSON.parse(calls[1].body as string)).toEqual({ type: 'image_to_model', file: { type: 'webp', file_token: 'img-token-1' } });
  });

  it('accepts the user key header when the server has none', async () => {
    const { request, calls } = setup();
    const r = await request('/api/tripo/tasks', post(imageForm(), { 'x-tripo-key': USER_KEY }));
    expect(r.status).toBe(200);
    expect(calls.every((c) => c.headers.get('authorization') === `Bearer ${USER_KEY}`)).toBe(true);
  });

  it('ignores the user key when the server has one', async () => {
    const { request, calls } = setup({ env: { TRIPO_API_KEY: SERVER_KEY } });
    await request('/api/tripo/tasks', post(imageForm(), { 'x-tripo-key': USER_KEY }));
    expect(calls.map((c) => c.headers.get('authorization'))).toEqual([`Bearer ${SERVER_KEY}`, `Bearer ${SERVER_KEY}`]);
  });

  it('sniffs magic bytes instead of trusting the declared type', async () => {
    const { request, calls } = setup({ env: { TRIPO_API_KEY: SERVER_KEY } });
    const gif = await request('/api/tripo/tasks', post(imageForm(bytes(GIF_HEAD), 'image/png')));
    expect(gif.status).toBe(415);
    expect(gif.json().error).toMatch(/PNG, JPEG or WEBP/);
    const jpeg = await request('/api/tripo/tasks', post(imageForm(bytes([0xff, 0xd8, 0xff, 0xe0]), 'image/gif')));
    expect(jpeg.status).toBe(200);
    expect(JSON.parse(calls[1].body as string).file.type).toBe('jpg');
  });

  it('requires an image file', async () => {
    const { request, calls } = setup({ env: { TRIPO_API_KEY: SERVER_KEY } });
    const form = new FormData();
    form.append('image', 'not a file');
    expect((await request('/api/tripo/tasks', post(form))).status).toBe(400);
    expect((await request('/api/tripo/tasks', post(new FormData()))).status).toBe(400);
    const empty = await request('/api/tripo/tasks', post(imageForm(new Uint8Array(0))));
    expect(empty.status).toBe(400);
    const jsonBody = await request('/api/tripo/tasks', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(jsonBody.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('validates optional fields', async () => {
    const { request, calls } = setup({ env: { TRIPO_API_KEY: SERVER_KEY } });
    const invalid: Record<string, string>[] = [{ texture: 'yes' }, { face_limit: '-5' }, { face_limit: '2000001' }, { model_version: 'v1 ; rm -rf' }];
    for (const fields of invalid) {
      const r = await request('/api/tripo/tasks', post(imageForm(bytes(PNG_HEAD), 'image/png', fields)));
      expect(r.status, JSON.stringify(fields)).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('enforces the 20 MB limit', async () => {
    const { request, calls } = setup({ env: { TRIPO_API_KEY: SERVER_KEY } });
    const justOver = await request('/api/tripo/tasks', post(imageForm(bytes(PNG_HEAD, MAX_IMAGE_BYTES + 1))));
    expect(justOver.status).toBe(413);
    expect(justOver.json().error).toMatch(/20 MB/);
    const wayOver = await request('/api/tripo/tasks', post(imageForm(bytes(PNG_HEAD, MAX_IMAGE_BYTES + 512 * 1024))));
    expect(wayOver.status).toBe(413);
    expect(wayOver.json()).toHaveProperty('error');
    expect(calls).toHaveLength(0);
    const ok = await request('/api/tripo/tasks', post(imageForm(bytes(PNG_HEAD, MAX_IMAGE_BYTES))));
    expect(ok.status).toBe(200);
  });

  it('refuses cross-site browser requests', async () => {
    const { request, calls } = setup({ env: { TRIPO_API_KEY: SERVER_KEY } });
    const r = await request('/api/tripo/tasks', post(imageForm(), { 'sec-fetch-site': 'cross-site' }));
    expect(r.status).toBe(403);
    expect(calls).toHaveLength(0);
    const same = await request('/api/tripo/tasks', post(imageForm(), { 'sec-fetch-site': 'same-origin' }));
    expect(same.status).toBe(200);
  });

  it('rate-limits task creation per client and window', async () => {
    let t = 1_000_000;
    const { request, calls } = setup({ env: { TRIPO_API_KEY: SERVER_KEY, TRIPO_RATE_LIMIT: '2', TRIPO_RATE_WINDOW_SEC: '60' }, now: () => t });
    expect((await request('/api/tripo/tasks', post(imageForm()))).status).toBe(200);
    expect((await request('/api/tripo/tasks', post(imageForm()))).status).toBe(200);
    const blocked = await request('/api/tripo/tasks', post(imageForm()));
    expect(blocked.status).toBe(429);
    expect(blocked.res.headers.get('retry-after')).toBe('60');
    expect(blocked.json().error).toMatch(/try again/);
    expect(calls).toHaveLength(4); // blocked request never reached Tripo
    t += 30_000;
    expect((await request('/api/tripo/tasks', post(imageForm()))).res.headers.get('retry-after')).toBe('30');
    t += 30_000;
    expect((await request('/api/tripo/tasks', post(imageForm()))).status).toBe(200);
  });

  it('does not count invalid uploads against the limit', async () => {
    const { request } = setup({ env: { TRIPO_API_KEY: SERVER_KEY, TRIPO_RATE_LIMIT: '1' } });
    expect((await request('/api/tripo/tasks', post(imageForm(bytes(GIF_HEAD))))).status).toBe(415);
    expect((await request('/api/tripo/tasks', post(imageForm()))).status).toBe(200);
    expect((await request('/api/tripo/tasks', post(imageForm()))).status).toBe(429);
  });

  it('keeps separate budgets per forwarded client IP when TRUST_PROXY is set', async () => {
    const { request } = setup({ env: { TRIPO_API_KEY: SERVER_KEY, TRIPO_RATE_LIMIT: '1', TRUST_PROXY: '1' } });
    const from = (ip: string) => post(imageForm(), { 'x-forwarded-for': `6.6.6.6, ${ip}` });
    expect((await request('/api/tripo/tasks', from('10.0.0.1'))).status).toBe(200);
    expect((await request('/api/tripo/tasks', from('10.0.0.1'))).status).toBe(429);
    expect((await request('/api/tripo/tasks', from('10.0.0.2'))).status).toBe(200);
  });

  it('uses a separate, larger budget for user keys', async () => {
    const { request } = setup({ env: { TRIPO_RATE_LIMIT: '1', TRIPO_RATE_LIMIT_BYOK: '2' } });
    const withKey = () => post(imageForm(), { 'x-tripo-key': USER_KEY });
    expect((await request('/api/tripo/tasks', withKey())).status).toBe(200);
    expect((await request('/api/tripo/tasks', withKey())).status).toBe(200);
    expect((await request('/api/tripo/tasks', withKey())).status).toBe(429);
  });

  it('maps upstream errors', async () => {
    const reject = (status: number, body: unknown) => (c: Call) => (c.url.endsWith('/task') ? json(body, status) : undefined);
    const user = setup({ override: reject(401, { code: 1002, message: 'Authentication failed' }) });
    const u = await user.request('/api/tripo/tasks', post(imageForm(), { 'x-tripo-key': USER_KEY }));
    expect(u.status).toBe(401);
    expect(u.json().error).toBe('Tripo rejected the API key');

    const server = setup({ env: { TRIPO_API_KEY: SERVER_KEY }, override: reject(401, { code: 1002, message: 'Authentication failed' }) });
    expect((await server.request('/api/tripo/tasks', post(imageForm()))).status).toBe(502);
    expect(server.logs.join('\n')).toMatch(/rejected the server API key/);

    const credits = setup({ env: { TRIPO_API_KEY: SERVER_KEY }, override: reject(403, { code: 2010, message: 'You need more credits' }) });
    const cr = await credits.request('/api/tripo/tasks', post(imageForm()));
    expect(cr.status).toBe(403);
    expect(cr.json().error).toMatch(/more credits.*code 2010/);

    const apiErr = setup({ env: { TRIPO_API_KEY: SERVER_KEY }, override: reject(200, { code: 2004, message: 'File type unsupported' }) });
    const ae = await apiErr.request('/api/tripo/tasks', post(imageForm()));
    expect(ae.status).toBe(502);
    expect(ae.json().error).toMatch(/File type unsupported/);

    const limited = setup({ env: { TRIPO_API_KEY: SERVER_KEY }, override: reject(429, { code: 2000, message: 'slow down' }) });
    expect((await limited.request('/api/tripo/tasks', post(imageForm()))).status).toBe(429);

    const down = setup({
      env: { TRIPO_API_KEY: SERVER_KEY },
      override: () => {
        throw new TypeError('fetch failed');
      },
    });
    const d = await down.request('/api/tripo/tasks', post(imageForm()));
    expect(d.status).toBe(502);
    expect(d.json()).toEqual({ error: 'Could not reach the Tripo API' });
  });
});

describe('GET /api/tripo/tasks/:id', () => {
  it('maps task states', async () => {
    const cases: [Partial<TripoState>, object][] = [
      [{ status: 'queued', progress: 0 }, { status: 'queued', progress: 0 }],
      [{ status: 'running', progress: 42.4 }, { status: 'running', progress: 42 }],
      [{ status: 'success', progress: 99 }, { status: 'success', progress: 100 }],
      [{ status: 'failed', progress: 10 }, { status: 'failed', progress: 10, error: expect.any(String) }],
      [{ status: 'cancelled', progress: 10 }, { status: 'cancelled', progress: 10, error: expect.any(String) }],
      [{ status: 'banned', progress: 0 }, { status: 'failed', progress: 0, error: expect.stringMatching(/moderation/) }],
      [{ status: 'expired', progress: 0 }, { status: 'failed', progress: 0, error: expect.stringMatching(/expired/) }],
      [{ status: 'something-new', progress: 7 }, { status: 'unknown', progress: 7 }],
    ];
    for (const [task, expected] of cases) {
      const { request, calls } = setup({ env: { TRIPO_API_KEY: SERVER_KEY }, task });
      const r = await request('/api/tripo/tasks/task-123');
      expect(r.status).toBe(200);
      expect(r.json()).toEqual(expected);
      expect(calls[0].url).toBe(`${API}/task/task-123`);
    }
  });

  it('accepts the user key on GET routes', async () => {
    const { request, calls } = setup({ task: { status: 'running', progress: 5 } });
    expect((await request('/api/tripo/tasks/task-123')).status).toBe(401);
    const r = await request('/api/tripo/tasks/task-123', { headers: { 'x-tripo-key': USER_KEY } });
    expect(r.json()).toEqual({ status: 'running', progress: 5 });
    expect(calls[0].headers.get('authorization')).toBe(`Bearer ${USER_KEY}`);
  });

  it('rejects malformed ids and maps unknown tasks to 404', async () => {
    const { request, calls } = setup({
      env: { TRIPO_API_KEY: SERVER_KEY },
      override: (c) => (c.url.includes('/task/missing') ? json({ code: 2001, message: 'task not found' }, 404) : undefined),
    });
    expect((await request('/api/tripo/tasks/a.b')).status).toBe(400);
    expect((await request('/api/tripo/tasks/a%2F..')).status).toBe(400);
    expect(calls).toHaveLength(0);
    const r = await request('/api/tripo/tasks/missing');
    expect(r.status).toBe(404);
    expect(r.json()).toEqual({ error: 'Task not found' });
  });
});

describe('GET /api/tripo/tasks/:id/model', () => {
  it('streams the GLB from a trusted host without forwarding the key', async () => {
    const { request, calls } = setup({ env: { TRIPO_API_KEY: SERVER_KEY } });
    const r = await request('/api/tripo/tasks/task-123/model');
    expect(r.status).toBe(200);
    expect(r.res.headers.get('content-type')).toBe('model/gltf-binary');
    expect(r.res.headers.get('content-length')).toBe('64');
    expect(r.res.headers.get('content-disposition')).toContain('tripo-task-123.glb');
    expect(Array.from(r.buf)).toEqual(Array.from(glb()));
    const download = calls.find((c) => c.url === MODEL_URL)!;
    expect(download.headers.get('authorization')).toBeNull();
    expect(download.redirect).toBe('manual');
  });

  it('prefers pbr_model, then model, then base_model', async () => {
    const other = 'https://cdn.tripo3d.ai/base.glb';
    const { request, calls } = setup({
      env: { TRIPO_API_KEY: SERVER_KEY },
      task: { output: { base_model: other, model: MODEL_URL } },
    });
    expect((await request('/api/tripo/tasks/task-123/model')).status).toBe(200);
    expect(calls.map((c) => c.url)).toContain(MODEL_URL);
    expect(calls.map((c) => c.url)).not.toContain(other);
  });

  it('refuses untrusted, look-alike and non-https hosts without fetching them', async () => {
    for (const url of [
      'https://evil.example.com/model.glb',
      'https://tripo3d.ai.evil.com/model.glb',
      'https://nottripo3d.ai/model.glb',
      'http://tripo-data.rg1.data.tripo3d.com/model.glb',
      'https://user:pw@tripo3d.ai/model.glb',
      'file:///etc/passwd',
      'http://169.254.169.254/latest/meta-data',
    ]) {
      const { request, calls, logs } = setup({ env: { TRIPO_API_KEY: SERVER_KEY }, task: { output: { model: url } } });
      const r = await request('/api/tripo/tasks/task-123/model');
      expect(r.status, url).toBe(502);
      expect(r.json().error).toMatch(/does not trust/);
      expect(calls.map((c) => c.url), url).toEqual([`${API}/task/task-123`]);
      expect(logs.join('\n')).toMatch(/TRIPO_ALLOWED_MODEL_HOSTS/);
    }
  });

  it('checks every redirect hop', async () => {
    const bad = setup({
      env: { TRIPO_API_KEY: SERVER_KEY },
      override: (c) => (c.url === MODEL_URL ? new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x.glb' } }) : undefined),
    });
    expect((await bad.request('/api/tripo/tasks/task-123/model')).status).toBe(502);
    expect(bad.calls.some((c) => c.url.includes('evil'))).toBe(false);

    const good = setup({
      env: { TRIPO_API_KEY: SERVER_KEY },
      override: (c) =>
        c.url === MODEL_URL
          ? new Response(null, { status: 302, headers: { location: '/moved/model.glb' } })
          : c.url === 'https://tripo-data.rg1.data.tripo3d.com/moved/model.glb'
            ? new Response(glb(32))
            : undefined,
    });
    const r = await good.request('/api/tripo/tasks/task-123/model');
    expect(r.status).toBe(200);
    expect(r.buf.byteLength).toBe(32);
  });

  it('honours TRIPO_ALLOWED_MODEL_HOSTS', async () => {
    const url = 'https://models.example-cdn.net/a.glb';
    const s = setup({
      env: { TRIPO_API_KEY: SERVER_KEY, TRIPO_ALLOWED_MODEL_HOSTS: ' example-cdn.net , .other.org' },
      task: { output: { model: url } },
      override: (c) => (c.url === url ? new Response(glb()) : undefined),
    });
    expect((await s.request('/api/tripo/tasks/task-123/model')).status).toBe(200);
    // The override replaces the defaults.
    const t = setup({ env: { TRIPO_API_KEY: SERVER_KEY, TRIPO_ALLOWED_MODEL_HOSTS: 'example-cdn.net' } });
    expect((await t.request('/api/tripo/tasks/task-123/model')).status).toBe(502);
  });

  it('returns 409 while the task is not finished and 502 without output', async () => {
    const running = setup({ env: { TRIPO_API_KEY: SERVER_KEY }, task: { status: 'running', progress: 50 } });
    expect((await running.request('/api/tripo/tasks/task-123/model')).status).toBe(409);
    const empty = setup({ env: { TRIPO_API_KEY: SERVER_KEY }, task: { output: {} } });
    expect((await empty.request('/api/tripo/tasks/task-123/model')).status).toBe(502);
  });

  it('reports a failed CDN download as 502', async () => {
    const s = setup({
      env: { TRIPO_API_KEY: SERVER_KEY },
      override: (c) => (c.url === MODEL_URL ? new Response('denied', { status: 403 }) : undefined),
    });
    const r = await s.request('/api/tripo/tasks/task-123/model');
    expect(r.status).toBe(502);
    expect(r.json().error).toMatch(/HTTP 403/);
  });
});

describe('secrets', () => {
  it('never echoes or logs a key, even when Tripo does', async () => {
    const echo = (c: Call) =>
      c.url.endsWith('/task')
        ? json({ code: 1004, message: `Invalid key ${c.headers.get('authorization')?.slice(7)} for tsk_someoneElse123` }, 400)
        : c.url.includes('/task/boom')
          ? json({ code: 1, message: `boom ${c.headers.get('authorization')}` }, 500)
          : undefined;
    for (const env of [{ TRIPO_API_KEY: SERVER_KEY }, {}] as ServerEnv[]) {
      const s = setup({ env, override: echo });
      const h = { 'x-tripo-key': USER_KEY };
      const created = await s.request('/api/tripo/tasks', post(imageForm(), h));
      expect(created.status).toBe(400);
      expect(created.json().error).toMatch(/Invalid key \[redacted\]/);
      await s.request('/api/tripo/tasks/boom', { headers: h });
      await s.request('/api/tripo/tasks/task-123', { headers: h });
      await s.request('/api/tripo/tasks/task-123/model', { headers: h });
      await s.request('/api/tripo/status', { headers: h });
      await s.request('/api/tripo/tasks', post(imageForm(bytes(GIF_HEAD)), h));
      await s.request('/api/tripo/tasks', post(imageForm(), { 'x-tripo-key': 'tsk_bad key!' }));
      for (const text of [...s.bodies, ...s.logs]) {
        expect(text).not.toContain(SERVER_KEY);
        expect(text).not.toContain(USER_KEY);
        expect(text).not.toContain('tsk_someoneElse123');
        expect(text).not.toContain('tsk_bad');
      }
    }
  });
});

describe('helpers', () => {
  it('toTaskState clamps and rounds', () => {
    expect(toTaskState({ status: 'running', progress: 12.6 })).toEqual({ status: 'running', progress: 13 });
  });

  it('parseTaskFields', () => {
    expect(parseTaskFields({})).toEqual({ ok: true, fields: {} });
    expect(parseTaskFields({ texture: 'true', pbr: 'false', face_limit: '500', model_version: 'v2.0-20240919' })).toEqual({
      ok: true,
      fields: { texture: true, pbr: false, faceLimit: 500, modelVersion: 'v2.0-20240919' },
    });
    expect(parseTaskFields({ face_limit: new Blob(['1']) }).ok).toBe(false);
  });

  it('rateKeyForIp groups IPv6 by /64', () => {
    expect(rateKeyForIp('203.0.113.9')).toBe('203.0.113.9');
    expect(rateKeyForIp('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(rateKeyForIp('2001:db8:0:1:aaaa::1')).toBe('2001:db8:0:1::/64');
    expect(rateKeyForIp('2001:db8:0:1:bbbb:cccc:dddd:eeee')).toBe('2001:db8:0:1::/64');
    expect(rateKeyForIp('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateKeyForIp('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });
});
