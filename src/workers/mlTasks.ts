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
import { DEFAULT_STALL_TIMEOUT_MS, modelStalledError, type BackgroundRemovalJob, type DepthJob, type ImagePayload, type MlEnvConfig } from './mlProtocol';
import { alphaChannel } from '../core/preprocess/alphaMask';

export type AnyPipeline = DepthEstimationPipeline | BackgroundRemovalPipeline;

/** ORT wasm file URLs transformers.js picked at import time (jsDelivr); configureEnv reuses their file names. */
let ortDefaultPaths: { mjs?: string | URL; wasm?: string | URL } | undefined;

let stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS;
const stallWrapped = new WeakSet<FetchFn>();

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Statuses whose Response must have a null body. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * Wrap `fetchFn` so a request fails with ModelStalledError when its response
 * headers, or the next body chunk while the consumer is reading, take longer
 * than `stallMs()`. fetch has no timeout of its own: a blackholed host or a
 * stalled proxy would otherwise hang the model load forever. The timer only
 * runs while a read is pending, so a slow consumer never trips it.
 */
export function withStallTimeout(fetchFn: FetchFn, stallMs: () => number): FetchFn {
  const wrapped: FetchFn = async (input, init = {}) => {
    const ms = stallMs();
    if (!(ms > 0)) return fetchFn(input, init);
    const url = input instanceof Request ? input.url : String(input);
    const ac = new AbortController();
    const outer = init.signal;
    if (outer?.aborted) ac.abort(outer.reason);
    else outer?.addEventListener('abort', () => ac.abort(outer.reason), { once: true });
    const stalled = () => {
      const err = modelStalledError(url, ms);
      ac.abort(err);
      return err;
    };
    // Race a timer instead of relying on the abort alone: not every fetch honours the signal promptly.
    const race = <T>(p: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(stalled()), ms);
      });
      return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
    };
    const res = await race(fetchFn(input, { ...init, signal: ac.signal }));
    const body = res.body;
    if (!body || NULL_BODY.has(res.status) || res.status < 200 || res.status > 599) return res;
    const reader = body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        try {
          const { done, value } = await race(reader.read());
          if (done) ctrl.close();
          else ctrl.enqueue(value);
        } catch (e) {
          ctrl.error(e);
          reader.cancel(e).catch(() => undefined);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  stallWrapped.add(wrapped);
  return wrapped;
}

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
  // Every Hub and ORT-runtime download goes through env.fetch.
  const base = env.fetch as FetchFn | undefined;
  if (base && !stallWrapped.has(base)) env.fetch = withStallTimeout(base, () => stallTimeoutMs) as typeof env.fetch;
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
  if (c.stallTimeoutMs !== undefined && c.stallTimeoutMs >= 0) stallTimeoutMs = c.stallTimeoutMs;
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
