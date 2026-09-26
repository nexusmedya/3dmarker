/**
 * Stability AI v2beta REST API (multipart; always through the server proxy).
 *
 * ASSUMPTION (no SDK to verify against; from the public API reference):
 *  - POST /v2beta/stable-image/edit/remove-background  image, output_format → image bytes with Accept: image/*
 *  - POST /v2beta/stable-image/control/{structure|sketch}  image, prompt, control_strength, output_format
 *  - POST /v2beta/stable-image/control/style  image, prompt, fidelity, output_format
 *  - POST /v2beta/3d/{stable-fast-3d|stable-point-aware-3d}  image, texture_resolution → model/gltf-binary
 *  - GET  /v1/user/account (key check); errors are { name, errors: [...] }.
 * The endpoint is the "model" id, so other endpoints of the same shape can be typed in.
 */
import type { ProviderAdapter, ProviderConfig } from '../types';
import { aiFetch, AiError, providerName } from '../transport';
import { asGlb, asImage, fileName, modelFor, prepareImages, PROGRESS, unsupported } from './common';

const ENDPOINT = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;

function checkEndpoint(cfg: ProviderConfig, id: string): string {
  if (!ENDPOINT.test(id)) {
    const n = providerName(cfg);
    throw new AiError({ tr: `${n}: geçersiz uç nokta “${id}”.`, en: `${n}: invalid endpoint “${id}”.` }, 'bad-request');
  }
  return id;
}

function strength(cfg: ProviderConfig): string {
  const v = Number(cfg.values.controlStrength);
  return String(Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.7);
}

/** Multipart body of an image endpoint (the path's last segment picks the extra fields). */
export function buildStabilityImageForm(cfg: ProviderConfig, endpoint: string, image: Blob, prompt: string | null): FormData {
  const form = new FormData();
  form.append('image', image, fileName(image, 'image'));
  if (prompt !== null) form.append('prompt', prompt.slice(0, 10_000));
  if (/control\/(structure|sketch)$/.test(endpoint)) form.append('control_strength', strength(cfg));
  if (/control\/style$/.test(endpoint)) form.append('fidelity', strength(cfg));
  form.append('output_format', 'png');
  return form;
}

export function buildStability3dForm(cfg: ProviderConfig, image: Blob): FormData {
  const form = new FormData();
  form.append('image', image, fileName(image, 'image'));
  const tex = cfg.values.textureResolution;
  if (typeof tex === 'string' && /^\d+$/.test(tex)) form.append('texture_resolution', tex);
  return form;
}

export const stabilityAdapter: ProviderAdapter = {
  kind: 'stability',
  async editImage(cfg, req) {
    const name = providerName(cfg);
    const endpoint = checkEndpoint(cfg, modelFor(cfg, 'image-edit'));
    req.onProgress?.(PROGRESS.generating(name));
    const [image] = await prepareImages(req.images.slice(0, 1));
    const res = await aiFetch(cfg, `v2beta/stable-image/${endpoint}`, {
      method: 'POST',
      headers: { Accept: 'image/*' },
      body: buildStabilityImageForm(cfg, endpoint, image, req.prompt),
      signal: req.signal,
    });
    return asImage(await res.blob(), name);
  },
  async removeBackground(cfg, image, signal) {
    const name = providerName(cfg);
    const endpoint = checkEndpoint(cfg, modelFor(cfg, 'background-removal'));
    const [png] = await prepareImages([image]);
    const res = await aiFetch(cfg, `v2beta/stable-image/${endpoint}`, {
      method: 'POST',
      headers: { Accept: 'image/*' },
      body: buildStabilityImageForm(cfg, endpoint, png, null),
      signal,
    });
    return asImage(await res.blob(), name);
  },
  async toModel(cfg, req) {
    const name = providerName(cfg);
    const front = req.views.front;
    if (!front) throw unsupported(cfg, { tr: 'ön görünüm gerekli.', en: 'the front view is required.' });
    const endpoint = checkEndpoint(cfg, modelFor(cfg, 'image-to-3d'));
    req.onProgress?.(PROGRESS.generating(name));
    const [png] = await prepareImages([front]);
    const res = await aiFetch(cfg, `v2beta/3d/${endpoint}`, {
      method: 'POST',
      body: buildStability3dForm(cfg, png),
      signal: req.signal,
    });
    req.onProgress?.(PROGRESS.downloading(name));
    return asGlb(await res.blob(), name);
  },
  async testConnection(cfg, signal) {
    await aiFetch(cfg, 'v1/user/account', { method: 'GET', signal, timeoutMs: 20_000 });
    return { ok: true };
  },
};
