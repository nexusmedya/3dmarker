/**
 * Depth map → triangle mesh in the shared frame: +Y up, +Z towards the
 * viewer, the longest image side spans 2 units, centred on the origin in X/Y,
 * UV (0,0) = image bottom-left.
 *
 * The depth is resampled onto a regular vertex grid (box-filtered when
 * shrinking, bilinear when enlarging, mask-aware so the background never
 * bleeds into the rim). Every grid cell is split along its shorter diagonal
 * in z; cells with exactly three foreground corners keep the one triangle
 * that avoids the background corner, which gives 45° silhouette edges
 * instead of staircases.
 *
 * Modes:
 *  - relief  front height field only (open surface), z = d·depthScale·2.
 *  - solid   front + flat back at z = -baseThickness·2 (the back reuses the
 *            front's triangulation, reversed) + vertical walls along every
 *            boundary edge (outline, holes, islands) → closed 2-manifold.
 *  - double  front + mirrored back joined by a rim wall. The front is lifted
 *            by rim/2 and the back is its mirror: z_front = d·depthScale·2 +
 *            rim/2, z_back = -z_front, with rim = baseThickness·2. So a
 *            silhouette-inflation depth (0 at the edge) becomes a pillow with
 *            a rim band of height `rim`, and ML depth a symmetric slab.
 * In the closed modes the front/back gap is at least MIN_THICKNESS so faces
 * never coincide, and "pinch" vertices (two surface wedges touching at one
 * grid vertex, e.g. across a one-pixel crack in the mask) are cut out so the
 * result is a true 2-manifold.
 *
 * Masked outlines are softened: outline vertices move up to 0.45 cell along
 * their boundary loop (rounding the grid's pixel staircase, UVs follow), and
 * in the closed modes the depth is smoothed along the rim. In double mode a
 * depth that falls to 0 just outside the outline (inflation) is taken to 0 on
 * it, so the rim band really is `rim` high, and the rim shades as one rounded
 * seam (front, wall and back share normals there).
 *
 * Front, back and walls use separate vertices (hard edges between them; wall
 * normals are smoothed along the outline except at corners ≥ 60°) and
 * geometry groups 0 = front, 1 = back, 2 = walls, so an array material can
 * style them separately (a single material ignores groups).
 */
import { BufferAttribute, BufferGeometry } from 'three';
import type { DepthMap, I18nText, Mask } from '../types';
import { LocalizedError } from '../errors';
import { blurFloat, resizeMask, sampleBilinear } from '../image/ops';
import type { DetailedDepth, DetailRegion, MeshMode, MeshOptions } from './options';

/** Thrown by buildGeometryFromDepth when a non-empty mask leaves no triangle on the grid. */
export const EMPTY_MESH: I18nText = {
  tr: 'Mesh boş çıktı: siluet bu çözünürlük için çok küçük ya da ince. "Çözünürlük" değerini artırın, "Siluet kalıplama (ekstrüzyon)" sürücüsünü deneyin ya da "Saydam alanları kes" seçeneğini kapatın.',
  en: 'The mesh came out empty: the silhouette is too small or thin for this resolution. Raise "Resolution", try the "Silhouette extrude" driver, or turn off "Cut transparent areas".',
};

/** Minimum front/back separation (scene units) in the closed modes. */
export const MIN_THICKNESS = 1e-3;
/** Upper bound for opts.resolution (memory guard). */
export const MAX_RESOLUTION = 2048;

export interface DepthMeshUserData {
  mode: MeshMode;
  gridWidth: number;
  gridHeight: number;
}

/** Vertex grid size: the longest side gets `resolution` vertices, the other side proportional (≥ 2). */
export function gridSize(width: number, height: number, resolution: number): [number, number] {
  const res = Math.max(2, Math.min(MAX_RESOLUTION, Math.round(resolution) || 2));
  if (width >= height) return [res, Math.max(2, Math.round(((res - 1) * height) / width) + 1)];
  return [Math.max(2, Math.round(((res - 1) * width) / height) + 1), res];
}

export interface DepthGrid {
  width: number;
  height: number;
  /** Raw depth per grid vertex (row-major, top row first). */
  depth: Float32Array;
  /** Foreground flag per grid vertex (majority vote over its footprint); null = no mask. */
  fg: Uint8Array | null;
}

/**
 * Resample `depth` (and `mask`) onto a gw × gh vertex grid whose corners sit
 * on the image corners. Depth is box-averaged over each vertex footprint when
 * the grid is coarser than the image and bilinear otherwise; with a mask only
 * foreground pixels contribute.
 */
export function sampleDepthGrid(depth: DepthMap, mask: Mask | null, gw: number, gh: number): DepthGrid {
  const { width: W, height: H, data } = depth;
  const m = mask ? (mask.width === W && mask.height === H ? mask.data : resizeMask(mask, W, H).data) : null;
  const fx = W / (gw - 1), fy = H / (gh - 1);
  const shrink = fx > 1.5 || fy > 1.5;
  const W1 = W + 1;

  // Summed-area tables: foreground counts, and (masked) depth sums.
  let satM: Int32Array | null = null;
  let satD: Float64Array | null = null;
  if (m) {
    satM = new Int32Array(W1 * (H + 1));
    for (let y = 0; y < H; y++) {
      let row = 0;
      for (let x = 0; x < W; x++) {
        if (m[y * W + x]) row++;
        satM[(y + 1) * W1 + x + 1] = satM[y * W1 + x + 1] + row;
      }
    }
  }
  if (shrink) {
    satD = new Float64Array(W1 * (H + 1));
    for (let y = 0; y < H; y++) {
      let row = 0;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const v = data[i];
        if (v === v && (!m || m[i])) row += v; // skip NaN and background
        satD[(y + 1) * W1 + x + 1] = satD[y * W1 + x + 1] + row;
      }
    }
  }

  // Footprint [x0, x1) × [y0, y1) of each grid column / row, in pixels.
  const bx0 = new Int32Array(gw), bx1 = new Int32Array(gw);
  const by0 = new Int32Array(gh), by1 = new Int32Array(gh);
  footprints(W, gw, fx, bx0, bx1);
  footprints(H, gh, fy, by0, by1);

  const out = new Float32Array(gw * gh);
  const fg = m ? new Uint8Array(gw * gh) : null;
  for (let j = 0; j < gh; j++) {
    const rows = by1[j] - by0[j];
    const y0 = by0[j] * W1, y1 = by1[j] * W1;
    for (let i = 0; i < gw; i++) {
      const x0 = bx0[i], x1 = bx1[i];
      const k = j * gw + i;
      let count = (x1 - x0) * rows;
      if (satM) {
        const c = satM[y1 + x1] - satM[y0 + x1] - satM[y1 + x0] + satM[y0 + x0];
        fg![k] = 2 * c >= count ? 1 : 0;
        count = c;
      }
      if (satD) {
        out[k] = count > 0 ? (satD[y1 + x1] - satD[y0 + x1] - satD[y1 + x0] + satD[y0 + x0]) / count : 0;
      } else {
        out[k] = m ? sampleMasked(data, m, W, H, i * fx, j * fy) : sampleBilinear(data, W, H, i * fx, j * fy);
      }
    }
  }
  return { width: gw, height: gh, depth: out, fg };
}

function footprints(size: number, n: number, f: number, lo: Int32Array, hi: Int32Array): void {
  const half = Math.max(0.5, f / 2);
  for (let i = 0; i < n; i++) {
    const p = i * f;
    const a = Math.min(size - 1, Math.max(0, Math.round(p - half)));
    lo[i] = a;
    hi[i] = Math.min(size, Math.max(a + 1, Math.round(p + half)));
  }
}

/** Bilinear sample using only foreground taps; falls back to plain bilinear if none. */
function sampleMasked(data: Float32Array, m: Uint8Array, W: number, H: number, x: number, y: number): number {
  const fx = Math.min(W - 1, Math.max(0, x - 0.5));
  const fy = Math.min(H - 1, Math.max(0, y - 0.5));
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = fx - ix, ty = fy - iy;
  const ix1 = Math.min(W - 1, ix + 1), iy1 = Math.min(H - 1, iy + 1);
  const a = iy * W + ix, b = iy * W + ix1, c = iy1 * W + ix, d = iy1 * W + ix1;
  const wa = (1 - tx) * (1 - ty) * m[a], wb = tx * (1 - ty) * m[b];
  const wc = (1 - tx) * ty * m[c], wd = tx * ty * m[d];
  const ws = wa + wb + wc + wd;
  if (ws < 1e-6) return sampleBilinear(data, W, H, x, y);
  return (data[a] * wa + data[b] * wb + data[c] * wc + data[d] * wd) / ws;
}

/** invert → clamp to [0,1] → gamma → masked smoothing (radius in grid cells). */
function shapeDepth(src: Float32Array, fg: Uint8Array | null, gw: number, gh: number, opts: MeshOptions): Float32Array {
  const out = new Float32Array(src.length);
  const gamma = opts.gamma > 0 ? opts.gamma : 1;
  for (let i = 0; i < src.length; i++) {
    let v = opts.invert ? 1 - src[i] : src[i];
    v = v >= 0 ? (v > 1 ? 1 : v) : 0; // also maps NaN to 0
    out[i] = gamma === 1 ? v : Math.pow(v, gamma);
  }
  if (opts.smoothing > 0) return blurFloat(out, gw, gh, opts.smoothing, 3, fg ? { width: gw, height: gh, data: fg } : null);
  return out;
}

/**
 * Build the mesh for a depth map (see the file comment for the modes and
 * frame). An all-background mask gives an empty geometry; a mask whose
 * foreground is too small or thin for the grid throws LocalizedError(EMPTY_MESH).
 */
export function buildGeometryFromDepth(depth: DepthMap, mask: Mask | null, opts: MeshOptions): BufferGeometry {
  const [gw, gh] = gridSize(depth.width, depth.height, opts.resolution);
  const grid = sampleDepthGrid(depth, opts.useMask ? mask : null, gw, gh);
  const fg = grid.fg;
  const d = shapeDepth(grid.depth, fg, gw, gh, opts);
  // Face / hand regions: unsmoothed full-resolution depth, refined grid (below).
  const detail = planDetail(depth, opts.useMask ? mask : null, gw, gh, opts);
  if (detail) sharpenDetail(d, gw, gh, detail);
  const mode = opts.mode;
  const closed = mode !== 'relief';

  // --- Triangulate into fixed slots (2 per quad) -----------------------------
  // Edge ids: horizontal (i,j)-(i+1,j) → j·qw+i; vertical (i,j)-(i,j+1) → nH + j·gw+i;
  // quad diagonal → nH + nV + quad (a quad only ever uses one diagonal).
  const qw = gw - 1, qh = gh - 1, nQuads = qw * qh;
  const nH = qw * gh, nV = gw * qh;
  const triV = new Int32Array(nQuads * 6);
  const triE = new Int32Array(nQuads * 6);
  const alive = new Uint8Array(nQuads * 2);
  const edgeUse = new Uint8Array(nH + nV + nQuads);
  const tear = mode === 'relief' && opts.discontinuity > 0 ? opts.discontinuity : Infinity;

  const put = (slot: number, a: number, b: number, c: number, eab: number, ebc: number, eca: number) => {
    if (tear !== Infinity) {
      const da = d[a], db = d[b], dc = d[c];
      if (Math.max(da, db, dc) - Math.min(da, db, dc) > tear) return;
    }
    const o = slot * 3;
    triV[o] = a; triV[o + 1] = b; triV[o + 2] = c;
    triE[o] = eab; triE[o + 1] = ebc; triE[o + 2] = eca;
    alive[slot] = 1;
    edgeUse[eab]++; edgeUse[ebc]++; edgeUse[eca]++;
  };

  for (let j = 0; j < qh; j++) {
    for (let i = 0; i < qw; i++) {
      const q = j * qw + i;
      const tl = j * gw + i, tr = tl + 1, bl = tl + gw, br = bl + 1;
      const top = q, bottom = q + qw, left = nH + tl, right = left + 1, diag = nH + nV + q;
      const bits = fg ? fg[tl] | (fg[tr] << 1) | (fg[bl] << 2) | (fg[br] << 3) : 15;
      // All triangles are CCW seen from +Z (image top = +Y).
      switch (bits) {
        case 15:
          if (Math.abs(d[tl] - d[br]) <= Math.abs(d[tr] - d[bl])) {
            put(2 * q, tl, bl, br, left, bottom, diag);
            put(2 * q + 1, tl, br, tr, diag, right, top);
          } else {
            put(2 * q, tl, bl, tr, left, diag, top);
            put(2 * q + 1, tr, bl, br, diag, bottom, right);
          }
          break;
        case 13: put(2 * q, tl, bl, br, left, bottom, diag); break; // no top-right
        case 11: put(2 * q + 1, tl, br, tr, diag, right, top); break; // no bottom-left
        case 14: put(2 * q + 1, tr, bl, br, diag, bottom, right); break; // no top-left
        case 7: put(2 * q, tl, bl, tr, left, diag, top); break; // no bottom-right
      }
    }
  }

  if (closed) removePinches(gw, gh, triV, triE, alive, edgeUse);
  // Soften the grid staircase of masked outlines: depth along the rim (closed
  // modes; a relief rim may be a torn cliff) and the outline's XY position.
  const outline = outlineOf(triV, triE, alive, edgeUse, gw * gh);
  if (mode === 'double') taperOutlineDepth(d, outline.deg, triV, alive, gw, gh);
  if (closed) smoothOutlineDepth(d, outline);
  const offset = tear === Infinity ? relaxOutline(outline, gw, gh, triV, alive) : null;

  // --- Compact: keep only referenced grid vertices ---------------------------
  const vmap = new Int32Array(gw * gh).fill(-1);
  let nTri = 0, nBnd = 0;
  for (let s = 0; s < alive.length; s++) {
    if (!alive[s]) continue;
    nTri++;
    const o = s * 3;
    vmap[triV[o]] = vmap[triV[o + 1]] = vmap[triV[o + 2]] = 0;
    for (let k = 0; k < 3; k++) if (edgeUse[triE[o + k]] === 1) nBnd++;
  }
  // The majority vote per grid vertex erases silhouettes thinner than about
  // 1.5 cells; say so rather than returning an invisible, empty model.
  if (nTri === 0 && fg && mask && mask.data.some((v) => v !== 0)) throw new LocalizedError(EMPTY_MESH);
  let nF = 0;
  for (let k = 0; k < vmap.length; k++) if (vmap[k] === 0) vmap[k] = nF++;

  // Front surface in grid coordinates (cells, outline offsets applied).
  let front: FrontMesh = {
    x: new Float64Array(nF), y: new Float64Array(nF), d: new Float64Array(nF),
    tri: new Int32Array(3 * nTri), bnd: new Int32Array(2 * nBnd),
  };
  for (let k = 0; k < vmap.length; k++) {
    const v = vmap[k];
    if (v < 0) continue;
    const i = k % gw, j = (k - i) / gw;
    front.x[v] = offset ? i + offset[2 * k] : i;
    front.y[v] = offset ? j + offset[2 * k + 1] : j;
    front.d[v] = d[k];
  }
  // Boundary edge p→q with the interior on its left seen from +Z (wall order = slot order).
  for (let s = 0, t = 0, b = 0; s < alive.length; s++) {
    if (!alive[s]) continue;
    const o = s * 3;
    front.tri[t++] = vmap[triV[o]]; front.tri[t++] = vmap[triV[o + 1]]; front.tri[t++] = vmap[triV[o + 2]];
    for (let k = 0; k < 3; k++) {
      if (edgeUse[triE[o + k]] !== 1) continue;
      front.bnd[b++] = vmap[triV[o + k]];
      front.bnd[b++] = vmap[triV[o + ((k + 1) % 3)]];
    }
  }
  if (detail && detail.levels > 0) front = refineFront(front, detail);
  nF = front.x.length;
  nTri = front.tri.length / 3;
  const nWall = closed ? front.bnd.length / 2 : 0;

  // --- Vertex buffers --------------------------------------------------------
  const nVerts = closed ? 2 * nF + 4 * nWall : nF;
  const nIdx = closed ? 6 * nTri + 6 * nWall : 3 * nTri;
  const pos = new Float32Array(nVerts * 3);
  const uv = new Float32Array(nVerts * 2);
  const idx = nVerts > 65535 ? new Uint32Array(nIdx) : new Uint16Array(nIdx);

  const L = Math.max(depth.width, depth.height);
  const hw = depth.width / L, hh = depth.height / L;
  const sx = (2 * hw) / qw, sy = (2 * hh) / qh;
  const S = Math.max(0, opts.depthScale * 2);
  const gap = Math.max(opts.baseThickness * 2, MIN_THICKNESS);
  const lift = mode === 'double' ? gap / 2 : 0;
  const zBase = -gap; // solid back plane

  for (let v = 0; v < nF; v++) {
    const i = front.x[v], j = front.y[v];
    const x = -hw + i * sx, y = hh - j * sy, z = front.d[v] * S + lift;
    const u = i / qw, t = 1 - j / qh;
    pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
    uv[v * 2] = u; uv[v * 2 + 1] = t;
    if (closed) {
      const b = v + nF;
      pos[b * 3] = x; pos[b * 3 + 1] = y; pos[b * 3 + 2] = mode === 'solid' ? zBase : -z;
      uv[b * 2] = u; uv[b * 2 + 1] = t;
    }
  }

  // --- Indices: front, back (reversed), walls --------------------------------
  const ft = front.tri;
  idx.set(ft, 0);
  let n = ft.length;
  let wallEnds: Int32Array | null = null; // front vertex ids (p, q) of each wall quad
  if (closed) {
    for (let t = 0; t < ft.length; t += 3) {
      idx[n++] = ft[t] + nF; idx[n++] = ft[t + 2] + nF; idx[n++] = ft[t + 1] + nF;
    }
    // Boundary edge p→q: quad pF, qF, pB, qB facing outwards.
    wallEnds = front.bnd;
    for (let e = 0, w = 2 * nF; e < nWall; e++, w += 4) {
      const p = wallEnds[2 * e], q = wallEnds[2 * e + 1];
      copyVertex(pos, uv, p, w);
      copyVertex(pos, uv, q, w + 1);
      copyVertex(pos, uv, p + nF, w + 2);
      copyVertex(pos, uv, q + nF, w + 3);
      idx[n++] = w; idx[n++] = w + 2; idx[n++] = w + 3;
      idx[n++] = w; idx[n++] = w + 3; idx[n++] = w + 1;
    }
  }

  const normals = vertexNormals(pos, idx);
  if (wallEnds) smoothWallNormals(pos, normals, wallEnds, nF, 2 * nF);
  if (wallEnds && mode === 'double') roundDoubleRim(pos, normals, wallEnds, nF, 2 * nF, gap);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uv, 2));
  geometry.setIndex(new BufferAttribute(idx, 1));
  geometry.addGroup(0, 3 * nTri, 0);
  if (closed) {
    geometry.addGroup(3 * nTri, 3 * nTri, 1);
    if (nWall > 0) geometry.addGroup(6 * nTri, 6 * nWall, 2);
  }
  const userData: DepthMeshUserData = { mode, gridWidth: gw, gridHeight: gh };
  geometry.userData = userData;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Front surface in grid coordinates before it becomes buffers. */
interface FrontMesh {
  /** Vertex position (grid cells, fractional after outline relaxing / refinement) and shaped depth. */
  x: Float64Array;
  y: Float64Array;
  d: Float64Array;
  /** CCW triangles seen from +Z. */
  tri: Int32Array;
  /** Boundary edges p→q (interior on the left), one wall quad each in the closed modes. */
  bnd: Int32Array;
}

/**
 * Target vertex spacing inside detail regions: 1/DETAIL_CELLS_PER_REGION of
 * the smallest region's longest side (a finger is ~1/8 of a hand box, so a
 * finger gets about 7 vertices across), but never below DETAIL_SPACING_PX
 * depth-map pixels. For a finger 8 px wide: ~95 % of its ridge height
 * survives at 1.25 px spacing, ~80 % at 2 px, ~3 % at the default grid.
 */
export const DETAIL_SPACING_PX = 1.25;
const DETAIL_CELLS_PER_REGION = 56;
/** At most this many halvings of the grid spacing inside detail regions. */
export const DETAIL_MAX_LEVELS = 3;
/** Budget of extra triangles for the refinement (the level count drops until it fits). */
export const DETAIL_TRIANGLE_BUDGET = 250_000;
/** Detail weight fades from 1 on a region box to 0 this many grid cells outside it. */
const DETAIL_FEATHER = 2;
/** At most this many regions (largest first). */
const DETAIL_MAX_REGIONS = 16;

interface DetailPlan {
  /** Region boxes in grid cells [x0, y0, x1, y1]. */
  boxes: number[][];
  /** Grid-spacing halvings inside the regions (0 = only unsmoothed sampling). */
  levels: number;
  /** Detail weight in [0, 1] at grid position (x, y). */
  weight: (x: number, y: number) => number;
  /** Shaped full-resolution depth at grid position (x, y). */
  sample: (x: number, y: number) => number;
}

/** Valid detail regions of a depth map, clamped to it, largest first. */
export function detailRegionsOf(depth: DepthMap): DetailRegion[] {
  const list = (depth as DepthMap & DetailedDepth).detail;
  if (!Array.isArray(list)) return [];
  const out: DetailRegion[] = [];
  for (const r of list) {
    if (!r || !(r.width > 0) || !(r.height > 0) || !Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
    const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
    const x1 = Math.min(depth.width, r.x + r.width), y1 = Math.min(depth.height, r.y + r.height);
    if (x1 - x0 < 1 || y1 - y0 < 1) continue;
    out.push({ kind: r.kind, x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }
  return out.sort((a, b) => b.width * b.height - a.width * a.height).slice(0, DETAIL_MAX_REGIONS);
}

function planDetail(depth: DepthMap, mask: Mask | null, gw: number, gh: number, opts: MeshOptions): DetailPlan | null {
  const regions = detailRegionsOf(depth);
  if (regions.length === 0) return null;
  const { width: W, height: H, data } = depth;
  const fx = W / (gw - 1), fy = H / (gh - 1);
  const boxes = regions.map((r) => [r.x / fx, r.y / fy, (r.x + r.width) / fx, (r.y + r.height) / fy]);
  const weight = (x: number, y: number): number => {
    let best = 0;
    for (const [x0, y0, x1, y1] of boxes) {
      const dx = Math.max(x0 - x, 0, x - x1), dy = Math.max(y0 - y, 0, y - y1);
      if (dx === 0 && dy === 0) return 1;
      const t = 1 - Math.hypot(dx, dy) / DETAIL_FEATHER;
      if (t > best) best = t;
    }
    return best * best * (3 - 2 * best);
  };
  const m = mask ? (mask.width === W && mask.height === H ? mask.data : resizeMask(mask, W, H).data) : null;
  const gamma = opts.gamma > 0 ? opts.gamma : 1;
  const sample = (x: number, y: number): number => {
    const px = x * fx, py = y * fy;
    let v = m ? sampleMasked(data, m, W, H, px, py) : sampleBilinear(data, W, H, px, py);
    if (opts.invert) v = 1 - v;
    v = v >= 0 ? (v > 1 ? 1 : v) : 0;
    return gamma === 1 ? v : Math.pow(v, gamma);
  };
  // Halvings until the spacing reaches DETAIL_SPACING_PX, within the triangle budget
  // (each level quadruples the triangles of the refined cells).
  const spacing = Math.max(DETAIL_SPACING_PX, Math.min(...regions.map((r) => Math.max(r.width, r.height))) / DETAIL_CELLS_PER_REGION);
  let levels = Math.max(0, Math.min(DETAIL_MAX_LEVELS, Math.ceil(Math.log2(Math.max(fx, fy) / spacing))));
  let cells = 0;
  for (const [x0, y0, x1, y1] of boxes) cells += (x1 - x0 + 2 * DETAIL_FEATHER) * (y1 - y0 + 2 * DETAIL_FEATHER);
  while (levels > 0 && 2 * cells * (4 ** levels - 1) > DETAIL_TRIANGLE_BUDGET) levels--;
  return { boxes, levels, weight, sample };
}

/** Inside detail regions, replace the box-filtered, smoothed grid depth by the full-resolution depth (feathered). */
function sharpenDetail(d: Float32Array, gw: number, gh: number, plan: DetailPlan): void {
  for (const [x0, y0, x1, y1] of plan.boxes) {
    const i0 = Math.max(0, Math.floor(x0 - DETAIL_FEATHER)), i1 = Math.min(gw - 1, Math.ceil(x1 + DETAIL_FEATHER));
    const j0 = Math.max(0, Math.floor(y0 - DETAIL_FEATHER)), j1 = Math.min(gh - 1, Math.ceil(y1 + DETAIL_FEATHER));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * gw + i;
        const w = plan.weight(i, j);
        // Overlapping boxes visit a vertex twice: the second pass sees the sharpened value and keeps it.
        if (w > 0) d[k] += w * (plan.sample(i, j) - d[k]);
      }
    }
  }
}

/**
 * Halve the edges of every triangle whose centroid lies in a detail region,
 * `plan.levels` times (1 → 4 split; neighbours with one or two split edges
 * are bisected / split in three, so the surface stays crack-free and a
 * closed mesh stays closed). A new vertex on an interior edge takes the
 * full-resolution depth (weighted towards the edge's mean by the detail
 * weight); on a boundary edge it takes the mean, keeping the smoothed outline.
 * Boundary edges are split along, so walls follow.
 */
function refineFront(src: FrontMesh, plan: DetailPlan): FrontMesh {
  const x = Array.from(src.x), y = Array.from(src.y), d = Array.from(src.d);
  let tri = Array.from(src.tri), bnd = Array.from(src.bnd);
  const K = 2 ** 26;
  const key = (a: number, b: number) => (a < b ? a * K + b : b * K + a);
  let border = new Set<number>();
  for (let e = 0; e < bnd.length; e += 2) border.add(key(bnd[e], bnd[e + 1]));

  for (let level = 0; level < plan.levels; level++) {
    const mid = new Map<number, number>();
    const nextBorder = new Set<number>();
    const split = (a: number, b: number) => {
      const k = key(a, b);
      if (mid.has(k)) return;
      const mx = (x[a] + x[b]) / 2, my = (y[a] + y[b]) / 2, mean = (d[a] + d[b]) / 2;
      const id = x.length;
      x.push(mx); y.push(my);
      if (border.has(k)) {
        d.push(mean);
        nextBorder.add(key(a, id)).add(key(id, b));
      } else d.push(mean + plan.weight(mx, my) * (plan.sample(mx, my) - mean));
      mid.set(k, id);
    };
    for (let t = 0; t < tri.length; t += 3) {
      const a = tri[t], b = tri[t + 1], c = tri[t + 2];
      if (plan.weight((x[a] + x[b] + x[c]) / 3, (y[a] + y[b] + y[c]) / 3) <= 0) continue;
      split(a, b); split(b, c); split(c, a);
    }
    if (mid.size === 0) break;
    const out: number[] = [];
    const len2 = (p: number, q: number) => (x[p] - x[q]) ** 2 + (y[p] - y[q]) ** 2;
    for (let t = 0; t < tri.length; t += 3) {
      let a = tri[t], b = tri[t + 1], c = tri[t + 2];
      let ab = mid.get(key(a, b)), bc = mid.get(key(b, c)), ca = mid.get(key(c, a));
      const n = +(ab !== undefined) + +(bc !== undefined) + +(ca !== undefined);
      if (n === 0) { out.push(a, b, c); continue; }
      if (n === 3) {
        out.push(a, ab!, ca!, ab!, b, bc!, ca!, bc!, c, ab!, bc!, ca!);
        continue;
      }
      // Rotate (keeping the winding) so that ab is split and, for two splits, bc too.
      for (let r = 0; r < 3 && !(ab !== undefined && (n === 1 || bc !== undefined)); r++) {
        [a, b, c] = [b, c, a];
        [ab, bc, ca] = [bc, ca, ab];
      }
      if (n === 1) {
        out.push(a, ab!, c, ab!, b, c);
      } else {
        out.push(ab!, b, bc!);
        // Quad a, ab, bc, c: cut along the shorter diagonal.
        if (len2(a, bc!) <= len2(ab!, c)) out.push(a, ab!, bc!, a, bc!, c);
        else out.push(a, ab!, c, ab!, bc!, c);
      }
    }
    tri = out;
    const nb: number[] = [];
    for (let e = 0; e < bnd.length; e += 2) {
      const p = bnd[e], q = bnd[e + 1], m = mid.get(key(p, q));
      if (m === undefined) nb.push(p, q);
      else nb.push(p, m, m, q);
    }
    bnd = nb;
    for (const k of border) if (!mid.has(k)) nextBorder.add(k);
    border = nextBorder;
  }
  return {
    x: Float64Array.from(x), y: Float64Array.from(y), d: Float64Array.from(d),
    tri: Int32Array.from(tri), bnd: Int32Array.from(bnd),
  };
}

function copyVertex(pos: Float32Array, uv: Float32Array, from: number, to: number): void {
  pos[to * 3] = pos[from * 3]; pos[to * 3 + 1] = pos[from * 3 + 1]; pos[to * 3 + 2] = pos[from * 3 + 2];
  uv[to * 2] = uv[from * 2]; uv[to * 2 + 1] = uv[from * 2 + 1];
}

/**
 * A grid vertex where two separate triangle fans ("wedges") meet has more
 * than two boundary edges and would make the closed mesh non-manifold. Keep
 * the largest wedge around such a vertex, drop the others, and repeat for
 * vertices that become pinches in turn.
 */
function removePinches(
  gw: number, gh: number,
  triV: Int32Array, triE: Int32Array, alive: Uint8Array, edgeUse: Uint8Array,
): void {
  const qw = gw - 1, qh = gh - 1;
  const bInc = new Uint8Array(gw * gh);
  for (let s = 0; s < alive.length; s++) {
    if (!alive[s]) continue;
    const o = s * 3;
    for (let k = 0; k < 3; k++) {
      if (edgeUse[triE[o + k]] !== 1) continue;
      bInc[triV[o + k]]++;
      bInc[triV[o + ((k + 1) % 3)]]++;
    }
  }
  const stack: number[] = [];
  for (let v = 0; v < bInc.length; v++) if (bInc[v] > 2) stack.push(v);

  const kill = (s: number) => {
    alive[s] = 0;
    const o = s * 3;
    for (let k = 0; k < 3; k++) {
      const e = triE[o + k];
      const a = triV[o + k], b = triV[o + ((k + 1) % 3)];
      const before = edgeUse[e]--;
      const delta = before === 2 ? 1 : -1; // 2→1 becomes boundary, 1→0 disappears
      bInc[a] += delta; bInc[b] += delta;
      if (bInc[a] > 2) stack.push(a);
      if (bInc[b] > 2) stack.push(b);
    }
  };

  // Triangles around the current vertex, their two edges touching it, and wedge labels.
  const fan: number[] = [], ea: number[] = [], eb: number[] = [], label: number[] = [], size: number[] = [];
  while (stack.length) {
    const v = stack.pop()!;
    if (bInc[v] <= 2) continue;
    fan.length = ea.length = eb.length = 0;
    const i = v % gw, j = (v - i) / gw;
    for (let qj = Math.max(0, j - 1); qj <= Math.min(qh - 1, j); qj++) {
      for (let qi = Math.max(0, i - 1); qi <= Math.min(qw - 1, i); qi++) {
        for (let s = 2 * (qj * qw + qi), e = s + 2; s < e; s++) {
          if (!alive[s]) continue;
          const o = s * 3;
          const k = triV[o] === v ? 0 : triV[o + 1] === v ? 1 : triV[o + 2] === v ? 2 : -1;
          if (k < 0) continue;
          fan.push(s); ea.push(triE[o + k]); eb.push(triE[o + ((k + 2) % 3)]);
        }
      }
    }
    // Flood-fill wedges: triangles sharing an edge at v belong together.
    label.length = size.length = 0;
    for (let t = 0; t < fan.length; t++) label.push(-1);
    for (let t = 0; t < fan.length; t++) {
      if (label[t] >= 0) continue;
      const id = size.length;
      size.push(0);
      const todo = [t];
      label[t] = id;
      while (todo.length) {
        const a = todo.pop()!;
        size[id]++;
        for (let b = 0; b < fan.length; b++) {
          if (label[b] < 0 && (ea[a] === ea[b] || ea[a] === eb[b] || eb[a] === ea[b] || eb[a] === eb[b])) {
            label[b] = id;
            todo.push(b);
          }
        }
      }
    }
    let keep = size.length > 1 ? 0 : -1; // -1 (should not happen): drop the whole fan
    for (let w = 1; w < size.length; w++) if (size[w] > size[keep]) keep = w;
    for (let t = 0; t < fan.length; t++) if (label[t] !== keep) kill(fan[t]);
  }
}

/** Boundary loops: each grid vertex's first two outline neighbours and its outline edge count. */
interface Outline {
  nb: Int32Array;
  deg: Uint8Array;
  /** Vertices with exactly two outline edges (a simple point on a loop). */
  verts: number[];
}

function outlineOf(triV: Int32Array, triE: Int32Array, alive: Uint8Array, edgeUse: Uint8Array, nGrid: number): Outline {
  const nb = new Int32Array(nGrid * 2).fill(-1);
  const deg = new Uint8Array(nGrid);
  const link = (v: number, u: number) => {
    if (deg[v] < 2) nb[2 * v + deg[v]] = u;
    if (deg[v] < 255) deg[v]++;
  };
  for (let s = 0; s < alive.length; s++) {
    if (!alive[s]) continue;
    const o = s * 3;
    for (let k = 0; k < 3; k++) {
      if (edgeUse[triE[o + k]] !== 1) continue;
      const a = triV[o + k], b = triV[o + ((k + 1) % 3)];
      link(a, b);
      link(b, a);
    }
  }
  const verts: number[] = [];
  for (let v = 0; v < nGrid; v++) if (deg[v] === 2) verts.push(v);
  return { nb, deg, verts };
}

/** Smoothing passes along the outline (1-2-1 kernel). */
const OUTLINE_SMOOTH_PASSES = 4;
/** Largest XY move of an outline vertex, in grid cells (keeps every triangle's orientation). */
const OUTLINE_MAX_SHIFT = 0.45;

/**
 * The outline follows the grid in steps, so outline vertices sit at varying
 * distances from the true silhouette. Where the depth rises steeply at the
 * edge (an inflated balloon has a vertical side there) that turns into a
 * comb of alternating heights along the rim. Smoothing the depth along each
 * boundary loop removes that grid-frequency noise and keeps the slow
 * variation along the rim.
 */
function smoothOutlineDepth(d: Float32Array, { nb, verts }: Outline): void {
  const next = new Float32Array(verts.length);
  for (let pass = 0; pass < OUTLINE_SMOOTH_PASSES; pass++) {
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      next[i] = 0.25 * d[nb[2 * v]] + 0.5 * d[v] + 0.25 * d[nb[2 * v + 1]];
    }
    for (let i = 0; i < verts.length; i++) d[verts[i]] = next[i];
  }
}

/** Extrapolated edge distance (cells) up to which an outline vertex counts as the silhouette itself… */
const TAPER_NEAR = 10;
/** …and from which its depth is kept (a slab edge, e.g. ML depth). */
const TAPER_FAR = 20;

/**
 * Double mode: the outline vertex sits up to a cell inside the silhouette and
 * the grid sampling / blur average in interior depth, so an inflated balloon
 * (depth ∝ √distance, steep at the edge) keeps ~15 % of its height on the
 * outline and front and back meet in a tall, stepped wall. Extrapolate the
 * depth outwards along its steepest inward rise (to the highest interior
 * neighbour): if it reaches 0 within TAPER_NEAR cells the outline vertex
 * stands in for the silhouette and gets depth 0; from TAPER_FAR on (flat or
 * slowly falling depth) it is left alone, smoothstep in between.
 */
function taperOutlineDepth(d: Float32Array, deg: Uint8Array, triV: Int32Array, alive: Uint8Array, gw: number, gh: number): void {
  const used = new Uint8Array(gw * gh);
  for (let s = 0; s < alive.length; s++) {
    if (!alive[s]) continue;
    const o = s * 3;
    used[triV[o]] = used[triV[o + 1]] = used[triV[o + 2]] = 1;
  }
  const next = new Float32Array(d.length);
  const changed: number[] = [];
  for (let v = 0; v < deg.length; v++) {
    if (!deg[v]) continue;
    const i = v % gw, j = (v - i) / gw;
    const dOut = d[v];
    let rise = 0; // largest depth gain per cell towards an interior neighbour
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const x = i + di, y = j + dj;
        if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
        const u = y * gw + x;
        if (used[u] && !deg[u]) rise = Math.max(rise, (d[u] - dOut) / (di && dj ? Math.SQRT2 : 1));
      }
    }
    if (!(rise > 1e-6)) continue; // flat, falling inwards, or a thin strip without interior
    const t = Math.min(1, Math.max(0, (TAPER_FAR - dOut / rise) / (TAPER_FAR - TAPER_NEAR)));
    next[v] = dOut * (1 - t * t * (3 - 2 * t));
    changed.push(v);
  }
  for (const v of changed) d[v] = next[v];
}

/**
 * Per-vertex XY offsets (grid cells, [di, dj] per grid vertex) that round off
 * the outline's pixel staircase — the 90° notches left by cells with two
 * foreground corners show up as ribs on the walls and a saw-tooth silhouette.
 * Outline vertices move towards their loop neighbours (1-2-1 passes, at most
 * OUTLINE_MAX_SHIFT); vertices on the image border stay put so a full-frame
 * relief keeps its rectangle. Any triangle that would flip or collapse gets
 * its vertices restored. Null when nothing moves.
 */
function relaxOutline({ nb, verts }: Outline, gw: number, gh: number, triV: Int32Array, alive: Uint8Array): Float32Array | null {
  const movable = verts.filter((v) => {
    const i = v % gw, j = (v - i) / gw;
    return i > 0 && j > 0 && i < gw - 1 && j < gh - 1;
  });
  if (movable.length === 0) return null;
  const px = new Float32Array(gw * gh), py = new Float32Array(gw * gh);
  for (let v = 0; v < px.length; v++) {
    px[v] = v % gw;
    py[v] = (v - px[v]) / gw;
  }
  const nx = new Float32Array(movable.length), ny = new Float32Array(movable.length);
  for (let pass = 0; pass < OUTLINE_SMOOTH_PASSES; pass++) {
    for (let m = 0; m < movable.length; m++) {
      const v = movable[m], a = nb[2 * v], b = nb[2 * v + 1];
      nx[m] = 0.25 * px[a] + 0.5 * px[v] + 0.25 * px[b];
      ny[m] = 0.25 * py[a] + 0.5 * py[v] + 0.25 * py[b];
    }
    for (let m = 0; m < movable.length; m++) {
      const v = movable[m];
      const i = v % gw, j = (v - i) / gw;
      let dx = nx[m] - i, dy = ny[m] - j;
      const l = Math.hypot(dx, dy);
      if (l > OUTLINE_MAX_SHIFT) {
        dx *= OUTLINE_MAX_SHIFT / l;
        dy *= OUTLINE_MAX_SHIFT / l;
      }
      px[v] = i + dx;
      py[v] = j + dy;
    }
  }
  const off = new Float32Array(gw * gh * 2);
  for (const v of movable) {
    off[2 * v] = px[v] - (v % gw);
    off[2 * v + 1] = py[v] - Math.floor(v / gw);
  }
  // Guard: restore the vertices of any triangle that flipped or got too thin.
  const area = (a: number, b: number, c: number, o: Float32Array | null) => {
    const ax = (a % gw) + (o ? o[2 * a] : 0), ay = Math.floor(a / gw) + (o ? o[2 * a + 1] : 0);
    const bx = (b % gw) + (o ? o[2 * b] : 0), by = Math.floor(b / gw) + (o ? o[2 * b + 1] : 0);
    const cx = (c % gw) + (o ? o[2 * c] : 0), cy = Math.floor(c / gw) + (o ? o[2 * c + 1] : 0);
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  };
  for (let round = 0, changed = true; changed && round < 8; round++) {
    changed = false;
    for (let s = 0; s < alive.length; s++) {
      if (!alive[s]) continue;
      const o = s * 3;
      const a = triV[o], b = triV[o + 1], c = triV[o + 2];
      if (off[2 * a] === 0 && off[2 * a + 1] === 0 && off[2 * b] === 0 && off[2 * b + 1] === 0 && off[2 * c] === 0 && off[2 * c + 1] === 0) continue;
      const before = area(a, b, c, null), after = area(a, b, c, off);
      if (after * Math.sign(before) >= 0.1 * Math.abs(before)) continue;
      for (const v of [a, b, c]) off[2 * v] = off[2 * v + 1] = 0;
      changed = true;
    }
  }
  return off;
}

/**
 * Adjacent walls turning by less than 60° share a smoothed normal (hides the
 * grid's 45° stair-step facets); sharper turns stay hard corners. Compared
 * against the averaged normal, which sits halfway (30°) between the two.
 */
const WALL_CREASE_COS = Math.cos((30 * Math.PI) / 180);

/**
 * Wall quads have their own vertices, so their normals come out flat and a
 * grid-stepped outline (axis-aligned and 45° edges) shades as ribs. Give each
 * wall corner the average outward direction of the two walls meeting there,
 * unless they meet at a real corner (turn ≥ 60°). Walls are vertical: normals stay in XY.
 */
function smoothWallNormals(pos: Float32Array, nrm: Float32Array, ends: Int32Array, nF: number, firstWall: number): void {
  const acc = new Float32Array(nF * 2);
  const nWall = ends.length / 2;
  const edgeN = new Float32Array(nWall * 2);
  for (let e = 0; e < nWall; e++) {
    const p = ends[2 * e], q = ends[2 * e + 1];
    // Outward normal of p→q with the interior on its left: (dy, -dx), length-weighted.
    const nx = pos[q * 3 + 1] - pos[p * 3 + 1], ny = -(pos[q * 3] - pos[p * 3]);
    const l = Math.hypot(nx, ny) || 1;
    edgeN[2 * e] = nx / l; edgeN[2 * e + 1] = ny / l;
    acc[2 * p] += nx; acc[2 * p + 1] += ny;
    acc[2 * q] += nx; acc[2 * q + 1] += ny;
  }
  for (let e = 0; e < nWall; e++) {
    const ex = edgeN[2 * e], ey = edgeN[2 * e + 1];
    for (let side = 0; side < 2; side++) {
      const v = ends[2 * e + side];
      let ax = acc[2 * v], ay = acc[2 * v + 1];
      const l = Math.hypot(ax, ay);
      if (l > 0 && (ax * ex + ay * ey) / l >= WALL_CREASE_COS) { ax /= l; ay /= l; } else { ax = ex; ay = ey; }
      // Quad layout: w = pF, w+1 = qF, w+2 = pB, w+3 = qB.
      for (const o of [side, side + 2]) {
        const k = (firstWall + 4 * e + o) * 3;
        nrm[k] = ax; nrm[k + 1] = ay; nrm[k + 2] = 0;
      }
    }
  }
}

/**
 * Double mode: front, wall and back have separate vertices, so the rim shades
 * as two hard creases. Where the rim is thin (the front outline at most one
 * rim height above the seam, fading out by two), give the front outline
 * vertex and the wall's top the same normal, halfway between the front
 * surface and the horizontal wall direction, and mirror it for the back and
 * the wall's bottom: the rim reads as one rounded seam.
 */
function roundDoubleRim(pos: Float32Array, nrm: Float32Array, ends: Int32Array, nF: number, firstWall: number, rim: number): void {
  const nWall = ends.length / 2;
  const acc = new Float32Array(nF * 2);
  for (let e = 0; e < nWall; e++) {
    for (let side = 0; side < 2; side++) {
      const k = (firstWall + 4 * e + side) * 3, v = ends[2 * e + side];
      acc[2 * v] += nrm[k]; acc[2 * v + 1] += nrm[k + 1];
    }
  }
  const seam = new Float32Array(nF * 3);
  const done = new Uint8Array(nF);
  for (let e = 0; e < nWall; e++) {
    for (let side = 0; side < 2; side++) {
      const v = ends[2 * e + side];
      const w = Math.min(1, Math.max(0, 2 - pos[v * 3 + 2] / rim));
      if (w <= 0) continue;
      if (!done[v]) {
        done[v] = 1;
        const hl = Math.hypot(acc[2 * v], acc[2 * v + 1]) || 1;
        const hx = acc[2 * v] / hl, hy = acc[2 * v + 1] / hl;
        const f = v * 3;
        let sx = hx + nrm[f], sy = hy + nrm[f + 1], sz = nrm[f + 2];
        const sl = Math.hypot(sx, sy, sz) || 1;
        sx /= sl; sy /= sl; sz /= sl;
        seam[f] = sx; seam[f + 1] = sy; seam[f + 2] = sz;
        setNormal(nrm, v, nrm[f] + (sx - nrm[f]) * w, nrm[f + 1] + (sy - nrm[f + 1]) * w, nrm[f + 2] + (sz - nrm[f + 2]) * w, 1);
        setNormal(nrm, v + nF, nrm[f], nrm[f + 1], nrm[f + 2], -1);
      }
      const f = v * 3;
      for (const o of [side, side + 2]) {
        const k = firstWall + 4 * e + o, kk = k * 3;
        setNormal(nrm, k, nrm[kk] + (seam[f] - nrm[kk]) * w, nrm[kk + 1] + (seam[f + 1] - nrm[kk + 1]) * w, seam[f + 2] * w, o < 2 ? 1 : -1);
      }
    }
  }
}

/** Store the normalised (x, y, z·zSign) as vertex v's normal. */
function setNormal(nrm: Float32Array, v: number, x: number, y: number, z: number, zSign: number): void {
  const l = Math.hypot(x, y, z) || 1;
  nrm[v * 3] = x / l; nrm[v * 3 + 1] = y / l; nrm[v * 3 + 2] = (z * zSign) / l;
}

/** Area-weighted smooth vertex normals (per part, since parts don't share vertices). */
function vertexNormals(pos: Float32Array, idx: Uint16Array | Uint32Array): Float32Array {
  const nrm = new Float32Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const abx = pos[b] - pos[a], aby = pos[b + 1] - pos[a + 1], abz = pos[b + 2] - pos[a + 2];
    const acx = pos[c] - pos[a], acy = pos[c + 1] - pos[a + 1], acz = pos[c + 2] - pos[a + 2];
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz;
    nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz;
    nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz;
  }
  for (let i = 0; i < nrm.length; i += 3) {
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]);
    if (l > 0) { nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l; } else nrm[i + 2] = 1;
  }
  return nrm;
}
