/**
 * High-quality separable resampling (Lanczos-3, Catmull-Rom bicubic) of RGBA
 * images and single channels. RGBA is resampled alpha-premultiplied, so
 * transparent pixels never bleed their (meaningless) colour into edges.
 * Downscaling widens the kernel (proper low-pass), upscaling interpolates.
 * Pure typed-array code: runs in Node, a worker or the main thread.
 */
import type { RGBAImage } from '../types';

export type ResampleKernel = 'lanczos3' | 'bicubic' | 'bilinear';

interface KernelDef {
  support: number;
  fn: (x: number) => number;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

const KERNELS: Record<ResampleKernel, KernelDef> = {
  lanczos3: { support: 3, fn: (x) => (Math.abs(x) < 3 ? sinc(x) * sinc(x / 3) : 0) },
  // Catmull-Rom (a = -0.5): interpolating, mild overshoot.
  bicubic: {
    support: 2,
    fn: (x) => {
      const a = -0.5;
      const t = Math.abs(x);
      if (t <= 1) return (a + 2) * t * t * t - (a + 3) * t * t + 1;
      if (t < 2) return a * t * t * t - 5 * a * t * t + 8 * a * t - 4 * a;
      return 0;
    },
  },
  bilinear: { support: 1, fn: (x) => Math.max(0, 1 - Math.abs(x)) },
};

/** Per output sample: first input index and `taps` normalised weights (indices clamped to the edge). */
interface Contrib {
  taps: number;
  index: Int32Array; // outSize * taps
  weight: Float32Array; // outSize * taps
}

function contributions(inSize: number, outSize: number, kernel: ResampleKernel): Contrib {
  const k = KERNELS[kernel];
  const scale = inSize / outSize;
  const filterScale = Math.max(1, scale);
  const support = k.support * filterScale;
  const taps = Math.ceil(support) * 2 + 1;
  const index = new Int32Array(outSize * taps);
  const weight = new Float32Array(outSize * taps);
  for (let i = 0; i < outSize; i++) {
    const center = (i + 0.5) * scale - 0.5;
    const left = Math.floor(center - support) + 1;
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      const j = left + t;
      const w = k.fn((j - center) / filterScale);
      index[i * taps + t] = j < 0 ? 0 : j >= inSize ? inSize - 1 : j;
      weight[i * taps + t] = w;
      sum += w;
    }
    if (sum !== 0) for (let t = 0; t < taps; t++) weight[i * taps + t] /= sum;
  }
  return { taps, index, weight };
}

/**
 * Resample an interleaved float image with `channels` channels from w × h to
 * W × H (horizontal pass, then vertical).
 */
export function resampleFloat(src: Float32Array, w: number, h: number, channels: number, W: number, H: number, kernel: ResampleKernel): Float32Array {
  const c = channels;
  // Horizontal: w × h → W × h
  let mid: Float32Array;
  if (W === w) mid = src;
  else {
    mid = new Float32Array(W * h * c);
    const { taps, index, weight } = contributions(w, W, kernel);
    for (let y = 0; y < h; y++) {
      const row = y * w * c;
      const orow = y * W * c;
      for (let x = 0; x < W; x++) {
        const base = x * taps;
        const o = orow + x * c;
        for (let t = 0; t < taps; t++) {
          const wt = weight[base + t];
          if (wt === 0) continue;
          const s = row + index[base + t] * c;
          for (let ch = 0; ch < c; ch++) mid[o + ch] += src[s + ch] * wt;
        }
      }
    }
  }
  if (H === h) return mid === src ? new Float32Array(src) : mid;
  // Vertical: W × h → W × H
  const out = new Float32Array(W * H * c);
  const { taps, index, weight } = contributions(h, H, kernel);
  const stride = W * c;
  for (let y = 0; y < H; y++) {
    const base = y * taps;
    const orow = y * stride;
    for (let t = 0; t < taps; t++) {
      const wt = weight[base + t];
      if (wt === 0) continue;
      const srow = index[base + t] * stride;
      for (let i = 0; i < stride; i++) out[orow + i] += mid[srow + i] * wt;
    }
  }
  return out;
}

/** Resize an RGBA image (premultiplied alpha) to exactly W × H. */
export function resizeImage(img: RGBAImage, W: number, H: number, kernel: ResampleKernel = 'lanczos3'): RGBAImage {
  W = Math.max(1, Math.round(W));
  H = Math.max(1, Math.round(H));
  if (W === img.width && H === img.height) return { width: W, height: H, data: new Uint8ClampedArray(img.data) };
  const { width: w, height: h, data } = img;
  const n = w * h;
  const pre = new Float32Array(n * 4);
  let opaque = true;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = data[o + 3];
    if (a !== 255) opaque = false;
    const f = a / 255;
    pre[o] = data[o] * f;
    pre[o + 1] = data[o + 1] * f;
    pre[o + 2] = data[o + 2] * f;
    pre[o + 3] = a;
  }
  const res = resampleFloat(pre, w, h, 4, W, H, kernel);
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (opaque) {
      out[o] = res[o];
      out[o + 1] = res[o + 1];
      out[o + 2] = res[o + 2];
      out[o + 3] = 255;
      continue;
    }
    const a = res[o + 3];
    if (a <= 0.5) continue; // fully transparent (colour irrelevant)
    const f = 255 / a;
    out[o] = res[o] * f;
    out[o + 1] = res[o + 1] * f;
    out[o + 2] = res[o + 2] * f;
    out[o + 3] = a;
  }
  return { width: W, height: H, data: out };
}

/** Resize a single 8-bit channel (e.g. an alpha matte) with a smooth kernel. */
export function resizeChannel(src: ArrayLike<number>, w: number, h: number, W: number, H: number, kernel: ResampleKernel = 'bicubic'): Uint8ClampedArray {
  const f = Float32Array.from(src as ArrayLike<number>);
  const res = resampleFloat(f, w, h, 1, W, H, kernel);
  return Uint8ClampedArray.from(res, (v) => Math.round(v));
}

/** Longest-side fit (never upscales), high-quality; returns the input when it already fits. */
export function fitImage(img: RGBAImage, maxSide: number, kernel: ResampleKernel = 'lanczos3'): RGBAImage {
  const s = maxSide / Math.max(img.width, img.height);
  if (s >= 1) return img;
  return resizeImage(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)), kernel);
}
