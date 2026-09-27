import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Lang, Progress } from '../core/types';
import { LangProvider } from './i18n';
import { GeneratePanel, ProgressBar, labelHasPercent, splitErrorDetail } from './GeneratePanel';

const render = (lang: Lang, progress: Progress | null, extra: { decorative?: boolean } = {}) =>
  renderToStaticMarkup(createElement(LangProvider, { value: lang }, createElement(ProgressBar, { progress, ...extra })));

describe('ProgressBar', () => {
  it('formats the percentage per language', () => {
    const p: Progress = { label: { tr: 'Şişiriliyor', en: 'Inflating' }, ratio: 0.36 };
    expect(render('en', p)).toContain('<span class="tabular">36%</span>');
    expect(render('tr', p)).toContain('<span class="tabular">%36</span>');
  });

  it('shows a single percentage when the driver label already has one', () => {
    const p: Progress = { label: { tr: '3B model oluşturuluyor… %37', en: 'Generating 3D model… 37%' }, ratio: 0.3645 };
    for (const lang of ['en', 'tr'] as const) {
      const html = render(lang, p);
      expect(html).not.toContain('class="tabular"');
      const text = /<div class="progress-text"[^>]*>(.*?)<\/div>/.exec(html)![1].replace(/<[^>]+>/g, '');
      expect(text).toBe(lang === 'en' ? 'Generating 3D model… 37%' : '3B model oluşturuluyor… %37');
      expect(html).toContain('aria-valuenow="36"'); // the bar itself still reports the ratio
    }
    expect(labelHasPercent('Downloading 12.5 MB')).toBe(false);
    expect(labelHasPercent('Building mesh…')).toBe(false);
  });

  it('only one copy is a live region / progressbar', () => {
    const p: Progress = { label: { tr: 'x', en: 'x' }, ratio: 0.5 };
    const main = render('en', p);
    expect(main).toContain('aria-live="polite"');
    expect(main).toContain('role="progressbar"');
    const overlay = render('en', p, { decorative: true });
    expect(overlay).not.toContain('aria-live');
    expect(overlay).not.toContain('role="progressbar"');
    expect(overlay).toContain('aria-hidden="true"');
  });
});

describe('error alert', () => {
  const base = {
    status: 'error' as const,
    progress: null,
    errorTitle: 'Generation failed',
    canGenerate: true,
    blockedReason: null,
    hasResult: false,
    onGenerate: () => {},
    onCancel: () => {},
    onDismiss: () => {},
  };
  const error = { tr: 'Model indirilemedi. [Failed to fetch]', en: 'Could not download the model. [Failed to fetch]' };

  it('keeps the technical tail in a closed disclosure and offers the recovery action', () => {
    const html = renderToStaticMarkup(
      createElement(LangProvider, { value: 'tr' }, createElement(GeneratePanel, { ...base, error, errorAction: { label: 'Siluet şişirme ile dene', onClick: () => {} } })),
    );
    expect(html).toContain('<p>Model indirilemedi.</p>');
    expect(html).toMatch(/<details class="error-detail"[^>]*><summary>Ayrıntılar<\/summary><code>Failed to fetch<\/code>/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain('data-testid="error-action"');
    expect(html).toContain('Siluet şişirme ile dene');
  });

  it('splitErrorDetail leaves messages without a tail alone', () => {
    expect(splitErrorDetail('Plain message.')).toEqual({ message: 'Plain message.', detail: null });
    expect(splitErrorDetail('[only]')).toEqual({ message: '[only]', detail: null });
    expect(splitErrorDetail('A [x] b')).toEqual({ message: 'A [x] b', detail: null });
  });
});
