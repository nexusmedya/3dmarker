import { describe, expect, it } from 'vitest';
import { alphaChannel, alphaToMask, intersectMasks } from './alphaMask';
import { compositeOver } from './composite';

describe('alphaChannel', () => {
  it('extracts the last channel of RGBA / LA and passes 1-channel through', () => {
    expect([...alphaChannel([1, 2, 3, 40, 5, 6, 7, 80], 2, 1, 4)]).toEqual([40, 80]);
    expect([...alphaChannel([1, 40, 5, 80], 2, 1, 2)]).toEqual([40, 80]);
    expect([...alphaChannel([40, 80], 2, 1, 1)]).toEqual([40, 80]);
  });

  it('rejects short buffers and odd channel counts', () => {
    expect(() => alphaChannel([1, 2, 3], 1, 1, 4)).toThrow();
    expect(() => alphaChannel([1, 2, 3], 1, 1, 3)).toThrow(/unsupported/);
  });
});

describe('alphaToMask', () => {
  it('thresholds at 0.5 by default', () => {
    const m = alphaToMask([0, 127, 128, 255], 4, 1, 4, 1);
    expect([...m.data]).toEqual([0, 0, 1, 1]);
  });

  it('upsamples to the target size', () => {
    // Left half foreground in a 2×2 matte → left half of 8×4.
    const m = alphaToMask([255, 0, 255, 0], 2, 2, 8, 4);
    expect(m.width).toBe(8);
    expect(m.height).toBe(4);
    for (let y = 0; y < 4; y++) {
      expect([...m.data.slice(y * 8, y * 8 + 8)]).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
    }
  });

  it('honours a custom threshold and validates length', () => {
    expect([...alphaToMask([100, 200], 2, 1, 2, 1, 0.3).data]).toEqual([1, 1]);
    expect(() => alphaToMask([1, 2, 3], 2, 1, 2, 1)).toThrow();
  });
});

describe('intersectMasks', () => {
  it('ANDs two masks', () => {
    const a = { width: 2, height: 2, data: new Uint8Array([1, 1, 0, 1]) };
    const b = { width: 2, height: 2, data: new Uint8Array([1, 0, 0, 1]) };
    expect([...intersectMasks(a, b).data]).toEqual([1, 0, 0, 1]);
    expect(() => intersectMasks(a, { width: 1, height: 4, data: new Uint8Array(4) })).toThrow();
  });
});

describe('compositeOver', () => {
  it('blends by alpha and makes the result opaque', () => {
    const img = { width: 2, height: 1, data: new Uint8ClampedArray([200, 100, 0, 255, 200, 100, 0, 0]) };
    const out = compositeOver(img, [0, 0, 255]);
    expect([...out.data]).toEqual([200, 100, 0, 255, 0, 0, 255, 255]);
    expect(out.data).not.toBe(img.data);
  });

  it('half alpha gives the midpoint', () => {
    const img = { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 128]) };
    const [r] = compositeOver(img, [0, 0, 0]).data;
    expect(r).toBe(128);
  });
});
