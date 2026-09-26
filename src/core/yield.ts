/**
 * Resolve once the browser has had a chance to paint, so a progress label
 * pushed just before a long synchronous step is on screen during it (and
 * input queued meanwhile, e.g. Cancel / Esc, gets dispatched). Two frames:
 * the app's progress throttle emits in frame N's rAF, React commits that in a
 * scheduler task before frame N+1, which paints it; a single frame is not
 * enough. Falls back to a macrotask without rAF (Node, workers) or in a
 * hidden tab (rAF is paused there), with a timer as safety net if frames stop
 * mid-wait. Used by the pipeline (src/app) and the main-thread drivers.
 */
export function yieldToPaint(fallbackMs = 250): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (typeof requestAnimationFrame !== 'function' || hidden) {
      setTimeout(finish, 0);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(finish, 0)));
    timer = setTimeout(finish, fallbackMs);
  });
}
