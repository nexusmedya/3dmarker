import { describe, expect, it, vi } from 'vitest';
import { LocalizedError } from '../core/errors';
import { AbortError, type Progress, type ViewId } from '../core/types';
import { FUSION_TEXT, reconstructFromViews } from '../core/fusion/reconstruct';
import type { FusionViewInput } from '../core/fusion/types';
import { renderView, sphere } from '../core/fusion/testing';
import { collectMeshData } from '../rig/meshData';
import { autoPlaceJoints } from '../rig/autoJoints';
import { boneSegments, buildSkeleton } from '../rig/skeleton';
import { computeSkinWeights, prepareSkinning } from '../rig/skinning';
import { makeMannequin } from '../rig/testing';
import { GEOMETRY_TEXT, GeometryWorkerClient, GeometryWorkerUnavailableError, getGeometryClient } from './geometryClient';
import { buffersOf, deserializeError, serializeError } from './geometryProtocol';
import { FakeGeometryWorker } from './geometryTesting';
import type { DepthInfer, FusionDepthSpec } from './fusionDepth';

const solid = [sphere([0, 0, 0], 1)];
function views(ids: ViewId[]): FusionViewInput[] {
  return ids.map((id) => {
    const r = renderView(solid, id, { width: 80, height: 80, scale: 32 });
    return { id, image: r.image, mask: id === 'front' ? r.mask : null };
  });
}
const OPTIONS = { resolution: 48 };

function wired(o: ConstructorParameters<typeof FakeGeometryWorker>[0] = {}) {
  const workers: FakeGeometryWorker[] = [];
  const client = new GeometryWorkerClient(() => {
    const w = new FakeGeometryWorker(o);
    workers.push(w);
    return w;
  });
  return { client, workers };
}

/** A centred dome (disparity), shaped like the depth model's raw output. */
const domeInfer: DepthInfer = async (job) => {
  const { width, height } = job.image;
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = (2 * (x + 0.5)) / width - 1, v = (2 * (y + 0.5)) / height - 1;
      data[y * width + x] = Math.sqrt(Math.max(0, 1 - u * u - v * v));
    }
  return { data, dims: [1, height, width] };
};
const SPEC: FusionDepthSpec = { model: 'onnx-community/depth-anything-v2-small', convention: 'disparity', nativeSide: 518, patchMultiple: 14 };

describe('geometry protocol', () => {
  it('keeps the name and bilingual text of errors across the boundary', () => {
    const loc = new LocalizedError({ tr: 'Türkçe', en: 'English' });
    loc.name = 'DepthOfflineError';
    const back = deserializeError(structuredClone(serializeError(loc)));
    expect(back).toBeInstanceOf(LocalizedError);
    expect((back as LocalizedError).i18n).toEqual({ tr: 'Türkçe', en: 'English' });
    expect(back.name).toBe('DepthOfflineError');
    expect(back.message).toBe(loc.message);

    const plain = deserializeError(serializeError(new TypeError('bad')));
    expect(plain).not.toBeInstanceOf(LocalizedError);
    expect([plain.name, plain.message]).toEqual(['TypeError', 'bad']);
    expect(serializeError('text')).toEqual({ name: 'Error', message: 'text' });

    const abort = deserializeError(serializeError(new AbortError()), { AbortError: () => new AbortError() });
    expect(abort).toBeInstanceOf(AbortError);
  });

  it('transfers only arrays that span their whole buffer', () => {
    const whole = new Float32Array(4), big = new Float32Array(8), view = big.subarray(2, 4);
    expect(buffersOf(whole, whole, view)).toEqual([whole.buffer]);
  });
});

describe('GeometryWorkerClient ↔ GeometryHost', () => {
  it('fuses in the worker with the same result as on the main thread, progress included', async () => {
    const inputs = views(['front', 'back', 'left']);
    const direct = await reconstructFromViews(inputs, OPTIONS, { signal: new AbortController().signal, onProgress: () => {} });
    const { client } = wired();
    const progress: Progress[] = [];
    const r = await client.fuse(inputs, OPTIONS, { signal: new AbortController().signal, onProgress: (p) => progress.push(p) });
    // The caller's images are copied, not transferred.
    expect(inputs[0].image.data.byteLength).toBeGreaterThan(0);
    expect(r.geometry.getAttribute('position').array).toEqual(direct.geometry.getAttribute('position').array);
    expect(r.geometry.getAttribute('color').array).toEqual(direct.geometry.getAttribute('color').array);
    expect(r.geometry.getIndex()!.array).toEqual(direct.geometry.getIndex()!.array);
    expect(r.geometry.boundingSphere).not.toBeNull();
    expect(r.info.triangles).toBe(direct.info.triangles);
    expect(r.geometry.userData.fusion).toEqual(direct.info.report);
    expect(r.geometry.userData.multiview.views).toEqual(['front', 'back', 'left']);
    expect(progress.map((p) => p.label.en)).toEqual(expect.arrayContaining([FUSION_TEXT.hull.en, FUSION_TEXT.finish.en]));
  });

  it('relays the depth-model runs to the main thread; the worker prepares and post-processes', async () => {
    const { client } = wired();
    const jobs: { width: number; height: number; model: string; exactSize: boolean }[] = [];
    const infer: DepthInfer = async (job, o) => {
      jobs.push({ width: job.image.width, height: job.image.height, model: job.model, exactSize: job.exactSize });
      o.onProgress({ stage: 'inference', device: 'wasm' });
      return domeInfer(job, o);
    };
    const progress: Progress[] = [];
    const r = await client.fuse(views(['front', 'back', 'left']), OPTIONS, {
      signal: new AbortController().signal,
      onProgress: (p) => progress.push(p),
      depth: { spec: SPEC, infer },
    });
    expect(jobs).toHaveLength(3);
    for (const j of jobs) {
      expect(j).toMatchObject({ model: SPEC.model, exactSize: true });
      expect(j.width % 14).toBe(0);
      expect(j.height % 14).toBe(0);
    }
    expect(r.info.depth).toEqual({ front: 'model', back: 'model', left: 'model' });
    expect(progress.some((p) => p.label.en.startsWith('Depth: left (3/3) · Estimating depth (WASM)'))).toBe(true);
  });

  it('an offline depth model becomes the fusion\'s own warning, and the fusion carries on', async () => {
    const { client } = wired();
    const offline: DepthInfer = () =>
      Promise.reject(new LocalizedError({ tr: 'Model indirilemedi [Failed to fetch]', en: 'Could not download the model [Failed to fetch]' }));
    const r = await client.fuse(views(['front', 'back', 'left']), OPTIONS, {
      signal: new AbortController().signal,
      onProgress: () => {},
      depth: { spec: SPEC, infer: offline },
    });
    expect(r.info.warnings[0]).toEqual(FUSION_TEXT.depthOffline);
    expect(r.info.triangles).toBeGreaterThan(0);
  });

  it('fusion errors arrive with their bilingual text', async () => {
    const { client } = wired();
    const err = await client.fuse(views(['front']), OPTIONS, { signal: new AbortController().signal, onProgress: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalizedError);
    expect((err as LocalizedError).i18n).toEqual(FUSION_TEXT.needViews);
  });

  it('abort rejects at once and cancels the worker job; the worker stays usable', async () => {
    const { client, workers } = wired();
    const ac = new AbortController();
    const labels: string[] = [];
    const run = client.fuse(views(['front', 'back', 'left']), { resolution: 96 }, {
      signal: ac.signal,
      onProgress: (p) => {
        labels.push(p.label.en);
        if (p.label.en === FUSION_TEXT.hull.en) ac.abort();
      },
    });
    await expect(run).rejects.toBeInstanceOf(AbortError);
    expect(workers[0].sent.some((m) => m.type === 'cancel')).toBe(true);
    await vi.waitFor(() => expect(workers[0].host.busy).toBe(0));
    expect(labels).not.toContain(FUSION_TEXT.finish.en);
    // An aborted signal never reaches the worker.
    await expect(client.fuse(views(['front', 'left']), OPTIONS, { signal: ac.signal, onProgress: () => {} })).rejects.toBeInstanceOf(AbortError);
    const again = await client.fuse(views(['front', 'left']), OPTIONS, { signal: new AbortController().signal, onProgress: () => {} });
    expect(again.info.triangles).toBeGreaterThan(0);
    expect(workers).toHaveLength(1);
  });

  it('skin weights: prepared once, weighed in the worker, identical to the main thread', async () => {
    const m = makeMannequin(1);
    const data = collectMeshData(m.mesh);
    const layout = autoPlaceJoints(m.mesh, { meshData: data });
    const segs = boneSegments(buildSkeleton(layout).names, layout);
    const direct = await computeSkinWeights(prepareSkinning(data.positions, data.index), segs);

    const { client, workers } = wired();
    const key = await client.skinPrepare(data.positions, data.index);
    // The caller keeps its arrays (copies are transferred).
    expect(data.positions.byteLength).toBeGreaterThan(0);
    const ratios: number[] = [];
    const plain = segs.map((s) => ({ bone: s.bone, index: s.index, head: { ...s.head }, tail: { ...s.tail } }));
    const w = await client.skinWeigh(key, plain, {}, { onProgress: (r) => ratios.push(r) });
    expect(w.skinIndex).toEqual(direct.skinIndex);
    expect(w.skinWeight).toEqual(direct.skinWeight);
    expect(ratios.at(-1)).toBe(1);
    // A second weigh reuses the prepared mesh.
    await client.skinWeigh(key, plain, { smoothIterations: 0 });
    expect(workers[0].sent.filter((s) => s.type === 'skin-prepare')).toHaveLength(1);
    client.skinRelease(key);
    expect(client.hasSkin(key)).toBe(false);
    await expect(client.skinWeigh(key, plain, {})).rejects.toThrow(/not prepared/);
  });

  it('a worker that cannot start rejects with GeometryWorkerUnavailableError and is not retried', async () => {
    const { client, workers } = wired({ failToStart: true });
    const err = await client.fuse(views(['front', 'left']), OPTIONS, { signal: new AbortController().signal, onProgress: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GeometryWorkerUnavailableError);
    expect((err as LocalizedError).i18n).toEqual(GEOMETRY_TEXT.unavailable);
    expect(client.usable).toBe(false);
    await expect(client.skinPrepare(new Float32Array(9), new Uint32Array([0, 1, 2]))).rejects.toBeInstanceOf(GeometryWorkerUnavailableError);
    expect(workers).toHaveLength(1);

    const throwing = new GeometryWorkerClient(() => {
      throw new Error('Worker is not defined');
    });
    await expect(throwing.fuse([], OPTIONS, { signal: new AbortController().signal, onProgress: () => {} })).rejects.toBeInstanceOf(GeometryWorkerUnavailableError);
    expect(throwing.usable).toBe(false);
  });

  it('a crash mid-job rejects with a bilingual error; the next call gets a fresh worker', async () => {
    const { client, workers } = wired();
    const run = client.fuse(views(['front', 'back', 'left']), { resolution: 96 }, {
      signal: new AbortController().signal,
      onProgress: (p) => {
        if (p.label.en === FUSION_TEXT.hull.en) workers[0].fail('out of memory');
      },
    });
    const err = await run.catch((e: unknown) => e);
    expect((err as LocalizedError).i18n).toEqual(GEOMETRY_TEXT.crashed);
    expect(workers[0].terminated).toBe(true);
    expect(client.usable).toBe(true);
    const r = await client.fuse(views(['front', 'left']), OPTIONS, { signal: new AbortController().signal, onProgress: () => {} });
    expect(r.info.triangles).toBeGreaterThan(0);
    expect(workers).toHaveLength(2);
  });

  it('without Worker (Node) there is no client: callers stay on the main thread', () => {
    expect(typeof Worker).toBe('undefined');
    expect(getGeometryClient()).toBeNull();
  });
});
