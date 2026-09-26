/**
 * Multi-view fusion contracts: the options, depth hook and result of
 * `reconstructFromViews` (./reconstruct.ts), which turns the front view plus
 * any of back / left / right / top / bottom into a closed, vertex-coloured
 * mesh in the shared frame (+Y up, +Z = front, longest side 2, centred).
 */
import type { BufferGeometry } from 'three';
import type { DepthMap, I18nText, Mask, Progress, RGBAImage, ViewId } from '../types';

/** World axis: 0 = X, 1 = Y, 2 = Z. */
export type Axis = 0 | 1 | 2;
export type Sign = 1 | -1;

export interface AxisDir {
  axis: Axis;
  sign: Sign;
}

/**
 * How an orthographic view sits in the world: which signed world axis image
 * x (rightwards) and image y (downwards) run along, and which one points from
 * the subject towards the camera. See VIEW_FRAMES (./frame.ts).
 */
export interface ViewFrame {
  u: AxisDir;
  v: AxisDir;
  w: AxisDir;
}

export interface FusionViewInput {
  id: ViewId;
  image: RGBAImage;
  /** Foreground mask; null = alpha channel, else border flood fill, else the whole image. */
  mask: Mask | null;
}

/** 'strict': every view carves exactly. 'tolerant': non-front views are dilated first (misaligned AI views). */
export type HullMode = 'strict' | 'tolerant';

/**
 * What a normalised depth map is fitted to along the view axis:
 *  - 'object': the object box (d = 1 at the box face, d = 0 at k·box depth), never past the middle of
 *              the ray's hull interval; consistent across rays.
 *  - 'ray':    each ray's own hull interval [t0, t1] (surface t = t0 + (1 − d)·k·(t1 − t0)).
 */
export type DepthFit = 'object' | 'ray';

export interface FusionOptions {
  /** Voxels along the object's longest side (64..256). */
  resolution: number;
  hull: HullMode;
  /** Dilation of non-front silhouettes in 'tolerant' mode, as a fraction of the view's longest bbox side (0..0.1). */
  tolerance: number;
  /** Object depth as a fraction of its width when no side / top / bottom view constrains it. */
  defaultDepth: number;
  /** 0..1: how far depth maps may carve (k = 0.5 · strength of the fitted extent; a view only sees its near half). */
  depthStrength: number;
  depthFit: DepthFit;
  /** Gaussian sigma (voxels) applied to the occupancy before surface extraction (0..3). */
  smoothness: number;
  /** Taubin λ/μ smoothing iterations on the extracted mesh (0..50). */
  smoothIterations: number;
  /** Exponent p of the view weight max(0, n·viewDir)^p (1..16): higher = sharper seams, less blur. */
  colorSharpness: number;
  /** Triangle cap; above it the voxel step grows (coarser surface). */
  maxTriangles: number;
}

export const DEFAULT_FUSION_OPTIONS: FusionOptions = {
  resolution: 144,
  hull: 'tolerant',
  tolerance: 0.02,
  defaultDepth: 0.5,
  depthStrength: 0.7,
  depthFit: 'object',
  smoothness: 1,
  smoothIterations: 8,
  colorSharpness: 4,
  maxTriangles: 300_000,
};

export interface DepthEstimateRequest {
  view: ViewId;
  /** The view cropped to its silhouette (plus a margin); pixels outside the mask are transparent. */
  image: RGBAImage;
  mask: Mask;
  /** Where the crop sits in the view image (pixel edges, x1 / y1 exclusive). */
  rect: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Monocular depth for one (cropped) view: a DepthMap of the request image's
 * size, [0, 1], 1 = nearest, normalised over the mask. Throwing a non-abort
 * error makes the fusion continue without model depth (with a warning).
 */
export type DepthEstimator = (
  req: DepthEstimateRequest,
  ctx: { signal: AbortSignal; onProgress: (p: Progress) => void },
) => Promise<DepthMap>;

export interface FusionContext {
  signal: AbortSignal;
  onProgress: (p: Progress) => void;
  /** Depth refinement hook; null / omitted = silhouettes only. */
  estimateDepth?: DepthEstimator | null;
  /** Called between stages (default: yieldToPaint). */
  yieldControl?: () => Promise<void>;
}

/** Where each view's depth came from: the model, the silhouette ("balloon" fallback) or nowhere. */
export type DepthSource = 'model' | 'silhouette' | 'none';

export interface FusionInfo {
  /** Views that contributed (empty silhouettes are skipped). */
  views: ViewId[];
  /** Object box in front-view pixels (width, height, depth) and where the depth came from. */
  box: { width: number; height: number; depth: number; depthFrom: 'side' | 'top-bottom' | 'default' };
  /** Voxel grid dims (including padding) and the extraction step (1 = full resolution). */
  grid: [number, number, number];
  step: number;
  depth: Partial<Record<ViewId, DepthSource>>;
  warnings: I18nText[];
  triangles: number;
}

export interface FusionResult {
  /** Indexed geometry with 'position', 'normal' and 'color' (linear RGB) in the shared frame. */
  geometry: BufferGeometry;
  info: FusionInfo;
}
