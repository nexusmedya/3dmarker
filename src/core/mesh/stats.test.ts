import { describe, expect, it } from 'vitest';
import { BoxGeometry, BufferAttribute, BufferGeometry, PlaneGeometry, SphereGeometry, TorusGeometry } from 'three';
import { computeMeshStats } from './stats';

function withIndex(g: BufferGeometry, edit: (idx: number[]) => number[]): BufferGeometry {
  const out = g.clone();
  out.setIndex(edit(Array.from(g.getIndex()!.array)));
  return out;
}

describe('computeMeshStats', () => {
  it('welds split vertices: a box is 8 vertices, 12 triangles, watertight', () => {
    const box = new BoxGeometry(1, 2, 3);
    expect(box.getAttribute('position').count).toBe(24);
    expect(computeMeshStats(box)).toEqual({ vertices: 8, triangles: 12, watertight: true });
    expect(computeMeshStats(box.toNonIndexed())).toEqual({ vertices: 8, triangles: 12, watertight: true });
  });

  it('accepts closed surfaces with UV seams and pole fans', () => {
    expect(computeMeshStats(new SphereGeometry(1, 24, 16)).watertight).toBe(true);
    expect(computeMeshStats(new TorusGeometry(1, 0.3, 12, 32)).watertight).toBe(true);
  });

  it('rejects open, holed, flipped and non-manifold meshes', () => {
    expect(computeMeshStats(new PlaneGeometry(1, 1, 4, 4)).watertight).toBe(false);
    const box = new BoxGeometry();
    expect(computeMeshStats(withIndex(box, (i) => i.slice(3))).watertight).toBe(false); // one triangle missing
    expect(computeMeshStats(withIndex(box, (i) => [i[0], i[2], i[1], ...i.slice(3)])).watertight).toBe(false); // flipped
    // two tetrahedra sharing an edge: that edge is used four times
    const tet = (o: number) => [0, 2, 1, 0, 1, o, 1, 2, o, 2, 0, o];
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1]), 3));
    g.setIndex([...tet(3), 0, 1, 2, 0, 4, 1, 1, 4, 2, 2, 4, 0]);
    expect(computeMeshStats(g)).toMatchObject({ triangles: 8, watertight: false });
    const single = new BufferGeometry();
    single.setAttribute('position', g.getAttribute('position'));
    single.setIndex(tet(3));
    expect(computeMeshStats(single)).toEqual({ vertices: 4, triangles: 4, watertight: true });
  });

  it('handles empty geometry and NaN positions', () => {
    expect(computeMeshStats(new BufferGeometry())).toEqual({ vertices: 0, triangles: 0, watertight: false });
    const box = new BoxGeometry();
    box.getAttribute('position').setX(0, NaN);
    expect(computeMeshStats(box).watertight).toBe(false);
  });
});
