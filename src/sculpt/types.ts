/**
 * Contracts for the Blender-style sculpt / depth editor: brushes that push
 * the vertices of the model on screen, with symmetry and undo / redo.
 * Works on any mesh result (depth surfaces, extrusions, fused multi-view
 * meshes, GLB models): the session welds the geometry once, builds a BVH
 * (three-mesh-bvh) and edits positions in place.
 */

export type BrushId =
  /** Push the surface out along the brush normal (invert / Ctrl: carve in). */
  | 'draw'
  /** Like draw but fills cavities first (flattened plane + offset), Blender "Clay Strips"-like. */
  | 'clay'
  /** Laplacian smoothing (Shift toggles to smooth from any brush). */
  | 'smooth'
  /** Pull vertices to the average plane under the brush. */
  | 'flatten'
  /** Move vertices along their own normals (inflate / deflate). */
  | 'inflate'
  /** Pull vertices towards the brush centre (sharpen creases). */
  | 'pinch'
  /** Drag the vertices under the brush with the pointer (screen-space). */
  | 'grab'
  /** Draw a sharp crease (draw + pinch). */
  | 'crease';

export const BRUSH_IDS: BrushId[] = ['draw', 'clay', 'smooth', 'flatten', 'inflate', 'pinch', 'grab', 'crease'];

export type Falloff = 'smooth' | 'sphere' | 'linear' | 'sharp' | 'constant';

export interface BrushSettings {
  brush: BrushId;
  /** Radius as a fraction of the model's bounding-sphere radius (0.01..0.6). */
  radius: number;
  /** 0..1 */
  strength: number;
  falloff: Falloff;
  /** Invert the brush direction (carve instead of draw, deflate instead of inflate…). */
  invert: boolean;
  /** Mirror strokes across the model's X = 0 plane. */
  symmetryX: boolean;
  /** Keep the model's silhouette boundary vertices fixed (open surfaces). */
  lockBoundary: boolean;
}

export const DEFAULT_BRUSH: BrushSettings = {
  brush: 'draw',
  radius: 0.12,
  strength: 0.5,
  falloff: 'smooth',
  invert: false,
  symmetryX: false,
  lockBoundary: true,
};

export interface SculptState {
  active: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Number of strokes applied since the session started (0 = untouched). */
  strokes: number;
}
