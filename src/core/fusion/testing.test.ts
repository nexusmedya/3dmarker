import { describe, expect, it } from 'vitest';
import type { Mask, ViewId } from '../types';
import { maskBBox } from './frame';
import {
  artistProportions,
  characterPartAt,
  containsPoint,
  cylinderX,
  ellipsoid,
  independentArtistViews,
  renderCharacterViews,
  seededRandom,
  taperY,
  tposeCharacter,
  CHARACTER_COLORS,
} from './testing';

const bw = (m: Mask) => { const b = maskBBox(m)!; return b.x1 - b.x0; };
const bh = (m: Mask) => { const b = maskBBox(m)!; return b.y1 - b.y0; };

/** Foreground pixels of row y between two x positions (pixel-edge coords). */
function rowRuns(m: Mask, y: number): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let x = 0; x <= m.width; x++) {
    const on = x < m.width && m.data[y * m.width + x];
    if (on && start < 0) start = x;
    if (!on && start >= 0) { runs.push([start, x]); start = -1; }
  }
  return runs;
}

describe('primitives', () => {
  it('cylinderX, ellipsoid and taperY report consistent spans', () => {
    const cx = cylinderX(1, 2, 0.5, -1, 3);
    expect(cx.span(0, [0, 1, 2])).toEqual([-1, 3]);
    expect(cx.span(0, [0, 1.6, 2])).toBeNull();
    expect(cx.span(1, [0, 0, 2])).toEqual([0.5, 1.5]);
    expect(cx.span(2, [4, 1, 0])).toBeNull();
    const el = ellipsoid([0, 0, 0], [1, 2, 3]);
    expect(el.span(1, [0, 0, 0])).toEqual([-2, 2]);
    expect(el.span(2, [1, 0, 0])).toEqual([0, 0]);
    expect(el.span(0, [0, 2.1, 0])).toBeNull();
    // Cone-like taper: radius 1 at y = 0, 0.5 at y = 1.
    const tp = taperY(0, 0, 1, 1, 0, 1, 1, 0.5);
    expect(tp.span(0, [0, 0, 0])).toEqual([-1, 1]);
    expect(tp.span(0, [0, 1, 0])).toEqual([-0.5, 0.5]);
    expect(tp.span(2, [0, 0.5, 0])).toEqual([-0.75, 0.75]);
    // Along Y: inside up to where the radius shrinks to the point's distance.
    const iv = tp.span(1, [0.75, 0, 0])!;
    expect(iv[0]).toBe(0);
    expect(iv[1]).toBeCloseTo(0.5, 9);
    expect(tp.span(1, [1.2, 0, 0])).toBeNull();
    const grow = taperY(0, 0, 1, 1, 0, 1, 0.5, 1);
    expect(grow.span(1, [0.75, 0, 0])![0]).toBeCloseTo(0.5, 9);
    expect(containsPoint([tp], [0.6, 0.5, 0.1])).toBe(true);
    expect(containsPoint([tp], [0.8, 0.5, 0])).toBe(false);
  });
});

describe('tposeCharacter', () => {
  it('stands on y = −0.5 with its crown at +0.5, arms at the shoulder line, symmetric', () => {
    const ch = tposeCharacter();
    expect(ch.soleY).toBe(-0.5);
    expect(ch.crownY).toBeCloseTo(0.5, 9);
    expect(ch.armY).toBeCloseTo(0.255, 9);
    expect(containsPoint(ch.solid, [0.3, ch.armY, 0.005])).toBe(true);
    expect(containsPoint(ch.solid, [-0.3, ch.armY, 0.005])).toBe(true);
    expect(containsPoint(ch.solid, [0.3, ch.armY + 0.05, 0.005])).toBe(false);
    expect(characterPartAt(ch, [0.3, ch.armY, 0.005])).toBe('arm');
    expect(characterPartAt(ch, [0.5, ch.armY, 0.005])).toBe('hand');
    expect(characterPartAt(ch, [0, 0.42, 0])).toBe('head');
    expect(characterPartAt(ch, [0, 0.1, 0])).toBe('torso');
    expect(characterPartAt(ch, [0.066, -0.3, 0])).toBe('leg');
    expect(characterPartAt(ch, [0.072, -0.48, 0.05])).toBe('foot');
    expect(characterPartAt(ch, [0, -0.3, 0])).toBeNull(); // between the legs
  });

  it('applies the proportions', () => {
    const ch = tposeCharacter({ armHeight: -0.05, legLength: 1.1, armLength: 1.2, headScale: 1.2 });
    expect(ch.armY).toBeCloseTo(0.255 - 0.05 + 0.042, 9);
    expect(ch.crownY).toBeGreaterThan(0.5 + 0.042);
    expect(containsPoint(ch.parts.arm, [0.1 + 0.36 * 1.2 - 0.01, ch.armY, 0.005])).toBe(true);
    expect(containsPoint(tposeCharacter().parts.arm, [0.1 + 0.36 * 1.2 - 0.01, 0.255, 0.005])).toBe(false);
  });
});

describe('renderCharacterViews', () => {
  const ALL: ViewId[] = ['front', 'back', 'left', 'right', 'top', 'bottom'];

  it('renders sane silhouettes of a T-pose from all six views', () => {
    const { inputs, renders, framing } = renderCharacterViews(ALL, { size: 256 });
    expect(inputs.map((i) => i.id)).toEqual(ALL);
    for (const id of ALL) {
      const m = renders[id]!.mask;
      expect(m.width).toBe(256);
      expect(bh(m)).toBeGreaterThan(30);
      // Inside the image with a margin.
      const b = maskBBox(m)!;
      expect(b.x0).toBeGreaterThan(0);
      expect(b.y0).toBeGreaterThan(0);
      expect(b.x1).toBeLessThan(256);
      expect(b.y1).toBeLessThan(256);
      expect(framing[id]!.scale).toBeCloseTo(0.8 * 256, 9);
    }
    // Front: span ≈ height (T-pose), the arm row runs from hand to hand, the legs are two runs.
    const f = renders.front!.mask;
    expect(bw(f) / bh(f)).toBeGreaterThan(1.0);
    expect(bw(f) / bh(f)).toBeLessThan(1.1);
    const fr = framing.front!;
    const armRow = Math.floor(fr.cy - fr.scale * 0.255);
    expect(rowRuns(f, armRow)).toHaveLength(1);
    expect(rowRuns(f, armRow)[0][1] - rowRuns(f, armRow)[0][0]).toBeGreaterThan(0.95 * bw(f));
    expect(rowRuns(f, Math.floor(fr.cy + fr.scale * 0.3))).toHaveLength(2);
    // Back mirrors the front (the figure is symmetric).
    expect(bw(renders.back!.mask)).toBe(bw(f));
    expect(bh(renders.back!.mask)).toBe(bh(f));
    // Sides: a narrow profile of the same height; left and right mirror each other.
    const l = renders.left!.mask, r = renders.right!.mask;
    expect(bh(l)).toBe(bh(f));
    expect(bw(l) / bh(l)).toBeGreaterThan(0.12);
    expect(bw(l) / bh(l)).toBeLessThan(0.25);
    for (let i = 0; i < l.data.length; i++) {
      const x = i % 256, y = (i - x) / 256;
      expect(r.data[y * 256 + (255 - x)]).toBe(l.data[i]);
    }
    // Top: as wide as the front, as deep as the side.
    const t = renders.top!.mask;
    expect(bw(t)).toBe(bw(f));
    expect(Math.abs(bh(t) - bw(l))).toBeLessThanOrEqual(1);
  });

  it('colours the parts (shirt on the torso, skin on the hands)', () => {
    const { renders, framing } = renderCharacterViews(['front'], { size: 256 });
    const { image } = renders.front!;
    const fr = framing.front!;
    const px = (x: number, y: number) => Array.from(image.data.slice((y * 256 + x) * 4, (y * 256 + x) * 4 + 3));
    expect(px(Math.floor(fr.cx), Math.floor(fr.cy - fr.scale * 0.1))).toEqual(CHARACTER_COLORS.torso);
    expect(px(Math.floor(fr.cx + fr.scale * 0.49), Math.floor(fr.cy - fr.scale * 0.255))).toEqual(CHARACTER_COLORS.hand);
    expect(image.data[3]).toBe(0); // transparent background
  });

  it('applies framing perturbations: scale, offset, padding, crop', () => {
    const ref = renderCharacterViews(['back'], { size: 256 }).renders.back!.mask;
    const scaled = renderCharacterViews(['back'], { size: 256, perturb: { back: { scale: 0.9 } } }).renders.back!.mask;
    expect(bh(scaled) / bh(ref)).toBeGreaterThan(0.88);
    expect(bh(scaled) / bh(ref)).toBeLessThan(0.92);
    const shifted = renderCharacterViews(['back'], { size: 256, perturb: { back: { dx: 0.05, dy: -0.05 } } }).renders.back!.mask;
    const b0 = maskBBox(ref)!, b1 = maskBBox(shifted)!;
    // Pixel quantisation of the bbox: within 1.5 px of the requested shift.
    expect(Math.abs(b1.x0 - b0.x0 - 0.05 * 0.8 * 256)).toBeLessThan(1.5);
    expect(Math.abs(b1.y0 - b0.y0 + 0.05 * 0.8 * 256)).toBeLessThan(1.5);
    const padded = renderCharacterViews(['back'], { size: 256, perturb: { back: { padding: 0.1 } } }).renders.back!.mask;
    expect(padded.width).toBe(256 + 2 * Math.round(0.1 * 0.8 * 256));
    expect(bh(padded)).toBe(bh(ref));
    const cropped = renderCharacterViews(['back'], { size: 256, perturb: { back: { cropBottom: 0.25 } } });
    const cm = cropped.renders.back!.mask;
    expect(cm.height).toBeLessThan(256);
    expect(maskBBox(cm)!.y1).toBe(cm.height); // the border cuts the figure
    expect(bh(cm) / bh(ref)).toBeCloseTo(0.75, 1);
    expect(cropped.framing.back!.height).toBe(cm.height);
    const topCut = renderCharacterViews(['back'], { size: 256, perturb: { back: { cropTop: 0.1 } } }).renders.back!.mask;
    expect(maskBBox(topCut)!.y0).toBe(0);
    expect(bh(topCut) / bh(ref)).toBeCloseTo(0.9, 1);
  });

  it('draws a view with its own proportions and leaves the reference figure alone', () => {
    const set = renderCharacterViews(['front', 'back'], { size: 256, perturb: { back: { proportions: { armHeight: -0.06 } } } });
    expect(set.characters.back!.armY).toBeCloseTo(set.character.armY - 0.06, 9);
    expect(set.characters.front).toBe(set.character);
    const fr = set.framing.front!;
    const armRow = Math.floor(fr.cy - fr.scale * set.character.armY);
    expect(rowRuns(set.renders.front!.mask, armRow)).toHaveLength(1);
    // In the back view that row shows the torso only; the arms are lower.
    expect(rowRuns(set.renders.back!.mask, armRow)[0][1] - rowRuns(set.renders.back!.mask, armRow)[0][0]).toBeLessThan(0.4 * bw(set.renders.back!.mask));
    const lower = Math.floor(fr.cy - fr.scale * (set.character.armY - 0.06));
    expect(rowRuns(set.renders.back!.mask, lower)[0][1] - rowRuns(set.renders.back!.mask, lower)[0][0]).toBeGreaterThan(0.95 * bw(set.renders.back!.mask));
  });
});

describe('independent artists', () => {
  it('seededRandom is deterministic and uniform-ish', () => {
    const a = seededRandom(42), b = seededRandom(42);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(xs);
    for (const x of xs) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
    expect(xs.reduce((s, v) => s + v, 0) / xs.length).toBeGreaterThan(0.45);
    expect(xs.reduce((s, v) => s + v, 0) / xs.length).toBeLessThan(0.55);
  });

  it('artistProportions stay within the spread', () => {
    const rng = seededRandom(7);
    for (let n = 0; n < 50; n++) {
      const p = artistProportions(rng, 0.08);
      for (const k of ['headScale', 'torsoWidth', 'torsoDepth', 'hipWidth', 'armLength', 'legLength', 'legRadius', 'legSpread'] as const) {
        expect(p[k]).toBeGreaterThanOrEqual(0.92);
        expect(p[k]).toBeLessThanOrEqual(1.08);
      }
      expect(Math.abs(p.armRadius - 0.03)).toBeLessThanOrEqual(0.03 * 0.08 + 1e-12);
      expect(Math.abs(p.armHeight)).toBeLessThanOrEqual(0.36 * 0.08 + 1e-12);
    }
  });

  it('gives every view but the front its own figure and framing, reproducibly', () => {
    const views: ViewId[] = ['front', 'back', 'left', 'right'];
    const a = independentArtistViews(views, 3, { size: 192 });
    const b = independentArtistViews(views, 3, { size: 192 });
    for (const id of views) expect(a.renders[id]!.mask.data).toEqual(b.renders[id]!.mask.data);
    expect(a.characters.front).toBe(a.character);
    expect(a.characters.back!.proportions).not.toEqual(a.character.proportions);
    expect(a.characters.left!.proportions).not.toEqual(a.characters.back!.proportions);
    const scales = views.map((v) => a.framing[v]!.scale / (0.8 * 192));
    for (const s of scales) { expect(s).toBeGreaterThanOrEqual(0.85); expect(s).toBeLessThanOrEqual(1.15); }
    expect(new Set(scales).size).toBe(views.length);
    // Every silhouette still fits inside the image.
    for (const id of views) {
      const bb = maskBBox(a.renders[id]!.mask)!;
      expect(bb.y0).toBeGreaterThan(0);
      expect(bb.y1).toBeLessThan(192);
    }
    const other = independentArtistViews(views, 4, { size: 192 });
    expect(other.renders.back!.mask.data).not.toEqual(a.renders.back!.mask.data);
  });
});
