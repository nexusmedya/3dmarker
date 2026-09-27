/**
 * Vertex colours for the fused mesh. Every view that sees a vertex contributes
 * its image colour, weighted by max(0, n · viewDir)^p (views facing the
 * surface dominate, grazing ones fade out), by how far inside the view's
 * silhouette the vertex projects (0 outside it, see colorSource) and by its
 * visibility. Then, per vertex:
 *
 *  - Visibility: from an orthographic depth buffer of the RECONSTRUCTED mesh
 *    per view (meshDepthBuffer), max-filtered by the colour-edge radius so a
 *    surface right next to an occluder's outline counts as hidden (its image
 *    pixels may show the occluder), with a slope-aware tolerance and a soft
 *    band of one voxel. Without triangles: the voxel field's first hits.
 *  - Exposure: each view's colours are scaled per channel to the front's
 *    (viewGains: robust median ratio on surface both see well), so views drawn
 *    or lit differently do not leave seams or tint what only they see.
 *  - Photo-consistency: a sample that disagrees strongly with what the
 *    better-supported views see at the vertex is dropped (vote by facing ×
 *    view priority: front > back > sides / caps > colour-only views); two
 *    disagreeing views no longer average into a colour neither shows.
 *  - Thin parts (ColorOptions.thin): the side / cap views only colour within
 *    the part's round cross-section and where they agree with the front / back.
 *  - Seams: each view's weight fades over two rings of vertices towards the
 *    edge of the area it colours (feathering).
 *
 * Vertices no view colours take the colour of the nearest coloured vertices
 * over the mesh (breadth-first). Colours are sampled bilinearly in linear RGB
 * (sRGB decoded per tap).
 */
import type { RGBAImage } from '../types';
import { distanceTransform } from '../image/distance';
import type { PreparedView, ViewProjection } from './frame';
import type { Adjacency } from './meshOps';
import { bleedImage, dilateMask } from './silhouette';
import { drain, type Steps } from './steps';
import { forEachRay, rayCrossings, rayTToWorld, type Grid } from './volume';

/** sRGB 8-bit → linear [0, 1]. */
export const SRGB_TO_LINEAR: Float32Array = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

export interface ColorSource {
  proj: ViewProjection;
  /**
   * Crop of the view image around its silhouette (at x0, y0 of the view):
   * the colour core's pixels as they are, every other pixel bled from the
   * nearest core pixel (see colorSource).
   */
  image: RGBAImage;
  x0: number;
  y0: number;
  /** Per crop pixel: how much a sample there counts, 0 outside the silhouette rising to 1 inside. */
  weight: Float32Array;
  /** Colour-edge radius (view pixels): the silhouette erosion, and how far an occluder's outline hides a surface. */
  edge: number;
  /** Unit vector from the subject towards the camera. */
  dir: [number, number, number];
  /** Vote of this view in photo-consistency (VIEW_PRIORITY, lower for colour-only views). */
  priority: number;
  /** Toward-camera coordinate of the first voxel surface per ray of the grid's (ua, va) plane (−Infinity = miss); null = mesh visibility only. */
  hits: Float32Array | null;
}

/** First iso crossing per ray, as the toward-camera world coordinate. */
export function firstHits(field: Float32Array, grid: Grid, proj: ViewProjection, iso = 0.5): Float32Array {
  const nu = grid.dims[proj.ua];
  const out = new Float32Array(nu * grid.dims[proj.va]).fill(-Infinity);
  const iv = new Float64Array(2);
  forEachRay(grid, proj, (a, b, start, step, n) => {
    if (rayCrossings(field, start, step, n, iso, iv)) out[a + nu * b] = proj.ws * rayTToWorld(grid, proj, iv[0]);
  });
  return out;
}

/** Smallest colour-edge radius (pixels): matting fringes are 1–2 px wide. */
const MIN_EDGE_RADIUS = 2;

/**
 * Photo-consistency vote of a view: the front is the reference image (it
 * carves the X-Y outline exactly, every other view is registered to it), the
 * back mirrors its outline, sides and caps are registered with some error.
 */
export const VIEW_PRIORITY = { front: 1, back: 0.9, other: 0.8, colorOnly: 0.5 } as const;

/**
 * Colour source of a view. The silhouette's rim is unreliable: matting leaves
 * background-tinted fringe pixels inside the mask, and a rim pixel may belong
 * to another part of the subject than the vertex that projects onto it. So
 * the colour core is the mask eroded by r = max(2 px, half a voxel's
 * footprint) (thin parts that the erosion would remove entirely keep their
 * own pixels), every pixel outside the core takes the colour of the nearest
 * core pixel, and samples are weighted by smoothstep(0, 2r, distance to the
 * silhouette's edge): 0 outside the silhouette. Works on a crop around the
 * silhouette. With `field` the voxel first hits are kept for visibility
 * (colorVertices without triangles).
 */
export function colorSource(view: PreparedView, proj: ViewProjection, field?: Float32Array | null, grid?: Grid): ColorSource {
  return drain(colorSourceSteps(view, proj, field, grid));
}

/** colorSource as cooperative steps (a yield after each pass over the crop / grid). */
export function* colorSourceSteps(view: PreparedView, proj: ViewProjection, field?: Float32Array | null, grid?: Grid): Steps<ColorSource> {
  const dir: [number, number, number] = [0, 0, 0];
  dir[proj.wa] = proj.ws;
  const spacing = grid?.spacing ?? 0;
  const r = Math.max(MIN_EDGE_RADIUS, 0.25 * spacing * (Math.abs(proj.su) + Math.abs(proj.sv)));
  const { image, mask, bbox } = view;
  const m = Math.ceil(2 * r) + 2;
  const x0 = Math.max(0, bbox.x0 - m), y0 = Math.max(0, bbox.y0 - m);
  const w = Math.min(image.width, bbox.x1 + m) - x0, h = Math.min(image.height, bbox.y1 + m) - y0;
  const n = w * h;
  const px = new Uint8ClampedArray(n * 4);
  const raw = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const s = (y + y0) * image.width + x0;
    px.set(image.data.subarray(s * 4, (s + w) * 4), y * w * 4);
    raw.set(mask.data.subarray(s, s + w), y * w);
  }
  yield;
  const edge = distanceTransform({ width: w, height: h, data: raw });
  yield;
  const core = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) if (edge[i] > r) {
    core[i] = 1;
    any = true;
  }
  if (any) {
    // Parts thinner than 2r vanish in the erosion and are not restored by dilating it back: keep them.
    const opened = dilateMask({ width: w, height: h, data: core }, r + 1.5).data;
    for (let i = 0; i < n; i++) if (raw[i] && !opened[i]) core[i] = 1;
    yield;
  } else core.set(raw);
  const weight = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, edge[i] / (2 * r));
    weight[i] = t * t * (3 - 2 * t);
  }
  const bled = bleedImage({ width: w, height: h, data: px }, { width: w, height: h, data: core });
  yield;
  const priority = (view.id === 'front' ? VIEW_PRIORITY.front : view.id === 'back' ? VIEW_PRIORITY.back : VIEW_PRIORITY.other)
    * (view.trust === 'color' ? VIEW_PRIORITY.colorOnly : 1);
  const hits = field && grid ? firstHits(field, grid, proj) : null;
  return { proj, image: bled, x0, y0, weight, edge: r, dir, priority, hits };
}

export interface ColorOptions {
  /** Exponent p of the facing weight. */
  sharpness: number;
  /** World distance behind the first voxel hit that still counts as visible (voxel visibility only). */
  tolerance: number;
  /**
   * The mesh's triangles: visibility from its per-view depth buffers
   * (meshDepthBuffer). Without them, the sources' voxel first hits.
   */
  indices?: Uint32Array;
  /** Per-view exposure matching to the front (viewGains); default on. */
  gains?: boolean;
  /** Photo-consistency vote (drop samples the better-supported views contradict); default on. */
  consistency?: boolean;
  /** Seam feathering: rings of vertices over which a view's weight fades out at the edge of its area (default 2). */
  feather?: number;
  /**
   * The parts the front shows as thin (the thin-part guard, ./guard.ts). The
   * fused surface is a visual hull: where a thin part is seen end-on in front
   * of a bigger one (a T-pose arm from the side, the neck inside the shoulders
   * from above) the hull keeps volume that view cannot carve, and that extra
   * surface really is the view's first hit, so the visibility test passes and
   * the part behind is painted on it (shirt blue on the hands). On thin parts
   * the front / back (which carve the X-Y outline exactly) are the reference:
   * a side / cap sample is dropped outside the part's round cross-section
   * where that view sees another part behind it (`support`), and wherever it
   * disagrees with the front / back colour.
   */
  thin?: ThinParts;
}

export interface ThinParts {
  /** 0..1 per surface point (grid world coords): how far the view looking along world `axis` (0 = X: left / right, 1 = Y: top / bottom) may colour it. */
  support(p: ArrayLike<number>, axis: 0 | 1): number;
  /** 0..1: how thin the front shows the part at p (0 = not thin). */
  gate(p: ArrayLike<number>): number;
}

/** Side / cap samples on thin parts farther than AGREE_MIN (linear RGB) from the front / back colour fade out, gone at AGREE_MAX. */
export const AGREE_MIN = 0.12;
export const AGREE_MAX = 0.2;
/** Least facing of a front / back sample that counts for the reference colour. */
const REF_FACING = 0.05;

/**
 * Photo-consistency: samples farther than CONSIST_MIN (linear RGB) from the
 * best-supported colour at a vertex fade out, gone at CONSIST_MAX, the more
 * the less support they have themselves (none left at two thirds of the
 * best's; two views seeing a surface equally well blend into a seam).
 */
export const CONSIST_MIN = 0.15;
export const CONSIST_MAX = 0.3;

/**
 * Exposure matching (viewGains): pairs where both views face the surface by
 * at least GAIN_FACING, at least GAIN_MIN_PAIRS of them agreeing after the
 * gain; a gain beyond GAIN_REJECT on any channel is a content mismatch (another
 * colour, not another exposure), within GAIN_DEADZONE it is noise; applied
 * gains are clamped to GAIN_MAX.
 */
const GAIN_FACING = 0.3;
const GAIN_MIN_PAIRS = 30;
const GAIN_REJECT = Math.log(1.6);
const GAIN_MAX = Math.log(1.4);
const GAIN_DEADZONE = Math.log(1.02);
const GAIN_EPS = 0.02;
const GAIN_RINGS = 6;

/**
 * Bilinear linear-RGB sample of a colour source at continuous view-image
 * pixel-edge coords into out[o..o+2]; returns the sample weight there (0..1).
 */
function sample(src: ColorSource, u: number, v: number, out: Float32Array, o: number): number {
  const { width: w, height: h, data } = src.image;
  const fx = Math.min(w - 1, Math.max(0, u - src.x0 - 0.5)), fy = Math.min(h - 1, Math.max(0, v - src.y0 - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
  const p00 = (y0 * w + x0) * 4, p10 = (y0 * w + x1) * 4, p01 = (y1 * w + x0) * 4, p11 = (y1 * w + x1) * 4;
  for (let c = 0; c < 3; c++) {
    out[o + c] = w00 * SRGB_TO_LINEAR[data[p00 + c]] + w10 * SRGB_TO_LINEAR[data[p10 + c]]
      + w01 * SRGB_TO_LINEAR[data[p01 + c]] + w11 * SRGB_TO_LINEAR[data[p11 + c]];
  }
  const m = src.weight;
  return w00 * m[p00 >> 2] + w10 * m[p10 >> 2] + w01 * m[p01 >> 2] + w11 * m[p11 >> 2];
}

/** Voxel visibility: within `tol` of the nearest first hit of the four rays around p (0 / 1). */
function voxelVisible(src: ColorSource, grid: Grid, p: Float64Array, tol: number): number {
  const { proj, hits } = src;
  if (!hits) return 1;
  const nu = grid.dims[proj.ua], nv = grid.dims[proj.va];
  const ga = (p[proj.ua] - grid.origin[proj.ua]) / grid.spacing;
  const gb = (p[proj.va] - grid.origin[proj.va]) / grid.spacing;
  const a0 = Math.floor(ga), b0 = Math.floor(gb);
  // The nearest first hit of the four surrounding rays: a surface right next to an occluder counts as hidden.
  let hit = -Infinity;
  for (let db = 0; db < 2; db++)
    for (let da = 0; da < 2; da++) {
      const a = Math.min(nu - 1, Math.max(0, a0 + da)), b = Math.min(nv - 1, Math.max(0, b0 + db));
      const c = hits[a + nu * b];
      if (c > hit) hit = c;
    }
  return proj.ws * p[proj.wa] >= hit - tol ? 1 : 0;
}

/**
 * Orthographic depth buffer of a triangle mesh in a view: per cell of the
 * source's crop (cell × cell view pixels), the largest toward-camera
 * coordinate (world) of the surface (−Infinity = empty). `near` is the same
 * max-filtered over `reach` cells: the nearest surface around each cell.
 */
export interface DepthBuffer {
  w: number;
  h: number;
  /** View pixels per cell. */
  cell: number;
  /** Max-filter radius of `near`, cells. */
  reach: number;
  depth: Float32Array;
  near: Float32Array;
}

/** Largest depth-buffer size (cells). */
const DEPTH_BUFFER_CELLS = 1 << 18;

export function meshDepthBuffer(positions: Float32Array, indices: Uint32Array, src: ColorSource): DepthBuffer {
  return drain(meshDepthBufferSteps(positions, indices, src));
}

/** meshDepthBuffer as cooperative steps (a yield per 16384 triangles). */
export function* meshDepthBufferSteps(positions: Float32Array, indices: Uint32Array, src: ColorSource): Steps<DepthBuffer> {
  const { proj, image } = src;
  const cell = Math.max(1, Math.ceil(Math.sqrt((image.width * image.height) / DEPTH_BUFFER_CELLS)));
  const w = Math.max(1, Math.ceil(image.width / cell)), h = Math.max(1, Math.ceil(image.height / cell));
  const depth = new Float32Array(w * h).fill(-Infinity);
  const { ua, va, wa, su, sv, ou, ov, ws } = proj;
  const X = (q: number) => (ou + su * positions[q + ua] - src.x0) / cell;
  const Y = (q: number) => (ov + sv * positions[q + va] - src.y0) / cell;
  const Z = (q: number) => ws * positions[q + wa];
  for (let t = 0, batch = 0; t < indices.length; t += 3) {
    if (++batch === 16384) {
      batch = 0;
      yield;
    }
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = X(a), ay = Y(a), bx = X(b), by = Y(b), cx = X(c), cy = Y(c);
    const az = Z(a), bz = Z(b), cz = Z(c);
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    // Cells whose centre (i + ½, j + ½) lies in the triangle.
    const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5)), i1 = Math.min(w - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
    const j0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5)), j1 = Math.min(h - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
    if (Math.abs(area) < 1e-12 || i0 > i1 || j0 > j1) continue;
    const inv = 1 / area;
    for (let j = j0; j <= j1; j++) {
      const y = j + 0.5;
      for (let i = i0; i <= i1; i++) {
        const x = i + 0.5;
        const l0 = ((bx - x) * (cy - y) - (by - y) * (cx - x)) * inv;
        const l1 = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) * inv;
        const l2 = 1 - l0 - l1;
        if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
        const z = l0 * az + l1 * bz + l2 * cz;
        const k = i + w * j;
        if (z > depth[k]) depth[k] = z;
      }
    }
  }
  // Triangles smaller than a cell cover no centre: their vertices still mark it.
  for (let q = 0; q < positions.length; q += 3) {
    const i = Math.floor(X(q)), j = Math.floor(Y(q));
    if (i < 0 || j < 0 || i >= w || j >= h) continue;
    const z = Z(q), k = i + w * j;
    if (z > depth[k]) depth[k] = z;
  }
  yield;
  const reach = Math.max(1, Math.round(src.edge / cell));
  const near = maxFilter(depth, w, h, reach);
  return { w, h, cell, reach, depth, near };
}

/** Separable square max filter of radius r. */
function maxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      let m = -Infinity;
      for (let d = Math.max(0, i - r); d <= Math.min(w - 1, i + r); d++) if (src[d + w * j] > m) m = src[d + w * j];
      tmp[i + w * j] = m;
    }
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      let m = -Infinity;
      for (let d = Math.max(0, j - r); d <= Math.min(h - 1, j + r); d++) if (tmp[i + w * d] > m) m = tmp[i + w * d];
      out[i + w * j] = m;
    }
  return out;
}

/**
 * Mesh visibility (0..1) of surface point p with facing f in a view: how far
 * it lies behind the nearest surface around its cell (DepthBuffer.near),
 * against a tolerance for the depth the surface itself spans over the
 * filter window at its slope; fades out over one voxel beyond it.
 */
export function meshVisibility(src: ColorSource, db: DepthBuffer, p: Float64Array, f: number, spacing: number): number {
  const { proj } = src;
  const i = Math.floor((proj.ou + proj.su * p[proj.ua] - src.x0) / db.cell);
  const j = Math.floor((proj.ov + proj.sv * p[proj.va] - src.y0) / db.cell);
  if (i < 0 || j < 0 || i >= db.w || j >= db.h) return 1;
  const front = db.near[i + db.w * j];
  if (front === -Infinity) return 1;
  const behind = front - proj.ws * p[proj.wa];
  const cellWorld = db.cell / Math.min(Math.abs(proj.su), Math.abs(proj.sv));
  const slope = Math.min(8, Math.sqrt(Math.max(0, 1 - f * f)) / Math.max(f, 0.05));
  const tol = 0.4 * spacing + (db.reach + 0.75) * cellWorld * slope;
  const t = (behind - tol) / spacing;
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  return 1 - t * t * (3 - 2 * t);
}

/** A source whose rays run along Z (front / back): it carves the X-Y outline exactly. */
const alongZ = (src: ColorSource) => src.proj.wa === 2;

const smooth01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Linear RGB per vertex (xyz-interleaved like positions). */
export function colorVertices(
  positions: Float32Array,
  normals: Float32Array,
  adj: Adjacency,
  sources: ColorSource[],
  grid: Grid,
  o: ColorOptions,
): Float32Array {
  return drain(colorVerticesSteps(positions, normals, adj, sources, grid, o));
}

/** colorVertices as cooperative steps (a yield per 4096 vertices and per view pass). */
export function* colorVerticesSteps(
  positions: Float32Array,
  normals: Float32Array,
  adj: Adjacency,
  sources: ColorSource[],
  grid: Grid,
  o: ColorOptions,
): Steps<Float32Array> {
  const n = positions.length / 3, S = sources.length;
  const colors = new Float32Array(n * 3);
  const done = new Uint8Array(n);
  const p = new Float64Array(3);
  const pw = Math.max(0.5, o.sharpness);
  const primary = sources.map(alongZ);
  const thin = o.thin && primary.some((x) => x) && primary.some((x) => !x) ? o.thin : null;
  const buffers: (DepthBuffer | null)[] = [];
  for (const src of sources) buffers.push(o.indices ? yield* meshDepthBufferSteps(positions, o.indices, src) : null);
  // Per vertex and source: the sample (linear RGB), its weight (0 = unused) and its quality (facing × silhouette × visibility).
  const smp = new Float32Array(n * S * 3), wts = new Float32Array(n * S), qual = new Float32Array(n * S);
  const gate = thin ? new Float32Array(n) : null;
  for (let v = 0; v < n; v++) {
    if ((v & 4095) === 4095) yield;
    const q = v * 3;
    p[0] = positions[q];
    p[1] = positions[q + 1];
    p[2] = positions[q + 2];
    // Support per view axis (X: left / right, Y: top / bottom), computed on demand.
    let supX = -1, supY = -1;
    if (thin) gate![v] = thin.gate(p);
    for (let s = 0; s < S; s++) {
      const src = sources[s];
      const facing = normals[q] * src.dir[0] + normals[q + 1] * src.dir[1] + normals[q + 2] * src.dir[2];
      if (facing <= 0) continue;
      let support = 1;
      if (!primary[s] && thin && gate![v] > 0) {
        if (src.proj.wa === 0) support = supX < 0 ? (supX = thin.support(p, 0)) : supX;
        else support = supY < 0 ? (supY = thin.support(p, 1)) : supY;
        if (!(support > 0)) continue;
      }
      const vis = buffers[s] ? meshVisibility(src, buffers[s]!, p, facing, grid.spacing) : voxelVisible(src, grid, p, o.tolerance);
      if (!(vis > 0)) continue;
      const { proj } = src;
      const k = v * S + s;
      const sw = sample(src, proj.ou + proj.su * p[proj.ua], proj.ov + proj.sv * p[proj.va], smp, 3 * k);
      if (!(sw > 0)) continue;
      wts[k] = Math.pow(facing, pw) * sw * support * vis;
      qual[k] = facing * sw * vis;
    }
  }
  yield;
  if (o.gains !== false) {
    const gains = viewGains(smp, qual, sources, adj);
    for (let s = 0; s < S; s++) {
      const g = gains[s];
      if (g[0] === 1 && g[1] === 1 && g[2] === 1) continue;
      for (let v = 0; v < n; v++) {
        const k = v * S + s;
        if (!(wts[k] > 0)) continue;
        for (let c = 0; c < 3; c++) smp[3 * k + c] = applyGain(smp[3 * k + c], g[c]);
      }
    }
    yield;
  }
  // Thin parts: the front / back reference colour (propagated to where they do not see).
  const ref = thin ? new Float32Array(n * 3) : null, hasRef = thin ? new Uint8Array(n) : null;
  if (ref) {
    for (let v = 0; v < n; v++) {
      if ((v & 4095) === 4095) yield;
      let rr = 0, rg = 0, rb = 0, rw = 0;
      for (let s = 0; s < S; s++) {
        const k = v * S + s;
        if (!primary[s] || !(wts[k] > 0) || qual[k] <= 0) continue;
        const facing = normals[3 * v] * sources[s].dir[0] + normals[3 * v + 1] * sources[s].dir[1] + normals[3 * v + 2] * sources[s].dir[2];
        if (facing < REF_FACING) continue;
        const w = qual[k];
        rr += w * smp[3 * k];
        rg += w * smp[3 * k + 1];
        rb += w * smp[3 * k + 2];
        rw += w;
      }
      if (rw > 1e-6) {
        ref[3 * v] = rr / rw;
        ref[3 * v + 1] = rg / rw;
        ref[3 * v + 2] = rb / rw;
        hasRef![v] = 1;
      }
    }
    propagateColors(ref, hasRef!, adj);
    yield;
  }
  const consistency = o.consistency !== false;
  const vote = new Float32Array(S);
  for (let v = 0; v < n; v++) {
    if ((v & 4095) === 4095) yield;
    const q = v * 3;
    const g = gate ? gate[v] : 0;
    let count = 0;
    for (let s = 0; s < S; s++) if (wts[v * S + s] > 0) count++;
    if (count === 0) continue;
    if (g > 0) {
      for (let s = 0; s < S; s++) {
        const k = v * S + s;
        if (!(wts[k] > 0) || primary[s]) continue;
        const d = dist3(smp, 3 * k, ref!, q);
        wts[k] *= 1 - g * smooth01((d - AGREE_MIN) / (AGREE_MAX - AGREE_MIN));
      }
    }
    if (consistency && count >= 2) {
      // Support of each sample's colour: the votes (quality × priority) of the samples agreeing with it.
      let best = -1, bestVote = 0;
      for (let s = 0; s < S; s++) {
        const k = v * S + s;
        vote[s] = 0;
        if (!(wts[k] > 0)) continue;
        for (let t = 0; t < S; t++) {
          const l = v * S + t;
          if (!(wts[l] > 0)) continue;
          if (t === s || dist3(smp, 3 * k, smp, 3 * l) < CONSIST_MIN) vote[s] += qual[l] * sources[t].priority;
        }
        if (vote[s] > bestVote) {
          bestVote = vote[s];
          best = s;
        }
      }
      if (best >= 0) {
        const kb = v * S + best;
        for (let s = 0; s < S; s++) {
          const k = v * S + s;
          if (s === best || !(wts[k] > 0)) continue;
          const off = smooth01((dist3(smp, 3 * k, smp, 3 * kb) - CONSIST_MIN) / (CONSIST_MAX - CONSIST_MIN));
          if (off <= 0) continue;
          const weaker = Math.min(1, Math.max(0, 3 * (1 - vote[s] / bestVote)));
          wts[k] *= 1 - off * weaker;
        }
      }
    }
  }
  yield;
  const rings = Math.max(0, Math.round(o.feather ?? 2));
  if (rings > 0) {
    yield* featherWeights(wts, S, adj, rings);
  }
  for (let v = 0; v < n; v++) {
    if ((v & 4095) === 4095) yield;
    const q = v * 3;
    let r = 0, gg = 0, b = 0, wsum = 0;
    for (let s = 0; s < S; s++) {
      const k = v * S + s;
      const wgt = wts[k];
      if (!(wgt > 0)) continue;
      r += wgt * smp[3 * k];
      gg += wgt * smp[3 * k + 1];
      b += wgt * smp[3 * k + 2];
      wsum += wgt;
    }
    if (wsum > 1e-6) {
      colors[q] = r / wsum;
      colors[q + 1] = gg / wsum;
      colors[q + 2] = b / wsum;
      done[v] = 1;
    }
  }
  propagateColors(colors, done, adj);
  return colors;
}

function dist3(a: Float32Array, i: number, b: Float32Array, j: number): number {
  const dr = a[i] - b[j], dg = a[i + 1] - b[j + 1], db = a[i + 2] - b[j + 2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Seam feathering: each view's weight is multiplied by the share of the
 * vertices within `rings` rings that it colours too (a box filter of its
 * coverage, iterated), so it fades out towards the edge of its area instead
 * of stopping at a visibility or silhouette cut. Where a view is the only
 * one, the normalisation leaves its colour as it is.
 */
function* featherWeights(wts: Float32Array, S: number, adj: Adjacency, rings: number): Steps<void> {
  const n = wts.length / S;
  const { offsets, neighbors } = adj;
  let cur = new Float32Array(n), next = new Float32Array(n);
  for (let s = 0; s < S; s++) {
    for (let v = 0; v < n; v++) cur[v] = wts[v * S + s] > 0 ? 1 : 0;
    for (let it = 0; it < rings; it++) {
      for (let v = 0; v < n; v++) {
        let sum = cur[v], cnt = 1;
        for (let e = offsets[v]; e < offsets[v + 1]; e++) {
          sum += cur[neighbors[e]];
          cnt++;
        }
        next[v] = sum / cnt;
      }
      [cur, next] = [next, cur];
    }
    for (let v = 0; v < n; v++) if (wts[v * S + s] > 0) wts[v * S + s] *= cur[v];
    yield;
  }
}

/**
 * Per-view exposure / white-balance gains to the front (1 for the front, and
 * for any view without enough shared, agreeing surface). A visual hull is
 * box-like: few vertices face two views at once, so a view is compared with
 * the calibrated views' colour field carried up to GAIN_RINGS rings over the
 * mesh (across the edge between their areas). Views are calibrated in order
 * of that overlap (the back through the sides), each against all views
 * calibrated before it: per channel the median of ln(ref / view), re-estimated
 * on the pairs within 0.3 of the first estimate (other parts, through
 * misregistration, are outliers). A channel beyond GAIN_REJECT means the views
 * show different colours there, not different exposures: no gain.
 */
export function viewGains(smp: Float32Array, qual: Float32Array, sources: ColorSource[], adj: Adjacency): [number, number, number][] {
  const S = sources.length, n = adj.offsets.length - 1;
  const gains: [number, number, number][] = sources.map(() => [1, 1, 1]);
  const ref = sources.findIndex((s) => s.proj.wa === 2 && s.proj.ws > 0 && s.priority >= VIEW_PRIORITY.front);
  if (ref < 0) return gains;
  const done = new Uint8Array(S);
  done[ref] = 1;
  const field = new Float32Array(n * 3), has = new Uint8Array(n);
  const good = (k: number) => qual[k] >= GAIN_FACING;
  for (;;) {
    // The calibrated views' colour where they see well, carried a few rings further.
    has.fill(0);
    for (let v = 0; v < n; v++) {
      let r = 0, g = 0, b = 0, w = 0;
      for (let t = 0; t < S; t++) {
        const l = v * S + t;
        if (!done[t] || !good(l)) continue;
        r += qual[l] * applyGain(smp[3 * l], gains[t][0]);
        g += qual[l] * applyGain(smp[3 * l + 1], gains[t][1]);
        b += qual[l] * applyGain(smp[3 * l + 2], gains[t][2]);
        w += qual[l];
      }
      if (w > 0) {
        field[3 * v] = r / w;
        field[3 * v + 1] = g / w;
        field[3 * v + 2] = b / w;
        has[v] = 1;
      }
    }
    spreadColors(field, has, adj, GAIN_RINGS);
    // The uncalibrated view with the most well-seen vertices in that field.
    let pick = -1, most = 0;
    for (let s = 0; s < S; s++) {
      if (done[s]) continue;
      let cnt = 0;
      for (let v = 0; v < n; v++) if (has[v] && good(v * S + s)) cnt++;
      if (cnt > most) {
        most = cnt;
        pick = s;
      }
    }
    if (pick < 0 || most < GAIN_MIN_PAIRS) break;
    done[pick] = 1;
    const logs: number[][] = [[], [], []];
    for (let v = 0; v < n; v++) {
      const k = v * S + pick;
      if (!has[v] || !good(k)) continue;
      for (let c = 0; c < 3; c++) logs[c].push(Math.log((toSrgb(field[3 * v + c]) + GAIN_EPS) / (toSrgb(smp[3 * k + c]) + GAIN_EPS)));
    }
    const first = logs.map(median);
    const keep: number[][] = [[], [], []];
    for (let i = 0; i < logs[0].length; i++) {
      if (![0, 1, 2].every((c) => Math.abs(logs[c][i] - first[c]) < 0.3)) continue;
      for (let c = 0; c < 3; c++) keep[c].push(logs[c][i]);
    }
    const g = keep.map(median);
    if (keep[0].length < Math.max(GAIN_MIN_PAIRS, 0.5 * logs[0].length)) continue;
    if (g.some((x) => Math.abs(x) > GAIN_REJECT)) continue;
    gains[pick] = g.map((x) => (Math.abs(x) < GAIN_DEADZONE ? 1 : Math.exp(Math.max(-GAIN_MAX, Math.min(GAIN_MAX, x))))) as [number, number, number];
  }
  return gains;
}

/** propagateColors limited to `rings` rings: vertices farther from any coloured one stay uncoloured. */
function spreadColors(colors: Float32Array, done: Uint8Array, adj: Adjacency, rings: number): void {
  const { offsets, neighbors } = adj;
  let front: number[] = [];
  for (let v = 0; v < done.length; v++) if (done[v]) front.push(v);
  for (let r = 0; r < rings && front.length; r++) {
    const next: number[] = [];
    for (const v of front)
      for (let e = offsets[v]; e < offsets[v + 1]; e++) {
        const u = neighbors[e];
        if (done[u]) continue;
        let cr = 0, cg = 0, cb = 0, k = 0;
        for (let f = offsets[u]; f < offsets[u + 1]; f++) {
          const w = neighbors[f];
          if (done[w] !== 1) continue;
          cr += colors[w * 3]; cg += colors[w * 3 + 1]; cb += colors[w * 3 + 2];
          k++;
        }
        colors[u * 3] = cr / k;
        colors[u * 3 + 1] = cg / k;
        colors[u * 3 + 2] = cb / k;
        done[u] = 2;
        next.push(u);
      }
    for (const u of next) done[u] = 1;
    front = next;
  }
}

/** Linear → sRGB-encoded (0..1). */
function toSrgb(x: number): number {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** A gain acts on the sRGB-encoded value, as exposure / white balance of an 8-bit image does. */
function applyGain(x: number, g: number): number {
  if (g === 1) return x;
  const e = Math.min(1, toSrgb(x) * g);
  return e <= 0.04045 ? e / 12.92 : Math.pow((e + 0.055) / 1.055, 2.4);
}

function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length & 1 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/**
 * Fill uncoloured vertices breadth-first from coloured ones: each takes the
 * mean of its already coloured neighbours. Components without any colour get
 * the global mean (grey when nothing is coloured).
 */
export function propagateColors(colors: Float32Array, done: Uint8Array, adj: Adjacency): void {
  const n = done.length;
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  let mr = 0, mg = 0, mb = 0, cnt = 0;
  for (let v = 0; v < n; v++) {
    if (!done[v]) continue;
    queue[tail++] = v;
    mr += colors[v * 3]; mg += colors[v * 3 + 1]; mb += colors[v * 3 + 2];
    cnt++;
  }
  const { offsets, neighbors } = adj;
  while (head < tail) {
    const v = queue[head++];
    for (let e = offsets[v]; e < offsets[v + 1]; e++) {
      const u = neighbors[e];
      if (done[u]) continue;
      let r = 0, g = 0, b = 0, k = 0;
      for (let f = offsets[u]; f < offsets[u + 1]; f++) {
        const w = neighbors[f];
        if (!done[w]) continue;
        r += colors[w * 3]; g += colors[w * 3 + 1]; b += colors[w * 3 + 2];
        k++;
      }
      colors[u * 3] = r / k;
      colors[u * 3 + 1] = g / k;
      colors[u * 3 + 2] = b / k;
      done[u] = 1;
      queue[tail++] = u;
    }
  }
  if (tail === n) return;
  const fill = cnt > 0 ? [mr / cnt, mg / cnt, mb / cnt] : [0.5, 0.5, 0.5];
  for (let v = 0; v < n; v++) {
    if (done[v]) continue;
    colors[v * 3] = fill[0];
    colors[v * 3 + 1] = fill[1];
    colors[v * 3 + 2] = fill[2];
  }
}
