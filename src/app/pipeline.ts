/**
 * Generation pipeline: uploaded file → working image → foreground mask →
 * driver → displayable three.js object.
 *
 * Depth results keep their depth map so the surface can be rebuilt in place
 * when only mesh options change (`BuiltModel.remesh`), without re-running
 * the driver. Everything here except loading / AI background removal /
 * GLB parsing with textures runs in Node (unit tests).
 */
import {
  Box3,
  DataTexture,
  DoubleSide,
  FrontSide,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
} from 'three';
import type { BufferGeometry, Object3D, Side, Texture } from 'three';
import type { DepthMap, Driver, DriverResult, Mask, ParamValues, Progress, RGBAImage } from '../core/types';
import { AbortError, throwIfAborted } from '../core/types';
import { fitRGBA, hasTransparency, maskArea, maskFromAlpha } from '../core/image/ops';
import { autoMaskFromBorder } from '../core/image/autoMask';
import { loadImageFile } from '../core/image/load';
import { removeBackground } from '../core/preprocess/removeBackground';
import { buildGeometryFromDepth } from '../core/mesh/buildFromDepth';
import { computeMeshStats, type MeshStats } from '../core/mesh/stats';
import { meshOptionsFromParams, type MeshMode } from '../core/mesh/options';
import { disposeObject } from './dispose';
import { UI } from './i18n';

/** Longest side of the working image handed to drivers and used as texture. */
export const WORKING_MAX_SIDE = 1024;

export type BackgroundMode = 'auto' | 'border' | 'ai' | 'none';
export const BACKGROUND_MODES: BackgroundMode[] = ['auto', 'border', 'ai', 'none'];

export function isBackgroundMode(v: unknown): v is BackgroundMode {
  return typeof v === 'string' && (BACKGROUND_MODES as string[]).includes(v);
}

export interface SourceImage {
  /** Display / download name, e.g. "cat.png". */
  name: string;
  /** Original file (cloud drivers upload it). */
  file: Blob;
  /** Working image, longest side ≤ WORKING_MAX_SIDE. */
  image: RGBAImage;
}

export async function prepareSource(
  file: Blob,
  name: string,
  load: (f: Blob) => Promise<RGBAImage> = loadImageFile,
): Promise<SourceImage> {
  const decoded = await load(file);
  return { name, file, image: fitRGBA(decoded, WORKING_MAX_SIDE) };
}

/** Why the preview has no mask: 'no-alpha' (auto, opaque image), 'border-failed', 'deferred' (AI runs on Generate). */
export type MaskNote = 'no-alpha' | 'border-failed' | 'deferred' | null;

/** Masks that are cheap enough to compute immediately (for the preview overlay). */
export function quickMask(image: RGBAImage, mode: BackgroundMode): { mask: Mask | null; note: MaskNote } {
  switch (mode) {
    case 'auto':
      return hasTransparency(image) ? { mask: nonEmpty(maskFromAlpha(image)), note: null } : { mask: null, note: 'no-alpha' };
    case 'border': {
      // A transparent PNG already has the best mask: its alpha.
      if (hasTransparency(image)) return { mask: nonEmpty(maskFromAlpha(image)), note: null };
      const mask = autoMaskFromBorder(image);
      return mask ? { mask, note: null } : { mask: null, note: 'border-failed' };
    }
    case 'ai':
      return { mask: null, note: 'deferred' };
    case 'none':
      return { mask: null, note: null };
  }
}

function nonEmpty(mask: Mask): Mask | null {
  return maskArea(mask) > 0 ? mask : null;
}

export interface MaskContext {
  signal: AbortSignal;
  onProgress: (p: Progress) => void;
  removeBg?: typeof removeBackground;
}

/** Foreground mask for the chosen background mode (runs AI background removal for 'ai'). */
export async function resolveMask(image: RGBAImage, mode: BackgroundMode, ctx: MaskContext): Promise<Mask | null> {
  if (mode !== 'ai') return quickMask(image, mode).mask;
  const remove = ctx.removeBg ?? removeBackground;
  const mask = await remove(image, { signal: ctx.signal, onProgress: ctx.onProgress });
  return nonEmpty(mask);
}

/**
 * Opaque copy of `img` for use as a texture: pixels with (almost) no alpha
 * carry no usable colour, so they take the colour of the nearest visible
 * pixel (multi-source BFS). This keeps silhouette rims and side walls from
 * sampling black.
 */
export function opaqueTextureImage(img: RGBAImage, alphaThreshold = 16): RGBAImage {
  const { width: w, height: h, data: src } = img;
  const n = w * h;
  const out = new Uint8ClampedArray(src);
  const filled = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    if (src[i * 4 + 3] >= alphaThreshold) {
      filled[i] = 1;
      queue[tail++] = i;
    }
  }
  if (tail === 0) {
    for (let i = 0; i < n; i++) out.set([128, 128, 128, 255], i * 4);
    return { width: w, height: h, data: out };
  }
  const visit = (from: number, j: number) => {
    if (filled[j]) return;
    filled[j] = 1;
    out[j * 4] = out[from * 4];
    out[j * 4 + 1] = out[from * 4 + 1];
    out[j * 4 + 2] = out[from * 4 + 2];
    queue[tail++] = j;
  };
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    if (x > 0) visit(i, i - 1);
    if (x < w - 1) visit(i, i + 1);
    if (i >= w) visit(i, i - w);
    if (i < n - w) visit(i, i + w);
  }
  for (let i = 0; i < n; i++) out[i * 4 + 3] = 255;
  return { width: w, height: h, data: out };
}

/** sRGB texture of a top-row-first RGBA image; flipY so that UV (0,0) is the image's bottom-left. */
export function createImageTexture(img: RGBAImage): DataTexture {
  const data = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  const tex = new DataTexture(data, img.width, img.height, RGBAFormat, UnsignedByteType);
  tex.name = 'image';
  tex.flipY = true;
  tex.colorSpace = SRGBColorSpace;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export function createSurfaceMaterial(map: Texture | null, side: Side): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({ map, roughness: 0.8, metalness: 0, side });
  mat.name = '3dmarker-surface';
  return mat;
}

/** Open surfaces are visible from behind; closed ones only need their front faces. */
export function sideForMode(mode: MeshMode): Side {
  return mode === 'relief' ? DoubleSide : FrontSide;
}

export interface BuiltModel {
  kind: DriverResult['kind'];
  /** Root object for the viewer and the exporters (already in the shared frame). */
  object: Object3D;
  stats: MeshStats;
  /** Depth results: the depth map and mask the surface was built from. */
  depth: DepthMap | null;
  mask: Mask | null;
  /** Normalised mesh options the current surface was built with (depth results only). */
  meshKey: string | null;
  /** Depth results only: rebuild the surface in place for new mesh params (disposes the old geometry). */
  remesh: ((meshParams: ParamValues) => MeshStats) | null;
}

/** Stable key of the effective mesh options (equal options → equal key). */
export function meshKeyOf(meshParams: ParamValues): string {
  return JSON.stringify(meshOptionsFromParams(meshParams));
}

export function buildDepthModel(depth: DepthMap, mask: Mask | null, texture: Texture | null, meshParams: ParamValues): BuiltModel {
  const opts = meshOptionsFromParams(meshParams);
  const mesh = new Mesh(buildGeometryFromDepth(depth, mask, opts), createSurfaceMaterial(texture, sideForMode(opts.mode)));
  mesh.name = 'surface';
  const model: BuiltModel = {
    kind: 'depth',
    object: mesh,
    stats: computeMeshStats(mesh.geometry),
    depth,
    mask,
    meshKey: meshKeyOf(meshParams),
    remesh(p) {
      const o = meshOptionsFromParams(p);
      const next = buildGeometryFromDepth(depth, mask, o);
      const old = mesh.geometry;
      mesh.geometry = next;
      old.dispose();
      const material = mesh.material as MeshStandardMaterial;
      const side = sideForMode(o.mode);
      if (material.side !== side) {
        material.side = side;
        material.needsUpdate = true;
      }
      model.stats = computeMeshStats(next);
      model.meshKey = meshKeyOf(p);
      return model.stats;
    },
  };
  return model;
}

export function buildGeometryModel(geometry: BufferGeometry, texture: Texture | null): BuiltModel {
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const stats = computeMeshStats(geometry);
  const mesh = new Mesh(geometry, createSurfaceMaterial(texture, stats.watertight ? FrontSide : DoubleSide));
  mesh.name = 'surface';
  return { kind: 'geometry', object: mesh, stats, depth: null, mask: null, meshKey: null, remesh: null };
}

/**
 * Wrap `obj` in a group that scales it so the longest bounding-box side is 2
 * and centres it on the origin (the shared frame).
 */
export function normalizeToFrame(obj: Object3D): Group {
  obj.updateMatrixWorld(true);
  const box = new Box3().setFromObject(obj);
  const group = new Group();
  group.name = 'model';
  group.add(obj);
  if (box.isEmpty()) return group;
  const size = box.getSize(new Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  const center = box.getCenter(new Vector3());
  obj.position.sub(center);
  if (longest > 0 && Number.isFinite(longest)) group.scale.setScalar(2 / longest);
  group.updateMatrixWorld(true);
  return group;
}

/** Summed stats over every mesh; watertight only if every mesh is. */
export function statsForObject(obj: Object3D): MeshStats {
  let vertices = 0, triangles = 0, watertight = true, any = false;
  obj.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const s = computeMeshStats(mesh.geometry);
    vertices += s.vertices;
    triangles += s.triangles;
    watertight &&= s.watertight;
    any = true;
  });
  return { vertices, triangles, watertight: any && watertight };
}

/** Parse a binary glTF (Draco / meshopt supported) into a normalised model. */
export async function buildGltfModel(glb: ArrayBuffer): Promise<BuiltModel> {
  const [{ GLTFLoader }, { DRACOLoader }, { MeshoptDecoder }] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/loaders/DRACOLoader.js'),
    import('three/examples/jsm/libs/meshopt_decoder.module.js'),
  ]);
  // Default decoder URLs are bundler-resolved (new URL(..., import.meta.url)); fetched only for Draco files.
  const draco = new DRACOLoader();
  const loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
  try {
    const gltf = await loader.parseAsync(glb, '');
    const object = normalizeToFrame(gltf.scene);
    return { kind: 'model', object, stats: statsForObject(object), depth: null, mask: null, meshKey: null, remesh: null };
  } finally {
    draco.dispose();
  }
}

/** Turn a driver result into a displayable model. */
export async function buildModel(
  result: DriverResult,
  image: RGBAImage,
  inputMask: Mask | null,
  meshParams: ParamValues,
): Promise<BuiltModel> {
  switch (result.kind) {
    case 'depth': {
      const texture = createImageTexture(opaqueTextureImage(image));
      return buildDepthModel(result.depth, result.mask ?? inputMask, texture, meshParams);
    }
    case 'geometry':
      return buildGeometryModel(result.geometry, createImageTexture(opaqueTextureImage(image)));
    case 'model':
      return buildGltfModel(result.glb);
  }
}

export interface PipelineRequest {
  source: SourceImage;
  bgMode: BackgroundMode;
  driver: Driver;
  params: ParamValues;
  meshParams: ParamValues;
  signal: AbortSignal;
  onProgress: (p: Progress) => void;
  /** Mask already computed for this source + mode; `undefined` computes it (AI removal for 'ai'). */
  mask?: Mask | null;
  removeBg?: typeof removeBackground;
}

export interface PipelineResult {
  model: BuiltModel;
  /** The mask handed to the driver (cache it for the AI mode). */
  inputMask: Mask | null;
}

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

export async function runPipeline(req: PipelineRequest): Promise<PipelineResult> {
  const { source, signal, onProgress } = req;
  throwIfAborted(signal);
  onProgress({ label: UI.starting });
  const inputMask =
    req.mask !== undefined ? req.mask : await resolveMask(source.image, req.bgMode, { signal, onProgress, removeBg: req.removeBg });
  throwIfAborted(signal);
  const result = await req.driver.run({
    image: source.image,
    mask: inputMask,
    file: source.file,
    params: req.params,
    signal,
    onProgress,
  });
  throwIfAborted(signal);
  onProgress({ label: result.kind === 'model' ? UI.loadingGlb : UI.buildingMesh });
  await yieldToUi();
  const model = await buildModel(result, source.image, inputMask, req.meshParams);
  if (signal.aborted) {
    disposeObject(model.object);
    throw new AbortError();
  }
  return { model, inputMask };
}

/** True for cancellations (our AbortError or a DOM AbortError). */
export function isAbortError(e: unknown): boolean {
  return e instanceof AbortError || (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError');
}
