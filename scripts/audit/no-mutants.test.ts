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

/** Written by mutate.mjs while a sweep holds a file in a mutated state. */
const SWEEP_MARKER = '/tmp/mutate-in-progress.json';

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

    // A sweep in progress is the one time a mutated file is CORRECT, and
    // running the suite then used to fail here with no explanation — which
    // invites the worst possible response: restoring the file by hand, under a
    // live sweep that will overwrite it and then restore a backup taken before
    // the edit. So say so instead.
    //
    // Narrowly: the marker must exist, name a file we actually found mutated,
    // AND its process must still be alive. A marker left by a crashed sweep is
    // exactly the case this test exists to catch, so a stale one must not
    // silence it.
    if (found.length && existsSync(SWEEP_MARKER)) {
      try {
        const marker = JSON.parse(readFileSync(SWEEP_MARKER, 'utf8'));
        process.kill(marker.pid, 0);   // throws if that process is gone
        const swept = relative(ROOT, join(ROOT, marker.src));
        if (found.every(f => f.startsWith(swept + ':'))) {
          console.warn(
            `\n  mutate.mjs is sweeping ${swept} right now (pid ${marker.pid}).\n` +
            '  The mutation below is that sweep and is expected. Do NOT restore it by\n' +
            '  hand — let the sweep finish, or stop it with SIGTERM and it restores\n' +
            `  itself.\n    ${found.join('\n    ')}\n`,
          );
          return;
        }
      } catch {
        // Unreadable marker, or a pid that no longer exists: a crashed sweep.
        // Fall through and fail, which is the whole point.
      }
    }

    expect(found, 'neutered assertion(s) left by scripts/audit/mutate.mjs').toEqual([]);
  });
});
