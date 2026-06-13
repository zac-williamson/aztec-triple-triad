/**
 * Boot the full stack and leave it running (children are detached with
 * file-backed stdio, so they survive this script exiting).
 * Inner-loop usage:
 *   npx tsx scripts/boot-stack.ts
 *   PLAYTEST_REUSE_STACK=1 npx playwright test   # iterate
 *   npx tsx scripts/stop-stack.ts
 */
import { Stack } from '../src/stack.js';
import { STANDALONE_INFO_PATH } from '../src/env.js';

await new Stack('standalone', STANDALONE_INFO_PATH).bootAll();
console.log('[stack] up — run tests with PLAYTEST_REUSE_STACK=1, stop with scripts/stop-stack.ts');
process.exit(0);
