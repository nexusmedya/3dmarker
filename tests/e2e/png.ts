/**
 * Tiny RGBA canvas + PNG encoder for E2E mocks (Node only, no canvas
 * package): filled ellipses / rectangles on a transparent background,
 * encoded as an 8-bit RGBA PNG with node:zlib. Used to answer mocked AI
 * image APIs with simple character silhouettes.
 */
import { crc32, deflateSync } from 'node:zlib';

export type RGBA = [number, number, number, number];

/** Similarity applied to every shape (fractions of the size): `scale` about the centre, then a shift of (dx, dy). */
export interface RasterTransform {
  scale?: number;
  dx?: number;
  dy?: number;
}

export class Raster {
  readonly data: Uint8Array;
  private readonly scale: number;
  private readonly dx: number;
  private readonly dy: number;
  constructor(
    readonly width: number,
    readonly height: number,
    transform: RasterTransform = {},
  ) {
    this.data = new Uint8Array(width * height * 4);
    this.rows = height;
    this.scale = transform.scale ?? 1;
    this.dx = transform.dx ?? 0;
    this.dy = transform.dy ?? 0;
  }

  private put(x: number, y: number, c: RGBA): void {
    const o = (y * this.width + x) * 4;
    this.data[o] = c[0];
    this.data[o + 1] = c[1];
    this.data[o + 2] = c[2];
    this.data[o + 3] = c[3];
  }

  private tx(x: number): number {
    return 0.5 + this.dx + this.scale * (x - 0.5);
  }

  private ty(y: number): number {
    return 0.5 + this.dy + this.scale * (y - 0.5);
  }

  /** Axis-aligned rectangle in fractions of the size (x0, y0, x1, y1), through the transform. */
  rect(x0: number, y0: number, x1: number, y1: number, c: RGBA): this {
    const W = this.width, H = this.height;
    const X0 = this.tx(x0), X1 = this.tx(x1), Y0 = this.ty(y0), Y1 = this.ty(y1);
    for (let y = Math.max(0, Math.round(Y0 * H)); y < Math.min(H, Math.round(Y1 * H)); y++)
      for (let x = Math.max(0, Math.round(X0 * W)); x < Math.min(W, Math.round(X1 * W)); x++) this.put(x, y, c);
    return this;
  }

  /** Ellipse centred at (cx, cy) with radii (rx, ry), all in fractions of the size, through the transform. */
  ellipse(cx: number, cy: number, rx: number, ry: number, c: RGBA): this {
    const W = this.width, H = this.height;
    const CX = this.tx(cx), CY = this.ty(cy), RX = rx * this.scale, RY = ry * this.scale;
    for (let y = Math.max(0, Math.floor((CY - RY) * H)); y <= Math.min(H - 1, Math.ceil((CY + RY) * H)); y++)
      for (let x = Math.max(0, Math.floor((CX - RX) * W)); x <= Math.min(W - 1, Math.ceil((CX + RX) * W)); x++) {
        const dx = ((x + 0.5) / W - CX) / RX, dy = ((y + 0.5) / H - CY) / RY;
        if (dx * dx + dy * dy <= 1) this.put(x, y, c);
      }
    return this;
  }

  /** Rows kept by png() (cropBottom shortens the image). */
  private rows: number;

  /**
   * Cuts the bottom `fraction` of the rows off the image: the PNG gets shorter,
   * so whatever was drawn below the new border is cut off at it (a view whose
   * feet run past the bottom edge), which the fusion's cut detection sees.
   */
  cropBottom(fraction: number): this {
    this.rows = Math.max(1, Math.min(this.height, Math.round((1 - fraction) * this.height)));
    return this;
  }

  png(): Buffer {
    return encodePng(this.width, this.rows, this.data.subarray(0, this.rows * this.width * 4));
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

/** A hand-made view's own framing: scale / shift (fractions), arm row (default 0.275) and a bottom crop. */
export interface CharacterFraming extends RasterTransform {
  /** Centre row of the outstretched arms (fraction of the height; the front's is 0.275). */
  armY?: number;
  /** Fraction of the height cut off the bottom of the image (the feet, at 0.92 of the height, run past the border from ≈ 0.09). */
  cropBottom?: number;
}

/**
 * A T-posed character seen from `view` (view conventions of src/core/types.ts),
 * shirt in `shirt` colour, 256² — what a mocked image model "generates". `p`
 * draws it with an independent framing (a user's own upload).
 */
export function characterView(view: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom', shirt: RGBA, size = 256, p: CharacterFraming = {}): Buffer {
  const r = new Raster(size, size, p);
  const armY = p.armY ?? 0.275;
  switch (view) {
    case 'front':
    case 'back':
      r.rect(0.44, 0.52, 0.49, 0.92, PANTS).rect(0.51, 0.52, 0.56, 0.92, PANTS); // legs
      r.rect(0.08, armY - 0.025, 0.92, armY + 0.025, SKIN); // arms straight out
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
      r.ellipse(0.5, armY, 0.035, 0.03, SKIN); // the near arm, end-on
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
  if (p.cropBottom) r.cropBottom(p.cropBottom);
  return r.png();
}
