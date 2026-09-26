/**
 * Multi-view fusion contracts: the options, depth hook and result of
 * `reconstructFromViews` (./reconstruct.ts), which turns the front view plus
 * any of back / left / right / top / bottom into a closed, vertex-coloured
 * mesh in the shared frame (+Y up, +Z = front, longest side 2, centred).
 */
import type { BufferGeometry } from 'three';
import type { DepthMap, I18nText, Mask, Progress, RGBAImage, ViewAlign, ViewId, ViewTrust } from '../types';
import type { Grid } from './volume';

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
  /** See ViewAlign (src/core/types.ts). Absent = DEFAULT_VIEW_ALIGN. */
  align?: ViewAlign;
}

/** 'strict': every view carves exactly. 'tolerant': non-front views are dilated first (misaligned AI views). */
export type HullMode = 'strict' | 'tolerant';

/**
 * What a normalised depth map is fitted to along the view axis:
 *  - 'object': one affine map along the view axis for the whole view, its scale calibrated against the
 *              hull (at most k·box depth), never past the middle of the ray's hull interval; consistent
 *              across rays.
 *  - 'ray':    each ray's own hull interval [t0, t1] (surface t = t0 + (1 − d)·k·(t1 − t0)).
 */
export type DepthFit = 'object' | 'ray';

/** How the back silhouette enters the XY hull plane: never (it mirrors the front) or intersected (legacy). */
export type HullBack = 'exclude' | 'intersect';
/** Depth-scale calibration: anchored robust median (a = 0) or the legacy envelope LP. */
export type Calibration = 'anchored' | 'envelope';
/** How extra views are placed on the object box: registered to the front by their silhouette profiles, or by the bbox alone. */
export type AlignMode = 'auto' | 'bbox';

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
  hullBack: HullBack;
  calibration: Calibration;
  /** Thin-part guard δ: parts thinner than δ·(front longest side) are protected from other views (0 = off, ≤ 0.15). */
  guard: number;
  align: AlignMode;
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
  hullBack: 'exclude',
  calibration: 'anchored',
  guard: 0.06,
  align: 'auto',
};

/** The options that reproduce the fusion before registration, back exclusion, the guard and anchored calibration. */
export const LEGACY_FUSION_OPTIONS: Pick<FusionOptions, 'hullBack' | 'calibration' | 'guard' | 'align'> = {
  hullBack: 'intersect',
  calibration: 'envelope',
  guard: 0,
  align: 'bbox',
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
  /** Called between stages, and inside long stages every `sliceMs` (default: yieldToPaint between stages, a macrotask inside). */
  yieldControl?: () => Promise<void>;
  /** Longest synchronous run inside a stage before yielding (and checking the abort signal), ms. Default 30. */
  sliceMs?: number;
  /** Diagnostics / tests: the occupancy field after a volume stage (the live buffer, not a copy). */
  inspect?: (stage: 'hull' | 'guard' | 'carve' | 'smooth', field: Float32Array, grid: Grid) => void;
}

/** Where each view's depth came from: the model, the silhouette ("balloon" fallback) or nowhere. */
export type DepthSource = 'model' | 'silhouette' | 'none';

/**
 * How a view was placed on the object box: 'bbox' (the front, or align: 'bbox'), 'aligned' (registered
 * to the front), 'plain' (nothing to register: a plain silhouette), 'weak' (no match: bbox kept),
 * 'stretched' (cut at an edge, scale not found: bbox kept), 'manual' (the request's dx / dy / scale).
 */
export type AlignStatus = 'bbox' | 'aligned' | 'plain' | 'weak' | 'stretched' | 'manual';
export type AlignLevel = 'good' | 'fair' | 'poor';
export type AlignNoteCode =
  | 'aligned' | 'autoAligned' | 'cropped' | 'stretched' | 'weak' | 'plain' | 'aspect'
  | 'sideBlind' | 'noMask' | 'mirrored' | 'colorOnly' | 'off' | 'inconsistent';
export interface AlignNote { code: AlignNoteCode; text: I18nText; }
export interface CutFlags { top: boolean; bottom: boolean; left: boolean; right: boolean; }
/** Correction of the bbox fit (units as ViewAlign). */
export interface AlignCorrection { dx: number; dy: number; scale: number; flipX: boolean; }

export interface ViewAlignment {
  id: ViewId;
  status: AlignStatus;
  level: AlignLevel;
  /** 0..100 integer (alignScore). */
  score: number;
  /** 0..1: profile agreement with the front at the applied fit (1 = identical). */
  confidence: number;
  /**
   * What the fusion uses: alignedBox(bbox, applied, SHARED_AXES[id]) === fitBox, except for a back cut
   * on one axis only, whose uncut axis keeps its bbox extent (see align.ts, "isotropy").
   */
  applied: AlignCorrection;
  /** What automatic registration found (identity when 'plain' / 'weak' / 'bbox'). */
  suggested: AlignCorrection;
  /** suggested ∘ applied⁻¹: dx / dy = suggested − applied, scale = suggested.scale / applied.scale. */
  residual: { dx: number; dy: number; scale: number };
  cut: CutFlags;
  fitBox: { x0: number; y0: number; x1: number; y1: number };
  /** Effective trust (the request, demoted to 'color' when the view is cut on both ends of its shared axis). */
  trust: ViewTrust;
  notes: AlignNote[];
  /** Landmark rows / columns of the FRONT (front pixel coords) for overlay guides: support ends + ≤ 6 strongest edges. */
  guides: { rows: number[]; cols: number[] };
}

export interface ViewReport {
  id: ViewId;
  trust: ViewTrust;
  depth: DepthSource;
  status: AlignStatus;
  level: AlignLevel;
  score: number;
  applied: AlignCorrection;
  suggested: AlignCorrection;
  cut: CutFlags;
  /** Share of this view's carve that the thin-part guard blocked (0..1); null when it did not carve. */
  consistency: number | null;
  notes: AlignNote[];
}
export interface FusionReport { views: ViewReport[]; warnings: I18nText[]; }

export interface FusionInfo {
  /** Views that contributed (empty silhouettes and trust 'off' are skipped). */
  views: ViewId[];
  /** Object box in front-view pixels (width, height, depth) and where the depth came from. */
  box: { width: number; height: number; depth: number; depthFrom: 'side' | 'top-bottom' | 'default' };
  /** Voxel grid dims (including padding) and the extraction step (1 = full resolution). */
  grid: [number, number, number];
  step: number;
  depth: Partial<Record<ViewId, DepthSource>>;
  warnings: I18nText[];
  triangles: number;
  /** Same order as `views` (front first, status 'bbox'). */
  alignment: ViewAlignment[];
  /** Effective trust per view. */
  trust: Partial<Record<ViewId, ViewTrust>>;
  /** Per carving view: share of its carve the thin-part guard blocked. */
  consistency: Partial<Record<ViewId, number>>;
  /** Front columns the thin-part guard protects. */
  guardColumns: number;
  report: FusionReport;
}

export interface FusionResult {
  /** Indexed geometry with 'position', 'normal' and 'color' (linear RGB) in the shared frame. */
  geometry: BufferGeometry;
  info: FusionInfo;
}
