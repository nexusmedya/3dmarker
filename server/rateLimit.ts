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

const SWEEP_THRESHOLD = 10_000;

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

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
        if (this.windows.size >= SWEEP_THRESHOLD) this.sweep(t);
        this.windows.set(key, w);
      }
    }
    const retryAfterSec = Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000));
    if (w.count >= limit) return { allowed: false, remaining: 0, retryAfterSec };
    if (count) w.count++;
    return { allowed: true, remaining: limit - w.count, retryAfterSec };
  }

  private sweep(t: number): void {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}
