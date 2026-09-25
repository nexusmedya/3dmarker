/**
 * Server entry: `tsx server/index.ts` (dev: API only, Vite proxies /api here;
 * NODE_ENV=production: also serves the built SPA from ./dist, or STATIC_DIR).
 * Env: PORT (8787), HOST, plus the API settings documented in ./app.ts.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app';

// .env is optional; existing environment variables win.
try {
  process.loadEnvFile();
} catch {
  // no .env file
}

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST || undefined;
const production = process.env.NODE_ENV === 'production';
const app = createApp();

if (production) {
  const root = process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : fileURLToPath(new URL('../dist', import.meta.url));
  const isApi = (path: string) => path === '/api' || path.startsWith('/api/');
  const assets = serveStatic({
    root,
    onFound: (path, c) => {
      // Vite emits content-hashed files under /assets; everything else may change between deploys.
      c.header('Cache-Control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  const spaIndex = serveStatic({ root, path: 'index.html', onFound: (_p, c) => c.header('Cache-Control', 'no-cache') });
  app.use('*', async (c, next) => (isApi(c.req.path) ? next() : assets(c, next)));
  // SPA fallback: extension-less GET paths get index.html; missing files stay 404.
  app.get('*', async (c, next) => (isApi(c.req.path) || /\.[A-Za-z0-9]+$/.test(c.req.path) ? next() : spaIndex(c, next)));
}

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  const host = hostname && hostname !== '0.0.0.0' && hostname !== '::' ? hostname : 'localhost';
  console.log(`3D Marker ${production ? 'server' : 'API'} listening on http://${host}:${info.port}`);
  console.log(`Tripo3D server key: ${process.env.TRIPO_API_KEY?.trim() ? 'configured' : 'not set (users must supply their own key)'}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
