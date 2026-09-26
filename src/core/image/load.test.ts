import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageLoadError, MAX_DECODE_SIDE, VECTOR_RASTER_SIDE, capSize, isRejectedType, loadImageFile } from './load';

describe('capSize / isRejectedType', () => {
  it('caps the longest side without upscaling', () => {
    expect(capSize(8000, 4000)).toEqual([MAX_DECODE_SIDE, MAX_DECODE_SIDE / 2]);
    expect(capSize(100, 50)).toEqual([100, 50]);
    expect(capSize(10, 20000, 100)).toEqual([1, 100]);
  });

  it('rejects non-image MIME types but accepts unknown ones', () => {
    expect(isRejectedType('text/plain')).toBe(true);
    expect(isRejectedType('application/pdf')).toBe(true);
    expect(isRejectedType('image/png')).toBe(false);
    expect(isRejectedType('')).toBe(false);
  });
});

/** Minimal browser stand-ins: createImageBitmap + OffscreenCanvas returning a solid colour. */
function stubBrowser(width: number, height: number) {
  const drawn: number[][] = [];
  const close = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width, height, close })));
  class FakeOffscreenCanvas {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return {
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
        clearRect: () => {},
        drawImage: (_s: unknown, x: number, y: number, w: number, h: number) => drawn.push([x, y, w, h]),
        getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(200) }),
      };
    }
  }
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  return { drawn, close };
}

/** <img> stand-in: a detached element reports its width / height attributes, else its natural size. */
function stubImage(naturalWidth: number, naturalHeight: number) {
  class FakeImage {
    decoding = '';
    src = '';
    readonly naturalWidth = naturalWidth;
    readonly naturalHeight = naturalHeight;
    private w: number | null = null;
    private h: number | null = null;
    get width() {
      return this.w ?? this.naturalWidth;
    }
    set width(v: number) {
      this.w = v;
    }
    get height() {
      return this.h ?? this.naturalHeight;
    }
    set height(v: number) {
      this.h = v;
    }
    decode() {
      return Promise.resolve();
    }
  }
  vi.stubGlobal('Image', FakeImage);
}

describe('loadImageFile', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('decodes to RGBA at natural size and releases the bitmap', async () => {
    const { drawn, close } = stubBrowser(30, 20);
    const img = await loadImageFile(new Blob([new Uint8Array(4)], { type: 'image/png' }));
    expect(img.width).toBe(30);
    expect(img.height).toBe(20);
    expect(img.data.length).toBe(30 * 20 * 4);
    expect(drawn).toEqual([[0, 0, 30, 20]]);
    expect(close).toHaveBeenCalledOnce();
    // Colour profiles (Display-P3, Adobe RGB …) are converted to sRGB; alpha stays straight.
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  });

  it('downscales giant images while drawing', async () => {
    const { drawn } = stubBrowser(10_000, 5_000);
    const img = await loadImageFile(new Blob([], { type: 'image/png' }));
    expect([img.width, img.height]).toEqual([MAX_DECODE_SIDE, MAX_DECODE_SIDE / 2]);
    expect(drawn[0]).toEqual([0, 0, MAX_DECODE_SIDE, MAX_DECODE_SIDE / 2]);
  });

  it('draws straight to a smaller maxSide (no full-size intermediate)', async () => {
    const { drawn } = stubBrowser(8000, 6000);
    const img = await loadImageFile(new Blob([], { type: 'image/jpeg' }), 1024);
    expect([img.width, img.height]).toEqual([1024, 768]);
    expect(drawn).toEqual([[0, 0, 1024, 768]]);
    expect(img.data.length).toBe(1024 * 768 * 4);
  });

  it('rasterises SVGs (decoded through <img>) at VECTOR_RASTER_SIDE, keeping the aspect ratio', async () => {
    const cases: [type: string, natural: [number, number], expected: [number, number]][] = [
      ['image/svg+xml', [24, 24], [VECTOR_RASTER_SIDE, VECTOR_RASTER_SIDE]], // small icon: scaled up
      ['image/svg+xml', [300, 150], [VECTOR_RASTER_SIDE, VECTOR_RASTER_SIDE / 2]], // viewBox-only default size
      ['image/svg+xml', [4000, 1000], [VECTOR_RASTER_SIDE, VECTOR_RASTER_SIDE / 4]], // large: scaled down
      ['image/svg+xml', [0, 0], [VECTOR_RASTER_SIDE, VECTOR_RASTER_SIDE]], // no intrinsic size
      ['image/png', [30, 20], [30, 20]], // rasters on the element path are never upscaled
    ];
    for (const [type, [nw, nh], expected] of cases) {
      const { drawn } = stubBrowser(1, 1);
      vi.stubGlobal('createImageBitmap', vi.fn(async () => Promise.reject(new Error('The source image could not be decoded.'))));
      stubImage(nw, nh);
      const img = await loadImageFile(new Blob(['<svg/>'], { type }));
      expect([img.width, img.height], `${type} ${nw}×${nh}`).toEqual(expected);
      expect(drawn).toEqual([[0, 0, ...expected]]);
      vi.unstubAllGlobals();
    }
  });

  it('rejects non-images with a bilingual error', async () => {
    stubBrowser(1, 1);
    const err = await loadImageFile(new Blob(['hi'], { type: 'text/plain' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageLoadError);
    expect((err as ImageLoadError).i18n.tr).toMatch(/görsel/);
    expect((err as ImageLoadError).i18n.en).toMatch(/not an image/);
  });

  it('reports undecodable files', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => Promise.reject(new Error('bad'))));
    const err = await loadImageFile(new Blob(['xx'], { type: 'image/png' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageLoadError);
    expect((err as ImageLoadError).i18n.en).toMatch(/Could not read/);
  });
});
