/** Multi-view fusion (front + back / sides / top / bottom → closed, vertex-coloured mesh). */
export * from './types';
export { VIEW_FRAMES, NO_CUT, CUT_MIN_FRACTION, cutFlags, estimateObjectBox, maskBBox, prepareView, resolveViewMask, viewProjection, projectPoint, constrainsDepth } from './frame';
export type { MaskSource, ObjectBox, PixelBox, PreparedView, ViewProjection } from './frame';
export {
  ALIGN,
  ALIGN_TEXT,
  SHARED_AXES,
  alignLevel,
  alignNoteText,
  alignResidual,
  alignScore,
  alignView,
  alignedBox,
  correctionOf,
  formatPercent,
  registerViews,
} from './align';
export type { AlignOptions } from './align';
export { FUSION_TEXT, FUSION_VIEW_NAMES, prepareFusionViews, reconstructFromViews, sanitizeFusionOptions, viewWarning } from './reconstruct';
export { GUARD_FILL, GuardField, buildGuard, buildGuardSteps, localThickness } from './guard';
export type { GuardOptions } from './guard';
export { calibrateDepth, calibrateDepthAnchored } from './depthCarve';
export type { CarveStats } from './depthCarve';
export { buildHull, buildHullPlanesSteps, buildHullSteps, createGrid } from './volume';
export type { Grid, HullOptions, HullPlanes } from './volume';
export { marchingCubes } from './marchingCubes';
