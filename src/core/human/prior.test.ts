import { describe, expect, it } from 'vitest';
import { bodyRelief, earProfile, earReliefs, faceRelief, faceReliefs, handRelief, palmLength, reliefAt, unitRelief } from './prior';
import { syntheticFace, syntheticHand, syntheticPose } from './testing';
import { FACE } from './topology';
import { POSE } from './types';

const W = 400, H = 400;

function solid(r: number, g: number, b: number) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([r, g, b, 255], i * 4);
  return { width: W, height: H, data };
}

describe('faceRelief', () => {
  const face = syntheticFace(200, 200, 100, 130);
  const L = face.landmarks;
  const f = faceRelief(face, W, H)!;

  it('peaks at the nose, above the cheeks, forehead and chin', () => {
    const nose = reliefAt(f, L[FACE.noseTip].x, L[FACE.noseTip].y, true);
    expect(nose).toBeGreaterThan(0.9);
    for (const cheek of [205, 425, 50, 280]) expect(nose).toBeGreaterThan(reliefAt(f, L[cheek].x, L[cheek].y, true) + 0.2);
    expect(nose).toBeGreaterThan(reliefAt(f, L[FACE.forehead].x, L[FACE.forehead].y + 5, true));
    expect(nose).toBeGreaterThan(reliefAt(f, L[FACE.chin].x, L[FACE.chin].y - 5, true));
  });

  it('sinks the eye sockets below the brows', () => {
    const iris = reliefAt(f, L[FACE.rightIris].x, L[FACE.rightIris].y);
    const brow = reliefAt(f, L[105].x, L[105].y);
    expect(iris).toBeLessThan(brow);
  });

  it('stays in [0, 1] (unit relief) with feathered edges and nothing outside the face', () => {
    const u = unitRelief(f);
    let max = 0, min = Infinity;
    for (const v of u) { max = Math.max(max, v); min = Math.min(min, v); }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(1);
    expect(max).toBeGreaterThan(0.9);
    // The outline (oval) is feathered out; the far corner of the region is not covered at all.
    const side = L[FACE.rightSide];
    expect(f.weight[(Math.floor(side.y) - f.y0) * f.width + Math.floor(side.x) - f.x0]).toBeLessThan(0.3);
    expect(f.weight[0]).toBe(0);
    expect(f.rimRadius).toBeGreaterThan(f.bands[0]);
  });

  it('follows the landmark depth (a flat face has no relief) and rejects bad input', () => {
    // Flat landmarks: only the recessed mouth opening remains.
    const flatFace = syntheticFace(200, 200, 100, 130, { depth: 0 });
    const flat = faceRelief(flatFace, W, H)!;
    expect(flat.span).toBeLessThanOrEqual(0.03 * flat.size + 1e-3);
    const FL = flatFace.landmarks;
    expect(reliefAt(flat, FL[FACE.noseTip].x, FL[FACE.noseTip].y)).toBeCloseTo(reliefAt(flat, FL[205].x, FL[205].y), 3);
    expect(faceRelief({ landmarks: L.slice(0, 100), box: face.box }, W, H)).toBeNull();
    expect(faceRelief(syntheticFace(200, 200, 3, 3), W, H)).toBeNull();
    const nan = { ...face, landmarks: L.map((p, i) => (i === 5 ? { ...p, z: NaN } : p)) };
    expect(faceRelief(nan, W, H)).toBeNull();
  });

  it('clips at the image border (partial faces)', () => {
    const edge = faceRelief(syntheticFace(20, 200, 100, 130), W, H)!;
    expect(edge.x0).toBe(0);
    expect(edge.span).toBeGreaterThan(0);
  });
});

describe('ears', () => {
  const face = syntheticFace(200, 200, 100, 130);
  const L = face.landmarks;

  it('adds two ear fields beside the outline with a raised rim', () => {
    const ears = earReliefs(face, W, H);
    expect(ears).toHaveLength(2);
    const [right, left] = ears;
    expect(right.x0 + right.width / 2).toBeLessThan(L[FACE.rightSide].x);
    expect(left.x0 + left.width / 2).toBeGreaterThan(L[FACE.leftSide].x);
    expect(earProfile(0.78)).toBeGreaterThan(earProfile(0.1));
    expect(faceReliefs(face, W, H)).toHaveLength(3);
    expect(faceReliefs(face, W, H, { ears: false })).toHaveLength(1);
  });

  it('keeps ears only on skin-coloured pixels', () => {
    expect(earReliefs(face, W, H, { image: solid(210, 160, 130) })).toHaveLength(2);
    // Skin-coloured cheeks, dark hair everywhere else.
    const img = solid(40, 30, 25);
    for (let y = 0; y < H; y++) for (let x = 120; x < 280; x++) img.data.set([210, 160, 130, 255], (y * W + x) * 4);
    const hidden = earReliefs(face, W, H, { image: img });
    const total = hidden.reduce((s, e) => s + e.weight.reduce((a, b) => a + b, 0), 0);
    expect(total).toBeLessThan(1);
  });

  it('hides the ear a turned head points away', () => {
    // Nose moved next to the right outline: head turned, right ear hidden.
    const turned = { ...face, landmarks: L.map((p, i) => (i === FACE.noseTip ? { ...p, x: L[FACE.rightSide].x + 10 } : p)) };
    const ears = earReliefs(turned, W, H);
    expect(ears).toHaveLength(1);
    expect(ears[0].x0).toBeGreaterThan(200);
  });
});

describe('handRelief', () => {
  const hand = syntheticHand(200, 300, 80);
  const L = hand.landmarks;
  const f = handRelief(hand, W, H)!;

  it('makes fingers round (axis above edges) and domes the palm', () => {
    const r = 0.1 * palmLength(L);
    const mid = { x: (L[10].x + L[11].x) / 2, y: (L[10].y + L[11].y) / 2 };
    const axis = reliefAt(f, mid.x, mid.y);
    const edge = reliefAt(f, mid.x + 0.8 * r, mid.y);
    expect(axis).toBeGreaterThan(edge + 0.2 * r);
    // Flat hand (z = 0): the plane sits r above the webbing gaps; the palm dome rises above it.
    const palmC = { x: (L[0].x + L[9].x) / 2, y: (L[0].y + L[9].y) / 2 };
    expect(reliefAt(f, palmC.x, palmC.y)).toBeGreaterThan(r + 0.5 * 0.12 * palmLength(L));
  });

  it('puts the gaps between spread fingers behind the fingers', () => {
    const gap = { x: (L[8].x + L[12].x) / 2, y: (L[8].y + L[12].y) / 2 + 0.1 * 80 };
    const tip = reliefAt(f, L[12].x, L[12].y + 3);
    const g = reliefAt(f, gap.x, gap.y);
    expect(g).toBeLessThan(tip);
    const i = (Math.floor(gap.y) - f.y0) * f.width + Math.floor(gap.x) - f.x0;
    expect(f.weight[i]).toBeGreaterThan(0);
    expect(f.weight[i]).toBeLessThanOrEqual(0.6 + 1e-6);
  });

  it('follows landmark z and rejects tiny / incomplete hands', () => {
    const tilted = syntheticHand(200, 300, 80);
    tilted.landmarks = tilted.landmarks.map((p, k) => (k >= 5 && k <= 8 ? { ...p, z: -30 } : p)); // index finger towards the camera
    const t = handRelief(tilted, W, H)!;
    const Lt = tilted.landmarks;
    expect(reliefAt(t, Lt[7].x, Lt[7].y)).toBeGreaterThan(reliefAt(t, Lt[15].x, Lt[15].y) + 20);
    expect(handRelief(syntheticHand(200, 300, 3), W, H)).toBeNull();
    expect(handRelief({ ...hand, landmarks: L.slice(0, 10) }, W, H)).toBeNull();
  });
});

describe('bodyRelief', () => {
  it('rounds limbs and the torso, skipping invisible joints', () => {
    const pose = syntheticPose(200, 10, 380);
    const f = bodyRelief(pose, W, H)!;
    const L = pose.landmarks;
    const thigh = { x: (L[POSE.leftHip].x + L[POSE.leftKnee].x) / 2, y: (L[POSE.leftHip].y + L[POSE.leftKnee].y) / 2 };
    const S = Math.abs(L[POSE.leftShoulder].x - L[POSE.rightShoulder].x);
    expect(reliefAt(f, thigh.x, thigh.y)).toBeGreaterThan(reliefAt(f, thigh.x + 0.15 * S, thigh.y));
    const chest = { x: 200, y: (L[POSE.leftShoulder].y + L[POSE.leftHip].y) / 2 };
    expect(reliefAt(f, chest.x, chest.y)).toBeGreaterThan(reliefAt(f, L[POSE.leftShoulder].x - 2, chest.y));

    const hidden = syntheticPose(200, 10, 380, 0.1);
    expect(bodyRelief(hidden, W, H)).toBeNull();
    expect(bodyRelief(syntheticPose(200, 10, 20), W, H)).toBeNull();
  });
});
