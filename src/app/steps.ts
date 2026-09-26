/**
 * The studio's step navigator: six steps from the image to the rigged,
 * animated model. Pure (Node-testable): ids, labels and the completion hint
 * each tab shows, derived from the app state.
 */
import type { I18nText } from '../core/types';
import type { UIKey } from './i18n';
import { UI } from './i18n';

export type StepId = 'image' | 'prep' | 'views' | '3d' | 'edit' | 'rig';

export const STEP_IDS: StepId[] = ['image', 'prep', 'views', '3d', 'edit', 'rig'];

export function isStepId(v: unknown): v is StepId {
  return typeof v === 'string' && (STEP_IDS as string[]).includes(v);
}

/** Tab label (short) and the heading of the step's panel. */
export const STEP_LABELS: Record<StepId, { short: UIKey; title: UIKey }> = {
  image: { short: 'stepImage', title: 'stepImageTitle' },
  prep: { short: 'stepPrep', title: 'stepPrepTitle' },
  views: { short: 'stepViews', title: 'stepViewsTitle' },
  '3d': { short: 'step3d', title: 'step3dTitle' },
  edit: { short: 'stepEdit', title: 'stepEditTitle' },
  rig: { short: 'stepRig', title: 'stepRigTitle' },
};

/** What the step hints are computed from (a subset of AppState, so tests stay small). */
export interface StepFacts {
  hasSource: boolean;
  loadingImage: boolean;
  /** An AI-prepared front image is in use (the original is kept for "revert"). */
  preparedInUse: boolean;
  /** An AI result waits for Accept / Discard. */
  preparedPending: boolean;
  /** Extra views present (0..5). */
  viewCount: number;
  hasModel: boolean;
  sculpted: boolean;
  rigged: boolean;
  aiBusy: 'prep' | 'views' | null;
  modelBusy: boolean;
}

export interface StepStatus {
  /** The step's goal is reached (tab shows a check mark). */
  done: boolean;
  /** Short status text under the tab label, or null. */
  hint: I18nText | null;
  /** Something runs in this step right now. */
  busy: boolean;
}

const fill = (text: I18nText, vars: Record<string, string | number>): I18nText => ({
  tr: text.tr.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)),
  en: text.en.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)),
});

export function stepStatus(step: StepId, f: StepFacts): StepStatus {
  switch (step) {
    case 'image':
      return { done: f.hasSource, hint: f.loadingImage ? UI.hintLoading : f.hasSource ? UI.hintLoaded : UI.hintTodo, busy: f.loadingImage };
    case 'prep':
      return {
        done: f.preparedInUse,
        hint: f.aiBusy === 'prep' ? UI.hintWorking : f.preparedPending ? UI.hintReview : f.preparedInUse ? UI.hintPrepared : UI.hintOptional,
        busy: f.aiBusy === 'prep',
      };
    case 'views':
      return {
        done: f.viewCount >= 5,
        hint: f.aiBusy === 'views' ? UI.hintWorking : fill(UI.hintViews, { n: f.viewCount }),
        busy: f.aiBusy === 'views',
      };
    case '3d':
      return { done: f.hasModel, hint: f.modelBusy ? UI.hintWorking : f.hasModel ? UI.hintModel : UI.hintTodo, busy: f.modelBusy };
    case 'edit':
      return { done: f.sculpted, hint: f.sculpted ? UI.hintSculpted : f.hasModel ? UI.hintOptional : UI.hintNeedsModel, busy: false };
    case 'rig':
      return { done: f.rigged, hint: f.rigged ? UI.hintRigged : f.hasModel ? UI.hintOptional : UI.hintNeedsModel, busy: false };
  }
}

/** Neighbour of `step` (for the Back / Next buttons), or null at the ends. */
export function adjacentStep(step: StepId, dir: -1 | 1): StepId | null {
  const i = STEP_IDS.indexOf(step) + dir;
  return i >= 0 && i < STEP_IDS.length ? STEP_IDS[i] : null;
}
