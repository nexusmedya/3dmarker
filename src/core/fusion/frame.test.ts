import { describe, expect, it } from 'vitest';
import type { Mask, RGBAImage, ViewId } from '../types';
import { DEFAULT_VIEW_ALIGN } from '../types';
import { mirrorMask, mirrorRGBA } from '../image/ops';
import { constrainsDepth, cutFlags, estimateObjectBox, maskBBox, NO_CUT, prepareView, projectPoint, resolveViewMask, VIEW_FRAMES, viewProjection, type PreparedView } from './frame';

function rect(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Mask {
  const data = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * w + x] = 1;
  return { width: w, height: h, data };
}

function image(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(px(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}

const blank = (w: number, h: number) => image(w, h, () => [0, 0, 0, 255]);

function view(id: ViewId, mask: Mask, source: PreparedView['maskSource'] = 'given'): PreparedView {
  const bbox = maskBBox(mask)!;
  return { id, frame: VIEW_FRAMES[id], image: blank(mask.width, mask.height), mask, maskSource: source, bbox, align: DEFAULT_VIEW_ALIGN, cut: { ...NO_CUT }, fitBox: { ...bbox }, registration: 'bbox', trust: 'full' };
}

describe('VIEW_FRAMES', () => {
  // Image position of a world point in a view whose bbox is the unit square around (0, 0) with a 2×2×2 box.
  const at = (id: ViewId, p: [number, number, number]) => {
    const v = view(id, rect(4, 4, 0, 0, 4, 4));
    return projectPoint(viewProjection(v, [4, 4, 4]), p);
  };
  const FRONT_OF: [number, number, number] = [0, 0, 1], BACK_OF: [number, number, number] = [0, 0, -1];
  const LEFT_OF: [number, number, number] = [1, 0, 0], RIGHT_OF: [number, number, number] = [-1, 0, 0];
  const ABOVE: [number, number, number] = [0, 1, 0], BELOW: [number, number, number] = [0, -1, 0];

  it('front: the subject faces the camera (its left on the image right), up is up', () => {
    expect(at('front', LEFT_OF)[0]).toBeGreaterThan(at('front', RIGHT_OF)[0]);
    expect(at('front', ABOVE)[1]).toBeLessThan(at('front', BELOW)[1]);
  });

  it('back: seen from behind, the subject\'s left on the image left', () => {
    expect(at('back', LEFT_OF)[0]).toBeLessThan(at('back', RIGHT_OF)[0]);
    expect(at('back', ABOVE)[1]).toBeLessThan(at('back', BELOW)[1]);
  });

  it('left: camera at the subject\'s left, its front on the image left', () => {
    expect(at('left', FRONT_OF)[0]).toBeLessThan(at('left', BACK_OF)[0]);
    expect(at('left', ABOVE)[1]).toBeLessThan(at('left', BELOW)[1]);
  });

  it('right: camera at the subject\'s right, its front on the image right', () => {
    expect(at('right', FRONT_OF)[0]).toBeGreaterThan(at('right', BACK_OF)[0]);
  });

  it('top: from above, the front at the image bottom, the subject\'s left on the right', () => {
    expect(at('top', FRONT_OF)[1]).toBeGreaterThan(at('top', BACK_OF)[1]);
    expect(at('top', LEFT_OF)[0]).toBeGreaterThan(at('top', RIGHT_OF)[0]);
  });

  it('bottom: from below, the front at the image top, the subject\'s left on the right', () => {
    expect(at('bottom', FRONT_OF)[1]).toBeLessThan(at('bottom', BACK_OF)[1]);
    expect(at('bottom', LEFT_OF)[0]).toBeGreaterThan(at('bottom', RIGHT_OF)[0]);
  });

  it('is a right-handed camera frame for every view (image right × image up = towards the camera)', () => {
    for (const f of Object.values(VIEW_FRAMES)) {
      const vec = (axis: number, sign: number) => [0, 1, 2].map((a) => (a === axis ? sign : 0));
      const r = vec(f.u.axis, f.u.sign), up = vec(f.v.axis, -f.v.sign), w = vec(f.w.axis, f.w.sign);
      const cross = [r[1] * up[2] - r[2] * up[1], r[2] * up[0] - r[0] * up[2], r[0] * up[1] - r[1] * up[0]];
      expect(cross.map((c) => c + 0)).toEqual(w.map((c) => c + 0)); // + 0 turns −0 into 0
    }
  });
});

describe('view preparation', () => {
  it('resolves masks: given → alpha → plain border → whole image', () => {
    const given = rect(10, 10, 2, 2, 5, 5);
    expect(resolveViewMask(blank(10, 10), given).source).toBe('given');
    const alpha = image(10, 10, (x, y) => (x > 3 && y > 3 ? [9, 9, 9, 255] : [0, 0, 0, 0]));
    expect(resolveViewMask(alpha, null)).toMatchObject({ source: 'alpha' });
    const plain = image(20, 20, (x, y) => (x > 5 && x < 14 && y > 5 && y < 14 ? [200, 0, 0, 255] : [255, 255, 255, 255]));
    expect(resolveViewMask(plain, null).source).toBe('border');
    const noisy = image(20, 20, (x, y) => [(x * 37 + y * 91) % 256, (x * 13) % 256, (y * 57) % 256, 255]);
    const none = resolveViewMask(noisy, null);
    expect(none.source).toBe('none');
    expect(none.mask.data.every((v) => v === 1)).toBe(true);
    // An empty given mask falls through; a mask of another size is resized.
    expect(resolveViewMask(alpha, rect(10, 10, 0, 0, 0, 0)).source).toBe('alpha');
    expect(resolveViewMask(blank(20, 20), rect(10, 10, 0, 0, 5, 5)).mask.width).toBe(20);
  });

  it('measures a tight bbox, ignoring stray specks', () => {
    const m = rect(100, 100, 20, 30, 60, 90);
    m.data[2 * 100 + 97] = 1; // a lone speck in the corner
    const v = prepareView({ id: 'left', image: blank(100, 100), mask: m })!;
    expect(v.bbox).toEqual({ x0: 20, y0: 30, x1: 60, y1: 90 });
    expect(v.mask.data[2 * 100 + 97]).toBe(0);
    expect(v.frame).toBe(VIEW_FRAMES.left);
    expect(maskBBox(rect(5, 5, 0, 0, 0, 0))).toBeNull();
  });

  it('keeps a small detached part of a given / alpha mask (only pixel noise is dropped)', () => {
    const m = rect(200, 200, 40, 40, 120, 180);
    for (let y = 60; y < 66; y++) for (let x = 150; x < 156; x++) m.data[y * 200 + x] = 1; // a 36 px ball, 0.09 % of the image
    const v = prepareView({ id: 'front', image: blank(200, 200), mask: m })!;
    expect(v.bbox).toEqual({ x0: 40, y0: 40, x1: 156, y1: 180 });
    expect(v.mask.data[62 * 200 + 152]).toBe(1);
  });

  it('keeps a dotted silhouette whole when every component is small', () => {
    const m = rect(200, 200, 0, 0, 0, 0);
    for (let y = 10; y < 190; y += 20) for (let x = 10; x < 190; x += 20) m.data[y * 200 + x] = 1;
    const v = prepareView({ id: 'front', image: blank(200, 200), mask: m })!;
    expect(v.bbox).toEqual({ x0: 10, y0: 10, x1: 171, y1: 171 });
  });
});

describe('estimateObjectBox', () => {
  const front = view('front', rect(100, 100, 10, 0, 90, 100)); // W = 80, H = 100

  it('takes W, H from the front and D from the sides with heights matched', () => {
    const left = view('left', rect(50, 50, 10, 0, 30, 50)); // 20 × 50 → D = 0.4 · 100
    const right = view('right', rect(100, 100, 0, 0, 60, 100)); // 60 × 100 → D = 60
    expect(estimateObjectBox([front, left, right], 0.5)).toEqual({ size: [80, 100, 50], depthFrom: 'side' });
  });

  it('uses top / bottom for D when there is no side view, else the default', () => {
    const top = view('top', rect(40, 40, 0, 10, 40, 30)); // 40 wide, 20 deep → D = 0.5 · 80
    expect(estimateObjectBox([front, top], 0.5)).toEqual({ size: [80, 100, 40], depthFrom: 'top-bottom' });
    const back = view('back', rect(100, 100, 0, 0, 100, 100));
    expect(estimateObjectBox([front, back], 0.25)).toEqual({ size: [80, 100, 20], depthFrom: 'default' });
  });

  it('ignores views without a real silhouette for proportions', () => {
    const left = view('left', rect(10, 10, 0, 0, 10, 10), 'none');
    expect(estimateObjectBox([front, left], 0.5).depthFrom).toBe('default');
  });

  it('requires the front view', () => {
    expect(() => estimateObjectBox([view('back', rect(4, 4, 0, 0, 4, 4))], 0.5)).toThrow();
  });
});

describe('viewProjection', () => {
  it('maps the object box onto the view bbox (back mirrored)', () => {
    const size: [number, number, number] = [80, 100, 50];
    const b = view('back', rect(200, 200, 50, 20, 130, 170)); // 80 × 150
    const p = viewProjection(b, size);
    expect(projectPoint(p, [40, 50, 0])).toEqual([50, 20]); // subject's left top → image top-left
    expect(projectPoint(p, [-40, -50, 0])).toEqual([130, 170]);
    const l = viewProjection(view('left', rect(100, 100, 0, 0, 50, 100)), size);
    expect(projectPoint(l, [0, 0, 25])[0]).toBe(0); // the front at the image left
    expect(projectPoint(l, [0, 0, -25])[0]).toBe(50);
  });
});

describe('cut flags, mirroring and the fitBox mapping', () => {
  it('flags an edge the silhouette is cut off at, not one a speck touches', () => {
    const cut = rect(100, 100, 20, 30, 60, 100); // reaches the bottom row over 40 px
    const v = prepareView({ id: 'left', image: blank(100, 100), mask: cut })!;
    expect(v.cut).toEqual({ top: false, bottom: true, left: false, right: false });
    const m = rect(100, 100, 20, 30, 60, 90);
    m.data[0 * 100 + 40] = 1; // a lone pixel on the top row (a speck: removed before the flags)
    const w = prepareView({ id: 'left', image: blank(100, 100), mask: m })!;
    expect(w.cut).toEqual({ top: false, bottom: false, left: false, right: false });
    const thin = rect(100, 100, 20, 0, 60, 90);
    thin.data.fill(0, 0, 100); // top row: only one pixel of the body touches
    thin.data[0 * 100 + 40] = 1;
    expect(cutFlags(thin, maskBBox(thin)!).top).toBe(false); // 1 px < max(2, 2 % of 40)
    expect(cutFlags(rect(100, 100, 0, 0, 100, 100), { x0: 0, y0: 0, x1: 100, y1: 100 })).toEqual({ top: true, bottom: true, left: true, right: true });
    expect(v.fitBox).toEqual(v.bbox);
    expect(v.registration).toBe('bbox');
    expect(v.trust).toBe('full');
    expect(v.align).toEqual(DEFAULT_VIEW_ALIGN);
  });

  it('mirrorRGBA / mirrorMask flip horizontally into new buffers', () => {
    const img = image(3, 2, (x, y) => [x * 10, y, 0, 255]);
    const mi = mirrorRGBA(img);
    expect(mi.data).not.toBe(img.data);
    expect(Array.from(mi.data.subarray(0, 4))).toEqual([20, 0, 0, 255]);
    expect(Array.from(mi.data.subarray(8, 12))).toEqual([0, 0, 0, 255]);
    expect(Array.from(mi.data.subarray(12, 16))).toEqual([20, 1, 0, 255]);
    const m = rect(3, 2, 0, 0, 1, 2);
    const mm = mirrorMask(m);
    expect(Array.from(mm.data)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(Array.from(m.data)).toEqual([1, 0, 0, 1, 0, 0]);
    // A view with flipX gets a mirrored image and mask; its trust comes from the request.
    const v = prepareView({ id: 'back', image: img, mask: m, align: { mode: 'auto', dx: 0, dy: 0, scale: 1, flipX: true, trust: 'color' } })!;
    expect(Array.from(v.mask.data)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(v.image.data[0]).toBe(20);
    expect(v.trust).toBe('color');
    expect(v.bbox).toEqual({ x0: 2, y0: 0, x1: 3, y1: 2 });
  });

  it('projects through the fitBox, not the bbox', () => {
    const size: [number, number, number] = [80, 100, 50];
    const b = view('back', rect(200, 200, 50, 20, 130, 170));
    b.fitBox = { x0: 40, y0: 0, x1: 140, y1: 200 };
    const p = viewProjection(b, size);
    expect(projectPoint(p, [40, 50, 0])).toEqual([40, 0]);
    expect(projectPoint(p, [-40, -50, 0])).toEqual([140, 200]);
  });

  it('estimateObjectBox uses the fitBox and ignores colour-only and stretched views', () => {
    const front = view('front', rect(100, 100, 10, 0, 90, 100));
    const left = view('left', rect(50, 50, 10, 0, 30, 50)); // bbox 20 × 50 → D = 40
    left.fitBox = { x0: 10, y0: -10, x1: 30, y1: 70 }; // registered: cut feet, 20 × 80 → D = 25
    expect(estimateObjectBox([front, left], 0.5)).toEqual({ size: [80, 100, 25], depthFrom: 'side' });
    const color = { ...view('right', rect(100, 100, 0, 0, 60, 100)), trust: 'color' as const };
    expect(estimateObjectBox([front, color], 0.5).depthFrom).toBe('default');
    const stretched = { ...view('right', rect(100, 100, 0, 0, 60, 100)), registration: 'stretched' as const };
    expect(estimateObjectBox([front, stretched, left], 0.5).size[2]).toBe(25); // the registered side decides
    expect(estimateObjectBox([front, stretched], 0.5)).toEqual({ size: [80, 100, 60], depthFrom: 'side' }); // better than the default when alone
    expect(constrainsDepth([front, color])).toBe(false);
    expect(constrainsDepth([front, stretched])).toBe(true);
  });
});
