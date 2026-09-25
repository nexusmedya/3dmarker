import { describe, expect, it } from 'vitest';
import { AbortError } from '../../core/types';
import { LocalizedError } from '../../core/errors';
import { isNetworkError, localizeMlError } from './errors';

describe('localizeMlError', () => {
  it('maps browser fetch failures to a bilingual download error', () => {
    for (const msg of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) {
      const e = new TypeError(msg);
      expect(isNetworkError(e)).toBe(true);
      const out = localizeMlError(e, 'org/model');
      expect(out).toBeInstanceOf(LocalizedError);
      expect((out as LocalizedError).i18n.en).toContain('Hugging Face');
      expect((out as LocalizedError).i18n.tr).toContain('org/model');
    }
  });

  it('maps missing weight files', () => {
    const e = new Error('Could not locate file: "https://huggingface.co/x/onnx/model.onnx".');
    e.name = 'ModelFileNotFoundError';
    const out = localizeMlError(e, 'x') as LocalizedError;
    expect(out.i18n.en).toMatch(/not found on Hugging Face/);
  });

  it('passes aborts, localized and unknown errors through', () => {
    const abort = new AbortError();
    expect(localizeMlError(abort, 'm')).toBe(abort);
    const loc = new LocalizedError({ tr: 'a', en: 'b' });
    expect(localizeMlError(loc, 'm')).toBe(loc);
    const other = new Error('boom');
    expect(localizeMlError(other, 'm')).toBe(other);
    expect(localizeMlError('str', 'm')).toBe('str');
  });
});
