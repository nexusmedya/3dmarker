import { describe, expect, it } from 'vitest';
import { mirrorPosition, pickJoint } from './jointEditor';

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
