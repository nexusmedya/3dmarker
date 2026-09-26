import { describe, expect, it } from 'vitest';
import { PROXY_KINDS } from './providers';
import {
  AI_KEY_PATTERN,
  DEFAULT_FETCH_HOSTS,
  buildTargetUrl,
  buildUpstreamHeaders,
  checkFetchUrl,
  joinBase,
  parseHostRules,
  rawPathAndQuery,
  redactKeys,
  relayResponseHeaders,
  safeContentType,
  sanitizePrefer,
  validateProxyPath,
} from './proxy';

describe('validateProxyPath', () => {
  it('accepts ordinary API paths', () => {
    for (const p of [
      'v1/images/edits',
      'v1beta/models/gemini-2.5-flash-image:generateContent',
      'v1/models/black-forest-labs/flux-kontext-pro/predictions',
      'fal-ai/trellis',
      'queue/fal-ai/trellis/requests/0a1b-2c3d/status',
      'v2/openapi/task/abc_123',
      'v2beta/3d/stable-fast-3d',
      'v1/files/a%20b.png',
      'a/b/',
    ]) {
      expect(validateProxyPath(p), p).toBe(p);
    }
  });

  it('rejects traversal, encoded separators, empty segments and scheme-like paths', () => {
    for (const p of [
      '',
      '..',
      'v1/../x',
      'v1/./x',
      '%2e%2e/x',
      'v1/%2E%2e/x',
      '.%2e/x',
      'v1%2F..%2Fx',
      'v1%2fx',
      'v1%5Cx',
      'v1\\x',
      'v1//x',
      '/v1/x',
      'https:/evil.com/x',
      'https:',
      'HTTP:%2F%2Fevil.com',
      'v1/%00',
      'v1/%0d%0aX-Injected:1',
      'v1/a b',
      'v1/a?b',
      'v1/a#b',
      'v1/%zz',
      'x'.repeat(3000),
    ]) {
      expect(validateProxyPath(p), p).toBeNull();
    }
  });
});

describe('buildTargetUrl', () => {
  it('always stays on the kind base', () => {
    expect(buildTargetUrl(PROXY_KINDS.openai, 'v1/images/edits', '')?.toString()).toBe('https://api.openai.com/v1/images/edits');
    expect(buildTargetUrl(PROXY_KINDS.replicate, 'v1/predictions/abc', 'a=1')?.toString()).toBe('https://api.replicate.com/v1/predictions/abc?a=1');
    expect(buildTargetUrl(PROXY_KINDS.openai, '@evil.com/x', '')?.host).toBe('api.openai.com');
  });

  it("routes fal's queue/ prefix to the queue host", () => {
    expect(buildTargetUrl(PROXY_KINDS.fal, 'fal-ai/flux/dev', '')?.toString()).toBe('https://fal.run/fal-ai/flux/dev');
    expect(buildTargetUrl(PROXY_KINDS.fal, 'queue/fal-ai/trellis', '')?.toString()).toBe('https://queue.fal.run/fal-ai/trellis');
    expect(buildTargetUrl(PROXY_KINDS.fal, 'queue/', '')).toBeNull();
    // Only the exact prefix: 'queued/x' stays on fal.run.
    expect(buildTargetUrl(PROXY_KINDS.fal, 'queued/x', '')?.host).toBe('fal.run');
  });

  it('drops key query parameters where the kind says so, keeping the rest verbatim', () => {
    expect(buildTargetUrl(PROXY_KINDS.gemini, 'v1beta/models', 'key=AIzaLeak&pageSize=5')?.search).toBe('?pageSize=5');
    expect(buildTargetUrl(PROXY_KINDS.gemini, 'v1beta/models', 'pageSize=5&x=a%20b')?.search).toBe('?pageSize=5&x=a%20b');
    expect(buildTargetUrl(PROXY_KINDS.openai, 'v1/models', 'key=kept')?.search).toBe('?key=kept');
  });

  it('joinBase keeps the base path prefix', () => {
    expect(joinBase('https://llm.example.com/v1', 'chat/completions', '')?.toString()).toBe('https://llm.example.com/v1/chat/completions');
    expect(joinBase('https://llm.example.com/v1', '../admin', '')).toBeNull();
  });
});

describe('rawPathAndQuery', () => {
  it('splits without decoding', () => {
    expect(rawPathAndQuery('http://h/api/ai/proxy/openai/v1%2Fx?a=%20&b#frag')).toEqual({ path: '/api/ai/proxy/openai/v1%2Fx', query: 'a=%20&b' });
    expect(rawPathAndQuery('http://h/p')).toEqual({ path: '/p', query: '' });
  });
});

describe('request headers', () => {
  const incoming = new Headers({
    'content-type': 'multipart/form-data; boundary=abc',
    accept: 'application/json',
    cookie: 'session=1',
    authorization: 'Bearer from-client',
    'x-3dmarker-client': '1',
    'x-ai-key': 'sk-user',
    'x-forwarded-for': '1.2.3.4',
    host: 'localhost',
    connection: 'keep-alive',
    prefer: 'wait=300',
    'x-fal-queue-priority': 'low',
    'x-fal-runner-hint': 'x'.repeat(300),
  });

  it('forwards only content headers, per-kind extras and the injected auth', () => {
    const h = buildUpstreamHeaders(PROXY_KINDS.openai, incoming, 'sk-server', '10');
    expect([...h.keys()].sort()).toEqual(['accept', 'authorization', 'content-length', 'content-type']);
    expect(h.get('authorization')).toBe('Bearer sk-server');
    expect(h.get('content-length')).toBe('10');
  });

  it('uses each kind’s auth scheme', () => {
    expect(buildUpstreamHeaders(PROXY_KINDS.gemini, new Headers(), 'AIzaK', null).get('x-goog-api-key')).toBe('AIzaK');
    expect(buildUpstreamHeaders(PROXY_KINDS.gemini, new Headers(), 'AIzaK', null).has('authorization')).toBe(false);
    expect(buildUpstreamHeaders(PROXY_KINDS.fal, new Headers(), 'id:secret', null).get('authorization')).toBe('Key id:secret');
    for (const k of ['openai', 'stability', 'replicate'] as const) {
      expect(buildUpstreamHeaders(PROXY_KINDS[k], new Headers(), 'k1', null).get('authorization'), k).toBe('Bearer k1');
    }
    expect(buildUpstreamHeaders(PROXY_KINDS.openai, new Headers(), null, null).has('authorization')).toBe(false);
  });

  it('caps Replicate’s Prefer wait and passes safe fal headers', () => {
    expect(buildUpstreamHeaders(PROXY_KINDS.replicate, incoming, 'k', null).get('prefer')).toBe('wait=60');
    const fal = buildUpstreamHeaders(PROXY_KINDS.fal, incoming, 'k', null);
    expect(fal.get('x-fal-queue-priority')).toBe('low');
    expect(fal.has('x-fal-runner-hint')).toBe(false); // too long
    expect(buildUpstreamHeaders(PROXY_KINDS.openai, incoming, 'k', null).has('prefer')).toBe(false);
  });

  it('sanitizePrefer', () => {
    expect(sanitizePrefer('wait')).toBe('wait=60');
    expect(sanitizePrefer('wait=5')).toBe('wait=5');
    expect(sanitizePrefer(' wait = 0 ')).toBe('wait=1');
    expect(sanitizePrefer('wait=9999')).toBe('wait=60');
    expect(sanitizePrefer('respond-async')).toBeNull();
    expect(sanitizePrefer('wait=5, other')).toBeNull();
  });
});

describe('response headers', () => {
  it('relays only safe headers and drops a decoded body’s length', () => {
    const up = new Headers({
      'content-type': 'application/json',
      'content-length': '42',
      'set-cookie': 'a=1',
      'access-control-allow-origin': '*',
      'strict-transport-security': 'max-age=1',
      'x-request-id': 'req_1',
      'x-ratelimit-remaining-requests': '9',
      'retry-after': '3',
      connection: 'close',
      'alt-svc': 'h3',
    });
    const out = relayResponseHeaders(up);
    expect([...out.keys()].sort()).toEqual(['content-length', 'content-type', 'retry-after', 'x-ratelimit-remaining-requests', 'x-request-id']);
    up.set('content-encoding', 'gzip');
    const gz = relayResponseHeaders(up);
    expect(gz.has('content-length')).toBe(false);
    expect(gz.has('content-encoding')).toBe(false);
  });
});

describe('redactKeys', () => {
  it('removes given secrets and key-shaped tokens', () => {
    const text =
      'bad key sk-proj-abcdefghijklmnopqrstuv and AIzaSyA1234567890abcdefghijklmnopqrstu r8_abcdefghijklmnopqrstuvwxyz tsk_abcdefghij ' +
      '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b:0123456789abcdef0123 mysecretvalue';
    const out = redactKeys(text, ['mysecretvalue', null, '']);
    expect(out).not.toMatch(/sk-proj|AIzaSy|r8_a|tsk_a|0f1e2d3c|mysecretvalue/);
    expect(out.match(/\[redacted\]/g)).toHaveLength(6);
  });
});

describe('AI_KEY_PATTERN', () => {
  it('accepts header-safe keys only', () => {
    for (const k of ['sk-proj-abc_DEF-123', 'AIzaSy-_x', 'r8_abc', 'id:secret', 'a+b/c=']) expect(AI_KEY_PATTERN.test(k), k).toBe(true);
    for (const k of ['', 'with space', 'line\nbreak', 'ünicode', 'x'.repeat(1025)]) expect(AI_KEY_PATTERN.test(k), k).toBe(false);
  });
});

describe('download allow-list', () => {
  const rules = parseHostRules(`${DEFAULT_FETCH_HOSTS},tripo3d.com,*.only-subs.example`)!;
  const ok = (u: string) => checkFetchUrl(u, rules).ok;

  it('parses host rules', () => {
    expect(parseHostRules(' A.com, *.b.org ,,c.net/some/prefix/ , *.d.net/p, 1.2.3.4, bad host, localhost')).toEqual([
      { host: 'a.com', subdomains: 'also', pathPrefix: '' },
      { host: 'b.org', subdomains: 'only', pathPrefix: '' },
      { host: 'c.net', subdomains: 'exact', pathPrefix: '/some/prefix' },
      { host: 'd.net', subdomains: 'only', pathPrefix: '/p' },
    ]);
    expect(parseHostRules('')).toBeNull();
    expect(parseHostRules('1.2.3.4')).toBeNull();
  });

  it('allows provider CDNs (host + subdomains, case and trailing dot insensitive)', () => {
    for (const u of [
      'https://replicate.delivery/pbxt/abc/out.png',
      'https://pbxt.replicate.delivery/x/model.glb',
      'https://fal.media/files/a.png',
      'https://v3.fal.media/files/lion/a.glb',
      'https://V3.FAL.MEDIA./files/a.png',
      'https://storage.googleapis.com/falserverless/model.glb',
      'https://storage.googleapis.com/falserverless',
      'https://tripo-data.rg1.data.tripo3d.com/m.glb',
      'https://a.only-subs.example/x',
    ]) {
      expect(ok(u), u).toBe(true);
    }
  });

  it('refuses look-alikes, other paths, IPs, credentials, ports and non-https', () => {
    for (const u of [
      'https://evilfal.media/x.png',
      'https://fal.media.evil.com/x.png',
      'https://fal.media@evil.com/x.png',
      'https://evil.com/fal.media/x.png',
      'https://replicate.delivery.evil.com/x',
      'https://notreplicate.delivery/x',
      'https://only-subs.example/x',
      'https://storage.googleapis.com/other-bucket/x',
      'https://storage.googleapis.com/falserverless-evil/x',
      'https://storage.googleapis.com/falserverless%2F..%2Fother/x',
      'https://storage.googleapis.com/falserverless/../other/x',
      // A path-limited entry is that exact host: any GCS bucket is served at <bucket>.storage.googleapis.com.
      'https://attacker-bucket.storage.googleapis.com/falserverless/x',
      'https://x.storage.googleapis.com/falserverless/big.bin',
      'http://v3.fal.media/x.png',
      'https://v3.fal.media:8443/x.png',
      'https://user:pw@v3.fal.media/x.png',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://[::ffff:169.254.169.254]/x',
      'https://2130706433/x',
      'https://0x7f.0.0.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/x',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) {
      expect(ok(u), u).toBe(false);
    }
  });

  it('marks allow-list misses (not malformed URLs) with the host', () => {
    expect(checkFetchUrl('https://evil.com/x', rules)).toMatchObject({ ok: false, host: 'evil.com' });
    expect(checkFetchUrl('https://127.0.0.1/x', rules)).not.toHaveProperty('host');
    expect(checkFetchUrl('http://fal.media/x', rules)).not.toHaveProperty('host');
  });

  it('safeContentType', () => {
    expect(safeContentType('image/png')).toBe('image/png');
    expect(safeContentType('model/gltf-binary')).toBe('model/gltf-binary');
    expect(safeContentType('text/plain; charset=utf-8')).toBe('text/plain; charset=utf-8');
    expect(safeContentType('text/html\r\nX: y')).toBe('application/octet-stream');
    expect(safeContentType(null)).toBe('application/octet-stream');
    expect(safeContentType('nonsense')).toBe('application/octet-stream');
  });
});
