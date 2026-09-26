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

export async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
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

function makeCanvas(w: number, h: number): { ctx: Ctx2D; toBlob: () => Promise<Blob> } | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (ctx) return { ctx, toBlob: () => canvas.convertToBlob({ type: 'image/png' }) };
  }
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return {
    ctx,
    toBlob: () => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png')),
  };
}

/** PNG blob of an RGBA image (browser). */
export async function encodePng(img: RGBAImage): Promise<Blob> {
  const c = makeCanvas(img.width, img.height);
  if (!c) throw new Error('No canvas available to encode PNG');
  c.ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c.toBlob();
}

/** Pixel size of an image blob, or null where it cannot be decoded (Node, broken file). */
export async function imageSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const bmp = await createImageBitmap(blob);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return size;
  } catch {
    return null;
  }
}

/**
 * The image as a PNG whose longest side is at most `maxSide` (browser).
 * Without a canvas (Node tests) or when decoding fails the blob is returned
 * as is and the provider decides.
 */
export async function toUploadPng(blob: Blob, maxSide = UPLOAD_MAX_SIDE): Promise<Blob> {
  if (!canUseCanvas()) return blob;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  } catch {
    return blob;
  }
  try {
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    if (scale === 1 && blob.type === 'image/png') return blob;
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const c = makeCanvas(w, h);
    if (!c) return blob;
    c.ctx.imageSmoothingEnabled = true;
    c.ctx.imageSmoothingQuality = 'high';
    c.ctx.drawImage(bmp, 0, 0, w, h);
    return await c.toBlob();
  } finally {
    bmp.close();
  }
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
