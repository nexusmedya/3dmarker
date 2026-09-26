/**
 * The seam between analyze.ts (pure orchestration: coordinates, caching,
 * crops) and the browser-only MediaPipe loader (mediapipe.ts). Tests plug in
 * fakes through this interface.
 */
import type { I18nText, RGBAImage } from '../types';
import type { HumanDetector } from './types';

/** MediaPipe NormalizedLandmark: x, y in [0, 1] of the input image, z in units of its width (smaller = closer). */
export interface RawLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export interface RawDetections {
  /** Landmarks per detected instance. */
  landmarks: RawLandmark[][];
  /** Hands only: MediaPipe's handedness label ('Left' | 'Right') per instance. */
  handedness?: string[];
}

export interface Detector {
  readonly kind: HumanDetector;
  /** Runs the model on an opaque RGBA image (IMAGE mode). */
  detect(image: RGBAImage): Promise<RawDetections>;
}

export interface LoadContext {
  signal: AbortSignal;
  /** Model download progress in bytes (total 0 = unknown). */
  onBytes?: (loaded: number, total: number) => void;
}

export interface DetectorBackend {
  /** Why detection cannot run in this environment (null = supported). */
  unsupportedReason(): I18nText | null;
  /** Load (once, then cached) one detector. Rejects with a LocalizedError when it cannot. */
  load(kind: HumanDetector, ctx: LoadContext): Promise<Detector>;
}
