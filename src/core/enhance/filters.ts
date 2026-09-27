/**
 * Local image filters for the enhancement card: unsharp mask (on luminance,
 * so colours do not fringe), an edge-preserving bilateral denoise and a light
 * JPEG deblocking filter on the 8 × 8 grid. All return new images and keep
 * the alpha channel as is.
 */
import type { RGBAImage } from '../types';

/** Rec. 601 luma of every pixel (0..255). */
export function lumaOf(img: RGBAImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) out[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return out;
}

function gaussianKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(r * 2 + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/** Separable Gaussian blur of a single float channel (edges clamped). */
export function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) >> 1;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let t = -r; t <= r; t++) {
        const xx = x + t < 0 ? 0 : x + t >= w ? w - 1 : x + t;
        s += src[row + xx] * k[t + r];
      }
      tmp[row + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let t = -r; t <= r; t++) {
      const yy = y + t < 0 ? 0 : y + t >= h ? h - 1 : y + t;
      const wt = k[t + r];
      const srow = yy * w, orow = y * w;
      for (let x = 0; x < w; x++) out[orow + x] += tmp[srow + x] * wt;
    }
  }
  return out;
}

export interface UnsharpOptions {
  /** Detail gain (0 = none). */
  amount?: number;
  /** Gaussian sigma of the blur, px. */
  radius?: number;
  /** Luma differences below this (0..255) are left alone, so flat noise is not amplified. */
  threshold?: number;
}

/** Unsharp mask on luminance: the luma detail is added to R, G and B alike. */
export function unsharpMask(img: RGBAImage, { amount = 0.8, radius = 1, threshold = 2 }: UnsharpOptions = {}): RGBAImage {
  const { width: w, height: h, data } = img;
  const y = lumaOf(img);
  const blur = gaussianBlur(y, w, h, radius);
  const out = new Uint8ClampedArray(data);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (data[o + 3] === 0) continue;
    let d = y[i] - blur[i];
    const ad = Math.abs(d);
    if (ad <= threshold) continue;
    // Soft threshold: ramps in instead of switching on.
    d = Math.sign(d) * (ad - threshold);
    const add = amount * d;
    out[o] = data[o] + add;
    out[o + 1] = data[o + 1] + add;
    out[o + 2] = data[o + 2] + add;
  }
  return { width: w, height: h, data: out };
}

export interface BilateralOptions {
  /** Window radius, px. */
  radius?: number;
  /** Spatial sigma, px. */
  sigmaSpace?: number;
  /** Range sigma on the mean absolute channel difference (0..255). */
  sigmaRange?: number;
}

/**
 * Edge-preserving bilateral denoise: neighbours are averaged with weights
 * that fall off with distance and with colour (and alpha) difference, so
 * noise and JPEG mosquitoes flatten while edges stay put.
 */
export function bilateralDenoise(img: RGBAImage, { radius = 2, sigmaSpace = 1.5, sigmaRange = 18 }: BilateralOptions = {}): RGBAImage {
  const { width: w, height: h, data } = img;
  const r = Math.max(1, Math.round(radius));
  const side = r * 2 + 1;
  const spatial = new Float32Array(side * side);
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) spatial[(dy + r) * side + dx + r] = Math.exp(-(dx * dx + dy * dy) / (2 * sigmaSpace * sigmaSpace));
  // Range weights indexed by the summed absolute RGBA difference (0..1020).
  const range = new Float32Array(1021);
  for (let s = 0; s <= 1020; s++) {
    const m = s / 3;
    range[s] = Math.exp(-(m * m) / (2 * sigmaRange * sigmaRange));
  }
  const out = new Uint8ClampedArray(data);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const a0 = data[o + 3];
      if (a0 === 0) continue;
      const r0 = data[o], g0 = data[o + 1], b0 = data[o + 2];
      let sr = 0, sg = 0, sb = 0, sw = 0;
      const y0 = y - r < 0 ? 0 : y - r, y1 = y + r >= h ? h - 1 : y + r;
      const x0 = x - r < 0 ? 0 : x - r, x1 = x + r >= w ? w - 1 : x + r;
      for (let yy = y0; yy <= y1; yy++) {
        const srow = (yy - y + r) * side - x + r;
        let p = (yy * w + x0) * 4;
        for (let xx = x0; xx <= x1; xx++, p += 4) {
          const diff = Math.abs(data[p] - r0) + Math.abs(data[p + 1] - g0) + Math.abs(data[p + 2] - b0) + Math.abs(data[p + 3] - a0);
          const wt = spatial[srow + xx] * range[diff];
          sr += data[p] * wt;
          sg += data[p + 1] * wt;
          sb += data[p + 2] * wt;
          sw += wt;
        }
      }
      out[o] = sr / sw;
      out[o + 1] = sg / sw;
      out[o + 2] = sb / sw;
    }
  }
  return { width: w, height: h, data: out };
}

export interface DeblockOptions {
  /** Largest step across a block boundary that is treated as an artefact (0..255). */
  alpha?: number;
  /** Largest step inside a block next to the boundary (flatness test). */
  beta?: number;
  /** Largest correction per pixel. */
  clip?: number;
}

/**
 * Light JPEG deblocking (H.264-style normal filter) along the 8 × 8 grid:
 * only small steps between otherwise flat sides are smoothed, real edges are
 * left alone. Colour channels are filtered independently.
 */
export function deblock(img: RGBAImage, { alpha = 20, beta = 6, clip = 4 }: DeblockOptions = {}): RGBAImage {
  const { width: w, height: h } = img;
  const d = new Uint8ClampedArray(img.data);
  const filter = (p1i: number, p0i: number, q0i: number, q1i: number) => {
    for (let c = 0; c < 3; c++) {
      const p1 = d[p1i + c], p0 = d[p0i + c], q0 = d[q0i + c], q1 = d[q1i + c];
      if (Math.abs(p0 - q0) >= alpha || Math.abs(p1 - p0) >= beta || Math.abs(q1 - q0) >= beta) continue;
      let delta = ((q0 - p0) * 4 + (p1 - q1) + 4) >> 3;
      delta = delta < -clip ? -clip : delta > clip ? clip : delta;
      d[p0i + c] = p0 + delta;
      d[q0i + c] = q0 - delta;
    }
  };
  // Vertical boundaries (between columns 8k-1 and 8k).
  for (let x = 8; x < w - 1; x += 8)
    for (let y = 0; y < h; y++) {
      const row = y * w;
      filter((row + x - 2) * 4, (row + x - 1) * 4, (row + x) * 4, (row + x + 1) * 4);
    }
  // Horizontal boundaries.
  for (let y = 8; y < h - 1; y += 8)
    for (let x = 0; x < w; x++) filter(((y - 2) * w + x) * 4, ((y - 1) * w + x) * 4, (y * w + x) * 4, ((y + 1) * w + x) * 4);
  return { width: w, height: h, data: d };
}
