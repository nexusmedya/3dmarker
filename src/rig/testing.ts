/**
 * Test fixtures (pure): a procedural T-pose mannequin made of capsules in the
 * shared frame (2 units tall, feet at y = -1, facing +Z, the subject's left
 * arm towards +X), its true joint positions, and fake BlazePose landmarks of
 * it seen from the front.
 */
import { BoxGeometry, BufferGeometry, CapsuleGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Mask } from '../core/types';
import { POSE, type Landmark, type PoseResult } from '../core/human/types';
import type { CoreBone, JointLayout } from './types';

export interface Mannequin {
  mesh: Mesh;
  /** Ground-truth joint positions. */
  joints: Record<CoreBone, { x: number; y: number; z: number }>;
}

/** `detail` scales the tessellation (1 ≈ 6k vertices, 5 ≈ 110k). */
export function makeMannequin(detail = 1): Mannequin {
  const seg = (n: number) => Math.max(3, Math.round(n * detail));
  const parts: BufferGeometry[] = [];
  const capsule = (r: number, len: number, x: number, y: number, z: number, alongX = false, scaleZ = 1) => {
    const g = new CapsuleGeometry(r, len, seg(6), seg(16), seg(len * 10));
    if (scaleZ !== 1) g.scale(1, 1, scaleZ);
    if (alongX) g.rotateZ(Math.PI / 2);
    g.translate(x, y, z);
    parts.push(g);
  };
  const head = new SphereGeometry(0.12, seg(24), seg(16));
  head.translate(0, 0.88, 0);
  parts.push(head);
  capsule(0.05, 0.12, 0, 0.72, 0); // neck
  capsule(0.16, 0.5, 0, 0.36, 0, false, 0.65); // torso -0.05 .. 0.77
  capsule(0.045, 0.72, 0.52, 0.62, 0, true); // left arm 0.115 .. 0.925
  capsule(0.045, 0.72, -0.52, 0.62, 0, true); // right arm
  capsule(0.065, 0.9, 0.1, -0.47, 0); // left leg -0.985 .. 0.045
  capsule(0.065, 0.9, -0.1, -0.47, 0);
  for (const x of [0.1, -0.1]) {
    const foot = new BoxGeometry(0.1, 0.05, 0.2, seg(2), 1, seg(4));
    foot.translate(x, -0.975, 0.06);
    parts.push(foot);
  }
  const merged = mergeGeometries(parts, false)!;
  parts.forEach((g) => g.dispose());
  const mesh = new Mesh(merged, new MeshStandardMaterial());
  mesh.name = 'surface';
  const j = (x: number, y: number, z = 0) => ({ x, y, z });
  const joints: Record<CoreBone, { x: number; y: number; z: number }> = {
    Hips: j(0, 0.04),
    Spine: j(0, 0.15),
    Spine1: j(0, 0.3),
    Spine2: j(0, 0.47),
    Neck: j(0, 0.67),
    Head: j(0, 0.78),
    HeadTop_End: j(0, 1),
    LeftShoulder: j(0.05, 0.64),
    LeftArm: j(0.16, 0.62),
    LeftForeArm: j(0.52, 0.62),
    LeftHand: j(0.84, 0.62),
    RightShoulder: j(-0.05, 0.64),
    RightArm: j(-0.16, 0.62),
    RightForeArm: j(-0.52, 0.62),
    RightHand: j(-0.84, 0.62),
    LeftUpLeg: j(0.1, 0.01),
    LeftLeg: j(0.1, -0.47),
    LeftFoot: j(0.1, -0.91),
    LeftToeBase: j(0.1, -0.97, 0.1),
    RightUpLeg: j(-0.1, 0.01),
    RightLeg: j(-0.1, -0.47),
    RightFoot: j(-0.1, -0.91),
    RightToeBase: j(-0.1, -0.97, 0.1),
  };
  return { mesh, joints };
}

/** A mannequin inside a scaled / offset group (like a normalised GLB model). */
export function makeGroupedMannequin(detail = 1): { root: Group; mannequin: Mannequin } {
  const mannequin = makeMannequin(detail);
  const root = new Group();
  const inner = new Group();
  inner.position.set(0.3, 0.1, -0.2);
  inner.add(mannequin.mesh);
  root.add(inner);
  root.scale.setScalar(1.5);
  return { root, mannequin };
}

export const FAKE_IMAGE = { width: 400, height: 400 };
/** The mannequin's XY bounds (x ±0.925, y -1..1) map to this pixel box. */
const PX = { x0: 20, y0: 10, w: 360, h: 380 };
const BOX = { minX: -0.925, maxX: 0.925, minY: -1, maxY: 1 };

export function toPixel(p: { x: number; y: number }): { x: number; y: number } {
  return {
    x: PX.x0 + ((p.x - BOX.minX) / (BOX.maxX - BOX.minX)) * PX.w,
    y: PX.y0 + ((BOX.maxY - p.y) / (BOX.maxY - BOX.minY)) * PX.h,
  };
}

/** Mask whose bounding box is the mannequin's pixel box. */
export function fakeMask(): Mask {
  const { width, height } = FAKE_IMAGE;
  const data = new Uint8Array(width * height);
  for (let y = PX.y0; y < PX.y0 + PX.h; y++) for (let x = PX.x0; x < PX.x0 + PX.w; x++) data[y * width + x] = 1;
  return { width, height, data };
}

/** BlazePose landmarks of a front-facing body with the given joints (model units). */
export function fakePose(joints: JointLayout, overrides: Partial<Record<number, { x: number; y: number }>> = {}): PoseResult {
  const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, z: 0, visibility: 0 }));
  const put = (i: number, p: { x: number; y: number } | undefined) => {
    if (!p) return;
    const px = toPixel(p);
    lm[i] = { x: px.x, y: px.y, z: 0, visibility: 0.99 };
  };
  put(POSE.nose, { x: 0, y: 0.86 });
  put(POSE.leftEye, { x: 0.04, y: 0.9 });
  put(POSE.rightEye, { x: -0.04, y: 0.9 });
  put(POSE.leftEar, { x: 0.11, y: 0.88 });
  put(POSE.rightEar, { x: -0.11, y: 0.88 });
  put(POSE.mouthLeft, { x: 0.03, y: 0.82 });
  put(POSE.mouthRight, { x: -0.03, y: 0.82 });
  put(POSE.leftShoulder, joints.LeftArm);
  put(POSE.rightShoulder, joints.RightArm);
  put(POSE.leftElbow, joints.LeftForeArm);
  put(POSE.rightElbow, joints.RightForeArm);
  put(POSE.leftWrist, joints.LeftHand);
  put(POSE.rightWrist, joints.RightHand);
  put(POSE.leftHip, joints.LeftUpLeg);
  put(POSE.rightHip, joints.RightUpLeg);
  put(POSE.leftKnee, joints.LeftLeg);
  put(POSE.rightKnee, joints.RightLeg);
  put(POSE.leftAnkle, joints.LeftFoot);
  put(POSE.rightAnkle, joints.RightFoot);
  put(POSE.leftFootIndex, joints.LeftToeBase && { x: joints.LeftToeBase.x, y: -0.985 });
  put(POSE.rightFootIndex, joints.RightToeBase && { x: joints.RightToeBase.x, y: -0.985 });
  for (const [i, p] of Object.entries(overrides)) put(Number(i), p);
  return { landmarks: lm, box: { x: PX.x0, y: PX.y0, width: PX.w, height: PX.h } };
}
