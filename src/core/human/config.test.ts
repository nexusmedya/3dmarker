import { describe, expect, it } from 'vitest';
import { DEFAULT_HUMAN_CONFIG, DEFAULT_MODEL_BASE, downloadSizeMB, humanConfigFrom, joinUrl, modelUrls } from './config';

describe('human config', () => {
  it('defaults to Google model bucket, bundled wasm, full pose with lite fallback', () => {
    const cfg = humanConfigFrom({});
    expect(cfg).toEqual(DEFAULT_HUMAN_CONFIG);
    expect(modelUrls(cfg, 'faces')).toEqual([
      'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    ]);
    expect(modelUrls(cfg, 'hands')[0]).toBe(
      'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    );
    expect(modelUrls(cfg, 'pose')).toEqual([
      `${DEFAULT_MODEL_BASE}pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
      `${DEFAULT_MODEL_BASE}pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
    ]);
  });

  it('reads the env overrides and ignores invalid values', () => {
    const cfg = humanConfigFrom({
      VITE_MEDIAPIPE_MODEL_BASE: 'mediapipe',
      VITE_MEDIAPIPE_WASM_BASE: '/wasm/',
      VITE_MEDIAPIPE_POSE_MODEL: 'heavy',
      VITE_MEDIAPIPE_DELEGATE: 'cpu',
    });
    expect(cfg.modelBase).toBe('mediapipe');
    expect(cfg.wasmBase).toBe('/wasm');
    expect(cfg.delegate).toBe('CPU');
    expect(modelUrls(cfg, 'pose').map((u) => u.split('/')[2])).toEqual(['pose_landmarker_heavy', 'pose_landmarker_full', 'pose_landmarker_lite']);
    expect(modelUrls(cfg, 'faces')[0]).toBe('mediapipe/face_landmarker/face_landmarker/float16/1/face_landmarker.task');
    const bad = humanConfigFrom({ VITE_MEDIAPIPE_POSE_MODEL: 'huge', VITE_MEDIAPIPE_DELEGATE: 'tpu', VITE_MEDIAPIPE_MODEL_BASE: '  ' });
    expect(bad).toEqual(DEFAULT_HUMAN_CONFIG);
    expect(humanConfigFrom({ VITE_MEDIAPIPE_POSE_MODEL: 'lite' }).pose).toBe('lite');
    expect(modelUrls(humanConfigFrom({ VITE_MEDIAPIPE_POSE_MODEL: 'lite' }), 'pose')).toHaveLength(1);
  });

  it('joins URLs with one slash and sums download sizes', () => {
    expect(joinUrl('https://a.b/models/', '/x/y.task')).toBe('https://a.b/models/x/y.task');
    expect(joinUrl('models', 'x.task')).toBe('models/x.task');
    expect(downloadSizeMB(DEFAULT_HUMAN_CONFIG)).toBe(20);
    expect(downloadSizeMB(DEFAULT_HUMAN_CONFIG, ['faces'])).toBe(4);
  });
});
