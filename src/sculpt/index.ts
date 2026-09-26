/** Public API of the sculpt / depth editing module (UI lives in src/ui/sculpt). */
export * from './types';
export { FALLOFFS, falloffWeight, isFalloff } from './falloff';
export { RADIUS_MAX, RADIUS_MIN, isBrushId, sanitizeBrushSettings, stepRadius, stepStrength } from './settings';
export { SculptSession, isEditableTarget, pressureOf } from './session';
export type { SculptEvent, SculptHit, SculptHost, SculptSessionOptions, StrokeModifiers } from './session';
export { SculptMesh, isSculptable } from './sculptMesh';
export { BRUSH_TUNING, applyDab, applyGrab, captureGrab } from './brushes';
export type { Dab, GrabCapture } from './brushes';
export { buildTopology } from './topology';
export type { SculptTopology } from './topology';
export { DEPTH_BRUSH_IDS, DepthEditState, isDepthBrushId, maskForSize, spacedPoints } from './depthBrush';
export type { DepthBrushId, DepthDab, Rect } from './depthBrush';
export { imageForSize, renderDepthRegion, turbo } from './depthRender';
export type { DepthColormap, DepthViewOptions } from './depthRender';
