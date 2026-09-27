import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AnimationClip,
  AnimationMixer,
  BoxGeometry,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  FrontSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Vector3,
  VectorKeyframeTrack,
  Box3,
  LinearMipmapLinearFilter,
} from 'three';
import type { DepthMap, Driver, DriverResult, Mask, ParamValues, Progress, RGBAImage, ViewSet } from '../core/types';
import { AbortError } from '../core/types';
import { LocalizedError } from '../core/errors';
import { exportObject } from '../core/export/exporters';
import { computeMeshStats } from '../core/mesh/stats';
import { disposeObject } from './dispose';
import {
  TEXTURE_MAX_SIDE,
  WORKING_MAX_SIDE,
  buildDepthModel,
  buildGeometryModel,
  buildGltfModel,
  buildModel,
  frontView,
  fusionReportOf,
  hasVertexColors,
  createImageTexture,
  isAbortError,
  meshKeyOf,
  normalizeToFrame,
  opaqueTextureImage,
  prepareSource,
  quickMask,
  resolveMask,
  runPipeline,
  sourceFromImage,
  statsForObject,
  textureImageOf,
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

  it('decodes straight to the texture size (no full-size intermediate)', async () => {
    const load = vi.fn(async () => image(8, 8));
    await prepareSource(new Blob(), 'x.png', load);
    expect(load).toHaveBeenCalledWith(expect.any(Blob), TEXTURE_MAX_SIDE);
    // Extra views need no texture copy: decoded at the working size.
    await prepareSource(new Blob(), 'v.png', load, { textureMaxSide: WORKING_MAX_SIDE });
    expect(load).toHaveBeenLastCalledWith(expect.any(Blob), WORKING_MAX_SIDE);
  });

  it('keeps small images untouched', async () => {
    const small = image(64, 32);
    const src = await prepareSource(new Blob(), 's.png', async () => small);
    expect(src.image).toBe(small);
    expect(src.texture).toBeUndefined();
    expect(textureImageOf(src)).toBe(small);
  });

  it('keeps a texture copy (≤ TEXTURE_MAX_SIDE) when the image is larger than the working size', async () => {
    const huge = image(3000, 1500);
    const src = await prepareSource(new Blob(), 'h.png', async () => huge);
    expect([src.image.width, src.image.height]).toEqual([WORKING_MAX_SIDE, WORKING_MAX_SIDE / 2]);
    expect([src.texture!.width, src.texture!.height]).toEqual([TEXTURE_MAX_SIDE, TEXTURE_MAX_SIDE / 2]);
    expect(textureImageOf(src)).toBe(src.texture);
    const views = await prepareSource(new Blob(), 'h.png', async () => huge, { textureMaxSide: WORKING_MAX_SIDE });
    expect(views.texture).toBeUndefined();
  });

  it('sourceFromImage splits an enhanced image into working image + texture', () => {
    const file = new Blob();
    const big = sourceFromImage(image(1536, 768), 'e.png', file);
    expect(big.image.width).toBe(WORKING_MAX_SIDE);
    expect(big.texture!.width).toBe(1536);
    expect(big.file).toBe(file);
    const small = sourceFromImage(image(600, 300), 'e.png', file);
    expect(small.texture).toBeUndefined();
  });
});

describe('texture', () => {
  it('uses trilinear mipmaps and anisotropic filtering', () => {
    const tex = createImageTexture(image(16, 8));
    expect(tex.generateMipmaps).toBe(true);
    expect(tex.minFilter).toBe(LinearMipmapLinearFilter);
    expect(tex.anisotropy).toBeGreaterThan(1);
    tex.dispose();
  });

  it('runPipeline textures the model with the texture copy while the driver gets the working image', async () => {
    const tex = image(64, 64);
    const work = image(32, 32);
    let seen: RGBAImage | null = null;
    const driver = {
      id: 'probe',
      run: async (input: { image: RGBAImage }) => {
        seen = input.image;
        return { kind: 'geometry' as const, geometry: new BoxGeometry(1, 1, 1) };
      },
    } as unknown as Driver;
    const out = await runPipeline({
      source: { name: 's.png', file: new Blob(), image: work, texture: tex },
      bgMode: 'none',
      driver,
      params: {},
      meshParams: {},
      signal: new AbortController().signal,
      onProgress: () => {},
      mask: null,
    });
    expect(seen).toBe(work);
    const mesh = out.model.object as Mesh;
    const map = (mesh.material as MeshStandardMaterial).map!;
    expect((map.image as { width: number }).width).toBe(64);
    disposeObject(out.model.object);
  });
});

describe('quickMask', () => {
  it('auto: alpha mask for transparent PNGs, null + note for opaque ones', () => {
    const t = quickMask(image(20, 20, { transparentBorder: 5 }), 'auto');
    expect(t.note).toBeNull();
    expect(t.mask!.data.reduce((a, v) => a + v, 0)).toBe(100);
    expect(quickMask(image(20, 20), 'auto')).toEqual({ mask: null, note: 'no-alpha' });
  });

  it('auto: an opaque image on a plain background gets the border mask (no rectangular slab)', () => {
    const m = quickMask(onWhite(40, 60, 10), 'auto');
    expect(m.note).toBeNull();
    expect(m.mask).not.toBeNull();
    const area = m.mask!.data.reduce((a, v) => a + v, 0);
    expect(area).toBeGreaterThan(0.8 * 20 * 40);
    expect(area).toBeLessThanOrEqual(20 * 40);
    // Busy (photo-like) background: nothing to separate, keep the note.
    const noisy = image(40, 40);
    for (let i = 0; i < noisy.data.length; i += 4) noisy.data.set([(i * 37) % 256, (i * 91) % 256, (i * 13) % 256], i);
    expect(quickMask(noisy, 'auto')).toEqual({ mask: null, note: 'no-alpha' });
  });

  it('auto: a few soft-alpha pixels do not hide a plain background', () => {
    const img = onWhite(40, 40, 10);
    img.data[3] = 200; // one semi-transparent corner pixel (not meaningful alpha)
    const m = quickMask(img, 'auto');
    expect(m.mask).not.toBeNull();
    expect(m.mask!.data.reduce((a, v) => a + v, 0)).toBeLessThanOrEqual(400);
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

  it('re-meshing changes the side of the surface material even while the viewer shows a display material', () => {
    const model = buildDepthModel(dome(16, 16), null, null, { mode: 'solid', resolution: 16 });
    const mesh = model.object as Mesh;
    const orig = mesh.material as MeshStandardMaterial;
    expect(orig.side).toBe(FrontSide);
    // Stand-in for ViewerCore's clay / wireframe / texture-off material swap.
    const display = new MeshBasicMaterial({ side: FrontSide });
    mesh.material = display;
    model.remesh!({ mode: 'relief', resolution: 16 });
    expect(orig.side).toBe(DoubleSide); // the material the viewer restores and exports
    expect(display.side).toBe(FrontSide); // display material untouched (the viewer resyncs its clones)
    display.side = DoubleSide;
    model.remesh!({ mode: 'solid', resolution: 16 });
    expect(orig.side).toBe(FrontSide);
    expect(display.side).toBe(DoubleSide);
    expect(mesh.material).toBe(display);
  });

  it('depthMeshStats (read from the builder layout) equals the full welded check', () => {
    const W = 48, H = 40;
    const maskOf = (f: (x: number, y: number) => boolean): Mask => {
      const data = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = f(x, y) ? 1 : 0;
      return { width: W, height: H, data };
    };
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const masks: (Mask | null)[] = [
      null,
      maskOf(() => false), // all background → empty geometry
      maskOf((x, y) => (x - 24) ** 2 + (y - 20) ** 2 < 15 ** 2 && (x - 24) ** 2 + (y - 20) ** 2 > 5 ** 2), // ring (hole)
      maskOf((x, y) => (x < 14 && y < 14) || (x > 30 && y > 22) || (x >= 14 && x < 16 && y > 5 && y < 30)), // islands, thin bridge
      maskOf((x, y) => (x + y) % 2 === 0 || (x > 10 && x < 38 && y > 8 && y < 32)), // checkerboard fringe (pinches)
      maskOf(() => rand() < 0.7), // noise
    ];
    const depths = [dome(W, H), { width: W, height: H, data: Float32Array.from({ length: W * H }, () => rand()) }];
    let checked = 0;
    for (const mask of masks)
      for (const depth of depths)
        for (const mode of ['relief', 'solid', 'double'] as const)
          for (const extra of [{}, { resolution: 23, smoothing: 0, discontinuity: 0.2 }, { resolution: 64, depthScale: 0, baseThickness: 0 }] as ParamValues[]) {
            const model = buildDepthModel(depth, mask, null, { mode, resolution: 32, ...extra });
            const geometry = (model.object as Mesh).geometry;
            expect(model.stats, `${mode} ${JSON.stringify(extra)}`).toEqual(computeMeshStats(geometry));
            expect(model.remesh!({ mode, resolution: 40, ...extra })).toEqual(computeMeshStats((model.object as Mesh).geometry));
            checked++;
          }
    expect(checked).toBe(masks.length * depths.length * 9);
  });

  it('a re-mesh that would come out empty throws and keeps the surface, stats and meshKey', () => {
    const S = 1024;
    const depth: DepthMap = { width: S, height: S, data: new Float32Array(S * S).fill(0.5) };
    const dot: Mask = { width: S, height: S, data: new Uint8Array(S * S) };
    for (let y = 501; y < 505; y++) for (let x = 501; x < 505; x++) dot.data[y * S + x] = 1; // 4×4 px
    const model = buildDepthModel(depth, dot, null, { mode: 'solid', resolution: 512 });
    const mesh = model.object as Mesh;
    const geometry = mesh.geometry;
    const stats = model.stats;
    const key = model.meshKey;
    expect(stats.triangles).toBeGreaterThan(0);
    // useStudio turns the error into jobFailed; the model on screen must stay intact.
    expect(() => model.remesh!({ mode: 'solid', resolution: 256 })).toThrow(LocalizedError);
    expect(mesh.geometry).toBe(geometry);
    expect(geometry.getAttribute('position').count).toBeGreaterThan(0);
    expect(model.stats).toBe(stats);
    expect(model.meshKey).toBe(key);
    // And building one from scratch fails before anything is allocated for the viewer.
    expect(() => buildDepthModel(depth, dot, null, { mode: 'relief', resolution: 256 })).toThrow(LocalizedError);
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

  it('skips empty meshes (e.g. a rig placeholder), which would make it look open', () => {
    const group = new Group();
    group.add(new Mesh(new BoxGeometry(1, 1, 1)), new Mesh(new BufferGeometry()));
    expect(statsForObject(group)).toEqual({ vertices: 8, triangles: 12, watertight: true });
    expect(statsForObject(new Mesh(new BufferGeometry()))).toEqual({ vertices: 0, triangles: 0, watertight: false });
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

  it('vertex-coloured geometry results are shown with their colours and no texture', async () => {
    const geometry = new BoxGeometry(1, 1, 1);
    geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 3).fill(0.5), 3));
    expect(hasVertexColors(geometry)).toBe(true);
    const model = await buildModel({ kind: 'geometry', geometry }, image(8, 8), null, {});
    const mat = (model.object as Mesh).material as MeshStandardMaterial;
    expect(mat).toBeInstanceOf(MeshStandardMaterial);
    expect(mat.vertexColors).toBe(true);
    expect(mat.map).toBeNull();
    expect(mat.side).toBe(FrontSide);
    // A texture handed in anyway is released, not shown.
    const tex = createImageTexture(image(4, 4));
    let disposed = false;
    tex.addEventListener('dispose', () => (disposed = true));
    const g2 = new BoxGeometry(1, 1, 1);
    g2.setAttribute('color', new Float32BufferAttribute(new Float32Array(g2.getAttribute('position').count * 3), 3));
    const m2 = buildGeometryModel(g2, tex);
    expect(((m2.object as Mesh).material as MeshStandardMaterial).map).toBeNull();
    expect(disposed).toBe(true);
    // Without colours: textured as before.
    expect(hasVertexColors(new BoxGeometry(1, 1, 1))).toBe(false);
  });

  it('model results: GLB is parsed and normalised to the frame', async () => {
    const src = new Mesh(new BoxGeometry(10, 4, 2), new MeshStandardMaterial({ color: 0x888888 }));
    const glb = await (await exportObject(src, 'glb')).arrayBuffer();
    const model = await buildGltfModel(glb);
    expect(model.kind).toBe('model');
    const size = new Box3().setFromObject(model.object).getSize(new Vector3());
    expect(Math.max(size.x, size.y, size.z)).toBeCloseTo(2);
    expect(model.stats.triangles).toBe(12);
    expect(model.animations).toBeUndefined();
  });

  it('model results: embedded animation clips are kept (and still bind under the normalising group)', async () => {
    const src = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    src.name = 'Spinner';
    const clip = new AnimationClip('spin', 1, [new VectorKeyframeTrack('Spinner.position', [0, 1], [0, 0, 0, 0, 2, 0])]);
    const glb = await (await exportObject(src, 'glb', { animations: [clip] })).arrayBuffer();
    const model = await buildGltfModel(glb);
    expect(model.animations?.map((c) => c.name)).toEqual(['spin']);
    const mixer = new AnimationMixer(model.object);
    mixer.clipAction(model.animations![0]).play();
    const node = model.object.getObjectByName('Spinner')!;
    const y0 = node.position.y;
    mixer.update(0.5); // halfway: 1 unit up
    expect(node.position.y - y0).toBeCloseTo(1, 3);
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

  it('hands the driver every view: the source as the front plus the extra views', async () => {
    const img = image(16, 16, { transparentBorder: 3 });
    const src = source(img);
    const back: ViewSet['back'] = { id: 'back', image: image(16, 16), mask: null, file: new Blob(['b']), origin: 'ai' };
    const driver = fakeDriver(() => ({ kind: 'depth', depth: dome(16, 16), mask: null }));
    const { inputMask } = await runPipeline({
      source: src,
      bgMode: 'auto',
      driver,
      params: {},
      meshParams: { resolution: 16 },
      signal: new AbortController().signal,
      onProgress: noop,
      views: { back },
    });
    const views = (driver.run as ReturnType<typeof vi.fn>).mock.calls[0][0].views as ViewSet;
    expect(Object.keys(views).sort()).toEqual(['back', 'front']);
    expect(views.back).toBe(back);
    expect(views.front).toEqual({ id: 'front', image: img, mask: inputMask, file: src.file, origin: 'source' });
    expect(frontView(src, null).mask).toBeNull();

    // No extra views: still the front.
    const d2 = fakeDriver(() => ({ kind: 'depth', depth: dome(16, 16), mask: null }));
    await runPipeline({ source: src, bgMode: 'none', driver: d2, params: {}, meshParams: { resolution: 16 }, signal: new AbortController().signal, onProgress: noop });
    expect(Object.keys((d2.run as ReturnType<typeof vi.fn>).mock.calls[0][0].views)).toEqual(['front']);
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

  it('a cancel that queued up while the mesh was built still aborts the job (and frees the model)', async () => {
    const ctrl = new AbortController();
    const geometry = new BoxGeometry(1, 1, 1);
    const disposed = vi.fn();
    geometry.addEventListener('dispose', disposed);
    let frames = 0;
    // Frames 1–2: the yield before the build; frame 3: the one after it, when the Esc keydown runs.
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
      if (++frames === 3) ctrl.abort();
      return setTimeout(() => cb(0), 0);
    });
    try {
      const driver = fakeDriver(() => ({ kind: 'geometry', geometry }));
      await expect(
        runPipeline({ source: source(image(8, 8)), bgMode: 'none', driver, params: {}, meshParams: {}, signal: ctrl.signal, onProgress: noop }),
      ).rejects.toBeInstanceOf(AbortError);
      expect(frames).toBe(4); // two yields of two frames each
      expect(disposed).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
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

describe('fusionReportOf', () => {
  it('finds the fusion report on a mesh geometry (first one), null elsewhere', () => {
    const report = { views: [{ id: 'back', score: 91 }], warnings: [] };
    const g = new BoxGeometry(1, 1, 1);
    g.userData.fusion = report;
    const plain = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    const group = new Group();
    group.add(plain, new Mesh(g, new MeshBasicMaterial()));
    expect(fusionReportOf(group)).toBe(report);
    expect(fusionReportOf(plain)).toBeNull();
    // Junk under the key is not a report.
    plain.geometry.userData.fusion = { views: 'no' };
    expect(fusionReportOf(plain)).toBeNull();
    expect(fusionReportOf(new Group())).toBeNull();
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
