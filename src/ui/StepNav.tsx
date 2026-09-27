/**
 * Step navigator of the studio panel: six numbered tabs with icons and a
 * completion hint (ARIA tabs with automatic activation: arrow keys / Home /
 * End move and select, Tab enters the step's panel). On phones the row
 * scrolls horizontally and keeps the selected tab in view.
 */
import { useEffect, useRef, type ComponentType, type KeyboardEvent, type ReactNode } from 'react';
import { STEP_IDS, STEP_LABELS, adjacentStep, type StepId, type StepStatus } from '../app/steps';
import { useI18n } from './i18n';
import { IconArrowLeft, IconArrowRight, IconBone, IconBrush, IconCheck, IconCube, IconImage, IconViews, IconWand } from './icons';

const STEP_ICONS: Record<StepId, ComponentType<{ size?: number }>> = {
  image: IconImage,
  prep: IconWand,
  views: IconViews,
  '3d': IconCube,
  edit: IconBrush,
  rig: IconBone,
};

export const stepTabId = (id: StepId) => `step-tab-${id}`;
export const stepPanelId = (id: StepId) => `step-panel-${id}`;

interface Props {
  step: StepId;
  status: Record<StepId, StepStatus>;
  onStep: (step: StepId) => void;
}

export function StepNav({ step, status, onStep }: Props) {
  const { t, tx, lang } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const tabs = useRef(new Map<StepId, HTMLButtonElement>());

  // Keep the selected tab visible when the row scrolls (phones).
  useEffect(() => {
    const list = listRef.current;
    const tab = tabs.current.get(step);
    if (!list || !tab || list.scrollWidth <= list.clientWidth + 1) return;
    const left = tab.offsetLeft - list.offsetLeft;
    if (left < list.scrollLeft || left + tab.offsetWidth > list.scrollLeft + list.clientWidth) {
      list.scrollTo?.({ left: Math.max(0, left - 12), behavior: 'smooth' });
    }
  }, [step]);

  // Edge fades show that the row scrolls (phones: steps 5-6 may start off-screen).
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const update = () => {
      const scrollable = list.scrollWidth > list.clientWidth + 1;
      list.classList.toggle('can-scroll-start', scrollable && list.scrollLeft > 1);
      list.classList.toggle('can-scroll-end', scrollable && list.scrollLeft + list.clientWidth < list.scrollWidth - 1);
      // Sticky on phones: focused controls keep clear of it (styles.css scroll-margin).
      document.documentElement.style.setProperty('--stepnav-h', `${list.offsetHeight}px`);
    };
    update();
    list.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(list);
    return () => {
      list.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [lang]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = STEP_IDS.indexOf(step);
    const n = STEP_IDS.length;
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % n;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next === null) return;
    e.preventDefault();
    const id = STEP_IDS[next];
    onStep(id);
    tabs.current.get(id)?.focus();
  };

  return (
    <div ref={listRef} className="stepnav" role="tablist" aria-label={t('stepsLabel')} aria-orientation="horizontal" onKeyDown={onKeyDown}>
      {STEP_IDS.map((id, i) => {
        const st = status[id];
        const active = id === step;
        const Icon = STEP_ICONS[id];
        return (
          <button
            key={id}
            ref={(el) => {
              if (el) tabs.current.set(id, el);
              else tabs.current.delete(id);
            }}
            type="button"
            role="tab"
            id={stepTabId(id)}
            aria-selected={active}
            aria-controls={stepPanelId(id)}
            tabIndex={active ? 0 : -1}
            className={`stepnav-tab${active ? ' is-active' : ''}${st.done ? ' is-done' : ''}${st.busy ? ' is-busy' : ''}`}
            data-testid={`step-${id}`}
            data-done={st.done ? 'true' : 'false'}
            title={`${t('stepNumber', { n: i + 1 })}: ${t(STEP_LABELS[id].title)}`}
            onClick={() => onStep(id)}
          >
            <span className="stepnav-top" aria-hidden="true">
              <span className="stepnav-num">{st.busy ? <span className="spinner spinner-sm" /> : st.done ? <IconCheck size={12} /> : i + 1}</span>
              <Icon size={15} />
            </span>
            <span className="stepnav-label">{t(STEP_LABELS[id].short)}</span>
            {st.hint && <span className="stepnav-hint">{tx(st.hint)}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** One step's panel (kept mounted while hidden so its state survives switching). */
export function StepPanel({ id, active, children }: { id: StepId; active: boolean; children: ReactNode }) {
  return (
    <div role="tabpanel" id={stepPanelId(id)} aria-labelledby={stepTabId(id)} className="step-panel" hidden={!active} data-testid={`step-panel-${id}`}>
      {children}
    </div>
  );
}

/**
 * Title line of a step's panel: number and full title. Not a heading: the
 * panel is already named by its tab and the cards inside carry the h2s.
 */
export function StepHeading({ id, children }: { id: StepId; children?: ReactNode }) {
  const { t } = useI18n();
  const n = STEP_IDS.indexOf(id) + 1;
  return (
    <div className="step-heading">
      <span className="step-heading-num" aria-hidden="true">
        {n}
      </span>
      <span className="step-heading-title">{t(STEP_LABELS[id].title)}</span>
      {children}
    </div>
  );
}

/** Back / Next buttons at the end of a step. */
export function StepFooter({ id, onStep }: { id: StepId; onStep: (step: StepId) => void }) {
  const { t } = useI18n();
  const prev = adjacentStep(id, -1);
  const next = adjacentStep(id, 1);
  return (
    <div className="step-footer">
      {prev ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onStep(prev)} data-testid={`step-back-${id}`}>
          <IconArrowLeft size={14} /> {t('stepBack', { step: t(STEP_LABELS[prev].short) })}
        </button>
      ) : (
        <span />
      )}
      {next && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onStep(next)} data-testid={`step-next-${id}`}>
          {t('stepNext', { step: t(STEP_LABELS[next].short) })} <IconArrowRight size={14} />
        </button>
      )}
    </div>
  );
}
