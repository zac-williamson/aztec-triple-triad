/** Stop a stack started by boot-stack.ts (reads .artifacts/stack.json). */
import { existsSync, rmSync } from 'fs';
import { killProcessGroup } from '../src/stack.js';
import { readStackInfo, STACK_INFO_PATH } from '../src/env.js';

if (!existsSync(STACK_INFO_PATH)) {
  console.log('[stack] no stack.json — nothing to stop');
  process.exit(0);
}
const info = readStackInfo();
for (const name of ['frontend', 'backend', 'sandbox'] as const) {
  const pid = info.pids[name];
  if (pid) await killProcessGroup(pid, name);
}
rmSync(STACK_INFO_PATH);
console.log('[stack] stopped');
