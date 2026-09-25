/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Shell variables win over .env (same rule as server/index.ts).
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const apiTarget = `http://localhost:${Number(env.PORT || 8787)}`;
  // Opt-in (same flag as the production server, see server/app.ts): cross-origin
  // isolation lets onnxruntime-web use multi-threaded WASM for the ML drivers.
  const headers: Record<string, string> =
    env.CROSS_ORIGIN_ISOLATION === '1' || env.CROSS_ORIGIN_ISOLATION === 'true'
      ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' }
      : {};

  return {
    plugins: [react()],
    worker: { format: 'es' as const },
    optimizeDeps: {
      // transformers.js ships its own wasm loader; pre-bundling breaks it.
      exclude: ['@huggingface/transformers'],
    },
    server: { headers, proxy: { '/api': apiTarget } },
    preview: { headers, proxy: { '/api': apiTarget } },
    build: {
      // three's core is ~600 kB minified (150 kB gzip); the ML worker is a separate ~550 kB chunk.
      chunkSizeWarningLimit: 700,
      rolldownOptions: {
        output: {
          // Long-lived vendor chunks cache across app deploys.
          codeSplitting: {
            groups: [
              // Core only: the loaders under three/examples stay lazy (GLB results).
              { name: 'three', test: /node_modules[\\/]three[\\/](build|src)[\\/]/ },
              { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            ],
          },
        },
      },
    },
    test: {
      environment: 'node' as const,
      include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
    },
  };
});
