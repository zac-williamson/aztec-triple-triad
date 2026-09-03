/**
 * No neutered assertion may reach the repository.
 *
 * scripts/audit/mutate.mjs rewrites security-critical source in place. When it
 * is killed rather than allowed to finish, its restore does not run — and a
 * mutated file then looks exactly like ordinary work in `git status`. That
 * happened: `assert(recomputed_commit == card_commit_1, ...)` in game_move sat
 * as `assert(true);` through four commits. It binds a player's move proof to
 * the hand they committed; without it a player can play cards they never
 * staked.
 *
 * The harness now restores on SIGINT/SIGTERM/SIGHUP and on an uncaught throw.
 * This test is the backstop for the case where that also fails, because the
 * failure is silent and the blast radius is the whole protocol.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(import.meta.dirname ?? __dirname, '..', '..');
const ROOTS = ['packages/contracts', 'circuits'];
const SKIP = new Set(['target', 'node_modules', '.git', 'codegen']);

function noirFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) noirFiles(full, out);
    else if (full.endsWith('.nr')) out.push(full);
  }
  return out;
}

describe('no mutation survives into the repo', () => {
  const files = ROOTS.flatMap(r => noirFiles(join(ROOT, r)));

  it('finds Noir sources to check', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it('contains no assert(true) anywhere', () => {
    const found: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        // The harness writes exactly `assert(true);`. Nothing legitimate in
        // this codebase asserts a constant — if that ever changes, the marker
        // the harness writes should change too, not this test.
        if (/^\s*assert\(true\);\s*$/.test(line)) {
          found.push(`${relative(ROOT, f)}:${i + 1}`);
        }
      });
    }
    expect(found, 'neutered assertion(s) left by scripts/audit/mutate.mjs').toEqual([]);
  });
});
