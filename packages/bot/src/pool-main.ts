/**
 * Pool entry point: `ARENA_BOT_POOL_SIZE=3 node dist/pool-main.js`
 *
 * See pool.ts for why this is N processes rather than N identities in one.
 */
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { BotPool } from './pool.js';

const size = Number(process.env.ARENA_BOT_POOL_SIZE ?? '1');
const startIndex = Number(process.env.ARENA_BOT_POOL_START_INDEX ?? '0');

if (!Number.isInteger(size) || size < 1) {
  console.error(`[arena-pool] ARENA_BOT_POOL_SIZE must be a positive integer, got ${process.env.ARENA_BOT_POOL_SIZE}`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const pool = new BotPool({
  size,
  startIndex,
  healthPortBase: Number(process.env.ARENA_BOT_HEALTH_PORT ?? '5175'),
});

// Identity checks BEFORE anything spawns: a half-started pool is much harder to
// read than a refusal that names the missing manifest.
try {
  // Same directory the bot itself reads — on a box the manifests live outside
  // the checkout, so a hardcoded relative path would fail the check for
  // identities that are present.
  pool.verifyIdentities(process.env.ARENA_BOT_ARTIFACTS_DIR ?? resolve(here, '../.artifacts'));
} catch (err) {
  console.error(`[arena-pool] ${(err as Error).message}`);
  process.exit(1);
}

pool.start();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[arena-pool] ${sig} — stopping ${pool.running} bot(s)`);
    pool.stop();
    // Give the children a moment to run their own shutdown before we go.
    setTimeout(() => process.exit(0), 2_000).unref?.();
  });
}
