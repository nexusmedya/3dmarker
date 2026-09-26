/**
 * Replicate predictions API (always through the server proxy).
 *
 * Verified against the replicate 1.4 JS client (lib/predictions.js):
 * POST /v1/models/{owner}/{name}/predictions { input } for models run by
 * name, POST /v1/predictions { version, input } for "owner/name:version";
 * 'Prefer: wait[=n]' makes the create call block until done (or the
 * timeout); the Prediction has status 'starting' | 'processing' |
 * 'succeeded' | 'failed' | 'canceled' | 'aborted', output, error and
 * urls.get / urls.cancel; files may be sent as data URIs (the client's
 * 'data-uri' encoding strategy). Output files are downloaded by URL.
 */
import type { ProviderAdapter, ProviderConfig } from '../types';
import { AbortError } from '../../core/types';
import { aiFetch, AiError, aiTiming, AI_ERROR_TEXT, providerName, readJson, sleep } from '../transport';
import { asGlb, asImage, PROGRESS, toModelPlan } from './common';
import { runGeneric, type GenericRequest } from './generic';

export interface Prediction {
  id?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
  logs?: string;
}

const MODEL_REF = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?::([A-Za-z0-9]+))?$/;
const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'aborted']);
const POLICY = /nsfw|safety|flagged|content policy|moderation|sensitive/i;

/** Path and body of the create call for "owner/name" or "owner/name:version". */
export function createRequest(model: string, input: unknown): { path: string; body: Record<string, unknown> } | null {
  const m = MODEL_REF.exec(model.trim());
  if (!m) return null;
  const [, owner, name, version] = m;
  if (version) return { path: 'v1/predictions', body: { version, input } };
  return { path: `v1/models/${owner}/${name}/predictions`, body: { input } };
}

/** Last "NN%" in the logs (many models print tqdm bars). */
function logPercent(logs: unknown): number | undefined {
  if (typeof logs !== 'string') return undefined;
  const all = [...logs.matchAll(/(\d{1,3})%/g)];
  const v = all.length ? Number(all[all.length - 1][1]) : NaN;
  return Number.isFinite(v) && v <= 100 ? v : undefined;
}

export async function runPrediction(cfg: ProviderConfig, model: string, input: unknown, req: GenericRequest): Promise<unknown> {
  const name = providerName(cfg);
  const { signal } = req;
  const create = createRequest(model, input);
  if (!create) {
    throw new AiError(
      { tr: `${name}: model kimliği “sahip/ad” ya da “sahip/ad:sürüm” biçiminde olmalı.`, en: `${name}: the model id must look like “owner/name” or “owner/name:version”.` },
      'bad-request',
    );
  }
  let pred = await readJson<Prediction>(
    await aiFetch(cfg, create.path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'wait=60' },
      body: JSON.stringify(create.body),
      signal,
    }),
    name,
    signal,
  );
  const id = typeof pred.id === 'string' && /^[A-Za-z0-9]+$/.test(pred.id) ? pred.id : null;
  const deadline = Date.now() + aiTiming.maxJobMs;
  try {
    while (!TERMINAL.has(pred.status ?? '')) {
      if (!id) throw new AiError(AI_ERROR_TEXT.badResponse(name, 'no prediction id'), 'bad-response');
      if (Date.now() > deadline) throw new AiError(AI_ERROR_TEXT.timeout(name, Math.round(aiTiming.maxJobMs / 1000)), 'timeout');
      req.onProgress?.(pred.status === 'starting' ? PROGRESS.queued(name) : PROGRESS.generating(name, logPercent(pred.logs)));
      await sleep(aiTiming.pollMs, signal);
      pred = await readJson<Prediction>(await aiFetch(cfg, `v1/predictions/${id}`, { method: 'GET', signal, timeoutMs: aiTiming.pollTimeoutMs }), name, signal);
    }
  } catch (e) {
    if (id && (signal.aborted || e instanceof AbortError)) cancelPrediction(cfg, id);
    throw e;
  }
  if (pred.status === 'succeeded') return pred.output;
  const detail = typeof pred.error === 'string' ? pred.error : pred.error ? JSON.stringify(pred.error) : pred.status ?? '';
  if (POLICY.test(detail)) throw new AiError(AI_ERROR_TEXT.contentPolicy(name, detail.slice(0, 300)), 'content-policy', 0, detail);
  throw new AiError(
    { tr: `${name} tahmini başarısız oldu: ${detail.slice(0, 300)}`, en: `The ${name} prediction failed: ${detail.slice(0, 300)}` },
    'failed',
    0,
    detail,
  );
}

/** Best-effort cancel after the user aborted (the job would otherwise keep billing). */
function cancelPrediction(cfg: ProviderConfig, id: string): void {
  aiFetch(cfg, `v1/predictions/${id}/cancel`, { method: 'POST', signal: new AbortController().signal, timeoutMs: 15_000 }).catch(() => {});
}

const run = (cfg: ProviderConfig) => (model: string, input: unknown, req: GenericRequest) => runPrediction(cfg, model, input, req);

export const replicateAdapter: ProviderAdapter = {
  kind: 'replicate',
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
    await aiFetch(cfg, 'v1/account', { method: 'GET', signal, timeoutMs: 20_000 });
    return { ok: true };
  },
};
