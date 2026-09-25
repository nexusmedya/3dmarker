import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_HOSTS,
  TripoClient,
  TripoError,
  isTrustedModelUrl,
  openModelDownload,
  parseHostList,
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
