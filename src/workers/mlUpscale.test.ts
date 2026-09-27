/**
 * Integration test for the 'image-to-image' (Swin2SR) task: the real
 * transformers.js pipeline (Node build, onnxruntime-node CPU) runs a tiny
 * hand-encoded ONNX "super-resolution" model (nearest ×2 via Concat +
 * DepthToSpace) with a Swin2SR processor config. Pins what runUpscale relies
 * on: model input `pixel_values`, output `reconstruction` in [0, 1] as a
 * 3-channel RawImage of padded size × scale, a no-op processor padding for
 * tiles that are multiples of 8, and seamless tile blending.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { env, type ImageToImagePipeline } from '@huggingface/transformers';
import { MlEngine, type LoadRequest } from './mlEngine';
import { loadPipeline, runUpscale, type AnyPipeline } from './mlTasks';

// --- minimal ONNX (protobuf) encoder (as in mlTasks.test.ts) ---------------
const varint = (n: number): number[] => {
  const o: number[] = [];
  while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); }
  o.push(n);
  return o;
};
const tag = (no: number, wireType: number) => varint(no * 8 + wireType);
const vInt = (no: number, n: number) => [...tag(no, 0), ...varint(n)];
const vBytes = (no: number, b: number[]) => [...tag(no, 2), ...varint(b.length), ...b];
const vStr = (no: number, s: string) => vBytes(no, [...new TextEncoder().encode(s)]);
const FLOAT = 1;
const valueInfo = (name: string, dims: (number | string)[]) => [
  ...vStr(1, name),
  ...vBytes(2, vBytes(1, [
    ...vInt(1, FLOAT),
    ...vBytes(2, dims.flatMap((d) => vBytes(1, typeof d === 'number' ? vInt(1, d) : vStr(2, d)))),
  ])),
];
const attrInt = (name: string, i: number) => [...vStr(1, name), ...vInt(3, i), ...vInt(20, 2)];
const node = (op: string, ins: string[], outs: string[], attrs: number[][] = []) =>
  [...ins.flatMap((s) => vStr(1, s)), ...outs.flatMap((s) => vStr(2, s)), ...vStr(4, op), ...attrs.flatMap((a) => vBytes(5, a))];
const onnxModel = (nodes: number[][], inputs: number[][], outputs: number[][]) => new Uint8Array([
  ...vInt(1, 8),
  ...vBytes(8, vInt(2, 13)),
  ...vBytes(7, [
    ...nodes.flatMap((n) => vBytes(1, n)),
    ...vStr(2, 'g'),
    ...inputs.flatMap((v) => vBytes(11, v)),
    ...outputs.flatMap((v) => vBytes(12, v)),
  ]),
]);

let root = '';

/** Swin2SR-like processor: rescale to [0, 1], pad to a multiple of 8 (symmetric), no resize / normalisation. */
const SWIN2SR_PREPROCESSOR = { do_pad: true, do_rescale: true, image_processor_type: 'Swin2SRImageProcessor', pad_size: 8, rescale_factor: 1 / 255 };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tjs-sr-'));
  const dir = join(root, 'fake', 'sr2');
  mkdirSync(join(dir, 'onnx'), { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ model_type: 'swin2sr', upscale: 2, num_channels: 3 }));
  writeFileSync(join(dir, 'preprocessor_config.json'), JSON.stringify(SWIN2SR_PREPROCESSOR));
  // Nearest ×2: four copies of the channels, rearranged into 2 × 2 blocks (DCR).
  writeFileSync(join(dir, 'onnx', 'model.onnx'), onnxModel(
    [
      node('Concat', ['pixel_values', 'pixel_values', 'pixel_values', 'pixel_values'], ['c'], [attrInt('axis', 1)]),
      node('DepthToSpace', ['c'], ['reconstruction'], [attrInt('blocksize', 2)]),
    ],
    [valueInfo('pixel_values', ['b', 3, 'h', 'w'])],
    [valueInfo('reconstruction', ['b', 3, 'H', 'W'])],
  ));
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = `${root}/`;
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const load = (req: LoadRequest) => loadPipeline({ ...req, device: (req.device === 'wasm' ? 'cpu' : req.device) as LoadRequest['device'] });

function testImage(w: number, h: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) px.set([(x * 7) % 256, (y * 11) % 256, (x * y) % 256, x < 3 ? 0 : 255], (y * w + x) * 4);
  return px;
}

describe('image-to-image (Swin2SR) integration', () => {
  it('the pipeline returns a 3-channel RawImage of the (multiple-of-8) input × scale', async () => {
    const pipe = (await load({ task: 'image-to-image', model: 'fake/sr2', device: 'wasm', dtype: 'fp32', onLoadProgress: () => {} })) as ImageToImagePipeline;
    const { RawImage } = await import('@huggingface/transformers');
    const out = await pipe(new RawImage(new Uint8ClampedArray(16 * 8 * 3).fill(200), 16, 8, 3));
    expect([out.width, out.height, out.channels]).toEqual([32, 16, 3]);
    expect(out.data[0]).toBe(200);
    // An odd size is padded by the processor (so runUpscale pads tiles itself and crops).
    const odd = await pipe(new RawImage(new Uint8ClampedArray(13 * 5 * 3).fill(10), 13, 5, 3));
    expect([odd.width, odd.height]).toEqual([32, 16]);
    await pipe.dispose();
  }, 60_000);

  it('runUpscale tiles, blends seamlessly and reports progress', async () => {
    const pipe = (await load({ task: 'image-to-image', model: 'fake/sr2', device: 'wasm', dtype: 'fp32', onLoadProgress: () => {} })) as ImageToImagePipeline;
    const W = 70, H = 45;
    const data = testImage(W, H);
    const onTile = vi.fn();
    const out = await runUpscale(pipe, { image: { width: W, height: H, data }, scale: 2, tile: 24, overlap: 8 }, 'wasm', { onTile });
    expect([out.width, out.height, out.scale]).toEqual([140, 90, 2]);
    expect(onTile).toHaveBeenLastCalledWith(onTile.mock.calls.length, onTile.mock.calls.length);
    expect(onTile.mock.calls.length).toBeGreaterThan(4);
    let maxDiff = 0;
    for (let y = 0; y < 90; y++)
      for (let x = 0; x < 140; x++) {
        const s = ((y >> 1) * W + (x >> 1)) * 4;
        const o = (y * 140 + x) * 4;
        for (let c = 0; c < 3; c++) maxDiff = Math.max(maxDiff, Math.abs(out.data[o + c] - data[s + c]));
        expect(out.data[o + 3]).toBe(255); // opaque: the caller puts the alpha back
      }
    expect(maxDiff).toBeLessThanOrEqual(1);
    await pipe.dispose();
  }, 60_000);

  it('stops between tiles when cancelled', async () => {
    const pipe = (await load({ task: 'image-to-image', model: 'fake/sr2', device: 'wasm', dtype: 'fp32', onLoadProgress: () => {} })) as ImageToImagePipeline;
    let tiles = 0;
    const err = await runUpscale(pipe, { image: { width: 64, height: 64, data: testImage(64, 64) }, scale: 2, tile: 16, overlap: 4 }, 'wasm', {
      onTile: () => tiles++,
      isCancelled: () => tiles >= 2,
    }).then(() => null, (e: unknown) => e as Error);
    expect(err?.name).toBe('AbortError');
    expect(tiles).toBe(2);
    await pipe.dispose();
  }, 60_000);

  it('MlEngine loads the image-to-image task and passes a cancellation on WebGPU through (no WASM retry)', async () => {
    const engine = new MlEngine<AnyPipeline>({ load, dispose: (p) => p.dispose(), detectGpu: async () => ({ available: false, fp16: false }) });
    const r = await engine.run({ task: 'image-to-image', model: 'fake/sr2', device: 'auto', precision: 'auto' }, () => {}, (pipe, device) =>
      runUpscale(pipe as ImageToImagePipeline, { image: { width: 20, height: 12, data: testImage(20, 12) }, scale: 2 }, device),
    );
    expect(r).toMatchObject({ device: 'wasm', dtype: 'fp32' });
    expect([r.result.width, r.result.height]).toEqual([40, 24]);
    await engine.disposeAll();

    const gpuEngine = new MlEngine<object>({ load: async () => ({}), dispose: () => {}, detectGpu: async () => ({ available: true, fp16: false }) });
    const calls: string[] = [];
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const e = await gpuEngine
      .run({ task: 'image-to-image', model: 'm', device: 'auto', precision: 'auto' }, () => {}, async (_p, device) => {
        calls.push(device);
        throw abort;
      })
      .then(() => null, (x: unknown) => x);
    expect(e).toBe(abort);
    expect(calls).toEqual(['webgpu']);
  }, 60_000);
});
