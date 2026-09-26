/**
 * Test helpers: exact orthographic renders of analytic solids (unions of
 * boxes, spheres and Y-cylinders) from the six views, with silhouette, colour
 * and normalised depth (1 = nearest). The view conventions are written out
 * here directly from the ViewId docs in src/core/types.ts, independently of
 * VIEW_FRAMES, so tests catch a wrong table.
 */
import type { DepthMap, Mask, RGBAImage, ViewId } from '../types';
import type { DepthEstimator, FusionViewInput } from './types';

type Vec3 = [number, number, number];

export interface Primitive {
  /** Interval of the solid along world `axis` at the other two coordinates of `p`, or null. */
  span(axis: 0 | 1 | 2, p: Vec3): [number, number] | null;
}

export const box = (min: Vec3, max: Vec3): Primitive => ({
  span(axis, p) {
    for (let a = 0; a < 3; a++) if (a !== axis && (p[a] < min[a] || p[a] > max[a])) return null;
    return [min[axis], max[axis]];
  },
});

export const sphere = (c: Vec3, r: number): Primitive => ({
  span(axis, p) {
    let d2 = 0;
    for (let a = 0; a < 3; a++) if (a !== axis) d2 += (p[a] - c[a]) ** 2;
    if (d2 > r * r) return null;
    const h = Math.sqrt(r * r - d2);
    return [c[axis] - h, c[axis] + h];
  },
});

/** Cylinder along Y: centre (cx, cz), radius r, from y0 to y1. */
export const cylinderY = (cx: number, cz: number, r: number, y0: number, y1: number): Primitive => ({
  span(axis, p) {
    if (axis === 1) return (p[0] - cx) ** 2 + (p[2] - cz) ** 2 <= r * r ? [y0, y1] : null;
    if (p[1] < y0 || p[1] > y1) return null;
    const off = axis === 0 ? p[2] - cz : p[0] - cx;
    if (off * off > r * r) return null;
    const h = Math.sqrt(r * r - off * off);
    const c = axis === 0 ? cx : cz;
    return [c - h, c + h];
  },
});

export type Solid = Primitive[];

/**
 * Camera of each view, from the ViewId docs: image (s, t) (s right, t down,
 * world units from the image centre) → world point with the ray coordinate
 * left free, the ray axis and the camera side (+1 = camera on the + side).
 */
const CAMERAS: Record<ViewId, { ray: 0 | 1 | 2; side: 1 | -1; at: (s: number, t: number) => Vec3 }> = {
  // Facing the subject: its left (+X) on the image right.
  front: { ray: 2, side: 1, at: (s, t) => [s, -t, 0] },
  // Seen from behind: the subject's left on the image left.
  back: { ray: 2, side: -1, at: (s, t) => [-s, -t, 0] },
  // Camera at the subject's left (+X): the subject's front (+Z) on the image left.
  left: { ray: 0, side: 1, at: (s, t) => [0, -t, -s] },
  // Camera at the subject's right (−X): the front on the image right.
  right: { ray: 0, side: -1, at: (s, t) => [0, -t, s] },
  // From above: the front at the image bottom, the subject's left on the right.
  top: { ray: 1, side: 1, at: (s, t) => [s, 0, t] },
  // From below: the front at the image top.
  bottom: { ray: 1, side: -1, at: (s, t) => [s, 0, -t] },
};

export interface RenderOptions {
  width?: number;
  height?: number;
  /** Pixels per world unit. */
  scale?: number;
  /** Shift of the object centre from the image centre, in pixels. */
  offset?: [number, number];
  /** Colour of a surface point (default: per-view colour from VIEW_COLORS). */
  color?: (p: Vec3, view: ViewId) => [number, number, number];
  /** Opaque background colour instead of transparency (the mask is then only returned separately). */
  background?: [number, number, number];
}

export const VIEW_COLORS: Record<ViewId, [number, number, number]> = {
  front: [255, 0, 0],
  back: [0, 0, 255],
  left: [0, 255, 0],
  right: [255, 255, 0],
  top: [255, 0, 255],
  bottom: [0, 255, 255],
};

export interface Rendered {
  image: RGBAImage;
  mask: Mask;
  depth: DepthMap;
}

export function renderView(solid: Solid, view: ViewId, o: RenderOptions = {}): Rendered {
  const w = o.width ?? 96, h = o.height ?? 96, scale = o.scale ?? 40;
  const [dx, dy] = o.offset ?? [0, 0];
  const cam = CAMERAS[view];
  const n = w * h;
  const data = new Uint8ClampedArray(n * 4);
  const mask = new Uint8Array(n);
  const hit = new Float32Array(n);
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (x + 0.5 - (w / 2 + dx)) / scale, t = (y + 0.5 - (h / 2 + dy)) / scale;
      const p = cam.at(s, t);
      let best = -Infinity;
      for (const prim of solid) {
        const iv = prim.span(cam.ray, p);
        if (!iv) continue;
        // Toward-camera coordinate of the entry point.
        const c = cam.side > 0 ? iv[1] : -iv[0];
        if (c > best) best = c;
      }
      const i = y * w + x;
      if (best === -Infinity) {
        if (o.background) data.set([...o.background, 255], i * 4);
        continue;
      }
      mask[i] = 1;
      hit[i] = best;
      if (best < lo) lo = best;
      if (best > hi) hi = best;
      p[cam.ray] = cam.side * best;
      const col = o.color ? o.color(p, view) : VIEW_COLORS[view];
      data.set([...col, 255], i * 4);
    }
  const depth = new Float32Array(n);
  const span = hi - lo > 1e-9 ? hi - lo : 1;
  for (let i = 0; i < n; i++) if (mask[i]) depth[i] = hi - lo > 1e-9 ? (hit[i] - lo) / span : 1;
  return { image: { width: w, height: h, data }, mask: { width: w, height: h, data: mask }, depth: { width: w, height: h, data: depth } };
}

/** Renders of several views, as fusion inputs (mask left to the alpha channel unless `withMask`). */
export function renderViews(
  solid: Solid,
  views: ViewId[],
  o: RenderOptions | ((v: ViewId) => RenderOptions) = {},
  withMask = false,
): { inputs: FusionViewInput[]; renders: Partial<Record<ViewId, Rendered>> } {
  const renders: Partial<Record<ViewId, Rendered>> = {};
  const inputs = views.map((id) => {
    const r = renderView(solid, id, typeof o === 'function' ? o(id) : o);
    renders[id] = r;
    return { id, image: r.image, mask: withMask ? r.mask : null };
  });
  return { inputs, renders };
}

/** Fake depth model: crops the exact rendered depth and re-normalises it over the crop mask. */
export function fakeDepthEstimator(renders: Partial<Record<ViewId, Rendered>>): DepthEstimator {
  return async ({ view, image, mask, rect }) => {
    const r = renders[view];
    if (!r) throw new Error(`no render for ${view}`);
    const { width: w, height: h } = image;
    const data = new Float32Array(w * h);
    let lo = Infinity, hi = -Infinity;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = r.depth.data[(y + rect.y0) * r.depth.width + x + rect.x0];
        data[y * w + x] = v;
        if (mask.data[y * w + x]) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    const span = hi - lo > 1e-9 ? hi - lo : 1;
    for (let i = 0; i < data.length; i++) data[i] = mask.data[i] ? Math.min(1, Math.max(0, (data[i] - lo) / span)) : 0;
    return { width: w, height: h, data };
  };
}
