/**
 * Left column of the studio: the step navigator and the six steps —
 * 1 image + background, 2 AI preparation, 3 views, 4 driver / parameters /
 * mesh, 5 sculpt + depth map editor, 6 rig & animation — with Generate
 * pinned at the bottom (it uses step 4's settings from any step).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { StepId } from '../app/steps';
import { STEP_IDS, stepStatus, type StepFacts, type StepStatus } from '../app/steps';
import { MESH_PARAMS } from '../core/mesh/options';
import { BACKGROUND_MODES, type BackgroundMode } from '../app/pipeline';
import type { UIKey } from '../app/i18n';
import { generateBlock, hasUnsavedModelEdits, meshModeLabel, presentViews } from '../app/store';
import { getDriver } from '../drivers';
import { VIEW_LABELS } from '../ai/views';
import { providerUsable, supports } from '../ai/settings';
import type { Studio } from './useStudio';
import { useI18n } from './i18n';
import { UploadCard } from './UploadCard';
import { DriverPicker } from './DriverPicker';
import { ParamForm } from './ParamForm';
import { GeneratePanel } from './GeneratePanel';
import { StepFooter, StepHeading, StepNav, StepPanel } from './StepNav';
import { DepthEditCard, HumanDetailNote, OriginalNote } from './StepCards';
import { IconCube, IconInfo, IconLayers, IconSparkles, IconUndo } from './icons';
import { AiPrepPanel } from './ai/AiPrepPanel';
import { ViewsPanel } from './ai/ViewsPanel';
import { FusionReportNote } from './FusionReport';
import { SculptPanel } from './sculpt/SculptPanel';
import { DepthMapEditor } from './sculpt/DepthMapEditor';
import { RigPanel } from './rig/RigPanel';

/** The in-browser driver that uses every view given. */
const FUSION_ID = 'multiview-fusion';

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
  const { state, driver, availability, model, modelSource, actions } = studio;
  const running = state.status === 'running';
  const busy = running || state.loadingImage;
  const step = state.step;
  const params = state.params[driver.id] ?? {};
  // Mesh options re-mesh the model on screen; the form also stays for a depth
  // result after switching to a driver without depth (and the other way round).
  const liveMesh = !!model?.remesh;
  // A rigged depth model is re-meshable again once the rig is removed (the rig parks model.remesh meanwhile).
  const depthModel = !!model?.depth;
  const showMesh = driver.producesDepth || liveMesh || depthModel;
  const pendingMode = state.pendingMeshMode ? meshModeLabel(state.pendingMeshMode) : null;
  const human = state.human && state.source && state.human.image === state.source.image ? state.human.analysis : null;
  const aiBusy = state.aiJob?.kind ?? null;

  // Steps visited once stay mounted (hidden): the rig keeps its playback, the panels their local state.
  const [visited, setVisited] = useState<ReadonlySet<StepId>>(() => new Set([step]));
  useEffect(() => {
    setVisited((v) => (v.has(step) ? v : new Set([...v, step])));
  }, [step]);

  // A new step starts at the top: of the panel's scroll area (desktop), or of
  // the page when the stacked panel was scrolled past its sticky tabs (phones).
  const scrollRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const firstStep = useRef(true);
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 });
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    const aside = asideRef.current;
    const stacked = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 900px)').matches;
    if (aside && stacked && aside.getBoundingClientRect().top < 0) aside.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [step]);

  const viewCount = presentViews(state.views).length;
  const facts: StepFacts = {
    hasSource: !!state.source,
    loadingImage: state.loadingImage,
    preparedInUse: !!state.original,
    preparedPending: !!state.prepared,
    viewCount,
    hasModel: !!model,
    sculpted: state.sculpted,
    rigged: state.rigged,
    aiBusy,
    modelBusy: running,
  };
  const status = {} as Record<StepId, StepStatus>;
  for (const id of STEP_IDS) status[id] = stepStatus(id, facts);

  // ---- Generate guard (Generate button + Ctrl/Cmd+Enter) ----
  const block = generateBlock(state, availability, driver);
  let blockedReason: string | null = null;
  let blockedAction: { label: string; onClick: () => void } | null = null;
  switch (block?.kind) {
    case 'no-image':
      blockedReason = t('needImage');
      if (step !== 'image') blockedAction = { label: t('goToImage'), onClick: () => actions.setStep('image') };
      break;
    case 'loading':
      blockedReason = t('readingImage');
      break;
    case 'unavailable':
      blockedReason = block.reason ? tx(block.reason) : t('unavailable');
      break;
    case 'ai-busy':
      blockedReason = t('blockedAiBusy');
      break;
    case 'views':
      blockedReason = block.missing.length ? t('needViews', { views: block.missing.map((v) => tx(VIEW_LABELS[v])).join(', ') }) : t('needAnyView');
      if (step !== 'views') blockedAction = { label: t('goToViews'), onClick: () => actions.setStep('views') };
      break;
  }

  // ---- What a new generation would discard (asked before it runs) ----
  const discardWarning = hasUnsavedModelEdits(state)
    ? t(state.rigged ? 'regenDiscardsRig' : state.sculpted ? 'regenDiscardsSculpt' : 'regenDiscardsDepth')
    : null;

  // ---- Extra views the selected driver would ignore ----
  const fusion = getDriver(FUSION_ID);
  const unusedViews = viewCount > 0 && !driver.views && !!fusion;
  const useFusion = () => actions.selectDriver(FUSION_ID);
  const unusedViewsNote = (testId: string) => (
    <p className="note small views-unused" role="status" data-testid={testId}>
      <IconInfo size={14} />
      <span className="grow">
        {t('viewsUnused', { n: viewCount })}{' '}
        <button type="button" className="link-btn" onClick={useFusion} disabled={running} data-testid={`${testId}-fusion`}>
          {t('useFusion')}
        </button>
      </span>
    </p>
  );

  let bgNote: string | null = null;
  if (state.source) {
    if (state.bgMode === 'ai') bgNote = state.mask ? t('bgAiReady') : t('bgAiHint');
    else if (state.maskNote === 'no-alpha') bgNote = t('bgAutoNoAlpha');
    else if (state.maskNote === 'border-failed') bgNote = t('bgBorderFail');
  } else if (state.bgMode === 'ai') bgNote = t('bgAiHint');

  // ---- AI readiness (views panel): why no image-edit provider can run, as specific as possible ----
  const editReady = !!studio.viewProvider;
  let aiReason: string | null = null;
  if (!editReady && studio.editProvider) aiReason = t('aiNoViewProvider');
  else if (!editReady) {
    const candidate = state.aiSettings.providers.find((p) => supports(p, 'image-edit'));
    const why = candidate ? providerUsable(candidate, state.serverAvailable).reason : undefined;
    aiReason = candidate && why ? `${candidate.label}: ${tx(why)}` : state.aiSettings.providers.length ? t('aiNoEditProvider') : t('aiNoProviders');
  }

  // ---- Mesh form note: pending mode, suggestion, or why live re-meshing is paused ----
  let meshNote: ReactNode = null;
  if ((liveMesh || depthModel) && (state.rigged || state.sculptActive || state.sculpted)) {
    meshNote = (
      <div className="note small mesh-paused" role="status" data-testid="mesh-paused">
        <IconInfo size={14} />
        <div className="grow">
          <p>{state.rigged ? t('remeshPausedRig') : state.sculptActive && !state.sculpted ? t('remeshPausedActive') : t('remeshPausedSculpt')}</p>
          {state.sculpted && !state.rigged && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={actions.discardSculpt}
              disabled={busy}
              title={t('discardEditsHint')}
              data-testid="discard-sculpt"
            >
              <IconUndo size={14} /> {t('discardEdits')}
            </button>
          )}
        </div>
      </div>
    );
  } else if (pendingMode) {
    meshNote = (
      <p className="note small" role="status" data-testid="mesh-pending">
        <IconInfo size={14} /> {t('meshPending', { mode: tx(pendingMode) })}
      </p>
    );
  } else if (state.meshNotice) {
    meshNote = (
      <p className="note small" role="status">
        <IconInfo size={14} /> {t('meshSuggested', { mode: tx(state.meshNotice) })}
      </p>
    );
  }

  const revertNote = state.original ? <OriginalNote onRevert={actions.revertOriginal} disabled={busy || !!aiBusy} /> : null;
  const mounted = (id: StepId) => id === step || visited.has(id);

  return (
    <aside ref={asideRef} className="panel" aria-label={t('navStudio')}>
      <StepNav step={step} status={status} onStep={actions.setStep} />
      <div className="panel-scroll" ref={scrollRef}>
        <StepPanel id="image" active={step === 'image'}>
          <StepHeading id="image" />
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
          {revertNote}

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
          <StepFooter id="image" onStep={actions.setStep} />
        </StepPanel>

        <StepPanel id="prep" active={step === 'prep'}>
          <StepHeading id="prep" />
          {revertNote}
          <AiPrepPanel
            hasSource={!!state.source}
            prep={state.prep}
            onPrep={actions.setPrep}
            providers={studio.editProviders}
            providerId={studio.editProvider?.id ?? state.aiProviderId}
            onProvider={actions.setAiProvider}
            onOpenSettings={actions.openAiSettings}
            human={human}
            status={aiBusy === 'prep' ? 'running' : state.prepError ? 'error' : 'idle'}
            progress={aiBusy === 'prep' ? (state.aiJob?.progress ?? null) : null}
            error={state.prepError}
            onRun={() => void actions.runPrep()}
            onCancel={actions.cancelAi}
            prepared={state.prepared}
            aiViewCount={Object.values(state.views).filter((v) => v?.origin === 'ai').length}
            original={state.source?.image ?? null}
            onAccept={actions.acceptPrepared}
            onDiscard={actions.discardPrepared}
            disabled={busy || aiBusy === 'views'}
          />
          <StepFooter id="prep" onStep={actions.setStep} />
        </StepPanel>

        <StepPanel id="views" active={step === 'views'}>
          <StepHeading id="views" />
          <ViewsPanel
            front={state.source?.image ?? null}
            views={state.views}
            onUpload={(v, f) => void actions.uploadView(v, f)}
            onGenerate={actions.generateView}
            onGenerateMissing={actions.generateMissing}
            onClear={actions.clearView}
            busy={aiBusy === 'views' ? (state.aiJob?.target ?? 'all') : null}
            progress={aiBusy === 'views' ? (state.aiJob?.progress ?? null) : null}
            error={state.viewsError}
            onCancel={actions.cancelAi}
            aiReady={editReady}
            aiReason={aiReason}
            onOpenSettings={actions.openAiSettings}
            disabled={busy || aiBusy === 'prep'}
            onUseFusion={
              unusedViews
                ? () => {
                    useFusion();
                    actions.setStep('3d');
                  }
                : undefined
            }
            checks={state.viewChecks}
            onAlign={actions.setViewAlign}
            onAlignAuto={actions.autoAlignView}
            onAlignReset={actions.resetViewAlign}
            frontMask={state.mask}
            prompt={(v) => actions.viewPromptText(v)}
          />
          <StepFooter id="views" onStep={actions.setStep} />
        </StepPanel>

        <StepPanel id="3d" active={step === '3d'}>
          <StepHeading id="3d" />
          <DriverPicker driver={driver} availability={availability} onSelect={actions.selectDriver} disabled={running} />
          {unusedViews && unusedViewsNote('views-unused')}

          {driver.badges.includes('human-detail') && (
            <HumanDetailNote human={human} enabled={params.humanDetail !== false} onDetect={actions.detectHuman} disabled={!state.source || busy} />
          )}

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
              note={meshNote}
            />
          )}
          {state.result?.fusion && <FusionReportNote report={state.result.fusion} />}
          <StepFooter id="3d" onStep={actions.setStep} />
        </StepPanel>

        <StepPanel id="edit" active={step === 'edit'}>
          <StepHeading id="edit" />
          {step === 'edit' && (
            // Mounted only while this step is open: leaving it ends sculpt mode (the edits stay).
            <SculptPanel
              key={studio.sculptEpoch}
              coreRef={studio.coreRef}
              model={model}
              enabled={!!model && !busy && !state.rigged}
              onEdited={actions.onSculptEdited}
              onSessionStart={actions.onSculptSession}
              onActiveChange={actions.onSculptActive}
            />
          )}
          {state.rigged && (
            <p className="note small" data-testid="sculpt-rigged">
              <IconInfo size={14} /> {t('sculptBlockedRig')}
            </p>
          )}
          <DepthEditCard
            available={!!model?.depth && !!modelSource}
            rigged={state.rigged}
            sculpted={state.sculpted}
            onOpen={actions.openDepthEditor}
            disabled={busy || state.sculptActive}
          />
          {model?.depth && modelSource && (
            <DepthMapEditor
              open={state.depthEditorOpen}
              depth={model.depth}
              mask={model.mask}
              image={modelSource.source.image}
              onApply={actions.applyDepthEdit}
              onClose={actions.closeDepthEditor}
            />
          )}
          <StepFooter id="edit" onStep={actions.setStep} />
        </StepPanel>

        <StepPanel id="rig" active={step === 'rig'}>
          <StepHeading id="rig" />
          {state.sculptActive && (
            <p className="note small">
              <IconInfo size={14} /> {t('rigBlockedSculpt')}
            </p>
          )}
          {mounted('rig') && (
            <RigPanel
              coreRef={studio.coreRef}
              model={model}
              frontImage={modelSource?.source.image ?? null}
              frontMask={modelSource?.mask ?? null}
              enabled={!!model && !busy && !state.sculptActive}
              onModelChanged={actions.onRigChanged}
              onActiveChange={actions.onRigged}
            />
          )}
          <StepFooter id="rig" onStep={actions.setStep} />
        </StepPanel>
      </div>

      <GeneratePanel
        status={state.status}
        progress={state.progress}
        error={state.error}
        errorTitle={t(state.errorTitle)}
        canGenerate={block === null}
        blockedReason={blockedReason}
        blockedAction={blockedAction}
        hasResult={!!state.result}
        onGenerate={() => void actions.generate()}
        onCancel={actions.cancel}
        onDismiss={actions.dismissError}
        discardWarning={discardWarning}
        confirming={state.regenConfirm}
        onConfirm={actions.confirmRegenerate}
        onCancelConfirm={actions.cancelRegenerate}
        summary={
          step !== '3d' ? (
            <>
              <p className="generate-summary small" data-testid="generate-driver">
                <span className="truncate muted">{t('generateWith', { driver: tx(driver.name) })}</span>
                <button type="button" className="link-btn" onClick={() => actions.setStep('3d')} disabled={running}>
                  {t('changeDriver')}
                </button>
              </p>
              {unusedViews && unusedViewsNote('generate-views-unused')}
            </>
          ) : null
        }
      />
    </aside>
  );
}
