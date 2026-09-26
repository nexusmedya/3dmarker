import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AbortError, defaultParams, type DriverInput, type Progress } from '../../core/types';
import type { HumanAnalysis } from '../../core/human/types';
import { fakeAnalysis, syntheticFace, syntheticHand } from '../../core/human/testing';
import type { DepthJob, DepthPayload } from '../../workers/mlProtocol';
import type { MlRequestOptions } from './workerClient';

vi.mock('./workerClient', () => ({
  isMlSupported: () => true,
  requestDepth: vi.fn(),
}));
vi.mock('../../core/human/analyze', () => ({ analyzeHuman: vi.fn() }));

const { requestDepth } = await import('./workerClient');
const { analyzeHuman } = await import('../../core/human/analyze');
const { ML_DRIVERS } = await import('./index');
const { HUMAN_PARAMS } = await import('./depthDriver');
const mockedRequest = vi.mocked(requestDepth);
const mockedAnalyze = vi.mocked(analyzeHuman);

const W = 400, H = 300;

/** Fake worker: flat disparity (a model that sees the face as flat). */
function flatDepth(job: Omit<DepthJob, 'id' | 'type'>, _opts: MlRequestOptions): Promise<DepthPayload> {
  const { width, height } = job.image;
  return Promise.resolve({ kind: 'depth', data: new Float32Array(width * height).fill(1), dims: [1, height, width], device: 'webgpu', dtype: 'fp16' });
}

function input(over: Partial<DriverInput> = {}): DriverInput & { progress: Progress[] } {
  const progress: Progress[] = [];
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([200, 160, 140, 255], i * 4);
  return {
    image: { width: W, height: H, data },
    mask: null,
    file: new Blob(),
    views: {},
    params: {},
    signal: new AbortController().signal,
    onProgress: (p) => progress.push(p),
    progress,
    ...over,
  };
}

const driver = ML_DRIVERS[0];
const face = syntheticFace(200, 140, 35, 45);
const withFace = (): HumanAnalysis => fakeAnalysis(W, H, { faces: [face] });

beforeEach(() => {
  mockedRequest.mockReset();
  mockedRequest.mockImplementation(flatDepth);
  mockedAnalyze.mockReset();
  mockedAnalyze.mockResolvedValue(fakeAnalysis(W, H));
});

describe('human detail in the ML depth drivers', () => {
  it('declares the params and badge on every depth driver', () => {
    for (const d of ML_DRIVERS) {
      expect(d.badges).toContain('human-detail');
      for (const p of HUMAN_PARAMS) expect(d.params).toContainEqual(p);
    }
    expect(defaultParams(HUMAN_PARAMS)).toEqual({ humanDetail: true, faceStrength: 0.8, handStrength: 0.7, hiResCrops: true });
    for (const p of HUMAN_PARAMS) expect(p.label.tr && p.label.en).toBeTruthy();
  });

  it('leaves the depth alone without people', async () => {
    const res = await driver.run(input({ params: defaultParams(driver.params) }));
    if (res.kind !== 'depth') throw new Error('expected depth');
    expect(mockedAnalyze).toHaveBeenCalledTimes(1);
    expect(mockedRequest).toHaveBeenCalledTimes(1);
    const v = res.depth.data[0];
    expect(res.depth.data.every((x) => x === v)).toBe(true);
  });

  it('skips analysis when humanDetail is off', async () => {
    await driver.run(input({ params: { ...defaultParams(driver.params), humanDetail: false } }));
    expect(mockedAnalyze).not.toHaveBeenCalled();
  });

  it('adds face relief and runs one extra inference per face crop at the native side', async () => {
    mockedAnalyze.mockResolvedValue(withFace());
    const inp = input({ params: defaultParams(driver.params) });
    const res = await driver.run(inp);
    if (res.kind !== 'depth') throw new Error('expected depth');
    expect(mockedRequest).toHaveBeenCalledTimes(2);
    const [cropJob] = mockedRequest.mock.calls[1];
    expect(cropJob.model).toBe('onnx-community/depth-anything-v2-small');
    expect((cropJob.image.width * cropJob.image.height) / 518 ** 2).toBeCloseTo(1, 1);
    const nose = face.landmarks[1], cheek = face.landmarks[205];
    const at = (p: { x: number; y: number }) => res.depth.data[Math.floor(p.y) * W + Math.floor(p.x)];
    expect(at(nose)).toBeGreaterThan(at(cheek) + 0.02);
    const labels = inp.progress.map((p) => p.label.en);
    expect(labels).toContain('Face detail: high-res pass (1/1)…');
    expect(labels.at(-1)).toBe('Adding face and hand relief…');
    // The image handed to the analysis is the driver's input image.
    expect(mockedAnalyze.mock.calls[0][0]).toBe(inp.image);
  });

  it('honours hiResCrops and the strengths', async () => {
    mockedAnalyze.mockResolvedValue(fakeAnalysis(W, H, { faces: [face], hands: [syntheticHand(320, 280, 30)] }));
    const base = defaultParams(driver.params);
    const off = await driver.run(input({ params: { ...base, hiResCrops: false } }));
    expect(mockedRequest).toHaveBeenCalledTimes(1);
    mockedRequest.mockClear();
    const flat = await driver.run(input({ params: { ...base, hiResCrops: false, faceStrength: 0, handStrength: 0 } }));
    if (off.kind !== 'depth' || flat.kind !== 'depth') throw new Error('expected depth');
    const i = Math.floor(face.landmarks[1].y) * W + Math.floor(face.landmarks[1].x);
    expect(off.depth.data[i]).toBeGreaterThan(flat.depth.data[i] + 0.02);
  });

  it('keeps the plain depth when the refinement fails, but propagates cancellation', async () => {
    mockedAnalyze.mockResolvedValue(withFace());
    mockedRequest.mockImplementationOnce(flatDepth).mockRejectedValueOnce(new Error('worker crashed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await driver.run(input({ params: defaultParams(driver.params) }));
    warn.mockRestore();
    if (res.kind !== 'depth') throw new Error('expected depth');
    const v = res.depth.data[0];
    expect(res.depth.data.every((x) => x === v)).toBe(true);

    const ac = new AbortController();
    mockedRequest.mockImplementationOnce(flatDepth).mockImplementationOnce(async () => {
      ac.abort();
      throw new AbortError();
    });
    await expect(driver.run(input({ params: defaultParams(driver.params), signal: ac.signal }))).rejects.toBeInstanceOf(AbortError);
  });

  it('cancels the analysis when the depth request fails or is aborted', async () => {
    let seen: AbortSignal | null = null;
    mockedAnalyze.mockImplementation((_img, o) => {
      seen = o.signal;
      return new Promise(() => {}); // never settles on its own
    });
    mockedRequest.mockRejectedValueOnce(new Error('model 404'));
    await expect(driver.run(input({ params: defaultParams(driver.params) }))).rejects.toThrow('model 404');
    expect(seen!.aborted).toBe(true);
  });

  it('relays the analysis progress once the depth is done', async () => {
    let resolve!: (a: HumanAnalysis) => void;
    mockedAnalyze.mockImplementation((_img, o) => {
      o.onProgress?.({ label: { tr: 'yükleniyor', en: 'Loading human detection models…' }, ratio: 0.3 });
      return new Promise<HumanAnalysis>((r) => (resolve = r));
    });
    const inp = input({ params: defaultParams(driver.params) });
    const run = driver.run(inp);
    await vi.waitFor(() => expect(inp.progress.at(-1)?.label.en).toBe('Loading human detection models…'));
    const labels = inp.progress.map((p) => p.label.en);
    expect(labels.indexOf('Post-processing…')).toBeLessThan(labels.lastIndexOf('Loading human detection models…'));
    resolve(fakeAnalysis(W, H));
    await run;
  });
});
