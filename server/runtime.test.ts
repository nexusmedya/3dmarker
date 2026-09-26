import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { cacheControlFor, isRebindSafeHost, mountStatic, serverOptions, withHostGuard } from './runtime';

describe('serverOptions', () => {
  it('listens on loopback with a Host guard in development', () => {
    expect(serverOptions([], {})).toEqual({ port: 8787, hostname: '127.0.0.1', production: false, guardHost: true });
    expect(serverOptions([], { NODE_ENV: 'development', PORT: '9000' })).toMatchObject({ port: 9000, hostname: '127.0.0.1' });
  });

  it('listens on all interfaces in production (flag or NODE_ENV)', () => {
    expect(serverOptions(['--production'], {})).toEqual({ port: 8787, hostname: undefined, production: true, guardHost: false });
    expect(serverOptions([], { NODE_ENV: 'production' })).toMatchObject({ hostname: undefined, production: true });
  });

  it('lets HOST override the bind address (and drops the dev guard)', () => {
    expect(serverOptions([], { HOST: '0.0.0.0' })).toMatchObject({ hostname: '0.0.0.0', guardHost: false });
    expect(serverOptions(['--production'], { HOST: '10.0.0.5' })).toMatchObject({ hostname: '10.0.0.5' });
    expect(serverOptions([], { HOST: '  ' })).toMatchObject({ hostname: '127.0.0.1', guardHost: true });
  });
});

describe('Host guard', () => {
  it('accepts only hosts DNS rebinding cannot produce', () => {
    for (const ok of ['localhost', 'localhost:5173', 'LOCALHOST:8787', 'app.localhost:5173', '127.0.0.1:8787', '192.168.1.20:5173', '[::1]:8787', '[::1]']) {
      expect(isRebindSafeHost(ok), ok).toBe(true);
    }
    for (const bad of ['evil.example', 'evil.example:8787', 'localhost.evil.example', '127.0.0.1.nip.io', '[evil]:80', 'a:b:c', '', null, undefined]) {
      expect(isRebindSafeHost(bad), String(bad)).toBe(false);
    }
  });

  it('answers 403 before the app sees a foreign Host', async () => {
    let seen = 0;
    const guarded = withHostGuard(async () => {
      seen++;
      return new Response('ok');
    });
    const req = (host: string) => new Request('http://127.0.0.1:8787/api/health', { headers: { host } });
    expect((await guarded(req('evil.example:8787'))).status).toBe(403);
    expect((await guarded(new Request('http://127.0.0.1:8787/api/health'))).status).toBe(403); // no Host at all
    expect(seen).toBe(0);
    expect((await guarded(req('localhost:8787'))).status).toBe(200);
    expect(seen).toBe(1);
  });
});

describe('static SPA (production)', () => {
  // The deploy path itself contains an "assets" directory.
  const base = mkdtempSync(join(tmpdir(), '3dmarker-static-'));
  const root = join(base, 'srv', 'assets', 'app', 'dist');
  const script = `console.log(${JSON.stringify('x'.repeat(4000))});\n`;
  let server: ServerType;
  let origin = '';

  beforeAll(async () => {
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'index.html'), `<!doctype html><title>3D Marker</title>${'<!-- pad -->'.repeat(200)}`);
    writeFileSync(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(root, 'assets', 'app-abc123.js'), script);
    const app = createApp({ env: {}, logger: { info() {}, warn() {}, error() {} } });
    mountStatic(app, root);
    await new Promise<void>((ready) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => ready());
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server?.close();
    rmSync(base, { recursive: true, force: true });
  });

  const get = (path: string) => fetch(`${origin}${path}`, { headers: { 'accept-encoding': 'gzip' } });

  it('caches only /assets/* for a year, whatever the deploy path', async () => {
    for (const path of ['/', '/index.html', '/favicon.svg', '/some/route']) {
      const r = await get(path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get('cache-control'), path).toBe('no-cache');
      await r.arrayBuffer();
    }
    const js = await get('/assets/app-abc123.js');
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await get('/assets/missing.js')).status).toBe(404);
    expect(cacheControlFor('/assets/x.js')).toMatch(/immutable/);
    expect(cacheControlFor('/index.html')).toBe('no-cache');
  });

  it('compresses text assets but never the API', async () => {
    const js = await get('/assets/app-abc123.js');
    expect(js.headers.get('content-encoding')).toBe('gzip');
    expect(js.headers.get('vary')).toMatch(/accept-encoding/i);
    expect(await js.text()).toBe(script); // fetch decodes it
    const page = await get('/');
    expect(page.headers.get('content-encoding')).toBe('gzip');
    await page.arrayBuffer();
    const api = await get('/api/health');
    expect(api.headers.get('content-encoding')).toBeNull();
    expect(await api.json()).toEqual({ ok: true });
  });
});
