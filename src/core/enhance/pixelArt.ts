/**
 * Pixel-art aware upscaling: detection of a nearest-neighbour pixel grid
 * (sprites that were already blown up k×), reduction back to one sample per
 * art pixel, and the EPX / Scale2x and AdvMAME3x / Scale3x edge-directed
 * scalers, which round diagonal staircases without inventing new colours.
 * Pixels are compared as whole RGBA words, so transparency stays crisp.
 */
import type { RGBAImage } from '../types';

/** A pixel grid: art pixels are `size` × `size` blocks starting at (offsetX, offsetY). */
export interface PixelGrid {
  size: number;
  offsetX: number;
  offsetY: number;
}

/** Aligned 32-bit view of an image's pixels (always a copy). */
function words(img: RGBAImage): Uint32Array {
  const buf = new Uint8Array(img.width * img.height * 4);
  buf.set(img.data);
  return new Uint32Array(buf.buffer);
}

function fromWords(px: Uint32Array, width: number, height: number): RGBAImage {
  return { width, height, data: new Uint8ClampedArray(px.buffer, px.byteOffset, width * height * 4) };
}

/** Channels differ by more than `tol` (JPEG-tolerant pixel equality). */
function differs(d: Uint8ClampedArray, i: number, j: number, tol: number): boolean {
  return (
    Math.abs(d[i] - d[j]) > tol ||
    Math.abs(d[i + 1] - d[j + 1]) > tol ||
    Math.abs(d[i + 2] - d[j + 2]) > tol ||
    Math.abs(d[i + 3] - d[j + 3]) > tol
  );
}

/**
 * Block size and phase along one axis from the positions where neighbouring
 * pixels change: in a k× nearest-neighbour upscale every change falls on the
 * same phase modulo k. Returns [1, 0] when no grid is evident.
 */
function axisGrid(changes: Int32Array, len: number, maxBlock: number): [number, number] {
  let total = 0;
  for (let i = 0; i < len; i++) total += changes[i];
  if (total < 24) return [1, 0];
  for (let k = maxBlock; k >= 2; k--) {
    const hist = new Float64Array(k);
    for (let i = 0; i < len; i++) if (changes[i]) hist[i % k] += changes[i];
    let best = 0;
    for (let p = 1; p < k; p++) if (hist[p] > hist[best]) best = p;
    if (hist[best] >= 0.97 * total) return [k, best];
  }
  return [1, 0];
}

/**
 * Detects a nearest-neighbour upscaled pixel grid (block size 2..maxBlock);
 * size 1 = none. Changes are counted between pixel columns / rows, with a
 * small tolerance so re-compressed sprites still qualify. A candidate grid
 * must show changes on several block lines and near-identical pixels inside
 * its blocks (a smooth gradient with one hard edge is not a grid).
 */
export function detectPixelGrid(img: RGBAImage, maxBlock = 16, tol = 24): PixelGrid {
  const { width: w, height: h, data } = img;
  // changesX[b]: colour changes between columns b-1 and b.
  const changesX = new Int32Array(w);
  const changesY = new Int32Array(h);
  const rowStep = Math.max(1, Math.floor(h / 256));
  const colStep = Math.max(1, Math.floor(w / 256));
  for (let y = 0; y < h; y += rowStep) {
    const row = y * w * 4;
    for (let x = 1; x < w; x++) if (differs(data, row + (x - 1) * 4, row + x * 4, tol)) changesX[x]++;
  }
  for (let x = 0; x < w; x += colStep) {
    for (let y = 1; y < h; y++) if (differs(data, ((y - 1) * w + x) * 4, (y * w + x) * 4, tol)) changesY[y]++;
  }
  const [kx, ox] = axisGrid(changesX, w, Math.min(maxBlock, w >> 1));
  const [ky, oy] = axisGrid(changesY, h, Math.min(maxBlock, h >> 1));
  const lines = (c: Int32Array) => c.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
  const sumX = changesX.reduce((a, v) => a + v, 0);
  const sumY = changesY.reduce((a, v) => a + v, 0);
  // Square art pixels; an axis without enough changes (e.g. stripes) defers to the other.
  let size = 1;
  if (kx === ky) size = kx;
  else if (kx > 1 && sumY < 24) size = kx;
  else if (ky > 1 && sumX < 24) size = ky;
  if (size <= 1) return { size: 1, offsetX: 0, offsetY: 0 };
  if (Math.max(lines(changesX), lines(changesY)) < 3) return { size: 1, offsetX: 0, offsetY: 0 };
  const grid = { size, offsetX: kx === size ? ox % size : 0, offsetY: ky === size ? oy % size : 0 };
  return blocksUniform(img, grid, rowStep, colStep) ? grid : { size: 1, offsetX: 0, offsetY: 0 };
}

/** Neighbouring pixels inside the same block are (nearly) identical, as a nearest-neighbour upscale makes them. */
function blocksUniform(img: RGBAImage, g: PixelGrid, rowStep: number, colStep: number): boolean {
  const { width: w, height: h, data } = img;
  let pairs = 0, same = 0;
  for (let y = 0; y < h; y += rowStep) {
    const row = y * w * 4;
    for (let x = 1; x < w; x++) {
      if ((x - g.offsetX) % g.size === 0) continue; // a block line
      pairs++;
      if (!differs(data, row + (x - 1) * 4, row + x * 4, 4)) same++;
    }
  }
  for (let x = 0; x < w; x += colStep)
    for (let y = 1; y < h; y++) {
      if ((y - g.offsetY) % g.size === 0) continue;
      pairs++;
      if (!differs(data, ((y - 1) * w + x) * 4, (y * w + x) * 4, 4)) same++;
    }
  return pairs > 0 && same / pairs >= 0.9;
}

/** One sample (the block centre) per art pixel of `grid`; partial blocks at the edges count as pixels. */
export function reduceToGrid(img: RGBAImage, grid: PixelGrid): RGBAImage {
  const k = grid.size;
  if (k <= 1) return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  const axis = (len: number, off: number): Int32Array => {
    const starts: number[] = [];
    for (let s = off > 0 ? off - k : 0; s < len; s += k) starts.push(s);
    return Int32Array.from(starts, (s) => {
      const lo = Math.max(0, s);
      const hi = Math.min(len, s + k) - 1;
      return Math.min(hi, Math.max(lo, s + (k >> 1)));
    });
  };
  const xs = axis(img.width, grid.offsetX);
  const ys = axis(img.height, grid.offsetY);
  const W = xs.length, H = ys.length;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const s = (ys[y] * img.width + xs[x]) * 4;
      out.set(img.data.subarray(s, s + 4), (y * W + x) * 4);
    }
  return { width: W, height: H, data: out };
}

/** EPX / Scale2x: 2× with rounded diagonals, no new colours. */
export function scale2x(img: RGBAImage): RGBAImage {
  const { width: w, height: h } = img;
  const src = words(img);
  const W = w * 2;
  const out = new Uint32Array(W * h * 2);
  for (let y = 0; y < h; y++) {
    const up = y > 0 ? y - 1 : y;
    const dn = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const l = x > 0 ? x - 1 : x;
      const r = x < w - 1 ? x + 1 : x;
      const E = src[y * w + x];
      const B = src[up * w + x];
      const D = src[y * w + l];
      const F = src[y * w + r];
      const H = src[dn * w + x];
      let e0 = E, e1 = E, e2 = E, e3 = E;
      if (B !== H && D !== F) {
        if (D === B) e0 = D;
        if (B === F) e1 = F;
        if (D === H) e2 = D;
        if (H === F) e3 = F;
      }
      const o = y * 2 * W + x * 2;
      out[o] = e0;
      out[o + 1] = e1;
      out[o + W] = e2;
      out[o + W + 1] = e3;
    }
  }
  return fromWords(out, W, h * 2);
}

/** AdvMAME3x / Scale3x: 3× counterpart of scale2x. */
export function scale3x(img: RGBAImage): RGBAImage {
  const { width: w, height: h } = img;
  const src = words(img);
  const W = w * 3;
  const out = new Uint32Array(W * h * 3);
  for (let y = 0; y < h; y++) {
    const up = y > 0 ? y - 1 : y;
    const dn = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const l = x > 0 ? x - 1 : x;
      const r = x < w - 1 ? x + 1 : x;
      const A = src[up * w + l], B = src[up * w + x], C = src[up * w + r];
      const D = src[y * w + l], E = src[y * w + x], F = src[y * w + r];
      const G = src[dn * w + l], H = src[dn * w + x], I = src[dn * w + r];
      let e0 = E, e1 = E, e2 = E, e3 = E, e5 = E, e6 = E, e7 = E, e8 = E;
      if (B !== H && D !== F) {
        if (D === B) e0 = D;
        if ((D === B && E !== C) || (B === F && E !== A)) e1 = B;
        if (B === F) e2 = F;
        if ((D === B && E !== G) || (D === H && E !== A)) e3 = D;
        if ((B === F && E !== I) || (H === F && E !== C)) e5 = F;
        if (D === H) e6 = D;
        if ((D === H && E !== I) || (H === F && E !== G)) e7 = H;
        if (H === F) e8 = F;
      }
      const o = y * 3 * W + x * 3;
      out[o] = e0; out[o + 1] = e1; out[o + 2] = e2;
      out[o + W] = e3; out[o + W + 1] = E; out[o + W + 2] = e5;
      out[o + 2 * W] = e6; out[o + 2 * W + 1] = e7; out[o + 2 * W + 2] = e8;
    }
  }
  return fromWords(out, W, h * 3);
}

/**
 * The factors a pixel-art chain applies to reach `targetSide` (longest side)
 * without passing `maxSide`: 2× steps, a 3× step when it lands in range.
 */
export function pixelChain(side: number, targetSide: number, maxSide: number): (2 | 3)[] {
  const steps: (2 | 3)[] = [];
  let s = side;
  while (s < targetSide) {
    if (s * 2 >= targetSide && s * 2 <= maxSide) steps.push(2);
    else if (s * 3 >= targetSide && s * 3 <= maxSide) steps.push(3);
    else if (s * 2 <= maxSide) steps.push(2);
    else break;
    s *= steps[steps.length - 1];
  }
  return steps;
}

export interface PixelUpscaleResult {
  image: RGBAImage;
  grid: PixelGrid;
  steps: (2 | 3)[];
}

/** Grid-reduce (when the art was already blown up), then Scale2x / Scale3x up to `targetSide`. */
export function pixelArtUpscale(img: RGBAImage, targetSide: number, maxSide: number, grid: PixelGrid = detectPixelGrid(img)): PixelUpscaleResult {
  let cur = grid.size > 1 ? reduceToGrid(img, grid) : img;
  const steps = pixelChain(Math.max(cur.width, cur.height), targetSide, maxSide);
  for (const s of steps) cur = s === 2 ? scale2x(cur) : scale3x(cur);
  if (cur === img) cur = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  return { image: cur, grid, steps };
}
