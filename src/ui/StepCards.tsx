/** Small cards of the step panels: human-detail status, AI-prepared image note, depth editor entry. */
import type { HumanAnalysis } from '../core/human/types';
import { useI18n } from './i18n';
import { IconAlert, IconCheck, IconInfo, IconLayers, IconPerson, IconUndo } from './icons';

/**
 * Human detection for drivers with the 'human-detail' badge (informative:
 * the driver runs its own, cached analysis when generating).
 */
export function HumanDetailNote({
  human,
  enabled,
  onDetect,
  disabled,
}: {
  human: HumanAnalysis | 'analyzing' | null;
  /** The driver's human-detail parameter is on. */
  enabled: boolean;
  onDetect: () => void;
  disabled?: boolean;
}) {
  const { t, tx } = useI18n();
  let state: 'off' | 'analyzing' | 'pending' | 'human' | 'none' | 'unavailable';
  if (!enabled) state = 'off';
  else if (human === 'analyzing') state = 'analyzing';
  else if (!human) state = 'pending';
  else if (human.isHuman) state = 'human';
  else if (human.unavailableReason || human.unavailableText) state = 'unavailable';
  else state = 'none';

  return (
    <section className="card human-note" aria-labelledby="human-note-title" data-testid="human-detail" data-state={state}>
      <div className="card-head">
        <h2 id="human-note-title" className="card-title">
          <IconPerson /> {t('humanTitle')}
        </h2>
        {state === 'pending' && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onDetect} disabled={disabled} data-testid="human-detect">
            {t('humanDetectNow')}
          </button>
        )}
      </div>
      <div className="human-note-body" aria-live="polite">
        {state === 'off' && (
          <p className="note small">
            <IconInfo size={14} /> {t('humanOff')}
          </p>
        )}
        {state === 'pending' && (
          <p className="note small">
            <IconInfo size={14} /> {t('humanPending')}
          </p>
        )}
        {state === 'analyzing' && (
          <span className="state-chip">
            <span className="spinner spinner-sm" aria-hidden="true" /> {t('humanAnalyzing')}
          </span>
        )}
        {state === 'human' && human && human !== 'analyzing' && (
          <>
            <div className="human-note-row">
              <span className="state-chip is-ok">
                <IconCheck size={13} /> {t('humanDetected')}
              </span>
              <span className="muted small tabular">{t('humanCounts', { f: human.faces.length, h: human.hands.length, p: human.poses.length })}</span>
            </div>
            <p className="muted small">{t('humanDetectedBody')}</p>
          </>
        )}
        {state === 'none' && (
          <div className="human-note-row">
            <span className="state-chip">
              <IconInfo size={13} /> {t('humanNone')}
            </span>
            <span className="muted small">{t('humanNoneBody')}</span>
          </div>
        )}
        {state === 'unavailable' && human && human !== 'analyzing' && (
          <div className="human-note-row">
            <span className="state-chip is-warn">
              <IconAlert size={13} /> {t('humanUnavailable')}
            </span>
            <span className="muted small">{human.unavailableText ? tx(human.unavailableText) : human.unavailableReason}</span>
          </div>
        )}
      </div>
    </section>
  );
}

/** "Using the AI-prepared image · Revert to original". */
export function OriginalNote({ onRevert, disabled, testId = 'revert-original' }: { onRevert: () => void; disabled?: boolean; testId?: string }) {
  const { t } = useI18n();
  return (
    <div className="prepared-note" role="status">
      <IconInfo size={14} />
      <span className="grow small">{t('preparedInUse')}</span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onRevert} disabled={disabled} data-testid={testId}>
        <IconUndo size={14} /> {t('revertOriginal')}
      </button>
    </div>
  );
}

/** Entry to the depth map editor (depth results only). */
export function DepthEditCard({
  available,
  rigged,
  sculpted,
  onOpen,
  disabled,
}: {
  /** The model on screen was built from a depth map. */
  available: boolean;
  rigged: boolean;
  sculpted: boolean;
  onOpen: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const note = !available ? t('depthEditNeedsDepth') : rigged ? t('depthEditRigged') : sculpted ? t('depthEditSculpted') : null;
  return (
    <section className="card" aria-labelledby="depth-edit-title" data-testid="depth-edit-card">
      <div className="card-head">
        <h2 id="depth-edit-title" className="card-title">
          <IconLayers /> {t('depthEditTitle')}
        </h2>
      </div>
      <p className="muted small">{t('depthEditBody')}</p>
      <button
        type="button"
        className="btn btn-secondary btn-block"
        onClick={onOpen}
        disabled={disabled || !available || rigged}
        data-testid="depth-edit-open"
        aria-haspopup="dialog"
      >
        <IconLayers size={16} /> {t('depthEditOpen')}
      </button>
      {note && (
        <p className="note small">
          <IconInfo size={14} /> {note}
        </p>
      )}
    </section>
  );
}
