import { describe, expect, it } from 'vitest';
import type { DepthMap, Mask } from '../core/types';
import { DEPTH_HEADROOM, DEPTH_RAISE_STEP, DepthEditState, maskForSize, spacedPoints, unionRect, type DepthDab } from './depthBrush';
import { imageForSize, renderDepthRegion, turbo } from './depthRender';
import { sanitizeBrushSettings, stepRadius, stepStrength } from './settings';
import { DEFAULT_BRUSH } from './types';

const W = 40, H = 30;
const flat = (v = 0.5): DepthMap => ({ width: W, height: H, data: new Float32Array(W * H).fill(v) });
const at = (s: DepthEditState, x: number, y: number) => s.data[y * W + x];
const dab = (o: Partial<DepthDab> = {}): DepthDab => ({ x: 20, y: 15, radius: 6, strength: 1, brush: 'raise', falloff: 'smooth', ...o });

describe('DepthEditState brushes', () => {
  it('raise / lower change depth inside the radius only, clamped to [0, headroom]', () => {
    const s = new DepthEditState(flat(), null);
    const rect = s.dab(dab());
    expect(rect).toEqual({ x0: 14, y0: 9, x1: 26, y1: 21 });
    expect(at(s, 20, 15)).toBeGreaterThan(0.5);
    expect(at(s, 20, 15)).toBeLessThanOrEqual(0.5 + DEPTH_RAISE_STEP + 1e-6);
    expect(at(s, 2, 2)).toBe(0.5);
    expect(at(s, 27, 15)).toBe(0.5);
    s.dab(dab({ brush: 'lower' }));
    s.dab(dab({ brush: 'lower' }));
    expect(at(s, 20, 15)).toBeLessThan(0.5);
    // The nearest point can still be raised: the output is rescaled into [0, 1].
    const top = new DepthEditState(flat(0.995), null);
    for (let k = 0; k < 5; k++) top.dab(dab());
    expect(at(top, 20, 15)).toBeGreaterThan(1);
    const out = top.toDepthMap();
    expect(Math.max(...out.data)).toBeCloseTo(1, 6);
    expect(out.data[15 * W + 20]).toBeCloseTo(1, 6);
    expect(out.data[2 * W + 2]).toBeCloseTo(0.995 / at(top, 20, 15), 6);
    expect(out.data[2 * W + 2]).toBeLessThan(0.995);
    const floor = new DepthEditState(flat(0.01), null);
    for (let k = 0; k < 5; k++) floor.dab(dab({ brush: 'lower' }));
    expect(at(floor, 20, 15)).toBe(0);
    const high = new DepthEditState(flat(DEPTH_HEADROOM - 0.001), null);
    high.dab(dab());
    expect(at(high, 20, 15)).toBe(DEPTH_HEADROOM);
  });

  it('does not paint outside the mask while mask-only is on', () => {
    const mask: Mask = { width: W, height: H, data: new Uint8Array(W * H) };
    for (let y = 0; y < H; y++) for (let x = 0; x < 20; x++) mask.data[y * W + x] = 1;
    const s = new DepthEditState(flat(), mask);
    s.dab(dab());
    expect(at(s, 19, 15)).toBeGreaterThan(0.5);
    expect(at(s, 20, 15)).toBe(0.5);
    s.maskOnly = false;
    s.dab(dab());
    expect(at(s, 20, 15)).toBeGreaterThan(0.5);
    // Nothing editable under the brush → no rect.
    s.maskOnly = true;
    expect(s.dab(dab({ x: 35, radius: 2 }))).toBeNull();
  });

  it('smooth lowers variance, flatten pulls towards the mean, erase restores the original', () => {
    const noisy = flat();
    let seed = 3;
    for (let i = 0; i < noisy.data.length; i++) noisy.data[i] = 0.5 + (((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5) * 0.2;
    const variance = (s: DepthEditState) => {
      const v: number[] = [];
      for (let y = 12; y < 18; y++) for (let x = 17; x < 23; x++) v.push(at(s, x, y));
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      return v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length;
    };
    const sm = new DepthEditState(noisy, null);
    const v0 = variance(sm);
    for (let k = 0; k < 3; k++) sm.dab(dab({ brush: 'smooth', radius: 10 }));
    expect(variance(sm)).toBeLessThan(v0 * 0.3);

    const fl = new DepthEditState(noisy, null);
    for (let k = 0; k < 4; k++) fl.dab(dab({ brush: 'flatten', radius: 10 }));
    expect(variance(fl)).toBeLessThan(v0 * 0.3);

    const er = new DepthEditState(flat(), null);
    for (let k = 0; k < 4; k++) er.dab(dab());
    er.dab(dab({ brush: 'erase', falloff: 'constant', radius: 10 }));
    expect(at(er, 20, 15)).toBe(0.5);
    expect(er.edited).toBe(false);
  });

  it('smooth does not pull the background into the masked foreground', () => {
    const d = flat(0);
    const mask: Mask = { width: W, height: H, data: new Uint8Array(W * H) };
    for (let y = 0; y < H; y++) for (let x = 0; x < 20; x++) {
      mask.data[y * W + x] = 1;
      d.data[y * W + x] = 0.8;
    }
    const s = new DepthEditState(d, mask);
    s.dab(dab({ brush: 'smooth', x: 19, radius: 8 }));
    expect(at(s, 19, 15)).toBeCloseTo(0.8, 6);
  });

  it('smooth matches a brute-force masked box mean (windows clipped at the image edges)', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const [x, y, radius, masked] of [
      [3, 4, 13, true],
      [20, 15, 30, true],
      [37, 27, 9, false],
      [20, 15, 6, true],
    ] as const) {
      const d = flat();
      for (let i = 0; i < d.data.length; i++) d.data[i] = 0.2 + 0.6 * rnd();
      const mask: Mask = { width: W, height: H, data: new Uint8Array(W * H) };
      for (let i = 0; i < mask.data.length; i++) mask.data[i] = rnd() < 0.7 ? 1 : 0;
      const s = new DepthEditState(d, masked ? mask : null);
      const src = s.data.slice();
      const rect = s.dab({ x, y, radius, strength: 1, brush: 'smooth', falloff: 'constant' })!;
      const k = Math.max(1, Math.round(radius / 6));
      let checked = 0;
      for (let py = rect.y0; py < rect.y1; py++)
        for (let px = rect.x0; px < rect.x1; px++) {
          const i = py * W + px;
          const inside = Math.hypot(px + 0.5 - x, py + 0.5 - y) < radius && (!masked || mask.data[i]);
          if (!inside) {
            expect(s.data[i]).toBe(src[i]);
            continue;
          }
          let sum = 0, cnt = 0;
          for (let yy = Math.max(0, py - k); yy <= Math.min(H - 1, py + k); yy++)
            for (let xx = Math.max(0, px - k); xx <= Math.min(W - 1, px + k); xx++) {
              if (masked && !mask.data[yy * W + xx]) continue;
              sum += src[yy * W + xx];
              cnt++;
            }
          expect(s.data[i]).toBeCloseTo(sum / cnt, 5);
          checked++;
        }
      expect(checked).toBeGreaterThan(0);
    }
  });

  it('undo / redo restore exact values per stroke', () => {
    const s = new DepthEditState(flat(), null);
    const orig = s.data.slice();
    s.beginStroke();
    s.dab(dab());
    s.dab(dab({ x: 24 }));
    expect(s.endStroke()).toBe(true);
    const after1 = s.data.slice();
    s.beginStroke();
    s.dab(dab({ brush: 'smooth', radius: 12 }));
    s.endStroke();
    expect(s.strokes).toBe(2);
    expect(s.undo()).not.toBeNull();
    expect(s.data).toEqual(after1);
    expect(s.undo()).not.toBeNull();
    expect(s.data).toEqual(orig);
    expect(s.canUndo).toBe(false);
    expect(s.undo()).toBeNull();
    expect(s.redo()).toEqual({ x0: 14, y0: 9, x1: 30, y1: 21 });
    expect(s.data).toEqual(after1);
    // An empty stroke is not recorded; a new stroke drops the redo branch.
    s.beginStroke();
    expect(s.endStroke()).toBe(false);
    s.beginStroke();
    s.dab(dab({ brush: 'lower' }));
    s.endStroke();
    expect(s.canRedo).toBe(false);
    // toDepthMap is a copy.
    const out = s.toDepthMap();
    out.data[0] = 9;
    expect(s.data[0]).toBe(0.5);
  });

  it('caps the stroke history', () => {
    const s = new DepthEditState(flat(), null, 2);
    for (let k = 0; k < 4; k++) {
      s.beginStroke();
      s.dab(dab({ x: 5 + k * 8 }));
      s.endStroke();
    }
    let n = 0;
    while (s.undo()) n++;
    expect(n).toBe(2);
  });
});

describe('stroke spacing', () => {
  it('emits points every `spacing` and carries the remainder', () => {
    const a = spacedPoints({ x: 0, y: 0 }, { x: 10, y: 0 }, 3, 0);
    expect(a.points.map((p) => p.x)).toEqual([3, 6, 9]);
    expect(a.carry).toBeCloseTo(1);
    const b = spacedPoints({ x: 10, y: 0 }, { x: 12, y: 0 }, 3, a.carry);
    expect(b.points.map((p) => p.x)).toEqual([12]);
    expect(b.carry).toBeCloseTo(0);
    const c = spacedPoints({ x: 0, y: 0 }, { x: 1, y: 0 }, 3, 0.5);
    expect(c.points).toHaveLength(0);
    expect(c.carry).toBeCloseTo(1.5);
    expect(spacedPoints({ x: 0, y: 0 }, { x: 1e6, y: 0 }, 1, 0, 16).points).toHaveLength(16);
  });

  it('merges dirty rects', () => {
    expect(unionRect(null, null)).toBeNull();
    expect(unionRect({ x0: 1, y0: 2, x1: 3, y1: 4 }, { x0: 0, y0: 3, x1: 5, y1: 4 })).toEqual({ x0: 0, y0: 2, x1: 5, y1: 4 });
  });
});

describe('depth view rendering', () => {
  it('maps depth to gray / turbo, blends the image and dims outside the mask', () => {
    expect(turbo(0)).toEqual([35, 23, 27]);
    const hot = turbo(0.5);
    expect(hot[1]).toBeGreaterThan(200); // green-ish middle
    const d = new Float32Array([0, 1, 0.5, 0.5]);
    const out = new Uint8ClampedArray(16);
    renderDepthRegion(out, d, 2, 2, { colormap: 'gray', image: null, imageOpacity: 0, mask: new Uint8Array([1, 1, 1, 0]) });
    expect(Array.from(out.slice(0, 8))).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
    expect(out[12]).toBe(Math.round(128 * 0.35));
    const img = new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 0, 0, 0, 0, 255]);
    renderDepthRegion(out, d, 2, 2, { colormap: 'gray', image: img, imageOpacity: 1, mask: null }, { x0: 0, y0: 0, x1: 1, y1: 1 });
    expect(Array.from(out.slice(0, 4))).toEqual([255, 0, 0, 255]);
  });

  it('resamples masks and images to the depth size', () => {
    const m = maskForSize({ width: 2, height: 1, data: new Uint8Array([1, 0]) }, 4, 2)!;
    expect(Array.from(m)).toEqual([1, 1, 0, 0, 1, 1, 0, 0]);
    expect(maskForSize(null, 3, 3)).toBeNull();
    const img = imageForSize({ width: 1, height: 1, data: new Uint8ClampedArray([9, 8, 7, 6]) }, 2, 1)!;
    expect(Array.from(img)).toEqual([9, 8, 7, 6, 9, 8, 7, 6]);
  });
});

describe('brush settings', () => {
  it('sanitises stored settings and steps radius / strength', () => {
    expect(sanitizeBrushSettings(null)).toEqual(DEFAULT_BRUSH);
    expect(sanitizeBrushSettings({ brush: 'clay', radius: 9, strength: 'x', falloff: 'sharp', invert: 1 })).toEqual({
      ...DEFAULT_BRUSH,
      brush: 'clay',
      radius: 0.6,
      falloff: 'sharp',
    });
    expect(stepRadius(0.1, 1)).toBeCloseTo(0.115, 3);
    expect(stepRadius(0.6, 1)).toBe(0.6);
    expect(stepRadius(0.01, -1)).toBe(0.01);
    expect(stepStrength(0.98, 1)).toBe(1);
    expect(stepStrength(0.5, -1)).toBe(0.45);
  });
});
