import { describe, expect, it, vi } from 'vitest';
import type { DriverInput, Mask, RGBAImage } from '../../core/types';
import { AbortError, defaultParams } from '../../core/types';
import { inflateDepth, inflateDriver, LocalizedError, resolveSilhouette, type InflateOptions } from './inflate';

function maskOf(w: number, h: number, inside: (x: number, y: number) => boolean): Mask {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = inside(x + 0.5, y + 0.5) ? 1 : 0;
  return { width: w, height: h, data };
}

function imageOf(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(px(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}

const opts = (o: Partial<InflateOptions> = {}): InflateOptions => ({ profile: 'round', thickness: 0, detail: 0, blur: 0, ...o });

function input(image: RGBAImage, mask: Mask | null, params = {}, signal = new AbortController().signal): DriverInput {
  return {
    image, mask, file: new Blob(), signal, onProgress: () => {},
    params: { ...defaultParams(inflateDriver.params), ...params },
  };
}

// Disk of radius R centred in a (2R + 20)² image.
const R = 40, S = 2 * R + 20, C = S / 2;
const disk = maskOf(S, S, (x, y) => (x - C) ** 2 + (y - C) ** 2 <= R * R);
const at = (d: Float32Array, x: number, y: number) => d[y * S + x];

describe('inflateDepth', () => {
  it('turns a disk into a hemisphere (round profile)', () => {
    const { data } = inflateDepth(disk, null, opts());
    expect(Math.max(...data)).toBeCloseTo(1, 5);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const v = at(data, x, y);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        if (!disk.data[y * S + x]) expect(v).toBe(0);
      }
    // Compare against sqrt(1 - (r/R)²) away from the steep rim.
    for (const r of [0, 10, 20, 30]) {
      const want = Math.sqrt(1 - (r / R) ** 2);
      expect(Math.abs(at(data, Math.floor(C + r), Math.floor(C)) - want)).toBeLessThan(0.04);
    }
    // Edge pixels are low; the centre is the peak.
    expect(at(data, Math.floor(C - R + 0.5), Math.floor(C))).toBeLessThan(0.3);
  });

  it('is symmetric and decreases away from the centre', () => {
    const { data } = inflateDepth(disk, null, opts({ blur: 1 }));
    const cy = Math.floor(C);
    for (let x = Math.floor(C); x < S - 1; x++) {
      expect(at(data, x + 1, cy)).toBeLessThanOrEqual(at(data, x, cy) + 1e-6);
      expect(at(data, x, cy)).toBeCloseTo(at(data, S - 1 - x, cy), 4);
      expect(at(data, cy, x)).toBeCloseTo(at(data, x, cy), 4);
    }
  });

  // Big disk (r 40) + thin bar (half-width 5) + small disk (r 20).
  const W = 200, H = 120;
  const dumbbell = maskOf(W, H, (x, y) =>
    (x - 60) ** 2 + (y - 60) ** 2 <= 40 * 40 ||
    (x >= 60 && x <= 160 && Math.abs(y - 60) <= 5) ||
    (x - 160) ** 2 + (y - 60) ** 2 <= 20 * 20);
  const mid = (d: Float32Array, x: number) => d[60 * W + x];

  it('keeps thin parts proportionally thin, and lifts them with thickness', () => {
    const thin = inflateDepth(dumbbell, null, opts()).data;
    expect(mid(thin, 60)).toBeCloseTo(1, 1);
    expect(mid(thin, 120)).toBeGreaterThan(0.08);
    expect(mid(thin, 120)).toBeLessThan(0.16); // ≈ 5 / 40
    expect(mid(thin, 160)).toBeGreaterThan(0.4); // ≈ 20 / 40
    expect(mid(thin, 160)).toBeLessThan(0.55);

    const thick = inflateDepth(dumbbell, null, opts({ thickness: 0.5 })).data;
    expect(mid(thick, 120)).toBeGreaterThan(mid(thin, 120) * 2);
    expect(mid(thick, 60)).toBeCloseTo(1, 1);
    // No dip where the bar meets the big disk.
    for (let x = 101; x < 125; x++) expect(mid(thick, x)).toBeGreaterThan(mid(thick, 120) * 0.9);

    const uniform = inflateDepth(dumbbell, null, opts({ thickness: 1 })).data;
    expect(mid(uniform, 120)).toBeGreaterThan(0.8);
  });

  it('soft profile is a paraboloid with gentler edges', () => {
    const round = inflateDepth(disk, null, opts()).data;
    const soft = inflateDepth(disk, null, opts({ profile: 'soft' })).data;
    const cy = Math.floor(C);
    for (const r of [0, 10, 20, 30]) {
      expect(Math.abs(at(soft, Math.floor(C + r), cy) - (1 - (r / R) ** 2))).toBeLessThan(0.05);
    }
    const rim = Math.floor(C + R - 1);
    expect(at(soft, rim, cy)).toBeLessThan(at(round, rim, cy));
  });

  it('flat profile has a plateau with a rounded bevel', () => {
    const { data } = inflateDepth(disk, null, opts({ profile: 'flat' }));
    let fg = 0, top = 0;
    for (let i = 0; i < data.length; i++) {
      if (!disk.data[i]) continue;
      fg++;
      if (data[i] > 0.999) top++;
    }
    expect(top / fg).toBeGreaterThan(0.6);
    const cy = Math.floor(C);
    expect(at(data, Math.floor(C - R + 0.5), cy)).toBeLessThan(0.9);
  });

  it('adds image detail inside the silhouette without touching the background', () => {
    const img = imageOf(S, S, (x) => (Math.floor(x / 4) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const plain = inflateDepth(disk, img, opts()).data;
    const detailed = inflateDepth(disk, img, opts({ detail: 1 })).data;
    let diff = 0;
    for (let i = 0; i < plain.length; i++) {
      expect(detailed[i]).toBeGreaterThanOrEqual(0);
      expect(detailed[i]).toBeLessThanOrEqual(1);
      if (!disk.data[i]) expect(detailed[i]).toBe(0);
      diff = Math.max(diff, Math.abs(detailed[i] - plain[i]));
    }
    expect(diff).toBeGreaterThan(0.05);
  });

  it('handles masks touching the image border and single pixels', () => {
    const full = maskOf(9, 5, () => true);
    const d = inflateDepth(full, null, opts({ blur: 1, thickness: 0.3, profile: 'soft' })).data;
    expect(Math.max(...d)).toBeCloseTo(1, 5);
    expect(d.every((v) => v >= 0 && v <= 1 && Number.isFinite(v))).toBe(true);
    const dot = maskOf(5, 5, (x, y) => x > 2 && x < 3 && y > 2 && y < 3);
    const dd = inflateDepth(dot, null, opts({ profile: 'flat', thickness: 0.5 })).data;
    expect(dd[2 * 5 + 2]).toBe(1);
  });

  it('is fast enough for 1024×1024', () => {
    const big = maskOf(1024, 1024, (x, y) => (x - 512) ** 2 + (y - 512) ** 2 < 400 ** 2 || (Math.abs(x - 512) < 30 && y > 80));
    const t0 = performance.now();
    inflateDepth(big, null, opts({ thickness: 0.2, blur: 1 }));
    expect(performance.now() - t0).toBeLessThan(4000);
  });
});

describe('resolveSilhouette', () => {
  it('prefers the given mask, then alpha, then the border colour', () => {
    const opaque = imageOf(20, 20, (x, y) => (x >= 5 && x < 15 && y >= 5 && y < 15 ? [200, 0, 0, 255] : [255, 255, 255, 255]));
    const given = maskOf(20, 20, (x) => x < 10);
    expect(resolveSilhouette(opaque, given)).toBe(given);
    expect(resolveSilhouette(opaque, null)!.data.reduce((a, b) => a + b, 0)).toBe(100);
    const alpha = imageOf(20, 20, (x, y) => [255, 255, 255, x >= 2 && x < 8 && y >= 2 && y < 8 ? 255 : 0]);
    expect(resolveSilhouette(alpha, null)!.data.reduce((a, b) => a + b, 0)).toBe(36);
    // A mask of another size is resampled to the image.
    expect(resolveSilhouette(opaque, maskOf(10, 10, () => true))!.width).toBe(20);
    expect(resolveSilhouette(opaque, maskOf(20, 20, () => false))).toBeNull();
  });
});

describe('inflateDriver', () => {
  it('declares its contract', () => {
    expect(inflateDriver.id).toBe('silhouette-inflate');
    expect(inflateDriver.category).toBe('heuristic');
    expect(inflateDriver.badges).toEqual(['offline', 'closed-mesh']);
    expect(inflateDriver.producesDepth).toBe(true);
    expect(Object.keys(defaultParams(inflateDriver.params)).sort()).toEqual(['blur', 'detail', 'profile', 'thickness']);
    expect(inflateDriver.description.en).toMatch(/Double-sided/);
    expect(inflateDriver.description.tr).toMatch(/Çift yüz/);
  });

  it('inflates a square on a white background without a mask', async () => {
    const img = imageOf(64, 64, (x, y) => (x >= 16 && x < 48 && y >= 16 && y < 48 ? [30, 90, 200, 255] : [255, 255, 255, 255]));
    const onProgress = vi.fn();
    const res = await inflateDriver.run({ ...input(img, null), onProgress });
    expect(res.kind).toBe('depth');
    if (res.kind !== 'depth') return;
    expect(res.mask!.data.reduce((a, b) => a + b, 0)).toBe(32 * 32);
    expect(res.depth.width).toBe(64);
    expect(res.depth.data[32 * 64 + 32]).toBeGreaterThan(0.95);
    expect(res.depth.data[0]).toBe(0);
    expect(onProgress).toHaveBeenCalled();
  });

  it('asks for a transparent PNG or plain background when no silhouette can be found', async () => {
    const busy = imageOf(64, 64, (x, y) => [x * 4, y * 4, (x * y) % 256, 255]);
    const err = await inflateDriver.run(input(busy, null)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalizedError);
    expect((err as LocalizedError).i18n.en).toMatch(/transparent/);
    expect((err as LocalizedError).i18n.tr).toMatch(/saydam/i);
  });

  it('honours the abort signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const img = imageOf(8, 8, () => [0, 0, 0, 255]);
    await expect(inflateDriver.run(input(img, maskOf(8, 8, () => true), {}, ac.signal))).rejects.toBeInstanceOf(AbortError);
  });

  it('falls back to defaults for garbage params', async () => {
    const img = imageOf(32, 32, () => [0, 0, 0, 255]);
    const res = await inflateDriver.run(input(img, maskOf(32, 32, (x, y) => (x - 16) ** 2 + (y - 16) ** 2 < 100), {
      profile: 'nope', thickness: Number.NaN, blur: 'x',
    }));
    expect(res.kind === 'depth' && res.depth.data.every((v) => Number.isFinite(v))).toBe(true);
  });
});
