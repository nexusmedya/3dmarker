import { describe, expect, it, vi } from 'vitest';
import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from '../../src/drivers/cloud/api';
import { createApp, type ServerEnv } from '../app';
import { MAX_FETCH_PER_CLIENT, MAX_PROXY_PER_CLIENT } from './routes';

const OPENAI_KEY = 'sk-server-openai-0123456789abcdef';
const USER_KEY = 'sk-user-own-key-9876543210fedcba';
const ALL_KEYS: ServerEnv = {
  OPENAI_API_KEY: OPENAI_KEY,
  GEMINI_API_KEY: 'AIzaServerGeminiKey0123456789abcdefghij',
  STABILITY_API_KEY: 'sk-server-stability-0123456789',
  REPLICATE_API_TOKEN: 'r8_serverReplicateToken0123456789',
  FAL_KEY: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b:0123456789abcdef0123',
  TRIPO_API_KEY: 'tsk_serverTripoKey_0123',
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  init: RequestInit;
}

type Handler = (c: Call) => Response | Promise<Response> | undefined | Promise<Response | undefined>;

/** Upstream that echoes { url, method, body } unless `handler` answers. */
function setup(s: { env?: ServerEnv; handler?: Handler; now?: () => number } = {}) {
  const calls: Call[] = [];
  const fetchMock: typeof fetch = async (input, init = {}) => {
    const call: Call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: (init.body as ReadableStream<Uint8Array> | null) ?? null,
      init,
    };
    calls.push(call);
    const custom = await s.handler?.(call);
    if (custom) return custom;
    const body = call.body ? await new Response(call.body).text() : null;
    return json({ url: call.url, method: call.method, body }, 200, { 'x-request-id': 'req_1', 'set-cookie': 'up=1' });
  };
  const logs: string[] = [];
  const logger = {
    info: (...a: unknown[]) => void logs.push(a.join(' ')),
    warn: (...a: unknown[]) => void logs.push(a.join(' ')),
    error: (...a: unknown[]) => void logs.push(a.join(' ')),
  };
  const app = createApp({ fetch: fetchMock, env: s.env ?? {}, logger, now: s.now });
  const bodies: string[] = [];
  const request = async (path: string, init: RequestInit = {}, { client = true } = {}) => {
    const headers = new Headers(init.headers);
    if (client && !headers.has(CLIENT_HEADER)) headers.set(CLIENT_HEADER, CLIENT_HEADER_VALUE);
    const res = await app.request(path, { ...init, headers });
    const text = await res.text();
    bodies.push(text);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { res, status: res.status, text, json: parsed as Record<string, unknown> };
  };
  return { app, request, calls, logs, bodies };
}

const post = (body: BodyInit, headers: Record<string, string> = {}): RequestInit => ({ method: 'POST', body, headers });

describe('GET /api/ai/providers', () => {
  it('lists managed providers without keys', async () => {
    const { request } = setup({ env: { ...ALL_KEYS, OPENAI_IMAGE_MODEL: 'gpt-image-1' } });
    const r = await request('/api/ai/providers', {}, { client: false });
    expect(r.status).toBe(200);
    expect(r.res.headers.get('cache-control')).toBe('no-store');
    const body = r.json as { providers: { id: string; managed: boolean; apiKey: string; models: object }[]; proxyKinds: string[]; byok: boolean };
    expect(body.providers.map((p) => p.id)).toEqual(['server-openai', 'server-gemini', 'server-stability', 'server-replicate', 'server-fal', 'server-tripo']);
    expect(body.providers[0].models).toEqual({ 'image-edit': 'gpt-image-1' });
    expect(body.proxyKinds).toEqual(['openai', 'gemini', 'stability', 'replicate', 'fal']);
    expect(body.byok).toBe(true);
    for (const key of Object.values(ALL_KEYS)) expect(r.text).not.toContain(key);
  });

  it('is empty without keys and lists extra kinds only when bases are configured', async () => {
    expect((await setup().request('/api/ai/providers')).json).toEqual({
      providers: [],
      proxyKinds: ['openai', 'gemini', 'stability', 'replicate', 'fal'],
      byok: true,
    });
    const extra = await setup({ env: { AI_PROXY_EXTRA_BASES: 'https://llm.example.com/v1', AI_PROXY_BYOK: '0', AI_PROXY_KINDS: 'fal' } }).request(
      '/api/ai/providers',
    );
    expect(extra.json).toEqual({ providers: [], proxyKinds: ['fal', 'openai-compatible', 'custom-http'], byok: false });
  });
});

describe('ANY /api/ai/proxy/:kind/*', () => {
  it('injects each kind’s server key on its fixed host', async () => {
    const { request, calls } = setup({ env: ALL_KEYS });
    const cases: [string, string, [string, string]][] = [
      ['openai/v1/images/edits', 'https://api.openai.com/v1/images/edits', ['authorization', `Bearer ${OPENAI_KEY}`]],
      [
        'gemini/v1beta/models/gemini-2.5-flash-image:generateContent',
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
        ['x-goog-api-key', ALL_KEYS.GEMINI_API_KEY!],
      ],
      ['stability/v2beta/3d/stable-fast-3d', 'https://api.stability.ai/v2beta/3d/stable-fast-3d', ['authorization', `Bearer ${ALL_KEYS.STABILITY_API_KEY}`]],
      ['replicate/v1/predictions', 'https://api.replicate.com/v1/predictions', ['authorization', `Bearer ${ALL_KEYS.REPLICATE_API_TOKEN}`]],
      ['replicate/v1/models/o/n/predictions', 'https://api.replicate.com/v1/models/o/n/predictions', ['authorization', `Bearer ${ALL_KEYS.REPLICATE_API_TOKEN}`]],
      ['fal/queue/fal-ai/trellis', 'https://queue.fal.run/fal-ai/trellis', ['authorization', `Key ${ALL_KEYS.FAL_KEY}`]],
    ];
    for (const [path, url, [h, v]] of cases) {
      const r = await request(`/api/ai/proxy/${path}`, post('{"a":1}', { 'content-type': 'application/json' }));
      expect(r.status, path).toBe(200);
      expect(r.json, path).toEqual({ url, method: 'POST', body: '{"a":1}' });
      const call = calls.at(-1)!;
      expect(call.headers.get(h), path).toBe(v);
      expect(call.headers.get('content-type')).toBe('application/json');
    }
    // Gemini only ever authenticates with the injected header.
    await request('/api/ai/proxy/gemini/v1beta/models?key=AIzaSomeoneElse&pageSize=2');
    expect(calls.at(-1)!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=2');
  });

  it('forwards method and query, and only safe headers both ways', async () => {
    const { request, calls } = setup({ env: ALL_KEYS });
    const r = await request('/api/ai/proxy/replicate/v1/predictions/abc?stream=false&x=a%20b', {
      headers: {
        cookie: 'sid=secret',
        authorization: 'Bearer client-supplied',
        'x-forwarded-for': '9.9.9.9',
        prefer: 'wait=600',
        accept: 'application/json',
      },
    });
    expect(r.status).toBe(200);
    const call = calls[0];
    expect(call.url).toBe('https://api.replicate.com/v1/predictions/abc?stream=false&x=a%20b');
    expect(call.method).toBe('GET');
    expect([...call.headers.keys()].sort()).toEqual(['accept', 'authorization', 'prefer']);
    expect(call.headers.get('authorization')).toBe(`Bearer ${ALL_KEYS.REPLICATE_API_TOKEN}`);
    expect(call.headers.get('prefer')).toBe('wait=60');
    expect(call.init.redirect).toBe('manual');
    expect(call.init.credentials).toBe('omit');
    expect(r.res.headers.get('x-request-id')).toBe('req_1');
    expect(r.res.headers.get('set-cookie')).toBeNull();
    expect(r.res.headers.get('cache-control')).toBe('no-store');
    expect(r.res.headers.get('x-ai-proxy-error')).toBeNull();

    await request('/api/ai/proxy/fal/queue/fal-ai/x/requests/r1/cancel', { method: 'PUT' });
    expect(calls.at(-1)!.method).toBe('PUT');
    expect(calls.at(-1)!.url).toBe('https://queue.fal.run/fal-ai/x/requests/r1/cancel');
    // No adapter needs these: never forwarded, whatever the path.
    for (const method of ['PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect((await request('/api/ai/proxy/replicate/v1/predictions/abc', { method })).status, method).toBe(405);
    }
    expect(calls).toHaveLength(2);
  });

  it('relays the user’s own key (it wins over the server key) and validates it', async () => {
    const { request, calls } = setup({ env: ALL_KEYS });
    await request('/api/ai/proxy/openai/v1/models', { headers: { 'x-ai-key': ` ${USER_KEY} ` } });
    expect(calls[0].headers.get('authorization')).toBe(`Bearer ${USER_KEY}`);
    expect(calls[0].headers.has('x-ai-key')).toBe(false);
    const bad = await request('/api/ai/proxy/openai/v1/models', { headers: { 'x-ai-key': 'has space' } });
    expect(bad.status).toBe(401);
    expect(bad.json.error).toMatch(/invalid format/);

    const noKeys = setup();
    const r = await noKeys.request('/api/ai/proxy/fal/queue/fal-ai/x/requests/r1/status', { headers: { 'x-ai-key': 'id:secret' } });
    expect(r.status).toBe(200);
    expect(noKeys.calls[0].headers.get('authorization')).toBe('Key id:secret');
  });

  it('answers 401 JSON without any key and never calls upstream', async () => {
    const { request, calls } = setup({ env: { OPENAI_API_KEY: OPENAI_KEY } });
    const r = await request('/api/ai/proxy/stability/v2beta/3d/stable-fast-3d', post('x'));
    expect(r.status).toBe(401);
    expect(r.json.error).toMatch(/No Stability AI API key/);
    expect(r.res.headers.get('x-ai-proxy-error')).toBe('1');
    expect(calls).toHaveLength(0);
  });

  it('refuses user keys when BYOK is off', async () => {
    const { request, calls } = setup({ env: { AI_PROXY_BYOK: '0', OPENAI_API_KEY: OPENAI_KEY } });
    expect((await request('/api/ai/proxy/openai/v1/models', { headers: { 'x-ai-key': USER_KEY } })).status).toBe(403);
    expect(calls).toHaveLength(0);
    expect((await request('/api/ai/proxy/openai/v1/models')).status).toBe(200);
  });

  it('rejects traversal and malformed paths before calling upstream', async () => {
    const { request, calls } = setup({ env: ALL_KEYS });
    for (const path of [
      '/api/ai/proxy/openai/v1%2F..%2F..%2Fx',
      '/api/ai/proxy/openai/v1%2fx',
      '/api/ai/proxy/openai/v1%5C..%5Cx',
      '/api/ai/proxy/openai/v1//x',
      '/api/ai/proxy/openai/https:/evil.com/x',
      '/api/ai/proxy/openai/v1/%00',
      '/api/ai/proxy/open%61i/v1/x',
    ]) {
      const r = await request(path);
      expect(r.status, path).toBe(400);
      expect(r.json.error, path).toBe('Invalid API path');
    }
    // Dot segments are resolved by the URL parser before routing; they can never leave /api/ai/proxy/<kind>/.
    expect((await request('/api/ai/proxy/openai/../../tripo/status')).status).toBe(404);
    expect((await request('/api/ai/proxy/openai/%2e%2e/%2e%2e/health')).json).toEqual({ error: 'Not found' });
    expect((await request('/api/ai/proxy/evil.com/v1/x')).status).toBe(404);
    expect((await request('/api/ai/proxy/openai-compatible/v1/x')).status).toBe(404);
    expect((await request('/api/ai/proxy/openai')).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect((await request('/api/ai/proxy/openai/@evil.com/x')).status).toBe(403); // not an allowed endpoint
    expect(calls).toHaveLength(0);
    // Whatever the query, the host is the kind's.
    await request('/api/ai/proxy/openai/v1/models?host=evil.com&url=https://evil.com');
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['api.openai.com']);
  });

  it('honours AI_PROXY_KINDS', async () => {
    const { request, calls } = setup({ env: { ...ALL_KEYS, AI_PROXY_KINDS: 'fal' } });
    expect((await request('/api/ai/proxy/openai/v1/models')).status).toBe(404);
    expect((await request('/api/ai/proxy/fal/queue/fal-ai/x/requests/r1/status')).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('requires our client header (CSRF guard)', async () => {
    const { request, calls } = setup({ env: ALL_KEYS });
    expect((await request('/api/ai/proxy/openai/v1/images/edits', post('x'), { client: false })).status).toBe(403);
    expect((await request('/api/ai/proxy/openai/v1/images/edits', post('x', { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    expect((await request('/api/ai/proxy/openai/v1/images/edits', post('x', { [CLIENT_HEADER]: '0' }))).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('enforces the body limit by Content-Length and while streaming', async () => {
    const { app, request, calls } = setup({ env: { ...ALL_KEYS, AI_PROXY_MAX_BODY_MB: '0.001' } }); // 1048 bytes
    // (app.request does not add Content-Length itself; a real client always sends it for a buffered body.)
    const big = await request('/api/ai/proxy/openai/v1/images/edits', post(new Uint8Array(2000), { 'content-length': '2000' }));
    expect(big.status).toBe(413);
    expect(big.json.error).toMatch(/larger than/);
    expect((await request('/api/ai/proxy/openai/v1/images/edits', post('x', { 'content-length': 'abc' }))).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect((await request('/api/ai/proxy/openai/v1/images/edits', post(new Uint8Array(1000), { 'content-length': '1000' }))).status).toBe(200);
    expect(calls[0].headers.get('content-length')).toBe('1000');

    // No Content-Length (chunked): counted on the way through; the upstream upload is cut.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(600));
        c.close();
      },
    });
    const r = await app.request('/api/ai/proxy/openai/v1/images/edits', {
      method: 'POST',
      body: stream,
      duplex: 'half',
      headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
    } as RequestInit);
    expect(r.status).toBe(413);
    expect(calls[1].headers.has('content-length')).toBe(false);
  });

  it('streams request and response bodies', async () => {
    let releaseClient!: () => void;
    const clientGate = new Promise<void>((r) => (releaseClient = r));
    let releaseUpstream!: () => void;
    const upstreamGate = new Promise<void>((r) => (releaseUpstream = r));
    const received: string[] = [];
    const { app } = setup({
      env: ALL_KEYS,
      handler: async (call) => {
        const reader = call.body!.getReader();
        const dec = new TextDecoder();
        received.push(dec.decode((await reader.read()).value)); // first chunk arrives before the client sent the rest
        releaseClient();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received.push(dec.decode(value));
        }
        const enc = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(enc.encode('data: 1\n\n'));
            await upstreamGate;
            c.enqueue(enc.encode('data: 2\n\n'));
            c.close();
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(enc.encode('part1;'));
        await clientGate;
        c.enqueue(enc.encode('part2'));
        c.close();
      },
    });
    const res = await app.request('/api/ai/proxy/openai/v1/images/edits', {
      method: 'POST',
      body,
      duplex: 'half',
      headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE, 'content-type': 'text/plain' },
    } as RequestInit);
    expect(res.status).toBe(200);
    expect(received).toEqual(['part1;', 'part2']);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    expect(dec.decode((await reader.read()).value)).toBe('data: 1\n\n'); // before the upstream finished
    releaseUpstream();
    expect(dec.decode((await reader.read()).value)).toBe('data: 2\n\n');
    expect((await reader.read()).done).toBe(true);
  });

  it('rate-limits generations per client and window, with a larger budget for own keys', async () => {
    let t = 1_000_000;
    const { request, calls } = setup({
      env: { ...ALL_KEYS, AI_PROXY_RATE_LIMIT: '2', AI_PROXY_RATE_LIMIT_BYOK: '3', AI_PROXY_RATE_WINDOW_SEC: '60' },
      now: () => t,
    });
    const gen = (h: Record<string, string> = {}) => request('/api/ai/proxy/openai/v1/images/edits', post('x', h));
    expect((await gen()).status).toBe(200);
    expect((await gen()).status).toBe(200);
    const blocked = await gen();
    expect(blocked.status).toBe(429);
    expect(blocked.res.headers.get('retry-after')).toBe('60');
    expect(blocked.res.headers.get('x-ai-proxy-error')).toBe('1');
    expect(calls).toHaveLength(2);
    // Reads (polls) have their own budget.
    expect((await request('/api/ai/proxy/openai/v1/models')).status).toBe(200);
    // Own keys: separate budget.
    for (let i = 0; i < 3; i++) expect((await gen({ 'x-ai-key': USER_KEY })).status).toBe(200);
    expect((await gen({ 'x-ai-key': USER_KEY })).status).toBe(429);
    t += 60_000;
    expect((await gen()).status).toBe(200);
  });

  it('rate-limits reads per minute (shared with output downloads)', async () => {
    const { request } = setup({ env: { ...ALL_KEYS, AI_PROXY_READ_RATE_LIMIT: '2' } });
    expect((await request('/api/ai/proxy/replicate/v1/predictions/a')).status).toBe(200);
    expect((await request('/api/ai/fetch?url=' + encodeURIComponent('https://replicate.delivery/a.png'))).status).toBe(200);
    const r = await request('/api/ai/proxy/replicate/v1/predictions/a');
    expect(r.status).toBe(429);
    expect(r.json.error).toMatch(/Too many requests/);
  });

  it(`limits one client to ${MAX_PROXY_PER_CLIENT} requests in progress`, async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let started = 0;
    const { app, request } = setup({
      env: ALL_KEYS,
      handler: async () => {
        started++;
        await gate;
        return json({ ok: true });
      },
    });
    const go = () => app.request('/api/ai/proxy/openai/v1/images/edits', { method: 'POST', body: 'x', headers: { [CLIENT_HEADER]: '1' } });
    const pending = Array.from({ length: MAX_PROXY_PER_CLIENT }, go);
    await vi.waitFor(() => expect(started).toBe(MAX_PROXY_PER_CLIENT));
    const refused = await request('/api/ai/proxy/openai/v1/images/edits', post('x'));
    expect(refused.status).toBe(429);
    expect(refused.json.error).toMatch(/in progress/);
    open();
    for (const r of await Promise.all(pending)) {
      expect(r.status).toBe(200);
      await r.text();
    }
    expect((await request('/api/ai/proxy/openai/v1/images/edits', post('x'))).status).toBe(200);
  });

  it('relays upstream errors with keys scrubbed; a rejected server key becomes 502', async () => {
    const echo = setup({
      env: ALL_KEYS,
      handler: (c) =>
        json({ error: { message: `Incorrect API key provided: ${c.headers.get('authorization')?.slice(7)}; also sk-proj-someoneElse1234567890` } }, 400, {
          'x-request-id': 'req_9',
        }),
    });
    const user = await echo.request('/api/ai/proxy/openai/v1/images/edits', post('x', { 'x-ai-key': USER_KEY }));
    expect(user.status).toBe(400);
    expect(user.res.headers.get('x-ai-proxy-error')).toBeNull();
    expect(user.res.headers.get('x-request-id')).toBe('req_9');
    expect(user.text).toContain('Incorrect API key provided: [redacted]');
    expect(user.text).not.toContain(USER_KEY);
    expect(user.text).not.toContain('sk-proj-someoneElse');
    const server = await echo.request('/api/ai/proxy/openai/v1/images/edits', post('x'));
    expect(server.text).not.toContain(OPENAI_KEY);

    const rejected = setup({ env: ALL_KEYS, handler: () => json({ error: { message: 'Invalid key' } }, 401) });
    const s = await rejected.request('/api/ai/proxy/openai/v1/images/edits', post('x'));
    expect(s.status).toBe(502);
    expect(s.json.error).toBe("OpenAI rejected the server's API key");
    expect(rejected.logs.join('\n')).toMatch(/OPENAI_API_KEY/);
    const u = await rejected.request('/api/ai/proxy/openai/v1/images/edits', post('x', { 'x-ai-key': USER_KEY }));
    expect(u.status).toBe(401);
    expect(u.json).toEqual({ error: { message: 'Invalid key' } });

    for (const text of [...echo.bodies, ...echo.logs, ...rejected.bodies, ...rejected.logs]) {
      for (const key of [...Object.values(ALL_KEYS), USER_KEY]) expect(text).not.toContain(key);
    }
  });

  it('refuses upstream redirects and maps transport failures', async () => {
    const redirect = setup({ env: ALL_KEYS, handler: () => new Response(null, { status: 302, headers: { location: 'https://evil.com/' } }) });
    const r = await redirect.request('/api/ai/proxy/openai/v1/models');
    expect(r.status).toBe(502);
    expect(r.json.error).toMatch(/redirect/);
    expect(r.res.headers.get('location')).toBeNull();
    expect(redirect.calls).toHaveLength(1);

    const down = setup({
      env: ALL_KEYS,
      handler: () => {
        throw new TypeError('fetch failed');
      },
    });
    const d = await down.request('/api/ai/proxy/fal/queue/fal-ai/x', post('x'));
    expect(d.status).toBe(502);
    expect(d.json).toEqual({ error: 'Could not reach fal.ai' });

    const hang = setup({
      env: { ...ALL_KEYS, AI_PROXY_TIMEOUT_SEC: '0.05' },
      handler: (c) =>
        new Promise<Response>((_resolve, reject) => c.init.signal?.addEventListener('abort', () => reject(c.init.signal?.reason), { once: true })),
    });
    const h = await hang.request('/api/ai/proxy/openai/v1/images/edits', post('x'));
    expect(h.status).toBe(504);
    expect(h.json.error).toMatch(/did not answer/);
  });

  it('forwards only the endpoints the adapters call (never account data or other resources)', async () => {
    const { request, calls } = setup({ env: { ...ALL_KEYS, AI_PROXY_RATE_LIMIT: '1', AI_PROXY_READ_RATE_LIMIT: '1' } });
    const refused: [string, RequestInit][] = [
      ['replicate/v1/predictions', {}], // every prediction on the account (other users' inputs and outputs)
      ['replicate/v1/trainings', {}],
      ['replicate/v1/deployments', post('{"min_instances":5}')],
      ['openai/v1/files', {}],
      ['openai/v1/files/file-abc/content', {}],
      ['openai/v1/fine_tuning/jobs', post('{}')],
      ['openai/v1/chat/completions', post('{}')],
      ['gemini/v1beta/files', {}],
      ['gemini/v1beta/tunedModels', {}],
      ['fal/fal-ai/veo3', post('{}')],
      ['fal/queue/fal-ai/veo3/requests/abc', post('{}')],
      ['stability/v1/user/balance', {}],
    ];
    for (const [path, init] of refused) {
      for (const own of [false, true]) {
        const r = await request(`/api/ai/proxy/${path}`, { ...init, headers: own ? { 'x-ai-key': USER_KEY } : {} });
        expect(r.status, path).toBe(403);
        expect(r.json.error, path).toMatch(/Endpoint not allowed/);
        expect(r.res.headers.get('x-ai-proxy-error')).toBe('1');
      }
    }
    expect((await request('/api/ai/proxy/openai/v1/files/file-abc', { method: 'DELETE' })).status).toBe(405);
    expect(calls).toHaveLength(0);
    // Refusals used up no budget: the allowed calls still go through.
    expect((await request('/api/ai/proxy/replicate/v1/predictions', post('{}'))).status).toBe(200);
    expect((await request('/api/ai/proxy/replicate/v1/predictions/abc')).status).toBe(200);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST https://api.replicate.com/v1/predictions', 'GET https://api.replicate.com/v1/predictions/abc']);
  });

  it('does not proxy Tripo (it has its own rate-limited /api/tripo routes)', async () => {
    const { request, calls } = setup({ env: { TRIPO_API_KEY: ALL_KEYS.TRIPO_API_KEY, TRIPO_RATE_LIMIT: '2' } });
    for (const path of ['tripo/v2/openapi/task', 'tripo/v2/openapi/user/balance']) {
      const r = await request(`/api/ai/proxy/${path}`, post('{}'));
      expect(r.status, path).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  it('caps server-key generations per kind over all clients, per window and per day', async () => {
    let t = 1_000_000;
    const { request, calls, logs } = setup({
      env: { ...ALL_KEYS, TRUST_PROXY: '1', AI_PROXY_RATE_LIMIT: '1', AI_PROXY_GLOBAL_RATE_LIMIT: '3', AI_PROXY_RATE_WINDOW_SEC: '60' },
      now: () => t,
    });
    // Each client a different /64 (a fresh per-client bucket), all in different /48s.
    const gen = (i: number, kind = 'openai/v1/images/edits', h: Record<string, string> = {}) =>
      request(`/api/ai/proxy/${kind}`, post('x', { 'x-forwarded-for': `2001:db8:${i}:1::1`, ...h }));
    for (let i = 0; i < 3; i++) expect((await gen(i)).status).toBe(200);
    const blocked = await gen(3);
    expect(blocked.status).toBe(429);
    expect(blocked.json.error).toMatch(/budget is used up/);
    expect(blocked.res.headers.get('retry-after')).toBe('60');
    expect(logs.join('\n')).toMatch(/AI_PROXY_GLOBAL_RATE_LIMIT=3/);
    // Per kind; users' own keys are not affected.
    expect((await gen(4, 'replicate/v1/predictions')).status).toBe(200);
    expect((await gen(5, 'openai/v1/images/edits', { 'x-ai-key': USER_KEY })).status).toBe(200);
    expect(calls).toHaveLength(5);
    t += 60_000;
    expect((await gen(6)).status).toBe(200);

    let d = 0;
    const daily = setup({ env: { ...ALL_KEYS, TRUST_PROXY: '1', AI_PROXY_RATE_LIMIT: '0', AI_PROXY_DAILY_LIMIT: '2' }, now: () => d });
    const dgen = (ip: string) => daily.request('/api/ai/proxy/openai/v1/images/edits', post('x', { 'x-forwarded-for': ip }));
    expect((await dgen('1.1.1.1')).status).toBe(200);
    expect((await dgen('2.2.2.2')).status).toBe(200);
    d += 12 * 3_600_000;
    const r = await dgen('3.3.3.3');
    expect(r.status).toBe(429);
    expect(Number(r.res.headers.get('retry-after'))).toBe(12 * 3600);
    expect(daily.logs.join('\n')).toMatch(/daily .*AI_PROXY_DAILY_LIMIT=2/);
    d += 12 * 3_600_000;
    expect((await dgen('3.3.3.3')).status).toBe(200);
  });

  it('also limits server-key generations per IPv6 /48, not only per /64', async () => {
    const { request, calls } = setup({ env: { ...ALL_KEYS, TRUST_PROXY: '1', AI_PROXY_RATE_LIMIT: '1', AI_PROXY_GLOBAL_RATE_LIMIT: '0' } });
    const gen = (ip: string) => request('/api/ai/proxy/openai/v1/images/edits', post('x', { 'x-forwarded-for': ip }));
    // Four /64s of one /48 get their own budget each, up to 4× the per-client limit…
    for (let i = 0; i < 4; i++) expect((await gen(`2001:db8:aa:${i}::1`)).status).toBe(200);
    expect((await gen('2001:db8:aa:1::2')).status).toBe(429); // same /64
    expect((await gen('2001:db8:aa:99::1')).status).toBe(429); // a fifth /64 of that /48
    // …while other /48s and IPv4 clients are unaffected.
    expect((await gen('2001:db8:bb:1::1')).status).toBe(200);
    expect((await gen('203.0.113.7')).status).toBe(200);
    expect(calls).toHaveLength(6);
  });

  it('keeps part of AI_PROXY_MAX_CONCURRENT for server-key requests', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let started = 0;
    const { app, request } = setup({
      env: { ...ALL_KEYS, TRUST_PROXY: '1', AI_PROXY_MAX_CONCURRENT: '8' },
      handler: async () => {
        started++;
        await gate;
        return json({ ok: true });
      },
    });
    const hold = (ip: string, own: boolean) =>
      app.request('/api/ai/proxy/openai/v1/images/edits', {
        method: 'POST',
        body: 'x',
        headers: { [CLIENT_HEADER]: '1', 'x-forwarded-for': ip, ...(own ? { 'x-ai-key': USER_KEY } : {}) },
      });
    // Own keys (free to hold for as long as one likes) may use 6 of the 8 slots.
    const pending = ['10.0.0.1', '10.0.0.1', '10.0.0.2', '10.0.0.2', '10.0.0.3', '10.0.0.3'].map((ip) => hold(ip, true));
    await vi.waitFor(() => expect(started).toBe(6));
    const byok = await request('/api/ai/proxy/openai/v1/images/edits', post('x', { 'x-forwarded-for': '10.0.0.4', 'x-ai-key': USER_KEY }));
    expect(byok.status).toBe(429);
    expect(byok.json.error).toMatch(/in progress/);
    pending.push(hold('10.0.0.5', false));
    await vi.waitFor(() => expect(started).toBe(7));
    open();
    for (const r of await Promise.all(pending)) {
      expect(r.status).toBe(200);
      await r.text();
    }
  });

  it('shrinks the per-client cap as the slots fill up', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let started = 0;
    const { app, request } = setup({
      env: { ...ALL_KEYS, TRUST_PROXY: '1', AI_PROXY_MAX_CONCURRENT: '12' },
      handler: async () => {
        started++;
        await gate;
        return json({ ok: true });
      },
    });
    const hold = (ip: string) => app.request('/api/ai/proxy/openai/v1/images/edits', { method: 'POST', body: 'x', headers: { [CLIENT_HEADER]: '1', 'x-forwarded-for': ip } });
    // 12 slots: the first client gets 6 (half of what is free), the next 3, then 2 each.
    const pending: (Response | Promise<Response>)[] = [];
    for (let i = 0; i < 6; i++) pending.push(hold('10.0.0.1'));
    await vi.waitFor(() => expect(started).toBe(6));
    expect((await request('/api/ai/proxy/openai/v1/images/edits', post('x', { 'x-forwarded-for': '10.0.0.1' }))).status).toBe(429);
    for (let i = 0; i < 3; i++) pending.push(hold('10.0.0.2'));
    await vi.waitFor(() => expect(started).toBe(9));
    expect((await request('/api/ai/proxy/openai/v1/images/edits', post('x', { 'x-forwarded-for': '10.0.0.2' }))).status).toBe(429);
    for (let i = 0; i < 2; i++) pending.push(hold('10.0.0.3'));
    await vi.waitFor(() => expect(started).toBe(11));
    open();
    for (const r of await Promise.all(pending)) {
      expect(r.status).toBe(200);
      await r.text();
    }
  });

  it('proxies openai-compatible only to listed bases', async () => {
    const env = { AI_PROXY_EXTRA_BASES: 'https://llm.example.com/v1, http://127.0.0.1:11434/v1' };
    const { request, calls } = setup({ env });
    const ok = await request('/api/ai/proxy/openai-compatible/images/edits', post('{}', { 'x-ai-base': 'https://LLM.example.com/v1/', 'x-ai-key': USER_KEY }));
    expect(ok.status).toBe(200);
    expect(calls[0].url).toBe('https://llm.example.com/v1/images/edits');
    expect(calls[0].headers.get('authorization')).toBe(`Bearer ${USER_KEY}`);
    await request('/api/ai/proxy/openai-compatible/models', { headers: { 'x-ai-base': 'http://127.0.0.1:11434/v1', 'x-ai-auth': 'api-key', 'x-ai-key': 'k' } });
    expect(calls[1].url).toBe('http://127.0.0.1:11434/v1/models');
    expect(calls[1].headers.get('api-key')).toBe('k');
    expect(calls[1].headers.has('authorization')).toBe(false);
    // Keyless local endpoints are fine.
    await request('/api/ai/proxy/custom-http/images/edits', post('{}', { 'x-ai-base': 'https://llm.example.com/v1' }));
    expect(calls[2].headers.has('authorization')).toBe(false);
    for (const base of ['https://evil.com/v1', 'https://llm.example.com', 'https://llm.example.com/v1/extra', '']) {
      const r = await request('/api/ai/proxy/openai-compatible/images/edits', post('{}', { 'x-ai-base': base }));
      expect(r.status, base).toBe(403);
    }
    // A listed base is reachable by anyone: only the endpoints the client uses (no free chat inference on a local LLM).
    for (const path of ['chat/completions', 'completions', 'embeddings', 'api/generate']) {
      const r = await request(`/api/ai/proxy/openai-compatible/${path}`, post('{}', { 'x-ai-base': 'http://127.0.0.1:11434/v1' }));
      expect(r.status, path).toBe(403);
      expect(r.json.error, path).toMatch(/Endpoint not allowed/);
    }
    expect(calls).toHaveLength(3);
  });
});

describe('GET /api/ai/fetch', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const cdn = (c: Call) => new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(PNG.length), 'set-cookie': 'x=1' }, status: c.url ? 200 : 500 });
  const f = (url: string) => `/api/ai/fetch?url=${encodeURIComponent(url)}`;

  it('downloads provider output from allow-listed hosts without credentials', async () => {
    const { request, calls } = setup({ env: ALL_KEYS, handler: cdn });
    for (const url of [
      'https://replicate.delivery/pbxt/abc/out.png',
      'https://pbxt.replicate.delivery/x/out.png',
      'https://v3.fal.media/files/lion/out.png',
      'https://fal.media/files/out.png',
      'https://storage.googleapis.com/falserverless/model.glb',
      'https://tripo-data.rg1.data.tripo3d.com/tcli/model.glb',
    ]) {
      const r = await request(f(url));
      expect(r.status, url).toBe(200);
      expect(r.res.headers.get('content-type')).toBe('image/png');
      expect(r.res.headers.get('content-length')).toBe(String(PNG.length));
      expect(r.res.headers.get('content-disposition')).toBe('attachment');
      expect(r.res.headers.get('content-security-policy')).toMatch(/sandbox/);
      expect(r.res.headers.get('set-cookie')).toBeNull();
      const call = calls.at(-1)!;
      expect(call.url).toBe(url);
      expect(call.init.redirect).toBe('manual');
      expect(call.init.credentials).toBe('omit');
      expect([...call.headers.keys()]).toEqual(['accept']);
    }
  });

  it('refuses look-alike hosts, IP literals, other schemes and ports without fetching', async () => {
    const { request, calls, logs } = setup({ handler: cdn });
    for (const url of [
      'https://evilfal.media/x.png',
      'https://fal.media.evil.com/x.png',
      'https://fal.media@evil.com/x.png',
      'https://replicate.delivery.evil.com/x.png',
      'https://storage.googleapis.com/other/x.png',
      'https://storage.googleapis.com/falserverless-evil/x.png',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://2130706433/x',
      'https://0x7f.0.0.1/x',
      'https://169.254.169.254/latest/meta-data',
      'http://v3.fal.media/x.png',
      'https://v3.fal.media:444/x.png',
      'file:///etc/passwd',
      'nonsense',
    ]) {
      const r = await request(f(url));
      expect([400, 403], url).toContain(r.status);
      expect(r.res.headers.get('x-ai-proxy-error')).toBe('1');
    }
    expect((await request('/api/ai/fetch')).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/AI_FETCH_ALLOWED_HOSTS/);
  });

  it('re-checks every redirect hop', async () => {
    const start = 'https://replicate.delivery/a.png';
    const evil = setup({
      handler: (c) => (c.url === start ? new Response(null, { status: 302, headers: { location: 'https://evil.com/a.png' } }) : cdn(c)),
    });
    const r = await evil.request(f(start));
    expect(r.status).toBe(502);
    expect(r.json.error).toMatch(/does not trust/);
    expect(evil.calls.map((c) => c.url)).toEqual([start]);

    const ip = setup({ handler: (c) => (c.url === start ? new Response(null, { status: 301, headers: { location: 'https://10.0.0.1/' } }) : cdn(c)) });
    expect((await ip.request(f(start))).status).toBe(502);
    expect(ip.calls).toHaveLength(1);

    const good = setup({
      handler: (c) => (c.url === start ? new Response(null, { status: 302, headers: { location: '/moved/a.png' } }) : cdn(c)),
    });
    expect((await good.request(f(start))).status).toBe(200);
    expect(good.calls.map((c) => c.url)).toEqual([start, 'https://replicate.delivery/moved/a.png']);

    let n = 0;
    const loop = setup({ handler: () => new Response(null, { status: 302, headers: { location: `https://replicate.delivery/r${++n}` } }) });
    const l = await loop.request(f(start));
    expect(l.status).toBe(502);
    expect(l.json.error).toMatch(/redirects/);
    expect(loop.calls).toHaveLength(4);
  });

  it('caps the size by Content-Length and while streaming', async () => {
    const env = { AI_FETCH_MAX_MB: '0.0001' }; // 104 bytes
    const declared = setup({ env, handler: () => new Response(new Uint8Array(200), { headers: { 'content-length': '200' } }) });
    const d = await declared.request(f('https://fal.media/big.glb'));
    expect(d.status).toBe(413);
    const streamed = setup({ env, handler: () => new Response(new Uint8Array(200)) });
    const res = await streamed.app.request(f('https://fal.media/big.glb'), { headers: { [CLIENT_HEADER]: '1' } });
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it('maps upstream failures and passes an odd content type as octet-stream', async () => {
    const missing = setup({ handler: () => new Response('nope', { status: 404 }) });
    const m = await missing.request(f('https://fal.media/x.png'));
    expect(m.status).toBe(502);
    expect(m.json.error).toMatch(/HTTP 404/);
    const odd = setup({ handler: () => new Response('x', { headers: { 'content-type': 'text/htmlé' } }) });
    expect((await odd.request(f('https://fal.media/x.html'))).res.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('uses AI_FETCH_ALLOWED_HOSTS and TRIPO_ALLOWED_MODEL_HOSTS', async () => {
    const custom = setup({ env: { AI_FETCH_ALLOWED_HOSTS: 'cdn.example.org' }, handler: cdn });
    expect((await custom.request(f('https://files.cdn.example.org/a.png'))).status).toBe(200);
    expect((await custom.request(f('https://fal.media/a.png'))).status).toBe(403);
    const tripo = setup({ env: { TRIPO_ALLOWED_MODEL_HOSTS: 'models.tripo-cdn.net' }, handler: cdn });
    expect((await tripo.request(f('https://x.models.tripo-cdn.net/a.glb'))).status).toBe(200);
    expect((await tripo.request(f('https://fal.media/a.png'))).status).toBe(200);
    expect((await tripo.request(f('https://tripo3d.com/a.glb'))).status).toBe(403);
  });

  it('requires the client header, refuses HEAD and limits parallel downloads', async () => {
    const { app, request, calls } = setup({
      handler: () => new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) })),
    });
    expect((await request(f('https://fal.media/a.png'), {}, { client: false })).status).toBe(403);
    expect((await request(f('https://fal.media/a.png'), { method: 'HEAD' })).status).toBe(405);
    expect(calls).toHaveLength(0);
    const open = () => app.request(f('https://fal.media/a.png'), { headers: { [CLIENT_HEADER]: '1' } });
    const streams: Response[] = [];
    for (let i = 0; i < MAX_FETCH_PER_CLIENT; i++) streams.push(await open());
    expect(streams.every((r) => r.status === 200)).toBe(true);
    expect((await request(f('https://fal.media/a.png'))).status).toBe(429);
    await streams.shift()!.body!.cancel();
    const next = await open();
    expect(next.status).toBe(200);
    await Promise.all([...streams, next].map((r) => r.body!.cancel()));
  });
});
