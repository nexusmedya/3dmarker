/**
 * Coalesce rapid progress callbacks (ML download / inference can fire
 * hundreds per second) into at most one UI update per frame.
 */
export interface Throttled<T> {
  push: (value: T) => void;
  /** Drop any pending value and ignore later pushes. */
  cancel: () => void;
}

export type Scheduler = (fn: () => void) => () => void;

export const frameScheduler: Scheduler = (fn) => {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(fn);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(fn, 16);
  return () => clearTimeout(id);
};

export function throttleLatest<T>(emit: (value: T) => void, schedule: Scheduler = frameScheduler): Throttled<T> {
  let pending: { value: T } | null = null;
  let cancelTimer: (() => void) | null = null;
  let stopped = false;
  return {
    push(value) {
      if (stopped) return;
      pending = { value };
      if (cancelTimer) return;
      cancelTimer = schedule(() => {
        cancelTimer = null;
        const p = pending;
        pending = null;
        if (p && !stopped) emit(p.value);
      });
    },
    cancel() {
      stopped = true;
      pending = null;
      cancelTimer?.();
      cancelTimer = null;
    },
  };
}
