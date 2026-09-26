import { describe, expect, it, vi } from 'vitest';
import { CLIENT_HEADER, CLIENT_HEADER_VALUE, MAX_IMAGE_BYTES } from '../src/drivers/cloud/api';
import { createApp, type ServerEnv } from './app';

const SERVER_KEY = 'tsk_serverSecret_9f8e7d6c5b';
const USER_KEY = 'tsk_userSecret_1a2b3c4d5e';
const API = 'https://api.tripo3d.ai/v2/openapi';

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];
const GIF_HEAD = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0];

function bytes(head: number[], size = 64): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(Math.max(size, head.length));
  b.set(head);
  return b;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function setup(env: ServerEnv = { TRIPO_API_KEY: SERVER_KEY }, now?: () => number) {
  const calls: Call[] = [];
  let uploads = 0;
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    const call: Call = { url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body };
    calls.push(call);
    if (url === `${API}/upload`) return json({ code: 0, data: { image_token: `tok-${++uploads}` } });
    if (url === `${API}/task`) return json({ code: 0, data: { task_id: 'mv-task-1' } });
    if (url.startsWith(`${API}/task/`)) return json({ code: 0, data: { task_id: 'mv-task-1', status: 'running', progress: 30, output: {} } });
    return new Response('not found', { status: 404 });
  };
  const logs: string[] = [];
  const logger = { info: (...a: unknown[]) => void logs.push(a.join(' ')), warn: () => {}, error: (...a: unknown[]) => void logs.push(a.join(' ')) };
  const app = createApp({ fetch: fetchMock, env, logger, now });
  const request = async (form: FormData, headers: Record<string, string> = {}) => {
    const res = await app.request('/api/tripo/multiview-tasks', {
      method: 'POST',
      body: form,
      headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE, ...headers },
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown>, res };
  };
  return { app, request, calls, logs };
}

function viewsForm(views: Partial<Record<'front' | 'left' | 'back' | 'right', Uint8Array<ArrayBuffer>>>, fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(views)) form.append(k, new Blob([v]), `${k}.png`);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
}

describe('POST /api/tripo/multiview-tasks', () => {
  it('uploads every view and creates a multiview_to_model task', async () => {
    const { request, calls, logs } = setup();
    const r = await request(
      viewsForm({ front: bytes(PNG_HEAD), left: bytes(JPEG_HEAD), right: bytes(PNG_HEAD) }, { model_version: 'v2.5-20250123', texture: 'true', face_limit: '5000' }),
    );
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ taskId: 'mv-task-1' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${API}/upload`,
      `POST ${API}/upload`,
      `POST ${API}/upload`,
      `POST ${API}/task`,
    ]);
    expect(calls.every((c) => c.headers.get('authorization') === `Bearer ${SERVER_KEY}`)).toBe(true);
    expect(((calls[1].body as FormData).get('file') as File).type).toBe('image/jpeg');
    expect(JSON.parse(calls[3].body as string)).toEqual({
      type: 'multiview_to_model',
      files: [{ type: 'png', file_token: 'tok-1' }, { type: 'jpg', file_token: 'tok-2' }, {}, { type: 'png', file_token: 'tok-3' }],
      model_version: 'v2.5-20250123',
      texture: true,
      face_limit: 5000,
    });
    expect(r.res.headers.get('x-ratelimit-remaining')).toBe('9');
    expect(logs.join('\n')).toMatch(/multi-view task mv-task-1 created with 3 views/);
  });

  it('follows TRIPO_MULTIVIEW_ORDER', async () => {
    const { request, calls } = setup({ TRIPO_API_KEY: SERVER_KEY, TRIPO_MULTIVIEW_ORDER: 'front,right,back,left' });
    await request(viewsForm({ front: bytes(PNG_HEAD), left: bytes(PNG_HEAD) }));
    expect(JSON.parse(calls.at(-1)!.body as string).files).toEqual([{ type: 'png', file_token: 'tok-1' }, {}, {}, { type: 'png', file_token: 'tok-2' }]);
  });

  it('needs the front and at least one side, each a valid image', async () => {
    const { request, calls } = setup();
    const cases: [FormData, number, RegExp][] = [
      [viewsForm({ left: bytes(PNG_HEAD), back: bytes(PNG_HEAD) }), 400, /front/],
      [viewsForm({ front: bytes(PNG_HEAD) }), 400, /at least one of/],
      [viewsForm({ front: bytes(PNG_HEAD), back: bytes(GIF_HEAD) }), 415, /back image type/],
      [viewsForm({ front: bytes(PNG_HEAD), right: new Uint8Array(0) }), 400, /right image is empty/],
      [viewsForm({ front: bytes(PNG_HEAD), left: bytes(PNG_HEAD, MAX_IMAGE_BYTES + 1) }), 413, /left image is larger than 20 MB/],
      [viewsForm({ front: bytes(PNG_HEAD), back: bytes(PNG_HEAD) }, { texture: 'maybe' }), 400, /texture/],
    ];
    for (const [form, status, re] of cases) {
      const r = await request(form);
      expect(r.status, re.source).toBe(status);
      expect(r.json.error as string, re.source).toMatch(re);
    }
    const text = new FormData();
    text.append('front', 'not a file');
    text.append('back', new Blob([bytes(PNG_HEAD)]), 'b.png');
    expect((await request(text)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('caps the whole body at four images', async () => {
    const { request, calls } = setup();
    const huge = bytes(PNG_HEAD, MAX_IMAGE_BYTES);
    const form = viewsForm({ front: huge, left: huge, back: huge, right: huge });
    form.append('extra', new Blob([huge]), 'x.png');
    const r = await request(form);
    expect(r.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('shares the key, CSRF and rate-limit rules of single-image tasks', async () => {
    const noKey = setup({});
    expect((await noKey.request(viewsForm({ front: bytes(PNG_HEAD), back: bytes(PNG_HEAD) }))).status).toBe(401);
    const own = await noKey.request(viewsForm({ front: bytes(PNG_HEAD), back: bytes(PNG_HEAD) }), { 'x-tripo-key': USER_KEY });
    expect(own.status).toBe(200);
    expect(noKey.calls.every((c) => c.headers.get('authorization') === `Bearer ${USER_KEY}`)).toBe(true);

    const s = setup({ TRIPO_API_KEY: SERVER_KEY, TRIPO_RATE_LIMIT: '1' });
    const form = () => viewsForm({ front: bytes(PNG_HEAD), back: bytes(PNG_HEAD) });
    expect((await s.request(form(), { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    const noHeader = await s.app.request('/api/tripo/multiview-tasks', { method: 'POST', body: form() });
    expect(noHeader.status).toBe(403);
    expect((await s.request(form())).status).toBe(200);
    // One multi-view task counts once, and shares the budget with single-image tasks.
    expect((await s.request(form())).status).toBe(429);
    const single = new FormData();
    single.append('image', new Blob([bytes(PNG_HEAD)]), 'a.png');
    const r = await s.app.request('/api/tripo/tasks', { method: 'POST', body: single, headers: { [CLIENT_HEADER]: '1' } });
    expect(r.status).toBe(429);
  });

  it('takes one slot per possible image while its body arrives', async () => {
    const env = { TRIPO_API_KEY: SERVER_KEY, TRIPO_RATE_LIMIT: '0', TRUST_PROXY: '1', TRIPO_MAX_CONCURRENT_UPLOADS: '5' };
    const { app } = setup(env);
    const encoded = new Response(viewsForm({ front: bytes(PNG_HEAD), back: bytes(PNG_HEAD) }));
    const type = encoded.headers.get('content-type')!;
    const data = new Uint8Array(await encoded.arrayBuffer());
    let send!: () => void;
    const gate = new Promise<void>((r) => (send = r));
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(c) {
          pulls++;
          await gate;
          c.enqueue(data);
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
    const headers = (ip: string) => ({ [CLIENT_HEADER]: '1', 'x-forwarded-for': ip });
    const held = app.request('/api/tripo/multiview-tasks', { method: 'POST', body, duplex: 'half', headers: { ...headers('10.0.0.1'), 'content-type': type } } as RequestInit);
    await vi.waitFor(() => expect(pulls).toBeGreaterThan(0));
    const single = () => {
      const f = new FormData();
      f.append('image', new Blob([bytes(PNG_HEAD)]), 'a.png');
      return f;
    };
    // Same client: busy while its multi-view upload is in progress.
    expect((await app.request('/api/tripo/tasks', { method: 'POST', body: single(), headers: headers('10.0.0.1') })).status).toBe(429);
    // 4 of 5 global slots taken: another client's single upload fits, a second multi-view does not.
    expect((await app.request('/api/tripo/tasks', { method: 'POST', body: single(), headers: headers('10.0.0.2') })).status).toBe(200);
    const mv = viewsForm({ front: bytes(PNG_HEAD), back: bytes(PNG_HEAD) });
    expect((await app.request('/api/tripo/multiview-tasks', { method: 'POST', body: mv, headers: headers('10.0.0.3') })).status).toBe(429);
    send();
    expect((await held).status).toBe(200);
    const again = viewsForm({ front: bytes(PNG_HEAD), back: bytes(PNG_HEAD) });
    expect((await app.request('/api/tripo/multiview-tasks', { method: 'POST', body: again, headers: headers('10.0.0.3') })).status).toBe(200);
  });

  it('reuses the task status route', async () => {
    const { app } = setup();
    const r = await app.request('/api/tripo/tasks/mv-task-1', { headers: { [CLIENT_HEADER]: '1' } });
    expect(await r.json()).toEqual({ status: 'running', progress: 30 });
  });
});
