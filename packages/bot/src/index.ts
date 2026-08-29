/**
 * Arena bot entry point.
 *
 * Run with the backend's ARENA_BOT_TOKEN in the environment:
 *   ARENA_BOT_TOKEN=... npm run dev -w packages/bot
 */
import { configFromEnv } from './config.js';
import { ArenaBot } from './ArenaBot.js';

const cfg = configFromEnv();
const bot = new ArenaBot(cfg);

console.log(
  `[arena-bot] starting: ws=${cfg.wsUrl} threshold=${cfg.joinThresholdMs}ms ` +
  `difficulty=${cfg.difficulty} cards=[${cfg.handCardIds.join(',')}] ` +
  `maxConcurrentGames=${cfg.maxConcurrentGames}`,
);
bot.start();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[arena-bot] ${sig} — shutting down`);
    bot.stop();
    process.exit(0);
  });
}
