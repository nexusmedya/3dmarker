import { FaceLandmarker, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import { describe, expect, it } from 'vitest';
import {
  FACE_CONTOUR_EDGES,
  FACE_OVAL,
  FACE_TRIANGLES,
  HAND_EDGES,
  INNER_LIPS_LOOP,
  LEFT_EYE_LOOP,
  POSE_EDGES,
  RIGHT_EYE_LOOP,
} from './topology';

const flat = (list: { start: number; end: number }[]) => list.flatMap((c) => [c.start, c.end]);

describe('topology tables match @mediapipe/tasks-vision', () => {
  it('face triangles are the tessellation edge triples', () => {
    const T = FaceLandmarker.FACE_LANDMARKS_TESSELATION;
    expect(FACE_TRIANGLES.length).toBe(T.length);
    for (let i = 0; i < T.length; i += 3) {
      expect([T[i].start, T[i + 1].start, T[i + 2].start]).toEqual([FACE_TRIANGLES[i], FACE_TRIANGLES[i + 1], FACE_TRIANGLES[i + 2]]);
      expect(T[i].end).toBe(T[i + 1].start);
      expect(T[i + 2].end).toBe(T[i].start);
    }
    expect(new Set(FACE_TRIANGLES).size).toBe(468);
  });

  it('face oval, contours, hand and pose skeletons', () => {
    expect(FACE_OVAL).toEqual(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL.map((c) => c.start));
    expect(FACE_CONTOUR_EDGES).toEqual(flat(FaceLandmarker.FACE_LANDMARKS_CONTOURS));
    expect(HAND_EDGES).toEqual(flat(HandLandmarker.HAND_CONNECTIONS));
    expect(POSE_EDGES).toEqual(flat(PoseLandmarker.POSE_CONNECTIONS));
  });

  it('eye and mouth loops are closed boundary loops of the tessellation', () => {
    const count = new Map<string, number>();
    for (let t = 0; t < FACE_TRIANGLES.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = FACE_TRIANGLES[t + k], b = FACE_TRIANGLES[t + ((k + 1) % 3)];
        const key = `${Math.min(a, b)},${Math.max(a, b)}`;
        count.set(key, (count.get(key) ?? 0) + 1);
      }
    }
    const boundary = (a: number, b: number) => count.get(`${Math.min(a, b)},${Math.max(a, b)}`) === 1;
    for (const loop of [FACE_OVAL, RIGHT_EYE_LOOP, LEFT_EYE_LOOP, INNER_LIPS_LOOP]) {
      for (let i = 0; i < loop.length; i++) expect(boundary(loop[i], loop[(i + 1) % loop.length])).toBe(true);
    }
    const total = [...count.values()].filter((v) => v === 1).length;
    expect(FACE_OVAL.length + RIGHT_EYE_LOOP.length + LEFT_EYE_LOOP.length + INNER_LIPS_LOOP.length).toBe(total);
  });
});
