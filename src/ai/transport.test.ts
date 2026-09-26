import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AbortError } from '../core/types';
import { createProviderConfig } from './settings';
import {
  aiFetch,
  AiError,
  aiTiming,
  directUrl,
  downloadOutput,
  errorFromStatus,
  extractErrorDetail,
  isTransientError,
  readJson,
  requestTarget,
  routeFor,
  withRetry,
} from './transport';
import { createServer, type Server } from 'node:http';
import { fakeNet, json, pngBlob, PNG_BASE64 } from './testing';

const signal = () => new AbortController().signal;
const saved = { ...aiTiming };

beforeEach(() => Object.assign(aiTiming, saved));
afterEach(() => vi.unstubAllGlobals());

async function rejects(p: Promise<unknown>): Promise<AiError> {
  try {
    await p;
  } catch (e) {
    return e as AiError;
  }
  throw new Error('expected a rejection');
}

describe('routing', () => {
  it('calls CORS-friendly kinds directly and the rest through the proxy', () => {
    expect(routeFor(createProviderConfig('openai'))).toBe('direct');
    expect(routeFor(createProviderConfig('gemini'))).toBe('direct');
    expect(routeFor(createProviderConfig('fal'))).toBe('direct');
    expect(routeFor(createProviderConfig('stability'))).toBe('proxy');
    expect(routeFor(createProviderConfig('replicate'))).toBe('proxy');
    expect(routeFor(createProviderConfig('tripo'))).toBe('proxy');
    expect(routeFor(createProviderConfig('custom-http'))).toBe('direct');
    expect(routeFor(createProviderConfig('openai', { managed: true }))).toBe('proxy');
    expect(routeFor(createProviderConfig('openai-compatible', { values: { direct: false } }))).toBe('proxy');
  });

  it('builds direct URLs (fal queue host, compatible base URL)', () => {
    expect(directUrl(createProviderConfig('openai'), 'v1/images/edits')).toBe('https://api.openai.com/v1/images/edits');
    expect(directUrl(createProviderConfig('fal'), 'queue/fal-ai/trellis')).toBe('https://queue.fal.run/fal-ai/trellis');
    expect(directUrl(createProviderConfig('fal'), 'fal-ai/trellis')).toBe('https://fal.run/fal-ai/trellis');
    expect(directUrl(createProviderConfig('openai-compatible', { values: { baseUrl: 'https://gw.example/v1/' } }), '/images/edits')).toBe(
      'https://gw.example/v1/images/edits',
    );
  });

  it('sets the auth header per kind for direct calls', () => {
    expect(requestTarget(createProviderConfig('openai', { apiKey: 'sk-abc' }), 'v1/x').headers).toEqual({ Authorization: 'Bearer sk-abc' });
    expect(requestTarget(createProviderConfig('gemini', { apiKey: 'AIzaXYZ' }), 'v1beta/x').headers).toEqual({ 'x-goog-api-key': 'AIzaXYZ' });
    expect(requestTarget(createProviderConfig('fal', { apiKey: 'id:secret' }), 'queue/a/b').headers).toEqual({ Authorization: 'Key id:secret' });
    expect(requestTarget(createProviderConfig('openai-compatible', { apiKey: 'k1', values: { baseUrl: 'https://x/v1', authHeader: 'api-key' } }), 'm').headers).toEqual({ 'api-key': 'k1' });
    expect(requestTarget(createProviderConfig('openai-compatible', { apiKey: 'k1', values: { baseUrl: 'https://x/v1', authHeader: 'none' } }), 'm').headers).toEqual({});
  });

  it('relays the user key in x-ai-key through the proxy, and nothing for managed configs', () => {
    const user = requestTarget(createProviderConfig('replicate', { apiKey: 'r8_abc' }), 'v1/predictions');
    expect(user.url).toBe('/api/ai/proxy/replicate/v1/predictions');
    expect(user.headers).toEqual({ 'x-3dmarker-client': '1', 'x-ai-key': 'r8_abc' });
    const managed = requestTarget(createProviderConfig('openai', { id: 'server-openai', managed: true }), 'v1/images/edits');
    expect(managed.url).toBe('/api/ai/proxy/openai/v1/images/edits');
    expect(managed.headers).toEqual({ 'x-3dmarker-client': '1' });
    const compat = requestTarget(createProviderConfig('openai-compatible', { apiKey: 'k', values: { baseUrl: 'https://gw.example/v1', direct: false } }), 'images/edits');
    expect(compat.headers['x-ai-base']).toBe('https://gw.example/v1');
    expect(compat.headers['x-ai-auth']).toBe('bearer');
  });

  it('rejects missing and malformed keys before sending', () => {
    expect(() => requestTarget(createProviderConfig('openai'), 'v1/x')).toThrow(expect.objectContaining({ code: 'missing-key' }));
    expect(() => requestTarget(createProviderConfig('openai', { apiKey: 'sk bad key' }), 'v1/x')).toThrow(expect.objectContaining({ code: 'key-format' }));
    // Invisible characters picked up when copying are stripped.
    expect(requestTarget(createProviderConfig('openai', { apiKey: '​sk-ok﻿ ' }), 'v1/x').headers.Authorization).toBe('Bearer sk-ok');
    // Keyless kinds are fine without one.
    expect(requestTarget(createProviderConfig('openai-compatible', { values: { baseUrl: 'https://x/v1' } }), 'm').headers).toEqual({});
  });
});

describe('error normalisation', () => {
  const direct = { name: 'OpenAI', route: 'direct' as const, key: 'sk-secretsecret' };

  it('extracts messages from the usual body shapes', () => {
    expect(extractErrorDetail({ error: { message: 'Bad key', code: 'invalid_api_key' } })).toEqual({ message: 'Bad key', codes: 'invalid_api_key' });
    expect(extractErrorDetail({ detail: [{ loc: ['body', 'image_url'], msg: 'field required' }] }).message).toBe('body.image_url: field required');
    expect(extractErrorDetail({ name: 'content_moderation', errors: ['Your request was flagged'] })).toEqual({ message: 'Your request was flagged', codes: 'content_moderation' });
    expect(extractErrorDetail({ title: 'Invalid version', detail: 'The version does not exist' }).message).toBe('The version does not exist');
    expect(extractErrorDetail('<html><body>Not Found</body></html>').message).toBe('Not Found');
  });

  it('maps statuses to codes with bilingual text', () => {
    const e401 = errorFromStatus(401, { error: { message: 'Incorrect API key provided: sk-secretsecret' } }, direct);
    expect(e401.code).toBe('auth');
    expect(e401.i18n.tr).toContain('OpenAI');
    expect(e401.i18n.en).not.toContain('sk-secretsecret');
    expect(errorFromStatus(401, { error: { message: 'bad key r8_abcdefghijklmnop' } }, { ...direct, key: undefined }).detail).toBe('bad key ***');
    expect(errorFromStatus(500, { detail: 'skeletonization failed' }, direct).detail).toBe('skeletonization failed');
    expect(errorFromStatus(400, { error: { message: 'Your request was rejected as a result of our safety system.', code: 'moderation_blocked' } }, direct).code).toBe('content-policy');
    expect(errorFromStatus(403, { name: 'content_moderation', errors: ['flagged'] }, direct).code).toBe('content-policy');
    expect(errorFromStatus(429, { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } }, direct).code).toBe('billing');
    const rate = errorFromStatus(429, { error: { message: 'Rate limit' } }, { ...direct, retryAfterSec: 20 });
    expect(rate.code).toBe('rate-limit');
    expect(rate.i18n.en).toContain('20 s');
    expect(errorFromStatus(402, {}, direct).code).toBe('billing');
    expect(errorFromStatus(403, { error: { message: 'Organization must be verified' } }, direct).code).toBe('forbidden');
    expect(errorFromStatus(404, { detail: 'Model not found' }, direct).code).toBe('not-found');
    expect(errorFromStatus(413, '', direct).code).toBe('too-large');
    expect(errorFromStatus(422, { detail: 'bad field' }, direct).code).toBe('bad-request');
    expect(errorFromStatus(503, 'overloaded', direct).code).toBe('server');
    // Gemini answers 400 INVALID_ARGUMENT for a bad key.
    expect(errorFromStatus(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }, direct).code).toBe('auth');
  });

  it('recognises a missing server / proxy', () => {
    const proxy = { name: 'Replicate', route: 'proxy' as const };
    expect(errorFromStatus(404, '<html>404</html>', { ...proxy, contentType: 'text/html' }).code).toBe('needs-server');
    expect(errorFromStatus(404, { error: 'Not found' }, { ...proxy, contentType: 'application/json' }).code).toBe('needs-server');
    expect(errorFromStatus(404, { detail: 'model gone' }, { ...proxy, contentType: 'application/json' }).code).toBe('not-found');
    // Errors of the proxy itself (and of the older /api/tripo routes, which say the same).
    expect(errorFromStatus(401, { error: 'No Replicate API key: the server has none configured' }, { ...proxy, proxyError: true }).code).toBe('missing-key');
    expect(errorFromStatus(401, { error: 'No Tripo API key: the server has none configured' }, proxy).code).toBe('missing-key');
    expect(errorFromStatus(404, { error: 'Unknown or disabled provider kind: replicate' }, { ...proxy, proxyError: true }).code).toBe('needs-server');
  });
});

describe('aiFetch', () => {
  it('sends to the direct URL with auth and returns 2xx responses', async () => {
    const net = fakeNet().on('POST', 'https://api.openai.com/v1/images/edits', json({ ok: 1 }));
    vi.stubGlobal('fetch', net.fetch);
    const res = await aiFetch(createProviderConfig('openai', { apiKey: 'sk-1' }), 'v1/images/edits', { method: 'POST', body: 'x', signal: signal() });
    expect(await res.json()).toEqual({ ok: 1 });
    expect(net.calls[0].headers.get('authorization')).toBe('Bearer sk-1');
  });

  it('turns HTTP errors into AiErrors', async () => {
    vi.stubGlobal('fetch', fakeNet().on(null, /openai/, json({ error: { message: 'Invalid key' } }, 401)).fetch);
    const e = await rejects(aiFetch(createProviderConfig('openai', { apiKey: 'sk-1' }), 'v1/models', { signal: signal() }));
    expect(e).toBeInstanceOf(AiError);
    expect(e.code).toBe('auth');
    expect(e.status).toBe(401);
  });

  it('reports network failures per route', async () => {
    vi.stubGlobal('fetch', fakeNet().on(null, /./, new TypeError('Failed to fetch')).fetch);
    expect((await rejects(aiFetch(createProviderConfig('gemini', { apiKey: 'AIza1' }), 'v1beta/models', { signal: signal() }))).code).toBe('network');
    expect((await rejects(aiFetch(createProviderConfig('stability', { apiKey: 'sk-1' }), 'v1/user/account', { signal: signal() }))).code).toBe('needs-server');
  });

  it('times out and aborts', async () => {
    const hang = (_: unknown, init: RequestInit = {}) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    vi.stubGlobal('fetch', hang);
    const cfg = createProviderConfig('openai', { apiKey: 'sk-1' });
    expect((await rejects(aiFetch(cfg, 'v1/models', { signal: signal(), timeoutMs: 20 }))).code).toBe('timeout');
    const ctl = new AbortController();
    const p = aiFetch(cfg, 'v1/models', { signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toBeInstanceOf(AbortError);
  });
});

describe('downloadOutput', () => {
  it('decodes data URIs', async () => {
    const blob = await downloadOutput(`data:image/png;base64,${PNG_BASE64}`, { signal: signal() });
    expect(blob.type).toBe('image/png');
  });

  it('downloads directly, falling back to /api/ai/fetch when CORS blocks it', async () => {
    const url = 'https://replicate.delivery/abc/out.png';
    const net = fakeNet()
      .on('GET', url, new TypeError('CORS'))
      .on('GET', `/api/ai/fetch?url=${encodeURIComponent(url)}`, new Response(pngBlob(), { headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', net.fetch);
    const blob = await downloadOutput(url, { signal: signal() });
    expect(blob.type).toBe('image/png');
    expect(net.calls.map((c) => c.url)).toEqual([url, `/api/ai/fetch?url=${encodeURIComponent(url)}`]);
    expect(net.calls[1].headers.get('x-3dmarker-client')).toBe('1');
  });

  it('does not retry through the server on HTTP errors, and explains a missing server', async () => {
    const url = 'https://v3.fal.media/files/x.glb';
    vi.stubGlobal('fetch', fakeNet().on('GET', url, json({ detail: 'expired' }, 403)).fetch);
    expect((await rejects(downloadOutput(url, { signal: signal() }))).code).toBe('forbidden');
    vi.stubGlobal('fetch', fakeNet().on('GET', /./, new TypeError('CORS')).fetch);
    expect((await rejects(downloadOutput(url, { signal: signal() }))).code).toBe('needs-server');
  });
});

describe('rate limits vs billing (429)', () => {
  const ctx = { name: 'P', route: 'direct' as const };

  it('treats Gemini per-minute RESOURCE_EXHAUSTED as a rate limit and reads RetryInfo', () => {
    const body = {
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message: 'You exceeded your current quota, please check your plan and billing details.',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' },
        ],
      },
    };
    expect(extractErrorDetail(body).retryAfterSec).toBe(12);
    const e = errorFromStatus(429, body, ctx);
    expect(e.code).toBe('rate-limit');
    expect(e.retryAfterSec).toBe(12);
    expect(e.i18n.en).toContain('try again in 12 s');
    // A daily quota is an exhausted quota.
    const daily = { error: { ...body.error, details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } };
    expect(errorFromStatus(429, daily, ctx).code).toBe('billing');
  });

  it('treats OpenAI rate_limit_exceeded as a rate limit and insufficient_quota as billing', () => {
    const rate = {
      error: {
        type: 'requests',
        code: 'rate_limit_exceeded',
        message: 'Rate limit reached for gpt-image-1 on images per min: Limit 5. Please try again in 12s. Visit https://platform.openai.com/account/rate-limits. You can increase your rate limit by adding a payment method to your account at https://platform.openai.com/account/billing.',
      },
    };
    const e = errorFromStatus(429, rate, ctx);
    expect(e.code).toBe('rate-limit');
    expect(e.retryAfterSec).toBe(12);
    expect(errorFromStatus(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }, ctx).code).toBe('billing');
    expect(errorFromStatus(429, { error: 'slow down' }, { ...ctx, retryAfterSec: 3 }).retryAfterSec).toBe(3);
  });
});

describe('retries', () => {
  beforeEach(() => Object.assign(aiTiming, { retryBaseMs: 1, retryMaxMs: 2 }));

  it('classifies transient errors', () => {
    expect(isTransientError(new AiError({ tr: '', en: '' }, 'server', 502))).toBe(true);
    expect(isTransientError(new AiError({ tr: '', en: '' }, 'server', 501))).toBe(false);
    expect(isTransientError(new AiError({ tr: '', en: '' }, 'rate-limit', 429))).toBe(true);
    expect(isTransientError(new AiError({ tr: '', en: '' }, 'network'))).toBe(true);
    expect(isTransientError(new AiError({ tr: '', en: '' }, 'needs-server', 404))).toBe(false);
    expect(isTransientError(new AiError({ tr: '', en: '' }, 'bad-request', 408))).toBe(true);
    expect(isTransientError(new AiError({ tr: '', en: '' }, 'auth', 401))).toBe(false);
    expect(isTransientError(new Error('x'))).toBe(false);
  });

  it('retries 5xx / 429 / network errors of idempotent GETs, and stops on others or at the deadline', async () => {
    const net = fakeNet().on('GET', 'https://api.openai.com/v1/x', json({}, 502), json({ error: 'slow' }, 429), new TypeError('Failed to fetch'), json({ ok: 1 }));
    vi.stubGlobal('fetch', net.fetch);
    const cfg = createProviderConfig('openai', { apiKey: 'sk-test' });
    const s = signal();
    const get = async () => readJson(await aiFetch(cfg, 'v1/x', { method: 'GET', signal: s }), 'OpenAI', s);
    expect(await withRetry(get, { signal: s })).toEqual({ ok: 1 });
    expect(net.calls).toHaveLength(4);

    const bad = fakeNet().on('GET', /./, json({ error: { message: 'nope' } }, 401));
    vi.stubGlobal('fetch', bad.fetch);
    expect((await rejects(withRetry(get, { signal: s }))).code).toBe('auth');
    expect(bad.calls).toHaveLength(1);

    const down = fakeNet().on('GET', /./, json({}, 500));
    vi.stubGlobal('fetch', down.fetch);
    expect((await rejects(withRetry(get, { signal: s, attempts: 3 }))).code).toBe('server');
    expect(down.calls).toHaveLength(3);
    const late = fakeNet().on('GET', /./, json({}, 500));
    vi.stubGlobal('fetch', late.fetch);
    expect((await rejects(withRetry(get, { signal: s, deadline: Date.now() }))).code).toBe('server');
    expect(late.calls).toHaveLength(1);
  });
});

describe('body reads stay under the timeout and abort', () => {
  let server: Server;
  let url = '';
  beforeEach(async () => {
    // Sends the headers and one byte, then stalls.
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.write('x');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/out.png`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it('cancels a stalled download on abort', async () => {
    const ctl = new AbortController();
    const p = downloadOutput(url, { signal: ctl.signal, timeoutMs: 5000 });
    setTimeout(() => ctl.abort(), 150);
    await expect(p).rejects.toBeInstanceOf(AbortError);
  });

  it('times out a stalled download', async () => {
    const e = await rejects(downloadOutput(url, { signal: signal(), timeoutMs: 200 }));
    expect(e).toBeInstanceOf(AiError);
    expect(e.code).toBe('timeout');
  });
});
