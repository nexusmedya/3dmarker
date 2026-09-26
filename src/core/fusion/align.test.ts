import { describe, expect, it } from 'vitest';
import type { ViewId } from '../types';
import { estimateObjectBox, prepareView, projectPoint, viewProjection, type PreparedView } from './frame';
import {
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
import { box, renderCharacterViews, independentArtistViews, renderViews, sphere, VIEW_COLORS, type CharacterViews, type ViewPerturbation } from './testing';
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
    expect(performance.now() - t0).toBeLessThan(150);
  }, 20000);
});
