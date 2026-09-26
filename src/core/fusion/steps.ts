/**
 * Cooperative long loops: a kernel written as a generator yields at safe
 * points (every Z slab, iteration or vertex batch). `drain` runs it to the
 * end synchronously (the plain function API); reconstructFromViews runs it
 * in time slices, yielding to the event loop between them so Cancel / Esc
 * are handled mid-stage.
 */
export type Steps<T = void> = Generator<void, T, void>;

/** Run a step generator to completion without yielding. */
export function drain<T>(steps: Steps<T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * Run a step generator in slices of about `sliceMs`; between slices call
 * `between` (which yields and may throw, e.g. on abort).
 */
export async function runSliced<T>(steps: Steps<T>, sliceMs: number, between: () => Promise<void>): Promise<T> {
  let last = performance.now();
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    if (performance.now() - last >= sliceMs) {
      await between();
      last = performance.now();
    }
  }
}

/**
 * A macrotask yield (input events are dispatched before it resolves). Uses a
 * MessageChannel where available: unlike timers it is not throttled in
 * background tabs.
 */
export function macrotask(): Promise<void> {
  if (typeof MessageChannel === 'function') {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}
