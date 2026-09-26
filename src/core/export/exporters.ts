/**
 * Export a three.js object to GLB / OBJ / STL / PLY using the stock
 * three.js exporters (OBJ of meshes: an equivalent writer that yields to the
 * event loop, see writeObjParts).
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
 *
 * Rigged models (src/rig): skinned meshes are re-bound to the cloned bones
 * (a plain clone() keeps pointing at the original skeleton — also true of
 * ViewerCore.getExportObject's clone — so bones are matched by identity,
 * then by name), rig placeholder meshes are dropped. GLB keeps the skin
 * (JOINTS_0 / WEIGHTS_0 + inverse bind matrices) with the bones put back
 * into their bind pose (`userData.rest`) and writes `options.animations`
 * (node TRS, LINEAR samplers; clips that target no exported node are
 * skipped). OBJ / STL / PLY have no skins: they get the mesh as currently
 * posed (`pose: 'current'`, the default — what the viewer shows, e.g. a
 * paused animation frame) or in the bind pose (`pose: 'rest'`).
 */
import { BufferAttribute, BufferGeometry, Group, Matrix3, Matrix4, Mesh as MeshClass, PropertyBinding, Skeleton, TextureSource, Vector3, Vector4 } from 'three';
import type {
  AnimationClip, Bone, DataTexture, InterleavedBufferAttribute, Line, Material, Mesh, Object3D, Points, SkinnedMesh, Texture,
} from 'three';
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
  /** GLB only: animation clips to embed (tracks bind by node name, e.g. `Hips.quaternion`). */
  animations?: AnimationClip[];
  /** OBJ / STL / PLY of skinned meshes: bake the current pose (default) or the bind pose. */
  pose?: 'current' | 'rest';
}

/** Export `object` (and its children) as a file blob; the object itself is not modified. GLB/STL/PLY are binary. */
export async function exportObject(object: Object3D, format: ExportFormat, opts: ExportOptions = {}): Promise<Blob> {
  let root = bakeWorldTransform(object, opts.scale ?? 1);
  const type = exportFormatInfo(format).mime;
  const rigged = hasSkinOrRig(root);
  if (rigged) {
    rebindSkinnedClones(object, root);
    root = dropRigPlaceholders(root);
    if (format === 'glb') {
      resetBonesToRest(root);
      root.updateMatrixWorld(true);
    } else {
      root.updateMatrixWorld(true);
      bakeSkinnedMeshes(root, opts.pose ?? 'current');
    }
  }
  switch (format) {
    case 'glb': {
      makeTexturesExportable(root);
      const animations = (opts.animations ?? []).filter((clip) => clipTargetsNodes(clip, root));
      const out = await new GLTFExporter().parseAsync(root, { binary: true, maxTextureSize: opts.maxTextureSize ?? 4096, animations });
      if (typeof (out as ArrayBuffer).byteLength !== 'number') throw new Error('GLTFExporter returned JSON instead of GLB');
      return new Blob([out as ArrayBuffer], { type });
    }
    case 'obj': {
      let linesOrPoints = false;
      root.traverse((o) => { linesOrPoints ||= !!((o as Line).isLine || (o as Points).isPoints); });
      // Meshes only (every model this app builds): chunked, see writeObjParts.
      if (!linesOrPoints) return new Blob(await writeObjParts(root), { type });
      return new Blob([new OBJExporter().parse(root)], { type });
    }
    case 'stl':
      return new Blob([new STLExporter().parse(root, { binary: true })], { type });
    case 'ply': {
      floatifyPlyAttributes(root);
      // Passing no onDone keeps the exporter synchronous (with one it schedules requestAnimationFrame).
      const noCallback = undefined as unknown as (res: ArrayBuffer) => void;
      const out = new PLYExporter().parse(root, noCallback, { binary: true, littleEndian: true });
      if (!out) throw new Error('PLYExporter failed');
      return new Blob([out], { type });
    }
  }
}

/** Let the browser paint and handle input between chunks of a long export. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The OBJ text for the meshes under `root`, identical to three's OBJExporter
 * (world transform baked, normals through the normal matrix, 1-based indices
 * continuing across meshes) but built as Blob parts of ~16k lines, yielding
 * to the event loop every ~40 ms. A million-triangle mesh is ~150 MB of text
 * and seconds of string building, which in one piece froze the page (and the
 * export spinner) and needed the whole file as a single string.
 */
export async function writeObjParts(root: Object3D): Promise<string[]> {
  const parts: string[] = [];
  let chunk = '', lines = 0, last = performance.now();
  const push = (line: string) => {
    chunk += line;
    if (++lines === 16384) {
      parts.push(chunk);
      chunk = '';
      lines = 0;
    }
  };
  const pause = async () => {
    if (performance.now() - last < 40) return;
    await yieldToEventLoop();
    last = performance.now();
  };

  const meshes: Mesh[] = [];
  root.traverse((o) => { if ((o as Mesh).isMesh) meshes.push(o as Mesh); });
  const v = new Vector3(), normalMatrix = new Matrix3();
  let baseV = 0, baseT = 0, baseN = 0;
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const pos = g.getAttribute('position'), normal = g.getAttribute('normal'), uv = g.getAttribute('uv'), index = g.getIndex();
    const nV = pos ? pos.count : 0, nT = uv ? uv.count : 0, nN = normal ? normal.count : 0;
    push(`o ${mesh.name}\n`);
    const mat = mesh.material as Material | Material[] | undefined;
    if (mat && !Array.isArray(mat) && mat.name) push(`usemtl ${mat.name}\n`);
    for (let i = 0; i < nV; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      push(`v ${v.x} ${v.y} ${v.z}\n`);
      if ((i & 4095) === 4095) await pause();
    }
    for (let i = 0; i < nT; i++) {
      push(`vt ${uv.getX(i)} ${uv.getY(i)}\n`);
      if ((i & 4095) === 4095) await pause();
    }
    if (normal) normalMatrix.getNormalMatrix(mesh.matrixWorld);
    for (let i = 0; i < nN; i++) {
      v.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
      push(`vn ${v.x} ${v.y} ${v.z}\n`);
      if ((i & 4095) === 4095) await pause();
    }
    const corner = (k: number) => {
      const j = k + 1;
      return normal || uv ? `${baseV + j}/${uv ? baseT + j : ''}${normal ? `/${baseN + j}` : ''}` : `${baseV + j}`;
    };
    const nCorners = index ? index.count : nV;
    for (let t = 0, i = 0; i + 2 < nCorners; t++, i += 3) {
      const a = index ? index.getX(i) : i, b = index ? index.getX(i + 1) : i + 1, c = index ? index.getX(i + 2) : i + 2;
      push(`f ${corner(a)} ${corner(b)} ${corner(c)}\n`);
      if ((t & 4095) === 4095) await pause();
    }
    baseV += nV;
    baseT += nT;
    baseN += nN;
    await pause();
  }
  if (chunk) parts.push(chunk);
  return parts;
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

/**
 * PLYExporter declares each property with the type of the source array
 * (short, char, ushort… for quantized glTF / KHR_mesh_quantization) but writes
 * the de-normalised, transformed float values through it, truncating them.
 * Give `root`'s meshes and points geometries whose position, normal and uv are
 * plain Float32 copies instead. Only the affected geometries are replaced (a
 * shallow copy sharing everything else); nothing is mutated, so call it on a
 * clone (see bakeWorldTransform). Colours are scaled correctly by the exporter.
 */
export function floatifyPlyAttributes(root: Object3D): void {
  const needsFloat = (a: BufferAttribute | InterleavedBufferAttribute | undefined) =>
    !!a && (a.normalized || !(a.array instanceof Float32Array));
  root.traverse((o) => {
    const obj = o as Mesh | Points;
    if (!(obj as Mesh).isMesh && !(obj as Points).isPoints) return;
    const src = obj.geometry;
    const names = ['position', 'normal', 'uv'].filter((n) => needsFloat(src.getAttribute(n)));
    if (names.length === 0) return;
    const g = new BufferGeometry();
    g.setIndex(src.getIndex());
    for (const [name, attr] of Object.entries(src.attributes)) g.setAttribute(name, attr);
    for (const name of names) {
      const a = src.getAttribute(name);
      const out = new Float32Array(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);
      g.setAttribute(name, new BufferAttribute(out, a.itemSize));
    }
    obj.geometry = g;
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

// ---------------------------------------------------------------------------
// Rigged models

/** Set by src/rig on a mesh whose geometry moved to a skinned child (it renders nothing). */
const RIG_PLACEHOLDER = 'rigPlaceholder';

function hasSkinOrRig(root: Object3D): boolean {
  let found = false;
  root.traverse((o) => {
    if ((o as SkinnedMesh).isSkinnedMesh || (o as Bone).isBone || (o.userData as Record<string, unknown>)[RIG_PLACEHOLDER]) found = true;
  });
  return found;
}

function parallelTraverse(a: Object3D, b: Object3D, fn: (a: Object3D, b: Object3D) => void): void {
  fn(a, b);
  for (let i = 0; i < a.children.length && i < b.children.length; i++) parallelTraverse(a.children[i], b.children[i], fn);
}

/**
 * Point every skinned mesh of `clone` (a clone of `source`) at the cloned
 * bones: by identity through the parallel hierarchy, else by bone name
 * (when `source` itself was a clone whose skeleton still references another
 * tree's bones). Meshes whose bones cannot all be found are left as they are.
 */
export function rebindSkinnedClones(source: Object3D, clone: Object3D): void {
  const map = new Map<Object3D, Object3D>();
  parallelTraverse(source, clone, (a, b) => map.set(a, b));
  const byName = new Map<string, Bone>();
  clone.traverse((o) => {
    if ((o as Bone).isBone && !byName.has(o.name)) byName.set(o.name, o as Bone);
  });
  const inTree = new Set<Object3D>();
  clone.traverse((o) => inTree.add(o));
  clone.traverse((o) => {
    const mesh = o as SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.skeleton) return;
    const bones = mesh.skeleton.bones.map((b) => {
      const mapped = map.get(b) as Bone | undefined;
      if (mapped && (mapped as Bone).isBone) return mapped;
      return inTree.has(b) ? b : byName.get(b.name);
    });
    if (bones.some((b) => !b)) return;
    const skeleton = new Skeleton(bones as Bone[], mesh.skeleton.boneInverses.map((m) => m.clone()));
    mesh.bind(skeleton, mesh.bindMatrix.clone());
  });
}

/** Remove rig placeholder meshes (a root placeholder becomes a Group keeping its transform and children). */
function dropRigPlaceholders(root: Object3D): Object3D {
  const swap = (mesh: Object3D): Object3D => {
    const g = new Group();
    g.name = mesh.name;
    g.position.copy(mesh.position);
    g.quaternion.copy(mesh.quaternion);
    g.scale.copy(mesh.scale);
    g.userData = { ...mesh.userData };
    delete (g.userData as Record<string, unknown>)[RIG_PLACEHOLDER];
    for (const c of [...mesh.children]) g.add(c);
    const parent = mesh.parent;
    if (parent) {
      const i = parent.children.indexOf(mesh);
      parent.children[i] = g;
      g.parent = parent;
      mesh.parent = null;
    }
    return g;
  };
  const found: Object3D[] = [];
  root.traverse((o) => {
    if ((o as Mesh).isMesh && (o.userData as Record<string, unknown>)[RIG_PLACEHOLDER]) found.push(o);
  });
  let out = root;
  for (const m of found) {
    const g = swap(m);
    if (m === root) out = g;
  }
  out.updateMatrixWorld(true);
  return out;
}

interface RestTransform {
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

function resetBonesToRest(root: Object3D): void {
  root.traverse((o) => {
    const rest = (o.userData as { rest?: RestTransform }).rest;
    if (!(o as Bone).isBone || !rest) return;
    o.position.fromArray(rest.position);
    o.quaternion.fromArray(rest.quaternion);
    o.scale.set(1, 1, 1);
  });
}

/** Replace each skinned mesh by a plain mesh in the given pose (skin attributes dropped). */
function bakeSkinnedMeshes(root: Object3D, pose: 'current' | 'rest'): void {
  const list: SkinnedMesh[] = [];
  root.traverse((o) => {
    if ((o as SkinnedMesh).isSkinnedMesh) list.push(o as SkinnedMesh);
  });
  if (pose === 'rest') {
    resetBonesToRest(root);
    root.updateMatrixWorld(true);
  }
  for (const sm of list) {
    const src = sm.geometry;
    const g = new BufferGeometry();
    g.setIndex(src.getIndex());
    for (const [name, attr] of Object.entries(src.attributes)) if (name !== 'skinIndex' && name !== 'skinWeight') g.setAttribute(name, attr);
    for (const grp of src.groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
    const posAttr = src.getAttribute('position');
    const nrmAttr = src.getAttribute('normal');
    if (pose === 'current' && sm.skeleton && src.getAttribute('skinIndex') && posAttr) {
      const v = new Vector3(), n = new Vector4();
      const out = new Float32Array(posAttr.count * 3);
      for (let i = 0; i < posAttr.count; i++) sm.applyBoneTransform(i, v.fromBufferAttribute(posAttr, i)).toArray(out, i * 3);
      g.setAttribute('position', new BufferAttribute(out, 3));
      if (nrmAttr) {
        const outN = new Float32Array(nrmAttr.count * 3);
        for (let i = 0; i < nrmAttr.count; i++) {
          n.set(nrmAttr.getX(i), nrmAttr.getY(i), nrmAttr.getZ(i), 0);
          sm.applyBoneTransform(i, n);
          v.set(n.x, n.y, n.z).normalize().toArray(outN, i * 3);
        }
        g.setAttribute('normal', new BufferAttribute(outN, 3));
      }
    }
    const mesh = new MeshClass(g, sm.material);
    mesh.name = sm.name;
    mesh.position.copy(sm.position);
    mesh.quaternion.copy(sm.quaternion);
    mesh.scale.copy(sm.scale);
    mesh.visible = sm.visible;
    mesh.userData = { ...sm.userData };
    for (const c of [...sm.children]) mesh.add(c);
    const parent = sm.parent;
    if (parent) {
      parent.children[parent.children.indexOf(sm)] = mesh;
      mesh.parent = parent;
      sm.parent = null;
    }
  }
  root.updateMatrixWorld(true);
}

/** True when at least one of the clip's tracks resolves to a node under `root`. */
function clipTargetsNodes(clip: AnimationClip, root: Object3D): boolean {
  return clip.tracks.some((t) => {
    const binding = PropertyBinding.parseTrackName(t.name);
    return !!PropertyBinding.findNode(root, binding.nodeName);
  });
}
