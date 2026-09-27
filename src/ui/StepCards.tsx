/** Small cards of the step panels: AI-prepared image note, depth editor entry. */
import { useState } from 'react';
import { useI18n } from './i18n';
import { IconAlert, IconInfo, IconLayers, IconUndo } from './icons';

/**
 * "Using the AI-prepared image · Revert to original". Reverting drops the AI
 * views made from the prepared image (paid work), so it asks first when there
 * are any; the reducer keeps an undo slot either way (RevertedNote).
 */
export function OriginalNote({
  onRevert,
  disabled,
  aiViewCount = 0,
  testId = 'revert-original',
}: {
  onRevert: () => void;
  disabled?: boolean;
  aiViewCount?: number;
  testId?: string;
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  if (confirming && aiViewCount > 0) {
    return (
      <div className="prepared-note is-confirm" role="alert" data-testid={`${testId}-confirm`}>
        <IconAlert size={14} />
        <span className="grow small">{t('revertConfirm', { n: aiViewCount })}</span>
        <span className="prepared-note-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              setConfirming(false);
              onRevert();
            }}
            disabled={disabled}
            data-testid={`${testId}-go`}
          >
            <IconUndo size={14} /> {t('revertOriginal')}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(false)} data-testid={`${testId}-keep`}>
            {t('revertKeep')}
          </button>
        </span>
      </div>
    );
  }
  return (
    <div className="prepared-note" role="status">
      <IconInfo size={14} />
      <span className="grow small">{t('preparedInUse')}</span>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => (aiViewCount > 0 ? setConfirming(true) : onRevert())}
        disabled={disabled}
        data-testid={testId}
      >
        <IconUndo size={14} /> {t('revertOriginal')}
      </button>
    </div>
  );
}

/** After "Revert to original": the AI-prepared image (and its views) can come back. */
export function RevertedNote({ onRestore, disabled, aiViewCount = 0 }: { onRestore: () => void; disabled?: boolean; aiViewCount?: number }) {
  const { t } = useI18n();
  return (
    <div className="prepared-note" role="status">
      <IconInfo size={14} />
      <span className="grow small">{t('originalInUse')}</span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onRestore} disabled={disabled} data-testid="restore-prepared">
        <IconUndo size={14} /> {aiViewCount > 0 ? t('restorePreparedViews', { n: aiViewCount }) : t('restorePrepared')}
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
