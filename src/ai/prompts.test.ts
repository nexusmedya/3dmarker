import { describe, expect, it } from 'vitest';
import { DEFAULT_PREP_OPTIONS, type PrepOptions } from './types';
import { getStyle, STYLE_KEEP_POSE, STYLES } from './styles';
import {
  ALPHA_BACKGROUND_PROMPT,
  buildPrepPrompt,
  buildViewPrompt,
  COMPLETE_BODY_PROMPT,
  COMPLETE_OBJECT_PROMPT,
  HUMAN_DETAIL_PROMPT,
  HUMAN_VIEW_DETAIL,
  isHumanoid,
  KEEP_LOOK_PROMPT,
  PLAIN_BACKGROUND_PROMPT,
  POSE_PRIORITY_PROMPT,
  prepNeeded,
  READINESS_PROMPT,
  SAME_POSE_PROMPT,
  SINGLE_VIEW_PROMPT,
  T_POSE_PROMPT,
  WHITE_BACKGROUND_PROMPT,
} from './prompts';

/** Brand / trademark words that must never reach a prompt or a style name. */
const TRADEMARKS = /\b(pixar|disney|ghibli|lego|funko|minecraft|fortnite|marvel|dc comics|nintendo|pok[eé]mon|playmobil|barbie|hasbro|mattel|dreamworks|roblox|zelda|mario|star wars|overwatch|warhammer|gundam|transformers|blizzard|sega|playstation|xbox|unreal|arcane|nendoroid|hot toys|bandai|sanrio|hello kitty|simpsons|anime studio)\b/i;

const opts = (p: Partial<PrepOptions> = {}): PrepOptions => ({ ...DEFAULT_PREP_OPTIONS, ...p });

describe('isHumanoid', () => {
  it('follows the subject, auto → detection', () => {
    expect(isHumanoid(opts({ subject: 'human' }), { isHuman: false })).toBe(true);
    expect(isHumanoid(opts({ subject: 'character' }), { isHuman: false })).toBe(true);
    expect(isHumanoid(opts({ subject: 'auto' }), { isHuman: true })).toBe(true);
    expect(isHumanoid(opts({ subject: 'auto' }), { isHuman: false })).toBe(false);
    expect(isHumanoid(opts({ subject: 'animal' }), { isHuman: true })).toBe(false);
  });
});

describe('prepNeeded', () => {
  it('is true only for real edits (background removal alone runs locally)', () => {
    expect(prepNeeded(opts())).toBe(false);
    expect(prepNeeded(opts({ removeBackground: true }))).toBe(false);
    expect(prepNeeded(opts({ styleId: 'bronze' }))).toBe(true);
    expect(prepNeeded(opts({ styleId: 'no-such-style' }))).toBe(false);
    expect(prepNeeded(opts({ tPose: true }))).toBe(true);
    expect(prepNeeded(opts({ tPose: true, subject: 'object' }))).toBe(false);
    expect(prepNeeded(opts({ completeBody: true }))).toBe(true);
    expect(prepNeeded(opts({ extraPrompt: '  ' }))).toBe(false);
    expect(prepNeeded(opts({ extraPrompt: 'add a hat' }))).toBe(true);
  });
});

describe('buildPrepPrompt', () => {
  it('asks for a T-pose and a completed body for humanoids', () => {
    const p = buildPrepPrompt(opts({ tPose: true, completeBody: true, subject: 'human' }), { isHuman: false });
    expect(p).toContain(T_POSE_PROMPT);
    expect(p).toContain('symmetric T-pose, arms straight out horizontally at shoulder height, palms down, legs straight and slightly apart');
    expect(p).toContain(COMPLETE_BODY_PROMPT);
    expect(p).toContain('complete the whole full-length body from head to feet');
    expect(p).toContain(HUMAN_DETAIL_PROMPT);
    expect(p).toContain('The subject is a person.');
    expect(p).toContain(KEEP_LOOK_PROMPT);
  });

  it('skips humanoid-only parts for objects', () => {
    const p = buildPrepPrompt(opts({ tPose: true, completeBody: true, subject: 'object' }), { isHuman: true });
    expect(p).not.toContain(T_POSE_PROMPT);
    expect(p).not.toContain(COMPLETE_BODY_PROMPT);
    expect(p).not.toContain(HUMAN_DETAIL_PROMPT);
    expect(p).toContain(COMPLETE_OBJECT_PROMPT);
  });

  it('adds the style, the background and 3D-readiness instructions', () => {
    const style = STYLES.find((s) => s.id === 'vinyl-figure')!;
    const p = buildPrepPrompt(opts({ styleId: 'vinyl-figure', removeBackground: true, extraPrompt: '  red   cap ' }), { isHuman: false });
    expect(p).toContain(style.prompt);
    expect(p).not.toContain(KEEP_LOOK_PROMPT);
    // Without real alpha output the model is asked for flat white, never "transparent" (fake checkerboards).
    expect(p).toContain(WHITE_BACKGROUND_PROMPT);
    expect(p).not.toContain('transparent background');
    expect(buildPrepPrompt(opts({ removeBackground: true }), { isHuman: false, alphaOutput: true })).toContain(ALPHA_BACKGROUND_PROMPT);
    expect(p).toContain(READINESS_PROMPT);
    expect(p.endsWith('Additional instructions: red cap')).toBe(true);
    expect(buildPrepPrompt(opts({ removeBackground: false }), { isHuman: false })).toContain(PLAIN_BACKGROUND_PROMPT);
  });

  it('lets a T-pose / body completion override the style’s pose and framing', () => {
    const style = getStyle('vinyl-figure')!;
    const reposed = buildPrepPrompt(opts({ styleId: 'vinyl-figure', tPose: true, subject: 'human' }), { isHuman: true });
    expect(reposed).not.toContain('pose and composition');
    expect(reposed).toContain(POSE_PRIORITY_PROMPT);
    expect(reposed.indexOf(T_POSE_PROMPT)).toBeLessThan(reposed.indexOf(style.prompt));
    const completed = buildPrepPrompt(opts({ styleId: 'vinyl-figure', completeBody: true }), { isHuman: true });
    expect(completed).not.toContain('pose and composition');
    expect(completed.indexOf(COMPLETE_BODY_PROMPT)).toBeLessThan(completed.indexOf(style.prompt));
    const restyled = buildPrepPrompt(opts({ styleId: 'vinyl-figure' }), { isHuman: true });
    expect(restyled).toContain(STYLE_KEEP_POSE);
    expect(restyled).toContain('pose and composition');
    expect(restyled).not.toContain(POSE_PRIORITY_PROMPT);
  });

  it('is deterministic', () => {
    const o = opts({ styleId: 'anime', tPose: true });
    expect(buildPrepPrompt(o, { isHuman: true })).toBe(buildPrepPrompt({ ...o }, { isHuman: true }));
  });
});

describe('buildViewPrompt', () => {
  const ctx = { isHuman: true, refViews: ['front' as const] };

  it('describes each view with the shared orientation conventions', () => {
    expect(buildViewPrompt('back', opts(), ctx)).toContain('the subject’s left side appears on the LEFT of the image');
    expect(buildViewPrompt('left', opts(), ctx)).toContain('camera placed at the subject’s left side');
    expect(buildViewPrompt('left', opts(), ctx)).toContain('The subject faces toward the LEFT edge of the image.');
    expect(buildViewPrompt('right', opts(), ctx)).toContain('The subject faces toward the RIGHT edge of the image.');
    expect(buildViewPrompt('top', opts(), ctx)).toContain('front points toward the BOTTOM edge');
    expect(buildViewPrompt('bottom', opts(), ctx)).toContain('front points toward the TOP edge');
  });

  it('keeps scale / framing / style and asks to complete unseen areas', () => {
    const p = buildViewPrompt('back', opts({ tPose: true }), ctx);
    expect(p).toContain('SAME scale, framing and height as the front view');
    expect(p).toContain('same subject, identity, art style');
    expect(p).toContain('Complete unseen areas plausibly');
    expect(p).toContain('back of the head');
    expect(buildViewPrompt('top', opts(), ctx)).toContain('SAME scale as the front view');
  });

  it('takes the pose from the reference, not from the live prep toggles', () => {
    // T-pose on, but the front may never have been prepared: the view must not claim a T-pose.
    const p = buildViewPrompt('left', opts({ tPose: true, subject: 'human', extraPrompt: 'add a hat' }), ctx);
    expect(p).not.toContain('T-pose');
    expect(p).toContain(SAME_POSE_PROMPT);
    expect(p).not.toContain('add a hat');
    // Extra instructions come along only when they produced the current front.
    const applied = buildViewPrompt('left', opts({ extraPrompt: 'add a hat' }), { ...ctx, frontPrep: opts({ extraPrompt: 'add a hat' }) });
    expect(applied).toContain('Additional instructions: add a hat');
    expect(buildViewPrompt('left', opts({ extraPrompt: 'add a hat' }), { ...ctx, frontPrep: null })).not.toContain('add a hat');
  });

  it('asks only for the detail each view can show, as one single image', () => {
    const back = buildViewPrompt('back', opts(), ctx);
    expect(back).not.toContain(HUMAN_DETAIL_PROMPT);
    expect(back).toContain('NOT visible');
    expect(back).not.toMatch(/nose|lips/);
    expect(buildViewPrompt('left', opts(), ctx)).toContain(HUMAN_VIEW_DETAIL.left);
    expect(buildViewPrompt('top', opts(), ctx)).not.toMatch(/lips/);
    expect(buildViewPrompt('back', opts(), { isHuman: false, refViews: ['front'] })).not.toContain('NOT visible');
    for (const v of ['back', 'left', 'right', 'top', 'bottom'] as const) {
      expect(buildViewPrompt(v, opts(), ctx)).toContain(SINGLE_VIEW_PROMPT);
      expect(buildViewPrompt(v, opts(), ctx)).toContain(WHITE_BACKGROUND_PROMPT);
      expect(buildViewPrompt(v, opts(), { ...ctx, alphaOutput: true })).toContain(ALPHA_BACKGROUND_PROMPT);
    }
  });

  it('names the reference images in order', () => {
    const p = buildViewPrompt('left', opts(), { isHuman: false, refViews: ['front', 'back', 'right'] });
    expect(p).toContain('image 1 is the front view, image 2 is the back view, image 3 is the right side view');
    expect(buildViewPrompt('left', opts(), { isHuman: false, refViews: [] })).toContain('The reference image shows the front view');
  });
});

describe('no trademarks', () => {
  it('in any prompt or style', () => {
    for (const s of STYLES) {
      expect(s.prompt).not.toMatch(TRADEMARKS);
      expect(s.name.tr).not.toMatch(TRADEMARKS);
      expect(s.name.en).not.toMatch(TRADEMARKS);
      expect(buildPrepPrompt(opts({ styleId: s.id, tPose: true, completeBody: true }), { isHuman: true })).not.toMatch(TRADEMARKS);
    }
    for (const v of ['back', 'left', 'right', 'top', 'bottom'] as const) expect(buildViewPrompt(v, opts(), { isHuman: true, refViews: ['front'] })).not.toMatch(TRADEMARKS);
  });

  it('nor descriptions of protected toy shapes', () => {
    for (const s of STYLES) expect(`${s.id} ${s.name.en} ${s.prompt}`).not.toMatch(/minifig|interlocking[- ]brick|c-shaped hands/i);
  });
});
