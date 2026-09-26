import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderConfig } from '../settings';
import { binary, fakeNet, glbBytes, json, PNG_BASE64, pngBlob } from '../testing';
import { buildCustomRequest, customHttpAdapter } from './customHttp';

const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());

describe('buildCustomRequest', () => {
  it('renders URL, headers and a JSON body', async () => {
    const cfg = createProviderConfig('custom-http', {
      apiKey: 'secret-1',
      values: {
        url: 'https://api.example.com/edit?key={{key}}',
        method: 'PUT',
        headers: '{"X-Api-Key": "{{key}}", "X-Empty": ""}',
        body: '{"input": {"text": "{{prompt}}", "img": "{{image_base64}}", "all": "{{images}}"}}',
      },
    });
    const req = await buildCustomRequest(cfg, { prompt: 'hello', images: [pngBlob()] });
    expect(req.url).toBe('https://api.example.com/edit?key=secret-1');
    expect(req.method).toBe('PUT');
    expect(req.headers).toEqual({ 'X-Api-Key': 'secret-1', 'Content-Type': 'application/json' });
    expect(JSON.parse(req.body as string)).toEqual({ input: { text: 'hello', img: PNG_BASE64, all: [`data:image/png;base64,${PNG_BASE64}`] } });
  });

  it('builds multipart bodies with image files', async () => {
    const cfg = createProviderConfig('custom-http', {
      values: { url: 'https://api.example.com/x', bodyType: 'multipart', headers: '', body: '{"file": "{{image}}", "views": "{{images}}", "prompt": "{{prompt}}", "n": 2}' },
    });
    const req = await buildCustomRequest(cfg, { prompt: 'p', images: [pngBlob(), pngBlob()] });
    const form = req.body as FormData;
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect(form.getAll('views')).toHaveLength(2);
    expect(form.get('prompt')).toBe('p');
    expect(form.get('n')).toBe('2');
  });

  it('rejects an invalid URL or template', async () => {
    await expect(buildCustomRequest(createProviderConfig('custom-http', { values: { url: 'ftp://x' } }), {})).rejects.toMatchObject({ code: 'bad-request' });
    await expect(buildCustomRequest(createProviderConfig('custom-http', { values: { url: 'https://x', body: '{bad' } }), {})).rejects.toThrow(/JSON/);
  });
});

describe('customHttpAdapter', () => {
  it('reads base64 from the response path', async () => {
    const net = fakeNet().on('POST', 'https://api.example.com/v1/edit', json({ data: [{ b64_json: PNG_BASE64 }] }));
    vi.stubGlobal('fetch', net.fetch);
    const cfg = createProviderConfig('custom-http', { apiKey: 'k', values: { url: 'https://api.example.com/v1/edit' } });
    const out = await customHttpAdapter.editImage!(cfg, { prompt: 'p', images: [pngBlob()], transparentBackground: false, signal: signal() });
    expect(out.type).toBe('image/png');
    expect(net.calls[0].headers.get('authorization')).toBe('Bearer k');
  });

  it('accepts binary GLB responses and URL results', async () => {
    const net = fakeNet()
      .on('POST', 'https://gpu.example/3d', binary(glbBytes(), 'model/gltf-binary'))
      .on('POST', 'https://gpu.example/3d-url', json({ output: { url: 'https://files.example/m.glb' } }))
      .on('GET', 'https://files.example/m.glb', binary(glbBytes(), 'model/gltf-binary'));
    vi.stubGlobal('fetch', net.fetch);
    const bin = createProviderConfig('custom-http', { values: { capability: 'image-to-3d', url: 'https://gpu.example/3d', responseType: 'binary', body: '{"image":"{{front}}"}' } });
    expect((await customHttpAdapter.toModel!(bin, { views: { front: pngBlob() }, signal: signal() })).byteLength).toBe(64);
    const viaUrl = createProviderConfig('custom-http', { values: { capability: 'image-to-3d', url: 'https://gpu.example/3d-url', responsePath: 'output.url' } });
    expect((await customHttpAdapter.toModel!(viaUrl, { views: { front: pngBlob() }, signal: signal() })).byteLength).toBe(64);
  });

  it('refuses a capability it is not set up for, and a missing path value', async () => {
    const cfg = createProviderConfig('custom-http', { values: { capability: 'image-edit', url: 'https://api.example.com/v1/edit' } });
    await expect(customHttpAdapter.removeBackground!(cfg, pngBlob(), signal())).rejects.toMatchObject({ code: 'unsupported' });
    vi.stubGlobal('fetch', fakeNet().on('POST', /./, json({ other: 1 })).fetch);
    await expect(customHttpAdapter.editImage!(cfg, { prompt: 'p', images: [pngBlob()], transparentBackground: false, signal: signal() })).rejects.toMatchObject({ code: 'bad-response' });
  });
});
