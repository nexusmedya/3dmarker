import { describe, expect, it } from 'vitest';
import type { ViewId } from '../types';
import { estimateObjectBox, prepareView, projectPoint, viewProjection, type PreparedView } from './frame';
import {
  ALIGN,
  ALIGN_TEXT,
  SHARED_AXES,
  alignLevel,
  alignNoteText,
  alignResidual,
  alignScore,
  alignView,
  alignedBox,
  correctionOf,
  registerViews,
} from './align';
import { reconstructFromViews } from './reconstruct';
import { mirrorRGBA } from '../image/ops';
import { box, cylinderY, renderCharacterViews, independentArtistViews, renderViews, sphere, taperY, VIEW_COLORS, type CharacterViews, type ViewPerturbation } from './testing';
import type { FusionViewInput } from './types';
import type { ViewAlignment } from './types';

const SIZE = 512;
const V4: ViewId[] = ['front', 'back', 'left', 'right'];

function prep(set: CharacterViews): PreparedView[] {
  return set.inputs.map((i) => prepareView(i)!);
}

function register(set: CharacterViews, mode: 'auto' | 'bbox' = 'auto'): { views: PreparedView[]; al: Record<string, ViewAlignment> } {
  const views = prep(set);
  const al: Record<string, ViewAlignment> = {};
  for (const a of registerViews(views, { mode })) al[a.id] = a;
  return { views, al };
}

/** Row (pixels) of a figure-space Y in a view, from its framing. */
const rowOf = (set: CharacterViews, id: ViewId, y: number) => set.framing[id]!.cy - set.framing[id]!.scale * y;

/** Rows of the reference figure's landmarks projected into a registered view minus the view's own rows, in fractions of H. */
function landmarkResiduals(set: CharacterViews, views: PreparedView[], id: ViewId): number[] {
  const front = views[0], view = views.find((v) => v.id === id)!;
  const box = estimateObjectBox(views, 0.5);
  const pf = viewProjection(front, box.size), pv = viewProjection(view, box.size);
  const ch = set.character, chv = set.characters[id]!;
  const H = set.framing.front!.scale;
  const marks = (c: typeof ch) => [c.crownY, c.crownY - 0.175, c.armY + 0.045, c.crotchY, c.soleY]; // crown, neck, shoulder line, crotch, sole
  return marks(ch).map((y, i) => {
    const Y = (rowOf(set, 'front', y) - pf.ov) / pf.sv; // object Y of the front's landmark row
    return Math.abs(pv.ov + pv.sv * Y - rowOf(set, id, marks(chv)[i])) / H;
  });
}

describe('registration of framing-only differences (R1)', () => {
  const cases: [string, ViewPerturbation][] = [
    ['scale 0.85', { scale: 0.85 }], ['scale 0.95', { scale: 0.95 }], ['scale 1.15', { scale: 1.15 }],
    ['dy +0.03', { dy: 0.03 }], ['dy −0.03', { dy: -0.03 }], ['dx 0.03', { dx: 0.03 }], ['padding 0.10', { padding: 0.1 }],
  ];
  it.each(cases)('finds the identity for %s on back, left and top', (_name, p) => {
    const views: ViewId[] = ['front', 'back', 'left', 'top'];
    const set = renderCharacterViews(views, { size: SIZE, perturb: { back: p, left: p, top: p } });
    const { al } = register(set);
    for (const id of ['back', 'left', 'top'] as ViewId[]) {
      const a = al[id];
      expect(['aligned', 'plain']).toContain(a.status);
      expect(Math.abs(a.applied.dx)).toBeLessThan(0.005);
      expect(Math.abs(a.applied.dy)).toBeLessThan(0.005);
      expect(Math.abs(a.applied.scale - 1)).toBeLessThan(0.01);
      expect(a.score).toBeGreaterThanOrEqual(90);
    }
  });
});

describe('registration of cropped views (R2)', () => {
  const crops: [string, ViewPerturbation, keyof ViewAlignment['cut']][] = [
    ['cropBottom 0.03', { cropBottom: 0.03 }, 'bottom'], ['cropBottom 0.08', { cropBottom: 0.08 }, 'bottom'], ['cropBottom 0.28', { cropBottom: 0.28 }, 'bottom'],
    ['cropTop 0.03', { cropTop: 0.03 }, 'top'], ['cropTop 0.08', { cropTop: 0.08 }, 'top'],
  ];
  const consistentDepth = estimateObjectBox(prep(renderCharacterViews(['front', 'left'], { size: SIZE })), 0.5).size[2];

  it.each(crops)('flags the cut and places the arm row of a %s back and left', (_name, p, edge) => {
    const set = renderCharacterViews(['front', 'back', 'left'], { size: SIZE, perturb: { back: p, left: p } });
    const { views, al } = register(set);
    const box = estimateObjectBox(views, 0.5);
    const pf = viewProjection(views[0], box.size);
    const H = set.framing.front!.scale;
    for (const id of ['back', 'left'] as ViewId[]) {
      const a = al[id];
      expect(a.cut[edge]).toBe(true);
      expect(a.notes.map((n) => n.code)).toContain('cropped');
      // The front's arm row lands on the view's arm row.
      const view = views.find((v) => v.id === id)!;
      const Y = (rowOf(set, 'front', set.character.armY) - pf.ov) / pf.sv;
      const pv = viewProjection(view, box.size);
      expect(Math.abs(pv.ov + pv.sv * Y - rowOf(set, id, set.characters[id]!.armY)) / H).toBeLessThan(0.007);
    }
    // The cropped side view still measures the depth correctly (a stretched bbox would overstate it).
    expect(Math.abs(box.size[2] / consistentDepth - 1)).toBeLessThan(0.1);
  });
});

describe('bias guard (R3): a back whose arms sit elsewhere keeps the identity', () => {
  it.each([[-0.03], [0.03], [-0.06], [0.06]])('armHeight %s', (armHeight) => {
    const set = renderCharacterViews(['front', 'back'], { size: SIZE, perturb: { back: { proportions: { armHeight } } } });
    const { al } = register(set);
    expect(Math.abs(al.back.applied.dy)).toBeLessThan(0.01);
    expect(Math.abs(al.back.applied.scale - 1)).toBeLessThan(0.02);
  });
});

describe('independent artists (R4): registration never lands worse than the bbox fit', () => {
  it.each([[1], [2], [3], [4], [5]])('seed %s', (seed) => {
    const set = independentArtistViews(V4, seed, { size: SIZE });
    const fitted = register(set, 'auto').views;
    const bboxed = register(set, 'bbox').views;
    for (const id of ['back', 'left', 'right'] as ViewId[]) {
      const rf = landmarkResiduals(set, fitted, id), rb = landmarkResiduals(set, bboxed, id);
      const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
      expect(mean(rf)).toBeLessThanOrEqual(mean(rb) + 0.005);
    }
  });
});

describe('plain and weak references (R5)', () => {
  it('a sphere or a box has nothing to align: plain, identity, no warnings', async () => {
    const s = renderViews([sphere([0, 0, 0], 1)], ['front', 'back', 'left', 'top'], { width: 128, height: 128, scale: 50 });
    const al = registerViews(s.inputs.map((i) => prepareView(i)!), { mode: 'auto' });
    for (const a of al.slice(1)) {
      expect(a.status).toBe('plain');
      expect(a.applied).toEqual({ dx: 0, dy: 0, scale: 1, flipX: false });
      expect(a.notes[0].code).toBe('plain');
    }
    const b = renderViews([box([-1, -0.5, -0.25], [1, 0.5, 0.25])], ['front', 'left', 'top'], { width: 140, height: 140, scale: 50 });
    const r = await reconstructFromViews(b.inputs, { resolution: 64 }, { signal: new AbortController().signal, onProgress: () => {}, yieldControl: async () => {} });
    expect(r.info.warnings).toEqual([]);
    for (const a of r.info.alignment.slice(1)) {
      expect(Math.abs(a.applied.dy)).toBeLessThan(0.005);
      expect(Math.abs(a.applied.scale - 1)).toBeLessThan(0.01);
    }
  });

  it('a back that shows another object is weak: identity, note weak', () => {
    const set = renderCharacterViews(['front'], { size: SIZE });
    const back = renderViews([sphere([0, 0, 0], 0.4)], ['back'], { width: SIZE, height: SIZE, scale: 400 });
    const a = alignView(prepareView(set.inputs[0])!, prepareView(back.inputs[0])!);
    expect(a.status).toBe('weak');
    expect(a.applied).toEqual({ dx: 0, dy: 0, scale: 1, flipX: false });
    expect(a.notes[0].code).toBe('weak');
    expect(a.level).toBe('poor');
  });
});

describe('scores (R6)', () => {
  it('rate consistent views high, misplaced arms lower the further they are, crops a little', () => {
    const consistent = register(renderCharacterViews(V4, { size: SIZE })).al;
    for (const id of ['back', 'left', 'right'] as ViewId[]) expect(consistent[id].score).toBeGreaterThanOrEqual(90);
    const at = (armHeight: number) => register(renderCharacterViews(['front', 'back'], { size: SIZE, perturb: { back: { proportions: { armHeight } } } })).al.back.score;
    const s3 = at(-0.03), s6 = at(-0.06);
    expect(s3).toBeGreaterThanOrEqual(30);
    expect(s3).toBeLessThanOrEqual(90);
    expect(s6).toBeLessThan(60);
    expect(s6).toBeLessThan(s3);
    expect(s3).toBeLessThan(consistent.back.score);
    const cropped = register(renderCharacterViews(['front', 'back'], { size: SIZE, perturb: { back: { cropBottom: 0.08 } } })).al.back;
    expect(cropped.score).toBeLessThanOrEqual(consistent.back.score);
    expect(cropped.notes.map((n) => n.code)).toContain('cropped');
    expect(alignNoteText(cropped, 'en')).toMatch(/Auto-aligned/);
    expect(cropped.notes.find((n) => n.code === 'cropped')!.text).toEqual(ALIGN_TEXT.croppedBottom);
  });

  it('alignScore / alignLevel / alignResidual follow the formula', () => {
    const cut = { top: false, bottom: false, left: false, right: false };
    const base = { confidence: 1, residual: { dx: 0, dy: 0, scale: 1 }, cut, status: 'aligned' as const, id: 'back' as const, maskSource: 'given' as const };
    expect(alignScore(base)).toBe(100);
    expect(alignScore({ ...base, maskSource: 'none' })).toBe(0);
    expect(alignScore({ ...base, residual: { dx: 0, dy: 0.08, scale: 1 } })).toBe(50);
    expect(alignScore({ ...base, id: 'top', residual: { dx: 0, dy: 0.08, scale: 1 } })).toBe(100); // dy is not shared with a cap view
    expect(alignScore({ ...base, residual: { dx: 0.04, dy: 0, scale: 1 } })).toBe(90);
    expect(alignScore({ ...base, confidence: 0.5, cut: { ...cut, bottom: true } })).toBe(42);
    expect(alignScore({ ...base, status: 'stretched' })).toBe(75);
    expect(alignLevel(80)).toBe('good');
    expect(alignLevel(79)).toBe('fair');
    expect(alignLevel(54)).toBe('poor');
    expect(alignResidual({ dx: 0.02, dy: -0.01, scale: 1.1, flipX: false }, { dx: 0.01, dy: 0.01, scale: 1 })).toEqual({ dx: 0.01, dy: -0.02, scale: 1.1 });
  });
});

describe('manual alignment, trust and flip (R7)', () => {
  it('manual corrections give exactly alignedBox, in auto and bbox mode', () => {
    const set = renderCharacterViews(['front', 'back', 'left'], { size: SIZE });
    const manual = { mode: 'manual' as const, dx: 0.02, dy: -0.03, scale: 1.05, flipX: false, trust: 'full' as const };
    const inputs = set.inputs.map((i) => (i.id === 'front' ? i : { ...i, align: manual }));
    for (const mode of ['auto', 'bbox'] as const) {
      const views = inputs.map((i) => prepareView(i)!);
      const al = registerViews(views, { mode });
      for (const a of al.slice(1)) {
        const view = views.find((v) => v.id === a.id)!;
        expect(a.status).toBe('manual');
        expect(a.fitBox).toEqual(alignedBox(view.bbox, manual, SHARED_AXES[a.id]));
        expect(view.fitBox).toEqual(a.fitBox);
        expect(a.applied).toEqual({ dx: 0.02, dy: -0.03, scale: 1.05, flipX: false });
      }
      // The side view's unshared (depth) axis keeps its bbox extent.
      const left = views.find((v) => v.id === 'left')!;
      expect(left.fitBox.x1 - left.fitBox.x0).toBeCloseTo(left.bbox.x1 - left.bbox.x0, 9);
    }
    // alignedBox and correctionOf are inverses on the shared axes.
    const b = { x0: 10, y0: 20, x1: 110, y1: 220 };
    const c = correctionOf(b, alignedBox(b, { dx: 0.05, dy: -0.02, scale: 1.2 }, SHARED_AXES.back), SHARED_AXES.back);
    expect(c.dx).toBeCloseTo(0.05, 9);
    expect(c.dy).toBeCloseTo(-0.02, 9);
    expect(c.scale).toBeCloseTo(1.2, 9);
  });

  it('flipX mirrors the view before anything else', () => {
    // A slab with a bump above its top-left corner (the subject's left, +X): the back view shows it on the
    // image left. Object coordinates are relative to the silhouette bbox centre (0.175, −0.175).
    const solid = [box([-1, -1, -0.3], [1, 0.2, 0.3]), sphere([1.1, 0.4, 0], 0.25)];
    const back = renderViews(solid, ['back'], { width: 160, height: 160, scale: 50 }).inputs[0];
    const plain = prepareView(back)!;
    const flipped = prepareView({ ...back, align: { mode: 'auto', dx: 0, dy: 0, scale: 1, flipX: true, trust: 'full' } })!;
    const size: [number, number, number] = [2.35, 1.65, 0.6];
    const at = (v: PreparedView, p: [number, number, number]) => {
      const [x, y] = projectPoint(viewProjection(v, size), p);
      return v.mask.data[Math.floor(y) * v.mask.width + Math.floor(x)];
    };
    const bump: [number, number, number] = [1.1 - 0.175, 0.4 + 0.175, 0], mirror: [number, number, number] = [-(1.1 - 0.175), 0.4 + 0.175, 0];
    expect(at(plain, bump)).toBe(1);
    expect(at(plain, mirror)).toBe(0);
    expect(at(flipped, bump)).toBe(0);
    expect(at(flipped, mirror)).toBe(1);
    expect(flipped.align.flipX).toBe(true);
    // The image was mirrored with the mask.
    const w = back.image.width;
    expect(Array.from(flipped.image.data.subarray(0, 4))).toEqual(Array.from(back.image.data.subarray((w - 1) * 4, w * 4)));
  });

  it("colour-only sides leave the hull and the box alone but still paint; 'off' views vanish", async () => {
    const solid = [box([-0.4, -1, -0.5], [0.4, 1, 0.5])];
    const { inputs } = renderViews(solid, ['front', 'back', 'left', 'right'], { width: 128, height: 128, scale: 50 });
    const trust = (t: 'color' | 'off') => inputs.map((i) => (i.id === 'left' || i.id === 'right' ? { ...i, align: { mode: 'auto' as const, dx: 0, dy: 0, scale: 1, flipX: false, trust: t } } : i));
    const ctx = () => ({ signal: new AbortController().signal, onProgress: () => {}, yieldControl: async () => {} });
    const r = await reconstructFromViews(trust('color'), { resolution: 64, defaultDepth: 0.4 }, ctx());
    expect(r.info.trust).toEqual({ front: 'full', back: 'full', left: 'color', right: 'color' });
    expect(r.info.box.depthFrom).toBe('default');
    expect(r.info.warnings.map((w) => w.en)).toEqual(expect.arrayContaining([expect.stringContaining('left view was used for colour only')]));
    const p = r.geometry.getAttribute('position').array as Float32Array, c = r.geometry.getAttribute('color').array as Float32Array;
    const n = r.geometry.getAttribute('normal').array as Float32Array;
    let leftHits = 0, rightHits = 0;
    for (let i = 0; i < p.length; i += 3) {
      if (n[i] > 0.9) { expect(Math.abs(c[i + 1] - 1)).toBeLessThan(0.15); expect(c[i]).toBeLessThan(0.15); leftHits++; } // +X faces: left view (green)
      if (n[i] < -0.9) { expect(Math.abs(c[i] - 1)).toBeLessThan(0.15); expect(Math.abs(c[i + 1] - 1)).toBeLessThan(0.15); rightHits++; } // −X: right (yellow)
    }
    expect(leftHits).toBeGreaterThan(20);
    expect(rightHits).toBeGreaterThan(20);
    expect(VIEW_COLORS.left).toEqual([0, 255, 0]);
    const off = await reconstructFromViews(trust('off'), { resolution: 64 }, ctx());
    expect(off.info.views).toEqual(['front', 'back']);
    expect(off.info.report.views.map((v) => v.id)).toEqual(['front', 'back']);
  });
});

describe('slot checks (R9): wrong slot, facing, duplicate', () => {
  const ALL: ViewId[] = ['front', 'back', 'left', 'right', 'top', 'bottom'];
  const set = renderCharacterViews(ALL, { size: 384 });
  const input = (id: ViewId) => set.inputs.find((i) => i.id === id)!;
  const front = prepareView(input('front'))!;
  /** The image of view `from` uploaded into slot `to`. */
  const check = (from: FusionViewInput, to: ViewId, flipX = false) =>
    alignView(front, prepareView({ ...from, id: to, align: { mode: 'auto', dx: 0, dy: 0, scale: 1, flipX, trust: 'full' } })!);
  const codes = (a: ViewAlignment) => a.notes.map((n) => n.code);
  const mirrored = (i: FusionViewInput): FusionViewInput => ({ ...i, image: mirrorRGBA(i.image) });
  const FLAGS = ['wrongSlot', 'facing', 'duplicate', 'sameImage', 'extent', 'featureless'];

  it.each([
    ['back', 'left'], ['back', 'right'], ['front', 'left'], ['front', 'right'], ['front', 'top'], ['back', 'top'], ['front', 'bottom'],
  ] as [ViewId, ViewId][])('a %s image in the %s slot is poor, colour only, with the wrong-slot note first', (from, to) => {
    const a = check(input(from), to);
    expect(a.level).toBe('poor');
    expect(a.score).toBeLessThanOrEqual(ALIGN.CAP_WRONG_SLOT);
    expect(a.trust).toBe('color');
    // The front image itself is named as such (the same image as the front), a back image as a front/back view.
    if (from === 'front') {
      expect(a.notes[0].code).toBe('sameImage');
      expect(alignNoteText(a, 'tr')).toMatch(/Ön görselle aynı/);
    } else {
      expect(a.notes[0].code).toBe('wrongSlot');
      expect(alignNoteText(a, 'tr')).toMatch(/ön\/arka görünüm gibi/);
    }
  });

  it('a wrong-slot view no longer sets the depth: back as left keeps the default depth, not the arm span', async () => {
    const inputs = [input('front'), input('back'), { ...input('back'), id: 'left' as const }];
    const r = await reconstructFromViews(inputs, { resolution: 48 }, { signal: new AbortController().signal, onProgress: () => {}, yieldControl: async () => {} });
    expect(r.info.trust.left).toBe('color');
    expect(r.info.box.depthFrom).toBe('default');
    expect(r.info.box.depth / r.info.box.width).toBeLessThan(0.6);
    // Placed by hand, the user's word stands: no demotion (the badge still says poor).
    const views = [front, prepareView({ ...input('back'), id: 'left', align: { mode: 'manual', dx: 0, dy: 0, scale: 1, flipX: false, trust: 'full' } })!];
    const m = registerViews(views, { mode: 'auto' })[1];
    expect(m.trust).toBe('full');
    expect(m.level).toBe('poor');
    expect(codes(m)[0]).toBe('wrongSlot');
  });

  it('flags a side view facing the wrong way (mirrored, or the other side), and Flip horizontally clears it', () => {
    const good = check(input('left'), 'left');
    expect(codes(good)).not.toContain('facing');
    const flipped = check(mirrored(input('left')), 'left');
    expect(flipped.notes[0].code).toBe('facing');
    expect(flipped.level).toBe('fair');
    expect(flipped.score).toBeLessThan(good.score);
    expect(alignNoteText(flipped, 'en')).toMatch(/Flip horizontally/);
    const fixed = check(mirrored(input('left')), 'left', true);
    expect(codes(fixed)).not.toContain('facing');
    expect(fixed.score).toBe(good.score);
    expect(codes(check(input('right'), 'left'))[0]).toBe('facing');
    expect(codes(check(input('left'), 'right'))[0]).toBe('facing');
    expect(codes(check(input('right'), 'right'))).not.toContain('facing');
  });

  it('flags the front uploaded again as the back (as is or mirrored), not the real back', () => {
    for (const dup of [input('front'), mirrored(input('front'))]) {
      const a = check(dup, 'back');
      expect(a.notes[0].code).toBe('duplicate');
      expect(a.level).not.toBe('good');
      expect(a.score).toBeLessThanOrEqual(ALIGN.CAP_DUPLICATE);
    }
    const real = check(input('back'), 'back');
    expect(codes(real)).not.toContain('duplicate');
    expect(real.level).toBe('good');
    // A plain one-colour object: its back may look just like its front.
    const plain = renderViews([box([-0.6, -1, -0.3], [0.6, 1, 0.3]), sphere([0, 1.2, 0], 0.3)], ['front', 'back'], { width: 128, height: 128, scale: 45, color: () => [200, 200, 200] });
    const pf = prepareView(plain.inputs[0])!;
    expect(codes(alignView(pf, prepareView(plain.inputs[1])!))).not.toContain('duplicate');
  });

  it('leaves consistent sets, hand-made sets and look-alike objects alone', () => {
    for (const a of registerViews(prep(set), { mode: 'auto' }).slice(1)) {
      expect(codes(a).filter((c) => FLAGS.includes(c))).toEqual([]);
      expect(a.level).toBe('good');
    }
    for (const seed of [1, 2, 3, 7, 11]) {
      for (const a of registerViews(prep(independentArtistViews(['front', 'back', 'left', 'right', 'top'], seed, { size: 384 })), { mode: 'auto' }).slice(1)) {
        expect(codes(a).filter((c) => FLAGS.includes(c))).toEqual([]);
        expect(a.trust).toBe('full');
      }
    }
    // A lamp (a solid of revolution) and a square table: their true side view is their front.
    const lamp = [cylinderY(0, 0, 0.05, -0.8, 0.5), cylinderY(0, 0, 0.4, -1, -0.8), taperY(0, 0, 0.5, 0.5, 0.3, 0.8, 1, 0.6)];
    const table = [box([-0.8, 0.3, -0.8], [0.8, 0.4, 0.8]), ...[-1, 1].flatMap((x) => [-1, 1].map((z) => box([x * 0.75 - 0.05, -1, z * 0.75 - 0.05], [x * 0.75 + 0.05, 0.3, z * 0.75 + 0.05])))];
    for (const solid of [lamp, table]) {
      const r = renderViews(solid, ['front', 'left', 'right'], { width: 256, height: 256, scale: 100 });
      for (const a of registerViews(r.inputs.map((i) => prepareView(i)!), { mode: 'auto' }).slice(1)) {
        expect(codes(a)).not.toContain('wrongSlot');
        expect(a.trust).toBe('full');
      }
    }
  });
});

describe('slot checks (R10): same image, impossible or contradicting depth, featureless views', () => {
  const set = renderCharacterViews(['front', 'back', 'left', 'right', 'top', 'bottom'], { size: 256 });
  const input = (id: ViewId) => set.inputs.find((i) => i.id === id)!;
  const as = (from: ViewId, to: ViewId): FusionViewInput => ({ ...input(from), id: to });
  const codes = (a: ViewAlignment) => a.notes.map((n) => n.code);
  const reg = (inputs: FusionViewInput[]) => {
    const al: Record<string, ViewAlignment> = {};
    for (const a of registerViews(inputs.map((i) => prepareView(i)!), { mode: 'auto' })) al[a.id] = a;
    return al;
  };
  /** A flat-coloured ellipse or rectangle filling `fx` × 0.8 of a 256² image. */
  const blob = (id: ViewId, kind: 'ellipse' | 'rect', fx: number): FusionViewInput => {
    const w = 256, data = new Uint8ClampedArray(w * w * 4);
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++) {
        const nx = (x + 0.5 - w / 2) / ((w * fx) / 2), ny = (y + 0.5 - w / 2) / ((w * 0.8) / 2);
        if (kind === 'rect' ? Math.abs(nx) <= 1 && Math.abs(ny) <= 1 : nx * nx + ny * ny <= 1) data.set([120, 110, 100, 255], 4 * (y * w + x));
      }
    return { id, image: { width: w, height: w, data }, mask: null };
  };
  /** The image stretched vertically by k (nearest neighbour, taller canvas). */
  const stretchY = (i: FusionViewInput, k: number): FusionViewInput => {
    const { width: w, height: h, data } = i.image, H = Math.round(h * k), out = new Uint8ClampedArray(w * H * 4);
    for (let y = 0; y < H; y++) out.set(data.subarray(Math.floor(y / k) * w * 4, (Math.floor(y / k) + 1) * w * 4), y * w * 4);
    return { ...i, image: { width: w, height: H, data: out } };
  };

  it('flags the front image uploaded again into a side / cap slot, also for objects that are not figures', () => {
    for (const to of ['left', 'top'] as ViewId[]) {
      const a = reg([input('front'), input('back'), as('front', to)])[to];
      expect(codes(a)[0]).toBe('sameImage');
      expect(a.level).toBe('poor');
      expect(alignNoteText(a, 'tr')).toMatch(/Ön görselle aynı.*"Yalnız renk"\/"Kapalı"/);
    }
    // A mug (its handle makes the front asymmetric): same image as the front in the left slot.
    const mug = renderViews([cylinderY(0, 0, 0.55, -0.8, 0.8), box([0.55, -0.37, -0.07], [0.95, 0.37, 0.07])], ['front', 'left'], { width: 200, height: 200, scale: 70 });
    const m = reg([mug.inputs[0], { ...mug.inputs[0], id: 'left' }]).left;
    expect(codes(m)[0]).toBe('sameImage');
    expect(m.level).toBe('poor');
    expect(codes(reg(mug.inputs).left)).not.toContain('sameImage');
    // A plain cylinder really looks the same from the side.
    const cyl = renderViews([cylinderY(0, 0, 0.5, -1, 1)], ['front'], { width: 200, height: 200, scale: 70, color: () => [200, 150, 120] });
    expect(codes(reg([cyl.inputs[0], { ...cyl.inputs[0], id: 'left' }]).left)).not.toContain('sameImage');
  });

  it('flags the same image in two slots on the view that fits its slot worse', () => {
    const al = reg([input('front'), input('back'), input('left'), input('right'), as('left', 'top')]);
    expect(codes(al.top)).toContain('sameImage');
    expect(al.top.notes.find((n) => n.code === 'sameImage')!.text.en).toMatch(/left view/);
    expect(al.top.level).toBe('poor');
    expect(codes(al.left)).not.toContain('sameImage');
    expect(al.left.level).toBe('good');
  });

  it('flags a top image in a side slot by the depth it implies, and makes it colour only', () => {
    for (const inputs of [[input('front'), input('back'), as('top', 'left'), input('right')], [input('front'), as('top', 'left')]]) {
      const a = reg(inputs).left;
      expect(codes(a)[0]).toBe('extent');
      expect(a.level).toBe('poor');
      expect(a.trust).toBe('color');
      expect(alignNoteText(a, 'en')).toMatch(/as deep as the front/);
    }
    // Before: 78, "fair".
  });

  it('flags a depth view that contradicts the other depth views', () => {
    // A top view whose depth is drawn 2.5 times too deep, next to consistent left / right / bottom views.
    const al = reg([input('front'), input('left'), input('right'), stretchY(input('top'), 2.5), input('bottom')]);
    expect(codes(al.top)[0]).toBe('extent');
    expect(alignNoteText(al.top, 'en')).toMatch(/contradicts the other views \(2\.\d× off\)/);
    expect(al.top.level).toBe('poor');
    expect(al.top.trust).toBe('color');
    for (const id of ['left', 'right', 'bottom']) expect(codes(al[id])).not.toContain('extent');
  });

  it('flags featureless blobs in any slot, and leaves plain objects alone', () => {
    for (const b of [blob('left', 'ellipse', 0.3), blob('left', 'rect', 0.3), blob('top', 'ellipse', 0.9)]) {
      const a = reg([input('front'), input('back'), b])[b.id];
      expect(codes(a)[0]).toBe('featureless');
      expect(a.level).toBe('poor'); // before: 83–84 ("good") in a side slot, 55 in the top slot
      expect(alignNoteText(a, 'tr')).toMatch(/ayırt edici ayrıntı yok/);
    }
    // Plain objects: a sphere, a flat-coloured box with its plain sides.
    for (const solid of [[sphere([0, 0, 0], 1)], [box([-1, -0.6, -0.3], [1, 0.6, 0.3])]]) {
      const r = renderViews(solid, ['front', 'left', 'top'], { width: 200, height: 200, scale: 70, color: () => [180, 180, 180] });
      for (const a of registerViews(r.inputs.map((i) => prepareView(i)!), { mode: 'auto' }).slice(1)) expect(codes(a)).not.toContain('featureless');
    }
  });
});

describe('determinism and speed (R8)', () => {
  it('gives identical alignments for identical inputs', () => {
    const set = independentArtistViews(V4, 2, { size: SIZE });
    const a = registerViews(prep(set), { mode: 'auto' });
    const b = registerViews(prep(set), { mode: 'auto' });
    expect(b).toEqual(a);
  });

  it('registers four 1024² views quickly', () => {
    const set = renderCharacterViews(V4, { size: 1024 });
    const views = prep(set);
    registerViews(views, { mode: 'auto' }); // warm-up
    const t0 = performance.now();
    registerViews(views, { mode: 'auto' });
    // ~75 ms locally with the wrong-slot / featureless checks; headroom for slower CI runners.
    expect(performance.now() - t0).toBeLessThan(300);
  }, 20000);
});
