/**
 * Wire contract of the 3D Marker server's `/api/tripo` and `/api/ai` routes,
 * shared by the browser drivers / AI adapters and the Hono server
 * (server/app.ts, server/ai/) so both sides agree on paths, limits and
 * payload shapes. No DOM or Node APIs here.
 */
import type { ProviderConfig, ProviderKindId } from '../../ai/types';

export const API_HEALTH_PATH = '/api/health';
export const TRIPO_STATUS_PATH = '/api/tripo/status';
export const TRIPO_TASKS_PATH = '/api/tripo/tasks';
/** POST multipart files `front` (required) + at least one of `left`, `back`, `right`; same optional fields as TRIPO_TASKS_PATH. */
export const TRIPO_MULTIVIEW_TASKS_PATH = '/api/tripo/multiview-tasks';
/** Multipart file fields of TRIPO_MULTIVIEW_TASKS_PATH. */
export const TRIPO_MULTIVIEW_FIELDS = ['front', 'left', 'back', 'right'] as const;
export type TripoMultiviewField = (typeof TRIPO_MULTIVIEW_FIELDS)[number];

export const taskPath = (id: string) => `${TRIPO_TASKS_PATH}/${encodeURIComponent(id)}`;
export const taskModelPath = (id: string) => `${taskPath(id)}/model`;

/** Header carrying the user's own Tripo key (used only when the server has none). */
export const TRIPO_KEY_HEADER = 'x-tripo-key';

/**
 * Sent (with CLIENT_HEADER_VALUE) on every task request by our own client.
 * A custom header cannot come from a plain HTML form, and any other site's
 * fetch that sets it needs a CORS preflight the server never approves, so it
 * blocks cross-site use of the server's key even where browsers omit
 * Sec-Fetch-Site (plain-HTTP origins, older browsers).
 */
export const CLIENT_HEADER = 'x-3dmarker-client';
export const CLIENT_HEADER_VALUE = '1';

/** Largest accepted upload. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Accepted user key format. Tripo keys look like `tsk_…`, but the format is
 * not documented as stable, so any 10–200 char URL-safe token is accepted;
 * this only keeps junk (whitespace, CR/LF, quotes) out of the upstream
 * Authorization header. Tripo itself decides whether the key is valid.
 */
export const API_KEY_PATTERN = /^[A-Za-z0-9_.-]{10,200}$/;

/** Tripo task ids are UUID-like; anything else is rejected before reaching the upstream URL. */
export const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Upstream model_version values are forwarded when they match this (the list shown in the UI lives in the driver). */
export const MODEL_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export const MAX_FACE_LIMIT = 1_000_000;

export type TaskStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'unknown';

/** GET /api/tripo/status */
export interface StatusResponse {
  configured: boolean;
}

/** POST /api/tripo/tasks */
export interface CreateTaskResponse {
  taskId: string;
}

/** Optional multipart fields of POST /api/tripo/tasks (besides the `image` file). */
export interface CreateTaskFields {
  model_version?: string;
  texture?: 'true' | 'false';
  pbr?: 'true' | 'false';
  /** Positive integer; omitted or '0' = let Tripo decide. */
  face_limit?: string;
}

/** Why a task ended with status 'failed' (localised by the client). */
export type TaskFailureReason = 'failed' | 'banned' | 'expired';

/** GET /api/tripo/tasks/:id */
export interface TaskStateResponse {
  status: TaskStatus;
  /** 0..100 */
  progress: number;
  /** Set with status 'failed'. */
  reason?: TaskFailureReason;
  /** English detail for logs and older clients. */
  error?: string;
}

/** Every non-2xx JSON response. */
export interface ApiErrorBody {
  error: string;
}

// --- AI provider routes (server/ai/) -----------------------------------------

/** GET → AiProvidersResponse: providers whose keys live on the server. */
export const AI_PROVIDERS_PATH = '/api/ai/providers';
/**
 * ANY `${AI_PROXY_PATH}/<kind>/<api path>[?query]` → the same request to that
 * kind's fixed API host (see AI_PROXY_BASES), with the server key injected or
 * the user's key (AI_KEY_HEADER) relayed. Needs CLIENT_HEADER. fal: a path
 * starting with `queue/` goes to the queue host.
 */
export const AI_PROXY_PATH = '/api/ai/proxy';
/** GET `${AI_FETCH_PATH}?url=<https URL>` → a provider output file (image / GLB) from an allow-listed host. Needs CLIENT_HEADER. */
export const AI_FETCH_PATH = '/api/ai/fetch';

/** The user's own provider key, relayed upstream by the proxy (never stored, logged or echoed). */
export const AI_KEY_HEADER = 'x-ai-key';
/**
 * Base URL of an 'openai-compatible' / 'custom-http' provider. Those kinds are
 * proxied only when this exact base is listed in the server's AI_PROXY_EXTRA_BASES.
 */
export const AI_BASE_HEADER = 'x-ai-base';
/**
 * How the relayed key authenticates at an AI_PROXY_EXTRA_BASES endpoint:
 * 'bearer' (default, Authorization: Bearer) or 'api-key' (api-key header, Azure style).
 */
export const AI_AUTH_HEADER = 'x-ai-auth';
/** Present (value '1') on errors produced by our proxy itself, absent on relayed upstream answers. */
export const AI_PROXY_ERROR_HEADER = 'x-ai-proxy-error';

/** Largest request body the proxy forwards. */
export const AI_PROXY_MAX_BODY_BYTES = 40 * 1024 * 1024;
/** Largest file AI_FETCH_PATH downloads. */
export const AI_FETCH_MAX_BYTES = 200 * 1024 * 1024;

/** Fixed upstream per proxied kind (the proxy never talks to any other host for them). */
export const AI_PROXY_BASES = {
  openai: 'https://api.openai.com',
  gemini: 'https://generativelanguage.googleapis.com',
  stability: 'https://api.stability.ai',
  replicate: 'https://api.replicate.com',
  /** Paths starting with `queue/` go to https://queue.fal.run (prefix removed). */
  fal: 'https://fal.run',
  tripo: 'https://api.tripo3d.ai',
} as const satisfies Partial<Record<ProviderKindId, string>>;

export type ProxiedKind = keyof typeof AI_PROXY_BASES;

/** `${AI_PROXY_PATH}/<kind>/<path>`; `path` is the upstream path without the host (leading '/' optional, may carry a query). */
export const aiProxyPath = (kind: ProviderKindId, path: string) => `${AI_PROXY_PATH}/${kind}/${path.replace(/^\/+/, '')}`;
export const aiFetchPath = (url: string) => `${AI_FETCH_PATH}?url=${encodeURIComponent(url)}`;

/** GET AI_PROVIDERS_PATH */
export interface AiProvidersResponse {
  /** Managed entries (`managed: true`, `apiKey: ''`, ids 'server-<kind>'). */
  providers: ProviderConfig[];
  /** Kinds the proxy forwards (with a server key or a relayed user key). */
  proxyKinds: ProviderKindId[];
  /** The proxy relays users' own keys (AI_KEY_HEADER). */
  byok: boolean;
}
