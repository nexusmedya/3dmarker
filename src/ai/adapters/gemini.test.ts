import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderConfig } from '../settings';
import { fakeNet, json, PNG_BASE64, pngBlob } from '../testing';
import { buildGenerateBody, geminiAdapter, generatePath, parseGenerateResponse } from './gemini';

const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());

describe('gemini request', () => {
  it('builds the camelCase REST body (verified against @google/genai mldev converters)', async () => {
    const cfg = createProviderConfig('gemini', { values: { imageSize: '2K' } });
    const body = await buildGenerateBody(cfg, { prompt: 'turn around', aspect: 'portrait' }, [pngBlob(), pngBlob()]);
    expect(body).toEqual({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'turn around' }, { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }, { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }],
        },
      ],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:4', imageSize: '2K' } },
    });
    expect(generatePath('models/gemini-2.5-flash-image')).toBe('v1beta/models/gemini-2.5-flash-image:generateContent');
  });

  it('posts to generateContent with x-goog-api-key and returns the final image', async () => {
    const net = fakeNet().on(
      'POST',
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
      json({
        candidates: [
          {
            content: {
              parts: [
                { text: 'Here you go' },
                { inlineData: { mimeType: 'image/png', data: 'AAAA' }, thought: true },
                { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', net.fetch);
    const cfg = createProviderConfig('gemini', { apiKey: 'AIzaTest' });
    const out = await geminiAdapter.editImage!(cfg, { prompt: 'p', images: [pngBlob()], transparentBackground: true, aspect: 'square', signal: signal() });
    expect(out.type).toBe('image/png');
    expect(out.size).toBeGreaterThan(20);
    const call = net.calls[0];
    expect(call.headers.get('x-goog-api-key')).toBe('AIzaTest');
    expect(call.headers.get('content-type')).toBe('application/json');
    expect((call.json as { generationConfig: { imageConfig: unknown } }).generationConfig.imageConfig).toEqual({ aspectRatio: '1:1' });
  });

  it('maps safety blocks and text-only replies to errors', () => {
    expect(() => parseGenerateResponse({ promptFeedback: { blockReason: 'SAFETY' } }, 'Gemini')).toThrow(expect.objectContaining({ code: 'content-policy' }));
    expect(() => parseGenerateResponse({ candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] }, 'Gemini')).toThrow(
      expect.objectContaining({ code: 'content-policy' }),
    );
    expect(() => parseGenerateResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'I cannot do that' }] } }] }, 'Gemini')).toThrow(
      expect.objectContaining({ code: 'bad-response', detail: 'I cannot do that' }),
    );
    // snake_case inline data is accepted too.
    expect(parseGenerateResponse({ candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: PNG_BASE64 } }] } }] }, 'Gemini').type).toBe('image/png');
  });

  it('maps an invalid key (400 INVALID_ARGUMENT) to an auth error', async () => {
    vi.stubGlobal('fetch', fakeNet().on('POST', /./, json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }, 400)).fetch);
    const cfg = createProviderConfig('gemini', { apiKey: 'AIzaBad' });
    await expect(geminiAdapter.editImage!(cfg, { prompt: 'p', images: [pngBlob()], transparentBackground: false, signal: signal() })).rejects.toMatchObject({ code: 'auth' });
  });
});
