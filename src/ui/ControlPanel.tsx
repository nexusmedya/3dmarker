/** Left column of the studio: image, background, driver, parameters, mesh options, generate. */
import type { Availability } from '../core/types';
import { MESH_PARAMS } from '../core/mesh/options';
import { BACKGROUND_MODES, type BackgroundMode } from '../app/pipeline';
import type { UIKey } from '../app/i18n';
import type { Studio } from './useStudio';
import { useI18n } from './i18n';
import { UploadCard } from './UploadCard';
import { DriverPicker } from './DriverPicker';
import { ParamForm } from './ParamForm';
import { GeneratePanel } from './GeneratePanel';
import { IconCube, IconInfo, IconLayers, IconSparkles } from './icons';

const BG_LABELS: Record<BackgroundMode, UIKey> = {
  auto: 'bgAuto',
  border: 'bgBorder',
  ai: 'bgAi',
  none: 'bgNone',
};

interface Props {
  studio: Studio;
  availability: Availability | 'checking' | null;
}

export function ControlPanel({ studio, availability }: Props) {
  const { t, tx } = useI18n();
  const { state, driver, actions } = studio;
  const running = state.status === 'running';
  const params = state.params[driver.id] ?? {};
  const unavailable = availability && availability !== 'checking' && !availability.ok ? availability : null;
  const blocked = !!unavailable;
  const blockedReason = !state.source
    ? t('needImage')
    : unavailable
      ? unavailable.reason
        ? tx(unavailable.reason)
        : t('unavailable')
      : null;

  let bgNote: string | null = null;
  if (state.source) {
    if (state.bgMode === 'ai') bgNote = state.mask ? t('bgAiReady') : t('bgAiHint');
    else if (state.maskNote === 'no-alpha') bgNote = t('bgAutoNoAlpha');
    else if (state.maskNote === 'border-failed') bgNote = t('bgBorderFail');
  } else if (state.bgMode === 'ai') bgNote = t('bgAiHint');

  return (
    <aside className="panel" aria-label={t('navStudio')}>
      <div className="panel-scroll">
        <UploadCard
          source={state.source}
          loading={state.loadingImage}
          mask={state.mask}
          showMask={state.showMask}
          onShowMask={actions.setShowMask}
          onFile={(f) => void actions.loadFile(f, f.name || 'image.png')}
          onSample={(s) => void actions.loadSample(s)}
          onClear={actions.clearImage}
        />

        <section className="card" aria-labelledby="bg-title">
          <div className="card-head">
            <h2 id="bg-title" className="card-title">
              <IconLayers /> <label htmlFor="bg-select">{t('bgTitle')}</label>
            </h2>
          </div>
          <select
            id="bg-select"
            className="select"
            data-testid="bg-select"
            value={state.bgMode}
            onChange={(e) => actions.setBgMode(e.target.value as BackgroundMode)}
            disabled={running}
          >
            {BACKGROUND_MODES.map((m) => (
              <option key={m} value={m}>
                {t(BG_LABELS[m])}
              </option>
            ))}
          </select>
          {bgNote && (
            <p className="note small">
              <IconInfo size={14} /> {bgNote}
            </p>
          )}
        </section>

        <DriverPicker driver={driver} availability={availability} onSelect={actions.selectDriver} disabled={running} />

        {driver.params.length > 0 && (
          <ParamForm
            key={driver.id}
            id="params"
            title={t('paramsTitle')}
            icon={<IconSparkles />}
            specs={driver.params}
            values={params}
            onChange={(k, v) => actions.setParam(driver.id, k, v)}
            onReset={() => actions.resetParams(driver)}
          />
        )}

        {driver.producesDepth && (
          <ParamForm
            id="mesh"
            title={t('meshTitle')}
            icon={<IconCube />}
            badge={
              <span className="pill pill-live" title={t('meshLiveHint')}>
                {t('meshLive')}
              </span>
            }
            specs={MESH_PARAMS}
            values={state.meshParams}
            onChange={actions.setMeshParam}
            onReset={actions.resetMeshParams}
            note={
              state.meshNotice ? (
                <p className="note small" role="status">
                  <IconInfo size={14} /> {t('meshSuggested', { mode: tx(state.meshNotice) })}
                </p>
              ) : null
            }
          />
        )}
      </div>

      <GeneratePanel
        status={state.status}
        progress={state.progress}
        error={state.error}
        errorTitle={t(state.errorTitle)}
        canGenerate={!!state.source && !state.loadingImage && !blocked}
        blockedReason={blockedReason}
        hasResult={!!state.result}
        onGenerate={() => void actions.generate()}
        onCancel={actions.cancel}
        onDismiss={actions.dismissError}
      />
    </aside>
  );
}
