import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderConfig } from '../settings';
import { aiTiming } from '../transport';
import { binary, fakeNet, glbBytes, json, pngBlob } from '../testing';
import { buildTripoForm, tripoAdapter } from './tripo';

const signal = () => new AbortController().signal;
const saved = { ...aiTiming };
beforeEach(() => Object.assign(aiTiming, saved, { pollMs: 1, retryBaseMs: 1, retryMaxMs: 2 }));
afterEach(() => vi.unstubAllGlobals());

describe('buildTripoForm', () => {
  it('names the multi-view files front / left / back / right', () => {
    const cfg = createProviderConfig('tripo', { values: { texture: true, pbr: false } });
    const form = buildTripoForm(cfg, 'v2.5-20250123', { front: pngBlob(), back: pngBlob(), left: pngBlob() }, true);
    expect(form.get('front')).toBeInstanceOf(Blob);
    expect(form.get('left')).toBeInstanceOf(Blob);
    expect(form.get('back')).toBeInstanceOf(Blob);
    expect(form.get('right')).toBeNull();
    expect(form.get('image')).toBeNull();
    expect(form.get('model_version')).toBe('v2.5-20250123');
    expect(form.get('texture')).toBe('true');
    expect(form.get('pbr')).toBe('false');
    expect(buildTripoForm(cfg, 'default', { front: pngBlob() }, false).get('model_version')).toBeNull();
  });
});

describe('tripoAdapter', () => {
  it('runs a multi-view task through /api/tripo with the user key', async () => {
    const net = fakeNet()
      .on('POST', '/api/tripo/multiview-tasks', json({ taskId: 't1' }))
      .on('GET', '/api/tripo/tasks/t1', json({ status: 'running', progress: 40 }), json({ status: 'success', progress: 100 }))
      .on('GET', '/api/tripo/tasks/t1/model', binary(glbBytes(), 'model/gltf-binary'));
    vi.stubGlobal('fetch', net.fetch);
    const cfg = createProviderConfig('tripo', { apiKey: 'tsk_abcdefghij' });
    const glb = await tripoAdapter.toModel!(cfg, { views: { front: pngBlob(), right: pngBlob(), top: pngBlob() }, signal: signal() });
    expect(glb.byteLength).toBe(64);
    expect(net.calls[0].headers.get('x-tripo-key')).toBe('tsk_abcdefghij');
    expect(net.calls[0].headers.get('x-3dmarker-client')).toBe('1');
    expect([...net.calls[0].form!.keys()].filter((k) => ['front', 'left', 'back', 'right', 'top'].includes(k))).toEqual(['front', 'right']);
  });

  it('uses the single-image route for image-to-3d and the server key when managed', async () => {
    const net = fakeNet()
      .on('POST', '/api/tripo/tasks', json({ taskId: 't2' }))
      .on('GET', '/api/tripo/tasks/t2', json({ status: 'success', progress: 100 }))
      .on('GET', '/api/tripo/tasks/t2/model', binary(glbBytes(), 'model/gltf-binary'));
    vi.stubGlobal('fetch', net.fetch);
    const cfg = createProviderConfig('tripo', { id: 'server-tripo', managed: true });
    await tripoAdapter.toModel!(cfg, { views: { front: pngBlob(), back: pngBlob() }, capability: 'image-to-3d', signal: signal() });
    expect(net.calls[0].form?.get('image')).toBeInstanceOf(Blob);
    expect(net.calls[0].headers.get('x-tripo-key')).toBeNull();
  });

  it('maps banned tasks and a missing server', async () => {
    vi.stubGlobal('fetch', fakeNet().on('POST', /./, json({ taskId: 't3' })).on('GET', /./, json({ status: 'failed', progress: 0, reason: 'banned' })).fetch);
    const cfg = createProviderConfig('tripo', { apiKey: 'tsk_abcdefghij' });
    await expect(tripoAdapter.toModel!(cfg, { views: { front: pngBlob() }, signal: signal() })).rejects.toMatchObject({ code: 'content-policy' });
    vi.stubGlobal('fetch', fakeNet().on(null, /./, new TypeError('Failed to fetch')).fetch);
    await expect(tripoAdapter.toModel!(cfg, { views: { front: pngBlob() }, signal: signal() })).rejects.toMatchObject({ code: 'needs-server' });
    await expect(tripoAdapter.toModel!(createProviderConfig('tripo', { apiKey: 'bad key!' }), { views: { front: pngBlob() }, signal: signal() })).rejects.toMatchObject({ code: 'key-format' });
  });
});

describe('tripo polling resilience', () => {
  it('retries transient poll and download failures (e.g. our proxy’s 429)', async () => {
    const net = fakeNet()
      .on('POST', '/api/tripo/tasks', json({ taskId: 't2' }))
      .on('GET', '/api/tripo/tasks/t2', json({ error: 'busy' }, 429, { 'retry-after': '0' }), json({}, 502), json({ status: 'success', progress: 100 }))
      .on('GET', '/api/tripo/tasks/t2/model', json({}, 503), binary(glbBytes(), 'model/gltf-binary'));
    vi.stubGlobal('fetch', net.fetch);
    const glb = await tripoAdapter.toModel!(createProviderConfig('tripo', { apiKey: 'tsk_abcdefghij' }), { views: { front: pngBlob() }, signal: signal() });
    expect(glb.byteLength).toBe(64);
  });
});
