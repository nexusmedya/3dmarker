/**
 * The provider kinds the settings dialog can add (any number of each).
 *
 * Model ids and request fields were checked against the official SDK sources
 * where one exists: openai-node 7.23 (resources/images: ImageModel,
 * ImageEditParams), @google/genai 2.24 (Model ids, generateContent REST
 * mapping), @fal-ai/client 1.10 (endpoint input / output types, browser
 * calls with `Authorization: Key …` and `mode: 'cors'`) and replicate 1.4
 * (predictions API). Stability AI and Tripo have no SDK here: their paths are
 * marked ASSUMPTION in the adapters. Every model field also takes free text.
 */
import type { I18nText, ParamSpec, SelectParam } from '../core/types';
import type { AiCapability, ModelSuggestion, ProviderConfig, ProviderKind, ProviderKindId } from './types';
import { AI_CAPABILITIES } from './types';

const t = (tr: string, en: string): I18nText => ({ tr, en });

function select(key: string, label: I18nText, options: [string, I18nText][], def: string, hint?: I18nText): SelectParam {
  return { kind: 'select', key, label, hint, default: def, options: options.map(([value, l]) => ({ value, label: l })) };
}

const TEMPLATE_HINT = t(
  'JSON; yer tutucular: {{prompt}}, {{image}} (ilk görsel, data URI), {{image2}}…, {{images}} (dizi), {{front}} {{back}} {{left}} {{right}} {{top}} {{bottom}}, {{key}}; sonuna _base64 eklenirse ham base64. Boş = modelin yerleşik şablonu.',
  'JSON; placeholders: {{prompt}}, {{image}} (first image, data URI), {{image2}}…, {{images}} (array), {{front}} {{back}} {{left}} {{right}} {{top}} {{bottom}}, {{key}}; add _base64 for raw base64. Empty = the model’s built-in template.',
);

const OUTPUT_PATH_HINT = t(
  'Sonuç dosyasının yolu, ör. images.0.url ya da model_glb.url. Boş = ilk uygun URL otomatik bulunur.',
  'Path to the output file, e.g. images.0.url or model_glb.url. Empty = the first suitable URL is found automatically.',
);

/** Per-capability request templates of the generic kinds (Replicate, fal.ai). */
function templateFields(caps: AiCapability[]): ParamSpec[] {
  const labels: Record<AiCapability, I18nText> = {
    'image-edit': t('Girdi şablonu — görsel düzenleme', 'Input template — image edit'),
    'background-removal': t('Girdi şablonu — arka plan kaldırma', 'Input template — background removal'),
    'image-to-3d': t('Girdi şablonu — görselden 3B', 'Input template — image to 3D'),
    'multiview-to-3d': t('Girdi şablonu — çok görünümden 3B', 'Input template — multi-view to 3D'),
  };
  const outputLabels: Record<AiCapability, I18nText> = {
    'image-edit': t('Çıktı yolu — görsel düzenleme', 'Output path — image edit'),
    'background-removal': t('Çıktı yolu — arka plan kaldırma', 'Output path — background removal'),
    'image-to-3d': t('Çıktı yolu — görselden 3B', 'Output path — image to 3D'),
    'multiview-to-3d': t('Çıktı yolu — çok görünümden 3B', 'Output path — multi-view to 3D'),
  };
  const fields: ParamSpec[] = caps.flatMap((cap): ParamSpec[] => [
    {
      kind: 'text' as const,
      key: templateKey(cap),
      label: labels[cap],
      hint: TEMPLATE_HINT,
      default: '',
      placeholder: '{"prompt": "{{prompt}}", "image": "{{image}}"}',
    },
    {
      kind: 'text' as const,
      key: outputPathKey(cap),
      label: outputLabels[cap],
      hint: OUTPUT_PATH_HINT,
      default: '',
      placeholder: cap === 'image-to-3d' || cap === 'multiview-to-3d' ? 'model_glb.url' : 'images.0.url',
    },
  ]);
  if (caps.includes('multiview-to-3d')) {
    fields.push({
      kind: 'boolean',
      key: 'swapSides',
      label: t('Sol/sağ görünümleri değiştir', 'Swap left / right views'),
      hint: t(
        'Model “sol” görünümü kameranın solu olarak bekliyorsa açın (bizde sol = öznenin sol yanı).',
        'Turn on when the model expects “left” as the camera’s left (ours is the subject’s left side).',
      ),
      default: false,
    });
  }
  return fields;
}

/** Field key holding the output path of a capability (generic kinds); one per capability so they never clash. */
export function outputPathKey(cap: AiCapability): string {
  switch (cap) {
    case 'image-edit':
      return 'editOutputPath';
    case 'background-removal':
      return 'bgOutputPath';
    case 'image-to-3d':
      return 'modelOutputPath';
    case 'multiview-to-3d':
      return 'multiviewOutputPath';
  }
}

/**
 * Moves the old single 'outputPath' value of a generic-kind config to the
 * per-capability fields it was meant for: the capabilities with a custom
 * template, else the 3D ones for a model-looking path, else the image ones.
 * Fields that already hold a path are left alone.
 */
export function migrateOutputPath(kind: ProviderKindId, values: Record<string, unknown>): Record<string, unknown> {
  const legacy = typeof values.outputPath === 'string' ? values.outputPath.trim() : '';
  if (!legacy || (kind !== 'fal' && kind !== 'replicate')) return values;
  const out: Record<string, unknown> = { ...values };
  delete out.outputPath;
  const caps = BY_ID.get(kind)?.capabilities ?? [];
  const custom = caps.filter((c) => typeof values[templateKey(c)] === 'string' && (values[templateKey(c)] as string).trim());
  const model = /glb|mesh|model|gltf/i.test(legacy);
  const targets = custom.length
    ? custom
    : caps.filter((c) => (c === 'image-to-3d' || c === 'multiview-to-3d') === model);
  for (const cap of targets) {
    const key = outputPathKey(cap);
    if (typeof out[key] !== 'string' || !(out[key] as string).trim()) out[key] = legacy;
  }
  return out;
}

/** Field key holding the request template of a capability (generic kinds). */
export function templateKey(cap: AiCapability): string {
  switch (cap) {
    case 'image-edit':
      return 'editTemplate';
    case 'background-removal':
      return 'bgTemplate';
    case 'image-to-3d':
      return 'modelTemplate';
    case 'multiview-to-3d':
      return 'multiviewTemplate';
  }
}

const m = (id: string, label: string, note?: I18nText): ModelSuggestion => (note ? { id, label, note } : { id, label });

const OPENAI_EDIT_MODELS: ModelSuggestion[] = [
  m('gpt-image-1.5', 'GPT Image 1.5', t('Varsayılan; saydam arka plan ve yüksek sadakat destekler', 'Default; supports transparent backgrounds and high input fidelity')),
  m('gpt-image-2', 'GPT Image 2', t('Daha yeni; saydam arka plan önizlemede', 'Newer; transparent background in preview')),
  m('gpt-image-2.5-flare', 'GPT Image 2.5 Flare'),
  m('gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst'),
  m('gpt-image-1', 'GPT Image 1'),
  m('gpt-image-1-mini', 'GPT Image 1 mini', t('Daha ucuz ve hızlı', 'Cheaper and faster')),
  m('chatgpt-image-latest', 'ChatGPT Image (latest)'),
];

const OPENAI_FIELDS: ParamSpec[] = [
  select(
    'size',
    t('Boyut', 'Size'),
    [
      ['match', t('Kaynağa göre (kare / dikey / yatay)', 'Match the source (square / portrait / landscape)')],
      ['auto', t('Otomatik (model seçer)', 'Auto (model decides)')],
      ['1024x1024', t('1024 × 1024', '1024 × 1024')],
      ['1024x1536', t('1024 × 1536 (dikey)', '1024 × 1536 (portrait)')],
      ['1536x1024', t('1536 × 1024 (yatay)', '1536 × 1024 (landscape)')],
    ],
    'match',
  ),
  select(
    'quality',
    t('Kalite', 'Quality'),
    [
      ['auto', t('Otomatik', 'Auto')],
      ['low', t('Düşük (ucuz)', 'Low (cheap)')],
      ['medium', t('Orta', 'Medium')],
      ['high', t('Yüksek', 'High')],
    ],
    'auto',
  ),
  select(
    'inputFidelity',
    t('Girdiye sadakat', 'Input fidelity'),
    [
      ['high', t('Yüksek (yüz ve ayrıntıları korur)', 'High (keeps faces and details)')],
      ['low', t('Düşük', 'Low')],
      ['omit', t('Gönderme', 'Do not send')],
    ],
    'high',
    t('Desteklemeyen modellerde gönderilmez.', 'Not sent to models that do not support it.'),
  ),
];

export const PROVIDER_KINDS: ProviderKind[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    description: t(
      'GPT Image modelleriyle görsel düzenleme: stil, T-poz, gövde tamamlama, diğer görünümler; saydam arka planla PNG. Tarayıcıdan doğrudan çağrılır (sunucu gerekmez).',
      'Image editing with the GPT Image models: styles, T-pose, body completion, other views; PNG with a transparent background. Called directly from the browser (no server needed).',
    ),
    docsUrl: 'https://platform.openai.com/docs/guides/image-generation',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-…',
    capabilities: ['image-edit', 'background-removal'],
    models: {
      'image-edit': OPENAI_EDIT_MODELS,
      'background-removal': [
        m('gpt-image-1.5', 'GPT Image 1.5', t('Konuyu yeniden çizer; piksel birebir değildir', 'Re-renders the subject; not pixel-exact')),
        m('gpt-image-1', 'GPT Image 1'),
        m('gpt-image-1-mini', 'GPT Image 1 mini'),
      ],
    },
    fields: OPENAI_FIELDS,
    browserDirect: true,
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    description: t(
      'Gemini görsel modelleri (“Nano Banana” ailesi) ile görsel düzenleme ve yeni görünüm üretimi. Tarayıcıdan doğrudan çağrılır. Saydam arka plan üretmez; arka plan ayrıca kaldırılır.',
      'Image editing and new views with the Gemini image models (the “Nano Banana” family). Called directly from the browser. Cannot output transparency; the background is removed separately.',
    ),
    docsUrl: 'https://ai.google.dev/gemini-api/docs/image-generation',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyPlaceholder: 'AIza…',
    capabilities: ['image-edit'],
    models: {
      'image-edit': [
        m('gemini-2.5-flash-image', 'Gemini 2.5 Flash Image (Nano Banana)'),
        m('gemini-3.1-flash-image', 'Gemini 3.1 Flash Image'),
        m('gemini-3-pro-image', 'Gemini 3 Pro Image (Nano Banana Pro)', t('En yüksek kalite, daha yavaş', 'Highest quality, slower')),
        m('nano-banana-pro-preview', 'Nano Banana Pro (preview)'),
      ],
    },
    fields: [
      select(
        'imageSize',
        t('Çıktı çözünürlüğü', 'Output resolution'),
        [
          ['default', t('Varsayılan (1K)', 'Default (1K)')],
          ['1K', t('1K', '1K')],
          ['2K', t('2K (Pro modeller)', '2K (Pro models)')],
          ['4K', t('4K (Pro modeller)', '4K (Pro models)')],
        ],
        'default',
      ),
    ],
    browserDirect: true,
  },
  {
    id: 'stability',
    name: 'Stability AI',
    description: t(
      'Arka plan kaldırma, yapıyı koruyarak stil verme ve Stable Fast 3D / SPAR3D ile görselden 3B. Sunucu vekili üzerinden çalışır.',
      'Background removal, structure-preserving restyling and image-to-3D with Stable Fast 3D / SPAR3D. Runs through the server proxy.',
    ),
    docsUrl: 'https://platform.stability.ai/docs/api-reference',
    keyUrl: 'https://platform.stability.ai/account/keys',
    keyPlaceholder: 'sk-…',
    capabilities: ['image-edit', 'background-removal', 'image-to-3d'],
    models: {
      'image-edit': [
        m('control/structure', 'Control — Structure', t('Kompozisyonu korur, stili değiştirir; yeni görünüm üretemez', 'Keeps the composition, changes the style; cannot render new views')),
        m('control/style', 'Control — Style guide'),
        m('control/sketch', 'Control — Sketch'),
      ],
      'background-removal': [m('edit/remove-background', 'Remove background')],
      'image-to-3d': [m('stable-fast-3d', 'Stable Fast 3D'), m('stable-point-aware-3d', 'Stable Point Aware 3D (SPAR3D)')],
    },
    fields: [
      {
        kind: 'number',
        key: 'controlStrength',
        label: t('Yapıya bağlılık', 'Structure strength'),
        hint: t('Control uç noktaları için (0–1)', 'For the control endpoints (0–1)'),
        min: 0,
        max: 1,
        step: 0.05,
        default: 0.7,
      },
      select(
        'textureResolution',
        t('3B doku çözünürlüğü', '3D texture resolution'),
        [
          ['512', t('512', '512')],
          ['1024', t('1024', '1024')],
          ['2048', t('2048', '2048')],
        ],
        '1024',
      ),
    ],
    browserDirect: false,
  },
  {
    id: 'replicate',
    name: 'Replicate',
    description: t(
      'Replicate üzerindeki herhangi bir model: model kimliği (sahip/ad ya da sahip/ad:sürüm) ve JSON girdi şablonu. Sunucu vekili üzerinden çalışır.',
      'Any model on Replicate: model id (owner/name or owner/name:version) plus a JSON input template. Runs through the server proxy.',
    ),
    docsUrl: 'https://replicate.com/docs/reference/http',
    keyUrl: 'https://replicate.com/account/api-tokens',
    keyPlaceholder: 'r8_…',
    capabilities: ['image-edit', 'background-removal', 'image-to-3d', 'multiview-to-3d'],
    models: {
      // ASSUMPTION: model ids / inputs as listed on replicate.com at the time of
      // writing; community models may need an explicit ":version" suffix.
      'image-edit': [
        m('black-forest-labs/flux-kontext-pro', 'FLUX.1 Kontext [pro]'),
        m('black-forest-labs/flux-kontext-max', 'FLUX.1 Kontext [max]'),
        m('google/nano-banana', 'Nano Banana'),
        m('qwen/qwen-image-edit', 'Qwen Image Edit'),
        m('bytedance/seedream-4', 'Seedream 4'),
      ],
      'background-removal': [
        m('bria/remove-background', 'Bria remove background'),
        m('851-labs/background-remover', 'Background remover (851 Labs)', t('Topluluk modeli: gerekirse :sürüm ekleyin', 'Community model: add :version if needed')),
      ],
      'image-to-3d': [
        m('firtoz/trellis', 'TRELLIS', t('Topluluk modeli: gerekirse :sürüm ekleyin', 'Community model: add :version if needed')),
        m('tencent/hunyuan3d-2', 'Hunyuan3D-2'),
      ],
      'multiview-to-3d': [m('tencent/hunyuan3d-2mv', 'Hunyuan3D-2mv (multi-view)')],
    },
    fields: templateFields(['image-edit', 'background-removal', 'image-to-3d', 'multiview-to-3d']),
    browserDirect: false,
  },
  {
    id: 'fal',
    name: 'fal.ai',
    description: t(
      'fal.ai üzerindeki herhangi bir uç nokta (Nano Banana, FLUX Kontext, TRELLIS, Hunyuan3D, Tripo…): model kimliği ve JSON girdi şablonu. Tarayıcıdan doğrudan çağrılır.',
      'Any fal.ai endpoint (Nano Banana, FLUX Kontext, TRELLIS, Hunyuan3D, Tripo…): model id plus a JSON input template. Called directly from the browser.',
    ),
    docsUrl: 'https://docs.fal.ai/model-apis/model-endpoints/queue',
    keyUrl: 'https://fal.ai/dashboard/keys',
    keyPlaceholder: 'key-id:key-secret',
    capabilities: ['image-edit', 'background-removal', 'image-to-3d', 'multiview-to-3d'],
    models: {
      'image-edit': [
        m('fal-ai/nano-banana/edit', 'Nano Banana edit'),
        m('fal-ai/nano-banana-pro/edit', 'Nano Banana Pro edit'),
        m('fal-ai/flux-pro/kontext', 'FLUX.1 Kontext [pro]'),
        m('fal-ai/flux-pro/kontext/max', 'FLUX.1 Kontext [max]'),
        m('fal-ai/bytedance/seedream/v4/edit', 'Seedream 4 edit'),
        m('fal-ai/qwen-image-edit', 'Qwen Image Edit'),
      ],
      'background-removal': [
        m('fal-ai/birefnet/v2', 'BiRefNet v2'),
        m('fal-ai/bria/background/remove', 'Bria RMBG'),
        m('fal-ai/imageutils/rembg', 'rembg'),
      ],
      'image-to-3d': [
        m('fal-ai/hunyuan3d-v3/image-to-3d', 'Hunyuan3D v3'),
        m('fal-ai/trellis-2', 'TRELLIS 2'),
        m('fal-ai/trellis', 'TRELLIS'),
        m('fal-ai/hunyuan3d-v21', 'Hunyuan3D 2.1'),
        m('fal-ai/hunyuan3d/v2', 'Hunyuan3D 2'),
        m('tripo3d/tripo/v2.5/image-to-3d', 'Tripo v2.5'),
        m('fal-ai/triposr', 'TripoSR', t('Hızlı, düşük ayrıntı', 'Fast, low detail')),
      ],
      'multiview-to-3d': [
        m('fal-ai/hunyuan3d-v3/image-to-3d', 'Hunyuan3D v3 (front + optional back / left / right)'),
        m('tripo3d/tripo/v2.5/multiview-to-3d', 'Tripo v2.5 multi-view'),
        m('fal-ai/hunyuan3d/v2/multi-view', 'Hunyuan3D 2 multi-view', t('Ön, arka ve sol görünüm gerekir', 'Needs front, back and left views')),
      ],
    },
    fields: templateFields(['image-edit', 'background-removal', 'image-to-3d', 'multiview-to-3d']),
    browserDirect: true,
  },
  {
    id: 'tripo',
    name: 'Tripo3D',
    description: t(
      'Tek görselden ya da ön/sol/arka/sağ görünümlerden dokulu tam 3B model (GLB). 3D Marker sunucusunun Tripo uçları üzerinden çalışır.',
      'Textured full 3D model (GLB) from one image or from front / left / back / right views. Runs through the 3D Marker server’s Tripo routes.',
    ),
    docsUrl: 'https://platform.tripo3d.ai/docs',
    keyUrl: 'https://platform.tripo3d.ai/api-keys',
    keyPlaceholder: 'tsk_…',
    capabilities: ['image-to-3d', 'multiview-to-3d'],
    models: {
      // ASSUMPTION: Tripo model_version ids (same list as the Tripo driver); 'default' omits the field.
      'image-to-3d': [m('default', 'Default'), m('v3.0-20250812', 'v3.0'), m('v2.5-20250123', 'v2.5'), m('v2.0-20240919', 'v2.0')],
      'multiview-to-3d': [m('default', 'Default'), m('v3.0-20250812', 'v3.0'), m('v2.5-20250123', 'v2.5')],
    },
    fields: [
      { kind: 'boolean', key: 'texture', label: t('Doku üret', 'Generate texture'), default: true },
      { kind: 'boolean', key: 'pbr', label: t('PBR malzeme', 'PBR material'), default: true },
    ],
    browserDirect: false,
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI-compatible',
    description: t(
      'OpenAI /images/edits biçimini konuşan herhangi bir uç nokta (kendi sunucunuz, bir ağ geçidi ya da başka bir sağlayıcı). Temel URL’yi girin.',
      'Any endpoint speaking the OpenAI /images/edits format (your own server, a gateway or another vendor). Enter its base URL.',
    ),
    docsUrl: 'https://platform.openai.com/docs/api-reference/images/createEdit',
    keyPlaceholder: 'sk-…',
    capabilities: ['image-edit', 'background-removal'],
    models: {
      'image-edit': [m('gpt-image-1.5', 'gpt-image-1.5'), m('gpt-image-1', 'gpt-image-1')],
      'background-removal': [m('gpt-image-1.5', 'gpt-image-1.5')],
    },
    fields: [
      {
        kind: 'text',
        key: 'baseUrl',
        label: t('Temel URL', 'Base URL'),
        hint: t('…/v1 gibi; istekler <temel URL>/images/edits adresine gider.', 'Like …/v1; requests go to <base URL>/images/edits.'),
        default: '',
        placeholder: 'https://example.com/v1',
      },
      {
        kind: 'boolean',
        key: 'direct',
        label: t('Tarayıcıdan doğrudan çağır', 'Call directly from the browser'),
        hint: t(
          'Uç nokta CORS’a izin vermeli. Kapalıysa istek sunucu vekili üzerinden gider (sunucuda yapılandırılmış olmalı).',
          'The endpoint must allow CORS. Off = through the server proxy (must be configured on the server).',
        ),
        default: true,
      },
      select(
        'authHeader',
        t('Kimlik doğrulama başlığı', 'Auth header'),
        [
          ['bearer', t('Authorization: Bearer <anahtar>', 'Authorization: Bearer <key>')],
          ['api-key', t('api-key: <anahtar>', 'api-key: <key>')],
          ['none', t('Yok', 'None')],
        ],
        'bearer',
      ),
      ...OPENAI_FIELDS,
    ],
    browserDirect: true,
  },
  {
    id: 'custom-http',
    name: 'Custom HTTP',
    description: t(
      'Tamamen özel bir HTTP uç noktası: URL, yöntem, başlık ve gövde şablonları, yanıttaki görsel/GLB yolu. Tarayıcıdan doğrudan çağrılır (CORS gerekli).',
      'A fully custom HTTP endpoint: URL, method, header and body templates, path to the image / GLB in the response. Called directly from the browser (needs CORS).',
    ),
    docsUrl: 'https://developer.mozilla.org/docs/Web/HTTP/CORS',
    capabilities: [...AI_CAPABILITIES],
    models: {},
    fields: [
      select(
        'capability',
        t('Yetenek', 'Capability'),
        [
          ['image-edit', t('Görsel düzenleme', 'Image edit')],
          ['background-removal', t('Arka plan kaldırma', 'Background removal')],
          ['image-to-3d', t('Görselden 3B', 'Image to 3D')],
          ['multiview-to-3d', t('Çok görünümden 3B', 'Multi-view to 3D')],
        ],
        'image-edit',
      ),
      { kind: 'text', key: 'url', label: t('URL', 'URL'), default: '', placeholder: 'https://api.example.com/v1/edit' },
      select('method', t('Yöntem', 'Method'), [['POST', t('POST', 'POST')], ['PUT', t('PUT', 'PUT')]], 'POST'),
      {
        kind: 'text',
        key: 'headers',
        label: t('Başlık şablonu (JSON)', 'Headers template (JSON)'),
        hint: t('{{key}} API anahtarıyla değiştirilir.', '{{key}} is replaced by the API key.'),
        default: '{"Authorization": "Bearer {{key}}"}',
      },
      select(
        'bodyType',
        t('Gövde türü', 'Body type'),
        [
          ['json', t('JSON', 'JSON')],
          ['multipart', t('multipart/form-data (görseller dosya olarak)', 'multipart/form-data (images as files)')],
        ],
        'json',
      ),
      {
        kind: 'text',
        key: 'body',
        label: t('Gövde şablonu (JSON)', 'Body template (JSON)'),
        hint: TEMPLATE_HINT,
        default: '{"prompt": "{{prompt}}", "image": "{{image}}"}',
      },
      select(
        'responseType',
        t('Yanıt türü', 'Response type'),
        [
          ['json', t('JSON (yol ile)', 'JSON (with a path)')],
          ['binary', t('Dosyanın kendisi (görsel / GLB)', 'The file itself (image / GLB)')],
        ],
        'json',
      ),
      {
        kind: 'text',
        key: 'responsePath',
        label: t('Yanıt yolu', 'Response path'),
        hint: t(
          'ör. data.0.b64_json ya da output.url; değer base64, data URI ya da URL olabilir.',
          'e.g. data.0.b64_json or output.url; the value may be base64, a data URI or a URL.',
        ),
        default: 'data.0.b64_json',
      },
    ],
    browserDirect: true,
  },
];

const BY_ID = new Map(PROVIDER_KINDS.map((k) => [k.id, k]));

export function isProviderKindId(v: unknown): v is ProviderKindId {
  return typeof v === 'string' && BY_ID.has(v as ProviderKindId);
}

export function getProviderKind(id: ProviderKindId): ProviderKind {
  const kind = BY_ID.get(id);
  if (!kind) throw new Error(`Unknown AI provider kind: ${id}`);
  return kind;
}

/** Capabilities one config offers: the kind's, except custom-http which serves the one it is set up for. */
export function configCapabilities(cfg: Pick<ProviderConfig, 'kind' | 'values'>): AiCapability[] {
  if (!isProviderKindId(cfg.kind)) return [];
  if (cfg.kind === 'custom-http') {
    const cap = cfg.values.capability;
    return AI_CAPABILITIES.includes(cap as AiCapability) ? [cap as AiCapability] : ['image-edit'];
  }
  return getProviderKind(cfg.kind).capabilities;
}

/** Kinds whose requests need an API key unless the server manages it. */
export function kindNeedsKey(id: ProviderKindId): boolean {
  return id !== 'openai-compatible' && id !== 'custom-http';
}

/**
 * Kinds whose adapter has a connection test (every adapter but custom-http's;
 * adapters/index.test.ts keeps this in step with the adapters, which load on demand).
 */
export function hasConnectionTest(kind: ProviderKindId): boolean {
  return isProviderKindId(kind) && kind !== 'custom-http';
}

/** The kind's first suggested model for a capability ('' when none). */
export function defaultModel(id: ProviderKindId, cap: AiCapability): string {
  return getProviderKind(id).models[cap]?.[0]?.id ?? '';
}

export const CAPABILITY_LABELS: Record<AiCapability, I18nText> = {
  'image-edit': t('Görsel düzenleme', 'Image edit'),
  'background-removal': t('Arka plan kaldırma', 'Background removal'),
  'image-to-3d': t('Görselden 3B', 'Image to 3D'),
  'multiview-to-3d': t('Çok görünümden 3B', 'Multi-view to 3D'),
};
