/**
 * Data specs of the Hugging Face Space image-to-3D drivers (run by
 * ./hfSpaces.ts).
 *
 * ASSUMPTION (applies to everything below): Space ids, endpoint (api_name)
 * names, parameter names / order and output positions were written from the
 * Spaces' public app.py files as remembered at the time of writing; they could
 * NOT be checked against the live Spaces (huggingface.co was unreachable from
 * the build sandbox). Named arguments are used wherever possible: the Gradio
 * client resolves them by parameter name and fills every argument we do not
 * pass with the Space's own default, so small signature changes do not break
 * the call. When a Space changes, fix it without code via the driver's
 * "Advanced: Space / endpoint / extra arguments" parameters (extra arguments
 * are merged into the main call; `null` removes an argument).
 */
import type { ParamSpec, ParamValues } from '../../core/types';
import type { HfSpaceSpec, HfStepContext } from './hfSpaces';

const num = (p: ParamValues, key: string, def: number, lo: number, hi: number) => {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
};
const bool = (p: ParamValues, key: string, def: boolean) => (typeof p[key] === 'boolean' ? (p[key] as boolean) : def);
const str = (p: ParamValues, key: string, def: string) => (typeof p[key] === 'string' && p[key] ? (p[key] as string) : def);
/** First output of a previous step, else `fallback`. */
const out = (ctx: HfStepContext, step: string, index: number, fallback: unknown) => {
  const d = ctx.outputs[step];
  return d && d[index] != null ? d[index] : fallback;
};

const CUTOUT_PARAM: ParamSpec = {
  kind: 'boolean',
  key: 'cutout',
  label: { tr: 'Arka planı kesilmiş görseli gönder', en: 'Send the cut-out image' },
  hint: {
    tr: 'Siluet (alfa / arka plan kaldırma) varsa saydam arka planlı PNG gönderilir; model yalnızca nesneye odaklanır. Kapalıysa orijinal dosya gider.',
    en: 'With a silhouette (alpha / background removal) a PNG with a transparent background is sent, so the model focuses on the object. Off = the original file.',
  },
  default: true,
};

// ---------------------------------------------------------------------------
// TRELLIS (Microsoft, MIT) — structured 3D latents, best overall geometry + texture.
// ASSUMPTION: Space "JeffreyXiang/TRELLIS" (mirror "trellis-community/TRELLIS"),
// app.py: demo.load(start_session) → /start_session; /preprocess_image(image) → image;
// /image_to_3d(image, multiimages, seed, ss_guidance_strength, ss_sampling_steps,
//   slat_guidance_strength, slat_sampling_steps, multiimage_algo) → video, the
//   generated state kept in the session (gr.State);
// /extract_glb(state, mesh_simplify, texture_size) → (Model3D glb, DownloadButton glb).
export const TRELLIS_SPEC: HfSpaceSpec = {
  id: 'hf-trellis',
  model: 'TRELLIS',
  name: { tr: 'TRELLIS (Hugging Face, ücretsiz)', en: 'TRELLIS (Hugging Face, free)' },
  description: {
    tr: 'Microsoft TRELLIS: şu an en iyi açık kaynak görselden 3B modellerinden biri. Tek görselden dokulu, kapalı ve arka yüzü de olan bir GLB üretir; karakterlerde ve arabalarda hacim ve ayrıntıyı tripo3d.ai’ye yakın verir. Ücretsiz Hugging Face Space (ZeroGPU) üzerinde çalışır: anahtar gerekmez, kuyruk ve günlük GPU kotası vardır. Görsel Space’e yüklenir.',
    en: 'Microsoft TRELLIS: one of the best open image-to-3D models today. Turns one image into a textured, closed GLB including the back; gives characters and cars volume and detail close to tripo3d.ai. Runs on a free Hugging Face Space (ZeroGPU): no key needed, but there is a queue and a daily GPU quota. The image is uploaded to the Space.',
  },
  space: 'JeffreyXiang/TRELLIS',
  alternativeSpaces: ['trellis-community/TRELLIS'],
  typicalSeconds: 60,
  params: [
    CUTOUT_PARAM,
    {
      kind: 'number',
      key: 'steps',
      label: { tr: 'Örnekleme adımı', en: 'Sampling steps' },
      hint: { tr: 'Daha çok adım = biraz daha ayrıntı, daha çok GPU süresi', en: 'More steps = a little more detail, more GPU time' },
      min: 4,
      max: 50,
      step: 1,
      default: 12,
    },
    {
      kind: 'number',
      key: 'simplify',
      label: { tr: 'Mesh sadeleştirme', en: 'Mesh simplification' },
      hint: { tr: 'Silinecek üçgen oranı (0.95 = %95 azalt). Düşük = daha ayrıntılı, daha büyük dosya', en: 'Share of triangles removed (0.95 = 95 % fewer). Lower = more detail, bigger file' },
      min: 0.5,
      max: 0.98,
      step: 0.01,
      default: 0.95,
    },
    {
      kind: 'select',
      key: 'textureSize',
      label: { tr: 'Doku boyutu', en: 'Texture size' },
      options: [
        { value: '512', label: { tr: '512 px', en: '512 px' } },
        { value: '1024', label: { tr: '1024 px', en: '1024 px' } },
        { value: '2048', label: { tr: '2048 px (daha yavaş)', en: '2048 px (slower)' } },
      ],
      default: '1024',
    },
  ],
  steps: [
    {
      id: 'session',
      endpoint: '/start_session',
      args: () => [],
      optional: true,
      label: { tr: 'Oturum açılıyor', en: 'Starting the session' },
      weight: 0.1,
    },
    {
      id: 'preprocess',
      endpoint: '/preprocess_image',
      args: (ctx) => ({ image: ctx.image }),
      label: { tr: 'Görsel hazırlanıyor', en: 'Preparing the image' },
      weight: 0.4,
    },
    {
      id: 'generate',
      endpoint: '/image_to_3d',
      main: true,
      args: (ctx) => {
        const steps = Math.round(num(ctx.params, 'steps', 12, 1, 100));
        return {
          image: out(ctx, 'preprocess', 0, ctx.image),
          seed: ctx.seed,
          ss_sampling_steps: steps,
          slat_sampling_steps: steps,
        };
      },
      label: { tr: '3B yapı üretiliyor', en: 'Generating the 3D structure' },
      weight: 3,
    },
    {
      id: 'extract',
      endpoint: '/extract_glb',
      args: (ctx) => ({
        mesh_simplify: num(ctx.params, 'simplify', 0.95, 0, 0.99),
        texture_size: Number(str(ctx.params, 'textureSize', '1024')) || 1024,
      }),
      label: { tr: 'GLB çıkarılıyor (doku pişiriliyor)', en: 'Extracting the GLB (baking the texture)' },
      weight: 1.5,
    },
  ],
  glbOutputs: [
    { step: 'extract', index: 0 },
    { step: 'extract', index: 1 },
  ],
};

// ---------------------------------------------------------------------------
// Hunyuan3D-2 (Tencent, Tencent Hunyuan community licence) — very detailed shapes + texture.
// ASSUMPTION: Space "tencent/Hunyuan3D-2", gradio_app.py:
// /shape_generation(caption, image, mv_image_front, mv_image_back, mv_image_left,
//   mv_image_right, steps, guidance_scale, seed, octree_resolution, check_box_rembg,
//   num_chunks, randomize_seed) → (file glb, html, stats, seed)
// /generation_all(same inputs) → (file shape glb, file textured glb, html, html, stats, seed)
export const HUNYUAN3D_SPEC: HfSpaceSpec = {
  id: 'hf-hunyuan3d-2',
  model: 'Hunyuan3D-2',
  name: { tr: 'Hunyuan3D-2 (Hugging Face, ücretsiz)', en: 'Hunyuan3D-2 (Hugging Face, free)' },
  description: {
    tr: 'Tencent Hunyuan3D-2: çok ayrıntılı, keskin geometri (araba gövdeleri, mekanik parçalar, karakter yüzleri) ve ayrı bir doku modeli. Ücretsiz Hugging Face Space (ZeroGPU) üzerinde çalışır; dokulu üretim ~1–2 dk GPU kullanır. Lisans: Tencent Hunyuan Community (AB/İngiltere/G. Kore hariç).',
    en: 'Tencent Hunyuan3D-2: very detailed, crisp geometry (car bodies, mechanical parts, character faces) and a separate texture model. Runs on a free Hugging Face Space (ZeroGPU); a textured run uses ~1–2 min of GPU. Licence: Tencent Hunyuan Community (excludes EU/UK/South Korea).',
  },
  space: 'tencent/Hunyuan3D-2',
  alternativeSpaces: ['tencent/Hunyuan3D-2mini-Turbo'],
  typicalSeconds: 90,
  params: [
    CUTOUT_PARAM,
    {
      kind: 'boolean',
      key: 'textured',
      label: { tr: 'Doku üret', en: 'Generate texture' },
      hint: { tr: 'Kapalıysa yalnızca şekil (daha hızlı, daha az kota)', en: 'Off = shape only (faster, less quota)' },
      default: true,
    },
    {
      kind: 'number',
      key: 'steps',
      label: { tr: 'Çıkarım adımı', en: 'Inference steps' },
      min: 5,
      max: 100,
      step: 1,
      default: 30,
    },
    {
      kind: 'select',
      key: 'octree',
      label: { tr: 'Şekil çözünürlüğü (octree)', en: 'Shape resolution (octree)' },
      hint: { tr: 'Yüksek = daha ince ayrıntı, daha çok GPU süresi', en: 'Higher = finer detail, more GPU time' },
      options: [
        { value: '256', label: { tr: '256 (hızlı)', en: '256 (fast)' } },
        { value: '384', label: { tr: '384', en: '384' } },
        { value: '512', label: { tr: '512 (en ayrıntılı)', en: '512 (most detailed)' } },
      ],
      default: '256',
    },
  ],
  steps: [
    {
      id: 'generate',
      endpoint: (p) => (bool(p, 'textured', true) ? '/generation_all' : '/shape_generation'),
      main: true,
      args: (ctx) => ({
        image: ctx.image,
        steps: Math.round(num(ctx.params, 'steps', 30, 1, 200)),
        seed: ctx.seed,
        octree_resolution: Number(str(ctx.params, 'octree', '256')) || 256,
        check_box_rembg: true,
        randomize_seed: false,
      }),
      label: { tr: 'Şekil ve doku üretiliyor', en: 'Generating shape and texture' },
      weight: 4,
    },
  ],
  // The textured mesh first (generation_all), else the shape.
  glbOutputs: [
    { step: 'generate', index: 1 },
    { step: 'generate', index: 0 },
  ],
};

// ---------------------------------------------------------------------------
// TripoSG (VAST, MIT) — high-fidelity shapes from the makers of Tripo, optional MV-Adapter texture.
// ASSUMPTION: Space "VAST-AI/TripoSG", app.py:
// /run_segmentation(image) → segmented image;
// /image_to_3d(image, seed, num_inference_steps, guidance_scale, simplify, target_face_num) → glb path;
// /run_texture(image, mesh_path, seed) → textured glb path (optional).
export const TRIPOSG_SPEC: HfSpaceSpec = {
  id: 'hf-triposg',
  model: 'TripoSG',
  name: { tr: 'TripoSG (Hugging Face, ücretsiz)', en: 'TripoSG (Hugging Face, free)' },
  description: {
    tr: 'VAST TripoSG: Tripo3D ekibinin açık kaynak şekil modeli — keskin, yüksek sadakatli geometri (karakterler, araçlar). İsteğe bağlı doku adımı (MV-Adapter). Ücretsiz Hugging Face Space (ZeroGPU); anahtar gerekmez.',
    en: 'VAST TripoSG: the open shape model from the Tripo3D team — sharp, high-fidelity geometry (characters, vehicles). Optional texture pass (MV-Adapter). Free Hugging Face Space (ZeroGPU); no key needed.',
  },
  space: 'VAST-AI/TripoSG',
  typicalSeconds: 60,
  params: [
    CUTOUT_PARAM,
    {
      kind: 'boolean',
      key: 'texture',
      label: { tr: 'Doku üret', en: 'Generate texture' },
      hint: { tr: 'Ek bir GPU adımı; başarısız olursa dokusuz şekil döner', en: 'An extra GPU pass; falls back to the untextured shape if it fails' },
      default: true,
    },
    {
      kind: 'number',
      key: 'steps',
      label: { tr: 'Çıkarım adımı', en: 'Inference steps' },
      min: 8,
      max: 100,
      step: 1,
      default: 50,
    },
    {
      kind: 'number',
      key: 'faces',
      label: { tr: 'Hedef üçgen sayısı', en: 'Target face count' },
      hint: { tr: '0 = sadeleştirme yok', en: '0 = no simplification' },
      min: 0,
      max: 1_000_000,
      step: 10_000,
      default: 100_000,
    },
  ],
  steps: [
    {
      id: 'segment',
      endpoint: '/run_segmentation',
      args: (ctx) => ({ image: ctx.image }),
      optional: true,
      label: { tr: 'Arka plan ayrılıyor', en: 'Segmenting the background' },
      weight: 0.4,
    },
    {
      id: 'generate',
      endpoint: '/image_to_3d',
      main: true,
      args: (ctx) => {
        const faces = Math.round(num(ctx.params, 'faces', 100_000, 0, 5_000_000));
        return {
          image: out(ctx, 'segment', 0, ctx.image),
          seed: ctx.seed,
          num_inference_steps: Math.round(num(ctx.params, 'steps', 50, 1, 200)),
          guidance_scale: 7,
          simplify: faces > 0,
          target_face_num: faces > 0 ? faces : 100_000,
        };
      },
      label: { tr: 'Şekil üretiliyor', en: 'Generating the shape' },
      weight: 2.5,
    },
    {
      id: 'texture',
      endpoint: '/run_texture',
      when: (p) => bool(p, 'texture', true),
      optional: true,
      args: (ctx) => ({
        image: out(ctx, 'segment', 0, ctx.image),
        mesh_path: out(ctx, 'generate', 0, null),
        seed: ctx.seed,
      }),
      label: { tr: 'Doku üretiliyor', en: 'Generating the texture' },
      weight: 2,
    },
  ],
  glbOutputs: [
    { step: 'texture', index: 0 },
    { step: 'generate', index: 0 },
  ],
};

// ---------------------------------------------------------------------------
// Stable Fast 3D (Stability AI, Stability Community licence) — ~1 s GPU, UV-textured GLB.
// ASSUMPTION: Space "stabilityai/stable-fast-3d", gradio_app.py run_btn.click(run_button,
//   inputs=[run_btn, input_img, background_remove_state, foreground_ratio,
//   remesh_option, vertex_count, texture_size], outputs=[run_btn, img_proc_state,
//   background_remove_state, preview_removal, output_3d, …]) exposed as /run_button.
//   With an RGBA input (our cut-out) the first call ("Run") generates directly;
//   otherwise it removes the background and a second call ("Generate") runs the model.
//   Positional arguments (the state input has no parameter name).
function sf3dArgs(ctx: HfStepContext, button: string, image: unknown, bgState: unknown): unknown[] {
  return [
    button,
    image,
    bgState,
    num(ctx.params, 'foregroundRatio', 0.85, 0.5, 1),
    str(ctx.params, 'remesh', 'None'),
    -1,
    Number(str(ctx.params, 'textureSize', '1024')) || 1024,
  ];
}

export const SF3D_SPEC: HfSpaceSpec = {
  id: 'hf-stable-fast-3d',
  model: 'Stable Fast 3D',
  name: { tr: 'Stable Fast 3D (Hugging Face, ücretsiz, hızlı)', en: 'Stable Fast 3D (Hugging Face, free, fast)' },
  description: {
    tr: 'Stability AI Stable Fast 3D: saniyeler içinde UV dokulu, temiz bir GLB. Ayrıntı TRELLIS / Hunyuan3D’den azdır ama çok az GPU kotası harcar; kota dolduğunda iyi bir yedek. Ücretsiz Hugging Face Space. Lisans: Stability AI Community.',
    en: 'Stability AI Stable Fast 3D: a clean UV-textured GLB in seconds. Less detail than TRELLIS / Hunyuan3D but uses very little GPU quota; a good fallback when the others are out of quota. Free Hugging Face Space. Licence: Stability AI Community.',
  },
  space: 'stabilityai/stable-fast-3d',
  typicalSeconds: 10,
  params: [
    CUTOUT_PARAM,
    {
      kind: 'number',
      key: 'foregroundRatio',
      label: { tr: 'Nesne oranı', en: 'Foreground ratio' },
      hint: { tr: 'Nesnenin kareyi ne kadar doldurduğu', en: 'How much of the frame the object fills' },
      min: 0.5,
      max: 1,
      step: 0.05,
      default: 0.85,
    },
    {
      kind: 'select',
      key: 'remesh',
      label: { tr: 'Yeniden örme', en: 'Remesh' },
      options: [
        { value: 'None', label: { tr: 'Yok', en: 'None' } },
        { value: 'Triangle', label: { tr: 'Üçgen', en: 'Triangle' } },
        { value: 'Quad', label: { tr: 'Dörtgen', en: 'Quad' } },
      ],
      default: 'None',
    },
    {
      kind: 'select',
      key: 'textureSize',
      label: { tr: 'Doku boyutu', en: 'Texture size' },
      options: [
        { value: '512', label: { tr: '512 px', en: '512 px' } },
        { value: '1024', label: { tr: '1024 px', en: '1024 px' } },
        { value: '2048', label: { tr: '2048 px', en: '2048 px' } },
      ],
      default: '1024',
    },
  ],
  steps: [
    {
      id: 'run',
      endpoint: '/run_button',
      main: true,
      args: (ctx) => sf3dArgs(ctx, 'Run', ctx.image, null),
      label: { tr: '3B model üretiliyor', en: 'Generating the 3D model' },
      weight: 1,
    },
    {
      id: 'generate',
      endpoint: '/run_button',
      optional: true,
      // Only when the first call stopped after background removal (no model yet).
      skip: (ctx) => ctx.hasModel,
      args: (ctx) => sf3dArgs(ctx, 'Generate', out(ctx, 'run', 1, ctx.image), out(ctx, 'run', 2, null)),
      label: { tr: '3B model üretiliyor', en: 'Generating the 3D model' },
      weight: 1,
    },
  ],
  glbOutputs: [
    { step: 'generate', index: 4 },
    { step: 'run', index: 4 },
  ],
};

/** In display order (best first). */
export const HF_SPACE_SPECS: HfSpaceSpec[] = [TRELLIS_SPEC, HUNYUAN3D_SPEC, TRIPOSG_SPEC, SF3D_SPEC];
