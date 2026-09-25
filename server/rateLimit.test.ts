import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from './rateLimit';

describe('FixedWindowRateLimiter', () => {
  it('allows `limit` hits per window and reports the reset time', () => {
    let t = 0;
    const rl = new FixedWindowRateLimiter(10_000, () => t);
    expect(rl.hit('a', 2)).toEqual({ allowed: true, remaining: 1, retryAfterSec: 10 });
    t = 4000;
    expect(rl.peek('a', 2)).toEqual({ allowed: true, remaining: 1, retryAfterSec: 6 });
    expect(rl.hit('a', 2).remaining).toBe(0);
    expect(rl.hit('a', 2)).toEqual({ allowed: false, remaining: 0, retryAfterSec: 6 });
    expect(rl.peek('a', 2).allowed).toBe(false);
    expect(rl.hit('b', 2).allowed).toBe(true);
    t = 10_000;
    expect(rl.hit('a', 2)).toEqual({ allowed: true, remaining: 1, retryAfterSec: 10 });
  });

  it('peek never counts and a non-positive limit disables limiting', () => {
    const rl = new FixedWindowRateLimiter(1000, () => 0);
    for (let i = 0; i < 5; i++) expect(rl.peek('a', 1).allowed).toBe(true);
    for (let i = 0; i < 5; i++) expect(rl.hit('a', 0).allowed).toBe(true);
  });
});
