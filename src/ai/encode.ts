/**
 * Blob / base64 / data URI helpers for the AI adapters, plus the browser-only
 * image steps (decode, downscale to PNG before upload, encode RGBA as PNG).
 * The pure helpers run in Node tests; the canvas ones fall back to passing
 * the blob through unchanged where no canvas exists (Node).
 */
import type { RGBAImage } from '../core/types';
import { loadImageFile } from '../core/image/load';

/** Longest side of images sent to providers. */
export const UPLOAD_MAX_SIDE = 1536;

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type NativeBase64 = Uint8Array & { toBase64?: () => string };
type NodeBuffer = { from(b: Uint8Array): { toString(enc: 'base64'): string } };

/**
 * Base64 of a blob without blocking the main thread for long: the native
 * Uint8Array#toBase64, else FileReader (async, off-thread), else Node's
 * Buffer, else the portable loop. All give the same standard base64.
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  if (typeof (Uint8Array.prototype as NativeBase64).toBase64 === 'function') {
    return (new Uint8Array(await blob.arrayBuffer()) as NativeBase64).toBase64!();
  }
  if (typeof FileReader !== 'undefined') {
    const url = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error ?? new Error('FileReader failed'));
      r.readAsDataURL(blob);
    });
    return url.slice(url.indexOf(',') + 1);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const buffer = (globalThis as { Buffer?: NodeBuffer }).Buffer;
  if (buffer) return buffer.from(bytes).toString('base64');
  return bytesToBase64(bytes);
}

/** MIME type from the first bytes (PNG, JPEG, WEBP, GIF, GLB), or null. */
export function sniffType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 4 && b[0] === 0x67 && b[1] === 0x6c && b[2] === 0x54 && b[3] === 0x46) return 'model/gltf-binary';
  return null;
}

/** Blob typed from its content when the declared type is missing or generic. */
export async function withSniffedType(blob: Blob): Promise<Blob> {
  if (blob.type && blob.type !== 'application/octet-stream' && blob.type !== 'binary/octet-stream') return blob;
  const type = sniffType(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
  return type ? new Blob([blob], { type }) : blob;
}

export async function blobToDataUri(blob: Blob): Promise<string> {
  const typed = await withSniffedType(blob);
  return `data:${typed.type || 'application/octet-stream'};base64,${await blobToBase64(typed)}`;
}

/** Decodes a base64 `data:` URI; null when `uri` is not one. */
export function dataUriToBlob(uri: string): Blob | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*?);base64,(.*)$/s.exec(uri.trim());
  if (!m) return null;
  const bytes = base64ToBytes(m[3]);
  const type = m[1] || sniffType(bytes) || 'application/octet-stream';
  return new Blob([bytes as BlobPart], { type });
}

/** Blob from raw base64 (type sniffed from the content when not given). */
export function base64ToBlob(b64: string, type?: string): Blob {
  const bytes = base64ToBytes(b64);
  return new Blob([bytes as BlobPart], { type: type ?? sniffType(bytes) ?? 'application/octet-stream' });
}

/** True when `buf` starts with the binary glTF magic ('glTF', version 2). */
export function isGlbBuffer(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false;
  const v = new DataView(buf);
  return v.getUint32(0, true) === 0x46546c67 && v.getUint32(4, true) === 2;
}

const canUseCanvas = () => typeof createImageBitmap === 'function' && (typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined');

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function makeCanvas(w: number, h: number): { ctx: Ctx2D; toBlob: (type?: string, quality?: number) => Promise<Blob> } | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) return { ctx, toBlob: (type = 'image/png', quality) => canvas.convertToBlob({ type, quality }) };
  }
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  return {
    ctx,
    toBlob: (type = 'image/png', quality) =>
      new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image encoding failed'))), type, quality)),
  };
}

/** PNG blob of an RGBA image (browser). */
export async function encodePng(img: RGBAImage): Promise<Blob> {
  const c = makeCanvas(img.width, img.height);
  if (!c) throw new Error('No canvas available to encode PNG');
  c.ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c.toBlob();
}

const sizeCache = new WeakMap<Blob, Promise<{ width: number; height: number } | null>>();

/** Pixel size of an image blob, or null where it cannot be decoded (Node, broken file). Memoised per blob. */
export function imageSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  let p = sizeCache.get(blob);
  if (!p) {
    p = (async () => {
      if (typeof createImageBitmap !== 'function') return null;
      try {
        const bmp = await createImageBitmap(blob);
        const size = { width: bmp.width, height: bmp.height };
        bmp.close();
        return size;
      } catch {
        return null;
      }
    })();
    sizeCache.set(blob, p);
  }
  return p;
}

/** JPEG quality of flattened (opaque) uploads. */
const UPLOAD_JPEG_QUALITY = 0.92;

export interface UploadOptions {
  /** Longest side (default UPLOAD_MAX_SIDE). */
  maxSide?: number;
  /**
   * true (default): keep transparency, PNG. false: for providers that ignore
   * alpha — transparent pixels are composited over white (a canvas stores
   * them as black, which such providers would show) and the image is sent
   * as a much smaller JPEG.
   */
  keepAlpha?: boolean;
}

/** Blobs are immutable, so prepared uploads are cached per blob and options. */
const uploadCache = new WeakMap<Blob, Map<string, Promise<Blob>>>();

/**
 * The image ready to upload (browser): longest side at most `maxSide`, PNG
 * with alpha, or flattened over white as JPEG (see UploadOptions). Without a
 * canvas (Node tests) or when decoding fails the blob is returned as is and
 * the provider decides. Idempotent and memoised per blob.
 */
export function toUploadImage(blob: Blob, opts: UploadOptions = {}): Promise<Blob> {
  const maxSide = opts.maxSide ?? UPLOAD_MAX_SIDE;
  const keepAlpha = opts.keepAlpha ?? true;
  const key = `${maxSide}:${keepAlpha ? 'a' : 'f'}`;
  let byOpts = uploadCache.get(blob);
  if (!byOpts) uploadCache.set(blob, (byOpts = new Map()));
  let p = byOpts.get(key);
  if (!p) {
    p = encodeUpload(blob, maxSide, keepAlpha);
    byOpts.set(key, p);
    // A later call with a result blob as input returns it unchanged.
    p.then((out) => {
      if (out !== blob && !uploadCache.has(out)) uploadCache.set(out, new Map([[key, Promise.resolve(out)]]));
    }, () => byOpts!.delete(key));
  }
  return p;
}

async function encodeUpload(blob: Blob, maxSide: number, keepAlpha: boolean): Promise<Blob> {
  if (!canUseCanvas()) return blob;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  } catch {
    return blob;
  }
  try {
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    if (scale === 1 && keepAlpha && blob.type === 'image/png') return blob;
    if (scale === 1 && !keepAlpha && blob.type === 'image/jpeg') return blob; // JPEG has no alpha
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const c = makeCanvas(w, h);
    if (!c) return blob;
    if (!keepAlpha) {
      c.ctx.fillStyle = '#ffffff';
      c.ctx.fillRect(0, 0, w, h);
    }
    c.ctx.imageSmoothingEnabled = true;
    c.ctx.imageSmoothingQuality = 'high';
    c.ctx.drawImage(bmp, 0, 0, w, h);
    return await (keepAlpha ? c.toBlob('image/png') : c.toBlob('image/jpeg', UPLOAD_JPEG_QUALITY));
  } finally {
    bmp.close();
  }
}

/** toUploadImage keeping alpha (PNG). */
export function toUploadPng(blob: Blob, maxSide = UPLOAD_MAX_SIDE): Promise<Blob> {
  return toUploadImage(blob, { maxSide, keepAlpha: true });
}

/** Decodes an image blob into RGBA (browser); null without a canvas or on failure. */
export async function decodeRGBA(blob: Blob, maxSide = 4096): Promise<RGBAImage | null> {
  if (!canUseCanvas()) return null;
  try {
    return await loadImageFile(blob, maxSide);
  } catch {
    return null;
  }
}
