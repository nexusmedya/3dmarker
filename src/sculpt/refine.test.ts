import { describe, expect, it } from 'vitest';
import { BoxGeometry, BufferAttribute, BufferGeometry } from 'three';
import { computeMeshStats } from '../core/mesh/stats';
import { edgeLengths, refineGeometry } from './refine';
import { gridGeometry } from './testing';

/** Two triangles spanning [-1, 1]² (normal +Z, uv, a colour ramp), with two groups. */
function quad(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setAttribute('color', new BufferAttribute(new Uint8Array([0, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 0]), 3, true));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.addGroup(0, 3, 0);
  g.addGroup(3, 3, 1);
  return g;
}

function area(g: BufferGeometry): number {
  const p = g.getAttribute('position'), idx = g.getIndex()!;
  let a = 0;
  for (let t = 0; t < idx.count; t += 3) {
    const [i, j, k] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
    const ux = p.getX(j) - p.getX(i), uy = p.getY(j) - p.getY(i), uz = p.getZ(j) - p.getZ(i);
    const vx = p.getX(k) - p.getX(i), vy = p.getY(k) - p.getY(i), vz = p.getZ(k) - p.getZ(i);
    a += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return a;
}

describe('refineGeometry', () => {
  it('splits every edge down to the target, in place, keeping area, winding, attributes and groups', () => {
    const g = quad();
    const r = refineGeometry(g, { maxEdge: 0.2 });
    expect(r).not.toBeNull();
    expect(r!.trianglesBefore).toBe(2);
    expect(r!.trianglesAfter).toBe(g.getIndex()!.count / 3);
    expect(r!.trianglesAfter).toBeGreaterThan(100);
    expect(edgeLengths(g).max).toBeLessThanOrEqual(0.2 + 1e-6);
    expect(area(g)).toBeCloseTo(4, 5);
    // Winding: every face normal still points +Z.
    const p = g.getAttribute('position'), idx = g.getIndex()!;
    for (let t = 0; t < idx.count; t += 3) {
      const [i, j, k] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
      const cz = (p.getX(j) - p.getX(i)) * (p.getY(k) - p.getY(i)) - (p.getY(j) - p.getY(i)) * (p.getX(k) - p.getX(i));
      expect(cz).toBeGreaterThan(0);
    }
    // Attributes interpolated linearly (planar uv = (x + 1) / 2, colour ramp in x).
    const uv = g.getAttribute('uv'), col = g.getAttribute('color'), n = g.getAttribute('normal');
    expect(col.normalized).toBe(true);
    for (let v = 0; v < p.count; v++) {
      expect(uv.getX(v)).toBeCloseTo((p.getX(v) + 1) / 2, 5);
      expect(uv.getY(v)).toBeCloseTo((p.getY(v) + 1) / 2, 5);
      expect(n.getZ(v)).toBeCloseTo(1, 5);
      expect(col.getX(v)).toBeCloseTo((p.getX(v) + 1) / 2, 1);
    }
    // Groups cover the triangles in order: first half from triangle 0, rest from triangle 1.
    expect(g.groups).toHaveLength(2);
    expect(g.groups[0].start).toBe(0);
    expect(g.groups[0].start + g.groups[0].count).toBe(g.groups[1].start);
    expect(g.groups[1].start + g.groups[1].count).toBe(idx.count);
    expect(g.groups.map((x) => x.materialIndex)).toEqual([0, 1]);
  });

  it('stays watertight across hard-edge seams (no T-junctions)', () => {
    const box = new BoxGeometry(2, 2, 2); // 24 vertices: split normals / uvs at every edge
    expect(computeMeshStats(box).watertight).toBe(true);
    const r = refineGeometry(box, { maxEdge: 0.3 });
    expect(r).not.toBeNull();
    expect(computeMeshStats(box).watertight).toBe(true);
    expect(edgeLengths(box).max).toBeLessThanOrEqual(0.3 + 1e-6);
  });

  it('respects the triangle budget and leaves fine meshes alone', () => {
    const g = quad();
    const r = refineGeometry(g, { maxEdge: 1e-4, maxTriangles: 5000 });
    expect(r!.trianglesAfter).toBeLessThanOrEqual(5000);
    const fine = gridGeometry(16);
    const pos = fine.getAttribute('position');
    expect(refineGeometry(fine, { maxEdge: 1 })).toBeNull();
    expect(fine.getAttribute('position')).toBe(pos);
  });

  it('refines non-indexed geometry too', () => {
    const g = quad().toNonIndexed();
    const r = refineGeometry(g, { maxEdge: 0.5 });
    expect(r).not.toBeNull();
    expect(g.getIndex()).not.toBeNull();
    expect(edgeLengths(g).max).toBeLessThanOrEqual(0.5 + 1e-6);
    expect(area(g)).toBeCloseTo(4, 5);
  });
});
