/**
 * Small software rasteriser for the landmark priors (pure, Node-testable).
 * Height fields live on a Region (a clamped sub-rectangle of the image) and
 * are combined z-buffer style: every primitive writes max(current, height),
 * i.e. the surface nearest to the viewer wins. Pixel centres sit at +0.5.
 */
import { distanceTransform } from '../image/distance';
import { blurFloat } from '../image/ops';
import type { RGBAImage } from '../types';

export interface Region {
  /** Top-left corner in image pixels (integers). */
  x0: number;
  y0: number;
  width: number;
  height: number;
}

/** Height sample: image-pixel position and height (px, larger = nearer). */
export interface P3 {
  x: number;
  y: number;
  h: number;
}

/** Integer region covering [x0, x1] × [y0, y1] plus `pad`, clamped to the image; null when empty. */
export function regionAround(x0: number, y0: number, x1: number, y1: number, pad: number, width: number, height: number): Region | null {
  const rx0 = Math.max(0, Math.floor(x0 - pad));
  const ry0 = Math.max(0, Math.floor(y0 - pad));
  const rx1 = Math.min(width, Math.ceil(x1 + pad));
  const ry1 = Math.min(height, Math.ceil(y1 + pad));
  if (rx1 - rx0 < 2 || ry1 - ry0 < 2) return null;
  return { x0: rx0, y0: ry0, width: rx1 - rx0, height: ry1 - ry0 };
}

/** Height buffer for a region, initialised to -Infinity (= not covered). */
export function heightBuffer(r: Region): Float32Array {
  return new Float32Array(r.width * r.height).fill(-Infinity);
}

/** Rasterise a triangle with linearly interpolated height into `buf` (max-combine). */
export function rasterTriangle(r: Region, buf: Float32Array, a: P3, b: P3, c: P3): void {
  const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
  if (Math.abs(area) < 1e-9) return;
  const minX = Math.max(r.x0, Math.floor(Math.min(a.x, b.x, c.x)));
  const maxX = Math.min(r.x0 + r.width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const minY = Math.max(r.y0, Math.floor(Math.min(a.y, b.y, c.y)));
  const maxY = Math.min(r.y0 + r.height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  const inv = 1 / area;
  const eps = -1e-6;
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const w0 = ((b.x - px) * (c.y - py) - (c.x - px) * (b.y - py)) * inv;
      const w1 = ((c.x - px) * (a.y - py) - (a.x - px) * (c.y - py)) * inv;
      const w2 = 1 - w0 - w1;
      if (w0 < eps || w1 < eps || w2 < eps) continue;
      const h = w0 * a.h + w1 * b.h + w2 * c.h;
      const i = (y - r.y0) * r.width + (x - r.x0);
      if (h > buf[i]) buf[i] = h;
    }
  }
}

/** Fan-triangulate a (star-shaped) polygon around `center`. */
export function rasterFan(r: Region, buf: Float32Array, loop: P3[], center: P3): void {
  for (let i = 0; i < loop.length; i++) rasterTriangle(r, buf, center, loop[i], loop[(i + 1) % loop.length]);
}

/**
 * Tapered capsule from `a` (radius ra) to `b` (radius rb): a round limb /
 * finger whose axis height is interpolated between a.h and b.h and whose
 * cross-section is a half circle (height above the axis = sqrt(r² - d²)).
 */
export function stampCapsule(r: Region, buf: Float32Array, a: P3, b: P3, ra: number, rb: number): void {
  const rmax = Math.max(ra, rb);
  if (!(rmax > 0)) return;
  const minX = Math.max(r.x0, Math.floor(Math.min(a.x, b.x) - rmax));
  const maxX = Math.min(r.x0 + r.width - 1, Math.ceil(Math.max(a.x, b.x) + rmax));
  const minY = Math.max(r.y0, Math.floor(Math.min(a.y, b.y) - rmax));
  const maxY = Math.min(r.y0 + r.height - 1, Math.ceil(Math.max(a.y, b.y) + rmax));
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const t = len2 > 1e-9 ? Math.min(1, Math.max(0, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0;
      const cx = a.x + t * dx, cy = a.y + t * dy;
      const d2 = (px - cx) ** 2 + (py - cy) ** 2;
      const rad = ra + (rb - ra) * t;
      if (d2 >= rad * rad) continue;
      const h = a.h + (b.h - a.h) * t + Math.sqrt(rad * rad - d2);
      const i = (y - r.y0) * r.width + (x - r.x0);
      if (h > buf[i]) buf[i] = h;
    }
  }
}

/** Filled ellipse / disc stamp with a caller-supplied height at normalised radius ρ ∈ [0, 1] and local axes. */
export function stampEllipse(
  r: Region,
  buf: Float32Array,
  center: { x: number; y: number },
  axisU: { x: number; y: number },
  radiusU: number,
  radiusV: number,
  height: (u: number, v: number, rho: number) => number,
  cover?: Float32Array,
  coverAt?: (rho: number) => number,
): void {
  const ext = Math.max(radiusU, radiusV);
  const minX = Math.max(r.x0, Math.floor(center.x - ext));
  const maxX = Math.min(r.x0 + r.width - 1, Math.ceil(center.x + ext));
  const minY = Math.max(r.y0, Math.floor(center.y - ext));
  const maxY = Math.min(r.y0 + r.height - 1, Math.ceil(center.y + ext));
  const ul = Math.hypot(axisU.x, axisU.y) || 1;
  const ux = axisU.x / ul, uy = axisU.y / ul;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5 - center.x, py = y + 0.5 - center.y;
      const u = (px * ux + py * uy) / radiusU;
      const v = (-px * uy + py * ux) / radiusV;
      const rho = Math.hypot(u, v);
      if (rho >= 1) continue;
      const i = (y - r.y0) * r.width + (x - r.x0);
      const h = height(u, v, rho);
      if (h > buf[i]) buf[i] = h;
      if (cover && coverAt) cover[i] = Math.max(cover[i], coverAt(rho));
    }
  }
}

/** Coverage mask (1 where the buffer was written). */
export function coverage(buf: Float32Array, r: Region): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(buf.length);
  for (let i = 0; i < buf.length; i++) data[i] = buf[i] > -Infinity ? 1 : 0;
  return { width: r.width, height: r.height, data };
}

export function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 <= e0) return x >= e1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Feathered weight of a coverage mask: 0 outside, rising smoothly to 1 about
 * `feather` px inside the border. Built from a blurred coverage (≈ Gaussian)
 * rather than a distance transform, whose gradient ripples along a
 * pixel-staircase border (visible as ridges once the weight shapes depth).
 * Edges that lie on the image border (the region was clamped) are not
 * feathered.
 */
export function featherWeights(
  cov: { width: number; height: number; data: Uint8Array },
  feather: number,
  openEdges: { left: boolean; right: boolean; top: boolean; bottom: boolean } = { left: false, right: false, top: false, bottom: false },
): Float32Array {
  const { width: w, height: h } = cov;
  const radius = Math.max(1, Math.round(feather / 2));
  // Pad every side by the blur reach; open sides replicate the coverage so the image border does not count as outside.
  const f = 3 * radius + 1;
  const pw = w + 2 * f, ph = h + 2 * f;
  const pad = new Float32Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    let sy = y - f;
    if (sy < 0) { if (!openEdges.top) continue; sy = 0; }
    if (sy >= h) { if (!openEdges.bottom) continue; sy = h - 1; }
    for (let x = 0; x < pw; x++) {
      let sx = x - f;
      if (sx < 0) { if (!openEdges.left) continue; sx = 0; }
      if (sx >= w) { if (!openEdges.right) continue; sx = w - 1; }
      pad[y * pw + x] = cov.data[sy * w + sx];
    }
  }
  const b = blurFloat(pad, pw, ph, radius, 3, null);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (cov.data[i]) out[i] = smoothstep(0.5, 0.97, b[(y + f) * pw + x + f]);
    }
  }
  return out;
}

/**
 * Normalised rounded profile inside a coverage mask: 0 at the border, 1 at
 * the most interior pixel (quarter-circle rise). The distance field is
 * smoothed first; raw, its medial-axis ridges shade as facets.
 */
export function domeProfile(cov: { width: number; height: number; data: Uint8Array }): Float32Array {
  let d = distanceTransform(cov);
  let dmax = 0;
  for (let i = 0; i < d.length; i++) if (d[i] > dmax) dmax = d[i];
  if (dmax >= 3) d = blurFloat(d, cov.width, cov.height, Math.max(1, Math.round(0.3 * dmax)), 2, cov);
  let max = 0;
  for (let i = 0; i < d.length; i++) if (d[i] > max) max = d[i];
  const out = new Float32Array(d.length);
  if (max <= 0) return out;
  for (let i = 0; i < d.length; i++) {
    if (!cov.data[i]) continue;
    const t = Math.min(1, d[i] / max);
    out[i] = Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
  }
  return out;
}

/** Convex hull (Andrew's monotone chain), counter-clockwise in a y-up sense; collinear points dropped. */
export function convexHull<T extends { x: number; y: number }>(points: T[]): T[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: T, a: T, b: T) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: T[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: T[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Even-odd point-in-polygon test. */
export function insidePolygon(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Copy of an integer-aligned region. */
export function cropRGBA(img: RGBAImage, box: { x: number; y: number; width: number; height: number }): RGBAImage {
  const x0 = Math.max(0, Math.round(box.x)), y0 = Math.max(0, Math.round(box.y));
  const w = Math.max(1, Math.min(img.width - x0, Math.round(box.width)));
  const h = Math.max(1, Math.min(img.height - y0, Math.round(box.height)));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    out.set(img.data.subarray(src, src + w * 4), y * w * 4);
  }
  return { width: w, height: h, data: out };
}
