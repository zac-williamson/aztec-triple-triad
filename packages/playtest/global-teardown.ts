/**
 * Playwright globalTeardown — stops the stack ONLY if this run booted it
 * (mode 'run'). Attached/standalone stacks are never touched. Runs even when
 * globalSetup failed, so it must key strictly off recorded ownership.
 */
import { existsSync, rmSync } from 'fs';
import { killProcessGroup } from './src/stack.js';
import { readStackInfo, STACK_INFO_PATH } from './src/env.js';

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(STACK_INFO_PATH)) return;
  const info = readStackInfo();
  if (info.mode === 'run') {
    // Reverse boot order: frontend, backend, then the sandbox tree.
    for (const name of ['frontend', 'backend', 'sandbox'] as const) {
      const pid = info.pids[name];
      if (pid) await killProcessGroup(pid, name);
    }
  } else {
    console.log(`[stack] mode=${info.mode} — leaving the stack running`);
  }
  rmSync(STACK_INFO_PATH);
}
