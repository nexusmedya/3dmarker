/** Load failures read as plain words in both languages. */
import { describe, expect, it } from 'vitest';
import { failureDetail } from './mediapipe';

describe('failureDetail', () => {
  it('names blocked hosts, timeouts and HTTP errors in Turkish and English', () => {
    expect(failureDetail('Failed to fetch').tr).toContain('model sunucusuna ulaşılamadı');
    expect(failureDetail('NetworkError when attempting to fetch resource.').en).toContain('could not be reached');
    expect(failureDetail('Download of https://x/y.task timed out')).toEqual({
      tr: 'indirme zaman aşımına uğradı (bağlantı çok yavaş ya da kesildi)',
      en: 'the download timed out (connection too slow or dropped)',
    });
    expect(failureDetail('HTTP 403 for https://x/y.task').tr).toBe('sunucu HTTP 403 yanıtı verdi');
    expect(failureDetail('Unable to create WebGL context').en).toMatch(/^graphics acceleration \(WebGL\)/);
    expect(failureDetail('something odd')).toEqual({ tr: 'something odd', en: 'something odd' });
  });
});
