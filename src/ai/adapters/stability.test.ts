import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderConfig } from '../settings';
import { binary, fakeNet, glbBytes, json, pngBlob } from '../testing';
import { buildStabilityImageForm, stabilityAdapter } from './stability';

const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());

const png = () => new Response(pngBlob(), { headers: { 'content-type': 'image/png' } });

describe('stabilityAdapter', () => {
  it('sends control/structure through the proxy with the user key', async () => {
    const net = fakeNet().on('POST', '/api/ai/proxy/stability/v2beta/stable-image/control/structure', png());
    vi.stubGlobal('fetch', net.fetch);
    const cfg = createProviderConfig('stability', { apiKey: 'sk-stab', values: { controlStrength: 0.6 } });
    const out = await stabilityAdapter.editImage!(cfg, { prompt: 'bronze statue', images: [pngBlob(), pngBlob()], transparentBackground: false, signal: signal() });
    expect(out.type).toBe('image/png');
    const call = net.calls[0];
    expect(call.headers.get('x-ai-key')).toBe('sk-stab');
    expect(call.headers.get('x-3dmarker-client')).toBe('1');
    expect(call.headers.get('accept')).toBe('image/*');
    expect(call.form?.get('prompt')).toBe('bronze statue');
    expect(call.form?.get('control_strength')).toBe('0.6');
    expect(call.form?.get('output_format')).toBe('png');
    expect(call.form?.getAll('image')).toHaveLength(1);
  });

  it('uses fidelity for the style endpoint', () => {
    const cfg = createProviderConfig('stability', { values: { controlStrength: 0.4 } });
    const form = buildStabilityImageForm(cfg, 'control/style', pngBlob(), 'x');
    expect(form.get('fidelity')).toBe('0.4');
    expect(form.get('control_strength')).toBeNull();
  });

  it('removes backgrounds and builds 3D models', async () => {
    const net = fakeNet()
      .on('POST', '/api/ai/proxy/stability/v2beta/stable-image/edit/remove-background', png())
      .on('POST', '/api/ai/proxy/stability/v2beta/3d/stable-fast-3d', binary(glbBytes(), 'model/gltf-binary'));
    vi.stubGlobal('fetch', net.fetch);
    const cfg = createProviderConfig('stability', { id: 'server-stability', managed: true });
    await stabilityAdapter.removeBackground!(cfg, pngBlob(), signal());
    expect(net.calls[0].form?.get('prompt')).toBeNull();
    expect(net.calls[0].headers.get('x-ai-key')).toBeNull();
    const glb = await stabilityAdapter.toModel!(cfg, { views: { front: pngBlob() }, signal: signal() });
    expect(new Uint8Array(glb.slice(0, 4))).toEqual(new TextEncoder().encode('glTF'));
    expect(net.calls[1].form?.get('texture_resolution')).toBe('1024');
  });

  it('rejects non-GLB models and maps moderation errors', async () => {
    vi.stubGlobal('fetch', fakeNet().on('POST', /3d/, binary(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 'application/octet-stream')).fetch);
    const cfg = createProviderConfig('stability', { apiKey: 'sk-stab' });
    await expect(stabilityAdapter.toModel!(cfg, { views: { front: pngBlob() }, signal: signal() })).rejects.toMatchObject({ code: 'bad-response' });
    vi.stubGlobal('fetch', fakeNet().on('POST', /./, json({ name: 'content_moderation', errors: ['Your request was flagged by our content moderation system'] }, 403)).fetch);
    await expect(stabilityAdapter.editImage!(cfg, { prompt: 'x', images: [pngBlob()], transparentBackground: false, signal: signal() })).rejects.toMatchObject({ code: 'content-policy' });
  });
});
