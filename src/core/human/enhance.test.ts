import { describe, expect, it, vi } from 'vitest';
import { AbortError, type DepthMap, type Mask, type RGBAImage } from '../types';
import {
  humanDetailRegions,
  withDetailRegions,
  applyField,
  enhanceHumanDepth,
  fitRange,
  occlude,
  planCrops,
  REFERENCE_DEPTH_SCALE,
  scaleAnalysis,
} from './enhance';
import { faceRelief, handRelief } from './prior';
import { fakeAnalysis, syntheticFace, syntheticHand } from './testing';
import { FACE } from './topology';
import type { HumanDetailOptions } from './types';

const W = 400, H = 300;
const signal = () => new AbortController().signal;

function image(w = W, h = H): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([205, 160, 135, 255], i * 4);
  return { width: w, height: h, data };
}

function flat(v = 0.5, w = W, h = H): DepthMap {
  return { width: w, height: h, data: new Float32Array(w * h).fill(v) };
}

function stats(d: Float32Array, w: number, box: { x: number; y: number; width: number; height: number }) {
  let s = 0, s2 = 0, n = 0;
  for (let y = Math.floor(box.y); y < box.y + box.height; y++) {
    for (let x = Math.floor(box.x); x < box.x + box.width; x++) {
      const v = d[y * w + x];
      s += v; s2 += v * v; n++;
    }
  }
  const mean = s / n;
  return { mean, variance: s2 / n - mean * mean };
}

const opts = (over: Partial<HumanDetailOptions> = {}): HumanDetailOptions => ({ faceStrength: 0.8, handStrength: 0.7, bodyStrength: 0, signal: signal(), ...over });

describe('enhanceHumanDepth', () => {
  const face = syntheticFace(200, 150, 60, 80);
  const L = face.landmarks;
  // Small enough for the crop pass to raise the resolution (≥ 1.5×).
  const cropFace = syntheticFace(200, 150, 35, 45);
  const at = (d: DepthMap, i: number) => d.data[Math.floor(L[i].y) * d.width + Math.floor(L[i].x)];

  it('is the identity without detections (or with only tiny ones)', async () => {
    const depth = flat();
    expect(await enhanceHumanDepth(depth, null, image(), fakeAnalysis(W, H), opts())).toBe(depth);
    const tiny = fakeAnalysis(W, H, { faces: [syntheticFace(50, 50, 8, 10)], hands: [syntheticHand(300, 200, 5)] });
    expect(await enhanceHumanDepth(depth, null, image(), tiny, opts())).toBe(depth);
    const off = fakeAnalysis(W, H, { faces: [face] });
    expect(await enhanceHumanDepth(depth, null, image(), off, opts({ faceStrength: 0 }))).toBe(depth);
  });

  it('adds face relief inside the face box and leaves the rest untouched', async () => {
    const depth = flat();
    const out = await enhanceHumanDepth(depth, null, image(), fakeAnalysis(W, H, { faces: [face] }), opts());
    expect(out).not.toBe(depth);
    expect(depth.data.every((v) => v === 0.5)).toBe(true); // input not mutated
    const box = face.box;
    expect(stats(out.data, W, box).variance).toBeGreaterThan(stats(depth.data, W, box).variance + 1e-4);
    // Nose in front of the cheeks, eye sockets behind the brows.
    expect(at(out, FACE.noseTip)).toBeGreaterThan(at(out, 205) + 0.05);
    expect(at(out, FACE.rightIris)).toBeLessThan(at(out, 105));
    // Far from the face (and its ears) nothing changes.
    for (const [x, y] of [[5, 5], [395, 295], [200, 5], [200, 295], [30, 150]]) expect(out.data[y * W + x]).toBe(0.5);
    for (const v of out.data) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('scales relief with the face size in the reference depth units', async () => {
    const small = syntheticFace(200, 150, 30, 40);
    const outS = await enhanceHumanDepth(flat(), null, image(), fakeAnalysis(W, H, { faces: [small] }), opts());
    const outL = await enhanceHumanDepth(flat(), null, image(), fakeAnalysis(W, H, { faces: [face] }), opts());
    const bump = (d: DepthMap, f: typeof face) => d.data[Math.floor(f.landmarks[1].y) * W + Math.floor(f.landmarks[1].x)] - 0.5;
    expect(bump(outL, face) / bump(outS, small)).toBeGreaterThan(1.5);
    // Physical scale: nose relief (px) ≈ strength · landmark relief / (longest side · reference depth scale).
    const f = faceRelief(face, W, H)!;
    const expected = (0.8 * f.span) / (Math.max(W, H) * REFERENCE_DEPTH_SCALE);
    expect(bump(outL, face)).toBeGreaterThan(0.3 * expected);
    expect(bump(outL, face)).toBeLessThan(1.5 * expected);
  });

  it('only tops up detail the depth does not already have', async () => {
    const first = await enhanceHumanDepth(flat(), null, image(), fakeAnalysis(W, H, { faces: [face] }), opts());
    const again = await enhanceHumanDepth(first, null, image(), fakeAnalysis(W, H, { faces: [face] }), opts());
    const gain1 = at(first, FACE.noseTip) - 0.5;
    const gain2 = at(again, FACE.noseTip) - at(first, FACE.noseTip);
    expect(gain1).toBeGreaterThan(0.05);
    expect(Math.abs(gain2)).toBeLessThan(0.15 * gain1);
    // A stronger setting adds only the difference.
    const more = await enhanceHumanDepth(first, null, image(), fakeAnalysis(W, H, { faces: [face] }), opts({ faceStrength: 1.2 }));
    expect(at(more, FACE.noseTip) - at(first, FACE.noseTip)).toBeGreaterThan(0.2 * gain1);
  });

  it('only changes foreground pixels and keeps [0, 1]', async () => {
    const mask: Mask = { width: W, height: H, data: new Uint8Array(W * H) };
    for (let y = 0; y < H; y++) for (let x = 0; x < 200; x++) mask.data[y * W + x] = 1; // left half only
    const depth = flat(0.97);
    for (let i = 0; i < W * H; i++) if (!mask.data[i]) depth.data[i] = 0;
    const out = await enhanceHumanDepth(depth, mask, image(), fakeAnalysis(W, H, { faces: [face] }), opts({ faceStrength: 1.5 }));
    let max = 0;
    for (let i = 0; i < W * H; i++) {
      if (!mask.data[i]) expect(out.data[i]).toBe(0);
      max = Math.max(max, out.data[i]);
      expect(out.data[i]).toBeLessThanOrEqual(1);
      expect(out.data[i]).toBeGreaterThanOrEqual(0);
    }
    expect(max).toBeCloseTo(1, 5);
    expect(out.data[150 * W + 120]).toBeGreaterThan(out.data[150 * W + 60] - 1e-6); // nose side vs cheek side
  });

  it('adds finger relief and keeps faces behind hands that cover them', async () => {
    const hand = syntheticHand(200, 250, 50);
    const out = await enhanceHumanDepth(flat(), null, image(), fakeAnalysis(W, H, { hands: [hand] }), opts());
    const HL = hand.landmarks;
    const mid = { x: (HL[10].x + HL[11].x) / 2, y: (HL[10].y + HL[11].y) / 2 };
    expect(out.data[Math.floor(mid.y) * W + Math.floor(mid.x)]).toBeGreaterThan(out.data[Math.floor(mid.y) * W + Math.floor(mid.x + 4)]);

    const ff = faceRelief(face, W, H)!;
    const before = ff.weight.reduce((a, b) => a + b, 0);
    occlude(ff, [handRelief(syntheticHand(200, 220, 40), W, H)!]);
    expect(ff.weight.reduce((a, b) => a + b, 0)).toBeLessThan(before * 0.95);
  });

  it('runs the high-res crop pass: aligned, feathered, largest faces first', async () => {
    // Global depth: flat. Crop depth: a tilted plane in the crop's own (arbitrary) affine units.
    const refineCrop = vi.fn(async (crop: RGBAImage) => {
      const d = new Float32Array(crop.width * crop.height);
      for (let y = 0; y < crop.height; y++) for (let x = 0; x < crop.width; x++) d[y * crop.width + x] = 3 * (x / crop.width) + 7;
      return { width: crop.width, height: crop.height, data: d };
    });
    const faceB = syntheticFace(330, 80, 25, 32);
    const analysis = fakeAnalysis(W, H, { faces: [faceB, cropFace] });
    const progress: string[] = [];
    const out = await enhanceHumanDepth(flat(), null, image(), analysis, opts({ faceStrength: 0, refineCrop, onProgress: (p) => progress.push(p.label.en) }));
    // faceStrength 0 disables faces entirely (no crops either).
    expect(refineCrop).not.toHaveBeenCalled();
    expect(out.data.every((v) => v === 0.5)).toBe(true);

    await enhanceHumanDepth(flat(), null, image(), analysis, opts({ refineCrop, onProgress: (p) => progress.push(p.label.en) }));
    expect(refineCrop).toHaveBeenCalledTimes(2);
    const [crop1] = refineCrop.mock.calls[0];
    expect(crop1.width).toBeGreaterThan(cropFace.box.width * 1.5); // the larger face, expanded by 35 % per side
    expect(progress).toContain('Face detail: high-res pass (1/2)…');
    expect(progress.at(-1)).toBe('Adding face and hand relief…');
  });

  it('aligns crop depth to the global depth (scale + offset)', async () => {
    // Global depth has a gentle ramp; the crop reports the same ramp ×4 + 2 plus fine detail the global pass missed.
    const depth = flat();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) depth.data[y * W + x] = 0.3 + 0.4 * (x / W);
    let cropBox = { x: 0, y: 0 };
    const refineCrop = async (crop: RGBAImage) => {
      const d = new Float32Array(crop.width * crop.height);
      for (let y = 0; y < crop.height; y++) {
        for (let x = 0; x < crop.width; x++) {
          const gx = cropBox.x + x;
          const detail = (x + y) % 8 < 4 ? 0.01 : -0.01;
          d[y * crop.width + x] = 4 * (0.3 + 0.4 * (gx / W) + detail) + 2;
        }
      }
      return { width: crop.width, height: crop.height, data: d };
    };
    const jobs = planCrops(fakeAnalysis(W, H, { faces: [cropFace] }), { maxCrops: 6, faces: true, hands: true });
    expect(jobs).toHaveLength(1);
    cropBox = jobs[0].box;
    const out = await enhanceHumanDepth(depth, null, image(), fakeAnalysis(W, H, { faces: [cropFace] }), opts({ faceStrength: 0.0001, refineCrop }));
    const cx = Math.floor(cropFace.box.x + cropFace.box.width / 2), cy = Math.floor(cropFace.box.y + cropFace.box.height / 2);
    const base = 0.3 + 0.4 * (cx / W);
    const i = cy * W + cx;
    expect(Math.abs(out.data[i] - base)).toBeLessThan(0.02);
    expect(Math.abs(out.data[i] - base)).toBeGreaterThan(0.005); // the crop's detail is in
    expect(out.data[5]).toBe(depth.data[5]);
  });

  it('skips crops that would not add resolution and honours maxCrops', () => {
    const big = syntheticFace(200, 150, 190, 145);
    expect(planCrops(fakeAnalysis(W, H, { faces: [big] }), { maxCrops: 6, faces: true, hands: true })).toHaveLength(0);
    const many = fakeAnalysis(W, H, {
      faces: [syntheticFace(60, 60, 20, 25), syntheticFace(200, 60, 25, 30)],
      hands: [syntheticHand(100, 250, 20), syntheticHand(300, 250, 25)],
    });
    const jobs = planCrops(many, { maxCrops: 3, faces: true, hands: true });
    expect(jobs.map((j) => j.kind)).toEqual(['face', 'face', 'hand']);
    expect(jobs[0].box.width).toBeGreaterThan(jobs[1].box.width);
    expect(planCrops(many, { maxCrops: 6, faces: false, hands: true }).every((j) => j.kind === 'hand')).toBe(true);
  });

  it('only plans crops that beat the global pass at its inference side', () => {
    const S = 1024;
    // A 400 px face box → a 680 px crop: gain sqrt(1024² / 680²) ≈ 1.506 at equal sides.
    const a = fakeAnalysis(S, S, { faces: [syntheticFace(512, 512, 200, 200)] });
    const [job] = planCrops(a, { maxCrops: 6, faces: true, hands: true });
    expect(job.box.width).toBeGreaterThan(600);
    expect(planCrops(a, { maxCrops: 6, faces: true, hands: true, sideRatio: 518 / 518 })).toHaveLength(1);
    // Global pass at 840, crops at 518: the crop would be coarser than the global depth.
    expect(planCrops(a, { maxCrops: 6, faces: true, hands: true, sideRatio: 518 / 840 })).toHaveLength(0);
    const small = fakeAnalysis(S, S, { faces: [syntheticFace(512, 512, 60, 75)] });
    expect(planCrops(small, { maxCrops: 6, faces: true, hands: true, sideRatio: 518 / 840 })).toHaveLength(1);
  });

  it('aborts', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(enhanceHumanDepth(flat(), null, image(), fakeAnalysis(W, H, { faces: [face] }), opts({ signal: ac.signal }))).rejects.toBeInstanceOf(AbortError);
    const ac2 = new AbortController();
    const refineCrop = async (crop: RGBAImage) => {
      ac2.abort();
      return { width: crop.width, height: crop.height, data: new Float32Array(crop.width * crop.height) };
    };
    await expect(
      enhanceHumanDepth(flat(), null, image(), fakeAnalysis(W, H, { faces: [cropFace] }), opts({ signal: ac2.signal, refineCrop })),
    ).rejects.toBeInstanceOf(AbortError);
  });

  it('maps an analysis made at another resolution', async () => {
    const a = fakeAnalysis(W * 2, H * 2, { faces: [syntheticFace(400, 300, 120, 160)] });
    const s = scaleAnalysis(a, W, H);
    expect(s.faces[0].landmarks[1].x).toBeCloseTo(a.faces[0].landmarks[1].x / 2, 5);
    expect(s.faces[0].landmarks[1].z).toBeCloseTo(a.faces[0].landmarks[1].z / 2, 5);
    expect(s.faces[0].box.width).toBeCloseTo(a.faces[0].box.width / 2, 5);
    const out = await enhanceHumanDepth(flat(), null, image(W * 2, H * 2), a, opts());
    expect(out.width).toBe(W);
    expect(out.data[150 * W + 200]).toBeGreaterThan(0.5);
  });
});

describe('applyField / fitRange', () => {
  it('does nothing at zero strength or without coverage under the mask', () => {
    const f = faceRelief(syntheticFace(200, 150, 60, 80), W, H)!;
    const out = new Float32Array(W * H).fill(0.5);
    expect(applyField(out, W, null, f, 0, 0.01)).toBe(false);
    const empty: Mask = { width: W, height: H, data: new Uint8Array(W * H) };
    expect(applyField(out, W, empty, f, 1, 0.01)).toBe(false);
    expect(out.every((v) => v === 0.5)).toBe(true);
  });

  it('rescales an overshooting foreground into [0, 1] and clamps', () => {
    const out = Float32Array.from([0.2, 0.6, 1.4, -0.1, 0.9]);
    const mask: Mask = { width: 5, height: 1, data: Uint8Array.from([1, 1, 1, 1, 0]) };
    fitRange(out, mask);
    expect(out[2]).toBeCloseTo(1, 5);
    expect(out[0]).toBeGreaterThanOrEqual(0);
    expect(out[3]).toBe(0);
    expect(out[4]).toBeCloseTo(0.9, 6); // background untouched
    expect(out[1]).toBeLessThan(0.6);
  });
});

describe('humanDetailRegions', () => {
  it('covers faces (with room for the ears) and hands, scaled to the depth grid, skipping tiny ones', () => {
    const face = syntheticFace(200, 150, 60, 80);
    const hand = syntheticHand(320, 220, 40);
    const tiny = syntheticFace(40, 40, 8, 10);
    const a = fakeAnalysis(W, H, { faces: [face, tiny], hands: [hand] });
    const r = humanDetailRegions(a, W, H);
    expect(r.map((x) => x.kind)).toEqual(['face', 'hand']);
    const [f, h] = r;
    const side = Math.max(face.box.width, face.box.height);
    expect(face.box.x - f.x).toBeGreaterThanOrEqual(0.19 * side);
    expect(f.x + f.width - (face.box.x + face.box.width)).toBeGreaterThanOrEqual(0.19 * side);
    expect(h.x).toBeLessThan(hand.box.x);
    for (const b of r) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(W);
      expect(b.y + b.height).toBeLessThanOrEqual(H);
    }
    // Half-size depth grid: half-size regions.
    const half = humanDetailRegions(a, W / 2, H / 2);
    expect(half[0].width).toBeCloseTo(f.width / 2, -0.5);
  });

  it('withDetailRegions shares the data and leaves the depth alone without regions', () => {
    const depth: DepthMap = { width: 2, height: 1, data: new Float32Array(2) };
    expect(withDetailRegions(depth, [])).toBe(depth);
    const out = withDetailRegions(depth, [{ kind: 'hand', x: 0, y: 0, width: 1, height: 1 }]) as DepthMap & { detail?: unknown[] };
    expect(out.data).toBe(depth.data);
    expect(out.detail).toHaveLength(1);
    expect('detail' in depth).toBe(false);
  });
});
