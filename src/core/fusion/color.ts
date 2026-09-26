/**
 * Vertex colours for the fused mesh: every view that sees a vertex
 * contributes its image colour, weighted by max(0, n · viewDir)^p (views
 * facing the surface dominate, grazing ones fade out) and by how far inside
 * the view's silhouette the vertex projects (0 outside it, see colorSource).
 * Visibility comes from per-view first-hit maps of the voxel field (a vertex
 * is visible when it is within a tolerance of the nearest first surface of
 * the four rays around it). Vertices no view sees take the colour of the
 * nearest coloured vertices over the mesh (breadth-first).
 * Colours are sampled bilinearly in linear RGB (sRGB decoded per tap).
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
  /** Unit vector from the subject towards the camera. */
  dir: [number, number, number];
  /** Toward-camera coordinate of the first surface per ray of the grid's (ua, va) plane; −Infinity = miss. */
  hits: Float32Array;
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
 * Colour source of a view. The silhouette's rim is unreliable: matting leaves
 * background-tinted fringe pixels inside the mask, and a rim pixel may belong
 * to another part of the subject than the vertex that projects onto it. So
 * the colour core is the mask eroded by r = max(2 px, half a voxel's
 * footprint) (thin parts that the erosion would remove entirely keep their
 * own pixels), every pixel outside the core takes the colour of the nearest
 * core pixel, and samples are weighted by smoothstep(0, 2r, distance to the
 * silhouette's edge): 0 outside the silhouette. Works on a crop around the
 * silhouette.
 */
export function colorSource(view: PreparedView, proj: ViewProjection, field: Float32Array, grid: Grid): ColorSource {
  const dir: [number, number, number] = [0, 0, 0];
  dir[proj.wa] = proj.ws;
  const r = Math.max(MIN_EDGE_RADIUS, 0.25 * grid.spacing * (Math.abs(proj.su) + Math.abs(proj.sv)));
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
  const edge = distanceTransform({ width: w, height: h, data: raw });
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
  } else core.set(raw);
  const weight = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, edge[i] / (2 * r));
    weight[i] = t * t * (3 - 2 * t);
  }
  return {
    proj,
    image: bleedImage({ width: w, height: h, data: px }, { width: w, height: h, data: core }),
    x0,
    y0,
    weight,
    dir,
    hits: firstHits(field, grid, proj),
  };
}

export interface ColorOptions {
  /** Exponent p of the facing weight. */
  sharpness: number;
  /** World distance behind the first hit that still counts as visible. */
  tolerance: number;
}

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

function visible(src: ColorSource, grid: Grid, p: Float64Array, tol: number): boolean {
  const { proj, hits } = src;
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
  return proj.ws * p[proj.wa] >= hit - tol;
}

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

/** colorVertices as cooperative steps (a yield per 4096 vertices). */
export function* colorVerticesSteps(
  positions: Float32Array,
  normals: Float32Array,
  adj: Adjacency,
  sources: ColorSource[],
  grid: Grid,
  o: ColorOptions,
): Steps<Float32Array> {
  const n = positions.length / 3;
  const colors = new Float32Array(n * 3);
  const done = new Uint8Array(n);
  const rgb = new Float32Array(3);
  const p = new Float64Array(3);
  const pw = Math.max(0.5, o.sharpness);
  for (let v = 0; v < n; v++) {
    if ((v & 4095) === 4095) yield;
    const q = v * 3;
    p[0] = positions[q];
    p[1] = positions[q + 1];
    p[2] = positions[q + 2];
    let r = 0, g = 0, b = 0, wsum = 0;
    for (const src of sources) {
      const facing = normals[q] * src.dir[0] + normals[q + 1] * src.dir[1] + normals[q + 2] * src.dir[2];
      if (facing <= 0) continue;
      if (!visible(src, grid, p, o.tolerance)) continue;
      const { proj } = src;
      const wgt = Math.pow(facing, pw) * sample(src, proj.ou + proj.su * p[proj.ua], proj.ov + proj.sv * p[proj.va], rgb, 0);
      if (!(wgt > 0)) continue;
      r += wgt * rgb[0];
      g += wgt * rgb[1];
      b += wgt * rgb[2];
      wsum += wgt;
    }
    if (wsum > 1e-6) {
      colors[q] = r / wsum;
      colors[q + 1] = g / wsum;
      colors[q + 2] = b / wsum;
      done[v] = 1;
    }
  }
  propagateColors(colors, done, adj);
  return colors;
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
