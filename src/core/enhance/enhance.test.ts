import { describe, expect, it, vi } from 'vitest';
import type { RGBAImage } from '../types';
import { AbortError } from '../types';
import { analyzeImage, blockiness, countColors, edgeAcutance } from './analyze';
import { alphaPlane, applyAlpha, bleedColors, hasAlpha } from './alpha';
import { enhanceImage, runAiPlan, runLocalPlan, type AiPlan, type AiUpscaler } from './enhance';
import { bilateralDenoise, deblock, lumaOf, unsharpMask } from './filters';
import { detectPixelGrid, pixelArtUpscale, pixelChain, reduceToGrid, scale2x, scale3x } from './pixelArt';
import { ENHANCE_MAX_SIDE, ENHANCE_PRESET_IDS, SR_MODELS, enhanceSuggestion, isEnhancePreset, localFallbackPlan, planEnhance } from './presets';
import { fitImage, resizeChannel, resizeImage } from './resize';
import { TileBlender, axisStarts, extractTile, planTiles } from './tiles';

// ---------------------------------------------------------------- fixtures

function solid(w: number, h: number, rgba: [number, number, number, number]): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
}

function px(img: RGBAImage, x: number, y: number): number[] {
  const o = (y * img.width + x) * 4;
  return Array.from(img.data.subarray(o, o + 4));
}

/** A small "sprite": a palette of 4 colours in blocks, transparent border. */
function sprite(w = 16, h = 16): RGBAImage {
  const img = solid(w, h, [0, 0, 0, 0]);
  const pal: [number, number, number, number][] = [[220, 40, 40, 255], [40, 200, 60, 255], [30, 60, 220, 255], [250, 230, 30, 255]];
  for (let y = 2; y < h - 2; y++)
    for (let x = 2; x < w - 2; x++) img.data.set(pal[((x >> 2) + (y >> 2)) % 4], (y * w + x) * 4);
  // a diagonal
  for (let i = 2; i < Math.min(w, h) - 2; i++) img.data.set([0, 0, 0, 255], (i * w + i) * 4);
  return img;
}

/** Nearest-neighbour k× blow-up. */
function nearest(img: RGBAImage, k: number): RGBAImage {
  const W = img.width * k, H = img.height * k;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) out.set(img.data.subarray(((((y / k) | 0) * img.width) + ((x / k) | 0)) * 4, ((((y / k) | 0) * img.width) + ((x / k) | 0)) * 4 + 4), (y * W + x) * 4);
  return { width: W, height: H, data: out };
}

/** Deterministic pseudo-random "photo": smooth gradients + texture + noise. */
function photo(w: number, h: number, seed = 1, noise = 0): RGBAImage {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const n = noise ? (rnd() - 0.5) * noise : 0;
      const edge = (x > w / 2) !== (y > h / 3) ? 90 : 0;
      data[o] = 60 + (x / w) * 120 + edge + n;
      data[o + 1] = 80 + (y / h) * 100 + Math.sin(x / 3) * 20 + n;
      data[o + 2] = 120 + Math.cos((x + y) / 5) * 40 + edge / 2 + n;
      data[o + 3] = 255;
    }
  return { width: w, height: h, data };
}

/** Vertical step edges (period 16), crisp or box-blurred over `blur` px. */
function stepImage(w: number, h: number, blur = 0): RGBAImage {
  const crisp = (x: number) => ((x % 16) < 8 ? 20 : 230);
  const img = solid(w, h, [0, 0, 0, 255]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = crisp(x);
      if (blur > 1) {
        let sum = 0;
        for (let k = 0; k < blur; k++) sum += crisp(Math.min(w - 1, Math.max(0, x + k - (blur >> 1))));
        v = sum / blur;
      }
      img.data.set([v, v, v, 255], (y * w + x) * 4);
    }
  return img;
}

// ---------------------------------------------------------------- resize

describe('resize', () => {
  it('keeps a flat colour flat (no ringing) and hits the exact size', () => {
    const img = solid(10, 6, [100, 150, 200, 255]);
    for (const k of ['lanczos3', 'bicubic', 'bilinear'] as const) {
      const up = resizeImage(img, 25, 13, k);
      expect([up.width, up.height]).toEqual([25, 13]);
      for (let i = 0; i < up.data.length; i += 4) expect(Array.from(up.data.subarray(i, i + 4))).toEqual([100, 150, 200, 255]);
    }
  });

  it('is premultiplied: transparent pixels do not darken the edge', () => {
    const img = solid(8, 1, [0, 0, 0, 0]);
    for (let x = 4; x < 8; x++) img.data.set([255, 255, 255, 255], x * 4);
    const up = resizeImage(img, 32, 4, 'lanczos3');
    for (let x = 0; x < 32; x++) {
      const [r, , , a] = px(up, x, 1);
      if (a > 20) expect(r).toBeGreaterThan(240); // colour stays white wherever visible
    }
  });

  it('downscales with a proper low-pass (checkerboard → grey)', () => {
    const img = solid(64, 64, [0, 0, 0, 255]);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if ((x + y) % 2) img.data.set([255, 255, 255, 255], (y * 64 + x) * 4);
    const down = resizeImage(img, 16, 16);
    for (let i = 0; i < down.data.length; i += 4) expect(Math.abs(down.data[i] - 128)).toBeLessThan(12);
  });

  it('fitImage never upscales; resizeChannel interpolates smoothly', () => {
    const img = solid(10, 10, [1, 2, 3, 255]);
    expect(fitImage(img, 20)).toBe(img);
    expect(fitImage(solid(40, 20, [0, 0, 0, 255]), 20).width).toBe(20);
    const a = resizeChannel(Uint8Array.from([0, 255]), 2, 1, 8, 1, 'bicubic');
    for (let i = 1; i < 8; i++) expect(a[i]).toBeGreaterThanOrEqual(a[i - 1]);
  });
});

// ---------------------------------------------------------------- pixel art

describe('pixel art', () => {
  it('scale2x / scale3x keep the palette and round diagonals', () => {
    const img = sprite();
    const colors = countColors(img);
    const s2 = scale2x(img);
    const s3 = scale3x(img);
    expect([s2.width, s2.height]).toEqual([32, 32]);
    expect([s3.width, s3.height]).toEqual([48, 48]);
    expect(countColors(s2)).toBe(colors);
    expect(countColors(s3)).toBe(colors);
    // EPX of a lone diagonal pixel pair fills the inner corners.
    const d = solid(3, 3, [255, 255, 255, 255]);
    d.data.set([0, 0, 0, 255], 0);
    d.data.set([0, 0, 0, 255], (1 * 3 + 1) * 4);
    d.data.set([0, 0, 0, 255], (0 * 3 + 1) * 4); // B above E... produce a staircase
    const e = scale2x(d);
    expect(px(e, 2, 0)).toEqual([0, 0, 0, 255]);
  });

  it('flat images pass through Scale2x unchanged (nearest)', () => {
    const img = solid(4, 4, [9, 8, 7, 255]);
    expect(Array.from(scale2x(img).data)).toEqual(Array.from(nearest(img, 2).data));
  });

  it('detects a nearest-neighbour grid with its phase and reduces it back', () => {
    const art = sprite(20, 20);
    const big = nearest(art, 4);
    const g = detectPixelGrid(big);
    expect(g).toEqual({ size: 4, offsetX: 0, offsetY: 0 });
    const back = reduceToGrid(big, g);
    expect([back.width, back.height]).toEqual([20, 20]);
    expect(Array.from(back.data)).toEqual(Array.from(art.data));
    // Cropped by 2 px: phase 2.
    const cropped: RGBAImage = { width: big.width - 2, height: big.height, data: new Uint8ClampedArray((big.width - 2) * big.height * 4) };
    for (let y = 0; y < big.height; y++) cropped.data.set(big.data.subarray((y * big.width + 2) * 4, (y * big.width + big.width) * 4), y * cropped.width * 4);
    expect(detectPixelGrid(cropped)).toMatchObject({ size: 4, offsetX: 2 });
    expect(detectPixelGrid(photo(64, 64, 3, 30)).size).toBe(1);
  });

  it('chains 2× / 3× steps to the target without passing the cap', () => {
    expect(pixelChain(32, 1024, 2048)).toEqual([2, 2, 2, 2, 2]);
    expect(pixelChain(400, 1024, 2048)).toEqual([3]);
    expect(pixelChain(1500, 1024, 2048)).toEqual([]);
    const r = pixelArtUpscale(sprite(), 128, 2048);
    expect(r.image.width).toBe(128);
    expect(r.steps).toEqual([2, 2, 2]);
  });
});

// ---------------------------------------------------------------- filters

describe('filters', () => {
  it('unsharp mask increases edge contrast, leaves flat areas and alpha alone', () => {
    const img = stepImage(64, 8, 4);
    const out = unsharpMask(img, { amount: 1, radius: 1.5 });
    const contrast = (im: RGBAImage) => {
      let m = 0;
      for (let x = 0; x + 1 < 64; x++) m = Math.max(m, Math.abs(px(im, x + 1, 4)[0] - px(im, x, 4)[0]));
      return m;
    };
    expect(contrast(out)).toBeGreaterThan(contrast(img));
    const flat = solid(16, 16, [90, 90, 90, 200]);
    expect(Array.from(unsharpMask(flat).data)).toEqual(Array.from(flat.data));
  });

  it('bilateral denoise reduces noise but keeps a strong edge', () => {
    const img = stepImage(64, 32, 0);
    let s = 7;
    for (let i = 0; i < img.data.length; i += 4) {
      s = (s * 1103515245 + 12345) >>> 0;
      const n = ((s >>> 16) % 21) - 10;
      for (let c = 0; c < 3; c++) img.data[i + c] = img.data[i + c] + n;
    }
    const out = bilateralDenoise(img);
    const variance = (im: RGBAImage) => {
      // inside the dark half of the first period
      let sum = 0, sq = 0, n = 0;
      for (let y = 2; y < 30; y++) for (let x = 1; x < 6; x++) { const v = px(im, x, y)[0]; sum += v; sq += v * v; n++; }
      return sq / n - (sum / n) ** 2;
    };
    expect(variance(out)).toBeLessThan(variance(img) * 0.5);
    expect(px(out, 7, 10)[0]).toBeLessThan(60); // edge between x=7 and x=8 stays sharp
    expect(px(out, 8, 10)[0]).toBeGreaterThan(190);
  });

  it('deblock smooths small 8×8 steps but not real edges', () => {
    const img = solid(32, 32, [100, 100, 100, 255]);
    for (let y = 0; y < 32; y++) for (let x = 8; x < 16; x++) img.data.set([106, 106, 106, 255], (y * 32 + x) * 4);
    for (let y = 0; y < 32; y++) for (let x = 24; x < 32; x++) img.data.set([200, 200, 200, 255], (y * 32 + x) * 4);
    const out = deblock(img);
    expect(Math.abs(px(out, 8, 5)[0] - px(out, 7, 5)[0])).toBeLessThan(6);
    expect(px(out, 23, 5)[0]).toBe(100);
    expect(px(out, 24, 5)[0]).toBe(200);
  });
});

// ---------------------------------------------------------------- analysis

describe('analyzeImage', () => {
  it('flags a small sprite as pixel art, a blown-up one via its grid', () => {
    const a = analyzeImage(sprite(48, 48));
    expect(a.pixelArt).toBe(true);
    expect(a.small).toBe(true);
    const big = analyzeImage(nearest(sprite(40, 40), 8));
    expect(big.grid.size).toBe(8);
    expect(big.pixelArt).toBe(true);
    expect(big.jpegArtifacts).toBe(false);
    expect(enhanceSuggestion(big)).toMatchObject({ preset: 'pixel', reasons: ['pixelated', 'small'].filter((r) => r !== 'small' || big.small) });
  });

  it('tells crisp edges from smeared ones', () => {
    const y = (img: RGBAImage) => lumaOf(img);
    const crisp = edgeAcutance(y(stepImage(128, 64, 0)), 128, 64)!;
    const soft = edgeAcutance(y(stepImage(128, 64, 6)), 128, 64)!;
    expect(crisp).toBeGreaterThan(0.9);
    expect(soft).toBeLessThan(0.3);
    const a = analyzeImage(stepImage(600, 600, 6));
    expect(a.blurry).toBe(true);
    expect(a.pixelArt).toBe(false);
    expect(enhanceSuggestion(a)?.reasons).toContain('blurry');
  });

  it('measures JPEG blockiness on the 8-px grid', () => {
    const img = photo(64, 64, 5);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if ((x >> 3) % 2) for (let c = 0; c < 3; c++) img.data[(y * 64 + x) * 4 + c] += 12;
    expect(blockiness(lumaOf(img), 64, 64)).toBeGreaterThan(1.3);
    expect(blockiness(lumaOf(photo(64, 64, 5)), 64, 64)).toBeLessThan(1.3);
  });

  it('a large crisp photo needs nothing', () => {
    const a = analyzeImage(photo(700, 600, 2));
    expect(a.small).toBe(false);
    expect(a.pixelArt).toBe(false);
    expect(enhanceSuggestion(a)).toBeNull();
  });
});

// ---------------------------------------------------------------- presets

describe('presets', () => {
  const base = analyzeImage(photo(300, 200, 4));

  it('knows its preset ids', () => {
    expect(ENHANCE_PRESET_IDS).toEqual(['auto', 'ai-x2', 'ai-x4', 'pixel', 'sharpen', 'denoise']);
    expect(isEnhancePreset('ai-x4')).toBe(true);
    expect(isEnhancePreset('x')).toBe(false);
  });

  it('AI plans pick the Swin2SR model and cap the result at ENHANCE_MAX_SIDE', () => {
    expect(planEnhance('ai-x2', base)).toMatchObject({ kind: 'ai', model: SR_MODELS.x2, scale: 2, width: 600, height: 400 });
    expect(planEnhance('ai-x4', base)).toMatchObject({ kind: 'ai', model: SR_MODELS.x4, width: 1200, height: 800 });
    expect(planEnhance('ai-x4', { ...base, jpegArtifacts: true })).toMatchObject({ model: SR_MODELS.x4Jpeg });
    const big = { ...base, width: 1000, height: 800, maxSide: 1000 };
    const p = planEnhance('ai-x4', big) as AiPlan;
    expect(p.inputWidth).toBe(512);
    expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(ENHANCE_MAX_SIDE);
  });

  it('auto: pixel art → pixel scaler, small → AI, fine → sharpen', () => {
    expect(planEnhance('auto', { ...base, pixelArt: true }).kind).toBe('pixel');
    expect(planEnhance('auto', { ...base, small: true })).toMatchObject({ kind: 'ai', scale: 4 });
    expect(planEnhance('auto', { ...base, width: 450, height: 300, maxSide: 450, small: true })).toMatchObject({ kind: 'ai', scale: 2 });
    expect(planEnhance('auto', { ...base, small: false, blurry: false })).toMatchObject({ kind: 'filter', ops: ['sharpen'], width: 300 });
    expect(planEnhance('denoise', base)).toMatchObject({ kind: 'filter', ops: ['deblock', 'denoise'] });
  });

  it('pixel plan predicts the scaler output size', () => {
    const img = nearest(sprite(40, 40), 8);
    const a = analyzeImage(img);
    const plan = planEnhance('pixel', a);
    const out = runLocalPlan(img, plan as Exclude<typeof plan, { kind: 'ai' }>);
    expect([out.width, out.height]).toEqual([plan.width, plan.height]);
    expect(out.width).toBe(40 * 32); // 40 → 1280 via 2⁵
  });

  it('local fallback of an AI plan keeps its size', () => {
    const ai = planEnhance('ai-x4', base) as AiPlan;
    expect(localFallbackPlan(ai, base)).toMatchObject({ kind: 'filter', width: ai.width, height: ai.height });
  });
});

// ---------------------------------------------------------------- tiles

describe('tiles', () => {
  it('covers the image with equal overlapping tiles, the last flush with the edge', () => {
    expect(axisStarts(100, 128, 16)).toEqual([0]);
    expect(axisStarts(300, 128, 16)).toEqual([0, 112, 172]);
    const tiles = planTiles(300, 100, 128, 16);
    expect(tiles).toHaveLength(3);
    expect(tiles.every((t) => t.w === 128 && t.h === 100)).toBe(true);
    expect(tiles[0]).toMatchObject({ left: false, right: true });
    expect(tiles[2]).toMatchObject({ x: 172, left: true, right: false });
  });

  it('pads tiles to a multiple of 8 by edge replication', () => {
    const img = photo(13, 5);
    const t = extractTile(img.data, 13, 4, { x: 0, y: 0, w: 13, h: 5, left: false, right: false, top: false, bottom: false });
    expect([t.width, t.height]).toEqual([16, 8]);
    expect(Array.from(t.data.subarray((7 * 16 + 15) * 3, (7 * 16 + 15) * 3 + 3))).toEqual(px(img, 12, 4).slice(0, 3));
  });

  it('blending nearest-upscaled tiles reproduces a seamless nearest upscale', () => {
    const img = photo(70, 45, 9);
    const scale = 2;
    const tiles = planTiles(70, 45, 24, 8);
    const blend = new TileBlender(140, 90, scale, 8);
    for (const t of tiles) {
      const tile = extractTile(img.data, 70, 4, t, 8);
      const up = nearest({ width: tile.width, height: tile.height, data: Uint8ClampedArray.from({ length: tile.width * tile.height * 4 }, (_, i) => (i % 4 === 3 ? 255 : tile.data[((i / 4) | 0) * 3 + (i % 4)])) }, scale);
      blend.add(t, up.data, up.width, 4);
    }
    const out = blend.result();
    const want = nearest(img, 2);
    let maxDiff = 0;
    for (let i = 0; i < out.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out[i] - want.data[i]));
    expect(maxDiff).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------- alpha + orchestration

describe('alpha', () => {
  it('bleeds visible colours into transparent pixels and puts a smooth matte back', () => {
    const img = solid(8, 8, [0, 0, 0, 0]);
    for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) img.data.set([200, 50, 10, 255], (y * 8 + x) * 4);
    expect(hasAlpha(img)).toBe(true);
    const bled = bleedColors(img);
    expect(px(bled, 0, 0)).toEqual([200, 50, 10, 255]);
    const up = applyAlpha(solid(32, 32, [1, 2, 3, 255]), alphaPlane(img), 8, 8);
    expect(px(up, 0, 0)[3]).toBe(0);
    expect(px(up, 16, 16)[3]).toBe(255);
    const edge = Array.from({ length: 32 }, (_, x) => px(up, x, 16)[3]);
    expect(edge.some((a) => a > 0 && a < 255)).toBe(true); // smooth, not blocky
  });
});

describe('enhanceImage', () => {
  const fakeAi: AiUpscaler = async (img, plan) => resizeImage(img, img.width * plan.scale, img.height * plan.scale, 'bicubic');

  it('AI plan: the upscaler gets an opaque image; alpha is upscaled separately', async () => {
    const img = sprite(40, 30);
    img.data.set([10, 20, 30, 128], 0); // soft alpha pixel
    const seen: RGBAImage[] = [];
    const out = await enhanceImage(img, 'ai-x2', {
      upscaleAi: async (i, p, o) => {
        seen.push(i);
        return fakeAi(i, p, o);
      },
    });
    expect(hasAlpha(seen[0])).toBe(false);
    expect([out.image.width, out.image.height]).toEqual([80, 60]);
    expect(px(out.image, 79, 59)[3]).toBe(0);
    expect(px(out.image, 40, 30)[3]).toBe(255);
  });

  it('automatic preset falls back to local upscaling when the AI fails; explicit AI presets report the error', async () => {
    const img = photo(100, 80, 3);
    const failing: AiUpscaler = async () => {
      throw new Error('Failed to fetch');
    };
    const out = await enhanceImage(img, 'auto', { upscaleAi: failing });
    expect(out.fallbackError).toBeInstanceOf(Error);
    expect(out.plan).toMatchObject({ kind: 'filter' });
    expect(out.image.width).toBe(400);
    await expect(enhanceImage(img, 'ai-x2', { upscaleAi: failing })).rejects.toThrow('Failed to fetch');
  });

  it('aborts pass through without a fallback', async () => {
    const ctrl = new AbortController();
    const up = vi.fn<AiUpscaler>(async () => {
      ctrl.abort();
      throw new AbortError();
    });
    await expect(enhanceImage(photo(64, 64), 'auto', { upscaleAi: up, signal: ctrl.signal })).rejects.toBeInstanceOf(AbortError);
  });

  it('runAiPlan resizes an off-size model output to the plan', async () => {
    const img = photo(30, 20);
    const plan = planEnhance('ai-x2', analyzeImage(img)) as AiPlan;
    const out = await runAiPlan(img, plan, async (i) => resizeImage(i, 59, 41));
    expect([out.width, out.height]).toEqual([60, 40]);
  });
});

// ---------------------------------------------------------------- speed

describe('performance (1024², Node)', () => {
  const img = photo(1024, 1024, 11, 20);
  const time = (fn: () => unknown) => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };

  it.each([
    ['unsharp mask', () => unsharpMask(img)],
    ['bilateral denoise', () => bilateralDenoise(img)],
    ['deblock', () => deblock(img)],
    ['lanczos 1024 → 2048', () => resizeImage(img, 2048, 2048)],
    ['scale2x', () => scale2x(img)],
    ['analysis', () => analyzeImage(img)],
  ])('%s ≤ 1 s', (_name, fn) => {
    expect(time(fn)).toBeLessThan(1000);
  });
});
