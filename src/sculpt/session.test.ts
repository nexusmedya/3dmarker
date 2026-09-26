import { describe, expect, it } from 'vitest';
import { Bone, Group, Mesh, MeshBasicMaterial, Ray, Skeleton, SkinnedMesh, Vector3 } from 'three';
import { SculptSession } from './session';
import { fakeHost, gridGeometry } from './testing';

const N = 32;
const Z = new Vector3(0, 0, 1);
const idx = (i: number, j: number) => j * (N + 1) + i;

function setup(opts: ConstructorParameters<typeof SculptSession>[2] = {}) {
  const geometry = gridGeometry(N);
  const mesh = new Mesh(geometry, new MeshBasicMaterial());
  const host = fakeHost();
  const session = new SculptSession(host, mesh, { keyTarget: null, ...opts });
  const pos = () => geometry.getAttribute('position').array as Float32Array;
  const nrm = () => geometry.getAttribute('normal').array as Float32Array;
  return { geometry, mesh, host, session, pos, nrm, z: (i: number, j: number) => pos()[idx(i, j) * 3 + 2] };
}

describe('SculptSession', () => {
  it('finds the meshes, sizes the brush from the bounding sphere and applies a dab', () => {
    const { session, z } = setup({ settings: { radius: 0.2, strength: 1 } });
    expect(session.meshCount).toBe(1);
    expect(session.boundingRadius).toBeCloseTo(Math.SQRT2, 5);
    expect(session.worldRadius()).toBeCloseTo(0.2 * Math.SQRT2, 5);
    expect(session.state).toEqual({ active: false, canUndo: false, canRedo: false, strokes: 0 });
    const moved = session.applyStrokeAt(new Vector3(0, 0, 0), Z);
    expect(moved).toBeGreaterThan(0);
    expect(z(N / 2, N / 2)).toBeGreaterThan(0);
    expect(session.state).toMatchObject({ canUndo: true, canRedo: false, strokes: 1 });
  });

  it('raycasts the mesh (BVH) and reports the surface normal facing the ray', () => {
    const { session } = setup();
    const hit = session.raycast(new Ray(new Vector3(0.1, 0.2, 5), new Vector3(0, 0, -1)));
    expect(hit).not.toBeNull();
    expect(hit!.point.x).toBeCloseTo(0.1, 5);
    expect(hit!.point.z).toBeCloseTo(0, 5);
    expect(hit!.normal.z).toBeCloseTo(1, 5);
    expect(hit!.backFacing).toBe(false);
    const back = session.raycast(new Ray(new Vector3(0.1, 0.2, -5), new Vector3(0, 0, 1)));
    expect(back!.backFacing).toBe(true);
    expect(back!.normal.z).toBeCloseTo(-1, 5);
    expect(session.raycast(new Ray(new Vector3(3, 3, 5), new Vector3(0, 0, -1)))).toBeNull();
  });

  it('a back-face stroke acts towards the viewer on an open surface', () => {
    const { session, z } = setup({ settings: { radius: 0.2, strength: 1 } });
    session.applyStrokeAt(new Vector3(0, 0, 0), new Vector3(0, 0, -1), { backFacing: true });
    expect(z(N / 2, N / 2)).toBeLessThan(0);
  });

  it('undo / redo restore exact positions and normals', () => {
    const { session, pos, nrm } = setup({ settings: { radius: 0.25, strength: 1 } });
    const p0 = pos().slice(), n0 = nrm().slice();
    session.applyStrokeAt(new Vector3(0, 0, 0), Z);
    const p1 = pos().slice(), n1 = nrm().slice();
    session.setSettings({ brush: 'inflate' });
    session.applyStrokeAt(new Vector3(0.3, 0, 0), Z);
    const p2 = pos().slice();
    expect(session.state.strokes).toBe(2);

    expect(session.undo()).toBe(true);
    expect(pos()).toEqual(p1);
    expect(nrm()).toEqual(n1);
    expect(session.undo()).toBe(true);
    expect(pos()).toEqual(p0);
    expect(nrm()).toEqual(n0);
    expect(session.state).toMatchObject({ canUndo: false, canRedo: true, strokes: 0 });
    expect(session.undo()).toBe(false);

    expect(session.redo()).toBe(true);
    expect(session.redo()).toBe(true);
    expect(pos()).toEqual(p2);
    expect(session.state).toMatchObject({ canUndo: true, canRedo: false, strokes: 2 });

    // A new stroke drops the redo branch.
    session.undo();
    session.applyStrokeAt(new Vector3(-0.3, 0, 0), Z);
    expect(session.state.canRedo).toBe(false);
  });

  it('caps the history by stroke count', () => {
    const { session } = setup({ maxHistory: 3, settings: { radius: 0.1 } });
    for (let k = 0; k < 5; k++) session.applyStrokeAt(new Vector3(-0.6 + k * 0.3, 0, 0), Z);
    let undos = 0;
    while (session.undo()) undos++;
    expect(undos).toBe(3);
    expect(session.state.strokes).toBe(2); // the two oldest strokes stay applied
  });

  it('reset restores the original geometry and is undoable', () => {
    const { session, pos, nrm } = setup();
    const p0 = pos().slice(), n0 = nrm().slice();
    session.applyStrokeAt(new Vector3(0, 0, 0), Z);
    session.applyStrokeAt(new Vector3(0.2, 0.1, 0), Z);
    const edited = pos().slice();
    expect(session.reset()).toBe(true);
    expect(pos()).toEqual(p0);
    expect(nrm()).toEqual(n0);
    expect(session.state.strokes).toBe(0);
    expect(session.reset()).toBe(false);
    session.undo();
    expect(pos()).toEqual(edited);
    expect(session.state.strokes).toBe(2);
  });

  it('dabs along a stroke with spacing and skips gaps', () => {
    const { session, z } = setup({ settings: { radius: 0.1, strength: 1 } });
    session.beginStroke(new Vector3(-0.5, 0, 0), Z);
    session.strokeTo(new Vector3(0.5, 0, 0), Z);
    session.endStroke();
    // Every vertex on the path is raised, the ends of the line not beyond the stroke.
    for (let i = N / 4; i <= (3 * N) / 4; i++) expect(z(i, N / 2)).toBeGreaterThan(0);
    expect(z(2, N / 2)).toBe(0);
    expect(session.state.strokes).toBe(1);

    const b = setup({ settings: { radius: 0.05, strength: 1 } });
    b.session.beginStroke(new Vector3(-0.8, 0, 0), Z);
    b.session.strokeGap();
    b.session.strokeTo(new Vector3(0.8, 0, 0), Z);
    b.session.endStroke();
    expect(b.z(N / 2, N / 2)).toBe(0); // nothing painted across the gap
    expect(b.z(Math.round(((0.8 + 1) * N) / 2), N / 2)).toBeGreaterThan(0);
  });

  it('shift smooths and ctrl inverts for one stroke', () => {
    const { session, z } = setup({ settings: { radius: 0.2, strength: 1 } });
    session.applyStrokeAt(new Vector3(0, 0, 0), Z, { invert: true });
    expect(z(N / 2, N / 2)).toBeLessThan(0);
    const dent = z(N / 2, N / 2);
    for (let k = 0; k < 4; k++) session.applyStrokeAt(new Vector3(0, 0, 0), Z, { smooth: true });
    expect(z(N / 2, N / 2)).toBeGreaterThan(dent);
    expect(session.settings.brush).toBe('draw');
  });

  it('mirrors strokes across the model x = 0 plane (in the root frame)', () => {
    const geometry = gridGeometry(N);
    const mesh = new Mesh(geometry, new MeshBasicMaterial());
    const root = new Group();
    root.position.set(3, 0, 0);
    root.add(mesh);
    const session = new SculptSession(fakeHost(), root, { keyTarget: null, settings: { radius: 0.15, symmetryX: true } });
    session.applyStrokeAt(new Vector3(3.5, 0, 0), Z); // local x = 0.5
    const p = geometry.getAttribute('position').array as Float32Array;
    const right = p[idx((3 * N) / 4, N / 2) * 3 + 2], left = p[idx(N / 4, N / 2) * 3 + 2];
    expect(right).toBeGreaterThan(0);
    expect(left).toBeCloseTo(right, 6);
    expect(p[idx(N / 2, N / 2) * 3 + 2]).toBe(0);
  });

  it('grabs along the stroke and mirrors the grab', () => {
    const { session, z, pos } = setup({ settings: { brush: 'grab', radius: 0.2, strength: 1, symmetryX: true } });
    session.beginStroke(new Vector3(0.5, 0, 0), Z);
    session.grabTo(new Vector3(0.5, 0, 0.1));
    session.grabTo(new Vector3(0.5, 0.05, 0.3));
    session.endStroke();
    const r = idx((3 * N) / 4, N / 2), l = idx(N / 4, N / 2);
    expect(z((3 * N) / 4, N / 2)).toBeCloseTo(0.3, 5);
    expect(pos()[r * 3 + 1]).toBeCloseTo(0.05, 5);
    expect(pos()[l * 3 + 2]).toBeCloseTo(0.3, 5);
    expect(pos()[l * 3 + 1]).toBeCloseTo(0.05, 5);
    expect(session.state.strokes).toBe(1);
  });

  it('skips skinned meshes (sculpting is off for rigged models)', () => {
    const skinned = new SkinnedMesh(gridGeometry(4), new MeshBasicMaterial());
    const bone = new Bone();
    skinned.add(bone);
    skinned.bind(new Skeleton([bone]));
    const session = new SculptSession(fakeHost(), skinned, { keyTarget: null });
    expect(session.meshCount).toBe(0);
    expect(session.applyStrokeAt(new Vector3(), Z)).toBe(0);
    expect(session.raycast(new Ray(new Vector3(0, 0, 5), new Vector3(0, 0, -1)))).toBeNull();
    session.dispose();
  });

  it('rebuilds when the geometry is swapped in place (re-mesh) and clears history', () => {
    const { session, mesh } = setup();
    session.applyStrokeAt(new Vector3(0, 0, 0), Z);
    expect(session.state.canUndo).toBe(true);
    const events: string[] = [];
    session.subscribe((e) => events.push(e.type));
    const next = gridGeometry(8);
    mesh.geometry = next;
    expect(session.syncGeometry()).toBe(true);
    expect(session.state).toMatchObject({ canUndo: false, strokes: 0 });
    expect(session.geometries()).toEqual([next]);
    expect(events).toContain('edit');
    expect(session.applyStrokeAt(new Vector3(0, 0, 0), Z)).toBeGreaterThan(0);
  });

  it('dispose keeps the edits and releases the BVH', () => {
    const { session, geometry, pos, host } = setup();
    session.setActive(true);
    expect(host.overlays.size).toBe(1);
    session.applyStrokeAt(new Vector3(0, 0, 0), Z);
    const edited = pos().slice();
    expect(geometry.boundsTree).toBeDefined();
    session.dispose();
    expect(host.overlays.size).toBe(0);
    expect(geometry.boundsTree).toBeUndefined();
    expect(pos()).toEqual(edited);
    expect(session.applyStrokeAt(new Vector3(0, 0, 0), Z)).toBe(0);
    expect(host.orbit.at(-1)).toBe(true);
  });

  it('settings are validated and announced', () => {
    const { session } = setup();
    const seen: unknown[] = [];
    session.subscribe((e) => e.type === 'settings' && seen.push(e.settings));
    session.setSettings({ radius: 5, strength: -1, brush: 'nope' as never });
    expect(session.settings.radius).toBe(0.6);
    expect(session.settings.strength).toBe(0);
    expect(session.settings.brush).toBe('draw');
    session.setSettings({ radius: 0.6 }); // no change → no event
    expect(seen).toHaveLength(1);
  });

  it('keyboard shortcuts while active (brushes, radius, strength, symmetry, undo / redo)', () => {
    const keys = new EventTarget();
    const { session, z } = setup({ keyTarget: keys, settings: { radius: 0.2, strength: 0.5 } });
    const press = (init: Record<string, unknown>) => {
      const e = Object.assign(new Event('keydown', { cancelable: true }), { key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init });
      keys.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(press({ key: '3' })).toBe(false); // inactive: ignored
    session.setActive(true);
    expect(press({ key: '3', code: 'Digit3' })).toBe(true);
    expect(session.settings.brush).toBe('smooth');
    press({ key: '7' });
    expect(session.settings.brush).toBe('grab');
    press({ key: ']', code: 'BracketRight' });
    expect(session.settings.radius).toBeCloseTo(0.23, 3);
    press({ key: '[', code: 'BracketLeft' });
    expect(session.settings.radius).toBeCloseTo(0.2, 3);
    press({ key: '}', code: 'BracketRight', shiftKey: true });
    expect(session.settings.strength).toBeCloseTo(0.55, 5);
    press({ key: 'x', code: 'KeyX' });
    expect(session.settings.symmetryX).toBe(true);

    press({ key: '1' });
    session.applyStrokeAt(new Vector3(0, 0, 0), Z);
    const raised = z(N / 2, N / 2);
    expect(raised).toBeGreaterThan(0);
    expect(press({ key: 'z', code: 'KeyZ', ctrlKey: true })).toBe(true);
    expect(z(N / 2, N / 2)).toBe(0);
    press({ key: 'Z', code: 'KeyZ', metaKey: true, shiftKey: true });
    expect(z(N / 2, N / 2)).toBe(raised);
    press({ key: 'z', code: 'KeyZ', ctrlKey: true });
    press({ key: 'y', code: 'KeyY', ctrlKey: true });
    expect(z(N / 2, N / 2)).toBe(raised);
    session.setActive(false);
    expect(press({ key: '2' })).toBe(false);
  });
});
