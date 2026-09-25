import { describe, expect, it } from 'vitest';
import type { RGBAImage } from '../types';
import { autoMaskFromBorder, hasMeaningfulAlpha, removeSmallComponents } from './autoMask';

type RGB = [number, number, number];

function solid(w: number, h: number, c: RGB, alpha = 255): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([c[0], c[1], c[2], alpha], i * 4);
  return { width: w, height: h, data };
}

function fillRect(img: RGBAImage, x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data.set(c, (y * img.width + x) * 4);
}

function count(data: Uint8Array): number {
  let a = 0;
  for (const v of data) a += v;
  return a;
}

describe('autoMaskFromBorder', () => {
  it('extracts a square on a white background', () => {
    const img = solid(64, 48, [255, 255, 255]);
    fillRect(img, 10, 8, 40, 30, [200, 30, 30]);
    const m = autoMaskFromBorder(img)!;
    expect(m).not.toBeNull();
    expect(m.width).toBe(64);
    expect(m.height).toBe(48);
    for (let y = 0; y < 48; y++)
      for (let x = 0; x < 64; x++) {
        const inside = x >= 10 && x < 40 && y >= 8 && y < 30;
        expect(m.data[y * 64 + x]).toBe(inside ? 1 : 0);
      }
  });

  it('tolerates noisy backgrounds within tolerance', () => {
    const img = solid(50, 50, [240, 240, 240]);
    let s = 1;
    for (let i = 0; i < 2500; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const n = (s % 21) - 10;
      img.data[i * 4] += n;
      img.data[i * 4 + 1] += n;
      img.data[i * 4 + 2] -= n;
    }
    fillRect(img, 15, 15, 35, 35, [20, 60, 200]);
    const m = autoMaskFromBorder(img)!;
    expect(count(m.data)).toBe(400);
  });

  it('keeps background-coloured regions enclosed by the object', () => {
    const img = solid(40, 40, [255, 255, 255]);
    fillRect(img, 10, 10, 30, 30, [0, 0, 0]);
    fillRect(img, 15, 15, 25, 25, [255, 255, 255]); // white "eye" inside
    const m = autoMaskFromBorder(img)!;
    expect(count(m.data)).toBe(400);
    expect(m.data[20 * 40 + 20]).toBe(1);
  });

  it('removes the anti-aliasing halo and tiny specks', () => {
    const img = solid(60, 60, [255, 255, 255]);
    fillRect(img, 20, 20, 40, 40, [0, 0, 0]);
    // 1px blended ring just outside the square, close to the background colour.
    for (let i = 19; i <= 40; i++) {
      for (const [x, y] of [[i, 19], [i, 40], [19, i], [40, i]] as [number, number][])
        img.data.set([235, 235, 235], (y * 60 + x) * 4);
    }
    img.data.set([0, 0, 0], (5 * 60 + 5) * 4); // isolated dark pixel
    const m = autoMaskFromBorder(img, 0.08)!;
    expect(m.data[19 * 60 + 30]).toBe(0);
    expect(m.data[5 * 60 + 5]).toBe(0);
    expect(count(m.data)).toBe(400);

    const raw = autoMaskFromBorder(img, 0.08, { erodeHalo: false, minComponentFraction: 0 })!;
    expect(raw.data[19 * 60 + 30]).toBe(1);
    expect(raw.data[5 * 60 + 5]).toBe(1);
  });

  it('keeps crisp object edges when eroding the halo', () => {
    const img = solid(30, 30, [255, 255, 255]);
    fillRect(img, 5, 5, 25, 25, [10, 120, 10]);
    expect(count(autoMaskFromBorder(img)!.data)).toBe(400);
  });

  it('works with a dark background and an object touching the border', () => {
    const img = solid(40, 40, [5, 5, 10]);
    fillRect(img, 0, 25, 40, 40, [250, 200, 0]); // bottom band touching 3 edges
    fillRect(img, 12, 8, 28, 25, [250, 200, 0]);
    const m = autoMaskFromBorder(img)!;
    expect(count(m.data)).toBe(40 * 15 + 16 * 17);
  });

  it('returns null for varied borders (photos, gradients)', () => {
    const img = solid(64, 64, [0, 0, 0]);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) img.data.set([x * 4, y * 4, 128], (y * 64 + x) * 4);
    expect(autoMaskFromBorder(img)).toBeNull();
  });

  it('returns null when the image has transparency', () => {
    const img = solid(20, 20, [255, 255, 255], 0);
    fillRect(img, 5, 5, 15, 15, [255, 0, 0]);
    for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) img.data[(y * 20 + x) * 4 + 3] = 255;
    expect(hasMeaningfulAlpha(img)).toBe(true);
    expect(autoMaskFromBorder(img)).toBeNull();
  });

  it('returns null when the foreground is almost empty or almost everything', () => {
    const empty = solid(100, 100, [255, 255, 255]);
    fillRect(empty, 50, 50, 55, 55, [0, 0, 0]); // 0.25 %
    expect(autoMaskFromBorder(empty)).toBeNull();
    expect(autoMaskFromBorder(solid(100, 100, [255, 255, 255]))).toBeNull();
  });

  it('is fast enough for 1024×1024', () => {
    const img = solid(1024, 1024, [250, 250, 250]);
    fillRect(img, 200, 150, 900, 950, [30, 90, 160]);
    const t0 = performance.now();
    const m = autoMaskFromBorder(img)!;
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(count(m.data)).toBe(700 * 800);
  });
});

describe('hasMeaningfulAlpha', () => {
  it('ignores a handful of semi-transparent pixels', () => {
    const img = solid(100, 100, [0, 0, 0]);
    img.data[3] = 0; // 1 pixel of 10 000 < 0.1 %
    expect(hasMeaningfulAlpha(img)).toBe(false);
  });
});

describe('removeSmallComponents', () => {
  it('uses 8-connectivity and drops components below the threshold', () => {
    const w = 6, h = 4;
    // diagonal of 3 pixels (one component) + an isolated pixel
    const data = new Uint8Array(w * h);
    data[0] = data[w + 1] = data[2 * w + 2] = 1;
    data[5] = 1;
    removeSmallComponents(data, w, h, 2);
    expect(count(data)).toBe(3);
    expect(data[5]).toBe(0);
  });
});
