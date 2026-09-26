/**
 * Server entry: `tsx server/index.ts` (dev: API only on 127.0.0.1, Vite
 * proxies /api here; `--production` or NODE_ENV=production: all interfaces,
 * and also serves the built SPA from ./dist, or STATIC_DIR).
 * Env: PORT (8787), HOST (default 127.0.0.1 in dev, all interfaces in
 * production), plus the API settings documented in ./app.ts.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { mountStatic, serverOptions, withHostGuard } from './runtime';

// .env is optional; existing environment variables win.
try {
  process.loadEnvFile();
} catch {
  // no .env file
}

const { port, hostname, production, guardHost } = serverOptions(process.argv.slice(2), process.env);
if (production) process.env.NODE_ENV = 'production';
const app = createApp();

if (production) {
  mountStatic(app, process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : fileURLToPath(new URL('../dist', import.meta.url)));
}

// On loopback in dev, still refuse foreign Host headers (DNS rebinding from a web page).
const server = serve({ fetch: guardHost ? withHostGuard(app.fetch) : app.fetch, port, hostname }, (info) => {
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
