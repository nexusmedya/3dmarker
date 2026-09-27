/**
 * Skin weights for one mesh, computed repeatedly (the auto-rig, then every
 * joint edit): in the geometry worker when there is one (the mesh is welded /
 * BVH-indexed there once and kept under a key), else on the main thread
 * (Node tests, old browsers, a worker that could not start), time-sliced.
 */
import { AbortError } from '../core/types';
import { yieldToPaint } from '../core/yield';
import { getGeometryClient, GeometryWorkerUnavailableError, type GeometryWorkerClient } from '../workers/geometryClient';
import type { SegmentPayload } from '../workers/geometryProtocol';
import type { BoneSegment } from './skeleton';
import { computeSkinWeights, prepareSkinning, type SkinningOptions, type SkinPrep, type SkinWeights } from './skinning';

export interface SkinWeigher {
  /** Where the weights are computed. */
  readonly where: 'worker' | 'main';
  weigh(segments: BoneSegment[], options?: Partial<SkinningOptions>): Promise<SkinWeights>;
  /** Free the prepared mesh (here or in the worker). */
  dispose(): void;
}

const toPayload = (s: BoneSegment[]): SegmentPayload[] =>
  s.map((x) => ({ bone: x.bone, index: x.index, head: { x: x.head.x, y: x.head.y, z: x.head.z }, tail: { x: x.tail.x, y: x.tail.y, z: x.tail.z } }));

function mainThreadWeigher(prep: SkinPrep): SkinWeigher {
  let p: SkinPrep | null = prep;
  return {
    where: 'main',
    weigh(segments, options) {
      if (!p) return Promise.reject(new Error('Skin weigher disposed'));
      return computeSkinWeights(p, segments, options);
    },
    dispose() {
      if (p) p.bvh = null;
      p = null;
    },
  };
}

async function prepareHere(positions: Float32Array, index: Uint32Array, signal?: AbortSignal): Promise<SkinWeigher> {
  await yieldToPaint();
  if (signal?.aborted) throw new AbortError();
  return mainThreadWeigher(prepareSkinning(positions, index));
}

function workerWeigher(client: GeometryWorkerClient, positions: Float32Array, index: Uint32Array, first: number): SkinWeigher {
  let key: number | null = first;
  let disposed = false;
  let fallback: SkinWeigher | null = null;
  return {
    get where() {
      return fallback ? fallback.where : ('worker' as const);
    },
    async weigh(segments, options = {}) {
      if (disposed) throw new Error('Skin weigher disposed');
      if (fallback) return fallback.weigh(segments, options);
      const { signal, onProgress, ...rest } = options;
      try {
        // A worker replaced after a crash lost the prepared mesh: prepare it again.
        if (key === null || !client.hasSkin(key)) key = await client.skinPrepare(positions, index, signal);
        if (disposed) throw new AbortError();
        return await client.skinWeigh(key, toPayload(segments), rest, { signal, onProgress });
      } catch (e) {
        if (!(e instanceof GeometryWorkerUnavailableError)) throw e;
        fallback = await prepareHere(positions, index, signal);
        return fallback.weigh(segments, options);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (key !== null) client.skinRelease(key);
      key = null;
      fallback?.dispose();
    },
  };
}

/**
 * Prepare `positions` / `index` (input vertex order, as collectMeshData
 * gives them) for weighing. The arrays are not modified; the worker gets
 * copies.
 */
export async function createSkinWeigher(positions: Float32Array, index: Uint32Array, signal?: AbortSignal): Promise<SkinWeigher> {
  const client = getGeometryClient();
  if (client) {
    try {
      const key = await client.skinPrepare(positions, index, signal);
      return workerWeigher(client, positions, index, key);
    } catch (e) {
      if (!(e instanceof GeometryWorkerUnavailableError)) throw e;
      console.warn('rig: geometry worker unavailable, weighing on the main thread');
    }
  }
  if (signal?.aborted) throw new AbortError();
  return mainThreadWeigher(prepareSkinning(positions, index));
}
