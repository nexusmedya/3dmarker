/**
 * Landmark preview for the UI (pure, software-drawn): pose skeleton, hand
 * skeletons and the face mesh (dots + contours) over a copy of the image.
 */
import type { RGBAImage } from '../types';
import { FACE_CONTOUR_EDGES, HAND_EDGES, POSE_EDGES } from './topology';
import type { HumanAnalysis, Landmark } from './types';

type RGB = readonly [number, number, number];

export const OVERLAY_COLORS = {
  pose: [56, 189, 248] as RGB,
  hand: [251, 191, 36] as RGB,
  face: [52, 211, 153] as RGB,
  joint: [255, 255, 255] as RGB,
};

class Painter {
  constructor(readonly img: RGBAImage) {}

  blend(x: number, y: number, c: RGB, a: number): void {
    const { width: w, height: h, data } = this.img;
    if (x < 0 || y < 0 || x >= w || y >= h || a <= 0) return;
    const o = (y * w + x) * 4;
    const k = Math.min(1, a);
    data[o] += (c[0] - data[o]) * k;
    data[o + 1] += (c[1] - data[o + 1]) * k;
    data[o + 2] += (c[2] - data[o + 2]) * k;
    data[o + 3] += (255 - data[o + 3]) * k;
  }

  /** Anti-aliased thick segment (capsule of the given width). */
  line(ax: number, ay: number, bx: number, by: number, width: number, c: RGB, alpha = 1): void {
    const r = width / 2;
    const x0 = Math.floor(Math.min(ax, bx) - r - 1), x1 = Math.ceil(Math.max(ax, bx) + r + 1);
    const y0 = Math.floor(Math.min(ay, by) - r - 1), y1 = Math.ceil(Math.max(ay, by) + r + 1);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let y = Math.max(0, y0); y <= Math.min(this.img.height - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(this.img.width - 1, x1); x++) {
        const px = x + 0.5, py = y + 0.5;
        const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
        const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        const cover = Math.min(1, Math.max(0, r + 0.5 - d));
        if (cover > 0) this.blend(x, y, c, cover * alpha);
      }
    }
  }

  dot(x: number, y: number, radius: number, c: RGB, alpha = 1): void {
    this.line(x, y, x, y, radius * 2, c, alpha);
  }
}

/** Copy of `image` with the analysis drawn on it (landmarks are rescaled if the analysis used another size). */
export function drawLandmarks(image: RGBAImage, analysis: HumanAnalysis): RGBAImage {
  const out: RGBAImage = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  const p = new Painter(out);
  const sx = image.width / Math.max(1, analysis.width), sy = image.height / Math.max(1, analysis.height);
  const X = (l: Landmark) => l.x * sx, Y = (l: Landmark) => l.y * sy;
  const t = Math.max(1, Math.round(Math.min(image.width, image.height) / 300));
  const edges = (pts: Landmark[], list: readonly number[], width: number, c: RGB, minVis = 0) => {
    for (let i = 0; i + 1 < list.length; i += 2) {
      const a = pts[list[i]], b = pts[list[i + 1]];
      if (!a || !b || (a.visibility ?? 1) < minVis || (b.visibility ?? 1) < minVis) continue;
      p.line(X(a), Y(a), X(b), Y(b), width, c, 0.9);
    }
  };

  for (const pose of analysis.poses) {
    edges(pose.landmarks, POSE_EDGES, t * 2, OVERLAY_COLORS.pose, 0.5);
    for (const l of pose.landmarks) if ((l.visibility ?? 1) >= 0.5) p.dot(X(l), Y(l), t * 1.5, OVERLAY_COLORS.joint);
  }
  for (const face of analysis.faces) {
    const L = face.landmarks;
    for (let i = 0; i < L.length; i++) p.dot(X(L[i]), Y(L[i]), Math.max(0.6, t * 0.5), OVERLAY_COLORS.face, 0.75);
    edges(L, FACE_CONTOUR_EDGES, t, OVERLAY_COLORS.face, 0);
  }
  for (const hand of analysis.hands) {
    edges(hand.landmarks, HAND_EDGES, t * 1.5, OVERLAY_COLORS.hand);
    for (const l of hand.landmarks) p.dot(X(l), Y(l), t * 1.2, OVERLAY_COLORS.joint);
  }
  return out;
}
