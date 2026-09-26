/**
 * Contracts for the dynamic AI provider registry.
 *
 * A *provider kind* (OpenAI, Google Gemini, Stability, Replicate, fal.ai, an
 * OpenAI-compatible endpoint, a custom HTTP endpoint, Tripo3D…) describes an
 * API: which capabilities it offers, suggested model ids, extra config fields
 * and whether a browser may call it directly (CORS). A *provider config* is
 * one entry the user added in the settings dialog (or the server announced
 * as "managed", its key kept server-side): kind + label + key + chosen model
 * per capability. Any number of configs may exist, several of the same kind.
 *
 * Requests go straight from the browser to the API when the kind allows it
 * and the key is the user's own; otherwise through our server's proxy
 * (/api/ai/proxy/<kind>/<path>, see server/), which injects the server key or
 * relays the user's key (header x-ai-key) and only talks to that kind's fixed
 * API host.
 */
import type { I18nText, ParamSpec, ParamValues, Progress, ViewId } from '../core/types';

export type AiCapability =
  /** Image-to-image with a text instruction: restyle, re-pose, complete, render another view. */
  | 'image-edit'
  /** Return the image with a transparent background. */
  | 'background-removal'
  /** One image → binary glTF. */
  | 'image-to-3d'
  /** Several views (front / back / left / right …) → binary glTF. */
  | 'multiview-to-3d';

export const AI_CAPABILITIES: AiCapability[] = ['image-edit', 'background-removal', 'image-to-3d', 'multiview-to-3d'];

export type ProviderKindId =
  | 'openai'
  | 'gemini'
  | 'stability'
  | 'replicate'
  | 'fal'
  | 'tripo'
  | 'openai-compatible'
  | 'custom-http';

export interface ModelSuggestion {
  id: string;
  label: string;
  note?: I18nText;
}

export interface ProviderKind {
  id: ProviderKindId;
  name: string;
  description: I18nText;
  /** Where to read about the API / get a key. */
  docsUrl: string;
  keyUrl?: string;
  /** Placeholder for the key field, e.g. 'sk-…'. */
  keyPlaceholder?: string;
  capabilities: AiCapability[];
  /** Suggested model ids per capability; the user may type any other id. */
  models: Partial<Record<AiCapability, ModelSuggestion[]>>;
  /** Extra fields besides the API key (base URL, request template…), rendered by the generic param form. */
  fields: ParamSpec[];
  /**
   * The API sends CORS headers, so the browser may call it directly with the
   * user's own key (works on a static deployment without our server).
   * false → requests always go through our server proxy.
   */
  browserDirect: boolean;
}

export interface ProviderConfig {
  /** Unique id of this entry (stable across sessions). */
  id: string;
  kind: ProviderKindId;
  /** User-visible name, e.g. "OpenAI — personal". */
  label: string;
  /** The user's own key; '' for managed entries (key held by the server). */
  apiKey: string;
  /** Announced by the server (GET /api/ai/providers): the key lives server-side. */
  managed?: boolean;
  /** Values for the kind's extra `fields`. */
  values: ParamValues;
  /** Model id chosen per capability (defaults to the kind's first suggestion). */
  models: Partial<Record<AiCapability, string>>;
  enabled: boolean;
}

export interface AiSettings {
  providers: ProviderConfig[];
  /** Provider config id used by default for each capability. */
  defaults: Partial<Record<AiCapability, string>>;
  /**
   * Keep API keys in localStorage (this device). Off → keys live in
   * sessionStorage only and are gone when the tab closes.
   */
  rememberKeys: boolean;
}

/** What the subject is; steers the prompts (T-pose and body completion only make sense for humanoids). */
export type SubjectKind = 'auto' | 'human' | 'character' | 'animal' | 'object';

export type StyleCategory = 'realistic' | 'animated' | 'toy' | 'material' | 'artistic' | 'game';

export interface StylePreset {
  id: string;
  name: I18nText;
  category: StyleCategory;
  /** Prompt fragment describing the look ("…as a glossy vinyl collectible figure…"). No brand / trademark names. */
  prompt: string;
  /** CSS background (gradient) used as the swatch in the style grid. */
  swatch: string;
}

/** Options of the "AI preparation" step, applied to the front view before the other views are generated. */
export interface PrepOptions {
  subject: SubjectKind;
  /** StylePreset id, or null to keep the original look. */
  styleId: string | null;
  /** Re-pose a humanoid into a symmetric T-pose (for rigging). */
  tPose: boolean;
  /** Humanoids shown only partly (e.g. just the head): generate the complete full-length body. */
  completeBody: boolean;
  /** Ask for / produce a transparent background. */
  removeBackground: boolean;
  /** Free text appended to every prompt. */
  extraPrompt: string;
}

export const DEFAULT_PREP_OPTIONS: PrepOptions = {
  subject: 'auto',
  styleId: null,
  tPose: false,
  completeBody: false,
  removeBackground: true,
  extraPrompt: '',
};

export interface ImageEditRequest {
  prompt: string;
  /** Reference images; the first is the primary one to edit. PNG / JPEG / WEBP blobs. */
  images: Blob[];
  /** Ask for a transparent background (providers that cannot do it return an opaque image). */
  transparentBackground: boolean;
  /** Preferred output aspect: square (default), portrait or landscape. */
  aspect?: 'square' | 'portrait' | 'landscape';
  signal: AbortSignal;
  onProgress?: (p: Progress) => void;
}

export interface ToModelRequest {
  /** 'image-to-3d' uses `front`; 'multiview-to-3d' uses every view given. */
  views: Partial<Record<ViewId, Blob>>;
  /**
   * Which capability (and so which configured model) to use. Omitted: multi-view
   * when views besides the front are given and the config offers it, else image-to-3d.
   */
  capability?: 'image-to-3d' | 'multiview-to-3d';
  signal: AbortSignal;
  onProgress?: (p: Progress) => void;
}

/** One adapter per provider kind; methods exist for the capabilities the kind lists. */
export interface ProviderAdapter {
  kind: ProviderKindId;
  /** Returns a PNG (or other image) blob. */
  editImage?(cfg: ProviderConfig, req: ImageEditRequest): Promise<Blob>;
  /** Returns the image with a transparent background (PNG). */
  removeBackground?(cfg: ProviderConfig, image: Blob, signal: AbortSignal): Promise<Blob>;
  /** Returns a binary glTF. */
  toModel?(cfg: ProviderConfig, req: ToModelRequest): Promise<ArrayBuffer>;
  /** Cheap authenticated call to validate the key / endpoint (e.g. list models). */
  testConnection?(cfg: ProviderConfig, signal: AbortSignal): Promise<{ ok: boolean; message?: string }>;
}
