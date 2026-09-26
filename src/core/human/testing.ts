/**
 * Synthetic landmarks for tests (pure). The face is laid out with a Tutte
 * embedding of the real MediaPipe face mesh (outline pinned to an ellipse,
 * every other vertex at the mean of its neighbours), so all 852 triangles are
 * valid and non-overlapping; heights come from a simple head model with a
 * nose, eye sockets and lips.
 */
import { FACE, FACE_OVAL, FACE_TRIANGLES, LEFT_EYE_LOOP, RIGHT_EYE_LOOP } from './topology';
import { POSE, type FaceResult, type HandResult, type HumanAnalysis, type Landmark, type PoseResult } from './types';

let layout: Float64Array | null = null;

/** Face mesh vertex positions in [-1, 1]² (y down), outline on the unit circle, 478 points (iris included). */
export function faceLayout(): Float64Array {
  if (layout) return layout;
  const n = 478;
  const pos = new Float64Array(n * 2);
  const nbrs: Set<number>[] = Array.from({ length: 468 }, () => new Set<number>());
  for (let t = 0; t < FACE_TRIANGLES.length; t += 3) {
    const a = FACE_TRIANGLES[t], b = FACE_TRIANGLES[t + 1], c = FACE_TRIANGLES[t + 2];
    nbrs[a].add(b).add(c); nbrs[b].add(a).add(c); nbrs[c].add(a).add(b);
  }
  const fixed = new Uint8Array(468);
  FACE_OVAL.forEach((v, k) => {
    const th = -Math.PI / 2 + (2 * Math.PI * k) / FACE_OVAL.length;
    pos[v * 2] = Math.cos(th);
    pos[v * 2 + 1] = Math.sin(th);
    fixed[v] = 1;
  });
  const lists = nbrs.map((s) => [...s]);
  for (let it = 0; it < 3000; it++) {
    for (let v = 0; v < 468; v++) {
      if (fixed[v]) continue;
      let x = 0, y = 0;
      for (const u of lists[v]) { x += pos[u * 2]; y += pos[u * 2 + 1]; }
      pos[v * 2] = x / lists[v].length;
      pos[v * 2 + 1] = y / lists[v].length;
    }
  }
  // Iris: centre + 4 ring points inside each eye opening.
  const iris = (loop: readonly number[], center: number) => {
    let cx = 0, cy = 0, minX = Infinity, maxX = -Infinity;
    for (const v of loop) {
      cx += pos[v * 2] / loop.length; cy += pos[v * 2 + 1] / loop.length;
      minX = Math.min(minX, pos[v * 2]); maxX = Math.max(maxX, pos[v * 2]);
    }
    const rad = 0.2 * (maxX - minX);
    pos[center * 2] = cx; pos[center * 2 + 1] = cy;
    for (let k = 0; k < 4; k++) {
      pos[(center + 1 + k) * 2] = cx + rad * Math.cos((k * Math.PI) / 2);
      pos[(center + 1 + k) * 2 + 1] = cy + rad * Math.sin((k * Math.PI) / 2);
    }
  };
  iris(RIGHT_EYE_LOOP, FACE.rightIris);
  iris(LEFT_EYE_LOOP, FACE.leftIris);
  layout = pos;
  return pos;
}

export interface SyntheticFaceOptions {
  /** Relief amplitudes as fractions of the face half-width. */
  dome?: number;
  nose?: number;
  sockets?: number;
  /** Scale all depth (0 = perfectly flat landmarks). */
  depth?: number;
}

/** A 478-point face centred at (cx, cy) with the given outline half-axes (px). */
export function syntheticFace(cx: number, cy: number, halfW: number, halfH: number, opts: SyntheticFaceOptions = {}): FaceResult {
  const pos = faceLayout();
  const { dome = 0.45, nose = 0.3, sockets = 0.08, depth = 1 } = opts;
  const at = (i: number) => ({ u: pos[i * 2], v: pos[i * 2 + 1] });
  const noseP = at(FACE.noseTip);
  const eyeR = at(FACE.rightIris), eyeL = at(FACE.leftIris);
  const g = (u: number, v: number, c: { u: number; v: number }, s: number) => Math.exp(-(((u - c.u) ** 2 + (v - c.v) ** 2) / (2 * s * s)));
  const landmarks: Landmark[] = [];
  for (let i = 0; i < 478; i++) {
    const { u, v } = at(i);
    const r2 = Math.min(1, u * u + v * v);
    const h = dome * Math.sqrt(1 - 0.75 * r2) + nose * g(u, v, noseP, 0.12) - sockets * (g(u, v, eyeR, 0.12) + g(u, v, eyeL, 0.12));
    landmarks.push({ x: cx + u * halfW, y: cy + v * halfH, z: -h * halfW * depth });
  }
  return { landmarks, box: boxOf(landmarks) };
}

/** Hand in a canonical open pose, wrist at (wx, wy), fingers pointing up; palm = wrist → middle knuckle length (px). */
export function syntheticHand(wx: number, wy: number, palm: number, handedness: 'Left' | 'Right' = 'Right', z = 0): HandResult {
  const P: [number, number][] = [
    [0, 0],
    [-0.28, -0.2], [-0.5, -0.45], [-0.66, -0.66], [-0.8, -0.86],
    [-0.36, -1], [-0.42, -1.42], [-0.45, -1.68], [-0.48, -1.9],
    [-0.08, -1.05], [-0.09, -1.52], [-0.1, -1.8], [-0.1, -2.02],
    [0.2, -0.98], [0.24, -1.42], [0.27, -1.68], [0.3, -1.88],
    [0.45, -0.85], [0.53, -1.16], [0.58, -1.36], [0.62, -1.52],
  ];
  const s = handedness === 'Right' ? 1 : -1;
  const landmarks = P.map(([x, y]) => ({ x: wx + s * x * palm, y: wy + y * palm, z }));
  return { landmarks, handedness, box: boxOf(landmarks) };
}

/** Standing person (frontal, arms slightly out) whose body spans `height` px from the top of the head, centred on cx. */
export function syntheticPose(cx: number, top: number, height: number, visibility = 0.99): PoseResult {
  const H = height;
  const pts: Record<number, [number, number]> = {
    [POSE.nose]: [0, 0.06],
    1: [0.015, 0.05], [POSE.leftEye]: [0.025, 0.05], 3: [0.035, 0.05], 4: [-0.015, 0.05], [POSE.rightEye]: [-0.025, 0.05], 6: [-0.035, 0.05],
    [POSE.leftEar]: [0.05, 0.055], [POSE.rightEar]: [-0.05, 0.055],
    [POSE.mouthLeft]: [0.015, 0.085], [POSE.mouthRight]: [-0.015, 0.085],
    [POSE.leftShoulder]: [0.12, 0.18], [POSE.rightShoulder]: [-0.12, 0.18],
    [POSE.leftElbow]: [0.2, 0.33], [POSE.rightElbow]: [-0.2, 0.33],
    [POSE.leftWrist]: [0.25, 0.47], [POSE.rightWrist]: [-0.25, 0.47],
    [POSE.leftPinky]: [0.27, 0.5], [POSE.rightPinky]: [-0.27, 0.5],
    [POSE.leftIndex]: [0.26, 0.51], [POSE.rightIndex]: [-0.26, 0.51],
    [POSE.leftThumb]: [0.245, 0.5], [POSE.rightThumb]: [-0.245, 0.5],
    [POSE.leftHip]: [0.08, 0.52], [POSE.rightHip]: [-0.08, 0.52],
    [POSE.leftKnee]: [0.09, 0.73], [POSE.rightKnee]: [-0.09, 0.73],
    [POSE.leftAnkle]: [0.09, 0.93], [POSE.rightAnkle]: [-0.09, 0.93],
    [POSE.leftHeel]: [0.085, 0.96], [POSE.rightHeel]: [-0.085, 0.96],
    [POSE.leftFootIndex]: [0.11, 0.98], [POSE.rightFootIndex]: [-0.11, 0.98],
  };
  // The subject's left appears on the image's right in a frontal photo.
  const landmarks: Landmark[] = [];
  for (let i = 0; i < 33; i++) {
    const [x, y] = pts[i] ?? [0, 0];
    landmarks.push({ x: cx + x * H, y: top + y * H, z: 0, visibility });
  }
  return { landmarks, box: boxOf(landmarks) };
}

export function boxOf(pts: Landmark[]): { x: number; y: number; width: number; height: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function fakeAnalysis(width: number, height: number, parts: Partial<Pick<HumanAnalysis, 'faces' | 'hands' | 'poses'>> = {}): HumanAnalysis {
  const faces = parts.faces ?? [], hands = parts.hands ?? [], poses = parts.poses ?? [];
  return { width, height, faces, hands, poses, isHuman: faces.length > 0 || poses.length > 0 };
}
