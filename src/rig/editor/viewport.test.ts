// @vitest-environment jsdom
/**
 * RigEditorViewport against a fake viewer (jsdom canvas, a real camera):
 * marker picking, interior snapping, IK handles, weight painting into the
 * skinned meshes with the heat map, pose capture / apply.
 */
import { describe, expect, it, vi } from 'vitest';
import { BufferAttribute, PerspectiveCamera, Vector3 } from 'three';
import type { Object3D, SkinnedMesh } from 'three';
import { buildGeometryModel } from '../../app/pipeline';
import { autoPlaceAnimal } from '../autoAnimal';
import { collectMeshData } from '../meshData';
import { rigModel } from '../rig';
import { makeDog } from '../testing';
import { HEAT_ATTRIBUTE } from './heatmap';
import { ikChains, RigEditorViewport, type ViewportCallbacks } from './viewport';

async function setup() {
  const model = buildGeometryModel(makeDog().mesh.geometry, null);
  const data = collectMeshData(model.object);
  const rig = await rigModel(null, model, { spec: autoPlaceAnimal(data, 'quadruped').spec, meshData: data });
  const canvas = document.createElement('canvas');
  canvas.style.touchAction = 'pan-y';
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400, x: 0, y: 0, toJSON: () => ({}) });
  const camera = new PerspectiveCamera(35, 1, 0.01, 100);
  camera.position.set(0, 0, 6);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const overlays = new Set<Object3D>();
  const host = { canvas, camera, setOrbitEnabled: vi.fn(), addOverlay: (o: Object3D) => void overlays.add(o), removeOverlay: (o: Object3D) => void overlays.delete(o), invalidate: vi.fn() };
  const cb: ViewportCallbacks = { onSelect: vi.fn(), onJointMoved: vi.fn(), onPoseEdited: vi.fn(), onAddAt: vi.fn(), onStroke: vi.fn() };
  const vp = new RigEditorViewport(host, rig, cb);
  return { rig, vp, cb, host, overlays, camera };
}

const screen = (p: Vector3, camera: PerspectiveCamera) => {
  const v = p.clone().project(camera);
  return { x: ((v.x + 1) / 2) * 400, y: ((1 - v.y) / 2) * 400 };
};

describe('RigEditorViewport', () => {
  it('picks joints on screen, selects, and snaps a joint into the middle of the mesh', async () => {
    const { rig, vp, cb, camera, overlays, host } = await setup();
    expect(overlays.size).toBe(1);
    const foot = vp.jointWorld('LeftFrontFoot', 'head');
    const s = screen(foot, camera);
    const pick = vp.pickAt(s.x, s.y);
    expect(pick?.kind).toBe('joint');
    vp.select('Chest');
    expect(cb.onSelect).toHaveBeenLastCalledWith('Chest', 'head');
    // A point pushed towards the camera (in front of the torso, between the legs) snaps back to the torso's middle.
    const spine = rig.spec.bones.find((b) => b.name === 'Spine1')!.head;
    const snapped = vp.snapInterior({ x: spine.x, y: spine.y, z: 0.6 })!;
    expect(snapped).not.toBeNull();
    expect(Math.abs(snapped.z)).toBeLessThan(0.05);
    vp.dispose();
    expect(overlays.size).toBe(0);
    expect(host.canvas.style.touchAction).toBe('pan-y'); // the viewer's touch scrolling is back
    rig.dispose();
  }, 30_000);

  it('IK handles move a foot to its target; poses capture and re-apply', async () => {
    const { rig, vp } = await setup();
    vp.setMode('pose');
    const chains = ikChains(rig.spec);
    expect(chains.map((c) => c.key).sort()).toEqual(['leg-front-L', 'leg-front-R', 'leg-hind-L', 'leg-hind-R']);
    const ch = chains.find((c) => c.key === 'leg-front-L')!;
    const target = vp.jointWorld(ch.end, 'head').add(new Vector3(0.12, 0.15, 0));
    vp.solveIk(ch, target);
    expect(vp.jointWorld(ch.end, 'head').distanceTo(target)).toBeLessThan(1e-4);
    const pose = vp.capturePose();
    vp.applyPose({ rot: {}, pos: {} });
    expect(vp.jointWorld(ch.end, 'head').distanceTo(target)).toBeGreaterThan(0.05);
    vp.applyPose(pose);
    expect(vp.jointWorld(ch.end, 'head').distanceTo(target)).toBeLessThan(1e-4);
    vp.dispose();
    rig.dispose();
  }, 30_000);

  it('paints the selected bone into the skinned mesh, shows the heat map and removes it on exit', async () => {
    const { rig, vp } = await setup();
    vp.setMode('paint');
    vp.select('Tail');
    const mesh = rig.meshes[0] as SkinnedMesh;
    expect(mesh.geometry.getAttribute(HEAT_ATTRIBUTE)).toBeTruthy();
    const tailIdx = rig.spec.bones.findIndex((b) => b.name === 'Tail');
    const chest = rig.spec.bones.find((b) => b.name === 'Chest')!.head;
    const weightNear = () => {
      const pos = mesh.geometry.getAttribute('position'), si = mesh.geometry.getAttribute('skinIndex') as BufferAttribute, sw = mesh.geometry.getAttribute('skinWeight') as BufferAttribute;
      let best = -1, bd = Infinity;
      for (let i = 0; i < pos.count; i++) {
        const d = Math.hypot(pos.getX(i) - chest.x, pos.getY(i) - chest.y, pos.getZ(i) - 0.2);
        if (d < bd) (bd = d), (best = i);
      }
      let w = 0;
      for (let k = 0; k < 4; k++) if (si.getComponent(best, k) === tailIdx) w += sw.getComponent(best, k);
      return w;
    };
    expect(weightNear()).toBeLessThan(0.01);
    vp.brush = { mode: 'add', radius: 0.08, strength: 1, falloff: 'constant', value: 1 };
    vp.painter.beginStroke();
    vp.dabAt({ x: chest.x, y: chest.y, z: 0.2 });
    const diff = vp.painter.endStroke();
    expect(diff!.ids.length).toBeGreaterThan(0);
    expect(weightNear()).toBeGreaterThan(0.9);
    vp.setMode('edit');
    expect(mesh.geometry.getAttribute(HEAT_ATTRIBUTE)).toBeUndefined();
    vp.dispose();
    rig.dispose();
  }, 30_000);
});
