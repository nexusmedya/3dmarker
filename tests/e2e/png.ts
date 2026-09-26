/**
 * Tiny RGBA canvas + PNG encoder for E2E mocks (Node only, no canvas
 * package): filled ellipses / rectangles on a transparent background,
 * encoded as an 8-bit RGBA PNG with node:zlib. Used to answer mocked AI
 * image APIs with simple character silhouettes.
 */
import { crc32, deflateSync } from 'node:zlib';

export type RGBA = [number, number, number, number];

export class Raster {
  readonly data: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8Array(width * height * 4);
  }

  private put(x: number, y: number, c: RGBA): void {
    const o = (y * this.width + x) * 4;
    this.data[o] = c[0];
    this.data[o + 1] = c[1];
    this.data[o + 2] = c[2];
    this.data[o + 3] = c[3];
  }

  /** Axis-aligned rectangle in fractions of the size (x0, y0, x1, y1). */
  rect(x0: number, y0: number, x1: number, y1: number, c: RGBA): this {
    const W = this.width, H = this.height;
    for (let y = Math.max(0, Math.round(y0 * H)); y < Math.min(H, Math.round(y1 * H)); y++)
      for (let x = Math.max(0, Math.round(x0 * W)); x < Math.min(W, Math.round(x1 * W)); x++) this.put(x, y, c);
    return this;
  }

  /** Ellipse centred at (cx, cy) with radii (rx, ry), all in fractions of the size. */
  ellipse(cx: number, cy: number, rx: number, ry: number, c: RGBA): this {
    const W = this.width, H = this.height;
    for (let y = Math.max(0, Math.floor((cy - ry) * H)); y <= Math.min(H - 1, Math.ceil((cy + ry) * H)); y++)
      for (let x = Math.max(0, Math.floor((cx - rx) * W)); x <= Math.min(W - 1, Math.ceil((cx + rx) * W)); x++) {
        const dx = ((x + 0.5) / W - cx) / rx, dy = ((y + 0.5) / H - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.put(x, y, c);
      }
    return this;
  }

  png(): Buffer {
    return encodePng(this.width, this.height, this.data);
  }
}

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tb) >>> 0);
  return Buffer.concat([len, tb, crc]);
}

/** 8-bit RGBA, no interlace, filter 0 on every row. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const SKIN: RGBA = [233, 180, 143, 255];
const HAIR: RGBA = [63, 42, 29, 255];
const PANTS: RGBA = [31, 47, 77, 255];

/**
 * A T-posed character seen from `view` (view conventions of src/core/types.ts),
 * shirt in `shirt` colour, 256² — what a mocked image model "generates".
 */
export function characterView(view: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom', shirt: RGBA, size = 256): Buffer {
  const r = new Raster(size, size);
  switch (view) {
    case 'front':
    case 'back':
      r.rect(0.44, 0.52, 0.49, 0.92, PANTS).rect(0.51, 0.52, 0.56, 0.92, PANTS); // legs
      r.rect(0.08, 0.25, 0.92, 0.3, SKIN); // arms straight out
      r.rect(0.38, 0.24, 0.62, 0.55, shirt); // torso
      r.rect(0.475, 0.18, 0.525, 0.25, SKIN); // neck
      r.ellipse(0.5, 0.13, 0.06, 0.075, view === 'back' ? HAIR : SKIN); // head
      if (view === 'front') r.ellipse(0.5, 0.085, 0.06, 0.03, HAIR);
      break;
    case 'left':
    case 'right': {
      const f = view === 'left' ? -1 : 1; // facing direction on the image
      r.rect(0.46, 0.52, 0.54, 0.92, PANTS); // legs (one behind the other)
      r.rect(0.43, 0.24, 0.57, 0.55, shirt); // torso in profile
      r.ellipse(0.5, 0.275, 0.035, 0.03, SKIN); // the near arm, end-on
      r.rect(0.475, 0.18, 0.525, 0.25, SKIN);
      r.ellipse(0.5, 0.13, 0.065, 0.075, SKIN);
      r.ellipse(0.5 - f * 0.015, 0.115, 0.055, 0.06, HAIR); // hair at the back of the head
      r.ellipse(0.5 + f * 0.065, 0.14, 0.012, 0.012, SKIN); // nose
      break;
    }
    case 'top':
    case 'bottom':
      r.rect(0.08, 0.45, 0.92, 0.55, SKIN); // arms across
      r.rect(0.38, 0.42, 0.62, 0.58, shirt); // shoulders / torso
      r.ellipse(0.5, 0.5, 0.06, 0.065, view === 'top' ? HAIR : PANTS);
      break;
  }
  return r.png();
}
