/**
 * Quick image diagnostics for the enhancement card: size, colour count,
 * pixel-art detection (few colours + hard edges, or a nearest-neighbour
 * pixel grid), edge acutance (blur) and JPEG 8 × 8 blockiness. A few tens of
 * milliseconds for a 1024² image; results are cached per image object.
 */
import type { RGBAImage } from '../types';
import { detectPixelGrid, reduceToGrid, type PixelGrid } from './pixelArt';
import { hasAlpha } from './alpha';
import { lumaOf } from './filters';

/** Longest side below which an image counts as small (suggest upscaling). */
export const SMALL_SIDE = 512;
/** Mean edge acutance below this counts as blurry. */
export const BLURRY_ACUTANCE = 0.3;
/** Boundary / interior gradient ratio above this counts as JPEG-blocky. */
export const BLOCKY_RATIO = 1.3;

export interface ImageAnalysis {
  width: number;
  height: number;
  maxSide: number;
  /** Distinct colours of the visible pixels (capped at COLOR_CAP + 1). */
  colors: number;
  /** Nearest-neighbour pixel grid (size 1 = none). */
  grid: PixelGrid;
  pixelArt: boolean;
  /** 0..1 mean steepness of edges (1 = one-pixel steps); null when there are too few edges. */
  acutance: number | null;
  blurry: boolean;
  /** Mean gradient on the JPEG 8 × 8 grid lines / elsewhere (1 = no blocks). */
  blockiness: number;
  jpegArtifacts: boolean;
  small: boolean;
  hasAlpha: boolean;
}

export const COLOR_CAP = 4096;

export function countColors(img: RGBAImage, cap = COLOR_CAP): number {
  const seen = new Set<number>();
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    seen.add(((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0);
    if (seen.size > cap) break;
  }
  return seen.size;
}

/**
 * Hard-edge statistics over horizontal / vertical neighbours of visible
 * pixels: the share of identical pairs and, among differing pairs, the share
 * of gentle steps (anti-aliasing, gradients) that pixel art lacks.
 */
function edgeStats(img: RGBAImage): { equal: number; soft: number } {
  const { width: w, height: h, data: d } = img;
  let pairs = 0, equal = 0, differ = 0, soft = 0;
  const check = (i: number, j: number) => {
    if (d[i + 3] === 0 && d[j + 3] === 0) return;
    pairs++;
    const m = Math.max(Math.abs(d[i] - d[j]), Math.abs(d[i + 1] - d[j + 1]), Math.abs(d[i + 2] - d[j + 2]), Math.abs(d[i + 3] - d[j + 3]));
    if (m === 0) equal++;
    else {
      differ++;
      if (m <= 24) soft++;
    }
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x + 1 < w) check(i, i + 4);
      if (y + 1 < h) check(i, i + w * 4);
    }
  return { equal: pairs ? equal / pairs : 0, soft: differ ? soft / differ : 0 };
}

/**
 * Mean edge acutance of luma (an edge-width measure): at every local peak of
 * the one-pixel gradient, the transition is followed both ways while the
 * gradient keeps its sign; acutance = peak step / whole transition. A crisp
 * edge scores 1, an anti-aliased one 0.5, an edge smeared over n px ~1/n.
 * Only transitions of at least `minRange` count.
 */
export function edgeAcutance(y: Float32Array, w: number, h: number, minRange = 48): number | null {
  let acc = 0, n = 0;
  const rowStep = Math.max(1, Math.floor(h / 384));
  const colStep = Math.max(1, Math.floor(w / 384));
  const d = new Float32Array(Math.max(w, h));
  const line = (get: (k: number) => number, len: number) => {
    for (let k = 0; k + 1 < len; k++) d[k] = get(k + 1) - get(k);
    for (let x = 1; x + 2 < len; x++) {
      const g = d[x];
      const a = Math.abs(g);
      if (a < 4 || a < Math.abs(d[x - 1]) || a <= Math.abs(d[x + 1])) continue;
      const sg = Math.sign(g);
      let l = x, r = x;
      while (l > 0 && x - l < 16 && Math.sign(d[l - 1]) === sg && Math.abs(d[l - 1]) > 0.5) l--;
      while (r + 1 < len - 1 && r - x < 16 && Math.sign(d[r + 1]) === sg && Math.abs(d[r + 1]) > 0.5) r++;
      const total = Math.abs(get(r + 1) - get(l));
      if (total < minRange) continue;
      acc += a / total;
      n++;
    }
  };
  for (let r = 0; r < h; r += rowStep) line((k) => y[r * w + k], w);
  for (let c = 0; c < w; c += colStep) line((k) => y[k * w + c], h);
  return n >= 32 ? acc / n : null;
}

/** Mean |horizontal + vertical luma step| on the 8-px grid lines divided by the mean elsewhere. */
export function blockiness(y: Float32Array, w: number, h: number): number {
  if (w < 32 || h < 32) return 1;
  let onGrid = 0, nOn = 0, off = 0, nOff = 0;
  for (let r = 0; r < h; r++)
    for (let x = 0; x + 1 < w; x++) {
      const s = Math.abs(y[r * w + x + 1] - y[r * w + x]);
      if (x % 8 === 7) { onGrid += s; nOn++; } else { off += s; nOff++; }
    }
  for (let r = 0; r + 1 < h; r++)
    for (let x = 0; x < w; x++) {
      const s = Math.abs(y[(r + 1) * w + x] - y[r * w + x]);
      if (r % 8 === 7) { onGrid += s; nOn++; } else { off += s; nOff++; }
    }
  const a = onGrid / Math.max(1, nOn), b = off / Math.max(1, nOff);
  if (a < 0.5) return 1; // nearly flat image: no evidence
  return a / Math.max(0.25, b);
}

export function analyzeImage(img: RGBAImage): ImageAnalysis {
  const { width: w, height: h } = img;
  const maxSide = Math.max(w, h);
  const colors = countColors(img);
  const grid = detectPixelGrid(img);
  let pixelArt = false;
  if (grid.size > 1) pixelArt = countColors(reduceToGrid(img, grid), 256) <= 256;
  else if (maxSide <= SMALL_SIDE && colors <= 64) {
    const e = edgeStats(img);
    pixelArt = e.equal >= 0.5 && e.soft < 0.15;
  }
  const y = lumaOf(img);
  const acutance = edgeAcutance(y, w, h);
  const blocks = grid.size > 1 ? 1 : blockiness(y, w, h);
  return {
    width: w,
    height: h,
    maxSide,
    colors,
    grid,
    pixelArt,
    acutance,
    blurry: !pixelArt && acutance !== null && acutance < BLURRY_ACUTANCE,
    blockiness: blocks,
    jpegArtifacts: !pixelArt && blocks > BLOCKY_RATIO,
    small: maxSide < SMALL_SIDE,
    hasAlpha: hasAlpha(img),
  };
}

const cache = new WeakMap<RGBAImage, ImageAnalysis>();

/** analyzeImage, memoised per image object. */
export function analyzeCached(img: RGBAImage): ImageAnalysis {
  let a = cache.get(img);
  if (!a) {
    a = analyzeImage(img);
    cache.set(img, a);
  }
  return a;
}
