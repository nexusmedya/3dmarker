/**
 * Human analysis configuration: MediaPipe Tasks Vision model locations and
 * detector options, from Vite env vars. Pure (Node-testable); the browser
 * loader is mediapipe.ts.
 *
 * Env vars (build time):
 *  - VITE_MEDIAPIPE_MODEL_BASE  where the .task models live (default Google's
 *    public bucket). A relative value (e.g. 'mediapipe/') resolves against the
 *    page, so self-hosted copies work under a GitHub Pages sub-path.
 *  - VITE_MEDIAPIPE_WASM_BASE   serve the wasm runtime from this directory
 *    (FilesetResolver file names) instead of the copy bundled by Vite.
 *  - VITE_MEDIAPIPE_POSE_MODEL  'lite' | 'full' (default) | 'heavy'.
 *  - VITE_MEDIAPIPE_DELEGATE    'auto' (GPU, CPU fallback; default) | 'GPU' | 'CPU'.
 */
import type { HumanDetector } from './types';

export type PoseModelVariant = 'lite' | 'full' | 'heavy';
export type DelegatePreference = 'auto' | 'GPU' | 'CPU';

export const DEFAULT_MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models/';

/**
 * Model paths relative to the model base. face_landmarker, hand_landmarker
 * and pose_landmarker_lite are verified against
 * node_modules/@mediapipe/tasks-vision/README.md.
 * ASSUMPTION: full / heavy follow the same bucket layout (as documented on
 * ai.google.dev; not reachable from the build sandbox). A missing model falls
 * back to the next candidate (see modelUrls), ending with lite.
 */
export const MODEL_PATHS = {
  faces: 'face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  hands: 'hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  pose: {
    lite: 'pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    full: 'pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
    heavy: 'pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task',
  },
} as const;

/** Approximate download sizes in MB (face ≈ 3.6, hand ≈ 7.5, pose lite / full / heavy ≈ 5.5 / 9 / 29). */
export const MODEL_SIZES_MB = { faces: 3.6, hands: 7.5, pose: { lite: 5.5, full: 9, heavy: 29 } } as const;

export interface HumanConfig {
  modelBase: string;
  /** Directory with FilesetResolver-named wasm files; null = the copy bundled by Vite. */
  wasmBase: string | null;
  pose: PoseModelVariant;
  delegate: DelegatePreference;
  /** A model download with no response / no new bytes for this long is aborted. */
  stallTimeoutMs: number;
  /** Upper bound for the wasm runtime + graph initialisation of one detector. */
  initTimeoutMs: number;
  numFaces: number;
  numHands: number;
  numPoses: number;
  /** Detection / presence confidence thresholds (MediaPipe default 0.5). */
  minConfidence: number;
  /**
   * ASSUMPTION: like the legacy MediaPipe Hands solution, HandLandmarker
   * labels handedness as if the image were a mirrored selfie, so labels are
   * swapped for ordinary photos. When a pose is found, the nearest pose wrist
   * decides instead.
   */
  handednessMirrored: boolean;
}

export const DEFAULT_HUMAN_CONFIG: HumanConfig = {
  modelBase: DEFAULT_MODEL_BASE,
  wasmBase: null,
  pose: 'full',
  delegate: 'auto',
  stallTimeoutMs: 30_000,
  initTimeoutMs: 60_000,
  numFaces: 4,
  numHands: 4,
  numPoses: 2,
  minConfidence: 0.4,
  handednessMirrored: true,
};

/** Config from Vite env vars (unknown / empty values keep the defaults). */
export function humanConfigFrom(vars: Record<string, unknown>): HumanConfig {
  const str = (k: string) => (typeof vars[k] === 'string' && (vars[k] as string).trim() ? (vars[k] as string).trim() : undefined);
  const cfg: HumanConfig = { ...DEFAULT_HUMAN_CONFIG };
  const base = str('VITE_MEDIAPIPE_MODEL_BASE');
  const wasm = str('VITE_MEDIAPIPE_WASM_BASE');
  const pose = str('VITE_MEDIAPIPE_POSE_MODEL');
  const delegate = str('VITE_MEDIAPIPE_DELEGATE')?.toUpperCase();
  if (base) cfg.modelBase = base;
  if (wasm) cfg.wasmBase = wasm.replace(/\/+$/, '');
  if (pose === 'lite' || pose === 'full' || pose === 'heavy') cfg.pose = pose;
  if (delegate === 'GPU' || delegate === 'CPU') cfg.delegate = delegate;
  else if (delegate === 'AUTO') cfg.delegate = 'auto';
  return cfg;
}

/** `base` + `path` with exactly one slash between them. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Candidate model URLs for a detector, most preferred first (pose falls back towards lite). */
export function modelUrls(cfg: HumanConfig, detector: HumanDetector): string[] {
  if (detector !== 'pose') return [joinUrl(cfg.modelBase, MODEL_PATHS[detector])];
  const order: PoseModelVariant[] = cfg.pose === 'heavy' ? ['heavy', 'full', 'lite'] : cfg.pose === 'full' ? ['full', 'lite'] : ['lite'];
  return order.map((v) => joinUrl(cfg.modelBase, MODEL_PATHS.pose[v]));
}

/** Approximate total download for the given detectors (MB). */
export function downloadSizeMB(cfg: HumanConfig, detectors: HumanDetector[] = ['faces', 'hands', 'pose']): number {
  let mb = 0;
  for (const d of detectors) mb += d === 'pose' ? MODEL_SIZES_MB.pose[cfg.pose] : MODEL_SIZES_MB[d];
  return Math.round(mb);
}
