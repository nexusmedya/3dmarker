/** React wrapper around ViewerCore: canvas host, toolbar and overlays. */
import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { Progress, RGBAImage } from '../core/types';
import { ViewerCore } from '../app/viewer';
import type { BuiltModel } from '../app/pipeline';
import type { ViewSettings } from '../app/store';
import { useI18n } from './i18n';
import { RGBACanvas } from './RGBACanvas';
import { ProgressBar } from './GeneratePanel';
import { IconAlert, IconContrast, IconCube, IconFocus, IconLayers, IconRotate, IconSphere, IconTexture, IconWireframe } from './icons';

interface Props {
  model: BuiltModel | null;
  geometryVersion: number;
  view: ViewSettings;
  onView: (patch: Partial<ViewSettings>) => void;
  coreRef: MutableRefObject<ViewerCore | null>;
  depthPreview: RGBAImage | null;
  running: boolean;
  progress: Progress | null;
  children?: ReactNode;
}

export function Viewer({ model, geometryVersion, view, onView, coreRef, depthPreview, running, progress, children }: Props) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const [webglError, setWebglError] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let core: ViewerCore;
    try {
      core = new ViewerCore(host, viewRef.current);
    } catch (e) {
      console.error(e);
      setWebglError(true);
      return;
    }
    coreRef.current = core;
    // Dev-only handle for debugging / leak checks (renderer.info.memory).
    if (import.meta.env.DEV) (window as unknown as { __3dmarkerViewer?: ViewerCore }).__3dmarkerViewer = core;
    return () => {
      core.dispose();
      if (coreRef.current === core) coreRef.current = null;
    };
  }, [coreRef]);

  useEffect(() => {
    coreRef.current?.setObject(model?.object ?? null);
  }, [model, coreRef]);

  useEffect(() => {
    if (geometryVersion > 0) coreRef.current?.refresh();
  }, [geometryVersion, coreRef]);

  useEffect(() => {
    coreRef.current?.setDisplay(view);
  }, [view, coreRef]);

  const toggle = (key: keyof ViewSettings) => onView({ [key]: !view[key] });
  const hasModel = !!model;

  return (
    <div className={`viewer${view.darkBackground ? ' is-dark' : ' is-light'}`}>
      <div className="viewer-toolbar" role="toolbar" aria-label={t('viewerLabel')}>
        <ToolButton label={t('viewTexture')} pressed={view.texture && !view.clay} onClick={() => toggle('texture')} disabled={view.clay} testId="view-texture">
          <IconTexture />
        </ToolButton>
        <ToolButton label={t('viewClay')} pressed={view.clay} onClick={() => toggle('clay')} testId="view-clay">
          <IconSphere />
        </ToolButton>
        <ToolButton label={t('viewWireframe')} pressed={view.wireframe} onClick={() => toggle('wireframe')} testId="view-wireframe">
          <IconWireframe />
        </ToolButton>
        <span className="toolbar-sep" aria-hidden="true" />
        <ToolButton label={t('viewAutoRotate')} pressed={view.autoRotate} onClick={() => toggle('autoRotate')} testId="view-rotate">
          <IconRotate />
        </ToolButton>
        <ToolButton label={t('viewReset')} onClick={() => coreRef.current?.resetView()} testId="view-reset">
          <IconFocus />
        </ToolButton>
        <ToolButton label={t('viewBackground')} pressed={!view.darkBackground} onClick={() => toggle('darkBackground')} testId="view-bg">
          <IconContrast />
        </ToolButton>
        {depthPreview && (
          <ToolButton label={t('viewDepth')} pressed={view.showDepth} onClick={() => toggle('showDepth')} testId="view-depth">
            <IconLayers />
          </ToolButton>
        )}
      </div>

      <div ref={hostRef} className="viewer-canvas" data-testid="viewer" aria-label={t('viewerLabel')} role="region" />

      {webglError && (
        <div className="viewer-overlay">
          <div className="empty">
            <IconAlert size={28} />
            <p>{t('noWebgl')}</p>
          </div>
        </div>
      )}

      {!hasModel && !webglError && !running && (
        <div className="viewer-overlay" aria-hidden="true">
          <div className="empty">
            <div className="empty-icon">
              <IconCube size={30} />
            </div>
            <strong>{t('viewerEmptyTitle')}</strong>
            <p>{t('viewerEmptyBody')}</p>
          </div>
        </div>
      )}

      {running && (
        <div className="viewer-overlay viewer-overlay-busy">
          <div className="busy-card">
            <span className="spinner spinner-lg" aria-hidden="true" />
            {/* Visual copy of the panel's progress bar, which is the one announced. */}
            <ProgressBar progress={progress} testId="viewer-progress" compact decorative />
          </div>
        </div>
      )}

      {depthPreview && view.showDepth && (
        <figure className="depth-thumb" data-testid="depth-preview">
          <RGBACanvas image={depthPreview} label={t('depthAlt')} />
          <figcaption>{t('viewDepth')}</figcaption>
        </figure>
      )}

      {hasModel && <p className="viewer-hint">{t('controlsHint')}</p>}
      {children}
    </div>
  );
}

function ToolButton({
  label,
  pressed,
  onClick,
  disabled,
  testId,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`tool-btn${pressed ? ' is-on' : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
    >
      {children}
    </button>
  );
}
