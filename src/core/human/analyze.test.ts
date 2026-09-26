import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbortError, type RGBAImage } from '../types';
import { analyzeHuman, clearHumanCache, faceAgreesWithPose, headBoxFromPose, landmarkBox, resolveHandedness, setDetectorBackend, toPixels } from './analyze';
import type { Detector, DetectorBackend, RawDetections, RawLandmark } from './backend';
import { syntheticFace, syntheticPose } from './testing';
import { FACE, LEFT_EYE_LOOP, RIGHT_EYE_LOOP } from './topology';
import type { HumanDetector } from './types';
import { POSE } from './types';

const W = 200, H = 100;
const img = (w = W, h = H): RGBAImage => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(128) });

const pts = (n: number, x = 0.5, y = 0.5, z = -0.1): RawLandmark[] =>
  Array.from({ length: n }, (_, i) => ({ x: x + (i % 7) * 0.01, y: y + (i % 5) * 0.01, z, visibility: 0.9 }));

type Fn = (image: RGBAImage) => RawDetections;

function backend(fns: Partial<Record<HumanDetector, Fn | Error>>, unsupported: string | null = null) {
  const calls = { load: [] as HumanDetector[], detect: [] as [HumanDetector, number, number][] };
  const b: DetectorBackend = {
    unsupportedReason: () => (unsupported ? { tr: unsupported, en: unsupported } : null),
    load: async (kind, ctx) => {
      calls.load.push(kind);
      ctx.onBytes?.(50, 100);
      const fn = fns[kind];
      if (!fn) throw new Error(`no ${kind}`);
      if (fn instanceof Error) throw fn;
      const det: Detector = {
        kind,
        detect: async (image) => {
          calls.detect.push([kind, image.width, image.height]);
          return fn(image);
        },
      };
      return det;
    },
  };
  return { b, calls };
}

const none: Fn = () => ({ landmarks: [] });

afterEach(() => setDetectorBackend(null));

describe('pure helpers', () => {
  it('converts normalised landmarks to pixels (z scaled like x)', () => {
    const [p] = toPixels([{ x: 0.5, y: 0.25, z: -0.1, visibility: 0.7 }], { x0: 10, y0: 20, width: 200, height: 100 }, true);
    expect(p).toEqual({ x: 110, y: 45, z: -20, visibility: 0.7 });
    const [q] = toPixels([{ x: 0.5, y: 0.25, z: -0.1, visibility: 0 }], { x0: 0, y0: 0, width: 200, height: 100 });
    expect(q.visibility).toBeUndefined();
  });

  it('boxes landmarks, clamped to the image and ignoring invisible points', () => {
    const box = landmarkBox([{ x: -5, y: 10, z: 0 }, { x: 50, y: 60, z: 0 }, { x: 500, y: 500, z: 0, visibility: 0.1 }], 100, 100, 0.5);
    expect(box).toEqual({ x: 0, y: 10, width: 50, height: 50 });
  });

  it('finds the head of a pose', () => {
    const pose = syntheticPose(200, 10, 380);
    const box = headBoxFromPose(pose, 400, 400)!;
    const nose = pose.landmarks[POSE.nose];
    expect(nose.x).toBeGreaterThan(box.x);
    expect(nose.x).toBeLessThan(box.x + box.width);
    expect(box.width).toBeGreaterThan(40);
    expect(headBoxFromPose(syntheticPose(200, 10, 380, 0.1), 400, 400)).toBeNull();
  });

  it('rejects a face mesh the pose on the same head contradicts', () => {
    const face = syntheticFace(200, 200, 60, 75);
    const L = face.landmarks;
    const mean = (ids: readonly number[]) => ({ x: ids.reduce((s, i) => s + L[i].x, 0) / ids.length, y: ids.reduce((s, i) => s + L[i].y, 0) / ids.length });
    const pose = syntheticPose(200, 10, 380);
    const put = (idx: number, p: { x: number; y: number }, dx = 0, dy = 0) => (pose.landmarks[idx] = { x: p.x + dx, y: p.y + dy, z: 0, visibility: 0.99 });
    const place = (dx: number, dy: number) => {
      put(POSE.nose, L[FACE.noseTip], dx, dy);
      put(POSE.leftEye, mean(LEFT_EYE_LOOP), dx, dy);
      put(POSE.rightEye, mean(RIGHT_EYE_LOOP), dx, dy);
      put(POSE.mouthLeft, L[291], dx, dy);
      put(POSE.mouthRight, L[61], dx, dy);
    };
    place(0, 0);
    expect(faceAgreesWithPose(face, [pose])).toBe(true);
    place(40, 0); // the pose's features sit 40 px (~0.3 face sizes) away
    expect(faceAgreesWithPose(face, [pose])).toBe(false);
    // Eye line rotated ~40° against the pose's.
    place(0, 0);
    const le = pose.landmarks[POSE.leftEye], re = pose.landmarks[POSE.rightEye];
    const d = Math.hypot(le.x - re.x, le.y - re.y) / 2, cx = (le.x + re.x) / 2, cy = (le.y + re.y) / 2;
    pose.landmarks[POSE.leftEye] = { ...le, x: cx + d * Math.cos(0.7), y: cy + d * Math.sin(0.7) };
    pose.landmarks[POSE.rightEye] = { ...re, x: cx - d * Math.cos(0.7), y: cy - d * Math.sin(0.7) };
    expect(faceAgreesWithPose(face, [pose])).toBe(false);
    expect(faceAgreesWithPose(face, [])).toBe(true);
    expect(faceAgreesWithPose(face, [syntheticPose(900, 10, 380)])).toBe(true); // pose elsewhere
  });

  it('resolves handedness from the pose, else by flipping the mirrored label', () => {
    expect(resolveHandedness('Left', { x: 0, y: 0, z: 0 }, [], true)).toBe('Right');
    expect(resolveHandedness('Left', { x: 0, y: 0, z: 0 }, [], false)).toBe('Left');
    const pose = syntheticPose(200, 10, 380);
    const lw = pose.landmarks[POSE.leftWrist];
    expect(resolveHandedness('Left', { x: lw.x + 2, y: lw.y, z: 0 }, [pose], true)).toBe('Left');
  });
});

describe('analyzeHuman', () => {
  it('returns an empty result with a reason when detection is unsupported', async () => {
    setDetectorBackend(backend({}, 'no wasm').b);
    const a = await analyzeHuman(img(), { signal: new AbortController().signal });
    expect(a).toMatchObject({ width: W, height: H, faces: [], hands: [], poses: [], isHuman: false, unavailableReason: 'no wasm' });
  });

  it('never throws when models cannot load; does not cache the failure', async () => {
    const { b, calls } = backend({ faces: new Error('HTTP 404'), hands: new Error('HTTP 404'), pose: new Error('HTTP 404') });
    setDetectorBackend(b);
    const image = img();
    const a = await analyzeHuman(image, { signal: new AbortController().signal });
    expect(a.isHuman).toBe(false);
    expect(a.unavailableReason).toContain('HTTP 404');
    expect(a.unavailableText?.tr).toBeTruthy();
    expect(Object.keys(a.failed ?? {}).sort()).toEqual(['faces', 'hands', 'pose']);
    await analyzeHuman(image, { signal: new AbortController().signal });
    expect(calls.load).toHaveLength(6);
  });

  it('reports partial failures and keeps what worked', async () => {
    setDetectorBackend(backend({ faces: () => ({ landmarks: [pts(478)] }), hands: new Error('boom'), pose: none }).b);
    const a = await analyzeHuman(img(), { signal: new AbortController().signal });
    expect(a.faces).toHaveLength(1);
    expect(a.isHuman).toBe(true);
    expect(a.unavailableReason).toBeUndefined();
    expect(a.failed?.hands).toContain('boom');
  });

  it('survives a detector that crashes at inference time', async () => {
    setDetectorBackend(backend({ faces: () => { throw new Error('wasm trap'); }, hands: none, pose: none }).b);
    const a = await analyzeHuman(img(), { signal: new AbortController().signal });
    expect(a.faces).toEqual([]);
    expect(a.failed?.faces).toContain('wasm trap');
  });

  it('converts results to pixels, sorts by size and reports progress', async () => {
    const big = pts(478, 0.2, 0.2, -0.05).map((p, i) => ({ ...p, x: 0.1 + (i % 20) * 0.02 }));
    setDetectorBackend(
      backend({
        faces: () => ({ landmarks: [pts(478, 0.7, 0.6), big] }),
        hands: () => ({ landmarks: [pts(21, 0.1, 0.8)], handedness: ['Left'] }),
        pose: none,
      }).b,
    );
    const progress: string[] = [];
    const a = await analyzeHuman(img(), { signal: new AbortController().signal, onProgress: (p) => progress.push(p.label.en) });
    expect(a.faces).toHaveLength(2);
    expect(a.faces[0].box.width).toBeGreaterThan(a.faces[1].box.width);
    expect(a.faces[1].landmarks[0]).toMatchObject({ x: 0.7 * W, y: 0.6 * H, z: -0.1 * W });
    expect(a.hands[0].handedness).toBe('Right'); // mirrored label flipped
    expect(a.hands[0].landmarks).toHaveLength(21);
    expect(progress[0]).toContain('Loading human detection models');
    expect(progress.some((p) => p.includes('MB'))).toBe(true);
    expect(progress).toContain('Detecting face, hands and body…');
  });

  it('caches per image object and serves detector subsets from the full result', async () => {
    const { b, calls } = backend({ faces: () => ({ landmarks: [pts(478)] }), hands: none, pose: none });
    setDetectorBackend(b);
    const image = img();
    const a1 = await analyzeHuman(image, { signal: new AbortController().signal });
    const a2 = await analyzeHuman(image, { signal: new AbortController().signal });
    expect(a2).toBe(a1);
    const faceOnly = await analyzeHuman(image, { signal: new AbortController().signal, detect: { hands: false, pose: false } });
    expect(faceOnly.faces).toBe(a1.faces);
    expect(calls.detect.filter(([k]) => k === 'faces')).toHaveLength(1);
    await analyzeHuman(img(), { signal: new AbortController().signal });
    expect(calls.detect.filter(([k]) => k === 'faces')).toHaveLength(2);
    clearHumanCache(image);
    await analyzeHuman(image, { signal: new AbortController().signal });
    expect(calls.detect.filter(([k]) => k === 'faces')).toHaveLength(3);
  });

  it('only runs the requested detectors', async () => {
    const { b, calls } = backend({ faces: none, hands: none, pose: none });
    setDetectorBackend(b);
    await analyzeHuman(img(), { signal: new AbortController().signal, detect: { faces: true, hands: false, pose: false } });
    expect(calls.load).toEqual(['faces']);
    const nothing = await analyzeHuman(img(), { signal: new AbortController().signal, detect: { faces: false, hands: false, pose: false } });
    expect(nothing.isHuman).toBe(false);
  });

  it('shares one run between concurrent callers; aborting one keeps the other', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { b, calls } = backend({ faces: () => ({ landmarks: [pts(478)] }), hands: none, pose: none });
    const slow: DetectorBackend = { ...b, load: async (k, ctx) => { await gate; return b.load(k, ctx); } };
    setDetectorBackend(slow);
    const image = img();
    const ac1 = new AbortController(), ac2 = new AbortController();
    const p1 = analyzeHuman(image, { signal: ac1.signal });
    const p2 = analyzeHuman(image, { signal: ac2.signal });
    ac1.abort();
    await expect(p1).rejects.toBeInstanceOf(AbortError);
    release();
    const a = await p2;
    expect(a.faces).toHaveLength(1);
    expect(calls.load.filter((k) => k === 'faces')).toHaveLength(1);
  });

  it('rejects with AbortError when aborted (before or during)', async () => {
    setDetectorBackend(backend({ faces: none, hands: none, pose: none }).b);
    const ac = new AbortController();
    ac.abort();
    await expect(analyzeHuman(img(), { signal: ac.signal })).rejects.toBeInstanceOf(AbortError);
    const ac2 = new AbortController();
    const p = analyzeHuman(img(), { signal: ac2.signal });
    ac2.abort();
    await expect(p).rejects.toBeInstanceOf(AbortError);
  });

  it('searches pose-guided crops for small faces and hands, mapping them back', async () => {
    const big = img(400, 400);
    const pose = syntheticPose(200, 10, 380);
    const norm = pose.landmarks.map((p) => ({ x: p.x / 400, y: p.y / 400, z: 0, visibility: 0.99 }));
    // The face / hand detectors only find something in up-scaled crops (≥ 256 px), centred.
    const inCrop: (n: number) => Fn = (n) => (image) => (image.width >= 256 && image.width < 400 ? { landmarks: [pts(n, 0.45, 0.45)], handedness: ['Right'] } : { landmarks: [] });
    const { b, calls } = backend({ pose: () => ({ landmarks: [norm] }), faces: inCrop(478), hands: inCrop(21) });
    setDetectorBackend(b);
    const a = await analyzeHuman(big, { signal: new AbortController().signal });
    expect(a.poses).toHaveLength(1);
    expect(a.faces).toHaveLength(1);
    const head = headBoxFromPose(a.poses[0], 400, 400)!;
    const f0 = a.faces[0].landmarks[0];
    expect(f0.x).toBeCloseTo(head.x + 0.45 * head.width, 0);
    expect(f0.y).toBeCloseTo(head.y + 0.45 * head.height, 0);
    expect(f0.z).toBeCloseTo(-0.1 * head.width, 1);
    expect(a.hands).toHaveLength(2);
    expect(a.hands.map((h) => h.handedness).sort()).toEqual(['Left', 'Right']); // from the pose wrists
    expect(calls.detect.filter(([k, w]) => k === 'faces' && w >= 256 && w < 400)).toHaveLength(1);
  });

  it('degrades gracefully with the real MediaPipe backend outside a browser', async () => {
    setDetectorBackend(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = await analyzeHuman(img(), { signal: new AbortController().signal });
    warn.mockRestore();
    expect(a.isHuman).toBe(false);
    expect(a.unavailableReason).toMatch(/not supported|Could not load/);
  });
});
