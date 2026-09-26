/** Multi-view fusion (front + back / sides / top / bottom → closed, vertex-coloured mesh). */
export * from './types';
export { VIEW_FRAMES, estimateObjectBox, prepareView, resolveViewMask, viewProjection, projectPoint } from './frame';
export type { ObjectBox, PixelBox, PreparedView, ViewProjection } from './frame';
export { FUSION_TEXT, FUSION_VIEW_NAMES, reconstructFromViews, sanitizeFusionOptions } from './reconstruct';
export { marchingCubes } from './marchingCubes';
