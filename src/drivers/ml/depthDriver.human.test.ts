import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AbortError, defaultParams, type DepthMap, type DriverInput, type Progress } from '../../core/types';
import type { DetailedDepth } from '../../core/mesh/options';
import type { HumanAnalysis } from '../../core/human/types';
import { planCrops } from '../../core/human/enhance';
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
const { HUMAN_PARAMS, humanUnavailableNote } = await import('./depthDriver');
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

  it('keeps the sharp nose tip of the crop pass (no percentile clamping before the fit)', async () => {
    mockedAnalyze.mockResolvedValue(withFace());
    const [job] = planCrops(withFace(), { maxCrops: 6, faces: true, hands: true });
    const nose = face.landmarks[1];
    const sigma = 5; // image px: the nose peak covers well under 1% of the crop… but more than its top 1%
    const ramp = (gx: number) => gx / W;
    // Global pass: a ramp and no nose. Crop pass: the same ramp plus a tall, sharp nose.
    mockedRequest.mockImplementation((j) => {
      const { width: iw, height: ih } = j.image;
      const data = new Float32Array(iw * ih);
      const crop = mockedRequest.mock.calls.length > 1;
      for (let v = 0; v < ih; v++) {
        for (let u = 0; u < iw; u++) {
          const gx = crop ? job.box.x + ((u + 0.5) / iw) * job.box.width : ((u + 0.5) / iw) * W;
          const gy = crop ? job.box.y + ((v + 0.5) / ih) * job.box.height : ((v + 0.5) / ih) * H;
          const peak = crop ? 3 * Math.exp(-((gx - nose.x) ** 2 + (gy - nose.y) ** 2) / (2 * sigma * sigma)) : 0;
          data[v * iw + u] = ramp(gx) + peak;
        }
      }
      return Promise.resolve({ kind: 'depth', data, dims: [1, ih, iw], device: 'webgpu', dtype: 'fp16' } as DepthPayload);
    });
    const res = await driver.run(input({ params: { ...defaultParams(driver.params), faceStrength: 0.0001 } }));
    if (res.kind !== 'depth') throw new Error('expected depth');
    expect(mockedRequest).toHaveBeenCalledTimes(2);
    const at = (x: number, y: number) => res.depth.data[Math.round(y) * W + Math.round(x)];
    const tip = at(nose.x, nose.y);
    const near = (at(nose.x - 4, nose.y) + at(nose.x + 4, nose.y)) / 2; // g ≈ 0.73 of the tip
    const cheek = (at(nose.x - 15, nose.y) + at(nose.x + 15, nose.y)) / 2;
    // A percentile-clamped crop turns the top of the nose into a plateau.
    expect(tip - near).toBeGreaterThan(0.2 * (tip - cheek));
    expect(tip - cheek).toBeGreaterThan(0.1);
  });

  it('skips a crop pass that would be coarser than a high-detail global pass', async () => {
    mockedAnalyze.mockResolvedValue(fakeAnalysis(W, H, { faces: [syntheticFace(200, 150, 50, 60)] }));
    await driver.run(input({ params: defaultParams(driver.params) }));
    expect(mockedRequest).toHaveBeenCalledTimes(2); // global 518 + crop 518
    mockedRequest.mockClear();
    await driver.run(input({ params: { ...defaultParams(driver.params), detail: 840 } }));
    expect(mockedRequest).toHaveBeenCalledTimes(1); // global 840 only
  });

  it('marks the face / hand areas on the depth so the mesh keeps their fine relief', async () => {
    const hand = syntheticHand(320, 200, 30);
    mockedAnalyze.mockResolvedValue(fakeAnalysis(W, H, { faces: [face], hands: [hand] }));
    const res = await driver.run(input({ params: defaultParams(driver.params) }));
    if (res.kind !== 'depth') throw new Error('expected depth');
    const regions = (res.depth as DepthMap & DetailedDepth).detail!;
    expect(regions.map((r) => r.kind)).toEqual(['face', 'hand']);
    const [f, h] = regions;
    // Each region contains its landmark box (plus a margin for ears / finger tips).
    expect(f.x).toBeLessThan(face.box.x);
    expect(f.x + f.width).toBeGreaterThan(face.box.x + face.box.width);
    expect(h.y).toBeLessThan(hand.box.y);
    expect(h.y + h.height).toBeGreaterThan(hand.box.y + hand.box.height);
    // No people → no regions.
    mockedAnalyze.mockResolvedValue(fakeAnalysis(W, H));
    const plain = await driver.run(input({ params: defaultParams(driver.params) }));
    if (plain.kind !== 'depth') throw new Error('expected depth');
    expect((plain.depth as DepthMap & DetailedDepth).detail).toBeUndefined();
  });

  it('says so in the progress when detection is unavailable, and still returns the depth', async () => {
    const blocked: HumanAnalysis = {
      ...fakeAnalysis(W, H),
      unavailableReason: 'Could not load the human detection (face) model: HTTP 403',
      unavailableText: { tr: 'İnsan algılama (yüz) modeli yüklenemedi: HTTP 403', en: 'Could not load the human detection (face) model: HTTP 403' },
    };
    mockedAnalyze.mockResolvedValue(blocked);
    const inp = input({ params: defaultParams(driver.params) });
    const res = await driver.run(inp);
    expect(res.kind).toBe('depth');
    const last = inp.progress.at(-1)!.label;
    expect(last.en).toMatch(/^Human detail unavailable, continuing without face \/ hand relief: .*HTTP 403/);
    expect(last.tr).toMatch(/^İnsan detayı kullanılamadı.*HTTP 403/);
  });

  it('notes partial failures and keeps the detectors that worked', async () => {
    mockedAnalyze.mockResolvedValue({ ...withFace(), failed: { hands: 'timed out' } });
    const inp = input({ params: defaultParams(driver.params) });
    const res = await driver.run(inp);
    if (res.kind !== 'depth') throw new Error('expected depth');
    expect(inp.progress.map((p) => p.label.en)).toContain('Human detail partly unavailable (the hand detection model did not load); continuing with what was found…');
    expect((res.depth as DepthMap & DetailedDepth).detail).toHaveLength(1);
    expect(humanUnavailableNote(withFace())).toBeNull();
    expect(humanUnavailableNote(null)?.en).toMatch(/unknown error/);
  });
});
