import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderConfig } from '../settings';
import { aiTiming } from '../transport';
import { binary, fakeNet, glbBytes, json, pngBlob } from '../testing';
import { falAdapter, falAppPath } from './fal';
import { buildGenericInput, genericEditImageLimit, outputUrl } from './generic';

const signal = () => new AbortController().signal;
const saved = { ...aiTiming };
beforeEach(() => Object.assign(aiTiming, saved, { pollMs: 1, retryBaseMs: 1, retryMaxMs: 2 }));
afterEach(() => vi.unstubAllGlobals());

describe('falAppPath', () => {
  it('keeps owner/alias (and namespaces) like @fal-ai/client parseEndpointId', () => {
    expect(falAppPath('fal-ai/nano-banana/edit')).toBe('fal-ai/nano-banana');
    expect(falAppPath('fal-ai/hunyuan3d/v2/multi-view')).toBe('fal-ai/hunyuan3d');
    expect(falAppPath('fal-ai/trellis')).toBe('fal-ai/trellis');
    expect(falAppPath('workflows/me/flow')).toBe('workflows/me/flow');
  });
});

describe('fal templates', () => {
  it('fills the verified nano-banana edit input', async () => {
    const cfg = createProviderConfig('fal', { apiKey: 'k' });
    const input = (await buildGenericInput(cfg, 'image-edit', 'fal-ai/nano-banana/edit', { prompt: 'p', images: [pngBlob(), pngBlob()] })) as Record<string, unknown>;
    expect(input.prompt).toBe('p');
    expect(input.image_urls).toHaveLength(2);
    expect(input.output_format).toBe('png');
  });

  it('requires the views a model cannot do without, and swaps sides on request', async () => {
    const cfg = createProviderConfig('fal', { apiKey: 'k' });
    await expect(buildGenericInput(cfg, 'multiview-to-3d', 'fal-ai/hunyuan3d/v2/multi-view', { views: { front: pngBlob(), back: pngBlob() } })).rejects.toMatchObject({ code: 'bad-request' });
    const left = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])], { type: 'image/png' });
    const swapped = createProviderConfig('fal', { apiKey: 'k', values: { swapSides: true } });
    const input = (await buildGenericInput(swapped, 'multiview-to-3d', 'fal-ai/hunyuan3d-v3/image-to-3d', { views: { front: pngBlob(), left } })) as Record<string, unknown>;
    expect(input.right_image_url).toBe('data:image/png;base64,iVBORwE=');
    expect(input.left_image_url).toBeUndefined();
  });
});

describe('falAdapter', () => {
  it('submits to the queue directly with Authorization: Key, polls and downloads', async () => {
    const net = fakeNet()
      .on('POST', 'https://queue.fal.run/fal-ai/nano-banana/edit', json({ request_id: 'r1', status_url: 'x', response_url: 'y' }))
      .on('GET', 'https://queue.fal.run/fal-ai/nano-banana/requests/r1/status', json({ status: 'IN_QUEUE', queue_position: 2 }), json({ status: 'IN_PROGRESS' }), json({ status: 'COMPLETED' }))
      .on('GET', 'https://queue.fal.run/fal-ai/nano-banana/requests/r1', json({ images: [{ url: 'https://v3.fal.media/files/a/out.png', content_type: 'image/png' }], description: '' }))
      .on('GET', 'https://v3.fal.media/files/a/out.png', new Response(pngBlob(), { headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', net.fetch);
    const cfg = createProviderConfig('fal', { apiKey: 'key-id:key-secret' });
    const progress = vi.fn();
    const out = await falAdapter.editImage!(cfg, { prompt: 'p', images: [pngBlob()], transparentBackground: false, signal: signal(), onProgress: progress });
    expect(out.type).toBe('image/png');
    expect(net.calls[0].headers.get('authorization')).toBe('Key key-id:key-secret');
    expect(net.calls[0].headers.get('content-type')).toBe('application/json');
    expect(progress.mock.calls.some(([p]) => p.label.en.includes('position 3'))).toBe(true);
  });

  it('goes through the proxy queue path for managed keys and returns GLBs', async () => {
    const net = fakeNet()
      .on('POST', '/api/ai/proxy/fal/queue/fal-ai/trellis', json({ request_id: 'r2' }))
      .on('GET', '/api/ai/proxy/fal/queue/fal-ai/trellis/requests/r2/status', json({ status: 'COMPLETED' }))
      .on('GET', '/api/ai/proxy/fal/queue/fal-ai/trellis/requests/r2', json({ model_mesh: { url: 'https://v3.fal.media/files/b/model.glb', content_type: 'model/gltf-binary' }, timings: {} }))
      .on('GET', 'https://v3.fal.media/files/b/model.glb', binary(glbBytes(), 'model/gltf-binary'));
    vi.stubGlobal('fetch', net.fetch);
    const cfg = createProviderConfig('fal', { id: 'server-fal', managed: true, models: { 'image-to-3d': 'fal-ai/trellis' } });
    const glb = await falAdapter.toModel!(cfg, { views: { front: pngBlob(), back: pngBlob() }, capability: 'image-to-3d', signal: signal() });
    expect(glb.byteLength).toBe(64);
    expect(Object.keys(net.calls[0].json as object)).toEqual(['image_url']);
    expect(net.calls[0].headers.get('authorization')).toBeNull();
  });

  it('surfaces validation errors from the result call', async () => {
    vi.stubGlobal(
      'fetch',
      fakeNet()
        .on('POST', /queue\.fal\.run\/fal-ai\/birefnet\/v2$/, json({ request_id: 'r3' }))
        .on('GET', /status$/, json({ status: 'COMPLETED' }))
        .on('GET', /requests\/r3$/, json({ detail: [{ loc: ['body', 'image_url'], msg: 'Could not download the image' }] }, 422)).fetch,
    );
    const cfg = createProviderConfig('fal', { apiKey: 'k:s' });
    await expect(falAdapter.removeBackground!(cfg, pngBlob(), signal())).rejects.toMatchObject({ code: 'bad-request', detail: 'body.image_url: Could not download the image' });
  });
});

describe('fal aspect, output paths and reference counts', () => {
  it('passes the wanted aspect to the models that take one, and drops it otherwise', async () => {
    const cfg = createProviderConfig('fal', { apiKey: 'k' });
    const nano = (await buildGenericInput(cfg, 'image-edit', 'fal-ai/nano-banana/edit', { prompt: 'p', images: [pngBlob()], aspect: 'square' })) as Record<string, unknown>;
    expect(nano.aspect_ratio).toBe('1:1');
    const qwen = (await buildGenericInput(cfg, 'image-edit', 'fal-ai/qwen-image-edit', { prompt: 'p', images: [pngBlob()], aspect: 'portrait' })) as Record<string, unknown>;
    expect(qwen.image_size).toBe('portrait_4_3');
    const none = (await buildGenericInput(cfg, 'image-edit', 'fal-ai/nano-banana/edit', { prompt: 'p', images: [pngBlob()] })) as Record<string, unknown>;
    expect('aspect_ratio' in none).toBe(false);
  });

  it('keeps one output path per capability', () => {
    const cfg = createProviderConfig('fal', { apiKey: 'k', values: { modelOutputPath: 'model_glb.url' } });
    // The 3D path must not break image edits of the same entry.
    expect(outputUrl(cfg, 'image-edit', { images: [{ url: 'https://x/a.png' }] }, 'image')).toBe('https://x/a.png');
    expect(outputUrl(cfg, 'image-to-3d', { model_glb: { url: 'https://x/m.glb' }, model_mesh: { url: 'https://x/other.glb' } }, 'model')).toBe('https://x/m.glb');
  });

  it('knows which edit templates carry more than one image', () => {
    expect(genericEditImageLimit(createProviderConfig('fal', { apiKey: 'k', models: { 'image-edit': 'fal-ai/nano-banana/edit' } }))).toBe(Infinity);
    expect(genericEditImageLimit(createProviderConfig('fal', { apiKey: 'k', models: { 'image-edit': 'fal-ai/flux-pro/kontext' } }))).toBe(1);
    expect(genericEditImageLimit(createProviderConfig('fal', { apiKey: 'k', values: { editTemplate: '{"a":"{{image}}","b":"{{image2}}"}' } }))).toBe(Infinity);
  });
});

describe('fal polling resilience', () => {
  const cfg = () => createProviderConfig('fal', { apiKey: 'k:s', models: { 'image-to-3d': 'fal-ai/trellis' } });

  it('retries transient status / result failures instead of losing the paid job', async () => {
    const net = fakeNet()
      .on('POST', 'https://queue.fal.run/fal-ai/trellis', json({ request_id: 'r7' }))
      .on('GET', /requests\/r7\/status$/, json({}, 502), json({ error: 'busy' }, 429, { 'retry-after': '0' }), new TypeError('Failed to fetch'), json({ status: 'COMPLETED' }))
      .on('GET', /requests\/r7$/, json({}, 503), json({ model_mesh: { url: 'https://v3.fal.media/m.glb' } }))
      .on('GET', 'https://v3.fal.media/m.glb', binary(glbBytes(), 'model/gltf-binary'));
    vi.stubGlobal('fetch', net.fetch);
    const glb = await falAdapter.toModel!(cfg(), { views: { front: pngBlob() }, signal: signal() });
    expect(glb.byteLength).toBe(64);
    expect(net.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('cancels the job when polling keeps failing', async () => {
    const net = fakeNet()
      .on('PUT', /requests\/r8\/cancel$/, json({}))
      .on('POST', 'https://queue.fal.run/fal-ai/trellis', json({ request_id: 'r8' }))
      .on('GET', /requests\/r8\/status$/, json({}, 500));
    vi.stubGlobal('fetch', net.fetch);
    await expect(falAdapter.toModel!(cfg(), { views: { front: pngBlob() }, signal: signal() })).rejects.toMatchObject({ code: 'server' });
    expect(net.calls.filter((c) => c.url.endsWith('/status'))).toHaveLength(aiTiming.retryAttempts);
    await new Promise((r) => setTimeout(r, 5));
    expect(net.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });
});
