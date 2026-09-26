/** Left column of the studio: image, background, driver, parameters, mesh options, generate. */
import { MESH_PARAMS } from '../core/mesh/options';
import { BACKGROUND_MODES, type BackgroundMode } from '../app/pipeline';
import type { UIKey } from '../app/i18n';
import { canGenerate, meshModeLabel } from '../app/store';
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
}

export function ControlPanel({ studio }: Props) {
  const { t, tx } = useI18n();
  const { state, driver, availability, model, actions } = studio;
  const running = state.status === 'running';
  const params = state.params[driver.id] ?? {};
  const unavailable = availability && availability !== 'checking' && !availability.ok ? availability : null;
  // Mesh options re-mesh the model on screen; the form also stays for a depth
  // result after switching to a driver without depth (and the other way round).
  const liveMesh = !!model?.remesh;
  const showMesh = driver.producesDepth || liveMesh;
  const pendingMode = state.pendingMeshMode ? meshModeLabel(state.pendingMeshMode) : null;
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

        {showMesh && (
          <ParamForm
            id="mesh"
            title={t('meshTitle')}
            icon={<IconCube />}
            badge={
              (model ? liveMesh : driver.producesDepth) ? (
                <span className="pill pill-live" title={t('meshLiveHint')} data-testid="mesh-live">
                  {t('meshLive')}
                </span>
              ) : undefined
            }
            specs={MESH_PARAMS}
            values={state.meshParams}
            onChange={actions.setMeshParam}
            onReset={actions.resetMeshParams}
            note={
              pendingMode ? (
                <p className="note small" role="status" data-testid="mesh-pending">
                  <IconInfo size={14} /> {t('meshPending', { mode: tx(pendingMode) })}
                </p>
              ) : state.meshNotice ? (
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
        canGenerate={canGenerate(state, availability)}
        blockedReason={blockedReason}
        hasResult={!!state.result}
        onGenerate={() => void actions.generate()}
        onCancel={actions.cancel}
        onDismiss={actions.dismissError}
      />
    </aside>
  );
}
