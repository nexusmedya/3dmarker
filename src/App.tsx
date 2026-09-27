/** 3D Marker: top bar, studio (step panel + viewer), the AI providers dialog and the landing below. */
import { useCallback, useEffect, useRef } from 'react';
import { t } from './app/i18n';
import { useStudio } from './ui/useStudio';
import { LangProvider } from './ui/i18n';
import { TopBar } from './ui/TopBar';
import { ControlPanel } from './ui/ControlPanel';
import { Viewer } from './ui/Viewer';
import { ExportBar, MeshStatsLine } from './ui/ExportBar';
import { Landing } from './ui/Landing';
import { ProviderSettingsDialog } from './ui/ai/ProviderSettingsDialog';

/** Same breakpoint as the stacked layout in styles.css. */
const STACKED_QUERY = '(max-width: 900px)';

export default function App() {
  const studio = useStudio();
  const { state, model, geometryVersion, coreRef, actions } = studio;
  const running = state.status === 'running';
  const getExportObject = useCallback(() => coreRef.current?.getExportObject() ?? null, [coreRef]);
  const aiCount = state.aiSettings.providers.filter((p) => p.enabled).length;
  const stageRef = useRef<HTMLDivElement>(null);

  // Stacked layout (phones): the viewer sits under the whole step panel. When
  // a generation finishes, bring the model into view instead of leaving the
  // user in the parameter list (only on the running → done edge).
  const prevStatus = useRef(state.status);
  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = state.status;
    const stage = stageRef.current;
    if (was !== 'running' || state.status !== 'done' || !state.result || !stage) return;
    if (!window.matchMedia?.(STACKED_QUERY).matches) return;
    const r = stage.getBoundingClientRect();
    if (r.top < window.innerHeight * 0.6 && r.bottom > 0) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    stage.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  }, [state.status, state.result]);

  // Editing steps on phones: the viewer stays pinned at the bottom of the screen while the controls scroll above it.
  const pinStage = !!model && (state.step === 'edit' || state.step === 'rig' || state.sculptActive);

  // Stable, so the memoised landing does not re-render on every progress tick.
  const runningRef = useRef(running);
  runningRef.current = running;
  const tryDriver = useCallback(
    (id: string) => {
      if (!runningRef.current) {
        actions.selectDriver(id);
        actions.setStep('3d');
      }
      document.getElementById('studio')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [actions],
  );

  return (
    <LangProvider value={state.lang}>
      <TopBar theme={state.theme} onLang={actions.setLang} onTheme={actions.setTheme} aiCount={aiCount} onAiSettings={actions.openAiSettings} />
      <main>
        <h1 className="visually-hidden">
          {t('appName', state.lang)} — {t('tagline', state.lang)}
        </h1>
        <section id="studio" className={`studio${pinStage ? ' studio--pin-stage' : ''}`}>
          <ControlPanel studio={studio} />
          <div className="stage" ref={stageRef} data-testid="stage">
            <Viewer
              model={model}
              geometryVersion={geometryVersion}
              view={state.view}
              onView={actions.setView}
              coreRef={coreRef}
              depthPreview={state.result?.depthPreview ?? null}
              running={running}
              progress={state.progress}
              hasSource={!!state.source}
              touchScroll={!state.sculptActive}
            />
            <div className="stage-footer">
              {state.result ? <MeshStatsLine result={state.result} /> : <div className="stats" />}
              <ExportBar
                result={state.result}
                getObject={getExportObject}
                stlSizeMm={state.stlSizeMm}
                onStlSize={actions.setStlSize}
                disabled={!model || running}
                animations={model?.animations}
                rigged={state.rigged}
              />
            </div>
          </div>
        </section>
        <Landing onTryDriver={tryDriver} />
      </main>
      <ProviderSettingsDialog
        open={state.aiSettingsOpen}
        onClose={actions.closeAiSettings}
        settings={state.aiSettings}
        onChange={actions.setAiSettings}
        serverAvailable={state.serverAvailable}
      />
    </LangProvider>
  );
}
