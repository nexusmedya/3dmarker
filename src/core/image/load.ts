/**
 * Decode an uploaded image file into an RGBAImage (browser only).
 *
 * createImageBitmap with premultiplyAlpha 'none' keeps straight alpha, and
 * colorSpaceConversion 'default' converts embedded colour profiles (ICC, e.g.
 * Display-P3 or Adobe RGB) to sRGB, as the browser displays the image and as
 * the <img> fallback decodes it: the pixels are treated as sRGB downstream
 * (preview canvas, SRGBColorSpace texture, GLB export, ML input). The bitmap
 * is read back through an OffscreenCanvas (or a DOM canvas), downscaled
 * while drawing so the longest side is at most `maxSide` (callers that only
 * need a working-size image pass that size, which avoids a full-size
 * intermediate). SVGs, which only decode through <img>, are rasterised at
 * VECTOR_RASTER_SIDE rather than at their (often tiny) intrinsic size.
 */
import type { I18nText, RGBAImage } from '../types';

/** Default longest side kept after decoding; larger images are downscaled. */
export const MAX_DECODE_SIDE = 4096;

/** Longest side SVGs are rasterised at (same as WORKING_MAX_SIDE in app/pipeline). */
export const VECTOR_RASTER_SIDE = 1024;

/** Error with a bilingual message (same shape as the drivers' LocalizedError). */
export class ImageLoadError extends Error {
  constructor(readonly i18n: I18nText) {
    super(`${i18n.tr} / ${i18n.en}`);
    this.name = 'ImageLoadError';
  }
}

export const NOT_AN_IMAGE: I18nText = {
  tr: 'Bu dosya bir görsel değil. Lütfen PNG, JPEG veya WEBP yükleyin.',
  en: 'This file is not an image. Please upload a PNG, JPEG or WEBP.',
};

export const DECODE_FAILED: I18nText = {
  tr: 'Görsel okunamadı; dosya bozuk ya da bu tarayıcı biçimi desteklemiyor olabilir.',
  en: 'Could not read the image; the file may be corrupt or the format unsupported by this browser.',
};

/** Target size so that the longest side is at most `maxSide` (never upscales). */
export function capSize(width: number, height: number, maxSide = MAX_DECODE_SIDE): [number, number] {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

/** True when the blob's MIME type (if any) is not an image type. */
export function isRejectedType(type: string): boolean {
  return type !== '' && !type.startsWith('image/');
}

type Drawable = CanvasImageSource & { width: number; height: number };
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export async function loadImageFile(file: Blob, maxSide = MAX_DECODE_SIDE): Promise<RGBAImage> {
  if (isRejectedType(file.type)) throw new ImageLoadError(NOT_AN_IMAGE);
  let source: Drawable;
  let release = () => {};
  try {
    const bitmap = await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
    source = bitmap;
    release = () => bitmap.close();
  } catch {
    // Some formats (e.g. SVG) only decode through an <img> element.
    try {
      const img = await decodeWithElement(file, file.type === 'image/svg+xml');
      source = img.element;
      release = img.release;
    } catch {
      throw new ImageLoadError(file.type ? DECODE_FAILED : NOT_AN_IMAGE);
    }
  }
  try {
    if (!source.width || !source.height) throw new ImageLoadError(DECODE_FAILED);
    const [w, h] = capSize(source.width, source.height, maxSide);
    const ctx = createContext(w, h);
    if (!ctx) throw new ImageLoadError(DECODE_FAILED);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    // getImageData already returns a fresh buffer owned by the caller.
    return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
  } finally {
    release();
  }
}

function createContext(w: number, h: number): Ctx2D | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
    if (ctx) return ctx;
  }
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas.getContext('2d', { willReadFrequently: true });
}

function decodeWithElement(file: Blob, isVector: boolean): Promise<{ element: HTMLImageElement; release: () => void }> {
  if (typeof Image === 'undefined') return Promise.reject(new Error('no DOM'));
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  const release = () => URL.revokeObjectURL(url);
  return img.decode().then(
    () => {
      let nw = img.naturalWidth, nh = img.naturalHeight;
      // Some engines report 0 × 0 for SVGs without an intrinsic size (Chromium uses 300 × 150).
      const sizeless = !nw || !nh;
      if (sizeless) nw = nh = 1;
      if (isVector || sizeless) {
        // Vectors redraw sharply at any size: scale the longest side to
        // VECTOR_RASTER_SIDE (up or down), keeping the aspect ratio. A detached
        // <img> reports these attributes as its width / height for drawImage.
        const scale = VECTOR_RASTER_SIDE / Math.max(nw, nh);
        img.width = Math.max(1, Math.round(nw * scale));
        img.height = Math.max(1, Math.round(nh * scale));
      }
      return { element: img, release };
    },
    (e: unknown) => {
      release();
      throw e;
    },
  );
}
