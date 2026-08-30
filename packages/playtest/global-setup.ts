/**
 * Playwright globalSetup — brings up the full stack (or attaches to a running
 * one in PLAYTEST_REUSE_STACK=1 mode) and records it in .artifacts/stack.json
 * for the tests and globalTeardown.
 */
import { startBlockNudge } from './src/blockNudge.js';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { buildSync } from 'esbuild';
import { Stack, killRegisteredBrowsers } from './src/stack.js';
import {
  REUSE_STACK, TESTNET, ROOT, ARTIFACTS_DIR, STACK_INFO_PATH, GAME_LOGIC_BUNDLE_PATH,
  PXE_URL, BACKEND_URL, FRONTEND_URL,
  readContractAddresses, type StackInfo,
} from './src/env.js';

/**
 * Bundle game-logic's source to a private CJS file for the rules mirror.
 * The package's dist is ESM without a "type" declaration, which plain-Node
 * CJS consumers (Playwright's transform) cannot load — see expected.ts.
 * Rebuilt every run so it can never go stale against lane 3's source.
 */
function bundleGameLogic(): void {
  buildSync({
    entryPoints: [resolve(ROOT, 'packages/game-logic/src/index.ts')],
    outfile: GAME_LOGIC_BUNDLE_PATH,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: false,
    logLevel: 'silent',
  });
}

async function assertReachable(name: string, url: string, init?: RequestInit): Promise<void> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    throw new Error(`PLAYTEST_REUSE_STACK=1 but ${name} is not reachable at ${url}: ${err}`);
  }
}

export default async function globalSetup(): Promise<void> {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  // Reap any browsers leaked by a prior run whose runner was killed before its
  // teardown could run — start every run on a clean machine (no accumulating
  // orphaned Chromium across runs).
  const leaked = await killRegisteredBrowsers();
  if (leaked) console.log(`[stack] reaped ${leaked} browser(s) leaked by a prior run`);
  bundleGameLogic();

  if (REUSE_STACK) {
    // Mark the run as attached FIRST: globalTeardown runs even when setup
    // throws, and it must never kill a stack this run does not own.
    const info: StackInfo = {
      mode: 'attached',
      pids: {},
      addresses: null,
      logsDir: ARTIFACTS_DIR,
    };
    writeFileSync(STACK_INFO_PATH, JSON.stringify(info, null, 2));

    await assertReachable('aztec node', PXE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'node_getBlockNumber', params: [], id: 1 }),
    });
    await assertReachable('backend', `${BACKEND_URL}/health`);
    await assertReachable('frontend', FRONTEND_URL);

    info.addresses = readContractAddresses();
    writeFileSync(STACK_INFO_PATH, JSON.stringify(info, null, 2));
    console.log('[stack] attached to running stack (reuse mode)');
    // Anything measured in BLOCKS (the abandoned-game dispute window is five)
    // never elapses on a local sandbox while a test waits: its automine
    // sequencer only builds on tx activity. Testnet needs no help.
    if (!TESTNET) startBlockNudge(PXE_URL, (m: string) => console.log(`[stack] ${m}`));
    return;
  }

  await new Stack(TESTNET ? 'testnet' : 'run', STACK_INFO_PATH).bootAll();
  if (!TESTNET) startBlockNudge(PXE_URL, (m: string) => console.log(`[stack] ${m}`));
}
