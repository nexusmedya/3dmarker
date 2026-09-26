/**
 * "AI preparation" card: before the 3D step, an image-edit provider restyles
 * the source (dozens of styles), re-poses a humanoid into a T-pose, completes
 * a partly visible body (a head → the full body) and removes the background
 * of its results. Shows the human detection, the run / cancel / progress
 * state and a before / after comparison with Accept / Discard.
 * Pure: the shell owns every value and runs the job.
 */
import { useId } from 'react';
import type { I18nText, Progress, RGBAImage } from '../../core/types';
import type { HumanAnalysis } from '../../core/human/types';
import type { PrepOptions, ProviderConfig, SubjectKind } from '../../ai/types';
import { getProviderKind, isProviderKindId } from '../../ai/kinds';
import { isHumanoid, prepNeeded } from '../../ai/prompts';
import { useI18n } from '../i18n';
import { Switch } from '../ParamField';
import { ProgressBar } from '../GeneratePanel';
import { IconAlert, IconCheck, IconInfo, IconWand, IconX } from '../icons';
import { IconPerson, IconPlus, IconSettings } from './icons';
import type { AiJobStatus } from './types';
import { detectionState } from './logic';
import { StylePicker } from './StylePicker';
import { Compare } from './Compare';
import './ai.css';

export const PREP_TEXT = {
  title: { tr: 'Yapay zekâ ile hazırla', en: 'AI preparation' },
  intro: {
    tr: 'Görseli 3B’den önce yapay zekâ ile dönüştürün: stil, T-poz, eksik gövdeyi tamamlama, saydam arka plan.',
    en: 'Transform the image with AI before the 3D step: style, T-pose, complete the missing body, transparent background.',
  },
  providers: { tr: 'AI sağlayıcıları…', en: 'AI providers…' },
  provider: { tr: 'Sağlayıcı', en: 'Provider' },
  emptyTitle: { tr: 'Henüz bir AI sağlayıcısı yok', en: 'No AI provider set up yet' },
  emptyBody: {
    tr: 'OpenAI, Google Gemini, fal.ai… anahtarınızı ekleyin; stil verme, T-poz, gövde tamamlama ve eksik görünümleri üretme açılır.',
    en: 'Add an OpenAI, Google Gemini, fal.ai… key to unlock styles, T-pose, body completion and generating the missing views.',
  },
  emptyCta: { tr: 'AI sağlayıcısı ekle', en: 'Add an AI provider' },
  subject: { tr: 'Konu', en: 'Subject' },
  subjects: {
    auto: { tr: 'Otomatik algıla', en: 'Auto-detect' },
    human: { tr: 'İnsan', en: 'Human' },
    character: { tr: 'Karakter / insansı', en: 'Character / humanoid' },
    animal: { tr: 'Hayvan', en: 'Animal' },
    object: { tr: 'Nesne', en: 'Object' },
  } satisfies Record<SubjectKind, I18nText>,
  analyzing: { tr: 'İnsan algılanıyor…', en: 'Detecting people…' },
  human: { tr: 'İnsan algılandı', en: 'Human detected' },
  notHuman: { tr: 'İnsan algılanmadı', en: 'No person detected' },
  unavailable: { tr: 'Algılama kullanılamıyor', en: 'Detection unavailable' },
  counts: { tr: '{f} yüz · {h} el · {p} gövde', en: '{f} · {h} · {p}' },
  tPose: { tr: 'T-poz olarak çıkar', en: 'Output in T-pose' },
  tPoseHint: {
    tr: 'Kişiyi ya da insansı karakteri simetrik T-pozuna getirir; iskelet ve animasyon için en iyisi.',
    en: 'Re-poses the person or humanoid character into a symmetric T-pose; best for rigging and animation.',
  },
  humanoidOnly: {
    tr: 'Yalnızca insan ve insansı karakterler için: “İnsan” ya da “Karakter” seçin veya otomatik algılamanın bir kişi bulmasını bekleyin.',
    en: 'Only for people and humanoid characters: choose Human or Character, or let auto-detect find a person.',
  },
  completeBody: { tr: 'Eksik gövdeyi tamamla', en: 'Complete the full body' },
  completeBodyHint: {
    tr: 'Gövdenin bir kısmı görünüyorsa (ör. yalnızca baş) yapay zekâ tam boy bedeni çizer.',
    en: 'Only part of the body visible (e.g. just a head)? The AI draws the complete full-length body.',
  },
  completeObject: { tr: 'Eksik kısımları tamamla', en: 'Complete missing parts' },
  completeObjectHint: {
    tr: 'Kırpılmış ya da kapanmış kısımları yapay zekâ tamamlar; tüm konu kadrajda olur.',
    en: 'The AI completes cropped or hidden parts so the whole subject is in frame.',
  },
  removeBg: { tr: 'Arka planı kaldır', en: 'Remove background' },
  removeBgHint: {
    tr: 'Yapay zekâ çıktıları (bu görsel ve üretilen görünümler) saydam arka planla gelir.',
    en: 'AI outputs (this image and the generated views) get a transparent background.',
  },
  extra: { tr: 'Ek talimat (isteğe bağlı)', en: 'Extra instructions (optional)' },
  extraPlaceholder: { tr: 'ör. kırmızı atkıyı koru, gülümsesin, spor ayakkabı', en: 'e.g. keep the red scarf, smiling, sneakers' },
  run: { tr: 'AI ile hazırla', en: 'Prepare with AI' },
  runAgain: { tr: 'Yeniden hazırla', en: 'Prepare again' },
  running: { tr: 'Hazırlanıyor…', en: 'Preparing…' },
  cancel: { tr: 'İptal', en: 'Cancel' },
  needSource: { tr: 'Önce bir görsel yükleyin.', en: 'Upload an image first.' },
  needProvider: { tr: 'Önce bir AI sağlayıcısı ekleyin.', en: 'Add an AI provider first.' },
  needOption: {
    tr: 'Bir stil, T-poz, tamamlama ya da arka plan kaldırma seçin veya talimat yazın.',
    en: 'Pick a style, T-pose, completion or background removal, or write instructions.',
  },
  errorTitle: { tr: 'Yapay zekâ işlemi başarısız', en: 'The AI step failed' },
  resultTitle: { tr: 'Sonuç', en: 'Result' },
  accept: { tr: 'Bu görseli kullan', en: 'Use this image' },
  discard: { tr: 'Vazgeç', en: 'Discard' },
  resultHint: {
    tr: 'Kabul ederseniz 3B model ve bundan sonra üretilen görünümler bu görselden yapılır.',
    en: 'Accept it and the 3D model and the views generated from now on are made from this image.',
  },
  aiViewsDropped: {
    tr: 'Önceki görselden yapay zekâyla üretilen {n} görünüm kabul edince kaldırılır (yüklediğiniz görünümler kalır); onları yeni görselden yeniden üretin.',
    en: 'Views generated by AI from the previous image ({n}) are removed when you accept (uploaded views stay); generate them again from the new image.',
  },
} as const;

const T = PREP_TEXT;
const SUBJECTS: SubjectKind[] = ['auto', 'human', 'character', 'animal', 'object'];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

interface Props {
  hasSource: boolean;
  prep: PrepOptions;
  onPrep: (patch: Partial<PrepOptions>) => void;
  /** Usable image-edit providers. */
  providers: ProviderConfig[];
  providerId: string | null;
  onProvider: (id: string) => void;
  onOpenSettings: () => void;
  human: HumanAnalysis | 'analyzing' | null;
  status: AiJobStatus;
  progress: Progress | null;
  error: I18nText | null;
  onRun: () => void;
  onCancel: () => void;
  prepared: { image: RGBAImage; name: string } | null;
  /** AI-generated extra views: made from the current front, dropped on Accept. */
  aiViewCount?: number;
  original: RGBAImage | null;
  onAccept: () => void;
  onDiscard: () => void;
  disabled?: boolean;
}

function providerOptionLabel(p: ProviderConfig): string {
  const kind = isProviderKindId(p.kind) ? getProviderKind(p.kind).name : p.kind;
  const label = p.label.trim() || kind;
  return label === kind ? label : `${label} · ${kind}`;
}

export function AiPrepPanel(p: Props) {
  const { tx, lang } = useI18n();
  const id = useId();
  const running = p.status === 'running';
  const lock = !!p.disabled || running;
  const hasProvider = p.providers.length > 0;
  const detection = detectionState(p.human);
  const humanoid = isHumanoid(p.prep, { isHuman: detection.kind === 'human' });
  const needed = prepNeeded({ ...p.prep, tPose: p.prep.tPose && humanoid });
  const providerValue = p.providers.some((x) => x.id === p.providerId) ? p.providerId! : p.providers[0]?.id ?? '';

  // Background removal alone runs without an image-edit provider.
  const bgOnly = !needed && p.prep.removeBackground;
  const blocked: I18nText | null = !p.hasSource
    ? T.needSource
    : bgOnly
      ? null
      : !hasProvider
        ? T.needProvider
        : !needed
          ? T.needOption
          : null;
  const canRun = !lock && !blocked;

  const countsText =
    detection.kind === 'human'
      ? lang === 'tr'
        ? tx(T.counts, { f: detection.faces, h: detection.hands, p: detection.poses })
        : tx(T.counts, { f: plural(detection.faces, 'face', 'faces'), h: plural(detection.hands, 'hand', 'hands'), p: plural(detection.poses, 'body', 'bodies') })
      : '';

  return (
    <section className={`card ai-prep${running ? ' is-running' : ''}`} aria-labelledby={`${id}-title`} data-testid="ai-prep">
      <div className="card-head">
        <h2 id={`${id}-title`} className="card-title">
          <IconWand /> {tx(T.title)} <span className="pill pill-accent">AI</span>
        </h2>
      </div>
      <p className="muted small">{tx(T.intro)}</p>

      {!hasProvider ? (
        <div className="ai-empty" data-testid="ai-prep-empty">
          <span className="ai-empty-icon" aria-hidden="true">
            <IconWand size={20} />
          </span>
          <strong>{tx(T.emptyTitle)}</strong>
          <p className="muted small">{tx(T.emptyBody)}</p>
          <button type="button" className="btn btn-primary btn-sm" onClick={p.onOpenSettings} data-testid="ai-prep-setup">
            <IconPlus size={14} /> {tx(T.emptyCta)}
          </button>
        </div>
      ) : (
        <div className="field">
          <div className="field-row">
            <label className="field-label" htmlFor={`${id}-provider`}>
              {tx(T.provider)}
            </label>
            <button type="button" className="btn btn-ghost btn-sm ai-provider-btn" onClick={p.onOpenSettings} data-testid="ai-prep-settings" disabled={running}>
              <IconSettings size={14} /> {tx(T.providers)}
            </button>
          </div>
          <select
            id={`${id}-provider`}
            className="select"
            value={providerValue}
            disabled={lock}
            data-testid="ai-prep-provider"
            onChange={(e) => p.onProvider(e.target.value)}
          >
            {p.providers.map((cfg) => (
              <option key={cfg.id} value={cfg.id}>
                {providerOptionLabel(cfg)}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="field">
        <label className="field-label" htmlFor={`${id}-subject`}>
          {tx(T.subject)}
        </label>
        <select
          id={`${id}-subject`}
          className="select"
          value={p.prep.subject}
          disabled={lock}
          aria-describedby={`${id}-detect`}
          data-testid="ai-prep-subject"
          onChange={(e) => p.onPrep({ subject: e.target.value as SubjectKind })}
        >
          {SUBJECTS.map((s) => (
            <option key={s} value={s}>
              {tx(T.subjects[s])}
            </option>
          ))}
        </select>
        <div id={`${id}-detect`} className="ai-detect" aria-live="polite" data-testid="ai-prep-detect" data-state={detection.kind}>
          {detection.kind === 'analyzing' && (
            <span className="ai-chip">
              <span className="spinner spinner-sm" aria-hidden="true" /> {tx(T.analyzing)}
            </span>
          )}
          {detection.kind === 'human' && (
            <>
              <span className="ai-chip is-ok">
                <IconPerson size={13} /> {tx(T.human)}
              </span>
              <span className="muted small tabular">{countsText}</span>
            </>
          )}
          {detection.kind === 'not-human' && (
            <span className="ai-chip">
              <IconInfo size={13} /> {tx(T.notHuman)}
            </span>
          )}
          {detection.kind === 'unavailable' && (
            <>
              <span className="ai-chip is-warn" title={detection.reason ? tx(detection.reason) : undefined}>
                <IconAlert size={13} /> {tx(T.unavailable)}
              </span>
              {detection.reason && <span className="muted small ai-detect-reason">{tx(detection.reason)}</span>}
            </>
          )}
        </div>
      </div>

      <StylePicker value={p.prep.styleId} onChange={(styleId) => p.onPrep({ styleId })} disabled={lock} />

      <div className="ai-toggles">
        <div className="field">
          <Switch
            id={`${id}-tpose`}
            checked={p.prep.tPose && humanoid}
            disabled={lock || !humanoid}
            onChange={(v) => p.onPrep({ tPose: v })}
            label={tx(T.tPose)}
            describedBy={`${id}-tpose-hint`}
            testId="ai-prep-tpose"
          />
          <p id={`${id}-tpose-hint`} className="field-hint">
            {tx(humanoid ? T.tPoseHint : T.humanoidOnly)}
          </p>
        </div>
        <div className="field">
          <Switch
            id={`${id}-complete`}
            checked={p.prep.completeBody}
            disabled={lock}
            onChange={(v) => p.onPrep({ completeBody: v })}
            label={tx(humanoid ? T.completeBody : T.completeObject)}
            describedBy={`${id}-complete-hint`}
            testId="ai-prep-complete"
          />
          <p id={`${id}-complete-hint`} className="field-hint">
            {tx(humanoid ? T.completeBodyHint : T.completeObjectHint)}
          </p>
        </div>
        <div className="field">
          <Switch
            id={`${id}-bg`}
            checked={p.prep.removeBackground}
            disabled={lock}
            onChange={(v) => p.onPrep({ removeBackground: v })}
            label={tx(T.removeBg)}
            describedBy={`${id}-bg-hint`}
            testId="ai-prep-removebg"
          />
          <p id={`${id}-bg-hint`} className="field-hint">
            {tx(T.removeBgHint)}
          </p>
        </div>
      </div>

      <div className="field">
        <label className="field-label" htmlFor={`${id}-extra`}>
          {tx(T.extra)}
        </label>
        <textarea
          id={`${id}-extra`}
          className="input ai-textarea"
          rows={2}
          maxLength={1000}
          value={p.prep.extraPrompt}
          placeholder={tx(T.extraPlaceholder)}
          disabled={lock}
          data-testid="ai-prep-extra"
          onChange={(e) => p.onPrep({ extraPrompt: e.target.value })}
        />
      </div>

      <div className="ai-run">
        {running ? (
          <div className="generate-row">
            <button type="button" className="btn btn-primary grow" disabled aria-busy="true">
              <span className="spinner" aria-hidden="true" /> {tx(T.running)}
            </button>
            <button type="button" className="btn btn-secondary" onClick={p.onCancel} data-testid="ai-prep-cancel">
              <IconX size={16} /> {tx(T.cancel)}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={p.onRun}
            disabled={!canRun}
            title={blocked ? tx(blocked) : undefined}
            aria-describedby={blocked && !p.disabled ? `${id}-blocked` : undefined}
            data-testid="ai-prep-run"
          >
            <IconWand size={16} /> {tx(p.prepared ? T.runAgain : T.run)}
          </button>
        )}
        {running && <ProgressBar progress={p.progress} testId="ai-prep-progress" />}
        {!running && blocked && !p.disabled && (
          <p id={`${id}-blocked`} className="muted small center" data-testid="ai-prep-blocked">
            {tx(blocked)}
          </p>
        )}
      </div>

      {p.error && !running && (
        <div className="alert alert-danger" role="alert" data-testid="ai-prep-error">
          <IconAlert size={18} />
          <div className="alert-body">
            <strong>{tx(T.errorTitle)}</strong>
            <p>{tx(p.error)}</p>
          </div>
        </div>
      )}

      {p.prepared && (
        <div className="ai-result" data-testid="ai-prep-result">
          <div className="ai-result-head">
            <strong className="small">{tx(T.resultTitle)}</strong>
            <span className="muted small truncate" title={p.prepared.name}>
              {p.prepared.name} · {p.prepared.image.width} × {p.prepared.image.height}
            </span>
          </div>
          <Compare before={p.original} after={p.prepared.image} testId="ai-prep-compare" />
          <p className="field-hint">{tx(T.resultHint)}</p>
          {!!p.aiViewCount && (
            <p className="note small" role="status" data-testid="ai-prep-views-dropped">
              <IconInfo size={14} /> {tx(T.aiViewsDropped, { n: p.aiViewCount })}
            </p>
          )}
          <div className="generate-row">
            <button type="button" className="btn btn-primary grow" onClick={p.onAccept} disabled={lock} data-testid="ai-prep-accept">
              <IconCheck size={16} /> {tx(T.accept)}
            </button>
            <button type="button" className="btn btn-secondary" onClick={p.onDiscard} disabled={lock} data-testid="ai-prep-discard">
              <IconX size={16} /> {tx(T.discard)}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
