/**
 * The Noir contract's timing constants, and every TypeScript copy of them.
 *
 * `MIN_ABANDON_SECONDS` and `DISPUTE_SECONDS` are duplicated by hand into the
 * browser and the bot — they have to be, because the client decides when to
 * OFFER a claim and how long to wait before settling, and getting either wrong
 * produces a transaction the chain rejects after the caller has already paid
 * for a recursive proof.
 *
 * This has already gone wrong twice in one week. The abandonment bar was
 * measured in blocks against a contract counting seconds, and separately the
 * dispute wait stayed on a five-block count after the contract moved to a
 * ten-minute window — which would have reverted every human recovery at its
 * last step. Both were silent: nothing compares these numbers, so they only
 * disagree in production.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname ?? __dirname, '..');
const CONTRACT = join(ROOT, 'packages/contracts/triple_triad_game/src/main.nr');

/** `pub global NAME: u64 = 1234;` → 1234 */
function contractGlobal(src: string, name: string): number {
  const m = src.match(new RegExp(`pub\\s+global\\s+${name}\\s*:\\s*\\w+\\s*=\\s*(\\d+)`));
  if (!m) throw new Error(`${name} not found in the contract — was it renamed?`);
  return Number(m[1]);
}

/** Every `const NAME = 1234` / `export const NAME = 1234` in a TS file. */
function tsConstants(src: string, name: string): number[] {
  return [...src.matchAll(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*(\\d+)`, 'g'))]
    .map(m => Number(m[1]));
}

const MIRRORS = [
  'packages/frontend/src/aztec/settlementArgs.ts',
  'packages/frontend/src/hooks/useGame.ts',
  'packages/bot/src/AbandonmentSweep.ts',
];

describe('contract timing constants and their TypeScript mirrors', () => {
  const contract = readFileSync(CONTRACT, 'utf8');

  it('reads the constants from the contract at all', () => {
    // Guards against this suite passing vacuously after a rename.
    expect(contractGlobal(contract, 'MIN_ABANDON_SECONDS')).toBeGreaterThan(0);
    expect(contractGlobal(contract, 'DISPUTE_SECONDS')).toBeGreaterThan(0);
  });

  for (const name of ['MIN_ABANDON_SECONDS', 'DISPUTE_SECONDS'] as const) {
    it(`every copy of ${name} matches the contract`, () => {
      const expected = contractGlobal(contract, name);
      const found: string[] = [];
      for (const rel of MIRRORS) {
        const path = join(ROOT, rel);
        if (!existsSync(path)) continue;
        for (const value of tsConstants(readFileSync(path, 'utf8'), name)) {
          found.push(`${rel}=${value}`);
          expect(value, `${rel} disagrees with the contract`).toBe(expected);
        }
      }
      expect(found.length, `no TypeScript copy of ${name} found — did a mirror move?`)
        .toBeGreaterThan(0);
    });
  }

  it('no timing constant is still counted in BLOCKS', () => {
    // Both bugs took this shape: a name ending in _BLOCKS holding a number the
    // contract now measures in seconds. Block intervals on this testnet run
    // 27-72s, so such a constant is wrong by a factor that varies with load.
    const offenders: string[] = [];
    for (const rel of [...MIRRORS, 'packages/frontend/src/hooks/useGameSettlement.ts']) {
      const path = join(ROOT, rel);
      if (!existsSync(path)) continue;
      const src = readFileSync(path, 'utf8');
      for (const m of src.matchAll(/(?:export\s+)?const\s+(\w*(?:ABANDON|DISPUTE)\w*_BLOCKS)\s*=/g)) {
        offenders.push(`${rel}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
