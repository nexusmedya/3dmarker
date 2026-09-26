import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Progress } from '../core/types';
import { DEFAULT_PREP_OPTIONS, type PrepOptions } from './types';
import { createProviderConfig, DEFAULT_AI_SETTINGS, setCurrentAiSettings } from './settings';
import { aiTiming } from './transport';
import { binary, fakeNet, glbBytes, json, PNG_BASE64, pngBlob } from './testing';
import {
  applyMaskToAlpha,
  aspectOf,
  ensureTransparent,
  generateModel,
  generateViewImage,
  hasTransparency,
  prepAspect,
  prepareFrontImage,
  VIEW_LABELS,
  viewAspect,
} from './generate';
import { T_POSE_PROMPT } from './prompts';

const saved = { ...aiTiming };
beforeEach(() => Object.assign(aiTiming, saved, { pollMs: 1 }));
afterEach(() => {
  vi.unstubAllGlobals();
  setCurrentAiSettings(DEFAULT_AI_SETTINGS, false);
});

const opts = (p: Partial<PrepOptions> = {}): PrepOptions => ({ ...DEFAULT_PREP_OPTIONS, ...p });
const ctx = (extra: Record<string, unknown> = {}) => {
  const progress: Progress[] = [];
  return { progress, ctx: { signal: new AbortController().signal, onProgress: (p: Progress) => progress.push(p), isHuman: true, ...extra } };
};
const openaiOk = () => fakeNet().on('POST', 'https://api.openai.com/v1/images/edits', json({ data: [{ b64_json: PNG_BASE64 }] }));

describe('pure helpers', () => {
  it('hasTransparency needs a meaningful share of transparent pixels', () => {
    const img = (alphas: number[]) => ({ width: alphas.length, height: 1, data: new Uint8ClampedArray(alphas.flatMap((a) => [0, 0, 0, a])) });
    expect(hasTransparency(img([255, 255, 255, 255]))).toBe(false);
    expect(hasTransparency(img([255, 0, 255, 255]))).toBe(true);
    const mostlyOpaque = img([...Array(999).fill(255), 200]);
    expect(hasTransparency(mostlyOpaque)).toBe(false);
    expect(hasTransparency(mostlyOpaque, 0.001)).toBe(true);
  });

  it('applyMaskToAlpha clears the background alpha', () => {
    const img = { width: 2, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]) };
    const out = applyMaskToAlpha(img, { width: 2, height: 1, data: new Uint8Array([1, 0]) });
    expect([...out.data]).toEqual([1, 2, 3, 255, 4, 5, 6, 0]);
    expect(img.data[7]).toBe(255);
    expect(() => applyMaskToAlpha(img, { width: 1, height: 1, data: new Uint8Array([1]) })).toThrow();
  });

  it('picks output aspects', () => {
    expect(aspectOf({ width: 1000, height: 500 })).toBe('landscape');
    expect(aspectOf({ width: 500, height: 1000 })).toBe('portrait');
    expect(aspectOf({ width: 500, height: 520 })).toBe('square');
    expect(aspectOf(null)).toBe('square');
    expect(prepAspect(opts({ tPose: true, completeBody: true }), true, { width: 300, height: 900 })).toBe('square');
    expect(prepAspect(opts({ completeBody: true }), true, { width: 900, height: 900 })).toBe('portrait');
    expect(prepAspect(opts({ completeBody: true }), false, { width: 900, height: 300 })).toBe('landscape');
    expect(viewAspect('back', { width: 300, height: 900 })).toBe('portrait');
    expect(viewAspect('top', { width: 300, height: 900 })).toBe('square');
    expect(VIEW_LABELS.left).toEqual({ tr: 'Sol', en: 'Left' });
  });
});

describe('prepareFrontImage', () => {
  it('edits with the prep prompt and aspect, with progress', async () => {
    const net = openaiOk();
    vi.stubGlobal('fetch', net.fetch);
    const cfg = createProviderConfig('openai', { apiKey: 'sk-1' });
    const { ctx: c, progress } = ctx({ bgProvider: null });
    const out = await prepareFrontImage(pngBlob(), opts({ tPose: true, styleId: 'plush', removeBackground: true }), cfg, c);
    expect(out.type).toBe('image/png');
    const form = net.calls[0].form!;
    expect(String(form.get('prompt'))).toContain(T_POSE_PROMPT);
    expect(String(form.get('prompt'))).toContain('plush toy');
    expect(form.get('size')).toBe('1024x1024');
    expect(form.get('background')).toBe('transparent');
    expect(progress[0].label.en).toBe('AI is preparing the image (OpenAI)');
    expect(progress.some((p) => p.label.en.startsWith('AI is preparing the image (OpenAI) · '))).toBe(true);
  });

  it('runs the background-removal provider from the published settings', async () => {
    const net = openaiOk().on('POST', /queue\.fal\.run\/fal-ai\/birefnet\/v2$/, json({ request_id: 'r' }))
      .on('GET', /requests\/r\/status$/, json({ status: 'COMPLETED' }))
      .on('GET', /requests\/r$/, json({ image: { url: `data:image/png;base64,${PNG_BASE64}` } }));
    vi.stubGlobal('fetch', net.fetch);
    const gem = createProviderConfig('gemini', { apiKey: 'AIza' });
    const fal = createProviderConfig('fal', { apiKey: 'k:s' });
    setCurrentAiSettings({ providers: [gem, fal], defaults: { 'background-removal': fal.id }, rememberKeys: false }, false);
    const cfg = createProviderConfig('openai', { apiKey: 'sk-1' });
    await prepareFrontImage(pngBlob(), opts({ styleId: 'marble', removeBackground: true }), cfg, ctx().ctx);
    // Node cannot decode the result, so a configured provider is trusted to make it transparent.
    expect(net.calls.map((c) => c.url)).toContain('https://queue.fal.run/fal-ai/birefnet/v2');
  });

  it('refuses kinds without image editing', async () => {
    await expect(prepareFrontImage(pngBlob(), opts(), createProviderConfig('tripo', { apiKey: 'tsk_abcdefghij' }), ctx().ctx)).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('generateViewImage', () => {
  it('sends the front plus the most useful other views, in a named order', async () => {
    const net = openaiOk();
    vi.stubGlobal('fetch', net.fetch);
    const cfg = createProviderConfig('openai', { apiKey: 'sk-1' });
    const { ctx: c, progress } = ctx({ bgProvider: null });
    await generateViewImage('right', { front: pngBlob(), others: { top: pngBlob(), left: pngBlob(), back: pngBlob(), bottom: pngBlob() } }, opts({ removeBackground: false }), cfg, c);
    const form = net.calls[0].form!;
    expect(form.getAll('image[]')).toHaveLength(4);
    const prompt = String(form.get('prompt'));
    expect(prompt).toContain('image 1 is the front view, image 2 is the back view, image 3 is the left side view, image 4 is the top view');
    expect(prompt).toContain('The subject faces toward the RIGHT edge of the image.');
    expect(form.get('background')).toBe('auto');
    expect(progress[0].label).toEqual({ tr: 'Sağ görünüm üretiliyor (OpenAI)', en: 'Generating the right view (OpenAI)' });
  });
});

describe('ensureTransparent', () => {
  it('returns the image as is without a decoder or a provider (Node)', async () => {
    const img = pngBlob();
    expect(await ensureTransparent(img, { bgProvider: null, signal: new AbortController().signal })).toBe(img);
    // A provider without background removal is skipped as well.
    expect(await ensureTransparent(img, { bgProvider: createProviderConfig('gemini', { apiKey: 'AIza' }), signal: new AbortController().signal })).toBe(img);
  });

  it('uses the given provider', async () => {
    const net = openaiOk();
    vi.stubGlobal('fetch', net.fetch);
    const onProgress = vi.fn();
    await ensureTransparent(pngBlob(), { bgProvider: createProviderConfig('openai', { apiKey: 'sk-1' }), signal: new AbortController().signal, onProgress });
    expect(net.calls[0].form?.get('background')).toBe('transparent');
    expect(onProgress).toHaveBeenCalledWith({ label: { tr: 'Arka plan kaldırılıyor (OpenAI)', en: 'Removing the background (OpenAI)' } });
  });
});

describe('generateModel', () => {
  it('runs toModel and validates the GLB', async () => {
    vi.stubGlobal(
      'fetch',
      fakeNet()
        .on('POST', '/api/tripo/tasks', json({ taskId: 't' }))
        .on('GET', '/api/tripo/tasks/t', json({ status: 'success', progress: 100 }))
        .on('GET', '/api/tripo/tasks/t/model', binary(glbBytes(), 'model/gltf-binary')).fetch,
    );
    const glb = await generateModel(createProviderConfig('tripo', { apiKey: 'tsk_abcdefghij' }), { front: pngBlob() }, { signal: new AbortController().signal, onProgress: () => {} });
    expect(glb.byteLength).toBe(64);
    await expect(generateModel(createProviderConfig('openai', { apiKey: 'sk' }), { front: pngBlob() }, { signal: new AbortController().signal, onProgress: () => {} })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});
