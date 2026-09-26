/**
 * Post-run consistency report of a multi-view fusion (step 3D): its
 * warnings and one chip per view with the registration score, level and
 * trust. The report comes from the model's geometry (pipeline.fusionReportOf).
 */
import type { FusionReport, ViewReport } from '../core/fusion/types';
import { VIEW_LABELS } from '../ai/views';
import { useI18n } from './i18n';
import { IconAlert, IconInfo } from './icons';
import { IconViews } from './ai/icons';

export function FusionReportNote({ report }: { report: FusionReport | null }) {
  const { t, tx } = useI18n();
  if (!report) return null;
  return (
    <section className="card fusion-report" aria-labelledby="fusion-report-title" data-testid="fusion-report">
      <div className="card-head">
        <h2 id="fusion-report-title" className="card-title">
          <IconViews /> {t('fusionReport')}
        </h2>
      </div>
      <ul className="fusion-chips" aria-label={t('fusionReport')}>
        {report.views.map((v) => (
          <ReportChip key={v.id} view={v} />
        ))}
      </ul>
      {report.warnings.map((w, i) => (
        <p key={i} className="note small" role="status">
          <IconAlert size={14} /> {tx(w)}
        </p>
      ))}
      {report.warnings.length === 0 && (
        <p className="note small">
          <IconInfo size={14} /> {tx(TEXT.consistent)}
        </p>
      )}
    </section>
  );
}

const TEXT = {
  consistent: { tr: 'Görünümler tutarlı; uyarı yok.', en: 'The views are consistent; no warnings.' },
};

function ReportChip({ view }: { view: ViewReport }) {
  const { t, tx } = useI18n();
  const first = view.notes[0];
  const label = `${tx(VIEW_LABELS[view.id])} ${view.score}`;
  return (
    <li
      className={`fusion-chip is-${view.level}${view.trust !== 'full' ? ' is-partial' : ''}`}
      data-testid={`fusion-view-${view.id}`}
      data-score={view.score}
      data-level={view.level}
      data-trust={view.trust}
      data-consistency={view.consistency === null ? undefined : view.consistency.toFixed(2)}
      title={first ? tx(first.text) : undefined}
    >
      <span className="tabular">{label}</span>
      {view.trust === 'color' && <span className="muted"> · {t('fusionColorOnly')}</span>}
    </li>
  );
}
