/**
 * Test helpers: exact orthographic renders of analytic solids (unions of
 * boxes, spheres and Y-cylinders) from the six views, with silhouette, colour
 * and normalised depth (1 = nearest). The view conventions are written out
 * here directly from the ViewId docs in src/core/types.ts, independently of
 * VIEW_FRAMES, so tests catch a wrong table.
 */
import type { DepthMap, Mask, RGBAImage, ViewId } from '../types';
import { maskBBox, viewProjection, type ObjectBox, type PreparedView } from './frame';
import { prepareFusionViews, reconstructFromViews, sanitizeFusionOptions } from './reconstruct';
import type { DepthEstimator, FusionContext, FusionOptions, FusionResult, FusionViewInput } from './types';
import type { Grid } from './volume';

export type Vec3 = [number, number, number];

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

/** Cylinder along X: centre (cy, cz), radius r, from x0 to x1. */
export const cylinderX = (cy: number, cz: number, r: number, x0: number, x1: number): Primitive => ({
  span(axis, p) {
    if (axis === 0) return (p[1] - cy) ** 2 + (p[2] - cz) ** 2 <= r * r ? [x0, x1] : null;
    if (p[0] < x0 || p[0] > x1) return null;
    const off = axis === 1 ? p[2] - cz : p[1] - cy;
    if (off * off > r * r) return null;
    const h = Math.sqrt(r * r - off * off);
    const c = axis === 1 ? cy : cz;
    return [c - h, c + h];
  },
});

export const ellipsoid = (c: Vec3, r: Vec3): Primitive => ({
  span(axis, p) {
    let q = 0;
    for (let a = 0; a < 3; a++) if (a !== axis) q += ((p[a] - c[a]) / r[a]) ** 2;
    if (q > 1) return null;
    const h = r[axis] * Math.sqrt(1 - q);
    return [c[axis] - h, c[axis] + h];
  },
});

/**
 * Elliptic cylinder along Y from y0 to y1 with half-axes (rx, rz) scaled by a
 * factor running linearly from k0 (at y0) to k1 (at y1): a tapered limb or torso.
 */
export const taperY = (cx: number, cz: number, rx: number, rz: number, y0: number, y1: number, k0 = 1, k1 = 1): Primitive => ({
  span(axis, p) {
    if (axis === 1) {
      const q = Math.sqrt(((p[0] - cx) / rx) ** 2 + ((p[2] - cz) / rz) ** 2);
      if (k0 === k1) return q <= k0 ? [y0, y1] : null;
      // k(y) is linear, so k(y) ≥ q holds on one side of y*.
      const ys = y0 + ((q - k0) * (y1 - y0)) / (k1 - k0);
      const lo = k1 > k0 ? Math.max(y0, ys) : y0, hi = k1 > k0 ? y1 : Math.min(y1, ys);
      return lo <= hi ? [lo, hi] : null;
    }
    if (p[1] < y0 || p[1] > y1) return null;
    const k = k0 + ((k1 - k0) * (p[1] - y0)) / (y1 - y0);
    // The other cross-section coordinate bounds the chord along `axis`.
    const off = axis === 0 ? (p[2] - cz) / (k * rz) : (p[0] - cx) / (k * rx);
    const t = 1 - off * off;
    if (t < 0) return null;
    const h = k * (axis === 0 ? rx : rz) * Math.sqrt(t);
    const c = axis === 0 ? cx : cz;
    return [c - h, c + h];
  },
});

export type Solid = Primitive[];

/** True when `p` lies inside (or within `eps` of the surface of) the union `solid`. */
export function containsPoint(solid: Solid, p: Vec3, eps = 1e-9): boolean {
  for (const prim of solid) {
    const iv = prim.span(2, p);
    if (iv && p[2] >= iv[0] - eps && p[2] <= iv[1] + eps) return true;
  }
  return false;
}

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

// ---------------------------------------------------------------------------
// T-pose character: a procedural stand-in for a hand-made / AI-generated view
// set. The reference figure stands on y = −0.5 with its crown at y = +0.5
// (height 1), faces +Z, arms straight out along X (span ≈ 1.04). Every view
// can be drawn with its own proportions and framing, as independent artists
// would draw it, so misregistration between views can be dialled in exactly.

export type CharacterPart = 'head' | 'torso' | 'arm' | 'hand' | 'leg' | 'foot';

/** Drawing proportions: ratios are 1 for the reference figure, lengths are fractions of its height. */
export interface CharacterProportions {
  /** Head size ratio (a bigger head grows upwards). */
  headScale: number;
  torsoWidth: number;
  torsoDepth: number;
  hipWidth: number;
  /** Arm radius, fraction of the height (0.03: arms 6 % of the height thick). */
  armRadius: number;
  /** Arm length ratio. */
  armLength: number;
  /** Vertical shift of both arms, fraction of the height (+ = up). */
  armHeight: number;
  /** Leg length ratio (the body above rides on the legs). */
  legLength: number;
  legRadius: number;
  /** Ratio of the distance between the legs. */
  legSpread: number;
}

export const DEFAULT_CHARACTER_PROPORTIONS: CharacterProportions = {
  headScale: 1,
  torsoWidth: 1,
  torsoDepth: 1,
  hipWidth: 1,
  armRadius: 0.03,
  armLength: 1,
  armHeight: 0,
  legLength: 1,
  legRadius: 1,
  legSpread: 1,
};

export interface TposeCharacter {
  solid: Solid;
  parts: Record<CharacterPart, Solid>;
  proportions: CharacterProportions;
  /** World Y of the arm axis. */
  armY: number;
  /** World Y where the legs meet the hips (the crotch). */
  crotchY: number;
  /** World Y of the sole and the crown. */
  soleY: number;
  crownY: number;
}

/** Height fraction from the sole (0 = sole, 1 = the reference crown) → world Y. */
const LEG_TOP = 0.47, LEG_BOTTOM = 0.05;

export function tposeCharacter(p: Partial<CharacterProportions> = {}): TposeCharacter {
  const P = { ...DEFAULT_CHARACTER_PROPORTIONS, ...p };
  // Longer legs lift everything above them.
  const lift = (LEG_TOP - LEG_BOTTOM) * (P.legLength - 1);
  const Y = (f: number) => f - 0.5 + lift;
  const legY = (f: number) => f - 0.5;
  const armY = Y(0.755 + P.armHeight);
  const zc = 0.005;
  const hs = P.headScale;
  const headC = Y(0.836) + 0.082 * hs;
  const armX0 = 0.1, armX1 = 0.1 + 0.36 * P.armLength;
  const parts: Record<CharacterPart, Solid> = {
    head: [
      cylinderY(0, zc, 0.028, Y(0.79), Y(0.86)),
      ellipsoid([0, headC, zc], [0.068 * hs, 0.082 * hs, 0.074 * hs]),
      ellipsoid([0, headC - 0.01 * hs, zc + 0.074 * hs], [0.012 * hs, 0.014 * hs, 0.018 * hs]),
    ],
    torso: [
      taperY(0, zc, 0.135 * P.torsoWidth, 0.07 * P.torsoDepth, Y(0.64), Y(0.8), 0.8, 1),
      taperY(0, zc, 0.12 * P.hipWidth, 0.075 * P.torsoDepth, Y(0.44), Y(0.65), 1, 0.9),
    ],
    arm: [cylinderX(armY, zc, P.armRadius, armX0, armX1), cylinderX(armY, zc, P.armRadius, -armX1, -armX0)],
    hand: [1, -1].map((s) => ellipsoid([s * (armX1 + 0.028), armY, zc], [0.034, 0.038, 0.026])),
    leg: [1, -1].map((s) => taperY(s * 0.066 * P.legSpread, 0, 0.048 * P.legRadius, 0.048 * P.legRadius, legY(LEG_BOTTOM), legY(LEG_TOP) + lift, 0.7, 1)),
    foot: [1, -1].map((s) => ellipsoid([s * 0.072 * P.legSpread, legY(0.03), 0.02], [0.045, 0.03, 0.07])),
  };
  return {
    solid: Object.values(parts).flat(),
    parts,
    proportions: P,
    armY,
    crotchY: Y(0.44),
    soleY: legY(0),
    crownY: headC + 0.082 * hs,
  };
}

export const CHARACTER_COLORS: Record<CharacterPart, [number, number, number]> = {
  head: [233, 180, 143],
  arm: [233, 180, 143],
  hand: [211, 154, 116],
  torso: [37, 99, 235],
  leg: [31, 47, 77],
  foot: [17, 24, 39],
};

/** Hair: a cap over the crown and the back of the head (the back view shows no face). */
export const HAIR_COLOR: [number, number, number] = [74, 52, 38];

const PART_ORDER: CharacterPart[] = ['hand', 'arm', 'head', 'foot', 'leg', 'torso'];

/** The part whose surface a rendered point lies on (null off the figure). */
export function characterPartAt(ch: TposeCharacter, p: Vec3): CharacterPart | null {
  for (const part of PART_ORDER) if (containsPoint(ch.parts[part], p)) return part;
  return null;
}

/** Whether a point of the head is hair: the top of the crown, and the back of the head above the nape. */
export function isHair(ch: TposeCharacter, p: Vec3): boolean {
  const hs = ch.proportions.headScale;
  return p[1] > ch.crownY - 0.045 * hs || (p[2] < -0.01 * hs && p[1] > ch.crownY - 0.13 * hs);
}

/** Per-part colouring for renderView (hair on the head, see isHair). */
export function characterColor(ch: TposeCharacter): (p: Vec3) => [number, number, number] {
  return (p) => {
    const part = characterPartAt(ch, p) ?? 'torso';
    return part === 'head' && isHair(ch, p) ? HAIR_COLOR : CHARACTER_COLORS[part];
  };
}

/** How one view's drawing differs from the reference framing / figure. */
export interface ViewPerturbation {
  /** Zoom of the drawing (1 = the reference framing; the figure is `fill` of the image height). */
  scale?: number;
  /** Shift of the figure, fraction of the reference figure height (image right / down). */
  dx?: number;
  dy?: number;
  /** Fraction of the silhouette's height cut off by the image border at the top / bottom. */
  cropTop?: number;
  cropBottom?: number;
  /** Extra transparent margin on every side, fraction of the reference figure height (grows the image). */
  padding?: number;
  /** This view's own drawing proportions (over the set's base proportions). */
  proportions?: Partial<CharacterProportions>;
  /** Per-channel gain on the drawn sRGB colours (another exposure / white balance), clamped to 255. */
  tint?: [number, number, number];
}

export interface CharacterViewsOptions {
  /** Image side (square) before padding / cropping, default 512. */
  size?: number;
  /** Figure height / image height at scale 1, default 0.8. */
  fill?: number;
  /** Base proportions of every view. */
  proportions?: Partial<CharacterProportions>;
  perturb?: Partial<Record<ViewId, ViewPerturbation>>;
  /** Give the exact mask instead of leaving it to the alpha channel. */
  withMask?: boolean;
  background?: [number, number, number];
}

/** Pixel mapping of one rendered view: image (pixel-edge) position = (cx, cy) + scale · camera (s, t). */
export interface ViewFraming {
  width: number;
  height: number;
  /** Pixels per world unit. */
  scale: number;
  cx: number;
  cy: number;
}

export interface CharacterViews {
  inputs: FusionViewInput[];
  renders: Partial<Record<ViewId, Rendered>>;
  framing: Partial<Record<ViewId, ViewFraming>>;
  /** The figure each view was drawn from. */
  characters: Partial<Record<ViewId, TposeCharacter>>;
  /** The reference figure (base proportions). */
  character: TposeCharacter;
}

/** Rows [y0, y1) of a render. */
function cropRows(r: Rendered, y0: number, y1: number): Rendered {
  const w = r.image.width, h = y1 - y0;
  return {
    image: { width: w, height: h, data: r.image.data.slice(y0 * w * 4, y1 * w * 4) },
    mask: { width: w, height: h, data: r.mask.data.slice(y0 * w, y1 * w) },
    depth: { width: w, height: h, data: r.depth.data.slice(y0 * w, y1 * w) },
  };
}

/** Renders of the T-pose character from `views`, each with its own perturbation. */
export function renderCharacterViews(views: ViewId[], o: CharacterViewsOptions = {}): CharacterViews {
  const size = o.size ?? 512, fill = o.fill ?? 0.8;
  const base = { ...DEFAULT_CHARACTER_PROPORTIONS, ...o.proportions };
  const character = tposeCharacter(base);
  const renders: CharacterViews['renders'] = {};
  const framing: CharacterViews['framing'] = {};
  const characters: CharacterViews['characters'] = {};
  const refPx = fill * size;
  const inputs = views.map((id) => {
    const pert = o.perturb?.[id] ?? {};
    const ch = pert.proportions ? tposeCharacter({ ...base, ...pert.proportions }) : character;
    const scale = refPx * (pert.scale ?? 1);
    const pad = Math.round((pert.padding ?? 0) * refPx);
    const w = size + 2 * pad, h = size + 2 * pad;
    const offset: [number, number] = [(pert.dx ?? 0) * refPx, (pert.dy ?? 0) * refPx];
    const paint = characterColor(ch), tint = pert.tint;
    const color = tint ? (p: Vec3) => paint(p).map((c, k) => Math.min(255, Math.round(c * tint[k]))) as [number, number, number] : paint;
    let r = renderView(ch.solid, id, { width: w, height: h, scale, offset, color, background: o.background });
    let cy = h / 2 + offset[1];
    if (pert.cropTop || pert.cropBottom) {
      const bb = maskBBox(r.mask);
      if (bb) {
        const bh = bb.y1 - bb.y0;
        const y0 = pert.cropTop ? Math.min(h - 1, bb.y0 + Math.round(pert.cropTop * bh)) : 0;
        const y1 = pert.cropBottom ? Math.max(y0 + 1, bb.y1 - Math.round(pert.cropBottom * bh)) : h;
        r = cropRows(r, y0, y1);
        cy -= y0;
      }
    }
    renders[id] = r;
    framing[id] = { width: r.image.width, height: r.image.height, scale, cx: w / 2 + offset[0], cy };
    characters[id] = ch;
    return { id, image: r.image, mask: o.withMask ? r.mask : null };
  });
  return { inputs, renders, framing, characters, character };
}

/** Deterministic PRNG (mulberry32), values in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Proportions an independent artist might draw: every ratio within ±spread of
 * the reference, the arms placed within ±spread of the torso length (0.36 of
 * the height) from the reference shoulder line.
 */
export function artistProportions(rng: () => number, spread = 0.08): CharacterProportions {
  const j = (v: number) => v * (1 + spread * (2 * rng() - 1));
  const d = DEFAULT_CHARACTER_PROPORTIONS;
  return {
    headScale: j(1),
    torsoWidth: j(1),
    torsoDepth: j(1),
    hipWidth: j(1),
    armRadius: j(d.armRadius),
    armLength: j(1),
    armHeight: 0.36 * spread * (2 * rng() - 1),
    legLength: j(1),
    legRadius: j(1),
    legSpread: j(1),
  };
}

/**
 * A view set drawn by independent artists: every view has its own framing
 * (zoom 0.85..1.15, shift up to ±4 % of the height) and every view but the
 * front its own proportions (artistProportions) and, with `tint` > 0, its own
 * exposure / white balance (a per-channel gain within ±tint, from a separate
 * stream so the shapes do not change). Deterministic per seed.
 */
export function independentArtistViews(views: ViewId[], seed: number, o: CharacterViewsOptions & { spread?: number; tint?: number } = {}): CharacterViews {
  const rng = seededRandom(seed), tintRng = seededRandom(seed * 7919 + 17);
  const perturb: Partial<Record<ViewId, ViewPerturbation>> = {};
  for (const id of views) {
    const framing: ViewPerturbation = { scale: 0.85 + 0.3 * rng(), dx: 0.08 * rng() - 0.04, dy: 0.08 * rng() - 0.04 };
    perturb[id] = id === 'front' ? framing : { ...framing, proportions: artistProportions(rng, o.spread ?? 0.08) };
    if (id !== 'front' && o.tint) {
      const g = () => 1 + o.tint! * (2 * tintRng() - 1);
      perturb[id]!.tint = [g(), g(), g()];
    }
  }
  return renderCharacterViews(views, { ...o, perturb: { ...perturb, ...o.perturb } });
}

// ---------------------------------------------------------------------------
// Voxel ground truth and metrics of the T-pose character (for the fusion tests
// and the reproduction script): which part of the FRONT view's figure each
// voxel of a grid belongs to, and how much of every part a field keeps.


/** Voxel label: 0 empty, 1 arm + hand, 2 leg + foot, 3 torso, 4 head. */
export type VoxelLabel = 0 | 1 | 2 | 3 | 4;
const LABEL_OF: Record<CharacterPart, VoxelLabel> = { arm: 1, hand: 1, leg: 2, foot: 2, torso: 3, head: 4 };

export interface VoxelTruth {
  label: Uint8Array;
  /** Voxels per label. */
  counts: number[];
  /** Front-view arm band: voxels whose (x, y) lies on the arm rows beyond the torso, inside the front silhouette. */
  armBand: Uint8Array;
  /** World Y (reference figure units) of the chest and the hips. */
  chestY: number;
  hipY: number;
  /** World coordinates (reference figure units) of every voxel centre. */
  wx: Float32Array;
  wy: Float32Array;
  wz: Float32Array;
  /** Crotch-to-sole length of the reference figure. */
  legLength: number;
}

/**
 * Analytic truth of the FRONT view's figure on the grid: object units are
 * front pixels, mapped through the front framing back to figure units; the
 * figure's Z centre comes from an exact side render at the same scale.
 */
export function characterTruth(set: CharacterViews, front: PreparedView, box: ObjectBox, grid: Grid): VoxelTruth {
  const f = set.framing.front!;
  const ch = set.character;
  const proj = viewProjection(front, box.size);
  const left = renderView(ch.solid, 'left', { width: f.width, height: f.height, scale: f.scale });
  const lb = maskBBox(left.mask)!;
  const zc = -((lb.x0 + lb.x1) / 2 - f.width / 2) / f.scale;
  const [nx, ny, nz] = grid.dims;
  const n = nx * ny * nz;
  const label = new Uint8Array(n), armBand = new Uint8Array(n);
  const wx = new Float32Array(n), wy = new Float32Array(n), wz = new Float32Array(n);
  const counts = [0, 0, 0, 0, 0];
  const armR = ch.proportions.armRadius;
  const fm = front.mask;
  const p: Vec3 = [0, 0, 0];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const X = grid.origin[0] + i * grid.spacing, Y = grid.origin[1] + j * grid.spacing, Z = grid.origin[2] + k * grid.spacing;
        const u = proj.ou + proj.su * X, v = proj.ov + proj.sv * Y;
        const x = (u - f.cx) / f.scale, y = -(v - f.cy) / f.scale, z = Z / f.scale + zc;
        const idx = i + nx * (j + ny * k);
        wx[idx] = x;
        wy[idx] = y;
        wz[idx] = z;
        p[0] = x;
        p[1] = y;
        p[2] = z;
        let l: VoxelLabel = 0;
        for (const part of ['arm', 'hand', 'leg', 'foot', 'torso', 'head'] as CharacterPart[]) {
          if (containsPoint(ch.parts[part], p)) {
            l = LABEL_OF[part];
            break;
          }
        }
        label[idx] = l;
        counts[l]++;
        if (Math.abs(y - ch.armY) <= armR && Math.abs(x) > 0.135 * ch.proportions.torsoWidth) {
          const px = Math.floor(u), py = Math.floor(v);
          if (px >= 0 && py >= 0 && px < fm.width && py < fm.height && fm.data[py * fm.width + px]) armBand[idx] = 1;
        }
      }
  return { label, counts, armBand, chestY: ch.armY - 0.06, hipY: ch.soleY + 0.5, wx, wy, wz, legLength: ch.crotchY - ch.soleY };
}

export interface CharacterMetrics {
  /** Survival of the true arm + hand voxels (occupancy = field > 0.5). */
  arm: number;
  /** Share of the front's arm-band columns with any occupied voxel along Z (how much arm the front still sees). */
  armSil: number;
  leg: number;
  torso: number;
  head: number;
  /** Torso half width (X) at the shoulder / chest / hip rows, measured and true (figure units = fractions of the height). */
  widths: [number, number, number];
  widthsTrue: [number, number, number];
  /** Z extent at the chest / hip rows, measured and true. */
  depths: [number, number];
  depthsTrue: [number, number];
  /** Lowest occupied row → first row with the mid column occupied (the crotch), vs the truth. */
  legLen: number;
  legLenTrue: number;
  /** Occupied voxels outside the figure / true figure voxels. */
  bloat: number;
  /** IoU of the occupancy with the figure. */
  iou: number;
}

export function measureField(field: Float32Array, grid: Grid, t: VoxelTruth): CharacterMetrics {
  const [nx, ny, nz] = grid.dims;
  const kept = [0, 0, 0, 0, 0];
  let extra = 0, occTotal = 0;
  const colBand = new Uint8Array(nx * ny), colHit = new Uint8Array(nx * ny);
  const rowW = new Float32Array(ny), rowWTrue = new Float32Array(ny);
  const rowZ0 = new Float32Array(ny).fill(Infinity), rowZ1 = new Float32Array(ny).fill(-Infinity);
  const rowZ0T = new Float32Array(ny).fill(Infinity), rowZ1T = new Float32Array(ny).fill(-Infinity);
  const rowMidOcc = new Uint8Array(ny), rowAny = new Uint8Array(ny);
  const rowY = new Float32Array(ny);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const idx = i + nx * (j + ny * k);
        const occ = field[idx] > 0.5;
        const l = t.label[idx];
        const ax = Math.abs(t.wx[idx]);
        if (occ) {
          occTotal++;
          kept[l]++;
          if (l === 0) extra++;
          rowAny[j] = 1;
          if (ax < 0.012) rowMidOcc[j] = 1;
          if (ax < 0.2) {
            rowW[j] = Math.max(rowW[j], ax);
            rowZ0[j] = Math.min(rowZ0[j], t.wz[idx]);
            rowZ1[j] = Math.max(rowZ1[j], t.wz[idx]);
          }
        }
        if (l !== 0 && ax < 0.2) {
          rowWTrue[j] = Math.max(rowWTrue[j], ax);
          rowZ0T[j] = Math.min(rowZ0T[j], t.wz[idx]);
          rowZ1T[j] = Math.max(rowZ1T[j], t.wz[idx]);
        }
        rowY[j] = t.wy[idx];
        if (t.armBand[idx]) {
          colBand[i + nx * j] = 1;
          if (occ) colHit[i + nx * j] = 1;
        }
      }
  let bandCols = 0, hitCols = 0;
  for (let c = 0; c < nx * ny; c++)
    if (colBand[c]) {
      bandCols++;
      if (colHit[c]) hitCols++;
    }
  const rowAt = (y: number) => {
    let best = 0, bd = Infinity;
    for (let j = 0; j < ny; j++) {
      const d = Math.abs(rowY[j] - y);
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    return best;
  };
  const js = rowAt(t.chestY + 0.095), jc = rowAt(t.chestY), jh = rowAt(t.hipY);
  const dz = (j: number, z0: Float32Array, z1: Float32Array) => (z1[j] > z0[j] ? z1[j] - z0[j] : 0);
  let jBottom = -1, jCrotch = -1;
  for (let j = 0; j < ny; j++) if (rowAny[j]) { jBottom = j; break; }
  for (let j = Math.max(0, jBottom); j < ny; j++) if (rowMidOcc[j]) { jCrotch = j; break; }
  const legLen = jBottom >= 0 && jCrotch >= 0 ? rowY[jCrotch] - rowY[jBottom] : 0;
  const total = t.counts[1] + t.counts[2] + t.counts[3] + t.counts[4];
  const keptTrue = kept[1] + kept[2] + kept[3] + kept[4];
  return {
    arm: kept[1] / Math.max(1, t.counts[1]),
    armSil: hitCols / Math.max(1, bandCols),
    leg: kept[2] / Math.max(1, t.counts[2]),
    torso: kept[3] / Math.max(1, t.counts[3]),
    head: kept[4] / Math.max(1, t.counts[4]),
    widths: [rowW[js], rowW[jc], rowW[jh]],
    widthsTrue: [rowWTrue[js], rowWTrue[jc], rowWTrue[jh]],
    depths: [dz(jc, rowZ0, rowZ1), dz(jh, rowZ0, rowZ1)],
    depthsTrue: [dz(jc, rowZ0T, rowZ1T), dz(jh, rowZ0T, rowZ1T)],
    legLen,
    legLenTrue: t.legLength,
    bloat: extra / Math.max(1, total),
    iou: keptTrue / Math.max(1, total + occTotal - keptTrue),
  };
}

/** IoU of two occupancy fields (> 0.5) of the same size. */
export function fieldIoU(a: Float32Array, b: Float32Array): number {
  let inter = 0, union = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i] > 0.5, q = b[i] > 0.5;
    if (p && q) inter++;
    if (p || q) union++;
  }
  return union > 0 ? inter / union : 1;
}

/**
 * reconstructFromViews plus the smoothed occupancy field it extracted the
 * surface from (via the `inspect` hook), its grid and the registered views.
 */
export async function reconstructWithField(
  inputs: FusionViewInput[],
  options: Partial<FusionOptions>,
  ctx: Partial<FusionContext> = {},
): Promise<FusionResult & { field: Float32Array; grid: Grid; views: PreparedView[] }> {
  let field: Float32Array | null = null, grid: Grid | null = null;
  const result = await reconstructFromViews(inputs, options, {
    signal: new AbortController().signal,
    onProgress: () => {},
    yieldControl: async () => {},
    ...ctx,
    inspect: (stage, f, g) => {
      ctx.inspect?.(stage, f, g);
      if (stage === 'smooth') {
        field = f;
        grid = g;
      }
    },
  });
  if (!field || !grid) throw new Error('reconstructWithField: no field captured');
  const { views } = prepareFusionViews(inputs, sanitizeFusionOptions(options));
  return { ...result, field, grid, views };
}
