/**
 * Cheap, offline foreground extraction for images shot / drawn on a plain
 * background: estimate the background colour from the image border and
 * flood-fill it inwards. Pure typed-array code (workers, Node tests).
 */
import type { Mask, RGBAImage } from '../types';

export interface AutoMaskOptions {
  /** Drop blended edge pixels (anti-aliasing halo) that touch the background. Default true. */
  erodeHalo?: boolean;
  /** Foreground specks smaller than this fraction of the image area are removed. Default 0.0002. */
  minComponentFraction?: number;
  /** Minimum share of border pixels that must match the background colour. Default 0.5. */
  minBorderAgreement?: number;
}

/** True when enough pixels (≥ 0.1 %) are clearly transparent for the alpha channel to be the mask. */
export function hasMeaningfulAlpha(img: RGBAImage, threshold = 128): boolean {
  const d = img.data;
  const n = img.width * img.height;
  const need = Math.max(1, Math.ceil(n * 0.001));
  let count = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] < threshold && ++count >= need) return true;
  return false;
}

/**
 * Foreground mask of an opaque image on a uniform-ish background.
 *
 * The background colour is the per-channel median of the border pixels;
 * pixels within `tolerance` of it (Euclidean distance in RGB scaled to
 * [0, 1] per channel) that are connected to the border become background.
 * Background-coloured regions enclosed by the object (e.g. white eyes on a
 * white page) stay foreground.
 *
 * Returns null when the image has meaningful transparency (use its alpha
 * instead), when the border is not a uniform colour, or when the foreground
 * covers < 1 % or > 99 % of the image.
 */
export function autoMaskFromBorder(img: RGBAImage, tolerance = 0.12, opts: AutoMaskOptions = {}): Mask | null {
  const { width: w, height: h, data: px } = img;
  const n = w * h;
  if (w < 3 || h < 3 || hasMeaningfulAlpha(img)) return null;
  const erodeHalo = opts.erodeHalo ?? true;
  const minFrac = opts.minComponentFraction ?? 0.0002;
  const minAgree = opts.minBorderAgreement ?? 0.5;

  // Border ring (outermost pixels), each listed once.
  const border = new Int32Array(2 * (w + h) - 4);
  let nb = 0;
  for (let x = 0; x < w; x++) {
    border[nb++] = x;
    border[nb++] = (h - 1) * w + x;
  }
  for (let y = 1; y < h - 1; y++) {
    border[nb++] = y * w;
    border[nb++] = y * w + w - 1;
  }

  // Per-channel median via histograms.
  const hist = new Int32Array(256 * 3);
  for (let k = 0; k < nb; k++) {
    const o = border[k] * 4;
    hist[px[o]]++;
    hist[256 + px[o + 1]]++;
    hist[512 + px[o + 2]]++;
  }
  const bgc = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let acc = 0;
    let v = 0;
    while (v < 255 && (acc += hist[c * 256 + v]) * 2 < nb) v++;
    bgc[c] = v;
  }
  const [br, bgG, bb] = bgc;
  const dist2 = (i: number) => {
    const o = i * 4;
    const dr = px[o] - br, dg = px[o + 1] - bgG, db = px[o + 2] - bb;
    return dr * dr + dg * dg + db * db;
  };
  const tol = Math.max(0, tolerance) * 255;
  const tol2 = tol * tol;

  // Reject busy borders (photos, gradients, patterns).
  let agree = 0;
  for (let k = 0; k < nb; k++) if (dist2(border[k]) <= tol2) agree++;
  if (agree < nb * minAgree) return null;

  // Flood fill (4-connected) from matching border pixels.
  const near = new Uint8Array(n);
  for (let i = 0; i < n; i++) near[i] = dist2(i) <= tol2 ? 1 : 0;
  const bg = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  for (let k = 0; k < nb; k++) {
    const i = border[k];
    if (near[i] && !bg[i]) {
      bg[i] = 1;
      stack[sp++] = i;
    }
  }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w;
    if (x > 0 && near[i - 1] && !bg[i - 1]) { bg[i - 1] = 1; stack[sp++] = i - 1; }
    if (x < w - 1 && near[i + 1] && !bg[i + 1]) { bg[i + 1] = 1; stack[sp++] = i + 1; }
    if (i >= w && near[i - w] && !bg[i - w]) { bg[i - w] = 1; stack[sp++] = i - w; }
    if (i < n - w && near[i + w] && !bg[i + w]) { bg[i + w] = 1; stack[sp++] = i + w; }
  }

  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = bg[i] ? 0 : 1;

  // Halo removal: foreground pixels touching the background whose colour is
  // still close to it are anti-aliasing blends, not object.
  if (erodeHalo) {
    const halo2 = 4 * tol2;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!out[i]) continue;
        const touches =
          (x > 0 && bg[i - 1]) || (x < w - 1 && bg[i + 1]) || (y > 0 && bg[i - w]) || (y < h - 1 && bg[i + w]);
        if (touches && dist2(i) <= halo2) out[i] = 0;
      }
  }

  if (minFrac > 0) removeSmallComponents(out, w, h, Math.max(4, Math.ceil(n * minFrac)), stack);

  let area = 0;
  for (let i = 0; i < n; i++) area += out[i];
  if (area < n * 0.01 || area > n * 0.99) return null;
  return { width: w, height: h, data: out };
}

/** In place: clear 8-connected foreground components smaller than `minArea`. */
export function removeSmallComponents(
  data: Uint8Array, w: number, h: number, minArea: number, scratch = new Int32Array(w * h),
): void {
  const n = w * h;
  const seen = new Uint8Array(n);
  const comp = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (!data[s] || seen[s]) continue;
    // Collect the component into `comp`, using `scratch` as the DFS stack.
    let sp = 0, cn = 0;
    seen[s] = 1;
    scratch[sp++] = s;
    while (sp > 0) {
      const i = scratch[--sp];
      comp[cn++] = i;
      const x = i % w, y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (data[j] && !seen[j]) {
            seen[j] = 1;
            scratch[sp++] = j;
          }
        }
      }
    }
    if (cn < minArea) for (let k = 0; k < cn; k++) data[comp[k]] = 0;
  }
}
