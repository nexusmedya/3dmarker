import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AbortError, defaultParams, type DriverInput, type Progress, type ViewId, type ViewSet } from '../../core/types';
import { LocalizedError } from '../../core/errors';
import { computeMeshStats } from '../../core/mesh/stats';
import { FUSION_TEXT } from '../../core/fusion/reconstruct';
import { renderView, sphere } from '../../core/fusion/testing';
import type { DepthJob, DepthPayload } from '../../workers/mlProtocol';
import type { MlRequestOptions } from '../ml/workerClient';

vi.mock('../ml/workerClient', () => ({
  isMlSupported: () => true,
  requestDepth: vi.fn(),
}));

const { requestDepth } = await import('../ml/workerClient');
const { MULTIVIEW_DRIVERS } = await import('./index');
const { fusionInputs, fusionOptionsFromParams } = await import('./fusion');
const mockedRequest = vi.mocked(requestDepth);

/** Fake worker: a centred dome (disparity, larger = nearer) — the crops are centred on the subject. */
function fakeDepth(job: Omit<DepthJob, 'id' | 'type'>, opts: MlRequestOptions): Promise<DepthPayload> {
  const { width, height } = job.image;
  opts.onProgress?.({ stage: 'inference', device: 'wasm' });
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = (2 * (x + 0.5)) / width - 1, v = (2 * (y + 0.5)) / height - 1;
      data[y * width + x] = Math.sqrt(Math.max(0, 1 - u * u - v * v));
    }
  return Promise.resolve({ kind: 'depth', data, dims: [1, height, width], device: 'wasm', dtype: 'q8' });
}

const driver = MULTIVIEW_DRIVERS[0];
const solid = [sphere([0, 0, 0], 1)];

function viewsOf(ids: ViewId[]): ViewSet {
  const out: ViewSet = {};
  for (const id of ids) {
    const r = renderView(solid, id, { width: 80, height: 80, scale: 32 });
    out[id] = { id, image: r.image, mask: null, file: new Blob(), origin: 'ai' };
  }
  return out;
}

function input(ids: ViewId[], params = {}, signal = new AbortController().signal): DriverInput & { progress: Progress[] } {
  const front = renderView(solid, 'front', { width: 80, height: 80, scale: 32 });
  const progress: Progress[] = [];
  return {
    image: front.image,
    mask: front.mask,
    file: new Blob(),
    views: viewsOf(ids),
    params: { ...defaultParams(driver.params), resolution: 64, ...params },
    signal,
    onProgress: (p) => progress.push(p),
    progress,
  };
}

beforeEach(() => {
  mockedRequest.mockReset();
  mockedRequest.mockImplementation(fakeDepth);
});

describe('MULTIVIEW_DRIVERS', () => {
  it('registers the fusion driver with its contract', () => {
    expect(MULTIVIEW_DRIVERS.map((d) => d.id)).toEqual(['multiview-fusion']);
    expect(driver.category).toBe('multiview');
    expect(driver.badges).toEqual(['multi-view', 'full-3d', 'closed-mesh', 'download']);
    expect(driver.views).toBe('required');
    expect(driver.minViews).toEqual([]);
    expect(driver.producesDepth).toBe(false);
    expect(driver.downloadSizeMB).toBeGreaterThan(0);
    expect(driver.name.tr && driver.name.en && driver.description.tr && driver.description.en).toBeTruthy();
  });

  it('declares valid, bilingual params with unique keys', () => {
    const keys = driver.params.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of driver.params) {
      expect(p.label.tr && p.label.en).toBeTruthy();
      if (p.hint) expect(p.hint.tr && p.hint.en).toBeTruthy();
      if (p.kind === 'number') {
        expect(p.default).toBeGreaterThanOrEqual(p.min);
        expect(p.default).toBeLessThanOrEqual(p.max);
      }
      if (p.kind === 'select') {
        expect(p.options.map((o) => o.value)).toContain(p.default);
        for (const o of p.options) expect(o.label.tr && o.label.en).toBeTruthy();
      }
    }
    expect(keys).toEqual(expect.arrayContaining(['resolution', 'hull', 'tolerance', 'align', 'guard', 'depthRefine', 'depthStrength', 'defaultDepth', 'smoothness', 'smoothIterations', 'colorSharpness', 'maxTriangles']));
    const res = driver.params.find((p) => p.key === 'resolution');
    expect(res).toMatchObject({ min: 64, max: 256, default: 144 });
    expect(driver.params.find((p) => p.key === 'guard')).toMatchObject({ kind: 'number', min: 0, max: 15, default: 6 });
    expect(driver.params.find((p) => p.key === 'align')).toMatchObject({ kind: 'select', default: 'auto' });
    expect(driver.description.tr).toContain('İnce parçalar');
    expect(driver.description.en).toContain('Thin parts');
  });
});

describe('multiview-fusion driver', () => {
  it('fuses the views into a closed, coloured geometry, running depth on every view', async () => {
    const inp = input(['back', 'left']);
    const r = await driver.run(inp);
    expect(r.kind).toBe('geometry');
    if (r.kind !== 'geometry') return;
    expect(r.geometry.getAttribute('color').itemSize).toBe(3);
    expect(r.geometry.getAttribute('normal')).toBeTruthy();
    expect(computeMeshStats(r.geometry).watertight).toBe(true);
    expect(mockedRequest).toHaveBeenCalledTimes(3);
    const job = mockedRequest.mock.calls[0][0];
    expect(job.model).toBe('onnx-community/depth-anything-v2-small');
    expect(job.exactSize).toBe(true);
    expect(job.image.width % 14).toBe(0);
    expect(job.image.height % 14).toBe(0);
    expect(r.geometry.userData.multiview.depth).toEqual({ front: 'model', back: 'model', left: 'model' });
    expect(inp.progress.some((p) => p.label.en.startsWith('Depth: left (3/3) · Estimating depth (WASM)'))).toBe(true);
    // The consistency report travels with the geometry for the 3D step (one entry per contributing view).
    const report = r.geometry.userData.fusion;
    expect(report.views.length).toBe(r.geometry.userData.multiview.views.length);
    expect(report.views.map((v: { id: string }) => v.id)).toEqual(r.geometry.userData.multiview.views);
    expect(Array.isArray(report.warnings)).toBe(true);
  });

  it('uses the selected depth model and skips depth when refinement is off', async () => {
    await driver.run(input(['left'], { depthModel: 'depth-anything-v2-base' }));
    expect(mockedRequest.mock.calls[0][0].model).toBe('onnx-community/depth-anything-v2-base');
    mockedRequest.mockClear();
    const r = await driver.run(input(['left'], { depthRefine: false }));
    expect(mockedRequest).not.toHaveBeenCalled();
    expect(r.kind).toBe('geometry');
  });

  it('falls back to the silhouettes with a warning when the model cannot be downloaded', async () => {
    mockedRequest.mockRejectedValue(new LocalizedError({ tr: 'Yapay zekâ modeli indirilemedi', en: 'Could not download the AI model' }));
    const inp = input(['back', 'right', 'top']);
    const r = await driver.run(inp);
    expect(r.kind).toBe('geometry');
    if (r.kind !== 'geometry') return;
    expect(computeMeshStats(r.geometry).watertight).toBe(true);
    expect(mockedRequest).toHaveBeenCalledTimes(1);
    expect(inp.progress.some((p) => p.label.en.includes(FUSION_TEXT.depthUnavailable.en))).toBe(true);
    expect(r.geometry.userData.multiview.warnings).toContainEqual({ tr: 'Yapay zekâ modeli indirilemedi', en: 'Could not download the AI model' });
  });

  it('needs at least one extra view', async () => {
    await expect(driver.run(input([]))).rejects.toMatchObject({ i18n: FUSION_TEXT.needViews });
  });

  it('aborts', async () => {
    const ac = new AbortController();
    mockedRequest.mockImplementation((_job, opts) => {
      ac.abort();
      return Promise.reject(opts.signal?.aborted ? new AbortError() : new Error('not aborted'));
    });
    await expect(driver.run(input(['back'], {}, ac.signal))).rejects.toBeInstanceOf(AbortError);
  });
});

describe('driver helpers', () => {
  it('maps params to fusion options (tolerance and guard in percent)', () => {
    const o = fusionOptionsFromParams({ ...defaultParams(driver.params), tolerance: 4, hull: 'strict', depthFit: 'ray', guard: 6, align: 'bbox' });
    expect(o.tolerance).toBeCloseTo(0.04);
    expect(o.hull).toBe('strict');
    expect(o.depthFit).toBe('ray');
    expect(o.resolution).toBe(144);
    expect(o.guard).toBeCloseTo(0.06);
    expect(o.align).toBe('bbox');
    expect(fusionOptionsFromParams({}).resolution).toBeUndefined();
    expect(fusionOptionsFromParams({}).guard).toBeUndefined();
    expect(fusionOptionsFromParams({}).align).toBe('auto');
    expect(fusionOptionsFromParams({ guard: 0 }).guard).toBe(0);
    // The back-hull and calibration modes are not params (the core's robust defaults apply).
    expect('hullBack' in fusionOptionsFromParams({})).toBe(false);
    expect('calibration' in fusionOptionsFromParams({})).toBe(false);
  });

  it('takes the front from the source image and every other view from the set, with its alignment; off views are skipped', () => {
    const inp = input(['left', 'top', 'back']);
    inp.views.front = { id: 'front', image: inp.image, mask: null, file: new Blob(), origin: 'source' };
    const align = { mode: 'manual' as const, dx: 0.02, dy: -0.03, scale: 1.05, flipX: false, trust: 'color' as const };
    inp.views.left!.align = align;
    inp.views.back!.align = { ...align, trust: 'off' };
    const views = fusionInputs(inp);
    expect(views.map((v) => v.id)).toEqual(['front', 'left', 'top']);
    expect(views[0].mask).toBe(inp.mask);
    expect(views[0].align).toBeUndefined();
    expect(views[1].align).toBe(align);
    expect(views[2].align).toBeUndefined();
  });
});
