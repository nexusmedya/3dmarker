/** Test helpers: small meshes and a fake viewer host for the sculpt session (Node, no WebGL). */
import { BufferAttribute, BufferGeometry, PerspectiveCamera, type Object3D } from 'three';
import type { SculptHost } from './session';

/** Regular grid in the XY plane (normal +Z), `n` × `n` quads spanning [-s, s]², indexed. */
export function gridGeometry(n: number, s = 1, z?: (x: number, y: number) => number): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = -s + (2 * s * i) / n, y = -s + (2 * s * j) / n;
      pos.push(x, y, z ? z(x, y) : 0);
      nrm.push(0, 0, 1);
      uv.push(i / n, j / n);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  if (z) g.computeVertexNormals();
  return g;
}

export interface FakeHost extends SculptHost {
  invalidations: number;
  orbit: boolean[];
  overlays: Set<Object3D>;
}

/** A host with a camera looking down -Z from z = 5 and an EventTarget canvas (no rendering). */
export function fakeHost(canvas?: HTMLCanvasElement): FakeHost {
  const camera = new PerspectiveCamera(35, 1, 0.01, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const el =
    canvas ??
    (Object.assign(new EventTarget(), {
      style: { cursor: '' },
      parentElement: null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0 }),
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      hasPointerCapture: () => false,
    }) as unknown as HTMLCanvasElement);
  const host: FakeHost = {
    canvas: el,
    camera,
    invalidations: 0,
    orbit: [],
    overlays: new Set(),
    invalidate() {
      host.invalidations++;
    },
    setOrbitEnabled(v: boolean) {
      host.orbit.push(v);
    },
    addOverlay(o: Object3D) {
      host.overlays.add(o);
    },
    removeOverlay(o: Object3D) {
      host.overlays.delete(o);
    },
  };
  return host;
}

/** Sum over vertices of |p - mean(neighbours)|² (discrete Laplacian energy) on a grid geometry's z. */
export function gridLaplacianEnergy(g: BufferGeometry, n: number): number {
  const p = g.getAttribute('position').array as Float32Array;
  let e = 0;
  for (let j = 1; j < n; j++) {
    for (let i = 1; i < n; i++) {
      const k = j * (n + 1) + i;
      const avg = (p[(k - 1) * 3 + 2] + p[(k + 1) * 3 + 2] + p[(k - n - 1) * 3 + 2] + p[(k + n + 1) * 3 + 2]) / 4;
      e += (p[k * 3 + 2] - avg) ** 2;
    }
  }
  return e;
}
