import { beforeAll, describe, expect, it } from 'vitest';
import {
  BoxGeometry, BufferAttribute, BufferGeometry, DataTexture, Group, InterleavedBuffer, InterleavedBufferAttribute, Mesh,
  MeshStandardMaterial, RGBAFormat,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { buildGeometryFromDepth } from '../mesh/buildFromDepth';
import { DEFAULT_MESH_OPTIONS } from '../mesh/options';
import { computeMeshStats } from '../mesh/stats';
import type { DepthMap } from '../types';
import {
  bakeWorldTransform, EXPORT_FORMATS, exportFileName, exportObject, flipDataTexture, makeTexturesExportable, writeObjParts,
} from './exporters';

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

  it('OBJ: same text as three\'s OBJExporter (transforms baked, several meshes, missing uv / normal)', async () => {
    const group = new Group();
    group.position.set(1, 2, 3);
    group.scale.set(2, 1, 0.5);
    group.rotation.set(0.3, -0.2, 0.1);
    const a = mesh();
    a.name = 'surface';
    const plain = new BufferGeometry();
    plain.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1]), 3));
    const b = new Mesh(plain, new MeshStandardMaterial({ name: 'm' }));
    b.position.x = 5;
    const withUv = new BoxGeometry(1, 1, 1);
    withUv.deleteAttribute('normal');
    group.add(a, b, new Mesh(withUv));
    const text = await (await exportObject(group, 'obj')).text();
    expect(text).toBe(new OBJExporter().parse(bakeWorldTransform(group)));
    expect(text).toContain('usemtl m\n');
    expect(text).toMatch(/^f \d+ \d+ \d+$/m); // no uv, no normal
    expect(text).toMatch(/^f \d+\/\d+ \d+\/\d+ \d+\/\d+$/m); // uv, no normal
  });

  it('OBJ: large meshes are written in chunks that let the event loop run', async () => {
    const big = buildGeometryFromDepth({ width: 256, height: 256, data: new Float32Array(256 * 256).fill(0.5) }, null,
      { ...DEFAULT_MESH_OPTIONS, mode: 'solid', resolution: 256, smoothing: 0 });
    let ticked = false;
    setTimeout(() => { ticked = true; }, 0);
    const parts = await writeObjParts(new Mesh(big));
    expect(ticked).toBe(true); // the one-string OBJExporter blocked until done
    expect(parts.length).toBeGreaterThan(10);
    const lines = parts.join('').split('\n');
    expect(lines.filter((l) => l.startsWith('f ')).length).toBe(big.getIndex()!.count / 3);
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

  it('PLY: quantized / normalized attributes (KHR_mesh_quantization) are written as floats', async () => {
    const box = new BoxGeometry(1, 1, 1);
    const src = box.getAttribute('position');
    // Normalized Int16 positions interleaved with a padding component (stride 4).
    const ib = new InterleavedBuffer(new Int16Array(src.count * 4), 4);
    for (let i = 0; i < src.count; i++) for (let c = 0; c < 3; c++) ib.array[4 * i + c] = Math.round(src.getComponent(i, c) * 32767);
    const q = new BufferGeometry();
    q.setIndex(box.getIndex());
    q.setAttribute('position', new InterleavedBufferAttribute(ib, 3, 0, true));
    const nrm = box.getAttribute('normal');
    q.setAttribute('normal', new BufferAttribute(Int8Array.from(nrm.array, (v) => Math.round(v * 127)), 3, true));
    const uv = box.getAttribute('uv');
    q.setAttribute('uv', new BufferAttribute(Uint16Array.from(uv.array, (v) => Math.round((0.25 + 0.5 * v) * 65535)), 2, true));
    const m = new Mesh(q, new MeshStandardMaterial());
    const group = new Group();
    group.scale.setScalar(1.7);
    group.add(m);

    const buf = await (await exportObject(group, 'ply')).arrayBuffer();
    const header = new TextDecoder().decode(buf.slice(0, 400));
    expect(header).toContain('property float x');
    expect(header).toContain('property float nx');
    expect(header).toContain('property float s');
    const parsed = new PLYLoader().parse(buf);
    parsed.computeBoundingBox();
    expect(parsed.boundingBox!.min.x).toBeCloseTo(-0.85, 3);
    expect(parsed.boundingBox!.max.y).toBeCloseTo(0.85, 3);
    const n = parsed.getAttribute('normal');
    for (let i = 0; i < n.count; i++) expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 4);
    const us = new Set(Array.from(parsed.getAttribute('uv').array, (v) => v.toFixed(3)));
    expect([...us].sort()).toEqual(['0.250', '0.750']);
    // The source mesh keeps its quantized geometry.
    expect(m.geometry).toBe(q);
    expect(q.getAttribute('position')).toBeInstanceOf(InterleavedBufferAttribute);
    expect(q.getAttribute('position').normalized).toBe(true);
    expect(q.getAttribute('uv').array).toBeInstanceOf(Uint16Array);
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
