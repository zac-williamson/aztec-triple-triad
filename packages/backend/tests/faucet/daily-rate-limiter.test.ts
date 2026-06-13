import { describe, it, expect } from 'vitest';
import { DailyRateLimiter } from '../../src/faucet/DailyRateLimiter.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('DailyRateLimiter', () => {
  it('allows up to the limit, then refuses', () => {
    const limiter = new DailyRateLimiter(2, () => 0);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(false);
  });

  it('release frees a slot within the same day', () => {
    const limiter = new DailyRateLimiter(1, () => 0);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(false);
    limiter.release('a');
    expect(limiter.tryAcquire('a')).toBe(true);
  });

  it('release never drives a key below zero', () => {
    const limiter = new DailyRateLimiter(1, () => 0);
    limiter.release('a'); // no-op
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(false);
  });

  it('resets the count when the day rolls over', () => {
    let now = 0;
    const limiter = new DailyRateLimiter(1, () => now);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(false);
    now += DAY_MS; // next day
    expect(limiter.tryAcquire('a')).toBe(true);
  });

  it('tracks keys independently', () => {
    const limiter = new DailyRateLimiter(1, () => 0);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('b')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(false);
    expect(limiter.tryAcquire('b')).toBe(false);
  });
});
