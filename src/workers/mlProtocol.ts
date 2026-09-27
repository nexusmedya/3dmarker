/**
 * Message protocol between the main thread (src/drivers/ml/workerClient.ts)
 * and the ML worker (src/workers/ml.worker.ts). Type-only module.
 */

export type MlTask = 'depth-estimation' | 'background-removal';

/** Device preference: 'auto' = WebGPU when an adapter is available, else WASM. */
export type MlDevicePref = 'auto' | 'wasm';
export type MlDevice = 'webgpu' | 'wasm';

/** 'auto' = fp16 on WebGPU (if shader-f16), 8-bit on WASM; 'fp32' = full precision everywhere. */
export type MlPrecision = 'auto' | 'fp32';

/** Tightly packed 8-bit RGBA pixels; the buffer is transferred to the worker. */
export interface ImagePayload {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** transformers.js `env` overrides, applied once when the worker starts. */
export interface MlEnvConfig {
  /** Model hub mirror, e.g. 'https://my-cdn.example.com/' (default: Hugging Face). */
  remoteHost?: string;
  /** Path template appended to remoteHost (default '{model}/resolve/{revision}/'). */
  remotePathTemplate?: string;
  /**
   * Directory URL hosting onnxruntime-web's ort-wasm-simd-threaded.asyncify.{mjs,wasm}. Default: the copy
   * Vite bundles into /assets (jsDelivr only for Safari < 26 without WebGPU, which needs the plain build).
   */
  wasmPrefix?: string;
  /** Cache downloaded weights in the Cache API (default true). */
  useBrowserCache?: boolean;
  /**
   * A model/runtime download that receives no bytes (or no response headers)
   * for this long fails with ModelStalledError (default DEFAULT_STALL_TIMEOUT_MS; 0 = never).
   */
  stallTimeoutMs?: number;
}

/** Same default as the MediaPipe loader (src/core/human/config.ts). */
export const DEFAULT_STALL_TIMEOUT_MS = 30_000;

interface JobBase {
  id: number;
  model: string;
  device: MlDevicePref;
  precision: MlPrecision;
  image: ImagePayload;
}

export interface DepthJob extends JobBase {
  type: 'depth';
  /**
   * Make the image processor use the image's exact size instead of its
   * configured one. Only for models whose ONNX graph takes dynamic sizes and
   * when the caller already resized to a valid size (e.g. multiples of 14).
   */
  exactSize: boolean;
}

export interface BackgroundRemovalJob extends JobBase {
  type: 'background-removal';
}

export type MlJob = DepthJob | BackgroundRemovalJob;

export type MlRequest =
  | MlJob
  | { type: 'configure'; config: MlEnvConfig }
  | { type: 'cancel'; id: number }
  | { type: 'dispose' };

export type MlStage = 'load' | 'download' | 'inference';

export interface MlProgress {
  stage: MlStage;
  /** Download ratio 0..1 (download stage only, when totals are known). */
  ratio?: number;
  loadedBytes?: number;
  totalBytes?: number;
  device?: MlDevice;
}

export interface DepthPayload {
  kind: 'depth';
  /** Raw `predicted_depth` values (model units), row-major. */
  data: Float32Array;
  /** Tensor dims, [h, w] (possibly with leading 1s). */
  dims: number[];
  device: MlDevice;
  dtype: string;
}

export interface AlphaPayload {
  kind: 'alpha';
  /** Foreground matte 0..255 at width × height. */
  data: Uint8Array;
  width: number;
  height: number;
  device: MlDevice;
  dtype: string;
}

export type MlResult = DepthPayload | AlphaPayload;

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export type MlResponse =
  | ({ type: 'progress'; id: number } & MlProgress)
  | { type: 'result'; id: number; result: MlResult }
  | { type: 'error'; id: number; error: SerializedError };

/**
 * Error name the worker uses when a WebGPU attempt failed inside ONNX Runtime.
 * That leaves the worker unusable (see MlEngine.run), so the client retries
 * the job on WASM in a fresh worker.
 */
export const WEBGPU_FAILED_ERROR = 'WebGpuFailedError';

/**
 * Error name for a model download that stopped responding (a blackholed host,
 * a stalled proxy or CDN edge): fetch has no timeout of its own.
 */
export const MODEL_STALLED_ERROR = 'ModelStalledError';

export function modelStalledError(url: string, ms: number): Error {
  const err = new Error(`No data from ${url} for ${Math.round(ms / 1000)} s`);
  err.name = MODEL_STALLED_ERROR;
  return err;
}

export function serializeError(e: unknown): SerializedError {
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack };
  return { name: 'Error', message: String(e) };
}

export function deserializeError(e: SerializedError): Error {
  const err = new Error(e.message);
  err.name = e.name;
  if (e.stack) err.stack = e.stack;
  return err;
}
