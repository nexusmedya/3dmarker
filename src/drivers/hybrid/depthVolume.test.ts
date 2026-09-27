import { describe, expect, it, vi } from 'vitest';
import { AbortError, defaultParams, type DriverInput, type ParamValues, type Progress, type RGBAImage } from '../../core/types';
import { LocalizedError } from '../../core/errors';
import { suggestedMeshMode, bestFor } from '../../app/driverMeta';
import { DRIVERS, getDriver } from '../index';
import { createDepthVolumeDriver, volumeOptionsFrom, workSize, type DepthEstimator } from './depthVolume';

/** A transparent PNG-like image with an opaque disk. */
function diskImage(w: number, h: number): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inside = (x + 0.5 - w / 2) ** 2 + (y + 0.5 - h / 2) ** 2 < (0.4 * Math.min(w, h)) ** 2;
      data.set([240, 120, 160, inside ? 255 : 0], i);
    }
  }
  return { width: w, height: h, data };
}

function makeInput(image: RGBAImage, params: ParamValues = {}, signal = new AbortController().signal) {
  const progress: Progress[] = [];
  const d = createDepthVolumeDriver();
  const input: DriverInput = {
    image,
    mask: null,
    file: new Blob([]),
    params: { ...defaultParams(d.params), ...params },
    views: {},
    signal,
    onProgress: (p) => progress.push(p),
  };
  return { input, progress };
}

const fakeEstimator = (): DepthEstimator & { mock: { calls: unknown[][] } } =>
  vi.fn(async ({ mask, width, height }) => {
    const data = new Float32Array(width * height);
    for (let i = 0; i < data.length; i++) if (mask.data[i]) data[i] = 0.5 + 0.5 * Math.sin(i);
    return { width, height, data };
  }) as never;

describe('depth-volume driver', () => {
  it('is registered with the ML drivers, closed-mesh, and keeps the mesh mode', () => {
    const d = getDriver('depth-volume')!;
    expect(d).toBeTruthy();
    expect(d.category).toBe('ml');
    expect(d.badges).toEqual(['download', 'webgpu', 'closed-mesh']);
    expect(d.producesDepth).toBe(false);
    expect(suggestedMeshMode(d)).toBeNull();
    expect(bestFor(d).en).toMatch(/Kirby/);
    expect(DRIVERS.filter((x) => x.id === 'depth-volume')).toHaveLength(1);
  });

  it('runs the depth model at the work size and returns a closed textured geometry', async () => {
    const estimateDepth = fakeEstimator();
    const d = createDepthVolumeDriver({ estimateDepth, mlSupported: () => true });
    const { input, progress } = makeInput(diskImage(120, 80), { resolution: '192' });
    const r = await d.run(input);
    expect(r.kind).toBe('geometry');
    if (r.kind !== 'geometry') return;
    const req = estimateDepth.mock.calls[0][0] as { width: number; height: number; mask: { width: number } };
    expect([req.width, req.height]).toEqual([120, 80]); // smaller than the resolution: kept
    expect(req.mask.width).toBe(120);
    expect(r.geometry.getAttribute('uv')).toBeTruthy();
    expect(r.geometry.getAttribute('color')).toBeUndefined();
    expect((r.geometry.userData.depthVolume as { usedDepth: boolean }).usedDepth).toBe(true);
    expect(progress[progress.length - 1].label.en).toBe('Done');
  });

  it('falls back to the inflated body with a warning when the depth model fails', async () => {
    const estimateDepth = vi.fn(async () => {
      throw new LocalizedError({ tr: 'model indirilemedi', en: 'could not download the model' });
    });
    const d = createDepthVolumeDriver({ estimateDepth, mlSupported: () => true });
    const { input, progress } = makeInput(diskImage(64, 64));
    const r = await d.run(input);
    expect(r.kind).toBe('geometry');
    expect(progress.some((p) => /silhouette volume only.*could not download/.test(p.label.en))).toBe(true);
    expect(progress.some((p) => /yalnızca siluet hacmiyle.*indirilemedi/.test(p.label.tr))).toBe(true);
    if (r.kind === 'geometry') expect((r.geometry.userData.depthVolume as { usedDepth: boolean }).usedDepth).toBe(false);
  });

  it('skips the model where ML is unsupported (and says so)', async () => {
    const estimateDepth = fakeEstimator();
    const d = createDepthVolumeDriver({ estimateDepth, mlSupported: () => false });
    expect((await d.isAvailable!()).reason?.en).toMatch(/silhouette volume/);
    const { input, progress } = makeInput(diskImage(64, 64));
    await d.run(input);
    expect(estimateDepth).not.toHaveBeenCalled();
    expect(progress.some((p) => /cannot run/.test(p.label.en))).toBe(true);
  });

  it('propagates aborts and needs a silhouette', async () => {
    const ac = new AbortController();
    const estimateDepth = vi.fn(async () => {
      ac.abort();
      throw new AbortError();
    });
    const d = createDepthVolumeDriver({ estimateDepth, mlSupported: () => true });
    await expect(d.run(makeInput(diskImage(64, 64), {}, ac.signal).input)).rejects.toBeInstanceOf(AbortError);

    const opaque: RGBAImage = { width: 8, height: 8, data: new Uint8ClampedArray(256).fill(255) };
    await expect(createDepthVolumeDriver({ estimateDepth: fakeEstimator(), mlSupported: () => true }).run(makeInput(opaque).input)).rejects.toThrow(LocalizedError);
  });

  it('parses params and sizes the work grid', () => {
    expect(volumeOptionsFrom({ shape: 'boxy', thickness: 9, backDetail: -1, depthScale: 1.5 })).toEqual({ shape: 'boxy', thickness: 3, backDetail: 0, depthScale: 1.5 });
    expect(volumeOptionsFrom({ shape: 'weird' }).shape).toBe('auto');
    expect(workSize(1024, 512, 320)).toEqual({ width: 320, height: 160 });
    expect(workSize(100, 50, 320)).toEqual({ width: 100, height: 50 });
  });
});
