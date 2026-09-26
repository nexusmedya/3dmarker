/**
 * Wire contract of the 3D Marker server's `/api/tripo` routes, shared by the
 * browser driver (./tripo.ts) and the Hono server (server/app.ts) so both
 * sides agree on paths, limits and payload shapes. No DOM or Node APIs here.
 */

export const API_HEALTH_PATH = '/api/health';
export const TRIPO_STATUS_PATH = '/api/tripo/status';
export const TRIPO_TASKS_PATH = '/api/tripo/tasks';

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
