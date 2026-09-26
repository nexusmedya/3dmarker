/**
 * View conventions and normalisation for multi-view fusion.
 *
 * World frame (object units = front-view pixels until the final rescale):
 * +X = image right of the front view (the subject's left), +Y up, +Z towards
 * the front camera. The object occupies the box [−W/2, W/2] × [−H/2, H/2] ×
 * [−D/2, D/2].
 *
 * Each orthographic view (src/core/types.ts ViewId docs) is a right-handed
 * camera frame: image right × image up = towards the camera.
 *
 *   view    image x →   image y ↓   camera at   (image up)
 *   front   +X          −Y          +Z          +Y
 *   back    −X          −Y          −Z          +Y   (mirrored X: the subject's left on the image left)
 *   left    −Z          −Y          +X          +Y   (the subject's front on the image left)
 *   right   +Z          −Y          −X          +Y
 *   top     +X          +Z          +Y          −Z   (the subject's front at the image bottom)
 *   bottom  +X          −Z          −Y          +Z   (the subject's front at the image top)
 *
 * Normalisation: a view's silhouette bbox [x0, x1] × [y0, y1] (pixel edges)
 * is mapped onto the matching face of the object box, so views of any scale
 * or offset line up (AI views rarely share the front's framing):
 *
 *   u = cx + su · p[ua] · (x1 − x0) / size[ua]      cx = (x0 + x1) / 2
 *   v = cy + sv · p[va] · (y1 − y0) / size[va]      cy = (y0 + y1) / 2
 *
 * Registration: `fitBox` replaces the bbox in that mapping. It starts as the
 * bbox; registerViews (./align.ts) refits it to the front by the silhouette
 * profiles along the axes a view shares with the front (isotropic scale on
 * those axes, offsets), so a view drawn at another scale, shifted, or cut at
 * an image edge (feet / hair outside the frame) still lands where the front
 * says the subject is. The axis a view does not share (its depth) keeps the
 * bbox extent. Rows / columns past a cut edge are unknown to the hull.
 *
 * Box size: W, H = the front bbox. D (in the same units) = the side views'
 * fitBox aspect times H (heights matched to the front), else the top / bottom
 * views' aspect times W, else defaultDepth · W. The orthographic silhouette of
 * a rigid object spans its full extent along both image axes, so the mapping
 * is exact for consistent views.
 */
import type { Mask, RGBAImage, ViewAlign, ViewId, ViewTrust } from '../types';
import { DEFAULT_VIEW_ALIGN, sanitizeViewAlign } from '../types';
import { hasMeaningfulAlpha, autoMaskFromBorder, removeSmallComponents } from '../image/autoMask';
import { maskArea, maskFromAlpha, mirrorMask, mirrorRGBA, resizeMask } from '../image/ops';
import type { AlignStatus, Axis, CutFlags, FusionViewInput, Sign, ViewFrame } from './types';

const X: Axis = 0, Y: Axis = 1, Z: Axis = 2;
const f = (axis: Axis, sign: Sign) => ({ axis, sign });

export const VIEW_FRAMES: Record<ViewId, ViewFrame> = {
  front: { u: f(X, 1), v: f(Y, -1), w: f(Z, 1) },
  back: { u: f(X, -1), v: f(Y, -1), w: f(Z, -1) },
  left: { u: f(Z, -1), v: f(Y, -1), w: f(X, 1) },
  right: { u: f(Z, 1), v: f(Y, -1), w: f(X, -1) },
  top: { u: f(X, 1), v: f(Z, 1), w: f(Y, 1) },
  bottom: { u: f(X, 1), v: f(Z, -1), w: f(Y, -1) },
};

/** Pixel-edge rectangle (x1 / y1 exclusive). */
export interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type MaskSource = 'given' | 'alpha' | 'border' | 'none';

export const NO_CUT: CutFlags = { top: false, bottom: false, left: false, right: false };

/** Border row / column foreground share of the bbox side that flags a cut edge. */
export const CUT_MIN_FRACTION = 0.02;

export interface PreparedView {
  id: ViewId;
  frame: ViewFrame;
  image: RGBAImage;
  /**
   * Cleaned silhouette, image-sized: the bbox, hull, carving and colour all
   * use it. Specks are removed (small components of a border flood-fill mask,
   * only pixel noise of a given / alpha mask).
   */
  mask: Mask;
  maskSource: MaskSource;
  bbox: PixelBox;
  /** Resolved request (DEFAULT_VIEW_ALIGN when absent); flipX is already applied to image and mask. */
  align: ViewAlign;
  /** The silhouette touches this image edge: ≥ max(2, 0.02·bbox side) foreground pixels on the border row / column. */
  cut: CutFlags;
  /** Pixel rectangle mapped onto the object-box face: = bbox until registerViews sets it. */
  fitBox: PixelBox;
  /** 'bbox' until registerViews. */
  registration: AlignStatus;
  /** Effective trust (the request; registerViews may demote to 'color'). */
  trust: ViewTrust;
}

/** Foreground mask of a view: given → alpha → border flood fill → whole image. */
export function resolveViewMask(image: RGBAImage, mask: Mask | null): { mask: Mask; source: MaskSource } {
  const { width: w, height: h } = image;
  if (mask) {
    const m = mask.width === w && mask.height === h ? mask : resizeMask(mask, w, h);
    if (maskArea(m) > 0) return { mask: m, source: 'given' };
  }
  if (hasMeaningfulAlpha(image)) {
    const m = maskFromAlpha(image);
    if (maskArea(m) > 0) return { mask: m, source: 'alpha' };
  }
  const border = autoMaskFromBorder(image);
  if (border) return { mask: border, source: 'border' };
  return { mask: { width: w, height: h, data: new Uint8Array(w * h).fill(1) }, source: 'none' };
}

/** Tight foreground bbox, or null for an empty mask. */
export function maskBBox(mask: Mask): PixelBox | null {
  const { width: w, height: h, data } = mask;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!data[row + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** Which image edges the silhouette is cut off at (enough foreground on the border row / column). */
export function cutFlags(mask: Mask, bbox: PixelBox): CutFlags {
  const { width: w, height: h, data } = mask;
  const count = (start: number, n: number, stride: number) => {
    let c = 0;
    for (let i = 0, p = start; i < n; i++, p += stride) c += data[p];
    return c;
  };
  const rowMin = Math.max(2, CUT_MIN_FRACTION * (bbox.x1 - bbox.x0));
  const colMin = Math.max(2, CUT_MIN_FRACTION * (bbox.y1 - bbox.y0));
  return {
    top: bbox.y0 === 0 && count(0, w, 1) >= rowMin,
    bottom: bbox.y1 === h && count((h - 1) * w, w, 1) >= rowMin,
    left: bbox.x0 === 0 && count(0, h, w) >= colMin,
    right: bbox.x1 === w && count(w - 1, h, w) >= colMin,
  };
}

/**
 * Resolve, clean (drop specks that would stretch the bbox) and measure a
 * view. Null when its silhouette is empty. A flipX request mirrors the image
 * and the resolved mask first.
 */
export function prepareView(input: FusionViewInput): PreparedView | null {
  const align = input.id === 'front' ? DEFAULT_VIEW_ALIGN : sanitizeViewAlign(input.align);
  const resolved = resolveViewMask(input.image, input.mask);
  const image = align.flipX ? mirrorRGBA(input.image) : input.image;
  const raw = align.flipX ? mirrorMask(resolved.mask) : resolved.mask;
  const source = resolved.source;
  const { width: w, height: h } = raw;
  const data = raw.data.slice();
  const area = maskArea(raw);
  if (area === 0) return null;
  // A border flood fill leaves background specks; a given or alpha mask is deliberate, and a small
  // detached part in it (a held ball, a hand clear of the body) is real: only drop pixel noise there.
  // Anything removed here is gone from the bbox and from the hull (an intersection) alike.
  const minArea = source === 'border' ? Math.max(4, Math.min(w * h * 0.002, area * 0.02)) : Math.max(4, w * h * 1e-5);
  removeSmallComponents(data, w, h, Math.ceil(minArea));
  let mask: Mask = { width: w, height: h, data };
  let bbox = maskBBox(mask);
  if (!bbox) {
    // Only specks (e.g. a dotted pattern): keep them all.
    mask = raw;
    bbox = maskBBox(raw);
  }
  if (!bbox) return null;
  return {
    id: input.id,
    frame: VIEW_FRAMES[input.id],
    image,
    mask,
    maskSource: source,
    bbox,
    align,
    cut: source === 'none' ? { ...NO_CUT } : cutFlags(mask, bbox),
    fitBox: { ...bbox },
    registration: 'bbox',
    trust: input.id === 'front' ? 'full' : align.trust,
  };
}

export interface ObjectBox {
  /** Extents along X, Y, Z in object units (front-view pixels). */
  size: [number, number, number];
  depthFrom: 'side' | 'top-bottom' | 'default';
}

const bw = (b: PixelBox) => b.x1 - b.x0;
const bh = (b: PixelBox) => b.y1 - b.y0;

/**
 * Object box from the views' silhouette extents (see the header). `views` must
 * include the front. D comes from the fitBox of trusted ('full'), registered
 * (not 'stretched') side / cap views with a real silhouette.
 */
export function estimateObjectBox(views: PreparedView[], defaultDepth: number): ObjectBox {
  const front = views.find((v) => v.id === 'front');
  if (!front) throw new Error('estimateObjectBox: the front view is required');
  const W = bw(front.bbox), H = bh(front.bbox);
  // Views without a real silhouette (whole image) say nothing about proportions; a view whose
  // cut edge could not be registered is stretched along the shared axis and overstates D by the cut
  // share — still far closer than the default, so it is used only when no registered view exists.
  const trusted = (ids: ViewId[]) => views.filter((v) => ids.includes(v.id) && v.maskSource !== 'none' && v.trust === 'full');
  const usable = (ids: ViewId[]) => {
    const all = trusted(ids);
    const registered = all.filter((v) => v.registration !== 'stretched');
    return registered.length ? registered : all;
  };
  const sides = usable(['left', 'right']);
  if (sides.length) {
    const D = sides.reduce((s, v) => s + (bw(v.fitBox) / bh(v.fitBox)) * H, 0) / sides.length;
    return { size: [W, H, D], depthFrom: 'side' };
  }
  const caps = usable(['top', 'bottom']);
  if (caps.length) {
    const D = caps.reduce((s, v) => s + (bh(v.fitBox) / bw(v.fitBox)) * W, 0) / caps.length;
    return { size: [W, H, D], depthFrom: 'top-bottom' };
  }
  return { size: [W, H, Math.max(1e-3, defaultDepth) * W], depthFrom: 'default' };
}

/** True when some trusted view constrains the object's Z extent (sides / top / bottom). */
export function constrainsDepth(views: PreparedView[]): boolean {
  return views.some((v) => v.id !== 'front' && v.id !== 'back' && v.trust === 'full');
}

/**
 * Linear world → image mapping of one view (continuous pixel-edge coords):
 * u = ou + su · p[ua], v = ov + sv · p[va]; the camera looks along −ws · e[wa].
 */
export interface ViewProjection {
  ua: Axis;
  va: Axis;
  wa: Axis;
  su: number;
  ou: number;
  sv: number;
  ov: number;
  /** +1 when the camera sits on the +wa side. */
  ws: Sign;
}

/** Projection built from the view's fitBox (= its bbox until registration). */
export function viewProjection(view: PreparedView, size: readonly [number, number, number]): ViewProjection {
  const { frame, fitBox } = view;
  return {
    ua: frame.u.axis,
    va: frame.v.axis,
    wa: frame.w.axis,
    su: (frame.u.sign * bw(fitBox)) / size[frame.u.axis],
    ou: (fitBox.x0 + fitBox.x1) / 2,
    sv: (frame.v.sign * bh(fitBox)) / size[frame.v.axis],
    ov: (fitBox.y0 + fitBox.y1) / 2,
    ws: frame.w.sign,
  };
}

/** Image position of a world point. */
export function projectPoint(p: ViewProjection, pt: ArrayLike<number>): [number, number] {
  return [p.ou + p.su * pt[p.ua], p.ov + p.sv * pt[p.va]];
}
