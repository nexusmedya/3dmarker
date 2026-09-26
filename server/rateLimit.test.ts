import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter, InFlight } from './rateLimit';

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

  it('sweeps expired windows and re-queues a key that starts a new window', () => {
    let t = 0;
    const rl = new FixedWindowRateLimiter(1000, () => t);
    rl.hit('a', 5);
    t = 500;
    rl.hit('b', 5);
    t = 1000;
    rl.hit('a', 5); // new window for a; a's old one was swept
    t = 1500;
    rl.hit('c', 5); // b expired
    expect(rl.size).toBe(2);
    // With a cap of 2 keys the oldest window goes first.
    const capped = new FixedWindowRateLimiter(10_000, () => t, 2);
    capped.hit('a', 1);
    t = 1600;
    capped.hit('b', 1);
    t = 1700;
    capped.hit('c', 1);
    expect(capped.size).toBe(2);
    expect(capped.peek('b', 1).allowed).toBe(false);
    expect(capped.peek('c', 1).allowed).toBe(false);
    expect(capped.peek('a', 1).allowed).toBe(true); // evicted: its count restarted
  });

  it('keeps the map bounded and inserts in constant time with many live keys', () => {
    const rl = new FixedWindowRateLimiter(3_600_000, () => 0, 20_000);
    const started = performance.now();
    for (let i = 0; i < 50_000; i++) {
      rl.peek(`k${i}`, 10);
      rl.hit(`k${i}`, 10);
    }
    expect(rl.size).toBe(20_000);
    expect(performance.now() - started).toBeLessThan(1000); // was O(n) per insert past 10k keys (seconds)
  });
});

describe('InFlight', () => {
  it('counts per key and in total, releases once and forgets empty keys', () => {
    const f = new InFlight();
    const a1 = f.acquire('a');
    const a2 = f.acquire('a');
    const b1 = f.acquire('b');
    expect([f.count('a'), f.count('b'), f.total]).toEqual([2, 1, 3]);
    a1();
    a1();
    expect([f.count('a'), f.total]).toEqual([1, 2]);
    a2();
    b1();
    expect([f.count('a'), f.count('b'), f.total]).toEqual([0, 0, 0]);
    expect((f as unknown as { counts: Map<string, number> }).counts.size).toBe(0);
  });
});
