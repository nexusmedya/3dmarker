import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbortError, defaultParams, type DriverInput, type ParamValues, type Progress, type ViewId, type ViewSet } from '../../core/types';
import { LocalizedError } from '../../core/errors';
import { CLIENT_HEADER, MAX_IMAGE_BYTES } from './api';
import { buildMultiviewForm, createTripoMultiviewDriver, pickMultiviewFiles, tripoMultiviewDriver, tripoMultiviewParamsFrom } from './tripoMultiview';

function glb(size = 128): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, size, true);
  return b;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function stubServer(opts: { create?: Response } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body });
      if (url === '/api/tripo/status') return json({ configured: true });
      if (url === '/api/tripo/multiview-tasks') return opts.create ?? json({ taskId: 'mv-1' });
      if (url === '/api/tripo/tasks/mv-1') return json({ status: 'success', progress: 100 });
      if (url === '/api/tripo/tasks/mv-1/model') return new Response(glb(), { headers: { 'content-length': '128' } });
      return json({ error: 'Not found' }, 404);
    }),
  );
  return { calls };
}

const img = (name: string, type = 'image/png') => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type });

function view(id: ViewId, file: Blob) {
  return { id, image: { width: 1, height: 1, data: new Uint8ClampedArray(4) }, mask: null, file, origin: 'upload' as const };
}

function input(views: Partial<Record<ViewId, Blob>>, params: ParamValues = {}) {
  const progress: Progress[] = [];
  const ctl = new AbortController();
  const set: ViewSet = {};
  for (const [id, file] of Object.entries(views) as [ViewId, Blob][]) set[id] = view(id, file);
  const inp: DriverInput = {
    image: { width: 1, height: 1, data: new Uint8ClampedArray(4) },
    mask: null,
    file: img('source.png'),
    views: set,
    params: { ...defaultParams(tripoMultiviewDriver.params), ...params },
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

const driver = () => createTripoMultiviewDriver({ pollIntervalMs: 1 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tripoMultiviewDriver', () => {
  it('declares the multi-view cloud contract', () => {
    expect(tripoMultiviewDriver.id).toBe('tripo3d-multiview');
    expect(tripoMultiviewDriver.category).toBe('cloud');
    expect(tripoMultiviewDriver.badges).toEqual(['api-key', 'full-3d', 'closed-mesh', 'multi-view']);
    expect(tripoMultiviewDriver.views).toBe('required');
    expect(tripoMultiviewDriver.minViews).toEqual([]);
    expect(tripoMultiviewDriver.producesDepth).toBe(false);
    expect(defaultParams(tripoMultiviewDriver.params)).toEqual({
      apiKey: '',
      modelVersion: 'default',
      texture: true,
      pbr: true,
      faceLimit: 0,
      swapSides: false,
    });
  });

  it('uploads the front and side views, polls and returns the GLB', async () => {
    const { calls } = stubServer();
    const { inp, progress } = input({ back: img('back.png'), left: img('left.jpg', 'image/jpeg'), top: img('top.png') }, { apiKey: 'tsk_mine_123456' });
    const res = await driver().run(inp);
    expect(res.kind === 'model' && new Uint8Array(res.glb)).toEqual(glb());
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/tripo/multiview-tasks',
      'GET /api/tripo/tasks/mv-1',
      'GET /api/tripo/tasks/mv-1/model',
    ]);
    const form = calls[0].body as FormData;
    expect((form.get('front') as File).name).toBe('front.png');
    expect((form.get('left') as File).name).toBe('left.jpg');
    expect(form.has('back')).toBe(true);
    expect(form.has('right')).toBe(false);
    expect(form.has('top')).toBe(false);
    expect(form.get('texture')).toBe('true');
    expect(calls.every((c) => c.headers.get(CLIENT_HEADER) === '1' && c.headers.get('x-tripo-key') === 'tsk_mine_123456')).toBe(true);
    expect(progress[0].label.en).toBe('Uploading 3 views to Tripo3D');
    expect(progress[0].label.tr).toBe('3 görünüm Tripo3D’ye yükleniyor');
    expect(progress.at(-1)).toEqual({ label: { tr: 'Tamamlandı', en: 'Done' }, ratio: 1 });
  });

  it('names the missing views when only the front (or only top/bottom) is given', async () => {
    const { calls } = stubServer();
    for (const views of [{}, { top: img('t.png'), bottom: img('b.png') }]) {
      const e = await failure(driver().run(input(views).inp));
      expect(e).toBeInstanceOf(LocalizedError);
      expect((e as LocalizedError).i18n.en).toMatch(/left, back, right view/);
      expect((e as LocalizedError).i18n.tr).toMatch(/sol, arka, sağ/);
    }
    expect(calls).toHaveLength(0);
  });

  it('checks every view before uploading', async () => {
    const { calls } = stubServer();
    const big = new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'big.png', { type: 'image/png' });
    const e = await failure(driver().run(input({ back: big }).inp));
    expect((e as LocalizedError).i18n.en).toMatch(/^Back view: .*20 MB/);
    expect((e as LocalizedError).i18n.tr).toMatch(/^Arka görünüm: .*20 MB/);
    const gif = await failure(driver().run(input({ right: img('r.gif', 'image/gif') }).inp));
    expect((gif as LocalizedError).i18n.en).toMatch(/^Right view: .*PNG, JPEG or WEBP/);
    expect(calls).toHaveLength(0);
  });

  it('maps server errors like the single-image driver', async () => {
    stubServer({ create: json({ error: 'A multi-view task needs at least one of…' }, 400) });
    const e = await failure(driver().run(input({ back: img('b.png') }).inp));
    expect((e as LocalizedError).i18n.en).toMatch(/Tripo3D error: A multi-view task/);
    stubServer({ create: json({ error: 'no key' }, 401) });
    expect(((await failure(driver().run(input({ back: img('b.png') }).inp))) as LocalizedError).i18n.en).toMatch(/No Tripo3D key/);
  });

  it('stops when aborted', async () => {
    const { calls } = stubServer();
    const { inp, ctl } = input({ back: img('b.png') });
    ctl.abort();
    expect(await failure(driver().run(inp))).toBeInstanceOf(AbortError);
    expect(calls).toHaveLength(0);
  });

  it('is available when the API server answers', async () => {
    stubServer();
    expect(await tripoMultiviewDriver.isAvailable!()).toEqual({ ok: true });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const a = await tripoMultiviewDriver.isAvailable!();
    expect(a.ok).toBe(false);
    expect(a.reason?.en).toMatch(/API server/);
  });
});

describe('helpers', () => {
  it('pickMultiviewFiles prefers views.front and ignores top/bottom', () => {
    const front = img('f.png');
    const picked = pickMultiviewFiles({ file: img('src.png'), views: { front: view('front', front), right: view('right', img('r.png')), top: view('top', img('t.png')) } });
    expect(Object.keys(picked).sort()).toEqual(['front', 'right']);
    expect(picked.front).toBe(front);
    const src = img('src.png');
    expect(pickMultiviewFiles({ file: src, views: {} }).front).toBe(src);
  });

  it('buildMultiviewForm swaps sides on request', () => {
    const left = img('l.png');
    const right = img('r.png');
    const params = tripoMultiviewParamsFrom({ swapSides: true, faceLimit: 2000, modelVersion: 'v2.5-20250123' });
    const form = buildMultiviewForm({ front: img('f.png'), left, right }, params);
    expect((form.get('left') as File).size).toBe(right.size);
    expect((form.get('left') as File).name).toBe('left.png');
    expect(form.get('face_limit')).toBe('2000');
    expect(form.get('model_version')).toBe('v2.5-20250123');
    const swappedOnlyLeft = buildMultiviewForm({ front: img('f.png'), left }, params);
    expect(swappedOnlyLeft.has('left')).toBe(false);
    expect(swappedOnlyLeft.has('right')).toBe(true);
    expect(tripoMultiviewParamsFrom({ swapSides: 'yes' }).swapSides).toBe(false);
  });
});
