/**
 * Small, dependency-free image helpers. Pure functions, usable in the main
 * thread, in workers and in Node tests.
 */
import type { DepthMap, Mask, RGBAImage } from '../types';

/** Rec. 709 luma of an RGBA image in [0, 1]. */
export function luminance(img: RGBAImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = (0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]) / 255;
  }
  return out;
}

/** True if any pixel has alpha below `threshold` (0..255). */
export function hasTransparency(img: RGBAImage, threshold = 250): boolean {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < threshold) return true;
  return false;
}

/** Foreground mask from the alpha channel: alpha >= threshold → 1. */
export function maskFromAlpha(img: RGBAImage, threshold = 128): Mask {
  const n = img.width * img.height;
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = img.data[i * 4 + 3] >= threshold ? 1 : 0;
  return { width: img.width, height: img.height, data };
}

/** Number of foreground pixels. */
export function maskArea(mask: Mask): number {
  let a = 0;
  for (let i = 0; i < mask.data.length; i++) a += mask.data[i];
  return a;
}

/**
 * Area-averaging downscale / bilinear upscale of an RGBA image so that its
 * longest side is at most `maxSide`. Returns the input untouched if it already fits.
 */
export function fitRGBA(img: RGBAImage, maxSide: number): RGBAImage {
  const scale = maxSide / Math.max(img.width, img.height);
  if (scale >= 1) return img;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  return resizeRGBA(img, w, h);
}

/** Resize RGBA with box filtering (downscale) or bilinear sampling (upscale). Alpha-premultiplied to avoid dark fringes. */
export function resizeRGBA(img: RGBAImage, w: number, h: number): RGBAImage {
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = img.width / w;
  const sy = img.height / h;
  const src = img.data;
  for (let y = 0; y < h; y++) {
    const y0 = y * sy;
    const y1 = Math.min(img.height, (y + 1) * sy);
    for (let x = 0; x < w; x++) {
      const x0 = x * sx;
      const x1 = Math.min(img.width, (x + 1) * sx);
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      if (sx <= 1 && sy <= 1) {
        // upscale: bilinear at pixel centre
        const fx = Math.min(img.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
        const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
        const ix = Math.floor(fx), iy = Math.floor(fy);
        const tx = fx - ix, ty = fy - iy;
        const ix1 = Math.min(img.width - 1, ix + 1), iy1 = Math.min(img.height - 1, iy + 1);
        const taps: [number, number, number][] = [
          [ix, iy, (1 - tx) * (1 - ty)], [ix1, iy, tx * (1 - ty)],
          [ix, iy1, (1 - tx) * ty], [ix1, iy1, tx * ty],
        ];
        for (const [px, py, wt] of taps) {
          const o = (py * img.width + px) * 4;
          const al = src[o + 3] / 255;
          r += src[o] * al * wt; g += src[o + 1] * al * wt; b += src[o + 2] * al * wt;
          a += al * wt; wsum += wt;
        }
      } else {
        for (let py = Math.floor(y0); py < Math.ceil(y1); py++) {
          const wy = Math.min(py + 1, y1) - Math.max(py, y0);
          if (wy <= 0) continue;
          for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
            const wx = Math.min(px + 1, x1) - Math.max(px, x0);
            if (wx <= 0) continue;
            const wt = wx * wy;
            const o = (py * img.width + px) * 4;
            const al = src[o + 3] / 255;
            r += src[o] * al * wt; g += src[o + 1] * al * wt; b += src[o + 2] * al * wt;
            a += al * wt; wsum += wt;
          }
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a;
      }
      out[o + 3] = wsum > 0 ? (a / wsum) * 255 : 0;
    }
  }
  return { width: w, height: h, data: out };
}

/** Bilinear sample of a single-channel float field at continuous pixel coords (pixel centres at +0.5). */
export function sampleBilinear(data: Float32Array, width: number, height: number, x: number, y: number): number {
  const fx = Math.min(width - 1, Math.max(0, x - 0.5));
  const fy = Math.min(height - 1, Math.max(0, y - 0.5));
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = fx - ix, ty = fy - iy;
  const ix1 = Math.min(width - 1, ix + 1), iy1 = Math.min(height - 1, iy + 1);
  const a = data[iy * width + ix], b = data[iy * width + ix1];
  const c = data[iy1 * width + ix], d = data[iy1 * width + ix1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** Resample a float field to a new size (bilinear). */
export function resizeFloat(data: Float32Array, width: number, height: number, w: number, h: number): Float32Array {
  if (w === width && h === height) return data.slice();
  const out = new Float32Array(w * h);
  const sx = width / w, sy = height / h;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) out[y * w + x] = sampleBilinear(data, width, height, (x + 0.5) * sx, (y + 0.5) * sy);
  return out;
}

/** Nearest-neighbour resample of a mask. */
export function resizeMask(mask: Mask, w: number, h: number): Mask {
  if (w === mask.width && h === mask.height) return { width: w, height: h, data: mask.data.slice() };
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(mask.height - 1, Math.floor(((y + 0.5) * mask.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(mask.width - 1, Math.floor(((x + 0.5) * mask.width) / w));
      data[y * w + x] = mask.data[sy * mask.width + sx];
    }
  }
  return { width: w, height: h, data };
}

/**
 * Separable box blur repeated `passes` times (3 passes ≈ Gaussian).
 * If `mask` is given, only foreground pixels contribute and are written
 * (normalised convolution), so background values never bleed into the object.
 */
export function blurFloat(
  data: Float32Array,
  width: number,
  height: number,
  radius: number,
  passes = 3,
  mask: Mask | null = null,
): Float32Array {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return data.slice();
  let cur = new Float32Array(data);
  let wgt = new Float32Array(width * height);
  for (let i = 0; i < wgt.length; i++) wgt[i] = mask ? mask.data[i] : 1;
  for (let i = 0; i < cur.length; i++) cur[i] *= wgt[i];
  const tmpV = new Float32Array(width * height);
  const tmpW = new Float32Array(width * height);
  for (let p = 0; p < passes; p++) {
    boxPass(cur, wgt, tmpV, tmpW, width, height, r, true);
    boxPass(tmpV, tmpW, cur, wgt, width, height, r, false);
  }
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const keep = mask && !mask.data[i];
    out[i] = keep ? data[i] : wgt[i] > 1e-8 ? cur[i] / wgt[i] : data[i];
  }
  return out;
}

function boxPass(
  srcV: Float32Array, srcW: Float32Array, dstV: Float32Array, dstW: Float32Array,
  width: number, height: number, r: number, horizontal: boolean,
): void {
  const lines = horizontal ? height : width;
  const len = horizontal ? width : height;
  const stride = horizontal ? 1 : width;
  const inv = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = horizontal ? l * width : l;
    let accV = 0, accW = 0;
    // clamp-to-edge window
    for (let k = -r; k <= r; k++) {
      const idx = base + Math.min(len - 1, Math.max(0, k)) * stride;
      accV += srcV[idx]; accW += srcW[idx];
    }
    for (let i = 0; i < len; i++) {
      const o = base + i * stride;
      dstV[o] = accV * inv; dstW[o] = accW * inv;
      const add = base + Math.min(len - 1, i + r + 1) * stride;
      const sub = base + Math.max(0, i - r) * stride;
      accV += srcV[add] - srcV[sub]; accW += srcW[add] - srcW[sub];
    }
  }
}

/**
 * Min-max normalise to [0, 1]. When a mask is given, statistics use only
 * foreground pixels (robust 1st/99th percentiles when `robust`), background
 * pixels are set to 0.
 */
export function normalizeDepth(depth: DepthMap, mask: Mask | null = null, robust = true): DepthMap {
  const { width, height, data } = depth;
  const vals: number[] = [];
  for (let i = 0; i < data.length; i++) if (!mask || mask.data[i]) vals.push(data[i]);
  if (vals.length === 0) return { width, height, data: new Float32Array(data.length) };
  let lo: number, hi: number;
  if (robust && vals.length > 100) {
    vals.sort((a, b) => a - b);
    lo = vals[Math.floor(vals.length * 0.01)];
    hi = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.99))];
  } else {
    lo = Infinity; hi = -Infinity;
    for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  const span = hi - lo > 1e-12 ? hi - lo : 1;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    if (mask && !mask.data[i]) continue;
    out[i] = Math.min(1, Math.max(0, (data[i] - lo) / span));
  }
  return { width, height, data: out };
}

/** Render a depth map as a grayscale RGBA image (for previews). */
export function depthToRGBA(depth: DepthMap, mask: Mask | null = null): RGBAImage {
  const n = depth.width * depth.height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.min(1, Math.max(0, depth.data[i])) * 255);
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = mask && !mask.data[i] ? 0 : 255;
  }
  return { width: depth.width, height: depth.height, data: out };
}
