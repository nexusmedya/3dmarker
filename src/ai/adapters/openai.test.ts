import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderConfig } from '../settings';
import { AiError } from '../transport';
import { fakeNet, json, PNG_BASE64, pngBlob } from '../testing';
import { buildEditForm, openAiAdapter, openAiCompatibleAdapter, openAiSize, REMOVE_BG_PROMPT } from './openai';

const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());

describe('openAiSize', () => {
  it('matches the wanted aspect by default and honours explicit settings', () => {
    expect(openAiSize('match', 'portrait')).toBe('1024x1536');
    expect(openAiSize('match', 'landscape')).toBe('1536x1024');
    expect(openAiSize('match', 'square')).toBe('1024x1024');
    expect(openAiSize('match', undefined)).toBe('auto');
    expect(openAiSize('auto', 'portrait')).toBe('auto');
    expect(openAiSize('1536x1024', 'portrait')).toBe('1536x1024');
  });
});

describe('buildEditForm', () => {
  it('uses the GPT image fields (verified against openai-node ImageEditParams)', () => {
    const cfg = createProviderConfig('openai', { values: { quality: 'high', inputFidelity: 'high', size: 'match' } });
    const form = buildEditForm(cfg, 'gpt-image-1.5', { prompt: 'p', transparentBackground: true, aspect: 'portrait' }, [pngBlob()]);
    expect(form.get('model')).toBe('gpt-image-1.5');
    expect(form.get('prompt')).toBe('p');
    expect(form.get('image')).toBeInstanceOf(Blob);
    expect(form.getAll('image[]')).toHaveLength(0);
    expect(form.get('background')).toBe('transparent');
    expect(form.get('output_format')).toBe('png');
    expect(form.get('quality')).toBe('high');
    expect(form.get('input_fidelity')).toBe('high');
    expect(form.get('size')).toBe('1024x1536');
  });

  it('sends several references as image[] and skips unsupported fields', () => {
    const cfg = createProviderConfig('openai', { values: { quality: 'auto' } });
    const form = buildEditForm(cfg, 'gpt-image-1-mini', { prompt: 'p', transparentBackground: false }, [pngBlob(), pngBlob(), pngBlob()]);
    expect(form.getAll('image[]')).toHaveLength(3);
    expect(form.get('image')).toBeNull();
    expect(form.get('background')).toBe('auto');
    expect(form.get('quality')).toBeNull();
    expect(form.get('input_fidelity')).toBeNull(); // not for the mini
    expect(form.get('size')).toBe('auto');
  });

  it('keeps unknown (compatible) models to the common fields', () => {
    const cfg = createProviderConfig('openai-compatible', { values: { baseUrl: 'https://x/v1', size: 'auto' } });
    const form = buildEditForm(cfg, 'some-model', { prompt: 'p', transparentBackground: true, aspect: 'square' }, [pngBlob()]);
    expect([...form.keys()].sort()).toEqual(['image', 'model', 'prompt']);
  });
});

describe('openAiAdapter', () => {
  it('posts a multipart edit and decodes data[0].b64_json', async () => {
    const net = fakeNet().on('POST', 'https://api.openai.com/v1/images/edits', json({ created: 1, data: [{ b64_json: PNG_BASE64 }] }));
    vi.stubGlobal('fetch', net.fetch);
    const cfg = createProviderConfig('openai', { apiKey: 'sk-test' });
    const progress = vi.fn();
    const out = await openAiAdapter.editImage!(cfg, { prompt: 'make it a statue', images: [pngBlob()], transparentBackground: true, aspect: 'square', signal: signal(), onProgress: progress });
    expect(out.type).toBe('image/png');
    const call = net.calls[0];
    expect(call.headers.get('authorization')).toBe('Bearer sk-test');
    expect(call.form?.get('model')).toBe('gpt-image-1.5');
    expect(call.form?.get('prompt')).toBe('make it a statue');
    expect(call.form?.get('size')).toBe('1024x1024');
    expect(progress).toHaveBeenCalled();
  });

  it('removes backgrounds with the background-removal model and a transparent background', async () => {
    const net = fakeNet().on('POST', /images\/edits$/, json({ data: [{ b64_json: PNG_BASE64 }] }));
    vi.stubGlobal('fetch', net.fetch);
    const cfg = createProviderConfig('openai', { apiKey: 'sk-test', models: { 'background-removal': 'gpt-image-1' } });
    await openAiAdapter.removeBackground!(cfg, pngBlob(), signal());
    expect(net.calls[0].form?.get('model')).toBe('gpt-image-1');
    expect(net.calls[0].form?.get('background')).toBe('transparent');
    expect(net.calls[0].form?.get('prompt')).toBe(REMOVE_BG_PROMPT);
  });

  it('downloads url results and maps moderation errors', async () => {
    vi.stubGlobal(
      'fetch',
      fakeNet()
        .on('POST', 'https://gw.example/v1/images/edits', json({ data: [{ url: 'https://cdn.example/out.png' }] }))
        .on('GET', 'https://cdn.example/out.png', new Response(pngBlob(), { headers: { 'content-type': 'image/png' } })).fetch,
    );
    const compat = createProviderConfig('openai-compatible', { apiKey: 'k', values: { baseUrl: 'https://gw.example/v1' } });
    expect((await openAiCompatibleAdapter.editImage!(compat, { prompt: 'p', images: [pngBlob()], transparentBackground: false, signal: signal() })).type).toBe('image/png');

    vi.stubGlobal('fetch', fakeNet().on('POST', /./, json({ error: { message: 'Your request was rejected by the safety system', code: 'moderation_blocked' } }, 400)).fetch);
    const cfg = createProviderConfig('openai', { apiKey: 'sk-test' });
    await expect(openAiAdapter.editImage!(cfg, { prompt: 'p', images: [pngBlob()], transparentBackground: false, signal: signal() })).rejects.toMatchObject({ code: 'content-policy' });
  });

  it('rejects a response without an image', async () => {
    vi.stubGlobal('fetch', fakeNet().on('POST', /./, json({ data: [] })).fetch);
    const cfg = createProviderConfig('openai', { apiKey: 'sk-test' });
    await expect(openAiAdapter.editImage!(cfg, { prompt: 'p', images: [pngBlob()], transparentBackground: false, signal: signal() })).rejects.toBeInstanceOf(AiError);
  });

  it('tests the connection with GET /v1/models', async () => {
    const net = fakeNet().on('GET', 'https://api.openai.com/v1/models', json({ data: [] }));
    vi.stubGlobal('fetch', net.fetch);
    expect(await openAiAdapter.testConnection!(createProviderConfig('openai', { apiKey: 'sk-test' }), signal())).toEqual({ ok: true });
  });
});
