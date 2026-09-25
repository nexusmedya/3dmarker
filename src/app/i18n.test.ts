import { describe, expect, it } from 'vitest';
import type { I18nText } from '../core/types';
import { DRIVERS } from '../drivers';
import { UI, detectLang, formatInt, t, tx } from './i18n';
import { FAQ, HERO, HIGHLIGHTS, PLANS, SECTION_TITLES, STEPS } from './content';
import { BADGE_HINTS, BADGE_LABELS, CATEGORY_LABELS } from './driverMeta';

function expectComplete(text: I18nText, where: string) {
  expect(text.tr.trim(), `${where} (tr)`).not.toBe('');
  expect(text.en.trim(), `${where} (en)`).not.toBe('');
}

describe('detectLang', () => {
  it('Turkish only when the first preferred language is Turkish', () => {
    expect(detectLang(['tr-TR', 'en-US'])).toBe('tr');
    expect(detectLang('tr')).toBe('tr');
    expect(detectLang(['en-GB', 'tr'])).toBe('en');
    expect(detectLang(undefined)).toBe('en');
    expect(detectLang([])).toBe('en');
  });
});

describe('tx / t', () => {
  it('fills placeholders and leaves unknown ones', () => {
    expect(tx({ tr: '%{pct} ön plan', en: '{pct}% fg {x}' }, 'en', { pct: 42 })).toBe('42% fg {x}');
    expect(t('downloadSize', 'tr', { mb: 50 })).toContain('50 MB');
    expect(t('generate', 'en')).toBe('Generate 3D');
  });

  it('formats integers per locale', () => {
    expect(formatInt(1234567, 'en')).toBe('1,234,567');
    expect(formatInt(1234567, 'tr')).toBe('1.234.567');
  });
});

describe('copy is bilingual', () => {
  it('UI strings', () => {
    for (const [k, v] of Object.entries(UI)) expectComplete(v, k);
  });

  it('landing content and driver metadata', () => {
    for (const v of Object.values(HERO)) expectComplete(v, 'hero');
    for (const v of Object.values(SECTION_TITLES)) expectComplete(v, 'section');
    for (const s of [...STEPS, ...HIGHLIGHTS]) {
      expectComplete(s.title, 'step');
      expectComplete(s.body, 'step');
    }
    for (const f of FAQ) {
      expectComplete(f.q, 'faq');
      expectComplete(f.a, 'faq');
    }
    for (const p of PLANS) [p.name, p.price, p.period, p.blurb, p.cta, ...p.features].forEach((x) => expectComplete(x, p.id));
    for (const v of [...Object.values(BADGE_LABELS), ...Object.values(BADGE_HINTS), ...Object.values(CATEGORY_LABELS)]) expectComplete(v, 'meta');
  });

  it('every registered driver has bilingual name / description / params', () => {
    for (const d of DRIVERS) {
      expectComplete(d.name, d.id);
      expectComplete(d.description, d.id);
      for (const p of d.params) expectComplete(p.label, `${d.id}.${p.key}`);
    }
  });
});
