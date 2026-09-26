import { describe, expect, it } from 'vitest';
import { UI } from './i18n';
import { STEP_IDS, STEP_LABELS, adjacentStep, isStepId, stepStatus, type StepFacts } from './steps';

const none: StepFacts = {
  hasSource: false,
  loadingImage: false,
  preparedInUse: false,
  preparedPending: false,
  viewCount: 0,
  hasModel: false,
  sculpted: false,
  rigged: false,
  aiBusy: null,
  modelBusy: false,
};

describe('steps', () => {
  it('six steps with labels in both languages', () => {
    expect(STEP_IDS).toEqual(['image', 'prep', 'views', '3d', 'edit', 'rig']);
    for (const id of STEP_IDS) {
      expect(UI[STEP_LABELS[id].short].tr).not.toBe('');
      expect(UI[STEP_LABELS[id].title].en).not.toBe('');
    }
    expect(isStepId('rig')).toBe(true);
    expect(isStepId('nope')).toBe(false);
    expect(isStepId(3)).toBe(false);
  });

  it('nothing done on an empty studio', () => {
    for (const id of STEP_IDS) expect(stepStatus(id, none).done, id).toBe(false);
    expect(stepStatus('image', none).hint).toBe(UI.hintTodo);
    expect(stepStatus('edit', none).hint).toBe(UI.hintNeedsModel);
    expect(stepStatus('views', none).hint).toEqual({ tr: '0/5 görünüm', en: '0/5 views' });
  });

  it('completion hints follow the state', () => {
    expect(stepStatus('image', { ...none, loadingImage: true })).toMatchObject({ busy: true, hint: UI.hintLoading });
    expect(stepStatus('image', { ...none, hasSource: true })).toMatchObject({ done: true, hint: UI.hintLoaded });
    expect(stepStatus('prep', { ...none, preparedPending: true })).toMatchObject({ done: false, hint: UI.hintReview });
    expect(stepStatus('prep', { ...none, preparedInUse: true })).toMatchObject({ done: true, hint: UI.hintPrepared });
    expect(stepStatus('prep', { ...none, aiBusy: 'prep' })).toMatchObject({ busy: true, hint: UI.hintWorking });
    expect(stepStatus('views', { ...none, aiBusy: 'prep' }).busy).toBe(false);
    expect(stepStatus('views', { ...none, viewCount: 3 })).toMatchObject({ done: false, hint: { tr: '3/5 görünüm', en: '3/5 views' } });
    expect(stepStatus('views', { ...none, viewCount: 5 }).done).toBe(true);
    expect(stepStatus('3d', { ...none, hasModel: true })).toMatchObject({ done: true, hint: UI.hintModel });
    expect(stepStatus('3d', { ...none, modelBusy: true })).toMatchObject({ busy: true });
    expect(stepStatus('edit', { ...none, hasModel: true })).toMatchObject({ done: false, hint: UI.hintOptional });
    expect(stepStatus('edit', { ...none, hasModel: true, sculpted: true })).toMatchObject({ done: true, hint: UI.hintSculpted });
    expect(stepStatus('rig', { ...none, hasModel: true, rigged: true })).toMatchObject({ done: true, hint: UI.hintRigged });
  });

  it('adjacent steps', () => {
    expect(adjacentStep('image', -1)).toBeNull();
    expect(adjacentStep('image', 1)).toBe('prep');
    expect(adjacentStep('3d', -1)).toBe('views');
    expect(adjacentStep('rig', 1)).toBeNull();
  });
});
