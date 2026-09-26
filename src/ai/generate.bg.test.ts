/**
 * ensureTransparent's local fallbacks, with the browser-only decoder / encoder
 * and the MODNet model mocked (Node has no canvas).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Progress, RGBAImage } from '../core/types';
import { AbortError } from '../core/types';
import { DEFAULT_PREP_OPTIONS } from './types';
import { createProviderConfig, DEFAULT_AI_SETTINGS, setCurrentAiSettings } from './settings';
import { fakeNet, json, PNG_BASE64 } from './testing';

const mocks = vi.hoisted(() => ({
  images: new Map<Blob, RGBAImage>(),
  removeBackground: vi.fn(),
}));

vi.mock('./encode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./encode')>();
  return {
    ...actual,
    decodeRGBA: vi.fn(async (b: Blob) => mocks.images.get(b) ?? null),
    encodePng: vi.fn(async (img: RGBAImage) => {
      const out = new Blob([new Uint8Array(img.data)], { type: 'image/png' });
      mocks.images.set(out, img);
      return out;
    }),
  };
});
vi.mock('../core/preprocess/removeBackground', () => ({ removeBackground: mocks.removeBackground }));

const { borderKeyMask, ensureTransparent, hasTransparency, prepareFrontImage } = await import('./generate');
const { decodeRGBA } = await import('./encode');
/** What unknown blobs (provider results) decode to. */
let decodeUnknown: RGBAImage | null = null;

/** w×h white image with an opaque red square in the middle (or noise everywhere). */
function image(kind: 'white-bg' | 'busy' | 'transparent', size = 20): RGBAImage {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const inside = x >= 6 && x < 14 && y >= 6 && y < 14;
      if (kind === 'busy') data.set([(x * 53 + y * 97) % 256, (x * 31) % 256, (y * 71) % 256, 255], o);
      else data.set(inside ? [220, 20, 20, 255] : [255, 255, 255, kind === 'transparent' ? 0 : 255], o);
    }
  return { width: size, height: size, data };
}

function blobOf(img: RGBAImage): Blob {
  const b = new Blob([PNG_BASE64], { type: 'image/png' });
  mocks.images.set(b, img);
  return b;
}

const signal = () => new AbortController().signal;

beforeEach(() => {
  mocks.removeBackground.mockReset();
  decodeUnknown = null;
  vi.mocked(decodeRGBA).mockImplementation(async (b: Blob) => mocks.images.get(b) ?? decodeUnknown);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setCurrentAiSettings(DEFAULT_AI_SETTINGS, false);
});

describe('borderKeyMask', () => {
  it('keys out a plain border and refuses busy ones', () => {
    const mask = borderKeyMask(image('white-bg'))!;
    expect(mask).not.toBeNull();
    expect(mask.data.reduce((a, v) => a + v, 0)).toBeGreaterThan(20);
    expect(borderKeyMask(image('busy'))).toBeNull();
  });
});

describe('ensureTransparent (local)', () => {
  it('keys out the white background of objects without the portrait model', async () => {
    const out = await ensureTransparent(blobOf(image('white-bg')), { bgProvider: null, signal: signal(), isHuman: false });
    expect(mocks.removeBackground).not.toHaveBeenCalled();
    expect(hasTransparency(mocks.images.get(out)!)).toBe(true);
  });

  it('uses MODNet first for humans', async () => {
    mocks.removeBackground.mockResolvedValue({ width: 20, height: 20, data: new Uint8Array(400).fill(1).fill(0, 0, 40) });
    const out = await ensureTransparent(blobOf(image('white-bg')), { bgProvider: null, signal: signal(), isHuman: true });
    expect(mocks.removeBackground).toHaveBeenCalledOnce();
    expect(hasTransparency(mocks.images.get(out)!)).toBe(true);
  });

  it('keeps the (paid) image with a warning when the model cannot load', async () => {
    mocks.removeBackground.mockRejectedValue(new Error('Failed to fetch https://huggingface.co/Xenova/modnet'));
    const busy = blobOf(image('busy'));
    const progress: Progress[] = [];
    expect(await ensureTransparent(busy, { bgProvider: null, signal: signal(), isHuman: false, onProgress: (p) => progress.push(p) })).toBe(busy);
    expect(progress.at(-1)!.label.en).toMatch(/could not be removed/);
    // A human on white still gets the colour key when MODNet fails.
    const out = await ensureTransparent(blobOf(image('white-bg')), { bgProvider: null, signal: signal(), isHuman: true });
    expect(hasTransparency(mocks.images.get(out)!)).toBe(true);
  });

  it('still rejects on abort', async () => {
    mocks.removeBackground.mockRejectedValue(new AbortError());
    await expect(ensureTransparent(blobOf(image('busy')), { bgProvider: null, signal: signal(), isHuman: true })).rejects.toBeInstanceOf(AbortError);
  });

  it('returns transparent images untouched', async () => {
    const b = blobOf(image('transparent'));
    expect(await ensureTransparent(b, { bgProvider: null, signal: signal() })).toBe(b);
  });
});

describe('ensureTransparent (provider)', () => {
  const fal = () => createProviderConfig('fal', { apiKey: 'k:s' });

  it('falls back locally when the provider fails or returns no transparency', async () => {
    const opaque = blobOf(image('white-bg'));
    vi.stubGlobal('fetch', fakeNet().on('POST', /queue\.fal\.run/, json({ error: { message: 'boom' } }, 400)).fetch);
    const failed = await ensureTransparent(opaque, { bgProvider: fal(), signal: signal(), isHuman: false });
    expect(hasTransparency(mocks.images.get(failed)!)).toBe(true);

    // The provider "succeeds" with an image that has no alpha: checked and keyed locally.
    decodeUnknown = image('busy');
    vi.stubGlobal(
      'fetch',
      fakeNet()
        .on('POST', /queue\.fal\.run/, json({ request_id: 'r' }))
        .on('GET', /status$/, json({ status: 'COMPLETED' }))
        .on('GET', /requests\/r$/, json({ image: { url: `data:image/png;base64,${PNG_BASE64}` } })).fetch,
    );
    const out = await ensureTransparent(blobOf(image('white-bg')), { bgProvider: fal(), signal: signal(), isHuman: false });
    expect(hasTransparency(mocks.images.get(out)!)).toBe(true);
  });
});

describe('prepareFrontImage', () => {
  it('keeps the edited image when MODNet cannot load', async () => {
    const edited = image('busy');
    vi.stubGlobal(
      'fetch',
      fakeNet().on('POST', 'https://api.openai.com/v1/images/edits', json({ data: [{ b64_json: PNG_BASE64 }] })).fetch,
    );
    mocks.removeBackground.mockRejectedValue(new Error('network'));
    // The decoded OpenAI result is opaque noise (no alpha, no plain border).
    decodeUnknown = edited;
    const cfg = createProviderConfig('openai', { apiKey: 'sk-1' });
    const out = await prepareFrontImage(new Blob(['src'], { type: 'image/png' }), { ...DEFAULT_PREP_OPTIONS, styleId: 'marble' }, cfg, {
      signal: signal(),
      onProgress: () => {},
      isHuman: true,
      bgProvider: null,
    });
    expect(out).toBeInstanceOf(Blob);
    expect(out.type).toBe('image/png');
  });
});
