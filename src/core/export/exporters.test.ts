import { beforeAll, describe, expect, it } from 'vitest';
import { DataTexture, Group, Mesh, MeshStandardMaterial, RGBAFormat } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { buildGeometryFromDepth } from '../mesh/buildFromDepth';
import { DEFAULT_MESH_OPTIONS } from '../mesh/options';
import { computeMeshStats } from '../mesh/stats';
import type { DepthMap } from '../types';
import { EXPORT_FORMATS, exportFileName, exportObject, flipDataTexture, makeTexturesExportable } from './exporters';

const S = 24;
const depth: DepthMap = { width: S, height: S, data: new Float32Array(S * S).fill(0.5) };
const geometry = buildGeometryFromDepth(depth, null, { ...DEFAULT_MESH_OPTIONS, mode: 'solid', resolution: 16, smoothing: 0 });
const TRIS = geometry.getIndex()!.count / 3;
const VERTS = geometry.getAttribute('position').count;
const mesh = () => new Mesh(geometry, new MeshStandardMaterial({ color: 0xcccccc }));

// GLTFExporter reads its Blob parts back with FileReader, which Node lacks.
beforeAll(() => {
  if (typeof globalThis.FileReader !== 'undefined') return;
  class NodeFileReader {
    result: ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob) {
      void blob.arrayBuffer().then((b) => { this.result = b; this.onloadend?.(); });
    }
  }
  (globalThis as unknown as { FileReader: unknown }).FileReader = NodeFileReader;
});

describe('EXPORT_FORMATS / exportFileName', () => {
  it('lists the four formats with extension and mime', () => {
    expect(EXPORT_FORMATS.map((f) => f.format)).toEqual(['glb', 'obj', 'stl', 'ply']);
    for (const f of EXPORT_FORMATS) expect(f.label && f.mime && f.ext && f.description.tr && f.description.en).toBeTruthy();
  });
  it('replaces the extension and sanitises the name', () => {
    expect(exportFileName('photo.final.png', 'glb')).toBe('photo.final.glb');
    expect(exportFileName('a/b:c.png', 'stl')).toBe('a_b_c.stl');
    expect(exportFileName('', 'obj')).toBe('3dmarker-model.obj');
  });
});

describe('exportObject', () => {
  it('STL: binary, one facet per triangle, world transform baked', async () => {
    const group = new Group();
    group.position.set(10, 0, 0);
    group.add(mesh());
    const blob = await exportObject(group.children[0], 'stl');
    const buf = await blob.arrayBuffer();
    expect(buf.byteLength).toBe(84 + 50 * TRIS);
    expect(new DataView(buf).getUint32(80, true)).toBe(TRIS);
    const parsed = new STLLoader().parse(buf);
    parsed.computeBoundingBox();
    expect(parsed.boundingBox!.min.x).toBeCloseTo(9, 5);
    expect(parsed.boundingBox!.max.x).toBeCloseTo(11, 5);
    expect(computeMeshStats(parsed).watertight).toBe(true);
    expect(group.children[0].parent).toBe(group); // original untouched
  });

  it('STL: optional uniform scale (e.g. to millimetres)', async () => {
    const buf = await (await exportObject(mesh(), 'stl', { scale: 50 })).arrayBuffer();
    const parsed = new STLLoader().parse(buf);
    parsed.computeBoundingBox();
    expect(parsed.boundingBox!.max.x - parsed.boundingBox!.min.x).toBeCloseTo(100, 3);
  });

  it('OBJ: vertices, UVs, normals and faces', async () => {
    const text = await (await exportObject(mesh(), 'obj')).text();
    const count = (prefix: string) => text.split('\n').filter((l) => l.startsWith(prefix)).length;
    expect(count('v ')).toBe(VERTS);
    expect(count('vt ')).toBe(VERTS);
    expect(count('vn ')).toBe(VERTS);
    expect(count('f ')).toBe(TRIS);
  });

  it('PLY: binary little-endian with the full index', async () => {
    const buf = await (await exportObject(mesh(), 'ply')).arrayBuffer();
    const header = new TextDecoder().decode(buf.slice(0, 300));
    expect(header).toContain('format binary_little_endian 1.0');
    expect(header).toContain(`element vertex ${VERTS}`);
    expect(header).toContain(`element face ${TRIS}`);
    const parsed = new PLYLoader().parse(buf);
    expect(parsed.getIndex()!.count).toBe(TRIS * 3);
    expect(parsed.getAttribute('uv').count).toBe(VERTS);
  });

  it('GLB: valid container that loads back with the same mesh (no texture: canvas needed)', async () => {
    const blob = await exportObject(mesh(), 'glb');
    expect(blob.type).toBe('model/gltf-binary');
    const buf = await blob.arrayBuffer();
    const view = new DataView(buf);
    expect(view.getUint32(0, true)).toBe(0x46546c67); // 'glTF'
    expect(view.getUint32(4, true)).toBe(2);
    expect(view.getUint32(8, true)).toBe(buf.byteLength);
    const gltf = await new GLTFLoader().parseAsync(buf, '');
    let loaded: Mesh | undefined;
    gltf.scene.traverse((o) => { if ((o as Mesh).isMesh) loaded = o as Mesh; });
    expect(loaded!.geometry.getIndex()!.count).toBe(TRIS * 3);
    expect(computeMeshStats(loaded!.geometry).watertight).toBe(true);
  });
});

describe('DataTexture handling for GLB', () => {
  const tex = () => {
    const data = new Uint8Array(2 * 3 * 4);
    for (let y = 0; y < 3; y++) data.fill(y + 1, y * 8, y * 8 + 8); // row y filled with y+1
    const t = new DataTexture(data, 2, 3, RGBAFormat);
    t.flipY = true;
    return t;
  };

  it('flipDataTexture reverses rows and clears flipY without touching the original', () => {
    const t = tex();
    const f = flipDataTexture(t);
    expect(f.flipY).toBe(false);
    expect(Array.from(f.image.data!.filter((_, i) => i % 8 === 0))).toEqual([3, 2, 1]);
    expect(Array.from(t.image.data!.filter((_, i) => i % 8 === 0))).toEqual([1, 2, 3]);
    expect(t.flipY).toBe(true);
  });

  it('makeTexturesExportable swaps flipY DataTextures on cloned materials only', () => {
    const t = tex();
    const mat = new MeshStandardMaterial({ map: t });
    const m = new Mesh(geometry, mat);
    const root = m.clone();
    makeTexturesExportable(root);
    const out = (root as Mesh).material as MeshStandardMaterial;
    expect(out).not.toBe(mat);
    expect(out.map).not.toBe(t);
    expect(out.map!.flipY).toBe(false);
    expect(mat.map).toBe(t);
    expect(m.material).toBe(mat);
  });
});
