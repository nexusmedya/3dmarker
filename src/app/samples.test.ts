/**
 * The "hand-drawn views" T-pose sample: same front as the consistent mannequin,
 * views drawn with an artist's own framing (SKETCH_PERTURBATIONS). Canvas 2D is
 * not available in Node, so the drawings run against a recording context.
 */
import { describe, expect, it } from 'vitest';
import { SAMPLES, SKETCH_PERTURBATIONS, type SampleSpec } from './samples';

interface Call {
  name: string;
  args: unknown[];
}

/** Runs `draw` on a context that records every method call (gradients are stubs). */
function record(draw: SampleSpec['draw'], w: number, h: number): Call[] {
  const calls: Call[] = [];
  const gradient = { addColorStop: () => {} };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === 'getImageData') return (_x: number, _y: number, cw: number, ch: number) => ({ data: new Uint8ClampedArray(cw * ch * 4) });
      if (prop.startsWith('create')) return () => gradient;
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
        for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) throw new Error(`${prop}: non-finite arg`);
      };
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  });
  draw(ctx as unknown as CanvasRenderingContext2D, w, h);
  return calls;
}

/** Centre rows (fractions of the height) of the `arc` calls: the limbs' round caps and the profile's hand disc. */
function arcRows(calls: Call[], h: number): number[] {
  return calls.filter((c) => c.name === 'arc').map((c) => Math.round(((c.args[1] as number) / h) * 1e4) / 1e4);
}

const FRONT_ARM_Y = 0.275;
/** Bottom of the mannequin's shoes as a fraction of the height (see drawMannequinProfile). */
const SOLE_Y = 0.945;

describe('samples: T-pose mannequin with hand-drawn views', () => {
  const tpose = SAMPLES.find((s) => s.id === 'tpose')!;
  const sketch = SAMPLES.find((s) => s.id === 'tpose-sketch')!;

  it('is the fifth sample, shares the consistent mannequin front and comes with back / left / right views', () => {
    expect(SAMPLES.slice(0, 4).map((s) => s.id)).toEqual(['logo', 'mascot', 'landscape', 'tpose']); // existing E2E uses sample-3
    expect(SAMPLES[4]).toBe(sketch);
    expect(sketch).toMatchObject({ fileName: 'sample-tpose-sketch.png', width: 768, height: 768, driverId: 'multiview-fusion' });
    expect(sketch.draw).toBe(tpose.draw);
    expect(Object.keys(sketch.views ?? {}).sort()).toEqual(['back', 'left', 'right']);
    expect(sketch.name.tr).not.toBe(tpose.name.tr);
    expect(sketch.name.en).not.toBe(tpose.name.en);
  });

  it('perturbations: the reported case, with the left view cut off at the bottom border', () => {
    expect(SKETCH_PERTURBATIONS.back).toEqual({ scale: 0.95, dx: 0, dy: 0.03, armY: 0.305 });
    expect(SKETCH_PERTURBATIONS.left).toEqual({ scale: 1.08, dx: 0, dy: 0.06, armY: 0.255 });
    expect(SKETCH_PERTURBATIONS.right).toEqual({ scale: 0.9, dx: 0.03, dy: 0, armY: 0.315 });
    // Where the soles land after the similarity (fraction of the height): past 1 = cropped.
    const sole = (p: { scale: number; dy: number }) => 0.5 + p.dy + p.scale * (SOLE_Y - 0.5);
    expect(sole(SKETCH_PERTURBATIONS.left)).toBeGreaterThan(1.02);
    expect(sole(SKETCH_PERTURBATIONS.back)).toBeLessThan(1);
    expect(sole(SKETCH_PERTURBATIONS.right)).toBeLessThan(1);
    // Every arm row differs from the front's by at least 2 % of the height (what the fusion must absorb).
    for (const p of Object.values(SKETCH_PERTURBATIONS)) expect(Math.abs(p.armY - FRONT_ARM_Y)).toBeGreaterThanOrEqual(0.02);
  });

  it('draws each view through the similarity transform and restores the context', () => {
    const w = 96, h = 64;
    for (const [view, p] of Object.entries(SKETCH_PERTURBATIONS) as [keyof typeof SKETCH_PERTURBATIONS, (typeof SKETCH_PERTURBATIONS)['back']][]) {
      const calls = record(sketch.views![view]!, w, h);
      expect(calls[0].name, view).toBe('clearRect');
      expect(calls[1].name, view).toBe('save');
      expect(calls[2], view).toEqual({ name: 'translate', args: [w / 2 + p.dx * w, h / 2 + p.dy * h] });
      expect(calls[3], view).toEqual({ name: 'scale', args: [p.scale, p.scale] });
      expect(calls[4], view).toEqual({ name: 'translate', args: [-w / 2, -h / 2] });
      expect(calls[calls.length - 1].name, view).toBe('restore');
      expect(calls.filter((c) => c.name === 'save').length, view).toBe(calls.filter((c) => c.name === 'restore').length);
      expect(calls.length, view).toBeGreaterThan(10);
    }
  });

  it('places the arms at the view’s own height while the consistent sample keeps the front’s', () => {
    const w = 200, h = 200;
    for (const view of ['back', 'left', 'right'] as const) {
      expect(arcRows(record(sketch.views![view]!, w, h), h), `sketch ${view}`).toContain(SKETCH_PERTURBATIONS[view].armY);
      expect(arcRows(record(sketch.views![view]!, w, h), h), `sketch ${view}`).not.toContain(FRONT_ARM_Y);
      expect(arcRows(record(tpose.views![view]!, w, h), h), `tpose ${view}`).toContain(FRONT_ARM_Y);
    }
    expect(arcRows(record(sketch.draw, w, h), h)).toContain(FRONT_ARM_Y);
  });
});
