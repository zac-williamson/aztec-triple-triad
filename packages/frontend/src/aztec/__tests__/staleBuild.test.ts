/**
 * A stale tab is not cosmetic here: the failing import is usually the proving
 * code, and a proof that never generates is a game that cannot be settled with
 * five cards committed behind it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isStaleChunkError, watchForStaleBuild, onBuildStale, isBuildStale } from '../staleBuild';

describe('recognising a deployed-away chunk', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://x/assets/a.js',
    'error loading dynamically imported module',
    'Importing a module script failed.',
  ])('recognises %s', msg => {
    expect(isStaleChunkError(new Error(msg))).toBe(true);
  });

  it('does not mistake an ordinary failure for a stale build', () => {
    // Telling a player to reload when the real fault is elsewhere sends them
    // round a loop that cannot help.
    expect(isStaleChunkError(new Error('PXE operation timed out'))).toBe(false);
    expect(isStaleChunkError(new Error('Assertion failed: Game already settled'))).toBe(false);
    expect(isStaleChunkError(undefined)).toBe(false);
  });
});

describe('watching for it', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('tells subscribers when a lazy chunk has gone', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    watchForStaleBuild();
    const seen: boolean[] = [];
    onBuildStale(v => seen.push(v));

    window.dispatchEvent(Object.assign(new Event('vite:preloadError'), {
      payload: new Error('Failed to fetch dynamically imported module: /assets/x.js'),
    }));

    expect(seen).toEqual([true]);
    expect(isBuildStale()).toBe(true);
  });
});
