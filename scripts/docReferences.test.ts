/**
 * Script paths named in source comments must exist.
 *
 * A comment that points at a file which is not there is worse than no comment:
 * it answers "is this tested?" with a confident yes that cannot be checked.
 * l1Funding.ts claimed the Fee Juice swap — the only leg that spends a player's
 * own money, and the only one no deployment exercises — was covered by
 * `swap-leg-live.mts`. That file has never existed. The real coverage is
 * `swap-leg-fork.mts`, against a mainnet fork rather than the Sepolia pool the
 * comment described.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(import.meta.dirname ?? __dirname, '..');
const SEARCH = ['packages/frontend/src', 'packages/bot/src', 'packages/backend/src', 'scripts'];
const SKIP = new Set(['node_modules', 'dist', 'target', '.git', 'codegen']);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(full)) out.push(full);
  }
  return out;
}

/** `packages/<pkg>/scripts/<name>.mts` and `scripts/<name>.(sh|ts)` mentions. */
const REFERENCE = /(?:packages\/[\w-]+\/)?scripts\/[\w.-]+\.(?:mts|ts|sh)/g;

describe('script paths named in comments', () => {
  const files = SEARCH.flatMap(d => walk(join(ROOT, d)));

  it('finds source to scan (a move must not silently empty this suite)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('all exist', () => {
    const broken: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(REFERENCE)) {
        const ref = m[0];
        // Only paths anchored at the repo root, which is how this codebase
        // writes them. A relative one inside a package would be ambiguous and
        // is not worth guessing at. (Do not put an EXAMPLE path in this
        // comment: the scan reads its own source and would flag it — which it
        // did, on the first run.)
        const candidates = [join(ROOT, ref), join(ROOT, 'packages/playtest', ref)];
        if (!candidates.some(existsSync)) {
          broken.push(`${relative(ROOT, file)} -> ${ref}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
