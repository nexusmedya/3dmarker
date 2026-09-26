// @vitest-environment jsdom
/** StepNav (ARIA tabs) and the GeneratePanel's blocked-reason action, rendered in jsdom. */
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Lang } from '../core/types';
import { STEP_IDS, stepStatus, type StepFacts, type StepId, type StepStatus } from '../app/steps';
import { LangProvider } from './i18n';
import { StepNav, StepPanel } from './StepNav';
import { GeneratePanel } from './GeneratePanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const facts: StepFacts = {
  hasSource: true,
  loadingImage: false,
  preparedInUse: false,
  preparedPending: false,
  viewCount: 2,
  hasModel: false,
  sculpted: false,
  rigged: false,
  aiBusy: 'views',
  modelBusy: false,
};
const status = Object.fromEntries(STEP_IDS.map((id) => [id, stepStatus(id, facts)])) as Record<StepId, StepStatus>;

let root: Root | null = null;
let host: HTMLDivElement;

async function render(el: ReturnType<typeof createElement>, lang: Lang = 'en') {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(LangProvider, { value: lang }, el)));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
});

function Harness({ onStep }: { onStep: (s: StepId) => void }) {
  const [step, setStep] = useState<StepId>('image');
  return createElement(
    'div',
    null,
    createElement(StepNav, {
      step,
      status,
      onStep: (s: StepId) => {
        onStep(s);
        setStep(s);
      },
    }),
    ...STEP_IDS.map((id) => createElement(StepPanel, { key: id, id, active: id === step, children: `panel ${id}` })),
  );
}

const tab = (id: StepId) => host.querySelector(`[data-testid="step-${id}"]`) as HTMLButtonElement;
const key = (el: Element, k: string) => act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })));

describe('StepNav', () => {
  it('is an ARIA tablist with roving focus and arrow / Home / End keys', async () => {
    const onStep = vi.fn();
    await render(createElement(Harness, { onStep }));
    const list = host.querySelector('[role="tablist"]')!;
    expect(list.getAttribute('aria-label')).toBe('Studio steps');
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(6);
    expect(tab('image').getAttribute('aria-selected')).toBe('true');
    expect(tab('image').tabIndex).toBe(0);
    expect(tab('prep').tabIndex).toBe(-1);
    expect(tab('image').getAttribute('aria-controls')).toBe('step-panel-image');
    const panel = host.querySelector('#step-panel-image')!;
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('step-tab-image');
    expect((host.querySelector('#step-panel-prep') as HTMLElement).hidden).toBe(true);

    // Completion hints / busy state from the facts.
    expect(tab('image').dataset.done).toBe('true');
    expect(tab('views').textContent).toContain('Working…');
    expect(tab('views').className).toContain('is-busy');

    tab('image').focus();
    await key(tab('image'), 'ArrowRight');
    expect(onStep).toHaveBeenLastCalledWith('prep');
    expect(document.activeElement).toBe(tab('prep'));
    expect((host.querySelector('#step-panel-prep') as HTMLElement).hidden).toBe(false);
    await key(tab('prep'), 'ArrowLeft');
    await key(tab('image'), 'ArrowLeft'); // wraps to the last
    expect(onStep).toHaveBeenLastCalledWith('rig');
    await key(tab('rig'), 'Home');
    expect(onStep).toHaveBeenLastCalledWith('image');
    await key(tab('image'), 'End');
    expect(onStep).toHaveBeenLastCalledWith('rig');
    const calls = onStep.mock.calls.length;
    await key(tab('rig'), 'a'); // other keys are ignored
    expect(onStep.mock.calls.length).toBe(calls);
    await act(async () => tab('3d').click());
    expect(tab('3d').getAttribute('aria-selected')).toBe('true');
  });

  it('labels follow the language', async () => {
    await render(createElement(StepNav, { step: 'views', status, onStep: () => {} }), 'tr');
    expect(tab('views').textContent).toContain('Görünümler');
    expect(tab('prep').textContent).toContain('AI hazırlık');
  });
});

describe('GeneratePanel', () => {
  it('shows the blocked reason with an action button, and the summary line', async () => {
    const go = vi.fn();
    await render(
      createElement(GeneratePanel, {
        status: 'idle',
        progress: null,
        error: null,
        errorTitle: 'x',
        canGenerate: false,
        blockedReason: 'Needs a view.',
        blockedAction: { label: 'Go to Views', onClick: go },
        hasResult: false,
        onGenerate: () => {},
        onCancel: () => {},
        onDismiss: () => {},
        summary: createElement('p', { 'data-testid': 'summary' }, 'Driver: X'),
      }),
    );
    expect((host.querySelector('[data-testid="generate"]') as HTMLButtonElement).disabled).toBe(true);
    expect(host.querySelector('[data-testid="generate-blocked"]')?.textContent).toContain('Needs a view.');
    expect(host.querySelector('[data-testid="summary"]')?.textContent).toBe('Driver: X');
    await act(async () => (host.querySelector('[data-testid="generate-blocked-action"]') as HTMLButtonElement).click());
    expect(go).toHaveBeenCalledOnce();
  });
});
