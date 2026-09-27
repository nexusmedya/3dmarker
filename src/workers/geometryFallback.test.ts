/**
 * The fusion driver and the rig's skin weigher go through the geometry
 * worker when there is one, and run the same code on the main thread when
 * there is none or it cannot start.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderView, sphere } from '../core/fusion/testing';
import type { FusionViewInput } from '../core/fusion/types';
import { collectMeshData } from '../rig/meshData';
import { autoPlaceJoints } from '../rig/autoJoints';
import { boneSegments, buildSkeleton } from '../rig/skeleton';
import { makeMannequin } from '../rig/testing';
import { GeometryWorkerClient } from './geometryClient';
import { FakeGeometryWorker } from './geometryTesting';

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('./geometryClient', async (orig) => ({ ...(await orig<typeof import('./geometryClient')>()), getGeometryClient: () => state.client }));
vi.mock('../drivers/ml/workerClient', () => ({ isMlSupported: () => true, requestDepth: vi.fn() }));

const { fuseViews } = await import('../drivers/multiview/fusion');
const { createSkinWeigher } = await import('../rig/weigher');

function views(): FusionViewInput[] {
  return (['front', 'back', 'left'] as const).map((id) => {
    const r = renderView([sphere([0, 0, 0], 1)], id, { width: 80, height: 80, scale: 32 });
    return { id, image: r.image, mask: null };
  });
}
const ctx = () => ({ signal: new AbortController().signal, onProgress: () => {}, depth: null });

function tracked(o: ConstructorParameters<typeof FakeGeometryWorker>[0] = {}) {
  const workers: FakeGeometryWorker[] = [];
  const client = new GeometryWorkerClient(() => {
    const w = new FakeGeometryWorker(o);
    workers.push(w);
    return w;
  });
  return { client, workers };
}

beforeEach(() => {
  state.client = null;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('fuseViews', () => {
  it('runs in the worker when there is one, on the main thread otherwise, with the same result', async () => {
    const main = await fuseViews(views(), { resolution: 48 }, ctx());
    const { client, workers } = tracked();
    state.client = client;
    const off = await fuseViews(views(), { resolution: 48 }, ctx());
    expect(workers[0].sent.map((m) => m.type)).toEqual(['fuse']);
    expect(off.geometry.getAttribute('position').array).toEqual(main.geometry.getAttribute('position').array);
    expect(off.info.report).toEqual(main.info.report);
  });

  it('falls back to the main thread when the worker cannot start', async () => {
    const { client } = tracked({ failToStart: true });
    state.client = client;
    const r = await fuseViews(views(), { resolution: 48 }, ctx());
    expect(r.info.triangles).toBeGreaterThan(0);
    expect(client.usable).toBe(false);
  });

  it('does not fall back on other errors (abort, fusion errors)', async () => {
    const { client } = tracked();
    state.client = client;
    const ac = new AbortController();
    ac.abort();
    await expect(fuseViews(views(), { resolution: 48 }, { ...ctx(), signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(fuseViews(views().slice(0, 1), { resolution: 48 }, ctx())).rejects.toMatchObject({ name: 'LocalizedError' });
  });
});

describe('createSkinWeigher', async () => {
  const m = makeMannequin(1);
  const data = collectMeshData(m.mesh);
  const layout = autoPlaceJoints(m.mesh, { meshData: data });
  const segs = boneSegments(buildSkeleton(layout).names, layout);

  it('weighs on the main thread without a worker, in the worker with one, identically', async () => {
    const here = await createSkinWeigher(data.positions, data.index);
    expect(here.where).toBe('main');
    const a = await here.weigh(segs);
    here.dispose();
    await expect(here.weigh(segs)).rejects.toThrow(/disposed/);

    const { client, workers } = tracked();
    state.client = client;
    const there = await createSkinWeigher(data.positions, data.index);
    expect(there.where).toBe('worker');
    const ratios: number[] = [];
    const b = await there.weigh(segs, { onProgress: (r) => ratios.push(r) });
    expect(b.skinIndex).toEqual(a.skinIndex);
    expect(b.skinWeight).toEqual(a.skinWeight);
    expect(ratios.at(-1)).toBe(1);
    there.dispose();
    await vi.waitFor(() => expect(workers[0].sent.at(-1)?.type).toBe('skin-release'));
  });

  it('re-prepares the mesh in a worker replaced after a crash', async () => {
    const { client, workers } = tracked();
    state.client = client;
    const w = await createSkinWeigher(data.positions, data.index);
    workers[0].fail('crash');
    const r = await w.weigh(segs);
    expect(r.skinWeight.length).toBe((data.positions.length / 3) * 4);
    expect(workers).toHaveLength(2);
    expect(workers[1].sent.map((s) => s.type)).toEqual(['skin-prepare', 'skin-weigh']);
  });

  it('falls back to the main thread when the worker cannot start', async () => {
    const { client } = tracked({ failToStart: true });
    state.client = client;
    const w = await createSkinWeigher(data.positions, data.index);
    expect(w.where).toBe('main');
    expect((await w.weigh(segs)).skinIndex.length).toBe((data.positions.length / 3) * 4);
  });

  it('abort while weighing in the worker rejects with AbortError', async () => {
    const { client } = tracked();
    state.client = client;
    const w = await createSkinWeigher(data.positions, data.index);
    const ac = new AbortController();
    const run = w.weigh(segs, { signal: ac.signal });
    ac.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });
});
