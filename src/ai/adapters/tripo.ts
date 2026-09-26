/**
 * Tripo3D through our server's /api/tripo routes (the wire contract of
 * src/drivers/cloud/api.ts): POST /api/tripo/tasks (multipart "image") or
 * POST /api/tripo/multiview-tasks (multipart front / left / back / right, at
 * least front + one), then GET /api/tripo/tasks/:id until 'success' and GET
 * /api/tripo/tasks/:id/model for the GLB. The user's own key travels in
 * x-tripo-key; managed configs use the server's key.
 */
import type { ViewId } from '../../core/types';
import { AbortError } from '../../core/types';
import type { ProviderAdapter, ProviderConfig } from '../types';
import {
  API_KEY_PATTERN,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  TRIPO_KEY_HEADER,
  TRIPO_MULTIVIEW_FIELDS,
  TRIPO_MULTIVIEW_TASKS_PATH,
  TRIPO_STATUS_PATH,
  TRIPO_TASKS_PATH,
  taskModelPath,
  taskPath,
  type CreateTaskResponse,
  type StatusResponse,
  type TaskStateResponse,
} from '../../drivers/cloud/api';
import { AiError, aiTiming, AI_ERROR_TEXT, cleanKey, providerName, readJson, send, sleep } from '../transport';
import { asGlb, fileName, modelFor, prepareImages, PROGRESS, toModelPlan } from './common';

/** Views the multi-view route takes (Tripo's own order). */
export const TRIPO_VIEWS: ViewId[] = [...TRIPO_MULTIVIEW_FIELDS];

function headersFor(cfg: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = { [CLIENT_HEADER]: CLIENT_HEADER_VALUE };
  if (cfg.managed) return headers;
  const key = cleanKey(cfg.apiKey);
  const name = providerName(cfg);
  if (!key) throw new AiError(AI_ERROR_TEXT.missingKey(name), 'missing-key');
  if (!API_KEY_PATTERN.test(key)) {
    throw new AiError(
      { tr: `${name} API anahtarı geçersiz biçimde (tsk_…).`, en: `The ${name} API key has an invalid format (tsk_…).` },
      'key-format',
    );
  }
  headers[TRIPO_KEY_HEADER] = key;
  return headers;
}

/** Multipart body of the create call. */
export function buildTripoForm(cfg: ProviderConfig, model: string, views: Partial<Record<ViewId, Blob>>, multiview: boolean): FormData {
  const form = new FormData();
  if (multiview) {
    for (const v of TRIPO_VIEWS) if (views[v]) form.append(v, views[v], fileName(views[v], v));
  } else if (views.front) {
    form.append('image', views.front, fileName(views.front, 'image'));
  }
  if (model && model !== 'default') form.append('model_version', model);
  form.append('texture', String(cfg.values.texture !== false));
  form.append('pbr', String(cfg.values.pbr !== false));
  return form;
}

export const tripoAdapter: ProviderAdapter = {
  kind: 'tripo',
  async toModel(cfg, req) {
    const name = providerName(cfg);
    const { signal } = req;
    const ctx = { name, route: 'proxy' as const, key: cfg.managed ? undefined : cleanKey(cfg.apiKey) };
    const headers = headersFor(cfg);
    const plan = toModelPlan(cfg, req);
    const views: Partial<Record<ViewId, Blob>> = {};
    for (const v of TRIPO_VIEWS) if (plan.views[v]) views[v] = (await prepareImages([plan.views[v]]))[0];
    const multiview = plan.cap === 'multiview-to-3d' && Object.keys(views).length > 1;
    const model = modelFor(cfg, multiview ? 'multiview-to-3d' : 'image-to-3d');

    req.onProgress?.(PROGRESS.sending(name));
    const created = await readJson<CreateTaskResponse>(
      await send(multiview ? TRIPO_MULTIVIEW_TASKS_PATH : TRIPO_TASKS_PATH, { method: 'POST', headers, body: buildTripoForm(cfg, model, views, multiview), signal }, ctx),
      name,
      signal,
    );
    if (typeof created.taskId !== 'string' || !created.taskId) throw new AiError(AI_ERROR_TEXT.badResponse(name, 'no task id'), 'bad-response');
    const deadline = Date.now() + aiTiming.maxJobMs;
    for (;;) {
      await sleep(aiTiming.pollMs, signal);
      if (Date.now() > deadline) throw new AiError(AI_ERROR_TEXT.timeout(name, Math.round(aiTiming.maxJobMs / 1000)), 'timeout');
      const st = await readJson<TaskStateResponse>(await send(taskPath(created.taskId), { method: 'GET', headers, signal, timeoutMs: aiTiming.pollTimeoutMs }, ctx), name, signal);
      if (st.status === 'success') break;
      if (st.status === 'failed' || st.status === 'cancelled') {
        const d = st.reason === 'banned' ? 'content moderation' : st.reason ?? st.error ?? st.status;
        if (st.reason === 'banned') throw new AiError(AI_ERROR_TEXT.contentPolicy(name, ''), 'content-policy', 0, d);
        throw new AiError({ tr: `${name} model üretemedi (${d}).`, en: `${name} could not generate a model (${d}).` }, 'failed', 0, d);
      }
      const pct = Math.max(0, Math.min(100, Math.round(Number(st.progress) || 0)));
      req.onProgress?.(st.status === 'queued' && !pct ? PROGRESS.queued(name) : PROGRESS.generating(name, pct));
    }
    req.onProgress?.(PROGRESS.downloading(name));
    const res = await send(taskModelPath(created.taskId), { method: 'GET', headers, signal, timeoutMs: aiTiming.downloadTimeoutMs }, ctx);
    if (signal.aborted) throw new AbortError();
    return asGlb(await res.blob(), name);
  },
  async testConnection(cfg, signal) {
    const res = await send(TRIPO_STATUS_PATH, { method: 'GET', signal, timeoutMs: 10_000 }, { name: providerName(cfg), route: 'proxy' });
    const body = await readJson<Partial<StatusResponse>>(res, providerName(cfg), signal);
    if (cfg.managed && body.configured !== true) return { ok: false, message: 'Sunucuda Tripo anahtarı tanımlı değil / The server has no Tripo key configured' };
    // A user key cannot be checked without creating a (paid) task; only the server route is verified.
    return {
      ok: true,
      message: cfg.managed ? undefined : 'Sunucuya ulaşıldı; anahtar ilk görevde denetlenir / Server reachable; the key is checked on the first task',
    };
  },
};
