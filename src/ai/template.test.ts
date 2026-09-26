import { describe, expect, it } from 'vitest';
import { LocalizedError } from '../core/errors';
import { findOutputUrl, getPath, isValidTemplate, parseTemplate, renderString, renderTemplate, templatePlaceholders } from './template';

describe('renderTemplate', () => {
  it('replaces whole placeholders by values (arrays too) and inline ones as text', () => {
    const tpl = { prompt: '{{prompt}}', image_urls: '{{images}}', note: 'model {{model}} v1', n: 1, nested: { a: ['{{image}}', 'x'] } };
    const out = renderTemplate(tpl, { prompt: 'hi', images: ['data:a', 'data:b'], model: 'm', image: 'data:a' });
    expect(out).toEqual({ prompt: 'hi', image_urls: ['data:a', 'data:b'], note: 'model m v1', n: 1, nested: { a: ['data:a', 'x'] } });
  });

  it('drops keys and array items whose whole placeholder is missing', () => {
    const tpl = { front_image_url: '{{front}}', back_image_url: '{{back}}', list: ['{{left}}', '{{front}}'] };
    expect(renderTemplate(tpl, { front: 'F' })).toEqual({ front_image_url: 'F', list: ['F'] });
  });

  it('tolerates spaces inside braces and leaves non-placeholders alone', () => {
    expect(renderTemplate({ a: '{{ prompt }}', b: '{prompt}' }, { prompt: 'p' })).toEqual({ a: 'p', b: '{prompt}' });
    expect(renderString('Bearer {{key}}', { key: 'k' })).toBe('Bearer k');
    expect(renderString('x{{missing}}y', {})).toBe('xy');
  });

  it('lists placeholders', () => {
    expect(templatePlaceholders('{"a":"{{image}}","b":"{{image_base64}} {{prompt}}"}').sort()).toEqual(['image', 'image_base64', 'prompt']);
  });
});

describe('parseTemplate', () => {
  it('throws a bilingual error on invalid JSON', () => {
    expect(() => parseTemplate('{nope', 'body')).toThrow(LocalizedError);
    expect(isValidTemplate('')).toBe(true);
    expect(isValidTemplate('{"a":1}')).toBe(true);
    expect(isValidTemplate('{a:1}')).toBe(false);
  });
});

describe('getPath', () => {
  it('follows dotted and bracketed paths', () => {
    const o = { data: [{ b64_json: 'AAA' }], output: { url: 'u' } };
    expect(getPath(o, 'data.0.b64_json')).toBe('AAA');
    expect(getPath(o, 'data[0].b64_json')).toBe('AAA');
    expect(getPath(o, '$.output.url')).toBe('u');
    expect(getPath(o, 'data.3.x')).toBeUndefined();
    expect(getPath('str', 'a')).toBeUndefined();
  });
});

describe('findOutputUrl', () => {
  it('prefers GLBs for models and skips previews', () => {
    const out = {
      thumbnail: { url: 'https://v3.fal.media/files/a/thumb.png', content_type: 'image/png' },
      model_urls: { obj: { url: 'https://v3.fal.media/files/a/model.obj' }, glb: { url: 'https://v3.fal.media/files/a/model.glb' } },
    };
    expect(findOutputUrl(out, 'model')).toBe('https://v3.fal.media/files/a/model.glb');
    expect(findOutputUrl({ model_mesh: { url: 'https://x/m.bin', content_type: 'model/gltf-binary' } }, 'model')).toBe('https://x/m.bin');
  });

  it('prefers images and skips masks', () => {
    const out = { mask_image: { url: 'https://x/mask.png' }, image: { url: 'https://x/out.png' } };
    expect(findOutputUrl(out, 'image')).toBe('https://x/out.png');
    expect(findOutputUrl(['https://replicate.delivery/a/out.webp'], 'image')).toBe('https://replicate.delivery/a/out.webp');
    expect(findOutputUrl('https://replicate.delivery/a/out.png', 'image')).toBe('https://replicate.delivery/a/out.png');
    expect(findOutputUrl({ nothing: 1 }, 'image')).toBeNull();
  });
});
