import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useUnloadGuard } from '../useUnloadGuard';

/** Fire a real beforeunload and report whether a listener cancelled it. */
function fireUnload(): boolean {
  const e = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

afterEach(() => vi.restoreAllMocks());

describe('useUnloadGuard', () => {
  it('does not interfere when there is nothing at stake', () => {
    renderHook(() => useUnloadGuard(false, 'nope'));
    expect(fireUnload()).toBe(false);
  });

  it('blocks the unload while work is outstanding', () => {
    renderHook(() => useUnloadGuard(true, 'owed a move proof'));
    expect(fireUnload()).toBe(true);
  });

  // NOTE: the hook also assigns `e.returnValue`, which some browsers still
  // require in order to show the prompt. That is deliberately NOT asserted
  // here: jsdom models `returnValue` as the legacy BOOLEAN (`!defaultPrevented`)
  // rather than the string a real BeforeUnloadEvent carries, so any assertion
  // on it would be testing jsdom rather than this hook. `defaultPrevented`
  // above is the part jsdom models faithfully.

  it('stops blocking once the work completes', () => {
    const { rerender } = renderHook(
      ({ active }) => useUnloadGuard(active, 'owed a move proof'),
      { initialProps: { active: true } },
    );
    expect(fireUnload()).toBe(true);
    rerender({ active: false });
    // Otherwise the player is trapped in a tab that can no longer help anyone.
    expect(fireUnload()).toBe(false);
  });

  it('removes its listener on unmount', () => {
    const { unmount } = renderHook(() => useUnloadGuard(true, 'owed a move proof'));
    unmount();
    expect(fireUnload()).toBe(false);
  });
});
