import { describe, expect, it, vi } from 'vitest';
import type { AiCapability, AiSettings, ProviderAdapter, ProviderConfig, ToModelRequest } from '../../ai/types';
import { AbortError, defaultParams, type DriverInput, type ParamValues, type Progress, type ViewId, type ViewSet } from '../../core/types';
import { LocalizedError } from '../../core/errors';
import { aiModelDriver, chooseProvider, createAiModelDriver, extraViewIds, type AiModelDeps } from './aiModel';

function glb(size = 64): ArrayBuffer {
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, size, true);
  return b.buffer;
}

const cfg = (id: string, kind: ProviderConfig['kind'], label = ''): ProviderConfig => ({
  id,
  kind,
  label,
  apiKey: 'k',
  values: {},
  models: {},
  enabled: true,
});

const TRIPO = cfg('p-tripo', 'tripo', 'Tripo3D (mine)');
const STAB = cfg('p-stab', 'stability', 'Stability');

/** Fake src/ai: `offers` maps a capability to the provider resolveProvider returns. */
function fakeDeps(offers: Partial<Record<AiCapability, ProviderConfig>>, adapter: Partial<ProviderAdapter> = {}) {
  const settings: AiSettings = { providers: Object.values(offers).filter(Boolean) as ProviderConfig[], defaults: {}, rememberKeys: false };
  const requests: { cfg: ProviderConfig; req: ToModelRequest }[] = [];
  const resolveCalls: unknown[][] = [];
  const toModel = vi.fn(async (c: ProviderConfig, req: ToModelRequest) => {
    requests.push({ cfg: c, req });
    req.onProgress?.({ label: { tr: 'işleniyor', en: 'working' }, ratio: 0.5 });
    return glb();
  });
  const deps: AiModelDeps = {
    currentAiSettings: () => ({ settings, serverAvailable: false }),
    resolveProvider: (s, cap, preferred, server) => {
      resolveCalls.push([s, cap, preferred, server]);
      return offers[cap] ?? null;
    },
    getAdapter: (kind) => ({ kind, toModel, ...adapter }),
  };
  return { deps, requests, toModel, resolveCalls, settings };
}

const png = (name: string) => new File([new Uint8Array([0x89, 0x50])], name, { type: 'image/png' });

function input(views: Partial<Record<ViewId, Blob>> = {}, params: ParamValues = {}) {
  const progress: Progress[] = [];
  const ctl = new AbortController();
  const set: ViewSet = {};
  for (const [id, file] of Object.entries(views) as [ViewId, Blob][]) {
    set[id] = { id, image: { width: 1, height: 1, data: new Uint8ClampedArray(4) }, mask: null, file, origin: 'ai' };
  }
  const inp: DriverInput = {
    image: { width: 1, height: 1, data: new Uint8ClampedArray(4) },
    mask: null,
    file: png('source.png'),
    views: set,
    params: { ...defaultParams(aiModelDriver.params), ...params },
    signal: ctl.signal,
    onProgress: (p) => progress.push(p),
  };
  return { inp, progress, ctl };
}

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('aiModelDriver', () => {
  it('declares the contract', () => {
    expect(aiModelDriver.id).toBe('ai-provider-3d');
    expect(aiModelDriver.category).toBe('cloud');
    expect(aiModelDriver.badges).toEqual(['api-key', 'full-3d', 'multi-view']);
    expect(aiModelDriver.views).toBe('optional');
    expect(aiModelDriver.producesDepth).toBe(false);
    expect(defaultParams(aiModelDriver.params)).toEqual({ preferMultiview: true });
  });

  it('sends every view to a multi-view provider when extra views exist', async () => {
    const f = fakeDeps({ 'multiview-to-3d': TRIPO, 'image-to-3d': STAB });
    const d = createAiModelDriver({ deps: async () => f.deps });
    const back = png('back.png');
    const top = png('top.png');
    const { inp, progress } = input({ back, top });
    const res = await d.run(inp);
    expect(res).toEqual({ kind: 'model', glb: glb() });
    expect(f.requests).toHaveLength(1);
    const { cfg: used, req } = f.requests[0];
    expect(used).toBe(TRIPO);
    expect(Object.keys(req.views).sort()).toEqual(['back', 'front', 'top']);
    expect(req.views.front).toBe(inp.file);
    expect(req.views.back).toBe(back);
    expect(req.signal).toBe(inp.signal);
    expect(f.resolveCalls[0]).toEqual([f.settings, 'multiview-to-3d', null, false]);
    expect(progress[0].label.en).toBe('Turning 3 views into a 3D model with Tripo3D (mine)…');
    expect(progress.map((p) => p.label.en)).toContain('working');
    expect(progress.at(-1)).toEqual({ label: { tr: 'Tamamlandı', en: 'Done' }, ratio: 1 });
  });

  it('falls back to single-image 3D (front only) without views, without a multi-view provider, or when told to', async () => {
    const both = fakeDeps({ 'multiview-to-3d': TRIPO, 'image-to-3d': STAB });
    const d = createAiModelDriver({ deps: async () => both.deps });
    await d.run(input().inp);
    await d.run(input({ back: png('b.png') }, { preferMultiview: false }).inp);
    expect(both.requests.map((r) => [r.cfg.id, Object.keys(r.req.views)])).toEqual([
      ['p-stab', ['front']],
      ['p-stab', ['front']],
    ]);
    const single = fakeDeps({ 'image-to-3d': STAB });
    const { inp, progress } = input({ back: png('b.png') });
    await createAiModelDriver({ deps: async () => single.deps }).run(inp);
    expect(Object.keys(single.requests[0].req.views)).toEqual(['front']);
    expect(progress[0].label.en).toBe('Generating the 3D model with Stability…');
  });

  it('prefers views.front over the source file', async () => {
    const f = fakeDeps({ 'image-to-3d': STAB });
    const front = png('prepared.png');
    await createAiModelDriver({ deps: async () => f.deps }).run(input({ front }).inp);
    expect(f.requests[0].req.views.front).toBe(front);
  });

  it('explains a missing provider in both languages', async () => {
    const f = fakeDeps({});
    const d = createAiModelDriver({ deps: async () => f.deps });
    const e = await failure(d.run(input().inp));
    expect(e).toBeInstanceOf(LocalizedError);
    expect((e as LocalizedError).i18n.en).toMatch(/Add a provider with image-to-3D in AI Providers/i);
    expect((e as LocalizedError).i18n.tr).toMatch(/AI Sağlayıcıları/);
    expect(await d.isAvailable!()).toEqual({ ok: true, reason: expect.objectContaining({ en: expect.stringMatching(/AI Providers/) }) });
    expect(await createAiModelDriver({ deps: async () => fakeDeps({ 'image-to-3d': STAB }).deps }).isAvailable!()).toEqual({ ok: true });
    expect(await createAiModelDriver({ deps: async () => fakeDeps({ 'multiview-to-3d': TRIPO }).deps }).isAvailable!()).toEqual({ ok: true });
    const broken = createAiModelDriver({ deps: () => Promise.reject(new Error('chunk load failed')) });
    expect((await broken.isAvailable!()).reason?.en).toMatch(/AI Providers/);
  });

  it('rejects adapters without toModel and non-GLB results', async () => {
    const noModel = fakeDeps({ 'image-to-3d': STAB }, { toModel: undefined });
    const e = await failure(createAiModelDriver({ deps: async () => noModel.deps }).run(input().inp));
    expect((e as LocalizedError).i18n.en).toMatch(/“Stability” cannot generate 3D models/);
    const junk = fakeDeps({ 'image-to-3d': STAB }, { toModel: async () => new TextEncoder().encode('<html>').buffer as ArrayBuffer });
    const j = await failure(createAiModelDriver({ deps: async () => junk.deps }).run(input().inp));
    expect((j as LocalizedError).i18n.en).toMatch(/did not return a valid GLB/);
  });

  it('passes bilingual adapter errors through and wraps others', async () => {
    const localized = new LocalizedError({ tr: 'anahtar reddedildi', en: 'key rejected' });
    const a = fakeDeps({ 'image-to-3d': STAB }, { toModel: async () => Promise.reject(localized) });
    expect(await failure(createAiModelDriver({ deps: async () => a.deps }).run(input().inp))).toBe(localized);
    const b = fakeDeps({ 'image-to-3d': cfg('x', 'fal') }, { toModel: async () => Promise.reject(new Error('boom')) });
    const e = (await failure(createAiModelDriver({ deps: async () => b.deps }).run(input().inp))) as LocalizedError;
    expect(e.i18n.en).toBe('fal could not generate the 3D model: boom');
    expect(e.i18n.tr).toBe('fal ile 3B model üretilemedi: boom');
  });

  it('turns aborts into AbortError', async () => {
    const ctl = new AbortController();
    const f = fakeDeps(
      { 'image-to-3d': STAB },
      {
        toModel: (_c, req) =>
          new Promise((_resolve, reject) => req.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
      },
    );
    const { inp } = input();
    const p = createAiModelDriver({ deps: async () => f.deps }).run({ ...inp, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 5);
    expect(await failure(p)).toBeInstanceOf(AbortError);
    const pre = new AbortController();
    pre.abort();
    expect(await failure(createAiModelDriver({ deps: async () => f.deps }).run({ ...inp, signal: pre.signal }))).toBeInstanceOf(AbortError);
  });
});

describe('helpers', () => {
  it('extraViewIds lists present views besides the front', () => {
    const { inp } = input({ front: png('f.png'), bottom: png('b.png'), left: png('l.png') });
    expect(extraViewIds(inp)).toEqual(['left', 'bottom']);
  });

  it('chooseProvider', () => {
    const f = fakeDeps({ 'multiview-to-3d': TRIPO, 'image-to-3d': STAB });
    expect(chooseProvider(f.deps, f.settings, true, true)).toEqual({ cfg: TRIPO, cap: 'multiview-to-3d' });
    expect(chooseProvider(f.deps, f.settings, true, false)).toEqual({ cfg: STAB, cap: 'image-to-3d' });
    expect(f.resolveCalls.at(-1)).toEqual([f.settings, 'image-to-3d', null, true]);
  });
});
