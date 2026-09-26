/**
 * transformers.js-facing task code used by ml.worker.ts: env setup, pipeline
 * loading and the two jobs. No `self`/`postMessage` here, so the same code
 * runs under the Node build of transformers.js in integration tests.
 */
import {
  env,
  pipeline,
  RawImage,
  type BackgroundRemovalPipeline,
  type DataType,
  type DepthEstimationPipeline,
  type DeviceType,
} from '@huggingface/transformers';
import type { LoadRequest } from './mlEngine';
import type { BackgroundRemovalJob, DepthJob, ImagePayload, MlEnvConfig } from './mlProtocol';
import { alphaChannel } from '../core/preprocess/alphaMask';

export type AnyPipeline = DepthEstimationPipeline | BackgroundRemovalPipeline;

/** ORT wasm file URLs transformers.js picked at import time (jsDelivr); configureEnv reuses their file names. */
let ortDefaultPaths: { mjs?: string | URL; wasm?: string | URL } | undefined;

/**
 * Browser defaults: never probe /models/ on our origin; fetch from the Hub and
 * keep weights in the Cache API. ONNX Runtime's wasm is served by this app:
 * the onnxruntime-web bundle transformers.js imports embeds the asyncify
 * loader and references its .wasm with `new URL(..., import.meta.url)`, which
 * Vite emits into /assets. transformers.js points both at jsDelivr instead;
 * unsetting wasmPaths makes ORT use the bundled pair. The plain build (Safari
 * < 26 without WebGPU) is not embedded, so it keeps the CDN paths.
 */
export function initEnv(): void {
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = typeof caches !== 'undefined';
  const wasm = env.backends.onnx.wasm;
  const cur = wasm?.wasmPaths;
  if (wasm && cur && typeof cur === 'object') {
    ortDefaultPaths = { ...cur };
    if (String(cur.wasm).endsWith('.asyncify.wasm')) wasm.wasmPaths = undefined;
  }
}

export function configureEnv(c: MlEnvConfig): void {
  const slash = (s: string) => (s.endsWith('/') ? s : `${s}/`);
  if (c.remoteHost) env.remoteHost = slash(c.remoteHost);
  if (c.remotePathTemplate) env.remotePathTemplate = c.remotePathTemplate;
  if (c.useBrowserCache !== undefined) env.useBrowserCache = c.useBrowserCache && typeof caches !== 'undefined';
  const wasm = env.backends.onnx.wasm;
  if (c.wasmPrefix && wasm) {
    // transformers.js chose the right build (asyncify or plain) and pointed
    // it at jsDelivr (initEnv switched asyncify to the bundled copy); keep
    // the file names and swap the directory.
    const prefix = slash(c.wasmPrefix);
    const cur = ortDefaultPaths ?? wasm.wasmPaths;
    const rebase = (u: string | URL | undefined) => (u ? prefix + String(u).split('/').pop() : undefined);
    wasm.wasmPaths = cur && typeof cur === 'object' ? { mjs: rebase(cur.mjs), wasm: rebase(cur.wasm) } : prefix;
  }
}

export function loadPipeline(req: LoadRequest): Promise<AnyPipeline> {
  return pipeline(req.task, req.model, {
    device: req.device as DeviceType,
    dtype: req.dtype as DataType,
    progress_callback: req.onLoadProgress,
  });
}

export function toRawImage({ width, height, data }: ImagePayload): RawImage {
  if (data.length !== width * height * 4) throw new Error(`Expected ${width}×${height} RGBA pixels, got ${data.length} bytes`);
  return new RawImage(data, width, height, 4);
}

export async function runDepth(pipe: DepthEstimationPipeline, job: Pick<DepthJob, 'image' | 'exactSize'>) {
  const image = toRawImage(job.image);
  // The pipeline takes no size option; the processor reads `size` on every
  // call, so override it for this call only (jobs run one at a time).
  const ip = pipe.processor?.image_processor;
  const exact = !!(job.exactSize && ip && ip.do_resize && !ip.do_pad && !ip.do_center_crop);
  const prevSize: unknown = ip?.size;
  if (exact) ip!.size = { width: image.width, height: image.height };
  try {
    // predicted_depth is already interpolated to the input image size.
    const { predicted_depth } = await pipe(image);
    return { data: new Float32Array(predicted_depth.data as Float32Array), dims: [...predicted_depth.dims] };
  } finally {
    if (exact) ip!.size = prevSize;
  }
}

export async function runBackgroundRemoval(pipe: BackgroundRemovalPipeline, job: Pick<BackgroundRemovalJob, 'image'>) {
  // Returns the input image with the predicted matte as its alpha channel.
  const out = await pipe(toRawImage(job.image));
  return { data: alphaChannel(out.data, out.width, out.height, out.channels), width: out.width, height: out.height };
}
