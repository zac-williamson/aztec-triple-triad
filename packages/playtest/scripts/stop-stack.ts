/** Stop a stack started by boot-stack.ts (reads .artifacts/standalone-stack.json). */
import { existsSync, rmSync } from 'fs';
import { killProcessGroup, killRegisteredBrowsers } from '../src/stack.js';
import { readStackInfo, STANDALONE_INFO_PATH } from '../src/env.js';

// Reap any per-player Chromium left behind by a test run against this stack.
const leakedBrowsers = await killRegisteredBrowsers();
if (leakedBrowsers) console.log(`[stack] killed ${leakedBrowsers} leaked browser process group(s)`);

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
