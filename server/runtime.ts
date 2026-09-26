/**
 * Pieces of the server entry (./index.ts) kept apart so they can be tested
 * without starting a server: startup options, the production SPA/static
 * handler and the dev-mode Host guard.
 */
import { isIP } from 'node:net';
import type { Env, Hono } from 'hono';
import { compress } from 'hono/compress';
import { serveStatic } from '@hono/node-server/serve-static';

export interface ServerOptions {
  port: number;
  /** Bind address; undefined = all interfaces. */
  hostname: string | undefined;
  /** Also serve the built SPA. */
  production: boolean;
  /** Refuse Host headers a DNS-rebinding page could send (see isRebindSafeHost). */
  guardHost: boolean;
}

/**
 * `--production` (or NODE_ENV=production): serve dist/ as well and listen on
 * all interfaces. Development listens on 127.0.0.1 only and checks the Host
 * header, so a key in .env is not exposed to the network; HOST overrides both.
 */
export function serverOptions(argv: readonly string[], env: NodeJS.ProcessEnv): ServerOptions {
  const production = argv.includes('--production') || env.NODE_ENV === 'production';
  const host = env.HOST?.trim() || undefined;
  return {
    port: Number(env.PORT ?? 8787),
    hostname: host ?? (production ? undefined : '127.0.0.1'),
    production,
    guardHost: !production && !host,
  };
}

/**
 * True for a Host header that DNS rebinding cannot produce: localhost (or
 * *.localhost) or an IP literal, with any port. A rebinding page always
 * sends its own domain name.
 */
export function isRebindSafeHost(host: string | null | undefined): boolean {
  const m = /^(?:\[([^\]]+)\]|([^:[\]]+))(?::\d{1,5})?$/.exec(host?.trim() ?? '');
  if (!m) return false;
  if (m[1] !== undefined) return isIP(m[1]) === 6;
  const name = m[2].toLowerCase().replace(/\.$/, '');
  return name === 'localhost' || name.endsWith('.localhost') || isIP(name) === 4;
}

type FetchHandler<A extends unknown[]> = (request: Request, ...rest: A) => Response | Promise<Response>;

/** Wrap a fetch handler so requests whose Host fails isRebindSafeHost get a 403. */
export function withHostGuard<A extends unknown[]>(handler: FetchHandler<A>): FetchHandler<A> {
  return (request, ...rest) =>
    isRebindSafeHost(request.headers.get('host')) ? handler(request, ...rest) : new Response('Forbidden host', { status: 403 });
}

const isApi = (path: string) => path === '/api' || path.startsWith('/api/');

/** Vite emits content-hashed files under /assets; everything else may change between deploys. */
export const cacheControlFor = (requestPath: string) =>
  requestPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';

/**
 * Serve the built SPA from `root` (gzip/deflate for text, JS, CSS, wasm):
 * files as they are, extension-less GET paths fall back to index.html, and
 * /api/* is never touched. Register after the API routes.
 */
export function mountStatic<E extends Env>(app: Hono<E>, root: string): void {
  // The request path decides the caching, not the file path: `root` itself may contain an "assets" directory.
  const assets = serveStatic({ root, onFound: (_path, c) => c.header('Cache-Control', cacheControlFor(c.req.path)) });
  const spaIndex = serveStatic({ root, path: 'index.html', onFound: (_path, c) => c.header('Cache-Control', 'no-cache') });
  const gzip = compress();
  // Registered first so it wraps both handlers below; never the API (the model route streams GLB).
  app.use('*', async (c, next) => (isApi(c.req.path) ? next() : gzip(c, next)));
  app.use('*', async (c, next) => (isApi(c.req.path) ? next() : assets(c, next)));
  // SPA fallback: extension-less GET paths get index.html; missing files stay 404.
  app.get('*', async (c, next) => (isApi(c.req.path) || /\.[A-Za-z0-9]+$/.test(c.req.path) ? next() : spaIndex(c, next)));
}
