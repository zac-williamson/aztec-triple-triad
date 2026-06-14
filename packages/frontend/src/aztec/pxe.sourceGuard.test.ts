/**
 * Source guard — the structural enforcement behind the single PXE door.
 *
 * pxe.ts serializes every contract read/send through the queue. That invariant
 * is convention-only unless something MECHANICALLY fails when a new caller
 * touches a contract directly. This test greps the production sources and fails
 * if a contract method is invoked, or `contractCache` is referenced, anywhere
 * but the door.
 *
 * Signal choice — `.methods.`:
 *   In aztec.js a contract is *only* ever exercised via `contract.methods.foo()`
 *   (then `.simulate()` / `.send()` / `.request()`). So `.methods.` is the exact,
 *   false-positive-free tell for "a contract instance escaped the door". We grep
 *   it (plus the contract-exclusive `.simulate(`) rather than bare `.send(`,
 *   because `.send(` is overloaded — `ws.send(...)` (WebSocket) and the account
 *   bootstrap's `deployMethod.send(...)` are NOT cached contract methods and
 *   carry no `.methods.`, so they're correctly never flagged (the requested
 *   deployMethod.send exemption falls out for free).
 *
 * Exemptions:
 *   - aztec/pxe.ts      — the door itself.
 *   - testkit/api.ts    — Lane-8 test harness; test-only and already enqueues
 *                         every read through txManager.enqueuePxe.
 *   - aztec/contracts.ts — the private home of `contractCache` (never exported).
 *
 * Test files are not scanned (they mock contracts, never touch the real PXE).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives at src/aztec/ — its parent's parent is src/.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

const rel = (file: string) => relative(SRC, file).split(sep).join('/');

/** Files allowed to invoke contract methods (`.methods.` / `.simulate(`). */
const CONTRACT_METHOD_ALLOW = new Set(['aztec/pxe.ts', 'testkit/api.ts']);
/** Files allowed to reference the private contract cache. */
const CONTRACT_CACHE_ALLOW = new Set(['aztec/contracts.ts']);

/** Recursively collect production .ts/.tsx files (skip tests + __tests__). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Yield the executable lines of a source file with comments removed, so that
 * documentation mentioning `.simulate()` / `.methods.` / `contractCache` is not
 * a false positive.
 */
function codeLines(text: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true;
      continue;
    }
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
    out.push(raw.replace(/\/\/.*$/, '')); // strip trailing line comments
  }
  return out;
}

const files = sourceFiles(SRC);

describe('PXE single-door source guard', () => {
  it('scans a non-trivial set of production sources', () => {
    // Sanity: the walk found files (a broken path would silently pass otherwise).
    expect(files.length).toBeGreaterThan(20);
  });

  it('no contract-method access (.methods. / .simulate) outside the PXE door', () => {
    const violations: string[] = [];
    for (const file of files) {
      const r = rel(file);
      if (CONTRACT_METHOD_ALLOW.has(r)) continue;
      for (const line of codeLines(readFileSync(file, 'utf8'))) {
        if (line.includes('.methods.') || /\.simulate\(/.test(line)) {
          violations.push(`${r}  ⟶  ${line.trim()}`);
        }
      }
    }
    expect(violations, `contract methods must be invoked only inside pxe.ts:\n${violations.join('\n')}`).toEqual([]);
  });

  it('contractCache is never referenced outside its private module', () => {
    const violations: string[] = [];
    for (const file of files) {
      const r = rel(file);
      if (CONTRACT_CACHE_ALLOW.has(r)) continue;
      for (const line of codeLines(readFileSync(file, 'utf8'))) {
        if (line.includes('contractCache')) {
          violations.push(`${r}  ⟶  ${line.trim()}`);
        }
      }
    }
    expect(violations, `contractCache must not escape contracts.ts:\n${violations.join('\n')}`).toEqual([]);
  });
});
