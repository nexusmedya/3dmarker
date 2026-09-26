// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { analyzeHuman } from './analyze';

describe('analyzeHuman under jsdom (UI tests)', () => {
  it('never downloads models: reports unsupported instead', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const image = { width: 8, height: 8, data: new Uint8ClampedArray(256) };
    const a = await analyzeHuman(image, { signal: new AbortController().signal });
    expect(a.isHuman).toBe(false);
    expect(a.unavailableReason).toMatch(/not supported/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
