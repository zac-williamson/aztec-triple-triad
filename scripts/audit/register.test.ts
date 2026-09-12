/**
 * The invariant register may not claim coverage the measurement denies.
 *
 * F7 in the audit: docs/plan/AUDIT_INVARIANTS.md marked thirteen rows VERIFIED
 * on the strength of reading the assertion. Mutation testing then showed
 * nothing exercised them — among the thirteen, S1 (the settlement binding that
 * fixes this project's historical worst bug) and Z1 (mint authorization).
 *
 * A register whose statuses are claims rather than artifacts is a more
 * confident version of no audit at all, so the statuses are derived. This test
 * is what stops them drifting back:
 *
 *   1. every VERIFIED row whose assertion survives mutation is a failure
 *   2. every surviving assertion that maps to NO row is reported — a property
 *      the register never named, which is how the cancel path (L5/L6) and the
 *      NFT rules (N1-N8) were found missing
 *
 * Refresh the snapshot with:
 *   MUTATION_JSON=scripts/audit/mutation-results.json \
 *     node scripts/audit/mutate.mjs contracts/game
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname ?? __dirname, '..', '..');
const SNAPSHOT = join(ROOT, 'scripts/audit/mutation-results.json');
const REGISTER = join(ROOT, 'docs/plan/AUDIT_INVARIANTS.md');
const MAP = JSON.parse(readFileSync(join(ROOT, 'scripts/audit/invariant-map.json'), 'utf8')).map;

const VERIFIED = new Set(['VERIFIED', 'MUTATION-COVERED']);

describe('the invariant register against the mutation snapshot', () => {
  const haveSnapshot = existsSync(SNAPSHOT);

  it('has a snapshot to check against', () => {
    // Without one this suite would pass vacuously, which is the failure mode
    // it exists to prevent.
    expect(haveSnapshot, `missing ${SNAPSHOT} — run mutate.mjs with MUTATION_JSON set`).toBe(true);
  });

  it('claims no coverage that mutation denies', () => {
    if (!haveSnapshot) return;
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    const register = readFileSync(REGISTER, 'utf8');

    const claimed = new Map<string, string>();
    for (const m of register.matchAll(/^\|\s*([A-Z]\d+)\s*\|[^|]*\|\s*`([A-Z-]+)`\s*\|/gm)) {
      claimed.set(m[1], m[2]);
    }

    const broken = new Set<string>();
    for (const target of Object.values(snap) as any[]) {
      for (const s of target.survivors ?? []) {
        const inv = s.message ? (MAP as Record<string, string>)[s.message] : undefined;
        if (inv) broken.add(inv);
      }
    }

    const overclaimed = [...broken]
      .filter(id => VERIFIED.has(claimed.get(id) ?? ''))
      .sort()
      .map(id => `${id} is ${claimed.get(id)} but its assertion survives mutation`);

    expect(overclaimed).toEqual([]);
  });

  it('reports surviving assertions that map to no invariant', () => {
    // Not a failure — a prompt. A survivor with no row means the register may
    // be missing a property, and no tool can report a property nobody wrote
    // down. Only a person re-reading the protocol against the list can.
    if (!haveSnapshot) return;
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    const unmapped = new Set<string>();
    for (const target of Object.values(snap) as any[]) {
      for (const s of target.survivors ?? []) {
        if (s.message && !(MAP as Record<string, string>)[s.message]) unmapped.add(s.message);
      }
    }
    if (unmapped.size) {
      console.warn(`\n  ${unmapped.size} surviving assertion(s) map to no invariant:`);
      for (const m of unmapped) console.warn(`    "${m}"`);
      console.warn('  Add a row to docs/plan/AUDIT_INVARIANTS.md or to invariant-map.json.\n');
    }
    expect(true).toBe(true);
  });
});
