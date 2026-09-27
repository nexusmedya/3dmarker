/**
 * Generate / cancel, the progress bar and the error alert. Pinned at the
 * bottom of the studio panel: it generates from step 4's settings whatever
 * step is open (`summary` names the driver, `blockedAction` links to the
 * step that unblocks it). When the model on screen carries edits a new
 * generation would discard, `discardWarning` says so under the button and
 * `confirming` swaps the button for an inline "Regenerate anyway" question.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import type { I18nText, Progress } from '../core/types';
import type { JobStatus } from '../app/store';
import { useI18n } from './i18n';
import { IconAlert, IconSparkles, IconX } from './icons';

interface Props {
  status: JobStatus;
  progress: Progress | null;
  error: I18nText | null;
  errorTitle: string;
  canGenerate: boolean;
  blockedReason: string | null;
  hasResult: boolean;
  onGenerate: () => void;
  onCancel: () => void;
  onDismiss: () => void;
  /** One line above the button (e.g. the selected driver). */
  summary?: ReactNode;
  /** A button next to the blocked reason (e.g. "Go to Views"). */
  blockedAction?: { label: string; onClick: () => void } | null;
  /** What a new generation would throw away (sculpt / rig / depth edits); null = nothing. */
  discardWarning?: string | null;
  /** Generate was pressed with `discardWarning` set: ask before going on. */
  confirming?: boolean;
  onConfirm?: () => void;
  onCancelConfirm?: () => void;
  /** A recovery button in the error alert (e.g. "Try Silhouette inflate"). */
  errorAction?: { label: string; onClick: () => void } | null;
}

export function GeneratePanel({
  status,
  progress,
  error,
  errorTitle,
  canGenerate,
  blockedReason,
  hasResult,
  onGenerate,
  onCancel,
  onDismiss,
  summary,
  blockedAction,
  discardWarning,
  confirming,
  onConfirm,
  onCancelConfirm,
  errorAction,
}: Props) {
  const { t, tx } = useI18n();
  const running = status === 'running';
  const asking = !running && canGenerate && !!confirming && !!discardWarning;
  // Sticky on phones: focused controls keep clear of it (styles.css scroll-margin).
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--generate-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="generate-panel" ref={ref}>
      {summary}
      {running ? (
        <div className="generate-row">
          <button type="button" className="btn btn-primary btn-lg grow" disabled aria-busy="true">
            <span className="spinner" aria-hidden="true" /> {t('generating')}
          </button>
          <button type="button" className="btn btn-secondary btn-lg" onClick={onCancel} data-testid="cancel">
            <IconX size={16} /> {t('cancel')}
          </button>
        </div>
      ) : asking ? (
        <div className="regen-confirm" role="alertdialog" aria-labelledby="regen-confirm-text" data-testid="generate-confirm-box">
          <p id="regen-confirm-text" className="small">
            <IconAlert size={16} /> {discardWarning}
          </p>
          <div className="generate-row">
            <button type="button" className="btn btn-primary grow" onClick={onConfirm} data-testid="generate-confirm" autoFocus>
              <IconSparkles size={16} /> {t('regenAnyway')}
            </button>
            <button type="button" className="btn btn-secondary" onClick={onCancelConfirm} data-testid="generate-confirm-cancel">
              {t('keepEdits')}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-primary btn-lg btn-block"
          onClick={onGenerate}
          disabled={!canGenerate}
          data-testid="generate"
          title={blockedReason ?? t('shortcutHint')}
        >
          <IconSparkles size={18} /> {hasResult ? t('regenerate') : t('generate')}
        </button>
      )}
      {running && <ProgressBar progress={progress} />}
      {!running && blockedReason && (
        <p className="muted small center generate-blocked" data-testid="generate-blocked">
          {blockedReason}
          {blockedAction && (
            <>
              {' '}
              <button type="button" className="link-btn" onClick={blockedAction.onClick} data-testid="generate-blocked-action">
                {blockedAction.label}
              </button>
            </>
          )}
        </p>
      )}
      {!running && !blockedReason && !asking && discardWarning && (
        <p className="muted small center generate-warning" data-testid="generate-warning">
          {discardWarning}
        </p>
      )}
      {!running && !blockedReason && !asking && <p className="muted small center kbd-hint">{t('shortcutHint')}</p>}
      {status === 'cancelled' && !error && (
        <p className="muted small center" role="status">
          {t('cancelled')}
        </p>
      )}
      {error && (
        <div className="alert alert-danger" role="alert" data-testid="error">
          <IconAlert size={18} />
          <div className="alert-body">
            <strong>{errorTitle}</strong>
            <ErrorText
              text={tx(error)}
              action={
                errorAction && (
                  <button type="button" className="btn btn-secondary btn-sm error-action" onClick={errorAction.onClick} data-testid="error-action">
                    <IconSparkles size={14} /> {errorAction.label}
                  </button>
                )
              }
            />
          </div>
          <button type="button" className="icon-btn" onClick={onDismiss} aria-label={t('dismiss')} title={t('dismiss')}>
            <IconX size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

/** "Message. [technical detail]" → the message, and the detail for a disclosure. */
export function splitErrorDetail(text: string): { message: string; detail: string | null } {
  const m = /^([\s\S]*?)\s*\[([^\[\]]+)\]\s*$/.exec(text);
  return m && m[1] ? { message: m[1], detail: m[2] } : { message: text, detail: null };
}

/** The message, then one row with the recovery action and the folded technical detail. */
function ErrorText({ text, action }: { text: string; action?: ReactNode }) {
  const { t } = useI18n();
  const { message, detail } = splitErrorDetail(text);
  return (
    <>
      <p>{message}</p>
      {(action || detail) && (
        <div className="error-extra">
          {action}
          {detail && (
            <details className="error-detail" data-testid="error-detail">
              <summary>{t('errorDetails')}</summary>
              <code>{detail}</code>
            </details>
          )}
        </div>
      )}
    </>
  );
}

/** True when a driver's label already shows a percentage ("… 37%", "… %37"). */
export function labelHasPercent(label: string): boolean {
  return /\d\s*%|%\s*\d/.test(label);
}

/**
 * Progress label + bar. `decorative` renders a visual-only copy (no live
 * region / progressbar role) so a second bar, e.g. the viewer overlay's, is
 * not announced twice.
 */
export function ProgressBar({
  progress,
  testId = 'progress',
  compact,
  decorative,
}: {
  progress: Progress | null;
  testId?: string;
  compact?: boolean;
  decorative?: boolean;
}) {
  const { t, tx } = useI18n();
  const ratio = progress?.ratio;
  const known = typeof ratio === 'number' && Number.isFinite(ratio);
  const pct = known ? Math.round(Math.min(1, Math.max(0, ratio)) * 100) : null;
  const label = progress ? tx(progress.label) : t('starting');
  const pctText = pct !== null ? t('percent', { pct }) : null;
  return (
    <div className={`progress${compact ? ' progress-compact' : ''}`} data-testid={testId} aria-hidden={decorative || undefined}>
      <div className="progress-text" aria-live={decorative ? undefined : 'polite'}>
        <span className="truncate">{label}</span>
        {/* The bar's own number, unless the driver's label already carries one. */}
        {pctText !== null && !labelHasPercent(label) && <span className="tabular">{pctText}</span>}
      </div>
      <div
        className={`progress-track${known ? '' : ' is-indeterminate'}`}
        {...(decorative
          ? {}
          : {
              role: 'progressbar',
              'aria-label': label,
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': pct ?? undefined,
              'aria-valuetext': pctText ?? undefined,
            })}
      >
        <div className="progress-fill" style={known ? { width: `${pct}%` } : undefined} />
      </div>
    </div>
  );
}
