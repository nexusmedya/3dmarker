/** 3D Marker: top bar, studio (controls + viewer) and the landing below. */
import { useCallback } from 'react';
import { useStudio } from './ui/useStudio';
import { useAvailability } from './ui/useAvailability';
import { LangProvider } from './ui/i18n';
import { TopBar } from './ui/TopBar';
import { ControlPanel } from './ui/ControlPanel';
import { Viewer } from './ui/Viewer';
import { ExportBar, MeshStatsLine } from './ui/ExportBar';
import { Landing } from './ui/Landing';

export default function App() {
  const studio = useStudio();
  const { state, driver, model, geometryVersion, coreRef, actions } = studio;
  const availability = useAvailability(driver);
  const running = state.status === 'running';
  const getExportObject = useCallback(() => coreRef.current?.getExportObject() ?? null, [coreRef]);

  const tryDriver = (id: string) => {
    if (!running) actions.selectDriver(id);
    document.getElementById('studio')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <LangProvider value={state.lang}>
      <TopBar theme={state.theme} onLang={actions.setLang} onTheme={actions.setTheme} />
      <main>
        <section id="studio" className="studio">
          <ControlPanel studio={studio} availability={availability} />
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
            />
            <div className="stage-footer">
              {state.result ? <MeshStatsLine result={state.result} /> : <div className="stats" />}
              <ExportBar
                result={state.result}
                getObject={getExportObject}
                stlSizeMm={state.stlSizeMm}
                onStlSize={actions.setStlSize}
                disabled={!model || running}
              />
            </div>
          </div>
        </section>
        <Landing onTryDriver={tryDriver} />
      </main>
    </LangProvider>
  );
}
