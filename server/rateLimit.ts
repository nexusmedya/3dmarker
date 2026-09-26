/**
 * In-memory fixed-window rate limiter (single process; resets on restart).
 * Good enough to stop one client from burning the server's Tripo credits;
 * use a shared store (Redis, KV…) when running several instances.
 */

export interface RateDecision {
  allowed: boolean;
  /** Hits left in the current window (after counting this one, for `hit`). */
  remaining: number;
  /** Seconds until the window resets (≥ 1 when blocked). */
  retryAfterSec: number;
}

interface Window {
  start: number;
  count: number;
}

/** Most keys kept at once; past it the oldest window is dropped (that client's count restarts). */
export const MAX_RATE_KEYS = 100_000;

export class FixedWindowRateLimiter {
  /** Kept in window-start order, so expired windows always form a prefix. */
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys: number = MAX_RATE_KEYS,
  ) {}

  /** Number of keys currently tracked. */
  get size(): number {
    return this.windows.size;
  }

  /** Would a hit for `key` be allowed? Does not count. `limit` ≤ 0 disables limiting. */
  peek(key: string, limit: number): RateDecision {
    return this.decide(key, limit, false);
  }

  /** Count one hit for `key` if allowed. */
  hit(key: string, limit: number): RateDecision {
    return this.decide(key, limit, true);
  }

  private decide(key: string, limit: number, count: boolean): RateDecision {
    if (!(limit > 0)) return { allowed: true, remaining: Infinity, retryAfterSec: 0 };
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      w = { start: t, count: 0 };
      if (count) {
        // Re-insert (not just overwrite) so the key moves to the back with its new start time.
        this.windows.delete(key);
        this.sweep(t);
        if (this.windows.size >= this.maxKeys) this.windows.delete(this.windows.keys().next().value!);
        this.windows.set(key, w);
      }
    }
    const retryAfterSec = Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000));
    if (w.count >= limit) return { allowed: false, remaining: 0, retryAfterSec };
    if (count) w.count++;
    return { allowed: true, remaining: limit - w.count, retryAfterSec };
  }

  /** Drop expired windows: they are the oldest, so stop at the first live one (amortised O(1)). */
  private sweep(t: number): void {
    for (const [k, w] of this.windows) {
      if (t - w.start < this.windowMs) break;
      this.windows.delete(k);
    }
  }
}

/** Requests in progress per key (e.g. uploads whose body is still arriving); empty keys are dropped. */
export class InFlight {
  private readonly counts = new Map<string, number>();
  private all = 0;

  /** In progress for `key`. */
  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** In progress over all keys. */
  get total(): number {
    return this.all;
  }

  /** Take a slot for `key`; the returned function gives it back (only its first call counts). */
  acquire(key: string): () => void {
    this.counts.set(key, this.count(key) + 1);
    this.all++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.all--;
      const n = this.count(key) - 1;
      if (n > 0) this.counts.set(key, n);
      else this.counts.delete(key);
    };
  }
}
