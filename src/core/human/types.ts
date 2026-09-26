/**
 * Contracts for human analysis (face / hand / body landmarks, MediaPipe
 * Tasks Vision in the browser) and the landmark-guided depth refinement that
 * gives faces and hands their relief (nose, lips, eye sockets, ears, fingers).
 *
 * Landmark coordinates are in PIXELS of the analysed image (x right, y down,
 * top-left origin). `z` uses the same pixel scale as x and follows
 * MediaPipe's convention: smaller (more negative) z = closer to the camera.
 */
import type { DepthMap, Mask, Progress, RGBAImage } from '../types';

export interface Landmark {
  x: number;
  y: number;
  z: number;
  /** 0..1 when the model reports it (pose landmarks). */
  visibility?: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FaceResult {
  /** 478 FaceLandmarker points (468 mesh + 10 iris). */
  landmarks: Landmark[];
  box: Box;
}

export interface HandResult {
  /** 21 HandLandmarker points (wrist, then 4 per finger: thumb, index, middle, ring, pinky). */
  landmarks: Landmark[];
  handedness: 'Left' | 'Right';
  box: Box;
}

export interface PoseResult {
  /** 33 PoseLandmarker points (BlazePose topology). */
  landmarks: Landmark[];
  box: Box;
}

export interface HumanAnalysis {
  width: number;
  height: number;
  faces: FaceResult[];
  hands: HandResult[];
  poses: PoseResult[];
  /** At least one face or body was found. */
  isHuman: boolean;
  /** Set when detection could not run (models unreachable, no WebGL…); the lists are then empty. */
  unavailableReason?: string;
}

export interface AnalyzeOptions {
  signal: AbortSignal;
  onProgress?: (p: Progress) => void;
  /** Which detectors to run (default: all). */
  detect?: { faces?: boolean; hands?: boolean; pose?: boolean };
}

export interface HumanDetailOptions {
  /** 0..1.5 — how much face relief (landmark prior + high-res crop detail) to add. */
  faceStrength: number;
  /** 0..1.5 — finger / hand relief. */
  handStrength: number;
  /**
   * Re-run the depth model on up-scaled crops around each face / hand and
   * blend the result in (much finer detail; one extra inference per crop).
   * Provided by the caller because it depends on the depth model in use.
   */
  refineCrop?: (crop: RGBAImage, signal: AbortSignal) => Promise<DepthMap>;
  signal: AbortSignal;
  onProgress?: (p: Progress) => void;
}

/** BlazePose landmark indices used by rigging and body completion. */
export const POSE = {
  nose: 0,
  leftEye: 2,
  rightEye: 5,
  leftEar: 7,
  rightEar: 8,
  mouthLeft: 9,
  mouthRight: 10,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftPinky: 17,
  rightPinky: 18,
  leftIndex: 19,
  rightIndex: 20,
  leftThumb: 21,
  rightThumb: 22,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFootIndex: 31,
  rightFootIndex: 32,
} as const;

export type { DepthMap, Mask };
