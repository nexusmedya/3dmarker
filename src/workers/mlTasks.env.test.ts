/**
 * initEnv / configureEnv: where ONNX Runtime Web loads its wasm from. Uses
 * fresh module instances (mlTasks keeps the transformers.js default paths).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0/dist/';

async function load(wasmPaths: unknown) {
  vi.resetModules();
  const { env } = await import('@huggingface/transformers');
  const tasks = await import('./mlTasks');
  // What transformers.js' backends/onnx.js sets at import time in the browser.
  (env.backends.onnx.wasm as { wasmPaths?: unknown }).wasmPaths = wasmPaths;
  return { wasm: env.backends.onnx.wasm as { wasmPaths?: unknown }, ...tasks };
}

describe('ORT wasm location', () => {
  let saved: unknown;
  beforeEach(async () => {
    const { env } = await import('@huggingface/transformers');
    saved = env.backends.onnx.wasm?.wasmPaths;
  });
  afterEach(async () => {
    const { env } = await import('@huggingface/transformers');
    if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = saved as undefined;
  });

  it('uses the asyncify build bundled into /assets instead of jsDelivr', async () => {
    const { wasm, initEnv, configureEnv } = await load({
      mjs: `${CDN}ort-wasm-simd-threaded.asyncify.mjs`,
      wasm: `${CDN}ort-wasm-simd-threaded.asyncify.wasm`,
    });
    initEnv();
    expect(wasm.wasmPaths).toBeUndefined();
    configureEnv({ remoteHost: 'https://m.example' }); // unrelated config keeps the bundled copy
    expect(wasm.wasmPaths).toBeUndefined();
    configureEnv({ wasmPrefix: '/ort' }); // explicit self-hosting keeps working
    expect(wasm.wasmPaths).toEqual({
      mjs: '/ort/ort-wasm-simd-threaded.asyncify.mjs',
      wasm: '/ort/ort-wasm-simd-threaded.asyncify.wasm',
    });
  });

  it('keeps the CDN paths for the plain build (not embedded in the bundle)', async () => {
    const plain = { mjs: `${CDN}ort-wasm-simd-threaded.mjs`, wasm: `${CDN}ort-wasm-simd-threaded.wasm` };
    const { wasm, initEnv, configureEnv } = await load(plain);
    initEnv();
    expect(wasm.wasmPaths).toEqual(plain);
    configureEnv({ wasmPrefix: '/ort/' });
    expect(wasm.wasmPaths).toEqual({ mjs: '/ort/ort-wasm-simd-threaded.mjs', wasm: '/ort/ort-wasm-simd-threaded.wasm' });
  });

  it('leaves unset paths alone (Node) and still honours a prefix', async () => {
    const { wasm, initEnv, configureEnv } = await load(undefined);
    initEnv();
    expect(wasm.wasmPaths).toBeUndefined();
    configureEnv({ wasmPrefix: '/ort/' });
    expect(wasm.wasmPaths).toBe('/ort/');
  });
});
