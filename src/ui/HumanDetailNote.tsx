/**
 * Step 4 card of the drivers with the 'human-detail' badge: what the human
 * detection (MediaPipe) found for the current image. Informative — the
 * driver runs its own, cached analysis when generating. When detection could
 * not run (models blocked, no WebGL, timeout) or some detectors failed, the
 * card says why, that generation goes on without that relief, and offers a
 * retry.
 */
import type { HumanAnalysis, HumanDetector } from '../core/human/types';
import type { I18nText } from '../core/types';
import { useI18n } from './i18n';
import { IconAlert, IconCheck, IconInfo, IconPerson, IconRotate } from './icons';

export type HumanNoteState = 'off' | 'analyzing' | 'pending' | 'human' | 'none' | 'unavailable';

export const HUMAN_NOTE_TEXT = {
  unavailableEffect: {
    tr: '3B üretim yine çalışır, ancak yüz ve el kabartması eklenmez. Ağ bağlantısını kontrol edip yeniden deneyebilirsiniz.',
    en: 'Generation still works, but without face and hand relief. Check the network connection and try again.',
  },
  partial: {
    tr: '{list} algılama kullanılamadı; bulunanlarla devam edilir.',
    en: '{list} detection unavailable; the rest is used.',
  },
  retry: { tr: 'Yeniden dene', en: 'Try again' },
} satisfies Record<string, I18nText>;

const DETECTOR_NAMES: Record<HumanDetector, I18nText> = {
  faces: { tr: 'Yüz', en: 'Face' },
  hands: { tr: 'El', en: 'Hand' },
  pose: { tr: 'Vücut', en: 'Body' },
};

export function humanNoteState(human: HumanAnalysis | 'analyzing' | null, enabled: boolean): HumanNoteState {
  if (!enabled) return 'off';
  if (human === 'analyzing') return 'analyzing';
  if (!human) return 'pending';
  if (human.isHuman) return 'human';
  if (human.unavailableReason || human.unavailableText) return 'unavailable';
  return 'none';
}

export function HumanDetailNote({
  human,
  enabled,
  onDetect,
  onRetry,
  disabled,
}: {
  human: HumanAnalysis | 'analyzing' | null;
  /** The driver's human-detail parameter is on. */
  enabled: boolean;
  onDetect: () => void;
  /** Detect again after a failure (forgets remembered load failures first); defaults to onDetect. */
  onRetry?: () => void;
  disabled?: boolean;
}) {
  const { t, tx, lang } = useI18n();
  const state = humanNoteState(human, enabled);
  const analysis = human && human !== 'analyzing' ? human : null;
  const failed = state === 'human' || state === 'none' ? (Object.keys(analysis?.failed ?? {}) as HumanDetector[]) : [];
  const partial = failed.length > 0;
  const retry = (
    <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry ?? onDetect} disabled={disabled} data-testid="human-retry">
      <IconRotate size={14} /> {tx(HUMAN_NOTE_TEXT.retry)}
    </button>
  );

  return (
    <section
      className="card human-note"
      aria-labelledby="human-note-title"
      data-testid="human-detail"
      data-state={state}
      data-partial={partial ? 'true' : undefined}
    >
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
        {state === 'human' && analysis && (
          <>
            <div className="human-note-row">
              <span className="state-chip is-ok">
                <IconCheck size={13} /> {t('humanDetected')}
              </span>
              <span className="muted small tabular">{t('humanCounts', { f: analysis.faces.length, h: analysis.hands.length, p: analysis.poses.length })}</span>
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
        {partial && (
          <div className="human-note-row" role="status" data-testid="human-partial">
            <span className="state-chip is-warn">
              <IconAlert size={13} /> {tx(HUMAN_NOTE_TEXT.partial, { list: failed.map((k) => DETECTOR_NAMES[k][lang]).join(', ') })}
            </span>
            {retry}
          </div>
        )}
        {state === 'unavailable' && analysis && (
          <div role="alert" className="human-note-body" data-testid="human-unavailable">
            <div className="human-note-row">
              <span className="state-chip is-warn">
                <IconAlert size={13} /> {t('humanUnavailable')}
              </span>
              <span className="muted small" data-testid="human-unavailable-reason">
                {analysis.unavailableText ? tx(analysis.unavailableText) : analysis.unavailableReason}
              </span>
            </div>
            <p className="muted small">{tx(HUMAN_NOTE_TEXT.unavailableEffect)}</p>
            <div className="human-note-row">{retry}</div>
          </div>
        )}
      </div>
    </section>
  );
}
