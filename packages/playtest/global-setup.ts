/**
 * Playwright globalSetup — brings up the full stack (or attaches to a running
 * one in PLAYTEST_REUSE_STACK=1 mode) and records it in .artifacts/stack.json
 * for the tests and globalTeardown.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { Stack } from './src/stack.js';
import {
  REUSE_STACK, ARTIFACTS_DIR, STACK_INFO_PATH, PXE_URL, BACKEND_URL, FRONTEND_URL,
  readContractAddresses, type StackInfo,
} from './src/env.js';

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
    return;
  }

  await new Stack('run', STACK_INFO_PATH).bootAll();
}
