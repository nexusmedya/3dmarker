import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, InterleavedBuffer, InterleavedBufferAttribute, Ray, SphereGeometry, Vector3 } from 'three';
import { SculptMesh } from './sculptMesh';
import { applyDab, applyGrab, BRUSH_TUNING, captureGrab, DabScratch, type Dab } from './brushes';
import { gridGeometry, gridLaplacianEnergy } from './testing';

const N = 32; // grid quads per side: vertex spacing 2 / 32
const Z = new Vector3(0, 0, 1);

function dab(over: Partial<Dab> = {}): Dab {
  return {
    brush: 'draw',
    center: new Vector3(0, 0, 0),
    normal: Z.clone(),
    radius: 0.4,
    strength: 1,
    invert: false,
    falloff: 'smooth',
    lockBoundary: true,
    ...over,
  };
}

const zAt = (m: SculptMesh, i: number, j: number) => m.pos[(j * (N + 1) + i) * 3 + 2];
const idx = (i: number, j: number) => j * (N + 1) + i;

describe('SculptMesh', () => {
  it('never touches the index or the other attributes', () => {
    const g = gridGeometry(N);
    const index = g.getIndex()!.array.slice();
    const uv = (g.getAttribute('uv').array as Float32Array).slice();
    const m = new SculptMesh(g);
    applyDab(m, dab());
    expect(Array.from(g.getIndex()!.array)).toEqual(Array.from(index));
    expect(Array.from(g.getAttribute('uv').array as Float32Array)).toEqual(Array.from(uv));
    expect(g.getAttribute('position').count).toBe((N + 1) ** 2);
    expect(g.boundsTree).toBe(m.bvh);
    m.dispose();
    expect(g.boundsTree).toBeUndefined();
  });

  it('gathers exactly the welded vertices inside the sphere', () => {
    const m = new SculptMesh(gridGeometry(N));
    const s = new DabScratch();
    m.gather(new Vector3(0, 0, 0), 0.3, s.gathered);
    let expected = 0;
    for (let j = 0; j <= N; j++)
      for (let i = 0; i <= N; i++) {
        const x = -1 + (2 * i) / N, y = -1 + (2 * j) / N;
        if (Math.hypot(x, y) < 0.3) expected++;
      }
    expect(s.gathered.count).toBe(expected);
    expect(s.gathered.nodes.size).toBeGreaterThan(0);
    for (let k = 0; k < s.gathered.count; k++) expect(s.gathered.t[k]).toBeLessThan(1);
  });
});

describe('brushes', () => {
  it('draw raises the surface under the brush along its normal, invert carves', () => {
    const m = new SculptMesh(gridGeometry(N));
    const moved = applyDab(m, dab());
    expect(moved).toBeGreaterThan(0);
    const c = zAt(m, N / 2, N / 2);
    expect(c).toBeGreaterThan(0);
    expect(c).toBeCloseTo(BRUSH_TUNING.draw * 0.4, 5); // draw · r · strength · w(0)
    expect(zAt(m, 0, 0)).toBe(0); // outside the brush
    expect(zAt(m, N / 2 + 8, N / 2)).toBe(0); // 0.5 away > r
    // x / y untouched by draw on a flat plane.
    expect(m.pos[idx(N / 2, N / 2) * 3]).toBe(0);
    const m2 = new SculptMesh(gridGeometry(N));
    applyDab(m2, dab({ invert: true }));
    expect(zAt(m2, N / 2, N / 2)).toBeLessThan(0);
  });

  it('keeps the BVH in sync: a ray finds the raised surface', () => {
    const m = new SculptMesh(gridGeometry(N));
    for (let k = 0; k < 20; k++) applyDab(m, dab({ radius: 0.3 }));
    const top = zAt(m, N / 2, N / 2);
    expect(top).toBeGreaterThan(0.1);
    const hit = m.bvh.raycastFirst(new Ray(new Vector3(0.001, 0.001, 5), new Vector3(0, 0, -1)), 2);
    expect(hit).not.toBeNull();
    expect(hit!.point.z).toBeCloseTo(top, 2);
  });

  it('updates normals on the flanks of a bump and leaves far normals alone', () => {
    const m = new SculptMesh(gridGeometry(N));
    for (let k = 0; k < 10; k++) applyDab(m, dab({ radius: 0.4 }));
    const flank = idx(N / 2 + 4, N / 2) * 3; // x = 0.25
    expect(m.nrm[flank]).toBeGreaterThan(0.05); // tilts towards +x (downhill)
    const far = idx(2, 2) * 3;
    expect([m.nrm[far], m.nrm[far + 1], m.nrm[far + 2]]).toEqual([0, 0, 1]);
    const len = Math.hypot(m.nrm[flank], m.nrm[flank + 1], m.nrm[flank + 2]);
    expect(len).toBeCloseTo(1, 5);
  });

  it('smooth reduces the Laplacian energy of a noisy surface', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.05;
    const g = gridGeometry(N, 1, () => rnd());
    const m = new SculptMesh(g);
    const before = gridLaplacianEnergy(g, N);
    for (let k = 0; k < 5; k++) applyDab(m, dab({ brush: 'smooth', radius: 1.6, strength: 1, falloff: 'constant' }));
    const after = gridLaplacianEnergy(g, N);
    expect(after).toBeLessThan(before * 0.5);
  });

  it('flatten reduces the height variance under the brush', () => {
    const g = gridGeometry(N, 1, (x, y) => 0.1 * Math.sin(x * 9) * Math.cos(y * 7));
    const m = new SculptMesh(g);
    const inside: number[] = [];
    for (let j = 0; j <= N; j++)
      for (let i = 0; i <= N; i++) if (Math.hypot(-1 + (2 * i) / N, -1 + (2 * j) / N) < 0.2) inside.push(idx(i, j));
    const variance = () => {
      const z = inside.map((v) => m.pos[v * 3 + 2]);
      const mean = z.reduce((a, b) => a + b, 0) / z.length;
      return z.reduce((a, b) => a + (b - mean) ** 2, 0) / z.length;
    };
    const before = variance();
    for (let k = 0; k < 4; k++) applyDab(m, dab({ brush: 'flatten', radius: 0.5, strength: 1 }));
    expect(variance()).toBeLessThan(before * 0.3);
  });

  it('pinch pulls vertices towards the brush centre (invert pushes away)', () => {
    const mean = (m: SculptMesh) => {
      let s = 0, c = 0;
      for (let v = 0; v < m.topo.vertexCount; v++) {
        const d = Math.hypot(m.pos[v * 3], m.pos[v * 3 + 1]);
        if (d < 0.35 && d > 0) {
          s += d;
          c++;
        }
      }
      return s / c;
    };
    const m = new SculptMesh(gridGeometry(N));
    const before = mean(m);
    applyDab(m, dab({ brush: 'pinch', radius: 0.5 }));
    expect(mean(m)).toBeLessThan(before);
    const m2 = new SculptMesh(gridGeometry(N));
    applyDab(m2, dab({ brush: 'pinch', radius: 0.5, invert: true }));
    expect(mean(m2)).toBeGreaterThan(before);
  });

  it('crease carves a sharp groove, clay raises low areas first', () => {
    const m = new SculptMesh(gridGeometry(N));
    applyDab(m, dab({ brush: 'crease' }));
    expect(zAt(m, N / 2, N / 2)).toBeLessThan(0);

    // Clay on a surface with a dip: the dip rises, the surrounding plateau stays below the plane offset.
    const g = gridGeometry(N, 1, (x, y) => (Math.hypot(x, y) < 0.1 ? -0.05 : 0));
    const c = new SculptMesh(g);
    const dip = zAt(c, N / 2, N / 2);
    applyDab(c, dab({ brush: 'clay', radius: 0.5 }));
    expect(zAt(c, N / 2, N / 2)).toBeGreaterThan(dip);
  });

  it('inflate grows a sphere along its normals', () => {
    const g = new SphereGeometry(1, 24, 16);
    const m = new SculptMesh(g);
    applyDab(m, dab({ brush: 'inflate', center: new Vector3(0, 0, 1), radius: 0.5 }));
    let maxR = 0;
    for (let v = 0; v < m.topo.vertexCount; v++) maxR = Math.max(maxR, Math.hypot(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]));
    expect(maxR).toBeGreaterThan(1.01);
  });

  it('keeps welded seam copies together (sphere UV seam)', () => {
    const g = new SphereGeometry(1, 16, 12);
    const m = new SculptMesh(g);
    // three's sphere seam (u = 0 / u = 1) lies at x < 0, z = 0.
    for (let k = 0; k < 5; k++) applyDab(m, dab({ center: new Vector3(-1, 0, 0), normal: new Vector3(-1, 0, 0), radius: 0.6 }));
    const { gStart, gVerts, groupCount } = m.topo;
    let movedSeam = false;
    for (let gi = 0; gi < groupCount; gi++) {
      const a = gVerts[gStart[gi]];
      for (let k = gStart[gi] + 1; k < gStart[gi + 1]; k++) {
        const b = gVerts[k];
        // Members move together (they may differ by float noise from the original generator).
        for (let c = 0; c < 3; c++) expect(Math.abs(m.pos[b * 3 + c] - m.pos[a * 3 + c])).toBeLessThan(1e-6);
      }
      if (gStart[gi + 1] - gStart[gi] === 2 && Math.hypot(m.pos[a * 3], m.pos[a * 3 + 1], m.pos[a * 3 + 2]) > 1.001) movedSeam = true;
    }
    expect(movedSeam).toBe(true);
    // Seam normals stay shared (one class) and unit length.
    const seam = m.topo.gid[17 * 6];
    const [a, b] = [gVerts[gStart[seam]], gVerts[gStart[seam] + 1]];
    for (let c = 0; c < 3; c++) expect(m.nrm[a * 3 + c] === m.nrm[b * 3 + c]).toBe(true);
  });

  it('lock boundary keeps the open rim fixed', () => {
    const edge = (m: SculptMesh) => [zAt(m, 0, N / 2), zAt(m, 1, N / 2)];
    const locked = new SculptMesh(gridGeometry(N));
    applyDab(locked, dab({ center: new Vector3(-1, 0, 0), radius: 0.5 }));
    const [rim, inner] = edge(locked);
    expect(rim).toBe(0);
    expect(inner).toBeGreaterThan(0);
    const free = new SculptMesh(gridGeometry(N));
    applyDab(free, dab({ center: new Vector3(-1, 0, 0), radius: 0.5, lockBoundary: false }));
    expect(edge(free)[0]).toBeGreaterThan(0);
  });

  it('ignores the far side of a thin shell (front faces only)', () => {
    // Two parallel sheets 0.02 apart; the back one faces -Z.
    const front = gridGeometry(8, 1);
    const m = new SculptMesh(front);
    const nrm = m.nrm;
    // Flip half of the normals (as if they were a back sheet): they must not move.
    for (let v = 0; v < m.topo.vertexCount; v++) if (v % 2) nrm[v * 3 + 2] = -1;
    applyDab(m, dab({ radius: 0.9 }));
    const c = idx8(4, 4);
    expect(m.pos[c * 3 + 2]).toBeGreaterThan(0);
    expect(m.pos[(c + 1) * 3 + 2]).toBe(0);
  });

  it('grab drags the captured vertices by the weighted delta', () => {
    const m = new SculptMesh(gridGeometry(N));
    const cap = captureGrab(m, { center: new Vector3(0, 0, 0), normal: Z, radius: 0.4, falloff: 'smooth', lockBoundary: true, strength: 1 });
    expect(cap.groups.length).toBeGreaterThan(0);
    applyGrab(cap, 0, 0, 0.2);
    expect(zAt(m, N / 2, N / 2)).toBeCloseTo(0.2, 6);
    applyGrab(cap, 0, 0, 0.1);
    expect(zAt(m, N / 2, N / 2)).toBeCloseTo(0.3, 6);
    expect(zAt(m, 0, 0)).toBe(0);
    const hit = m.bvh.raycastFirst(new Ray(new Vector3(0.001, 0.001, 5), new Vector3(0, 0, -1)), 2);
    expect(hit!.point.z).toBeCloseTo(0.3, 2);
  });
});

const idx8 = (i: number, j: number) => j * 9 + i;

describe('geometry layouts', () => {
  it('sculpts triangle soup (no index) without opening cracks', () => {
    const g = new SphereGeometry(1, 16, 12).toNonIndexed();
    const m = new SculptMesh(g);
    expect(g.getIndex()).toBeNull();
    for (let k = 0; k < 4; k++) applyDab(m, dab({ center: new Vector3(0, 0, 1), radius: 0.7 }));
    const { gStart, gVerts, groupCount } = m.topo;
    let moved = 0;
    for (let gi = 0; gi < groupCount; gi++) {
      const a = gVerts[gStart[gi]];
      if (Math.hypot(m.pos[a * 3], m.pos[a * 3 + 1], m.pos[a * 3 + 2]) > 1.001) moved++;
      for (let k = gStart[gi] + 1; k < gStart[gi + 1]; k++)
        for (let c = 0; c < 3; c++) expect(Math.abs(m.pos[gVerts[k] * 3 + c] - m.pos[a * 3 + c])).toBeLessThan(1e-6);
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('copies interleaved / quantised attributes out once and keeps their values', () => {
    const src = gridGeometry(8);
    const p = src.getAttribute('position').array as Float32Array;
    const n = src.getAttribute('normal').array as Float32Array;
    const inter = new Float32Array(p.length * 2);
    for (let v = 0; v < p.length / 3; v++) inter.set([p[v * 3], p[v * 3 + 1], p[v * 3 + 2], n[v * 3], n[v * 3 + 1], n[v * 3 + 2]], v * 6);
    const buf = new InterleavedBuffer(inter, 6);
    const g = new BufferGeometry();
    g.setAttribute('position', new InterleavedBufferAttribute(buf, 3, 0));
    // Quantised normals (normalised int8, like KHR_mesh_quantization).
    const q = new Int8Array(n.length);
    for (let i = 0; i < n.length; i++) q[i] = Math.round(n[i] * 127);
    g.setAttribute('normal', new BufferAttribute(q, 3, true));
    g.setIndex(src.getIndex());
    const m = new SculptMesh(g);
    expect(g.getAttribute('position')).toBeInstanceOf(BufferAttribute);
    expect(Array.from(m.pos)).toEqual(Array.from(p));
    expect(m.nrm[2]).toBeCloseTo(1, 6);
    expect(applyDab(m, dab({ radius: 0.6 }))).toBeGreaterThan(0);
  });
});
