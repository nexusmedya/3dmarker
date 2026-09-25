/**
 * Export a three.js object to GLB / OBJ / STL / PLY using the stock
 * three.js exporters.
 *
 * Every format bakes the object's world transform (including its parents',
 * e.g. a viewer turntable) into the file, times an optional uniform scale.
 * Pass the model root, not the whole viewer scene (lights, helpers and
 * cameras would be exported too).
 *
 * Textures (GLB only; OBJ has no MTL, STL/PLY have no textures — UVs are
 * still written to OBJ/PLY): GLTFExporter needs a DOM or OffscreenCanvas,
 * so GLB export of textured meshes is browser/worker-only. Supported maps:
 * CanvasTexture / Texture of an HTMLImageElement, HTMLCanvasElement,
 * ImageBitmap or OffscreenCanvas, and DataTexture with 8-bit RGBA data.
 * GLTFExporter writes DataTexture pixels with putImageData, which ignores its
 * flipY transform, so a DataTexture with flipY = true (the natural choice for
 * top-row-first RGBAImage data) would come out upside down; exportObject
 * hands the exporter a row-flipped copy instead. Float DataTextures are not
 * supported by GLTFExporter.
 */
import { Matrix4, TextureSource } from 'three';
import type { DataTexture, Material, Mesh, Object3D, Texture } from 'three';
import type { I18nText } from '../types';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { PLYExporter } from 'three/examples/jsm/exporters/PLYExporter.js';

export type ExportFormat = 'glb' | 'obj' | 'stl' | 'ply';

export interface ExportFormatInfo {
  format: ExportFormat;
  label: string;
  mime: string;
  ext: string;
  description: I18nText;
}

export const EXPORT_FORMATS: ExportFormatInfo[] = [
  {
    format: 'glb', label: 'GLB (glTF binary)', mime: 'model/gltf-binary', ext: 'glb',
    description: { tr: 'Doku ve malzeme dahil; web, oyun motorları, Blender', en: 'Includes texture and material; web, game engines, Blender' },
  },
  {
    format: 'obj', label: 'OBJ (Wavefront)', mime: 'model/obj', ext: 'obj',
    description: { tr: 'Geometri + UV (doku dosyası yok)', en: 'Geometry + UVs (no texture file)' },
  },
  {
    format: 'stl', label: 'STL (binary)', mime: 'model/stl', ext: 'stl',
    description: { tr: '3D baskı için; yalnızca geometri', en: 'For 3D printing; geometry only' },
  },
  {
    format: 'ply', label: 'PLY (binary)', mime: 'application/octet-stream', ext: 'ply',
    description: { tr: 'Geometri + normal + UV; MeshLab, CloudCompare', en: 'Geometry + normals + UVs; MeshLab, CloudCompare' },
  },
];

export function exportFormatInfo(format: ExportFormat): ExportFormatInfo {
  return EXPORT_FORMATS.find((f) => f.format === format)!;
}

export interface ExportOptions {
  /** Uniform scale applied on export (default 1: longest side = 2 units). Slicers read STL units as mm, so e.g. 50 → 100 mm. */
  scale?: number;
  /** GLB: textures larger than this are downscaled (default 4096). */
  maxTextureSize?: number;
}

/** Export `object` (and its children) as a file blob; the object itself is not modified. GLB/STL/PLY are binary. */
export async function exportObject(object: Object3D, format: ExportFormat, opts: ExportOptions = {}): Promise<Blob> {
  const root = bakeWorldTransform(object, opts.scale ?? 1);
  const type = exportFormatInfo(format).mime;
  switch (format) {
    case 'glb': {
      makeTexturesExportable(root);
      const out = await new GLTFExporter().parseAsync(root, { binary: true, maxTextureSize: opts.maxTextureSize ?? 4096 });
      if (typeof (out as ArrayBuffer).byteLength !== 'number') throw new Error('GLTFExporter returned JSON instead of GLB');
      return new Blob([out as ArrayBuffer], { type });
    }
    case 'obj':
      return new Blob([new OBJExporter().parse(root)], { type });
    case 'stl':
      return new Blob([new STLExporter().parse(root, { binary: true })], { type });
    case 'ply': {
      // Passing no onDone keeps the exporter synchronous (with one it schedules requestAnimationFrame).
      const noCallback = undefined as unknown as (res: ArrayBuffer) => void;
      const out = new PLYExporter().parse(root, noCallback, { binary: true, littleEndian: true });
      if (!out) throw new Error('PLYExporter failed');
      return new Blob([out], { type });
    }
  }
}

/** File name for a download: the source name without its extension (sanitised) + the format's extension. */
export function exportFileName(sourceName: string, format: ExportFormat): string {
  const base = sourceName.replace(/\.[^./\\]*$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
  return `${base || '3dmarker-model'}.${exportFormatInfo(format).ext}`;
}

/** Save a blob via a temporary <a download> (browser only). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 40_000); // revoking right away can cancel the download in some browsers
}

/**
 * Shallow clone of `object` (geometries/materials shared) whose root carries
 * scale × the object's world matrix, so the clone's world space is the
 * export space. The original is not modified (apart from updating its matrices).
 */
export function bakeWorldTransform(object: Object3D, scale = 1): Object3D {
  object.updateWorldMatrix(true, true);
  const root = object.clone();
  new Matrix4().makeScale(scale, scale, scale).multiply(object.matrixWorld).decompose(root.position, root.quaternion, root.scale);
  root.matrixAutoUpdate = true;
  root.updateMatrixWorld(true);
  return root;
}

/**
 * Replace flipY DataTextures on `root`'s materials by row-flipped copies.
 * Materials are cloned and reassigned on `root`'s meshes, never mutated, so
 * call it on a clone (see bakeWorldTransform).
 */
export function makeTexturesExportable(root: Object3D): void {
  const cache = new Map<Texture, Texture>();
  const fix = (mat: Material): Material => {
    let out = mat;
    for (const key of Object.keys(mat)) {
      const tex = (mat as unknown as Record<string, unknown>)[key] as Texture | null | undefined;
      if (!tex || !(tex as DataTexture).isDataTexture || !tex.flipY) continue;
      if (out === mat) out = mat.clone();
      let flipped = cache.get(tex);
      if (!flipped) cache.set(tex, (flipped = flipDataTexture(tex as DataTexture)));
      (out as unknown as Record<string, unknown>)[key] = flipped;
    }
    return out;
  };
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(fix) : fix(mesh.material);
  });
}

/** Copy of a DataTexture with its rows reversed and flipY = false (same appearance when rendered). */
export function flipDataTexture(tex: DataTexture): DataTexture {
  const { data, width, height } = tex.image;
  const out = tex.clone();
  if (!data) return out;
  const flipped = data.slice();
  const row = data.length / height;
  for (let y = 0; y < height; y++) flipped.set(data.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  out.source = new TextureSource({ data: flipped, width, height });
  out.flipY = false;
  out.needsUpdate = true;
  return out;
}
