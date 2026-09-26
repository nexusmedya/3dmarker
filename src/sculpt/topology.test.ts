import { describe, expect, it } from 'vitest';
import { BoxGeometry, SphereGeometry } from 'three';
import { buildTopology } from './topology';
import { falloffWeight, FALLOFFS } from './falloff';
import { gridGeometry } from './testing';

const topoOf = (g: import('three').BufferGeometry) =>
  buildTopology(
    g.getAttribute('position').array,
    g.getIndex()?.array ?? null,
    (g.getAttribute('normal')?.array as ArrayLike<number> | undefined) ?? null,
  );

describe('falloff', () => {
  it('is 1 at the centre, 0 at the rim and never increases', () => {
    for (const f of FALLOFFS) {
      expect(falloffWeight(f, 0)).toBe(1);
      expect(falloffWeight(f, 1)).toBe(0);
      expect(falloffWeight(f, 1.5)).toBe(0);
      expect(falloffWeight(f, Number.NaN)).toBe(0);
      let prev = 1;
      for (let t = 0; t < 1; t += 0.05) {
        const w = falloffWeight(f, t);
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(prev + 1e-12);
        prev = w;
      }
    }
  });

  it('has the expected shapes', () => {
    expect(falloffWeight('linear', 0.5)).toBeCloseTo(0.5);
    expect(falloffWeight('sharp', 0.5)).toBeCloseTo(0.25);
    expect(falloffWeight('smooth', 0.5)).toBeCloseTo(0.5);
    expect(falloffWeight('sphere', 0.6)).toBeCloseTo(0.8);
    expect(falloffWeight('constant', 0.99)).toBe(1);
    // Smooth has a flat centre and a soft rim.
    expect(falloffWeight('smooth', 0.1)).toBeGreaterThan(falloffWeight('linear', 0.1));
    expect(falloffWeight('smooth', 0.9)).toBeLessThan(falloffWeight('linear', 0.9));
  });
});

describe('buildTopology', () => {
  it('welds the duplicated seam and pole vertices of a UV sphere', () => {
    const g = new SphereGeometry(1, 16, 12);
    const t = topoOf(g);
    expect(t.vertexCount).toBe(17 * 13);
    expect(t.groupCount).toBe(16 * 11 + 2); // one seam column + 2 × 17 pole copies merged
    // Closed after welding: no open edges.
    expect(Array.from(t.boundary).some((b) => b)).toBe(false);
    // Seam copies (u = 0 and u = 1) share a group; a pole group has 17 members.
    expect(t.gid[1 * 17 + 0]).toBe(t.gid[1 * 17 + 16]);
    const poleGroup = t.gid[0];
    expect(t.gStart[poleGroup + 1] - t.gStart[poleGroup]).toBe(17);
    // A pole is adjacent to the 16 ring vertices.
    expect(t.adjStart[poleGroup + 1] - t.adjStart[poleGroup]).toBe(16);
    // Seam copies have equal normals → one normal class.
    const seam = t.gid[17];
    expect(t.gClass[seam + 1] - t.gClass[seam]).toBe(1);
  });

  it('flags the border of an open grid and builds 4-8 neighbour adjacency', () => {
    const n = 4;
    const t = topoOf(gridGeometry(n));
    expect(t.groupCount).toBe(25);
    let border = 0;
    for (let g = 0; g < t.groupCount; g++) if (t.boundary[g]) border++;
    expect(border).toBe(16);
    const centre = t.gid[2 * 5 + 2];
    expect(t.boundary[centre]).toBe(0);
    expect(t.adjStart[centre + 1] - t.adjStart[centre]).toBe(6); // two diagonals per quad row
    expect(t.triCount).toBe(n * n * 2);
    // Each vertex lists the triangles that use it.
    expect(t.vtStart[t.vertexCount]).toBe(t.triCount * 3);
  });

  it('keeps hard edges apart: box corners weld but keep 3 normal classes', () => {
    const t = topoOf(new BoxGeometry(1, 1, 1));
    expect(t.vertexCount).toBe(24);
    expect(t.groupCount).toBe(8);
    for (let g = 0; g < 8; g++) {
      expect(t.gStart[g + 1] - t.gStart[g]).toBe(3);
      expect(t.gClass[g + 1] - t.gClass[g]).toBe(3);
    }
    expect(Array.from(t.boundary).some((b) => b)).toBe(false);
  });

  it('works without an index (triangle soup) and without normals', () => {
    const g = new BoxGeometry(1, 1, 1).toNonIndexed();
    const t = buildTopology(g.getAttribute('position').array, null, null);
    expect(t.vertexCount).toBe(36);
    expect(t.groupCount).toBe(8);
    expect(t.classCount).toBe(8); // no normals: one class per group
    expect(Array.from(t.boundary).some((b) => b)).toBe(false);
  });
});
