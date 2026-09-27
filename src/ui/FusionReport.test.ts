// @vitest-environment jsdom
/** FusionReportNote: warnings, one chip per view with score / level / trust, colour-only wording, both languages. */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FusionReport, ViewReport } from '../core/fusion/types';
import { FusionReportNote } from './FusionReport';
import { byTestId, cleanup, mount, queryTestId } from './ai/testing';

afterEach(cleanup);

function view(id: ViewReport['id'], over: Partial<ViewReport> = {}): ViewReport {
  const c = { dx: 0, dy: 0, scale: 1, flipX: false };
  return {
    id,
    trust: 'full',
    depth: 'none',
    status: 'aligned',
    level: 'good',
    score: 92,
    applied: c,
    suggested: c,
    cut: { top: false, bottom: false, left: false, right: false },
    consistency: null,
    notes: [{ code: 'aligned', text: { tr: 'Ön görünümle hizalı', en: 'Aligned with the front' } }],
    ...over,
  };
}

const report: FusionReport = {
  views: [
    view('front', { status: 'bbox', score: 100 }),
    view('back', { score: 61, level: 'fair', consistency: 0.31, notes: [{ code: 'inconsistent', text: { tr: 'Tam örtüşmüyor', en: 'Does not quite match' } }] }),
    view('left', { trust: 'color', score: 40, level: 'poor' }),
  ],
  warnings: [{ tr: 'Sol görünümü yalnızca renk için kullanıldı', en: 'The left view was used for colour only' }],
};

describe('FusionReportNote', () => {
  it('renders nothing without a report', () => {
    mount(createElement(FusionReportNote, { report: null }));
    expect(queryTestId('fusion-report')).toBeNull();
  });

  it('lists the warnings and one chip per view with its data attributes', () => {
    mount(createElement(FusionReportNote, { report }));
    const root = byTestId('fusion-report');
    expect(root.textContent).toContain('Fusion report');
    expect(root.textContent).toContain('The left view was used for colour only');
    const back = byTestId('fusion-view-back');
    expect(back.dataset).toMatchObject({ score: '61', level: 'fair', trust: 'full', consistency: '0.31' });
    expect(back.textContent).toBe('Back 61');
    expect(back.title).toBe('Does not quite match');
    expect(byTestId('fusion-view-front').dataset.consistency).toBeUndefined();
    const left = byTestId('fusion-view-left');
    expect(left.dataset.trust).toBe('color');
    expect(left.textContent).toMatch(/Left 40 · colour only/);
    expect(root.querySelectorAll('[data-testid^="fusion-view-"]')).toHaveLength(3);
  });

  it('says so when there are no warnings, in Turkish too', () => {
    mount(createElement(FusionReportNote, { report: { ...report, warnings: [] } }), 'tr');
    const root = byTestId('fusion-report');
    expect(root.textContent).toContain('Birleştirme raporu');
    expect(root.textContent).toContain('uyarı yok');
    expect(byTestId('fusion-view-left').textContent).toMatch(/Sol 40 · yalnız renk/);
  });

  it('shows views switched off before the run as muted chips', () => {
    mount(createElement(FusionReportNote, { report, offViews: ['top', 'left'] }), 'tr');
    const top = byTestId('fusion-view-top');
    expect(top.dataset.trust).toBe('off');
    expect(top.textContent).toBe('Üst · kapalı');
    expect(top.dataset.score).toBeUndefined();
    // A view the report already lists is not duplicated.
    expect(document.querySelectorAll('[data-testid="fusion-view-left"]')).toHaveLength(1);
  });
});
