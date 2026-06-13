/** Stop a stack started by boot-stack.ts (reads .artifacts/standalone-stack.json). */
import { existsSync, rmSync } from 'fs';
import { killProcessGroup } from '../src/stack.js';
import { readStackInfo, STANDALONE_INFO_PATH } from '../src/env.js';

if (!existsSync(STANDALONE_INFO_PATH)) {
  console.log('[stack] no standalone-stack.json — nothing to stop');
  process.exit(0);
}
const info = readStackInfo(STANDALONE_INFO_PATH);
for (const name of ['frontend', 'backend', 'sandbox'] as const) {
  const pid = info.pids[name];
  if (pid) await killProcessGroup(pid, name);
}
rmSync(STANDALONE_INFO_PATH);
console.log('[stack] stopped');
