/**
 * Integration test: runs the real transformers.js pipelines (Node build,
 * onnxruntime-node CPU) against tiny hand-encoded ONNX models, pinning the
 * library behaviour ml.worker.ts relies on: processor size override,
 * predicted_depth layout, background-removal alpha output, progress events
 * and the error raised for missing dtype weights.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env, type BackgroundRemovalPipeline, type DepthEstimationPipeline } from '@huggingface/transformers';
import { isMissingWeightsError, MlEngine, type LoadRequest } from './mlEngine';
import { loadPipeline, runBackgroundRemoval, runDepth, type AnyPipeline } from './mlTasks';
import type { LoadProgressEvent } from '../drivers/ml/postprocess';

// --- minimal ONNX (protobuf) encoder -------------------------------------
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
/** ValueInfoProto for a float tensor; string dims are symbolic. */
const valueInfo = (name: string, dims: (number | string)[]) => [
  ...vStr(1, name),
  ...vBytes(2, vBytes(1, [
    ...vInt(1, FLOAT),
    ...vBytes(2, dims.flatMap((d) => vBytes(1, typeof d === 'number' ? vInt(1, d) : vStr(2, d)))),
  ])),
];
const attrInts = (name: string, ints: number[]) => [...vStr(1, name), ...ints.flatMap((i) => vInt(8, i)), ...vInt(20, 7)];
const attrInt = (name: string, i: number) => [...vStr(1, name), ...vInt(3, i), ...vInt(20, 2)];
const node = (op: string, ins: string[], outs: string[], attrs: number[][] = []) =>
  [...ins.flatMap((s) => vStr(1, s)), ...outs.flatMap((s) => vStr(2, s)), ...vStr(4, op), ...attrs.flatMap((a) => vBytes(5, a))];
const onnxModel = (nodes: number[][], inputs: number[][], outputs: number[][]) => new Uint8Array([
  ...vInt(1, 8), // ir_version
  ...vBytes(8, vInt(2, 13)), // opset 13
  ...vBytes(7, [
    ...nodes.flatMap((n) => vBytes(1, n)),
    ...vStr(2, 'g'),
    ...inputs.flatMap((v) => vBytes(11, v)),
    ...outputs.flatMap((v) => vBytes(12, v)),
  ]),
]);

// --- fixtures --------------------------------------------------------------
let root = '';

function writeModel(id: string, config: object, preprocessor: object, onnx: Uint8Array) {
  const dir = join(root, id);
  mkdirSync(join(dir, 'onnx'), { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  writeFileSync(join(dir, 'preprocessor_config.json'), JSON.stringify(preprocessor));
  writeFileSync(join(dir, 'onnx', 'model.onnx'), onnx); // fp32 only
}

/** Left half black, right half white. */
function halfImage(w: number, h: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = i % w < w / 2 ? 0 : 255;
    px.set([v, v, v, 255], i * 4);
  }
  return px;
}

/** The Node build has no 'wasm' device; map it to CPU. */
const load = (req: LoadRequest) => loadPipeline({ ...req, device: (req.device === 'wasm' ? 'cpu' : req.device) as LoadRequest['device'] });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tjs-fixtures-'));
  // "Depth Anything": depth = mean of normalised channels (bright = near).
  writeModel('fake/depth', { model_type: 'depth_anything' }, {
    do_normalize: true, do_pad: false, do_rescale: true, do_resize: true, ensure_multiple_of: 14,
    image_mean: [0.5, 0.5, 0.5], image_std: [0.5, 0.5, 0.5], image_processor_type: 'DPTImageProcessor',
    keep_aspect_ratio: true, resample: 3, rescale_factor: 1 / 255, size: { height: 518, width: 518 },
  }, onnxModel(
    [node('ReduceMean', ['pixel_values'], ['predicted_depth'], [attrInts('axes', [1]), attrInt('keepdims', 0)])],
    [valueInfo('pixel_values', ['b', 3, 'h', 'w'])],
    [valueInfo('predicted_depth', ['b', 'h', 'w'])],
  ));
  // "MODNet": matte = sigmoid(mean of channels); input is not called pixel_values, like the real one.
  writeModel('fake/matte', { model_type: 'modnet' }, {
    do_normalize: true, do_pad: false, do_rescale: true, do_resize: true, image_mean: [0.5, 0.5, 0.5], image_std: [0.5, 0.5, 0.5],
    resample: 2, rescale_factor: 1 / 255, size: { shortest_edge: 64 }, size_divisibility: 32, feature_extractor_type: 'ImageFeatureExtractor',
  }, onnxModel(
    [node('ReduceMean', ['input'], ['m'], [attrInts('axes', [1]), attrInt('keepdims', 1)]), node('Sigmoid', ['m'], ['output'])],
    [valueInfo('input', ['b', 3, 'h', 'w'])],
    [valueInfo('output', ['b', 1, 'h', 'w'])],
  ));
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = `${root}/`;
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('transformers.js integration (Node, tiny ONNX models)', () => {
  it('depth: exact-size override reaches the model, output is at input size, size is restored', async () => {
    const events: LoadProgressEvent[] = [];
    const pipe = (await load({
      task: 'depth-estimation', model: 'fake/depth', device: 'wasm', dtype: 'fp32', onLoadProgress: (e) => events.push(e),
    })) as DepthEstimationPipeline;
    expect(events.map((e) => e.status)).toEqual(expect.arrayContaining(['initiate', 'progress', 'done', 'ready']));
    expect(events.find((e) => e.status === 'progress')).toMatchObject({ file: expect.any(String), loaded: expect.any(Number), total: expect.any(Number) });

    const ip = pipe.processor.image_processor!;
    const seen: number[][] = [];
    const orig = ip._call.bind(ip);
    ip._call = async (...args: Parameters<typeof orig>) => {
      const r = await orig(...args);
      seen.push(r.pixel_values.dims);
      return r;
    };

    const W = 70, H = 28;
    const exact = await runDepth(pipe, { image: { width: W, height: H, data: halfImage(W, H) }, exactSize: true });
    const native = await runDepth(pipe, { image: { width: W, height: H, data: halfImage(W, H) }, exactSize: false });
    expect(seen).toEqual([[1, 3, 28, 70], [1, 3, 210, 518]]);
    expect(ip.size).toEqual({ height: 518, width: 518 });
    for (const r of [exact, native]) {
      expect(r.dims).toEqual([28, 70]);
      expect(r.data).toBeInstanceOf(Float32Array);
      expect(r.data[W - 1]).toBeGreaterThan(r.data[0]); // bright right half = larger = nearer
    }
    await pipe.dispose();
  }, 60_000);

  it('background removal: returns the matte as alpha at the input size', async () => {
    const pipe = (await load({
      task: 'background-removal', model: 'fake/matte', device: 'wasm', dtype: 'fp32', onLoadProgress: () => {},
    })) as BackgroundRemovalPipeline;
    const W = 70, H = 28;
    const out = await runBackgroundRemoval(pipe, { image: { width: W, height: H, data: halfImage(W, H) } });
    expect(out.width).toBe(W);
    expect(out.height).toBe(H);
    expect(out.data).toHaveLength(W * H);
    expect(out.data[0]).toBeLessThan(128); // dark = background
    expect(out.data[W - 1]).toBeGreaterThan(128); // bright = foreground
    await pipe.dispose();
  }, 60_000);

  it('missing dtype weights raise the error MlEngine falls back on', async () => {
    const err = await load({ task: 'depth-estimation', model: 'fake/depth', device: 'wasm', dtype: 'fp16', onLoadProgress: () => {} })
      .then(() => null, (e: unknown) => e);
    expect(isMissingWeightsError(err)).toBe(true);
  }, 60_000);

  it('MlEngine falls back from q8 (missing) to fp32 with the real loader', async () => {
    const engine = new MlEngine<AnyPipeline>({
      load,
      dispose: (p) => p.dispose(),
      detectGpu: async () => ({ available: false, fp16: false }),
    });
    const W = 28, H = 28;
    const r = await engine.run(
      { task: 'depth-estimation', model: 'fake/depth', device: 'auto', precision: 'auto' },
      () => {},
      (pipe) => runDepth(pipe as DepthEstimationPipeline, { image: { width: W, height: H, data: halfImage(W, H) }, exactSize: true }),
    );
    expect(r).toMatchObject({ device: 'wasm', dtype: 'fp32' });
    expect(r.result.dims).toEqual([28, 28]);
    await engine.disposeAll();
  }, 60_000);
});
