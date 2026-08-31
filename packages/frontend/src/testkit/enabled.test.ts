/**
 * The gate decides whether a deployed build can be verified at all, so both
 * halves of it are worth pinning: it must stay OFF for an ordinary visitor and
 * ON for an explicit opt-in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const load = async () => (await import('./enabled')).TESTKIT_ENABLED;
const setUrl = (search: string) => {
  Object.defineProperty(window, 'location', {
    value: { search }, writable: true, configurable: true,
  });
};

describe('TESTKIT_ENABLED', () => {
  const realLocation = window.location;
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: realLocation, writable: true, configurable: true,
    });
  });

  it('stays off for an ordinary visitor', async () => {
    setUrl('');
    expect(await load()).toBe(false);
  });

  it('stays off for a lookalike parameter', async () => {
    // ?e2e=0 and ?e2etest are not opt-ins; only the exact value counts.
    setUrl('?e2e=0&e2etest=1');
    expect(await load()).toBe(false);
  });

  it('turns on for an explicit opt-in', async () => {
    setUrl('?e2e=1');
    expect(await load()).toBe(true);
  });

  it('survives a location it cannot parse', async () => {
    Object.defineProperty(window, 'location', {
      get() { throw new Error('no location here'); }, configurable: true,
    });
    await expect(load()).resolves.toBe(false);
  });
});
