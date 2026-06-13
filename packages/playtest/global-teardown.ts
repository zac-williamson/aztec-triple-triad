/** Playwright globalTeardown — stops every stack process we started. */
import { existsSync } from 'fs';
import { killProcessGroup } from './src/stack.js';
import { readStackInfo, STACK_INFO_PATH } from './src/env.js';

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(STACK_INFO_PATH)) return;
  const info = readStackInfo();
  if (info.reused) {
    console.log('[stack] reuse mode — leaving the stack running');
    return;
  }
  // Reverse boot order: frontend, backend, then the sandbox tree.
  for (const name of ['frontend', 'backend', 'sandbox'] as const) {
    const pid = info.pids[name];
    if (pid) await killProcessGroup(pid, name);
  }
}
