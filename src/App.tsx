/** 3D Marker: top bar, studio (step panel + viewer), the AI providers dialog and the landing below. */
import { useCallback } from 'react';
import { t } from './app/i18n';
import { useStudio } from './ui/useStudio';
import { LangProvider } from './ui/i18n';
import { TopBar } from './ui/TopBar';
import { ControlPanel } from './ui/ControlPanel';
import { Viewer } from './ui/Viewer';
import { ExportBar, MeshStatsLine } from './ui/ExportBar';
import { Landing } from './ui/Landing';
import { ProviderSettingsDialog } from './ui/ai/ProviderSettingsDialog';

export default function App() {
  const studio = useStudio();
  const { state, model, geometryVersion, coreRef, actions } = studio;
  const running = state.status === 'running';
  const getExportObject = useCallback(() => coreRef.current?.getExportObject() ?? null, [coreRef]);
  const aiCount = state.aiSettings.providers.filter((p) => p.enabled).length;

  const tryDriver = (id: string) => {
    if (!running) {
      actions.selectDriver(id);
      actions.setStep('3d');
    }
    document.getElementById('studio')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <LangProvider value={state.lang}>
      <TopBar theme={state.theme} onLang={actions.setLang} onTheme={actions.setTheme} aiCount={aiCount} onAiSettings={actions.openAiSettings} />
      <main>
        <h1 className="visually-hidden">
          {t('appName', state.lang)} — {t('tagline', state.lang)}
        </h1>
        <section id="studio" className="studio">
          <ControlPanel studio={studio} />
          <div className="stage">
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
