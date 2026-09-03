/**
 * Warming exists so a deploy cannot break an in-flight settlement.
 *
 * The failure it prevents: settlement's dynamic imports resolve to hashed
 * chunks, a deploy replaces them, and a tab opened beforehand gets "Failed to
 * fetch dynamically imported module" — after the game is over and the wager is
 * committed. Seen for real in this project's own production testing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('warmSettlementModules', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('resolves even when a module fails to load — warming is never a gate on playing', async () => {
    // A tab that cannot preload must still play and still try to settle; this
    // moves WHEN a module loads, it does not add a new way to fail.
    vi.doMock('../pxe', () => { throw new Error('chunk 404'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { warmSettlementModules } = await import('../warmSettlementModules');

    await expect(warmSettlementModules()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('does the work once, however many times it is called', async () => {
    const { warmSettlementModules } = await import('../warmSettlementModules');
    const first = warmSettlementModules();
    expect(warmSettlementModules()).toBe(first);
    await first;
    expect(warmSettlementModules()).toBe(first);
  });

  it('covers every dynamic import on the settlement path', async () => {
    // The list is hand-maintained, so this reads the SOURCE of the settlement
    // hook and fails when it grows an import the warmer does not know about.
    // A module missing here is silently exposed to the deploy race again.
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    // Resolve from the repo root when vitest is invoked there and from the
    // package when it is invoked here — both happen (npm test -w, and running
    // the file directly).
    const { existsSync } = await import('fs');
    const candidates = [
      join(process.cwd(), 'src'),
      join(process.cwd(), 'packages/frontend/src'),
    ];
    const src = candidates.find(c => existsSync(join(c, 'hooks/useGameSettlement.ts')));
    expect(src, 'could not locate the frontend source tree').toBeTruthy();

    const hook = readFileSync(join(src!, 'hooks/useGameSettlement.ts'), 'utf8');
    const warmer = readFileSync(join(src!, 'aztec/warmSettlementModules.ts'), 'utf8');

    const imports = [...hook.matchAll(/import\(\s*'([^']+)'\s*\)/g)].map(m => m[1]);
    expect(imports.length, 'the hook should still be importing dynamically').toBeGreaterThan(0);

    const missing = imports.filter(spec => {
      const bare = spec.replace(/^\.\.\/aztec\//, './').replace(/^\.\//, '');
      return !warmer.includes(`'${spec}'`) && !warmer.includes(`/${bare}'`) && !warmer.includes(`'./${bare}'`);
    });
    expect(missing, 'settlement imports not covered by the warmer').toEqual([]);
  });
});
