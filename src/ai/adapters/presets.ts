/**
 * Built-in input templates of the generic kinds' suggested models. A
 * template the user typed in the provider's settings always wins; unknown
 * models fall back to a per-capability default.
 */
import type { ViewId } from '../../core/types';
import type { AiCapability, ProviderConfig } from '../types';
import { templateKey } from '../kinds';

export interface ModelPreset {
  template: Record<string, unknown>;
  /** Views besides the front the model cannot do without. */
  requires?: ViewId[];
}

const P = '{{prompt}}';
/** '1:1' / '3:4' / '4:3' when an aspect is wanted; the key is dropped otherwise (the model keeps the input's). */
const AR = '{{aspect}}';
/** fal's image_size preset ('square_hd' / 'portrait_4_3' / 'landscape_4_3'), dropped when no aspect is wanted. */
const SIZE = '{{image_size}}';

/**
 * fal.ai, verified against the @fal-ai/client 1.10 endpoint types
 * (src/types/endpoints.d.ts): input field names and output shapes
 * (images[].url, image.url, model_mesh.url, model_glb.url).
 */
export const FAL_PRESETS: Record<string, ModelPreset> = {
  'fal-ai/nano-banana/edit': { template: { prompt: P, image_urls: '{{images}}', output_format: 'png', num_images: 1, aspect_ratio: AR } },
  'fal-ai/nano-banana-pro/edit': { template: { prompt: P, image_urls: '{{images}}', output_format: 'png', num_images: 1, aspect_ratio: AR } },
  'fal-ai/flux-pro/kontext': { template: { prompt: P, image_url: '{{image}}', output_format: 'png', aspect_ratio: AR } },
  'fal-ai/flux-pro/kontext/max': { template: { prompt: P, image_url: '{{image}}', output_format: 'png', aspect_ratio: AR } },
  'fal-ai/bytedance/seedream/v4/edit': { template: { prompt: P, image_urls: '{{images}}', num_images: 1, image_size: SIZE } },
  'fal-ai/qwen-image-edit': { template: { prompt: P, image_url: '{{image}}', output_format: 'png', image_size: SIZE } },
  'fal-ai/birefnet': { template: { image_url: '{{image}}', output_format: 'png', refine_foreground: true } },
  'fal-ai/birefnet/v2': { template: { image_url: '{{image}}', output_format: 'png', refine_foreground: true } },
  'fal-ai/bria/background/remove': { template: { image_url: '{{image}}' } },
  'fal-ai/imageutils/rembg': { template: { image_url: '{{image}}' } },
  'fal-ai/trellis': { template: { image_url: '{{image}}' } },
  'fal-ai/trellis-2': { template: { image_url: '{{image}}' } },
  'fal-ai/hunyuan3d/v2': { template: { input_image_url: '{{image}}', textured_mesh: true } },
  'fal-ai/hunyuan3d-v21': { template: { input_image_url: '{{image}}', textured_mesh: true } },
  'fal-ai/hunyuan3d-v3/image-to-3d': {
    template: { input_image_url: '{{front}}', back_image_url: '{{back}}', left_image_url: '{{left}}', right_image_url: '{{right}}' },
  },
  'fal-ai/hunyuan3d/v2/multi-view': {
    template: { front_image_url: '{{front}}', back_image_url: '{{back}}', left_image_url: '{{left}}', textured_mesh: true },
    requires: ['back', 'left'],
  },
  'fal-ai/triposr': { template: { image_url: '{{image}}', output_format: 'glb' } },
  'tripo3d/tripo/v2.5/image-to-3d': { template: { image_url: '{{image}}', texture: 'standard', pbr: true } },
  'tripo3d/tripo/v2.5/multiview-to-3d': {
    template: {
      front_image_url: '{{front}}',
      back_image_url: '{{back}}',
      left_image_url: '{{left}}',
      right_image_url: '{{right}}',
      texture: 'standard',
      pbr: true,
    },
  },
};

/** ASSUMPTION: Replicate model inputs as shown on the model pages at the time of writing (no typed schema available). */
export const REPLICATE_PRESETS: Record<string, ModelPreset> = {
  'black-forest-labs/flux-kontext-pro': { template: { prompt: P, input_image: '{{image}}', output_format: 'png', aspect_ratio: 'match_input_image' } },
  'black-forest-labs/flux-kontext-max': { template: { prompt: P, input_image: '{{image}}', output_format: 'png', aspect_ratio: 'match_input_image' } },
  'google/nano-banana': { template: { prompt: P, image_input: '{{images}}', output_format: 'png' } },
  'qwen/qwen-image-edit': { template: { prompt: P, image: '{{image}}', output_format: 'png' } },
  'bytedance/seedream-4': { template: { prompt: P, image_input: '{{images}}' } },
  'bria/remove-background': { template: { image: '{{image}}' } },
  '851-labs/background-remover': { template: { image: '{{image}}', format: 'png' } },
  'firtoz/trellis': { template: { images: ['{{image}}'], generate_model: true, texture_size: 1024 } },
  'tencent/hunyuan3d-2': { template: { image: '{{image}}' } },
  'tencent/hunyuan3d-2mv': {
    template: { front_image: '{{front}}', back_image: '{{back}}', left_image: '{{left}}', right_image: '{{right}}' },
  },
};

const FAL_DEFAULTS: Record<AiCapability, Record<string, unknown>> = {
  'image-edit': { prompt: P, image_url: '{{image}}' },
  'background-removal': { image_url: '{{image}}' },
  'image-to-3d': { image_url: '{{image}}' },
  'multiview-to-3d': { front_image_url: '{{front}}', back_image_url: '{{back}}', left_image_url: '{{left}}', right_image_url: '{{right}}' },
};

const REPLICATE_DEFAULTS: Record<AiCapability, Record<string, unknown>> = {
  'image-edit': { prompt: P, image: '{{image}}' },
  'background-removal': { image: '{{image}}' },
  'image-to-3d': { image: '{{image}}' },
  'multiview-to-3d': { front_image: '{{front}}', back_image: '{{back}}', left_image: '{{left}}', right_image: '{{right}}' },
};

/**
 * The template text to render for a request: the user's own (non-empty
 * settings field), else the model's preset, else the capability default.
 */
export function resolveTemplate(
  cfg: ProviderConfig,
  cap: AiCapability,
  model: string,
): { text: string; requires: ViewId[]; custom: boolean } {
  const own = cfg.values[templateKey(cap)];
  if (typeof own === 'string' && own.trim()) return { text: own, requires: [], custom: true };
  const presets = cfg.kind === 'fal' ? FAL_PRESETS : REPLICATE_PRESETS;
  const defaults = cfg.kind === 'fal' ? FAL_DEFAULTS : REPLICATE_DEFAULTS;
  const preset = presets[model.split(':')[0]];
  return { text: JSON.stringify(preset?.template ?? defaults[cap]), requires: preset?.requires ?? [], custom: false };
}
