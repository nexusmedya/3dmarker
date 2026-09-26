/**
 * fal.ai queue API (direct from the browser with the user's key, or through
 * the proxy for managed keys: paths starting with 'queue/' go to
 * https://queue.fal.run).
 *
 * Verified against @fal-ai/client 1.10 (src/queue.js, request.js, utils.js):
 * submit POST https://queue.fal.run/{endpoint} with the JSON input and
 * 'Authorization: Key …' → { request_id, status_url, response_url };
 * status GET /{owner}/{alias}/requests/{id}/status → { status: 'IN_QUEUE' |
 * 'IN_PROGRESS' | 'COMPLETED', queue_position }; result GET
 * /{owner}/{alias}/requests/{id}; cancel PUT …/cancel. Status and result
 * paths drop the endpoint's sub-path (e.g. "/edit"), except that the
 * 'workflows' / 'comfy' namespaces keep three segments. The client calls
 * fal from browsers with mode 'cors' (it only warns about exposed keys).
 * ASSUMPTION: image inputs may be data URIs (the client passes them through
 * untouched instead of uploading).
 */
import type { ProviderAdapter, ProviderConfig } from '../types';
import { AbortError } from '../../core/types';
import { aiFetch, AiError, aiTiming, AI_ERROR_TEXT, providerName, readJson, sleep } from '../transport';
import { asGlb, asImage, PROGRESS, toModelPlan } from './common';
import { runGeneric, type GenericRequest } from './generic';

const ENDPOINT = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/;
const NAMESPACES = ['workflows', 'comfy'];

/** "owner/alias" (or "ns/owner/alias") of an endpoint id, as the queue status / result paths use it. */
export function falAppPath(endpoint: string): string {
  const parts = endpoint.split('/');
  return (NAMESPACES.includes(parts[0]) ? parts.slice(0, 3) : parts.slice(0, 2)).join('/');
}

interface QueueStatus {
  status?: string;
  queue_position?: number;
  error?: unknown;
}

export async function runFalJob(cfg: ProviderConfig, model: string, input: unknown, req: GenericRequest): Promise<unknown> {
  const name = providerName(cfg);
  const { signal } = req;
  if (!ENDPOINT.test(model)) {
    throw new AiError(
      { tr: `${name}: model kimliği “sahip/ad[/yol]” biçiminde olmalı (ör. fal-ai/trellis).`, en: `${name}: the model id must look like “owner/name[/path]” (e.g. fal-ai/trellis).` },
      'bad-request',
    );
  }
  const submitted = await readJson<{ request_id?: string }>(
    await aiFetch(cfg, `queue/${model}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
      signal,
    }),
    name,
    signal,
  );
  const id = typeof submitted.request_id === 'string' && /^[A-Za-z0-9_-]+$/.test(submitted.request_id) ? submitted.request_id : null;
  if (!id) throw new AiError(AI_ERROR_TEXT.badResponse(name, 'no request id'), 'bad-response');
  const base = `queue/${falAppPath(model)}/requests/${id}`;
  const deadline = Date.now() + aiTiming.maxJobMs;
  try {
    for (;;) {
      if (Date.now() > deadline) throw new AiError(AI_ERROR_TEXT.timeout(name, Math.round(aiTiming.maxJobMs / 1000)), 'timeout');
      const st = await readJson<QueueStatus>(await aiFetch(cfg, `${base}/status`, { method: 'GET', signal, timeoutMs: aiTiming.pollTimeoutMs }), name, signal);
      if (st.status === 'COMPLETED') {
        if (st.error) {
          const d = typeof st.error === 'string' ? st.error : JSON.stringify(st.error);
          throw new AiError({ tr: `${name} işi başarısız oldu: ${d.slice(0, 300)}`, en: `The ${name} job failed: ${d.slice(0, 300)}` }, 'failed', 0, d);
        }
        break;
      }
      req.onProgress?.(st.status === 'IN_QUEUE' ? PROGRESS.queued(name, typeof st.queue_position === 'number' ? st.queue_position : undefined) : PROGRESS.generating(name));
      await sleep(aiTiming.pollMs, signal);
    }
  } catch (e) {
    if (signal.aborted || e instanceof AbortError) cancelJob(cfg, base);
    throw e;
  }
  return readJson<unknown>(await aiFetch(cfg, base, { method: 'GET', signal, timeoutMs: aiTiming.pollTimeoutMs }), name, signal);
}

/** Best-effort cancel after the user aborted. */
function cancelJob(cfg: ProviderConfig, base: string): void {
  aiFetch(cfg, `${base}/cancel`, { method: 'PUT', signal: new AbortController().signal, timeoutMs: 15_000 }).catch(() => {});
}

const run = (cfg: ProviderConfig) => (model: string, input: unknown, req: GenericRequest) => runFalJob(cfg, model, input, req);

export const falAdapter: ProviderAdapter = {
  kind: 'fal',
  async editImage(cfg, req) {
    const blob = await runGeneric(cfg, 'image-edit', { prompt: req.prompt, images: req.images, signal: req.signal, onProgress: req.onProgress }, 'image', run(cfg));
    return asImage(blob, providerName(cfg));
  },
  async removeBackground(cfg, image, signal) {
    const blob = await runGeneric(cfg, 'background-removal', { images: [image], signal }, 'image', run(cfg));
    return asImage(blob, providerName(cfg));
  },
  async toModel(cfg, req) {
    const { cap, views } = toModelPlan(cfg, req);
    const blob = await runGeneric(cfg, cap, { views, signal: req.signal, onProgress: req.onProgress }, 'model', run(cfg));
    return asGlb(blob, providerName(cfg));
  },
  async testConnection(cfg, signal) {
    // ASSUMPTION: an unknown request id on a public app answers 404 with a valid key and 401/403 with a bad one.
    try {
      await aiFetch(cfg, 'queue/fal-ai/flux/requests/00000000-0000-0000-0000-000000000000/status', { method: 'GET', signal, timeoutMs: 20_000 });
    } catch (e) {
      if (e instanceof AiError && (e.code === 'not-found' || e.code === 'bad-request')) return { ok: true };
      throw e;
    }
    return { ok: true };
  },
};
