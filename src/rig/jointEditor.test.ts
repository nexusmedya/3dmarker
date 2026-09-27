import { describe, expect, it, vi } from 'vitest';
import { Object3D, PerspectiveCamera, Vector3 } from 'three';
import { JointEditor, mirrorPosition, pickJoint } from './jointEditor';
import type { JointLayout } from './types';

describe('joint editor picking', () => {
  const joints = [
    { bone: 'LeftArm' as const, x: 100, y: 100, depth: 0.5 },
    { bone: 'LeftForeArm' as const, x: 140, y: 100, depth: 0.5 },
    { bone: 'RightArm' as const, x: 101, y: 101, depth: 0.2 },
  ];

  it('picks the nearest joint within the radius', () => {
    expect(pickJoint(joints, 138, 104, 14)).toBe('LeftForeArm');
    expect(pickJoint(joints, 200, 200, 14)).toBe(null);
  });

  it('prefers the joint nearer to the camera when two overlap on screen', () => {
    expect(pickJoint(joints, 100, 100, 14)).toBe('RightArm');
  });

  it('mirrors about the hips plane', () => {
    expect(mirrorPosition({ x: 0.5, y: 1, z: 0.2 }, 0.1)).toEqual({ x: -0.3, y: 1, z: 0.2 });
  });
});

describe('joint editor dragging', () => {
  const setup = (clamp?: (b: string, p: { x: number; y: number; z: number }) => { x: number; y: number; z: number }) => {
    const canvas = Object.assign(new EventTarget(), {
      style: { cursor: '' },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }),
      setPointerCapture() {},
      releasePointerCapture() {},
    });
    const camera = new PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 3);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const layout: JointLayout = { Hips: { x: 0, y: 0, z: 0 }, LeftForeArm: { x: 0.5, y: 0.5, z: 0 }, RightForeArm: { x: -0.5, y: 0.5, z: 0 } };
    const onCommit = vi.fn();
    const editor = new JointEditor(
      { canvas: canvas as unknown as HTMLCanvasElement, camera, setOrbitEnabled: () => {}, addOverlay: () => {}, removeOverlay: () => {}, invalidate: () => {} },
      { root: new Object3D(), layout, mirror: () => true, onSelect: () => {}, onCommit, clamp: clamp as never },
    );
    const at = new Vector3(0.5, 0.5, 0).project(camera);
    const sx = ((at.x + 1) / 2) * 400, sy = ((1 - at.y) / 2) * 400;
    const fire = (type: string, x: number, y: number) =>
      canvas.dispatchEvent(Object.assign(new Event(type), { button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, clientX: x, clientY: y }));
    return { editor, onCommit, sx, sy, fire };
  };

  it('a press that slips a pixel or two is a click, not a move (no re-weight)', () => {
    const { editor, onCommit, sx, sy, fire } = setup();
    fire('pointerdown', sx, sy);
    fire('pointermove', sx + 1, sy + 1);
    fire('pointerup', sx + 1, sy + 1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(editor.selection).toBe('LeftForeArm');
    editor.dispose();
  });

  it('a drag commits the joint and its mirror twin through the clamp', () => {
    const clamp = vi.fn((_b: string, p: { x: number; y: number; z: number }) => ({ ...p, y: 0.5 }));
    const { editor, onCommit, sx, sy, fire } = setup(clamp);
    fire('pointerdown', sx, sy);
    fire('pointermove', sx + 10, sy - 40);
    fire('pointerup', sx + 10, sy - 40);
    expect(onCommit).toHaveBeenCalledTimes(1);
    const patch = onCommit.mock.calls[0][0] as JointLayout;
    expect(clamp).toHaveBeenCalledTimes(2);
    expect(patch.LeftForeArm!.y).toBe(0.5);
    expect(patch.LeftForeArm!.x).toBeGreaterThan(0.52);
    expect(patch.RightForeArm!.x).toBeCloseTo(-patch.LeftForeArm!.x, 6);
    editor.dispose();
  });
});
