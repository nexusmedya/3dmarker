import { describe, expect, it, vi } from 'vitest';
import type { AiSettings, ProviderConfig } from '../../ai/types';
import { AbortError, defaultParams, type DriverInput, type Mask, type ParamValues, type Progress } from '../../core/types';
import { LocalizedError } from '../../core/errors';
import {
  applyExtraArgs,
  classifyHfError,
  collectFiles,
  createHfSpaceDriver,
  cutoutImage,
  hfTokenFromAiSettings,
  normalizeSpace,
  parseExtraArgs,
  pickModelFile,
  type GradioClientLike,
  type GradioConnectOptions,
  type GradioEventLike,
  type GradioJobLike,
  type GradioModule,
  type HfSpaceDriverOptions,
  type HfSpaceSpec,
} from './hfSpaces';
import { HF_SPACE_SPECS, HUNYUAN3D_SPEC, SF3D_SPEC, TRELLIS_SPEC, TRIPOSG_SPEC } from './hfSpecs';
import { CLOUD_DRIVERS } from './index';

function glb(size = 64): ArrayBuffer {
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, size, true);
  return b.buffer;
}

const file = (url: string) => ({ path: url.split('/').pop(), url, orig_name: url.split('/').pop(), meta: { _type: 'gradio.FileData' } });

type Script = GradioEventLike[] | Error | 'hang';

interface Call {
  endpoint: string;
  data: unknown;
}

/** Fake @gradio/client: each endpoint answers with a scripted event list (or throws / hangs). */
function fakeGradio(scripts: Record<string, Script | Script[]>, opts: { connectError?: Error; statuses?: { status: string }[] } = {}) {
  const calls: Call[] = [];
  const connects: { space: string; options: GradioConnectOptions }[] = [];
  const cancels: string[] = [];
  let closed = 0;
  const counters: Record<string, number> = {};
  const client: GradioClientLike = {
    config: { root: 'https://owner-space.hf.space' },
    submit(endpoint, data) {
      calls.push({ endpoint, data });
      const entry = scripts[endpoint];
      const n = (counters[endpoint] = (counters[endpoint] ?? 0) + 1);
      const script: Script = Array.isArray(entry) && entry.length > 0 && Array.isArray(entry[0]) ? (entry as Script[])[n - 1] ?? [] : ((entry as Script) ?? new Error(`There is no endpoint matching that name: ${endpoint}`));
      if (script instanceof Error) throw script;
      let i = 0;
      const job: GradioJobLike = {
        next: () =>
          script === 'hang'
            ? new Promise(() => undefined)
            : Promise.resolve(i < script.length ? { done: false, value: script[i++] } : { done: true, value: undefined }),
        return: async () => ({ done: true, value: undefined }),
        cancel: async () => {
          cancels.push(endpoint);
        },
      };
      return job;
    },
    close: () => {
      closed++;
    },
  };
  const gradio: GradioModule = {
    connect: async (space, options) => {
      connects.push({ space, options });
      for (const s of opts.statuses ?? []) options.status_callback?.(s);
      if (opts.connectError) throw opts.connectError;
      return client;
    },
    handleFile: (f) => ({ handled: f }),
  };
  return { gradio, calls, connects, cancels, closed: () => closed };
}

const ok = (data: unknown[]): GradioEventLike[] => [
  { type: 'status', stage: 'pending', queue: true, position: 2, size: 5, eta: 30 },
  { type: 'status', stage: 'pending', queue: true, position: 0, original_msg: 'process_starts' },
  { type: 'status', stage: 'pending', progress_data: [{ progress: 0.5, index: null, length: null, unit: 'steps', desc: 'Sampling' }] },
  { type: 'data', data },
  { type: 'status', stage: 'complete' },
];
const fail = (message: string): GradioEventLike[] => [{ type: 'status', stage: 'error', message }];

function fetchGlb(body: ArrayBuffer = glb()) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(body, { status: 200 }));
}

function makeInput(params: ParamValues, spec: HfSpaceSpec = TRELLIS_SPEC, signal = new AbortController().signal, mask: Mask | null = null) {
  const progress: Progress[] = [];
  const f = new File([new Uint8Array([0x89, 0x50])], 'front.png', { type: 'image/png' });
  const driver = createHfSpaceDriver(spec);
  const input: DriverInput = {
    image: { width: 2, height: 1, data: new Uint8ClampedArray(8).fill(200) },
    mask,
    file: f,
    params: { ...defaultParams(driver.params), ...params },
    views: {},
    signal,
    onProgress: (p) => progress.push(p),
  };
  return { input, progress };
}

function driverWith(spec: HfSpaceSpec, g: ReturnType<typeof fakeGradio>, extra: Partial<HfSpaceDriverOptions> = {}) {
  return createHfSpaceDriver(spec, {
    gradio: async () => g.gradio,
    aiSettings: () => null,
    random: () => 0.5,
    encodePng: async () => new Blob([new Uint8Array([1])], { type: 'image/png' }),
    ...extra,
  });
}

const TRELLIS_OK = {
  '/start_session': ok([]),
  '/preprocess_image': ok([file('https://owner-space.hf.space/gradio_api/file=/tmp/pre.png')]),
  '/image_to_3d': ok([file('https://owner-space.hf.space/gradio_api/file=/tmp/preview.mp4')]),
  '/extract_glb': ok([file('https://owner-space.hf.space/gradio_api/file=/tmp/sample.glb'), file('https://owner-space.hf.space/gradio_api/file=/tmp/sample2.glb')]),
};

describe('HF Space drivers', () => {
  it('registers the four models first in the cloud list, as closed full-3D GLB drivers', () => {
    expect(CLOUD_DRIVERS.slice(0, 4).map((d) => d.id)).toEqual(['hf-trellis', 'hf-hunyuan3d-2', 'hf-triposg', 'hf-stable-fast-3d']);
    for (const d of CLOUD_DRIVERS.slice(0, 4)) {
      expect(d.category).toBe('cloud');
      expect(d.badges).toEqual(['full-3d', 'closed-mesh']);
      expect(d.producesDepth).toBe(false);
      expect(d.params.find((p) => p.key === 'hfToken')).toMatchObject({ kind: 'text', secret: true });
      for (const k of ['space', 'endpoint', 'extraArgs', 'seed', 'timeoutMin']) expect(d.params.some((p) => p.key === k), k).toBe(true);
      expect(new Set(d.params.map((p) => p.key)).size).toBe(d.params.length);
    }
    for (const s of HF_SPACE_SPECS) expect(s.steps.filter((x) => x.main)).toHaveLength(1);
  });

  it('is available without a key, with a hint about the free quota', async () => {
    const a = await createHfSpaceDriver(TRELLIS_SPEC).isAvailable!();
    expect(a.ok).toBe(true);
    expect(a.reason?.en).toMatch(/ZeroGPU/);
    expect(a.reason?.tr).toMatch(/anahtar/);
  });

  it('TRELLIS: runs the steps in one session, relays queue / GPU progress and returns the validated GLB', async () => {
    const g = fakeGradio(TRELLIS_OK);
    const fetch = fetchGlb();
    const driver = driverWith(TRELLIS_SPEC, g, { fetch });
    const { input, progress } = makeInput({ hfToken: ' hf_abcdefghijk123 ', seed: 42, steps: 20, simplify: 0.9, textureSize: '2048' });
    const r = await driver.run(input);
    expect(r.kind).toBe('model');
    expect(r.kind === 'model' && new Uint8Array(r.glb)[0]).toBe(0x67);

    expect(g.connects).toHaveLength(1);
    expect(g.connects[0].space).toBe('JeffreyXiang/TRELLIS');
    expect(g.connects[0].options.token).toBe('hf_abcdefghijk123');
    expect(g.connects[0].options.events).toEqual(['data', 'status']);
    expect(g.connects[0].options.record_history).toBe(false);
    expect(g.calls.map((c) => c.endpoint)).toEqual(['/start_session', '/preprocess_image', '/image_to_3d', '/extract_glb']);
    const gen = g.calls[2].data as Record<string, unknown>;
    expect(gen).toMatchObject({ seed: 42, ss_sampling_steps: 20, slat_sampling_steps: 20 });
    expect((gen.image as { url: string }).url).toMatch(/pre\.png$/); // the preprocessed image is passed on
    expect(g.calls[3].data).toEqual({ mesh_simplify: 0.9, texture_size: 2048 });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toMatch(/sample\.glb$/);
    expect((fetch.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer hf_abcdefghijk123');
    expect(g.closed()).toBe(1);

    const labels = progress.map((p) => p.label.en);
    expect(labels.some((l) => /position 3\/5, ~30 s/.test(l))).toBe(true);
    expect(progress.some((p) => /GPU’da üretiliyor/.test(p.label.tr))).toBe(true);
    expect(labels.some((l) => /50%.*Sampling/.test(l))).toBe(true);
    expect(labels[labels.length - 1]).toBe('Done');
    const ratios = progress.map((p) => p.ratio ?? 0);
    for (let i = 1; i < ratios.length; i++) expect(ratios[i]).toBeGreaterThanOrEqual(ratios[i - 1] - 1e-9);
  });

  it('uploads the cut-out PNG when a mask exists (and the original otherwise)', async () => {
    const g = fakeGradio(TRELLIS_OK);
    const cut = new Blob([new Uint8Array([7])], { type: 'image/png' });
    const encodePng = vi.fn(async () => cut);
    const mask: Mask = { width: 2, height: 1, data: new Uint8Array([1, 0]) };
    const { input } = makeInput({}, TRELLIS_SPEC, undefined, mask);
    await driverWith(TRELLIS_SPEC, g, { fetch: fetchGlb(), encodePng }).run(input);
    expect(encodePng).toHaveBeenCalledTimes(1);
    const img = (encodePng.mock.calls[0] as unknown as [{ data: Uint8ClampedArray }])[0];
    expect([img.data[3], img.data[7]]).toEqual([200, 0]);
    const pre = g.calls[1].data as { image: { handled: File } };
    expect(await pre.image.handled.arrayBuffer()).toEqual(await cut.arrayBuffer());

    const g2 = fakeGradio(TRELLIS_OK);
    const { input: in2 } = makeInput({ cutout: false }, TRELLIS_SPEC, undefined, mask);
    await driverWith(TRELLIS_SPEC, g2, { fetch: fetchGlb(), encodePng }).run(in2);
    expect(((g2.calls[1].data as { image: { handled: File } }).image.handled as File).name).toBe('front.png');
  });

  it('takes an hf_ token from the AI provider settings when the param is empty', async () => {
    const p = (label: string, apiKey: string, extra: Partial<ProviderConfig> = {}): ProviderConfig => ({
      id: label, kind: 'openai-compatible', label, apiKey, values: {}, models: {}, enabled: true, ...extra,
    });
    const settings: AiSettings = {
      providers: [p('OpenAI', 'sk-123'), p('Other', 'hf_otherotherother'), p('HF router', 'hf_routerrouter1', { values: { baseUrl: 'https://router.huggingface.co/v1' } })],
      defaults: {},
      rememberKeys: false,
    };
    expect(hfTokenFromAiSettings(settings)).toBe('hf_routerrouter1');
    expect(hfTokenFromAiSettings({ ...settings, providers: [p('x', 'hf_disableddisab', { enabled: false })] })).toBe('');
    const g = fakeGradio(TRELLIS_OK);
    const { input } = makeInput({});
    await driverWith(TRELLIS_SPEC, g, { fetch: fetchGlb(), aiSettings: () => settings }).run(input);
    expect(g.connects[0].options.token).toBe('hf_routerrouter1');
  });

  it('rejects a malformed token and a bad Space id before connecting', async () => {
    const g = fakeGradio(TRELLIS_OK);
    const d = driverWith(TRELLIS_SPEC, g);
    await expect(d.run(makeInput({ hfToken: 'hf_ab cd"' }).input)).rejects.toThrow(/hf_/);
    await expect(d.run(makeInput({ space: 'not a space' }).input)).rejects.toThrow(/owner\/name/);
    await expect(d.run(makeInput({ extraArgs: '{oops' }).input)).rejects.toThrow(/JSON/);
    expect(g.connects).toHaveLength(0);
  });

  it('applies the Space / endpoint / extra-argument overrides to the main step', async () => {
    const g = fakeGradio({ ...TRELLIS_OK, '/image_to_3d_v2': TRELLIS_OK['/image_to_3d'] });
    const { input } = makeInput({
      space: 'https://huggingface.co/spaces/me/my-trellis',
      endpoint: 'image_to_3d_v2',
      extraArgs: '{"ss_guidance_strength": 9, "slat_sampling_steps": null, "seed2": "$seed"}',
      seed: 7,
    });
    await driverWith(TRELLIS_SPEC, g, { fetch: fetchGlb() }).run(input);
    expect(g.connects[0].space).toBe('me/my-trellis');
    expect(g.calls[2].endpoint).toBe('/image_to_3d_v2');
    const args = g.calls[2].data as Record<string, unknown>;
    expect(args.ss_guidance_strength).toBe(9);
    expect('slat_sampling_steps' in args).toBe(false);
    expect(args.seed2).toBe(7);
  });

  it('maps a ZeroGPU quota error to a token / other-model suggestion', async () => {
    const g = fakeGradio({ ...TRELLIS_OK, '/image_to_3d': fail('You have exceeded your GPU quota (60s requested vs. 12s left). Create a free account to get more usage quota.') });
    const e = await driverWith(TRELLIS_SPEC, g).run(makeInput({}).input).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LocalizedError);
    expect((e as LocalizedError).i18n.en).toMatch(/quota.*access token.*another model/s);
    expect((e as LocalizedError).i18n.tr).toMatch(/kota/);
    expect(g.closed()).toBe(1);

    const g2 = fakeGradio({ ...TRELLIS_OK, '/image_to_3d': fail('ZeroGPU quota exceeded') });
    const e2 = await driverWith(TRELLIS_SPEC, g2).run(makeInput({ hfToken: 'hf_abcdefghijk123' }).input).catch((x: unknown) => x);
    expect((e2 as LocalizedError).i18n.en).toMatch(/refills|PRO/);
  });

  it('reports a sleeping / paused Space and names the mirror', async () => {
    const g = fakeGradio({}, { connectError: new Error('Could not resolve app config. '), statuses: [{ status: 'sleeping' }] });
    const { input, progress } = makeInput({});
    const e = await driverWith(TRELLIS_SPEC, g).run(input).catch((x: unknown) => x);
    expect((e as LocalizedError).i18n.en).toMatch(/not running.*trellis-community\/TRELLIS/s);
    expect(progress.some((p) => /waking/.test(p.label.en))).toBe(true);
  });

  it('reports an unknown endpoint with the advanced-override hint', async () => {
    const g = fakeGradio({ ...TRELLIS_OK, '/extract_glb': new Error('There is no endpoint matching that name of fn_index matching that number.') });
    const e = await driverWith(TRELLIS_SPEC, g).run(makeInput({}).input).catch((x: unknown) => x);
    expect((e as LocalizedError).i18n.en).toMatch(/\/extract_glb.*Advanced/s);
  });

  it('aborts: cancels the running job and throws AbortError', async () => {
    const g = fakeGradio({ ...TRELLIS_OK, '/image_to_3d': 'hang' });
    const ac = new AbortController();
    const { input } = makeInput({}, TRELLIS_SPEC, ac.signal);
    const p = driverWith(TRELLIS_SPEC, g).run(input);
    await vi.waitFor(() => expect(g.calls.some((c) => c.endpoint === '/image_to_3d')).toBe(true));
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortError);
    await vi.waitFor(() => expect(g.cancels).toContain('/image_to_3d'));
    expect(g.closed()).toBe(1);
  });

  it('times out with a clear message', async () => {
    const g = fakeGradio({ ...TRELLIS_OK, '/image_to_3d': 'hang' });
    const { input } = makeInput({ timeoutMin: 2 });
    const e = await driverWith(TRELLIS_SPEC, g, { minuteMs: 5 }).run(input).catch((x: unknown) => x);
    expect((e as LocalizedError).i18n.en).toMatch(/did not finish within 2 minutes/);
    expect(g.cancels).toContain('/image_to_3d');
  });

  it('rejects a download that is not a GLB', async () => {
    const g = fakeGradio(TRELLIS_OK);
    const e = await driverWith(TRELLIS_SPEC, g, { fetch: fetchGlb(new TextEncoder().encode('<html>nope</html>').buffer as ArrayBuffer) })
      .run(makeInput({}).input)
      .catch((x: unknown) => x);
    expect((e as LocalizedError).i18n.en).toMatch(/valid GLB/);
  });

  it('Hunyuan3D-2: textured → /generation_all and the textured file; off → /shape_generation', async () => {
    const out = [file('https://x.hf.space/f/white_mesh.glb'), file('https://x.hf.space/f/textured_mesh.glb'), '<html>', '<html>', {}, 1];
    const g = fakeGradio({ '/generation_all': ok(out), '/shape_generation': ok([out[0], '<html>', {}, 1]) });
    const fetch = fetchGlb();
    await driverWith(HUNYUAN3D_SPEC, g, { fetch }).run(makeInput({ octree: '384' }, HUNYUAN3D_SPEC).input);
    expect(g.calls[0].endpoint).toBe('/generation_all');
    expect(g.calls[0].data).toMatchObject({ octree_resolution: 384, check_box_rembg: true, randomize_seed: false });
    expect(String(fetch.mock.calls[0][0])).toMatch(/textured_mesh\.glb$/);
    await driverWith(HUNYUAN3D_SPEC, g, { fetch }).run(makeInput({ textured: false }, HUNYUAN3D_SPEC).input);
    expect(g.calls[1].endpoint).toBe('/shape_generation');
    expect(String(fetch.mock.calls[1][0])).toMatch(/white_mesh\.glb$/);
  });

  it('TripoSG: a failing optional texture step falls back to the untextured shape', async () => {
    const g = fakeGradio({
      '/run_segmentation': ok([file('https://x.hf.space/f/seg.png')]),
      '/image_to_3d': ok([file('https://x.hf.space/f/mesh.glb')]),
      '/run_texture': fail('CUDA out of memory'),
    });
    const fetch = fetchGlb();
    const { input, progress } = makeInput({}, TRIPOSG_SPEC);
    const r = await driverWith(TRIPOSG_SPEC, g, { fetch }).run(input);
    expect(r.kind).toBe('model');
    expect(g.calls.map((c) => c.endpoint)).toEqual(['/run_segmentation', '/image_to_3d', '/run_texture']);
    expect((g.calls[2].data as { mesh_path: { url: string } }).mesh_path.url).toMatch(/mesh\.glb$/);
    expect(String(fetch.mock.calls[0][0])).toMatch(/mesh\.glb$/);
    expect(progress.some((p) => /skipped/.test(p.label.en))).toBe(true);
  });

  it('Stable Fast 3D: one call when the first returns the model, a second "Generate" call otherwise', async () => {
    const withModel = ['Run', null, null, null, file('https://x.hf.space/f/sf3d.glb')];
    const g = fakeGradio({ '/run_button': ok(withModel) });
    await driverWith(SF3D_SPEC, g, { fetch: fetchGlb() }).run(makeInput({}, SF3D_SPEC).input);
    expect(g.calls).toHaveLength(1);
    expect((g.calls[0].data as unknown[])[0]).toBe('Run');
    expect((g.calls[0].data as unknown[]).slice(3)).toEqual([0.85, 'None', -1, 1024]);

    const bgOnly = ['Generate', file('https://x.hf.space/f/proc.png'), true, file('https://x.hf.space/f/prev.png'), null];
    const g2 = fakeGradio({ '/run_button': [ok(bgOnly), ok(withModel)] });
    await driverWith(SF3D_SPEC, g2, { fetch: fetchGlb() }).run(makeInput({}, SF3D_SPEC).input);
    expect(g2.calls).toHaveLength(2);
    expect((g2.calls[1].data as unknown[])[0]).toBe('Generate');
    expect((g2.calls[1].data as unknown[])[2]).toBe(true);
  });
});

describe('HF helpers', () => {
  it('classifies Space errors', () => {
    expect(classifyHfError('You have exceeded your GPU quota (60s requested vs. 12s left).')).toBe('quota');
    expect(classifyHfError('No GPU was available after 60s. Retry later')).toBe('gpu');
    expect(classifyHfError('This application is currently busy. Please try again. ')).toBe('busy');
    expect(classifyHfError('Space is asleep. Waking it up...')).toBe('sleeping');
    expect(classifyHfError('Could not resolve app config. ')).toBe('sleeping');
    expect(classifyHfError('Space "a/b" could not be accessed (received a 404 response from the Hugging Face API).')).toBe('not-found');
    expect(classifyHfError('Invalid credentials. Could not login. ')).toBe('token');
    expect(classifyHfError('Parameter `foo` is not a valid keyword argument. Please refer to the API for usage.')).toBe('endpoint');
    expect(classifyHfError('Failed to fetch')).toBe('network');
    expect(classifyHfError('something odd')).toBe('other');
  });

  it('normalises Space ids and extra args', () => {
    expect(normalizeSpace(' tencent/Hunyuan3D-2 ')).toBe('tencent/Hunyuan3D-2');
    expect(normalizeSpace('https://huggingface.co/spaces/VAST-AI/TripoSG/tree/main')).toBe('VAST-AI/TripoSG');
    expect(normalizeSpace('https://me-trellis.hf.space/')).toBe('https://me-trellis.hf.space');
    expect(normalizeSpace('bad id')).toBeNull();
    expect(parseExtraArgs('')).toBeNull();
    expect(() => parseExtraArgs('3')).toThrow(LocalizedError);
    expect(applyExtraArgs({ a: 1 }, ['$image', '$seed', 2], { image: 'IMG', seed: 5 })).toEqual(['IMG', 5, 2]);
    expect(applyExtraArgs([1], { a: 1 }, { image: 'IMG', seed: 5 })).toEqual([1]);
  });

  it('finds the model file: preferred output, else any .glb, and names non-GLB formats', () => {
    const spec = { ...TRELLIS_SPEC, glbOutputs: [{ step: 'extract', index: 1 }] };
    expect(pickModelFile(spec, { extract: [file('https://a/x.glb'), file('https://a/y.glb')] }).file?.url).toBe('https://a/y.glb');
    expect(pickModelFile(spec, { generate: [{ __type__: 'update', value: file('https://a/z.glb') }] }).file?.url).toBe('https://a/z.glb');
    expect(pickModelFile(spec, { extract: [file('https://a/m.obj')] })).toEqual({ file: null, other: 'obj' });
    expect(collectFiles(['https://a/b.glb?x=1', 'text'])).toHaveLength(1);
  });

  it('cuts the image out with the mask', () => {
    const img = { width: 2, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]) };
    expect(cutoutImage(img, { width: 2, height: 1, data: new Uint8Array([1, 0]) })!.data[7]).toBe(0);
    expect(cutoutImage(img, { width: 2, height: 1, data: new Uint8Array([1, 1]) })).toBeNull();
    expect(cutoutImage(img, null)).toBeNull();
  });
});
