/**
 * Timed, bounded relay of an upstream response body. Shared by the Tripo
 * model download (./providers/tripo.ts), the AI proxy and the AI output
 * download (./ai/routes.ts).
 *
 * Until the response headers arrive, one timeout covers every hop; after that
 * only progress is timed (an idle timer re-armed on each chunk) plus a
 * generous cap on the whole transfer, so a slow but moving body is relayed at
 * the client's pace. An optional byte cap stops oversized bodies. The upstream
 * is closed whenever the relay stops early (timeout, cap, caller abort).
 */

export type RelayErrorKind = 'timeout' | 'aborted' | 'too-large';

export interface RelayOptions {
  /** Caller signal (e.g. the client's request); aborting it stops everything. */
  signal?: AbortSignal;
  /** Until the response headers arrive, over all hops. */
  timeoutMs: number;
  /** Longest gap between two body chunks. */
  idleTimeoutMs: number;
  /** Cap on the whole transfer, headers included. */
  totalTimeoutMs: number;
  /** Largest body relayed; a longer one errors with a 'too-large' error. */
  maxBytes?: number;
  /**
   * Called exactly once when the transfer is over: the body finished, failed,
   * timed out or was cancelled, or `open` threw.
   */
  onSettled?: () => void;
  /** The error used for a timeout / caller abort / oversized body. */
  makeError: (kind: RelayErrorKind, message: string) => Error;
}

/**
 * Run `open` (one or more fetches with the given signal; it classifies its own
 * transport failures, `timedOut()` tells whether the header timeout fired),
 * then return a Response whose body is relayed under the idle / total / size
 * limits. Throws whatever `open` throws.
 */
export async function timedRelay(
  open: (signal: AbortSignal, timedOut: () => boolean) => Promise<Response>,
  opts: RelayOptions,
): Promise<Response> {
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    opts.onSettled?.();
  };

  const ctrl = new AbortController();
  const signal = opts.signal ? AbortSignal.any([ctrl.signal, opts.signal]) : ctrl.signal;
  let stopError: Error | null = null;
  const stop = (kind: RelayErrorKind, message: string) => () => {
    stopError ??= opts.makeError(kind, message);
    ctrl.abort(stopError);
  };
  const total = setTimeout(stop('timeout', 'The transfer took too long'), opts.totalTimeoutMs);
  const headersTimer = setTimeout(stop('timeout', 'The upstream timed out'), opts.timeoutMs);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = () => {
    clearTimeout(total);
    clearTimeout(headersTimer);
    clearTimeout(idle);
  };

  let res: Response;
  try {
    res = await open(signal, () => stopError !== null);
  } catch (e) {
    clearTimers();
    settle();
    throw e;
  }
  clearTimeout(headersTimer);
  if (!res.body) {
    clearTimers();
    settle();
    return res;
  }

  const reader = res.body.getReader();
  let received = 0;
  let finished = false;
  let out!: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => {
    finished = true;
    clearTimers();
    signal.removeEventListener('abort', onAbort);
    settle();
  };
  const onAbort = () => {
    if (finished) return;
    finish();
    const reason = stopError ?? opts.makeError('aborted', 'Request aborted');
    out.error(reason);
    reader.cancel(reason).catch(() => {});
  };
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(stop('timeout', 'The transfer stalled'), opts.idleTimeoutMs);
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(c) {
        out = c;
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        else arm();
      },
      async pull(c) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (!finished) {
            finish();
            c.error(stopError ?? e);
          }
          return;
        }
        if (finished) return;
        if (chunk.done) {
          finish();
          c.close();
          return;
        }
        received += chunk.value.byteLength;
        if (opts.maxBytes !== undefined && received > opts.maxBytes) {
          const err = opts.makeError('too-large', `The response is larger than ${opts.maxBytes} bytes`);
          finish();
          c.error(err);
          reader.cancel(err).catch(() => {});
          return;
        }
        arm();
        c.enqueue(chunk.value);
      },
      cancel(reason) {
        finish();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * Pass a request body through while counting it: errors (and flags `exceeded`)
 * once more than `maxBytes` went by, so an upstream upload stops right there.
 */
export function countingBody(src: ReadableStream<Uint8Array>, maxBytes: number): { body: ReadableStream<Uint8Array>; exceeded: () => boolean } {
  let seen = 0;
  let over = false;
  const reader = src.getReader();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        const { done, value } = await reader.read();
        if (done) return c.close();
        seen += value.byteLength;
        if (seen > maxBytes) {
          over = true;
          const err = new Error('Request body too large');
          c.error(err);
          reader.cancel(err).catch(() => {});
          return;
        }
        c.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return { body, exceeded: () => over };
}
