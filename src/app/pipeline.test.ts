import { beforeAll, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, DoubleSide, FrontSide, Mesh, MeshStandardMaterial, Vector3, Box3 } from 'three';
import type { DepthMap, Driver, DriverResult, Mask, Progress, RGBAImage } from '../core/types';
import { AbortError } from '../core/types';
import { exportObject } from '../core/export/exporters';
import {
  WORKING_MAX_SIDE,
  buildDepthModel,
  buildGltfModel,
  buildModel,
  createImageTexture,
  isAbortError,
  meshKeyOf,
  normalizeToFrame,
  opaqueTextureImage,
  prepareSource,
  quickMask,
  resolveMask,
  runPipeline,
  statsForObject,
  type SourceImage,
} from './pipeline';

/** Opaque grey image, or a transparent one with an opaque centred square. */
function image(w: number, h: number, opts: { transparentBorder?: number; color?: [number, number, number] } = {}): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  const [r, g, b] = opts.color ?? [120, 130, 140];
  const m = opts.transparentBorder ?? 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const inside = x >= m && x < w - m && y >= m && y < h - m;
      data.set(inside ? [r, g, b, 255] : [0, 0, 0, 0], o);
    }
  return { width: w, height: h, data };
}

/** White background with a dark centred square (plain-background photo). */
function onWhite(w: number, h: number, m: number): RGBAImage {
  const img = image(w, h, { color: [255, 255, 255] });
  for (let y = m; y < h - m; y++) for (let x = m; x < w - m; x++) img.data.set([20, 40, 200, 255], (y * w + x) * 4);
  return img;
}

function dome(w: number, h: number): DepthMap {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5) / w - 0.5, dy = (y + 0.5) / h - 0.5;
      data[y * w + x] = Math.max(0, 1 - 4 * (dx * dx + dy * dy));
    }
  return { width: w, height: h, data };
}

function fakeDriver(result: () => DriverResult | Promise<DriverResult>, extra: Partial<Driver> = {}): Driver {
  return {
    id: 'fake',
    name: { tr: 'Sahte', en: 'Fake' },
    description: { tr: '', en: '' },
    category: 'heuristic',
    badges: ['offline'],
    params: [],
    producesDepth: true,
    run: vi.fn(async () => result()),
    ...extra,
  };
}

const source = (img: RGBAImage): SourceImage => ({ name: 'test.png', file: new Blob([], { type: 'image/png' }), image: img });
const noop = () => {};

beforeAll(() => {
  // GLTFExporter reads its Blob parts back with FileReader, which Node lacks.
  if (typeof globalThis.FileReader !== 'undefined') return;
  class NodeFileReader {
    result: ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob) {
      void blob.arrayBuffer().then((b) => {
        this.result = b;
        this.onloadend?.();
      });
    }
  }
  (globalThis as unknown as { FileReader: unknown }).FileReader = NodeFileReader;
});

describe('prepareSource', () => {
  it('downscales the decoded image to the working size', async () => {
    const big = image(2048, 1024);
    const src = await prepareSource(new Blob(), 'big.png', async () => big);
    expect(src.image.width).toBe(WORKING_MAX_SIDE);
    expect(src.image.height).toBe(WORKING_MAX_SIDE / 2);
    expect(src.name).toBe('big.png');
  });

  it('keeps small images untouched', async () => {
    const small = image(64, 32);
    const src = await prepareSource(new Blob(), 's.png', async () => small);
    expect(src.image).toBe(small);
  });
});

describe('quickMask', () => {
  it('auto: alpha mask for transparent PNGs, null + note for opaque ones', () => {
    const t = quickMask(image(20, 20, { transparentBorder: 5 }), 'auto');
    expect(t.note).toBeNull();
    expect(t.mask!.data.reduce((a, v) => a + v, 0)).toBe(100);
    expect(quickMask(image(20, 20), 'auto')).toEqual({ mask: null, note: 'no-alpha' });
  });

  it('border: flood-fills a plain background, notes failure on a busy border', () => {
    const m = quickMask(onWhite(40, 40, 10), 'border');
    expect(m.note).toBeNull();
    expect(m.mask).not.toBeNull();
    const area = m.mask!.data.reduce((a, v) => a + v, 0);
    expect(area).toBeGreaterThan(300);
    expect(area).toBeLessThanOrEqual(400);
    // Random noise border: no uniform colour.
    const noisy = image(40, 40);
    for (let i = 0; i < noisy.data.length; i += 4) noisy.data.set([(i * 37) % 256, (i * 91) % 256, (i * 13) % 256], i);
    expect(quickMask(noisy, 'border')).toEqual({ mask: null, note: 'border-failed' });
  });

  it('ai is deferred, none is null', () => {
    expect(quickMask(image(8, 8), 'ai')).toEqual({ mask: null, note: 'deferred' });
    expect(quickMask(image(8, 8, { transparentBorder: 2 }), 'none')).toEqual({ mask: null, note: null });
  });
});

describe('resolveMask', () => {
  it('runs the injected background remover for ai mode', async () => {
    const mask: Mask = { width: 4, height: 4, data: new Uint8Array(16).fill(1) };
    const removeBg = vi.fn(async () => mask);
    const ctrl = new AbortController();
    const out = await resolveMask(image(4, 4), 'ai', { signal: ctrl.signal, onProgress: noop, removeBg });
    expect(out).toBe(mask);
    expect(removeBg).toHaveBeenCalledOnce();
  });

  it('returns null for an all-background AI mask', async () => {
    const removeBg = async () => ({ width: 2, height: 2, data: new Uint8Array(4) });
    expect(await resolveMask(image(2, 2), 'ai', { signal: new AbortController().signal, onProgress: noop, removeBg })).toBeNull();
  });
});

describe('opaqueTextureImage', () => {
  it('fills transparent pixels with the nearest visible colour and makes everything opaque', () => {
    const img = image(9, 9, { transparentBorder: 3, color: [200, 10, 50] });
    const out = opaqueTextureImage(img);
    for (let i = 0; i < 81; i++) {
      expect(Array.from(out.data.slice(i * 4, i * 4 + 4))).toEqual([200, 10, 50, 255]);
    }
    expect(img.data[3]).toBe(0); // input untouched
  });

  it('fully transparent images become neutral grey', () => {
    const out = opaqueTextureImage(image(3, 3, { transparentBorder: 2 }));
    expect(Array.from(out.data.slice(0, 4))).toEqual([128, 128, 128, 255]);
  });
});

describe('createImageTexture', () => {
  it('is an sRGB, flipY DataTexture sharing the pixel buffer', () => {
    const img = image(4, 2);
    const tex = createImageTexture(img);
    expect(tex.flipY).toBe(true);
    expect(tex.colorSpace).toBe('srgb');
    expect(tex.image.width).toBe(4);
    expect((tex.image.data as Uint8Array).buffer).toBe(img.data.buffer);
  });
});

describe('buildDepthModel / remesh', () => {
  it('builds a textured surface and re-meshes in place without the driver', () => {
    const tex = createImageTexture(image(32, 32));
    const model = buildDepthModel(dome(32, 32), null, tex, { mode: 'relief', resolution: 32 });
    const mesh = model.object as Mesh;
    const mat = mesh.material as MeshStandardMaterial;
    expect(mat.map).toBe(tex);
    expect(mat.side).toBe(DoubleSide);
    expect(model.stats.watertight).toBe(false);
    expect(model.meshKey).toBe(meshKeyOf({ mode: 'relief', resolution: 32 }));

    const old = mesh.geometry;
    const disposed = vi.fn();
    old.addEventListener('dispose', disposed);
    const stats = model.remesh!({ mode: 'solid', resolution: 48 });
    expect(disposed).toHaveBeenCalledOnce();
    expect(mesh.geometry).not.toBe(old);
    expect(stats.watertight).toBe(true);
    expect(stats.triangles).toBeGreaterThan(0);
    expect(mat.side).toBe(FrontSide);
    expect(mat.map).toBe(tex); // texture kept across re-meshing
    expect(model.meshKey).toBe(meshKeyOf({ mode: 'solid', resolution: 48 }));
  });

  it('meshKeyOf normalises equivalent params', () => {
    expect(meshKeyOf({})).toBe(meshKeyOf({ mode: 'relief' }));
    expect(meshKeyOf({ mode: 'solid' })).not.toBe(meshKeyOf({ mode: 'relief' }));
  });
});

describe('normalizeToFrame / statsForObject', () => {
  it('scales the longest side to 2 and centres the object', () => {
    const mesh = new Mesh(new BoxGeometry(4, 2, 1), new MeshStandardMaterial());
    mesh.position.set(10, 5, -3);
    const group = normalizeToFrame(mesh);
    const box = new Box3().setFromObject(group);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    expect(size.x).toBeCloseTo(2);
    expect(size.y).toBeCloseTo(1);
    expect(center.length()).toBeLessThan(1e-6);
  });

  it('sums stats over meshes', () => {
    const a = normalizeToFrame(new Mesh(new BoxGeometry(1, 1, 1)));
    const s = statsForObject(a);
    expect(s.triangles).toBe(12);
    expect(s.vertices).toBe(8);
    expect(s.watertight).toBe(true);
  });
});

describe('buildModel', () => {
  it('geometry results get the image texture; closed meshes are front-sided', async () => {
    const model = await buildModel({ kind: 'geometry', geometry: new BoxGeometry(1, 1, 1) }, image(8, 8), null, {});
    expect(model.kind).toBe('geometry');
    const mat = (model.object as Mesh).material as MeshStandardMaterial;
    expect(mat.map).not.toBeNull();
    expect(mat.side).toBe(FrontSide);
    expect(model.remesh).toBeNull();
  });

  it('model results: GLB is parsed and normalised to the frame', async () => {
    const src = new Mesh(new BoxGeometry(10, 4, 2), new MeshStandardMaterial({ color: 0x888888 }));
    const glb = await (await exportObject(src, 'glb')).arrayBuffer();
    const model = await buildGltfModel(glb);
    expect(model.kind).toBe('model');
    const size = new Box3().setFromObject(model.object).getSize(new Vector3());
    expect(Math.max(size.x, size.y, size.z)).toBeCloseTo(2);
    expect(model.stats.triangles).toBe(12);
  });
});

describe('runPipeline', () => {
  it('passes the mask to the driver and builds a depth model', async () => {
    const img = image(24, 24, { transparentBorder: 4 });
    const driver = fakeDriver(() => ({ kind: 'depth', depth: dome(24, 24), mask: null }));
    const labels: Progress[] = [];
    const { model, inputMask } = await runPipeline({
      source: source(img),
      bgMode: 'auto',
      driver,
      params: { a: 1 },
      meshParams: { resolution: 24 },
      signal: new AbortController().signal,
      onProgress: (p) => labels.push(p),
    });
    expect(inputMask).not.toBeNull();
    const call = (driver.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.mask).toBe(inputMask);
    expect(call.params).toEqual({ a: 1 });
    expect(call.image).toBe(img);
    expect(model.kind).toBe('depth');
    expect(model.mask).toBe(inputMask); // result.mask null → input mask used for meshing
    expect(model.stats.triangles).toBeGreaterThan(0);
    expect(labels.some((p) => p.label.en === 'Building mesh…')).toBe(true);
  });

  it('uses a provided (cached) mask instead of recomputing', async () => {
    const cached: Mask = { width: 8, height: 8, data: new Uint8Array(64).fill(1) };
    const removeBg = vi.fn();
    const driver = fakeDriver(() => ({ kind: 'depth', depth: dome(8, 8), mask: null }));
    await runPipeline({
      source: source(image(8, 8)),
      bgMode: 'ai',
      driver,
      params: {},
      meshParams: { resolution: 8 },
      signal: new AbortController().signal,
      onProgress: noop,
      mask: cached,
      removeBg,
    });
    expect(removeBg).not.toHaveBeenCalled();
    expect((driver.run as ReturnType<typeof vi.fn>).mock.calls[0][0].mask).toBe(cached);
  });

  it('throws AbortError when cancelled during the driver run', async () => {
    const ctrl = new AbortController();
    const driver = fakeDriver(async () => {
      ctrl.abort();
      return { kind: 'depth', depth: dome(8, 8), mask: null };
    });
    await expect(
      runPipeline({ source: source(image(8, 8)), bgMode: 'none', driver, params: {}, meshParams: {}, signal: ctrl.signal, onProgress: noop }),
    ).rejects.toBeInstanceOf(AbortError);
  });

  it('propagates driver errors', async () => {
    const driver = fakeDriver(() => {
      throw new Error('boom');
    });
    await expect(
      runPipeline({ source: source(image(8, 8)), bgMode: 'none', driver, params: {}, meshParams: {}, signal: new AbortController().signal, onProgress: noop }),
    ).rejects.toThrow('boom');
  });
});

describe('isAbortError', () => {
  it('recognises our AbortError and DOM-style aborts', () => {
    expect(isAbortError(new AbortError())).toBe(true);
    expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortError(new Error('x'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
