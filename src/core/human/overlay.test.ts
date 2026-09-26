import { describe, expect, it } from 'vitest';
import { drawLandmarks, OVERLAY_COLORS } from './overlay';
import { fakeAnalysis, syntheticFace, syntheticHand, syntheticPose } from './testing';
import { POSE } from './types';

function gray(w: number, h: number, alpha = 255) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([100, 100, 100, alpha], i * 4);
  return { width: w, height: h, data };
}

const px = (img: { width: number; data: Uint8ClampedArray }, x: number, y: number) => {
  const o = (Math.floor(y) * img.width + Math.floor(x)) * 4;
  return [...img.data.subarray(o, o + 4)];
};

describe('drawLandmarks', () => {
  it('returns a same-size copy and leaves the input alone', () => {
    const img = gray(120, 80);
    const out = drawLandmarks(img, fakeAnalysis(120, 80));
    expect(out.width).toBe(120);
    expect(out.height).toBe(80);
    expect(out.data).not.toBe(img.data);
    expect(out.data).toEqual(img.data);
  });

  it('draws the pose skeleton, hand skeleton and face mesh', () => {
    const img = gray(400, 400, 0);
    const pose = syntheticPose(200, 10, 380);
    const hand = syntheticHand(60, 380, 40);
    const face = syntheticFace(330, 80, 40, 50);
    const out = drawLandmarks(img, fakeAnalysis(400, 400, { poses: [pose], hands: [hand], faces: [face] }));
    expect(img.data.every((v, i) => (i % 4 === 3 ? v === 0 : v === 100))).toBe(true);
    // Mid-thigh lies on a pose bone.
    const L = pose.landmarks;
    const thigh = px(out, (L[POSE.leftHip].x + L[POSE.leftKnee].x) / 2, (L[POSE.leftHip].y + L[POSE.leftKnee].y) / 2);
    expect(thigh.slice(0, 3)).toEqual([...OVERLAY_COLORS.pose].map((c) => expect.closeTo(c, -1.5)));
    expect(thigh[3]).toBeGreaterThan(200);
    // Hand joints are white dots; face points are tinted.
    expect(px(out, hand.landmarks[12].x, hand.landmarks[12].y).slice(0, 3)).toEqual([255, 255, 255]);
    const nose = px(out, face.landmarks[1].x, face.landmarks[1].y);
    expect(nose[1]).toBeGreaterThan(nose[0]);
    // Untouched pixel stays transparent.
    expect(px(out, 395, 5)[3]).toBe(0);
  });

  it('rescales landmarks from another analysis size', () => {
    const img = gray(100, 100);
    const pose = syntheticPose(100, 10, 180); // analysed at 200 × 200
    const out = drawLandmarks(img, fakeAnalysis(200, 200, { poses: [pose] }));
    const L = pose.landmarks;
    expect(px(out, L[POSE.leftKnee].x / 2, L[POSE.leftKnee].y / 2).slice(0, 3)).toEqual([255, 255, 255]);
  });
});
