/**
 * "Image enhancement" card of step 1: presets (automatic, AI ×2 / ×4 with
 * Swin2SR in the ML worker, pixel art, sharpen, denoise) with the resulting
 * size, a before / after comparison of the result and Apply / Discard; once
 * applied, Revert brings the previous image back. Opens by itself when the
 * image looks small, blurry or pixelated.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { I18nText, Progress, RGBAImage } from '../core/types';
import { analyzeCached, type ImageAnalysis } from '../core/enhance/analyze';
import {
  ENHANCE_PRESETS,
  SR_MODEL_MB,
  enhanceSuggestion,
  planEnhance,
  presetInfo,
  type EnhancePlan,
  type EnhancePresetId,
  type EnhanceReason,
} from '../core/enhance/presets';
import { textureImageOf, type SourceImage } from '../app/pipeline';
import type { EnhanceApplied, EnhancePending } from '../app/store';
import type { UIKey } from '../app/i18n';
import { formatSeconds } from '../app/format';
import { useI18n, type I18n } from './i18n';
import { Compare } from './ai/Compare';
import { ProgressBar } from './GeneratePanel';
import { IconAlert, IconCheck, IconInfo, IconUndo, IconWand, IconX } from './icons';

const REASON_KEYS: Record<EnhanceReason, UIKey> = {
  small: 'enhanceReasonSmall',
  blurry: 'enhanceReasonBlurry',
  pixelated: 'enhanceReasonPixelated',
  jpeg: 'enhanceReasonJpeg',
};

/** "small and blurry" in the current language. */
export function reasonsText(reasons: EnhanceReason[], t: I18n['t']): string {
  const words = reasons.map((r) => t(REASON_KEYS[r]));
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')}${t('enhanceAnd')}${words[words.length - 1]}`;
}

/** Short description of what a plan does. */
export function planText(plan: EnhancePlan, t: I18n['t']): string {
  switch (plan.kind) {
    case 'ai':
      return t('enhancePlanAi', { s: plan.scale });
    case 'pixel':
      return plan.grid.size > 1 ? `${t('enhancePlanPixel')} · ${t('enhancePlanGrid', { k: plan.grid.size })}` : t('enhancePlanPixel');
    case 'filter': {
      const names: Record<string, UIKey> = { deblock: 'enhanceOpDeblock', denoise: 'enhanceOpDenoise', upscale: 'enhanceOpUpscale', sharpen: 'enhanceOpSharpen' };
      const s = plan.ops.map((o) => t(names[o])).join(' + ');
      return s.charAt(0).toLocaleUpperCase() + s.slice(1);
    }
  }
}

/**
 * Analysis of `image`, computed shortly after it is shown (a few tens of ms
 * on the main thread; cached per image), so the preview paints first.
 */
export function useImageAnalysis(image: RGBAImage | null): ImageAnalysis | null {
  const [state, setState] = useState<{ image: RGBAImage; analysis: ImageAnalysis } | null>(null);
  useEffect(() => {
    if (!image) return;
    const id = window.setTimeout(() => {
      try {
        setState({ image, analysis: analyzeCached(image) });
      } catch (e) {
        console.warn('[enhance] analysis failed', e);
      }
    }, 30);
    return () => window.clearTimeout(id);
  }, [image]);
  return state && state.image === image ? state.analysis : null;
}

interface Props {
  source: SourceImage;
  analysis: ImageAnalysis | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  running: boolean;
  progress: Progress | null;
  error: I18nText | null;
  onDismissError: () => void;
  pending: EnhancePending | null;
  /** The enhancement in use (only while its result is the front). */
  applied: EnhanceApplied | null;
  onRun: (preset: EnhancePresetId) => void;
  onCancel: () => void;
  onApply: () => void;
  onDiscard: () => void;
  onRevert: () => void;
  /** Another job or a decode is in the way. */
  disabled: boolean;
}

export function EnhanceCard(p: Props) {
  const { t, tx } = useI18n();
  const id = useId();
  const { analysis } = p;
  const suggestion = useMemo(() => (analysis ? enhanceSuggestion(analysis) : null), [analysis]);
  const [preset, setPreset] = useState<EnhancePresetId>('auto');
  // A new image with an evident problem pre-selects the matching preset.
  const suggestedFor = useRef<ImageAnalysis | null>(null);
  useEffect(() => {
    if (!analysis || suggestedFor.current === analysis) return;
    suggestedFor.current = analysis;
    if (suggestion) setPreset(suggestion.preset);
  }, [analysis, suggestion]);

  const plans = useMemo(() => {
    const out = {} as Record<EnhancePresetId, EnhancePlan>;
    if (analysis) for (const info of ENHANCE_PRESETS) out[info.id] = planEnhance(info.id, analysis);
    return analysis ? out : null;
  }, [analysis]);
  const plan = plans?.[preset] ?? null;
  const input = textureImageOf(p.source);
  const lock = p.disabled || p.running;

  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (p.pending) resultRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [p.pending]);

  return (
    <details
      id="enhance-card"
      className={`card card-collapsible enhance-card${suggestion && !p.applied ? ' is-suggested' : ''}`}
      open={p.open}
      onToggle={(e) => {
        const open = (e.currentTarget as HTMLDetailsElement).open;
        if (open !== p.open) p.onOpenChange(open);
      }}
      data-testid="enhance-card"
    >
      <summary className="card-head" data-testid="enhance-toggle">
        <h2 className="card-title" id={`${id}-title`}>
          <IconWand /> {t('enhanceTitle')}
        </h2>
        {suggestion && !p.applied && !p.open && (
          <span className="state-chip is-warn" data-testid="enhance-suggested-chip">
            {reasonsText(suggestion.reasons.filter((r) => r !== 'jpeg'), t)}
          </span>
        )}
        {p.applied && (
          <span className="state-chip is-ok">
            <IconCheck size={12} /> {tx(presetInfo(p.applied.preset).label)}
          </span>
        )}
      </summary>

      <div className="enhance-body">
        <p className="muted small">{t('enhanceIntro')}</p>

        {suggestion && !p.applied && (
          <p className="note small enhance-suggest" role="status" data-testid="enhance-suggestion">
            <IconInfo size={14} /> {t('enhanceSuggest', { reasons: reasonsText(suggestion.reasons, t) })}
          </p>
        )}

        {p.applied && (
          <div className="prepared-note" role="status" data-testid="enhance-applied">
            <IconInfo size={14} />
            <span className="grow small">{t('enhanceInUse', { preset: tx(presetInfo(p.applied.preset).label) })}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={p.onRevert} disabled={lock} data-testid="enhance-revert">
              <IconUndo size={14} /> {t('enhanceRevert')}
            </button>
          </div>
        )}

        <div className="enhance-presets" role="group" aria-label={t('enhancePresets')}>
          {ENHANCE_PRESETS.map((info) => {
            const pl = plans?.[info.id];
            const on = preset === info.id;
            return (
              <button
                key={info.id}
                type="button"
                className={`enhance-preset${on ? ' is-on' : ''}`}
                aria-pressed={on}
                aria-describedby={`${id}-plan`}
                onClick={() => setPreset(info.id)}
                disabled={p.running}
                title={tx(info.hint)}
                data-testid={`enhance-preset-${info.id}`}
              >
                <span className="enhance-preset-label">{tx(info.label)}</span>
                {pl && (
                  <span className="enhance-preset-size tabular">
                    {pl.width} × {pl.height}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div id={`${id}-plan`} className="enhance-plan small" aria-live="polite" data-testid="enhance-plan">
          <p className="muted">{tx(presetInfo(preset).hint)}</p>
          {plan && (
            <p>
              <strong>{planText(plan, t)}</strong>
              {' · '}
              <span className="tabular" data-testid="enhance-size">
                {t('enhanceSize', { w0: input.width, h0: input.height, w: plan.width, h: plan.height })}
              </span>
            </p>
          )}
          {plan?.kind === 'ai' && <p className="muted">{t('enhanceAiDownload', { mb: SR_MODEL_MB[plan.model] ?? 50 })}</p>}
        </div>

        <div className="ai-run">
          {p.running ? (
            <div className="generate-row">
              <button type="button" className="btn btn-primary grow" disabled aria-busy="true">
                <span className="spinner" aria-hidden="true" /> {t('enhanceRunning')}
              </button>
              <button type="button" className="btn btn-secondary" onClick={p.onCancel} data-testid="enhance-cancel">
                <IconX size={16} /> {t('enhanceCancel')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-secondary btn-block"
              onClick={() => p.onRun(preset)}
              disabled={lock || !analysis}
              title={p.disabled ? t('enhanceBusyOther') : undefined}
              data-testid="enhance-run"
            >
              <IconWand size={16} /> {p.pending ? t('enhanceRunAgain') : t('enhanceRun')}
            </button>
          )}
          {p.running && <ProgressBar progress={p.progress} testId="enhance-progress" />}
        </div>

        {p.error && !p.running && (
          <div className="alert alert-danger" role="alert" data-testid="enhance-error">
            <IconAlert size={18} />
            <div className="alert-body">
              <strong>{t('enhanceErrorTitle')}</strong>
              <p style={{ whiteSpace: 'pre-line' }}>{tx(p.error)}</p>
            </div>
            <button type="button" className="icon-btn" onClick={p.onDismissError} aria-label={t('enhanceDiscard')}>
              <IconX size={14} />
            </button>
          </div>
        )}

        {p.pending && (
          <div className="ai-result" ref={resultRef} data-testid="enhance-result">
            <div className="ai-result-head">
              <strong className="small">{t('enhanceResult')}</strong>
              <span className="muted small truncate" title={p.pending.source.name}>
                {textureImageOf(p.pending.source).width} × {textureImageOf(p.pending.source).height} px · {planText(p.pending.plan, t)} ·{' '}
                {t('enhanceTook', { s: formatSeconds(p.pending.elapsedMs) })}
              </span>
            </div>
            <Compare before={textureImageOf(p.pending.from)} after={textureImageOf(p.pending.source)} testId="enhance-compare" />
            {p.pending.fallback && (
              <p className="note small" role="status" data-testid="enhance-fallback">
                <IconInfo size={14} /> <span title={tx(p.pending.fallback)}>{t('enhanceFallback')}</span>
              </p>
            )}
            <p className="field-hint">{t('enhanceApplyHint')}</p>
            <div className="generate-row">
              <button type="button" className="btn btn-primary grow" onClick={p.onApply} disabled={lock} data-testid="enhance-apply">
                <IconCheck size={16} /> {t('enhanceApply')}
              </button>
              <button type="button" className="btn btn-secondary" onClick={p.onDiscard} disabled={p.running} data-testid="enhance-discard">
                <IconX size={16} /> {t('enhanceDiscard')}
              </button>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
