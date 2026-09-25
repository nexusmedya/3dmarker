/**
 * Release the GPU resources held by a three.js object tree: every geometry,
 * material and material texture reachable from `root` is disposed once.
 */
import type { BufferGeometry, Material, Object3D, Texture } from 'three';

export interface DisposeCounts {
  geometries: number;
  materials: number;
  textures: number;
}

/** Textures referenced by a material's own properties (map, normalMap, matcap, …). */
export function materialTextures(mat: Material, into = new Set<Texture>()): Set<Texture> {
  for (const value of Object.values(mat)) {
    if (value && typeof value === 'object' && (value as Texture).isTexture) into.add(value as Texture);
  }
  return into;
}

export function materialsOf(obj: Object3D): Material[] {
  const mat = (obj as Object3D & { material?: Material | Material[] }).material;
  if (!mat) return [];
  return Array.isArray(mat) ? mat : [mat];
}

export function disposeObject(root: Object3D): DisposeCounts {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((o) => {
    const geometry = (o as Object3D & { geometry?: BufferGeometry }).geometry;
    if (geometry?.isBufferGeometry) geometries.add(geometry);
    for (const m of materialsOf(o)) materials.add(m);
  });
  for (const m of materials) materialTextures(m, textures);
  geometries.forEach((g) => g.dispose());
  materials.forEach((m) => m.dispose());
  textures.forEach((t) => t.dispose());
  return { geometries: geometries.size, materials: materials.size, textures: textures.size };
}
