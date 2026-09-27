/**
 * Tiling for the AI upscaler: the image is cut into equally sized,
 * overlapping tiles (bounded model memory, one shape for WebGPU), each tile
 * is upscaled on its own and the results are blended back with linear
 * feathering across the overlaps, so no seams show. Tiles are padded to a
 * multiple of `multiple` (Swin2SR's window size) by edge replication, which
 * makes the model's processor add no padding of its own.
 */

export interface Tile {
  /** Input rectangle (inside the image). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Whether a neighbouring tile overlaps this side (feathered there). */
  left: boolean;
  right: boolean;
  top: boolean;
  bottom: boolean;
}

/** Start offsets along one axis: tiles of `tile` px, at least `overlap` px shared, the last one flush with the end. */
export function axisStarts(len: number, tile: number, overlap: number): number[] {
  if (len <= tile) return [0];
  const step = Math.max(1, tile - overlap);
  const starts: number[] = [];
  for (let s = 0; s + tile < len; s += step) starts.push(s);
  starts.push(len - tile);
  return starts;
}

export function planTiles(width: number, height: number, tile: number, overlap: number): Tile[] {
  const xs = axisStarts(width, tile, overlap);
  const ys = axisStarts(height, tile, overlap);
  const tiles: Tile[] = [];
  for (let j = 0; j < ys.length; j++)
    for (let i = 0; i < xs.length; i++)
      tiles.push({
        x: xs[i],
        y: ys[j],
        w: Math.min(tile, width),
        h: Math.min(tile, height),
        left: i > 0,
        right: i < xs.length - 1,
        top: j > 0,
        bottom: j < ys.length - 1,
      });
  return tiles;
}

/** Round up to a multiple of `m`. */
export const roundUp = (v: number, m: number) => Math.ceil(v / m) * m;

/**
 * RGB (3 channels) of a tile, padded on the right / bottom to a multiple of
 * `multiple` by repeating the last column / row. `src` is RGBA or RGB.
 */
export function extractTile(src: ArrayLike<number>, width: number, channels: number, t: Tile, multiple = 8): { data: Uint8Array; width: number; height: number } {
  const W = roundUp(t.w, multiple);
  const H = roundUp(t.h, multiple);
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const sy = t.y + Math.min(y, t.h - 1);
    for (let x = 0; x < W; x++) {
      const sx = t.x + Math.min(x, t.w - 1);
      const s = (sy * width + sx) * channels;
      const o = (y * W + x) * 3;
      out[o] = src[s];
      out[o + 1] = src[s + 1];
      out[o + 2] = src[s + 2];
    }
  }
  return { data: out, width: W, height: H };
}

/** Weighted accumulation of upscaled tiles into a W × H RGB canvas. */
export class TileBlender {
  private sum: Float32Array;
  private weight: Float32Array;

  constructor(
    readonly width: number,
    readonly height: number,
    /** Output px per input px. */
    readonly scale: number,
    /** Input px of overlap the feathering ramps across. */
    readonly overlap: number,
  ) {
    this.sum = new Float32Array(width * height * 3);
    this.weight = new Float32Array(width * height);
  }

  /**
   * Add a tile's upscaled pixels (`data`: `dw` px wide, `channels` channels;
   * only its top-left t.w·scale × t.h·scale area is used, the rest is padding).
   */
  add(t: Tile, data: ArrayLike<number>, dw: number, channels: number): void {
    const s = this.scale;
    const tw = t.w * s, th = t.h * s;
    const ox = t.x * s, oy = t.y * s;
    const ramp = Math.max(1, Math.round(this.overlap * s));
    const wx = new Float32Array(tw);
    const wy = new Float32Array(th);
    const edge = (i: number, n: number, lo: boolean, hi: boolean) => {
      let v = 1;
      if (lo && i < ramp) v = Math.min(v, (i + 0.5) / ramp);
      if (hi && n - 1 - i < ramp) v = Math.min(v, (n - 1 - i + 0.5) / ramp);
      return v;
    };
    for (let i = 0; i < tw; i++) wx[i] = edge(i, tw, t.left, t.right);
    for (let j = 0; j < th; j++) wy[j] = edge(j, th, t.top, t.bottom);
    for (let j = 0; j < th; j++) {
      const Y = oy + j;
      if (Y >= this.height) break;
      for (let i = 0; i < tw; i++) {
        const X = ox + i;
        if (X >= this.width) break;
        const w = wx[i] * wy[j];
        const src = (j * dw + i) * channels;
        const p = Y * this.width + X;
        this.sum[p * 3] += data[src] * w;
        this.sum[p * 3 + 1] += data[src + 1] * w;
        this.sum[p * 3 + 2] += data[src + 2] * w;
        this.weight[p] += w;
      }
    }
  }

  /** The blended image as opaque RGBA. */
  result(): Uint8ClampedArray {
    const n = this.width * this.height;
    const out = new Uint8ClampedArray(n * 4);
    for (let p = 0; p < n; p++) {
      const w = this.weight[p] || 1;
      out[p * 4] = this.sum[p * 3] / w;
      out[p * 4 + 1] = this.sum[p * 3 + 1] / w;
      out[p * 4 + 2] = this.sum[p * 3 + 2] / w;
      out[p * 4 + 3] = 255;
    }
    return out;
  }
}
