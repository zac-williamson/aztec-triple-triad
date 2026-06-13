/**
 * Boot the full stack and leave it running (children are detached).
 * Inner-loop usage:
 *   npx tsx scripts/boot-stack.ts
 *   PLAYTEST_REUSE_STACK=1 npx playwright test   # iterate
 *   npx tsx scripts/stop-stack.ts
 */
import globalSetup from '../global-setup.js';

await globalSetup();
console.log('[stack] up — run tests with PLAYTEST_REUSE_STACK=1, stop with scripts/stop-stack.ts');
process.exit(0);
