/**
 * The point of this module is that the recording and the printing are
 * SEPARATE. A flag that also decides whether to record would be useless for
 * the case it exists for: the player who hit the bug had the flag off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { diag, diagnosticsDump, resetDiagnostics } from '../diagnostics';

describe('diagnostics', () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetDiagnostics();
    localStorage.clear();
    window.history.replaceState({}, '', '/');
    spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  it('records without printing, so a player\'s console stays clean', () => {
    diag('[pxe-queue] join queued behind 2 item(s)');
    expect(spy).not.toHaveBeenCalled();
    expect(diagnosticsDump()).toContain('join queued behind 2 item(s)');
  });

  it('keeps what happened BEFORE anyone thought to look', () => {
    // The whole reason not to gate recording behind the flag: the interesting
    // lines are always the ones from before the bug was noticed.
    diag('[pxe-queue] sweep held the queue for 61s');
    expect(spy).not.toHaveBeenCalled();
    localStorage.setItem('triad_debug', '1');
    expect(diagnosticsDump()).toContain('sweep held the queue for 61s');
  });

  it('prints when a player switches diagnostics on', () => {
    localStorage.setItem('triad_debug', '1');
    diag('[pxe-queue] settle starting after 9s in the queue');
    expect(spy).toHaveBeenCalledWith('[pxe-queue] settle starting after 9s in the queue');
  });

  it('prints under the test harness without any setup', () => {
    window.history.replaceState({}, '', '/?e2e=1');
    diag('[pxe-queue] create queued behind 1 item(s)');
    expect(spy).toHaveBeenCalled();
  });

  it('stamps each line with a time, since ordering is the whole question', () => {
    diag('first');
    expect(diagnosticsDump()).toMatch(/^\d\d:\d\d:\d\d\.\d\d\d first$/);
  });

  it('stays small enough to paste into a support chat', () => {
    for (let i = 0; i < 500; i++) diag(`line ${i}`);
    const lines = diagnosticsDump().split('\n');
    expect(lines).toHaveLength(200);
    // Keeps the RECENT ones — the oldest are the least useful.
    expect(lines[lines.length - 1]).toContain('line 499');
    expect(diagnosticsDump()).not.toContain('line 299 ');
  });

  it('records even where storage throws, which is where support is hardest', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(() => diag('[pxe-queue] still recorded')).not.toThrow();
    expect(diagnosticsDump()).toContain('still recorded');
    getItem.mockRestore();
  });

  it('is reachable from a console without a debug build', () => {
    diag('reachable');
    const dump = (window as unknown as { __triadDiagnostics: () => string }).__triadDiagnostics;
    expect(typeof dump).toBe('function');
    expect(dump()).toContain('reachable');
  });
});
