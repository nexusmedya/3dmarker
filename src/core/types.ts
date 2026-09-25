/**
 * Core contracts shared by every driver, the mesh builder and the UI.
 *
 * A "driver" is one strategy for turning a 2D image into 3D. Drivers are
 * listed in a select box; each declares its own parameters (rendered
 * generically by the UI) and returns one of three result kinds:
 *
 *  - `depth`    a per-pixel depth map; the shared mesh builder turns it into a
 *               surface (relief / solid / double-sided) using MeshOptions.
 *  - `geometry` a ready three.js BufferGeometry (e.g. silhouette extrusion).
 *  - `model`    a complete binary glTF (e.g. from a cloud image-to-3D API).
 *
 * Coordinate frame for `geometry` results (and the mesh builder output):
 * +Y up, +Z towards the viewer, the image's longest side spans 2 units
 * (x ∈ [-1, 1] for landscape images), centred on the origin in X/Y.
 * UVs map (0,0) to the image's bottom-left corner.
 */
import type { BufferGeometry } from 'three';

/** Localised UI text. Every user-facing string carries both languages. */
export interface I18nText {
  tr: string;
  en: string;
}

export type Lang = keyof I18nText;

/** 8-bit RGBA image, row-major, top row first (same layout as ImageData). */
export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Foreground mask, row-major, top row first. 1 = foreground, 0 = background. */
export interface Mask {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Depth map, row-major, top row first.
 * Values are normalised to [0, 1] where **1 = closest to the viewer**.
 */
export interface DepthMap {
  width: number;
  height: number;
  data: Float32Array;
}

interface ParamBase {
  key: string;
  label: I18nText;
  hint?: I18nText;
}

export interface NumberParam extends ParamBase {
  kind: 'number';
  min: number;
  max: number;
  step: number;
  default: number;
}

export interface BooleanParam extends ParamBase {
  kind: 'boolean';
  default: boolean;
}

export interface SelectParam extends ParamBase {
  kind: 'select';
  options: { value: string; label: I18nText }[];
  default: string;
}

export interface TextParam extends ParamBase {
  kind: 'text';
  default: string;
  /** Render as a password field and never persist it. */
  secret?: boolean;
  placeholder?: string;
}

export type ParamSpec = NumberParam | BooleanParam | SelectParam | TextParam;
export type ParamValue = number | boolean | string;
export type ParamValues = Record<string, ParamValue>;

export interface Progress {
  label: I18nText;
  /** 0..1 when known; undefined renders an indeterminate bar. */
  ratio?: number;
}

export type DriverCategory = 'ml' | 'heuristic' | 'cloud';

export type DriverBadge =
  | 'offline' // runs fully locally, no downloads
  | 'download' // downloads model weights on first use (cached afterwards)
  | 'webgpu' // accelerated by WebGPU when available (falls back to WASM)
  | 'api-key' // needs a server-side or user-supplied API key
  | 'closed-mesh' // produces a watertight mesh
  | 'full-3d'; // reconstructs unseen sides (not just 2.5D)

export interface DriverInput {
  /** Working image (already downscaled to the app's max working size). */
  image: RGBAImage;
  /** Foreground mask derived from the PNG alpha channel / background removal; null when the image is fully opaque and no removal ran. */
  mask: Mask | null;
  /** The original uploaded file (for drivers that upload it somewhere). */
  file: Blob;
  params: ParamValues;
  signal: AbortSignal;
  onProgress: (p: Progress) => void;
}

export type DriverResult =
  | { kind: 'depth'; depth: DepthMap; mask: Mask | null }
  | { kind: 'geometry'; geometry: BufferGeometry }
  | { kind: 'model'; glb: ArrayBuffer };

export interface Availability {
  ok: boolean;
  reason?: I18nText;
}

export interface Driver {
  /** Stable id, used in URLs / persisted settings. */
  id: string;
  name: I18nText;
  description: I18nText;
  category: DriverCategory;
  badges: DriverBadge[];
  /** Approximate one-time download size, shown in the UI. */
  downloadSizeMB?: number;
  params: ParamSpec[];
  /** True when the driver returns `kind: 'depth'`, so the shared MeshOptions apply. */
  producesDepth: boolean;
  /** Optional capability check (e.g. server has an API key configured). */
  isAvailable?: () => Promise<Availability>;
  run: (input: DriverInput) => Promise<DriverResult>;
}

/** Thrown by drivers when `signal` is aborted. */
export class AbortError extends Error {
  constructor() {
    super('Aborted');
    this.name = 'AbortError';
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AbortError();
}

/** Default values for a list of params. */
export function defaultParams(specs: ParamSpec[]): ParamValues {
  const out: ParamValues = {};
  for (const s of specs) out[s.key] = s.default;
  return out;
}
