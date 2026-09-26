/**
 * Human analysis + face / hand depth detail. Browser-only parts (MediaPipe)
 * load lazily on the first analyzeHuman() call.
 */
export { analyzeHuman, clearHumanCache, setDetectorBackend } from './analyze';
export { enhanceHumanDepth, REFERENCE_DEPTH_SCALE } from './enhance';
export { drawLandmarks, OVERLAY_COLORS } from './overlay';
export { bodyRelief, earReliefs, faceRelief, faceReliefs, handRelief, unitRelief, type ReliefField } from './prior';
export { DEFAULT_HUMAN_CONFIG, downloadSizeMB, humanConfigFrom, type HumanConfig } from './config';
export { FACE, FINGERS, HAND, HAND_EDGES, POSE_EDGES } from './topology';
export type { Detector, DetectorBackend, RawDetections, RawLandmark } from './backend';
export * from './types';
