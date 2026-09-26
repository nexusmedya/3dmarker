import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AbortError } from '../../core/types';
import { createProviderConfig } from '../settings';
import { aiTiming } from '../transport';
import { binary, fakeNet, glbBytes, json, pngBlob } from '../testing';
import { createRequest, replicateAdapter } from './replicate';

const signal = () => new AbortController().signal;
const saved = { ...aiTiming };
beforeEach(() => Object.assign(aiTiming, saved, { pollMs: 1 }));
afterEach(() => vi.unstubAllGlobals());

const png = () => new Response(pngBlob(), { headers: { 'content-type': 'image/png' } });

describe('createRequest', () => {
  it('uses the model route by name and the predictions route with a version', () => {
    expect(createRequest('black-forest-labs/flux-kontext-pro', { a: 1 })).toEqual({ path: 'v1/models/black-forest-labs/flux-kontext-pro/predictions', body: { input: { a: 1 } } });
    expect(createRequest('firtoz/trellis:abc123', { a: 1 })).toEqual({ path: 'v1/predictions', body: { version: 'abc123', input: { a: 1 } } });
    expect(createRequest('not a model', {})).toBeNull();
  });
});

describe('replicateAdapter', () => {
  it('creates a prediction with Prefer: wait, polls, then downloads the output', async () => {
    const net = fakeNet()
      .on('POST', '/api/ai/proxy/replicate/v1/models/black-forest-labs/flux-kontext-pro/predictions', json({ id: 'p1', status: 'starting' }))
      .on('GET', '/api/ai/proxy/replicate/v1/predictions/p1', json({ id: 'p1', status: 'processing', logs: '50%' }), json({ id: 'p1', status: 'succeeded', output: 'https://replicate.delivery/x/out.png' }))
      .on('GET', 'https://replicate.delivery/x/out.png', png());
    vi.stubGlobal('fetch', net.fetch);
    const cfg = createProviderConfig('replicate', { apiKey: 'r8_key' });
    const progress = vi.fn();
    const out = await replicateAdapter.editImage!(cfg, { prompt: 'make it clay', images: [pngBlob()], transparentBackground: false, signal: signal(), onProgress: progress });
    expect(out.type).toBe('image/png');
    const create = net.calls[0];
    expect(create.headers.get('prefer')).toBe('wait=60');
    expect(create.headers.get('x-ai-key')).toBe('r8_key');
    const input = (create.json as { input: Record<string, unknown> }).input;
    expect(input.prompt).toBe('make it clay');
    expect(String(input.input_image)).toMatch(/^data:image\/png;base64,/);
    expect(input.aspect_ratio).toBe('match_input_image');
    expect(net.calls.filter((c) => c.url.endsWith('/v1/predictions/p1'))).toHaveLength(2);
    expect(progress.mock.calls.some(([p]) => p.ratio === 0.5)).toBe(true);
  });

  it('honours a custom input template and output path', async () => {
    const net = fakeNet()
      .on('POST', /predictions$/, json({ id: 'p2', status: 'succeeded', output: { result: { mesh: 'https://replicate.delivery/y/m.glb' } } }))
      .on('GET', 'https://replicate.delivery/y/m.glb', binary(glbBytes(), 'model/gltf-binary'));
    vi.stubGlobal('fetch', net.fetch);
    const cfg = createProviderConfig('replicate', {
      apiKey: 'r8_key',
      models: { 'multiview-to-3d': 'me/mv:v9' },
      values: { multiviewTemplate: '{"f":"{{front}}","b":"{{back}}","l":"{{left}}","seed":1}', outputPath: 'result.mesh' },
    });
    const glb = await replicateAdapter.toModel!(cfg, { views: { front: pngBlob(), back: pngBlob() }, signal: signal() });
    expect(glb.byteLength).toBe(64);
    const body = net.calls[0].json as { version: string; input: Record<string, unknown> };
    expect(net.calls[0].url).toBe('/api/ai/proxy/replicate/v1/predictions');
    expect(body.version).toBe('v9');
    expect(Object.keys(body.input).sort()).toEqual(['b', 'f', 'seed']); // missing left dropped
  });

  it('reports failed predictions (content policy separately)', async () => {
    vi.stubGlobal('fetch', fakeNet().on('POST', /./, json({ id: 'p3', status: 'failed', error: 'NSFW content detected' })).fetch);
    const cfg = createProviderConfig('replicate', { apiKey: 'r8_key' });
    await expect(replicateAdapter.removeBackground!(cfg, pngBlob(), signal())).rejects.toMatchObject({ code: 'content-policy' });
    vi.stubGlobal('fetch', fakeNet().on('POST', /./, json({ id: 'p4', status: 'failed', error: 'CUDA out of memory' })).fetch);
    await expect(replicateAdapter.removeBackground!(cfg, pngBlob(), signal())).rejects.toMatchObject({ code: 'failed', detail: 'CUDA out of memory' });
  });

  it('cancels the prediction when aborted', async () => {
    const ctl = new AbortController();
    const net = fakeNet()
      .on('POST', /predictions\/p5\/cancel$/, json({}))
      .on('POST', /predictions$/, json({ id: 'p5', status: 'processing' }))
      .on('GET', /predictions\/p5$/, () => {
        ctl.abort();
        return json({ id: 'p5', status: 'processing' });
      });
    vi.stubGlobal('fetch', net.fetch);
    const cfg = createProviderConfig('replicate', { apiKey: 'r8_key' });
    await expect(replicateAdapter.removeBackground!(cfg, pngBlob(), ctl.signal)).rejects.toBeInstanceOf(AbortError);
    await new Promise((r) => setTimeout(r, 5));
    expect(net.calls.some((c) => c.url.endsWith('/v1/predictions/p5/cancel'))).toBe(true);
  });
});
