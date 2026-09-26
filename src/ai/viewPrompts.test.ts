import { describe, expect, it } from 'vitest';
import type { Mask, RGBAImage } from '../core/types';
import { HUMAN_VIEW_DETAIL, SAME_POSE_PROMPT, SINGLE_VIEW_PROMPT, VIEW_DESCRIPTIONS, WHITE_BACKGROUND_PROMPT } from './prompts';
import { buildUserViewPrompt, measureFrontFraming, type FrontFraming } from './viewPrompts';

/** Brand / trademark words that must never reach a prompt (same list as prompts.test.ts). */
const TRADEMARKS = /\b(pixar|disney|ghibli|lego|funko|minecraft|fortnite|marvel|dc comics|nintendo|pok[eé]mon|playmobil|barbie|hasbro|mattel|dreamworks|roblox|zelda|mario|star wars|overwatch|warhammer|gundam|transformers|blizzard|sega|playstation|xbox|unreal|arcane|nendoroid|hot toys|bandai|sanrio|hello kitty|simpsons|anime studio)\b/i;

const opaque = (w: number, h: number): RGBAImage => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) });

/** A T-pose stick figure mask: head, a wide arm band, a torso and legs. */
function tPoseMask(w = 100, h = 200): Mask {
  const data = new Uint8Array(w * h);
  const rect = (x0: number, x1: number, y0: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * w + x] = 1;
  };
  rect(44, 56, 20, 40); // head
  rect(10, 90, 50, 60); // arms
  rect(40, 60, 40, 110); // torso
  rect(40, 49, 110, 180); // legs
  rect(51, 60, 110, 180);
  return { width: w, height: h, data };
}

/** The same figure with the arms down (no wide band). */
function aPoseMask(w = 100, h = 200): Mask {
  const m = tPoseMask(w, h);
  for (let y = 50; y < 60; y++) for (let x = 0; x < w; x++) if (x < 40 || x >= 60) m.data[y * w + x] = 0;
  return m;
}

function alphaImage(mask: Mask): RGBAImage {
  const img = opaque(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i++) img.data[i * 4 + 3] = mask.data[i] ? 255 : 0;
  return img;
}

describe('measureFrontFraming', () => {
  it('measures the bbox and the arm band of a T-pose from the mask', () => {
    const f = measureFrontFraming(opaque(100, 200), tPoseMask());
    expect(f).toMatchObject({ width: 100, height: 200, bbox: { x0: 10, y0: 20, x1: 90, y1: 180 } });
    // Arm rows 50..60 of a figure spanning rows 20..180 → 18.75 %..25 % of its height.
    expect(f.armBand).not.toBeNull();
    expect(f.armBand![0]).toBeCloseTo(30 / 160, 5);
    expect(f.armBand![1]).toBeCloseTo(40 / 160, 5);
  });

  it('finds no arm band without a wide row band, uses the alpha without a mask, and gives up on an opaque image', () => {
    expect(measureFrontFraming(opaque(100, 200), aPoseMask()).armBand).toBeNull();
    const fromAlpha = measureFrontFraming(alphaImage(tPoseMask()), null);
    expect(fromAlpha.bbox).toEqual({ x0: 10, y0: 20, x1: 90, y1: 180 });
    expect(fromAlpha.armBand).not.toBeNull();
    const unknown = measureFrontFraming(opaque(64, 48), null);
    expect(unknown).toEqual({ width: 64, height: 48, bbox: null, armBand: null });
  });
});

describe('buildUserViewPrompt', () => {
  const framing = (): FrontFraming => measureFrontFraming(opaque(768, 768), tPoseMask(768, 768));

  it('describes the view, the measured framing and the output size', () => {
    const front = measureFrontFraming(opaque(100, 200), tPoseMask());
    const p = buildUserViewPrompt('back', { front, isHuman: false, tPose: false });
    expect(p.startsWith('Attached is the FRONT view of my subject. Render the BACK view')).toBe(true);
    expect(p).toContain(VIEW_DESCRIPTIONS.back);
    expect(p).toContain('180° around the vertical axis');
    expect(p).toContain('the figure spans 80 % of the image height'); // rows 20..180 of 200
    expect(p).toContain('at least 5 % empty margin'); // min(10, 20, 10, 20) / 200
    expect(p).toContain('Output size 100 × 200 px');
    expect(p).toContain('the top and the bottom of the subject at the SAME image heights');
    expect(p).toContain(SAME_POSE_PROMPT);
    expect(p).toContain(WHITE_BACKGROUND_PROMPT);
    expect(p).toContain(SINGLE_VIEW_PROMPT);
    expect(buildUserViewPrompt('left', { front, isHuman: false, tPose: false })).toContain('90° around the vertical axis');
    expect(buildUserViewPrompt('top', { front, isHuman: false, tPose: false })).toMatch(/the TOP view[\s\S]*straight down[\s\S]*% of the image height/);
  });

  it('falls back to a generic framing when the front has no silhouette', () => {
    const p = buildUserViewPrompt('right', { front: { width: 640, height: 480, bbox: null, armBand: null }, isHuman: false, tPose: false });
    expect(p).toContain('spans 80 % of the image height');
    expect(p).toContain('at least 8 % empty margin');
    expect(p).toContain('Output size 640 × 480 px');
    expect(p).not.toContain('outstretched arms');
  });

  it('pins the arm height only for T-pose-like fronts and spells the T-pose out when asked', () => {
    const tpose = buildUserViewPrompt('back', { front: framing(), isHuman: true, tPose: true });
    expect(tpose).toMatch(/The widest part \(the outstretched arms\) is at \d+–\d+ % of the figure height from the top/);
    expect(tpose).toContain('a strict T-pose: both arms straight out horizontally at shoulder height');
    const apose = buildUserViewPrompt('back', { front: measureFrontFraming(opaque(100, 200), aPoseMask()), isHuman: true, tPose: false });
    expect(apose).not.toContain('outstretched arms');
    expect(apose).not.toContain('strict T-pose');
    expect(apose).toContain('Pose: exactly the same pose as the attached image.');
  });

  it('adds the human detail of the view only for people', () => {
    for (const v of ['back', 'left', 'right', 'top', 'bottom'] as const) {
      expect(buildUserViewPrompt(v, { front: framing(), isHuman: true, tPose: false })).toContain(HUMAN_VIEW_DETAIL[v]);
      expect(buildUserViewPrompt(v, { front: framing(), isHuman: false, tPose: false })).not.toContain(HUMAN_VIEW_DETAIL[v]);
    }
    expect(buildUserViewPrompt('back', { front: framing(), isHuman: true, tPose: false })).toContain('the top of the head and the soles');
  });

  it('is deterministic and free of brand names', () => {
    for (const v of ['back', 'left', 'right', 'top', 'bottom'] as const) {
      const a = buildUserViewPrompt(v, { front: framing(), isHuman: true, tPose: true });
      expect(a).toBe(buildUserViewPrompt(v, { front: framing(), isHuman: true, tPose: true }));
      expect(a).not.toMatch(TRADEMARKS);
    }
  });
});
