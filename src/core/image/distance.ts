/**
 * Exact Euclidean distance transforms (Felzenszwalb & Huttenlocher 2012,
 * "Distance Transforms of Sampled Functions"). Separable, O(width·height).
 * Pure functions on typed arrays — usable in workers and Node tests.
 */
import type { Mask } from '../types';

/**
 * Lower envelope of parabolas: out[q] = min_p ((q - p)² + f[p]) for q, p in [0, n).
 * `f` must be finite. `v` (length ≥ n) and `z` (length ≥ n + 1) are scratch buffers.
 */
function envelope1d(f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    const fq = f[q] + q * q;
    let s: number;
    for (;;) {
      const p = v[k];
      s = (fq - (f[p] + p * p)) / (2 * (q - p));
      if (s > z[k]) break;
      k--;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    const dq = q - p;
    out[q] = dq * dq + f[p];
  }
}

/**
 * Exact Euclidean distance (in pixels, between pixel centres) from every
 * foreground pixel to the nearest background pixel. Pixels outside the image
 * count as background, so a foreground pixel on the image border has distance
 * ≤ 1. Background pixels get 0.
 */
export function distanceTransform(mask: Mask): Float32Array {
  const { width: w, height: h, data: m } = mask;
  const n = w * h;
  const out = new Float32Array(n);
  if (n === 0) return out;

  // Pass 1 (columns): 1D distance to the nearest background pixel in the same
  // column, rows -1 and h being background. Done row-wise for cache locality.
  const col = new Int32Array(n);
  const run = new Int32Array(w);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      run[x] = m[row + x] ? run[x] + 1 : 0;
      col[row + x] = run[x];
    }
  }
  run.fill(0);
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      run[x] = m[row + x] ? run[x] + 1 : 0;
      if (run[x] < col[row + x]) col[row + x] = run[x];
    }
  }

  // Pass 2 (rows): F&H on squared column distances, with background sentinels
  // at x = -1 and x = w (index 0 and w + 1 of the padded line).
  const len = w + 2;
  const f = new Float64Array(len);
  const d = new Float64Array(len);
  const v = new Int32Array(len);
  const z = new Float64Array(len + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let any = false;
    for (let x = 0; x < w; x++) {
      const c = col[row + x];
      f[x + 1] = c * c;
      if (c) any = true;
    }
    if (!any) continue; // whole row is background
    f[0] = 0;
    f[len - 1] = 0;
    envelope1d(f, len, d, v, z);
    for (let x = 0; x < w; x++) out[row + x] = m[row + x] ? Math.sqrt(d[x + 1]) : 0;
  }
  return out;
}

/**
 * Height of the union of spheres centred on every pixel c with radius r(c):
 *   H(p) = sqrt(max(0, max_c (r(c)² − |p − c|²)))
 * Computed exactly as a generalised distance transform of f = −r².
 * Fed with the distance transform, this "inflates" a silhouette into a body
 * with circular cross-sections (a disk becomes a hemisphere, a stroke a tube).
 */
export function unionOfSpheres(radius: Float32Array, width: number, height: number): Float32Array {
  const n = width * height;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const tmp = new Float64Array(n);
  const len = Math.max(width, height);
  const f = new Float64Array(len);
  const d = new Float64Array(len);
  const v = new Int32Array(len);
  const z = new Float64Array(len + 1);

  let maxR2 = 0;
  // Columns.
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const r = radius[y * width + x];
      const r2 = r > 0 ? r * r : 0;
      f[y] = -r2;
      if (r2 > maxR2) maxR2 = r2;
    }
    envelope1d(f, height, d, v, z);
    for (let y = 0; y < height; y++) tmp[y * width + x] = d[y];
  }
  // Float32 radii carry ~1e-7 relative error in r²; don't let it leak a
  // hairline of height outside the silhouette.
  const eps = maxR2 * 1e-6;
  // Rows.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) f[x] = tmp[row + x];
    envelope1d(f, width, d, v, z);
    for (let x = 0; x < width; x++) out[row + x] = d[x] < -eps ? Math.sqrt(-d[x]) : 0;
  }
  return out;
}
