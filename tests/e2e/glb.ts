/**
 * Hand-built minimal binary glTF (GLB 2.0) for E2E tests: a unit cube with
 * flat normals, saturated per-face vertex colours (linear, as glTF expects)
 * and outward CCW winding (so the app's mesh stats report it watertight:
 * 8 vertices, 12 triangles).
 */

const FACES: { n: number[]; u: number[]; v: number[]; color: number[] }[] = [
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], color: [0.8, 0.03, 0.04] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], color: [0.03, 0.5, 0.06] },
  { n: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0], color: [0.04, 0.12, 0.85] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], color: [0.9, 0.55, 0.02] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], color: [0.35, 0.05, 0.7] },
  { n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0], color: [0.02, 0.55, 0.6] },
];

function pad4(n: number): number {
  return (n + 3) & ~3;
}

export function buildCubeGlb(): Uint8Array {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (const { n, u, v, color } of FACES) {
    const base = positions.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let k = 0; k < 3; k++) positions.push(n[k] * 0.5 + su * 0.5 * u[k] + sv * 0.5 * v[k]);
      normals.push(...n);
      colors.push(...color);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const pos = new Float32Array(positions);
  const nor = new Float32Array(normals);
  const col = new Float32Array(colors);
  const idx = new Uint16Array(indices);
  const views = [pos, nor, col, idx];
  const offsets: number[] = [];
  let binLength = 0;
  for (const a of views) {
    offsets.push(binLength);
    binLength = pad4(binLength + a.byteLength);
  }
  const bin = new Uint8Array(binLength);
  views.forEach((a, i) => bin.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), offsets[i]));

  const json = {
    asset: { version: '2.0', generator: '3dmarker-e2e' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'cube' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    buffers: [{ byteLength: binLength }],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[1], byteLength: nor.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[2], byteLength: col.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[3], byteLength: idx.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5126, count: nor.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: col.length / 3, type: 'VEC3' },
      { bufferView: 3, componentType: 5123, count: idx.length, type: 'SCALAR' },
    ],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = pad4(jsonBytes.length);
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLength, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength); // pad JSON with spaces
  const binStart = 20 + jsonLength;
  dv.setUint32(binStart, binLength, true);
  dv.setUint32(binStart + 4, 0x004e4942, true); // 'BIN\0'
  out.set(bin, binStart + 8);
  return out;
}
