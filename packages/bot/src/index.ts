/**
 * Arena bot entry point.
 *
 * Off-chain (relay only — the bot plays but wagers nothing):
 *   ARENA_BOT_TOKEN=... npm run dev -w packages/bot
 *
 * Chain mode (the bot commits real cards like any player). Provision it first:
 *   npx tsx scripts/provision-arena-bot.ts --cards 40
 *   ARENA_BOT_TOKEN=... ARENA_BOT_CHAIN=1 \
 *   AZTEC_PXE_URL=... VITE_NFT_CONTRACT_ADDRESS=... VITE_GAME_CONTRACT_ADDRESS=... \
 *   npm run dev -w packages/bot
 */
import { resolve } from 'path';
import { configFromEnv } from './config.js';
import { ArenaBot } from './ArenaBot.js';
import { BotChain } from './BotChain.js';
import { BotProofs } from './BotProofs.js';
import { startHealthServer } from './health.js';

const cfg = configFromEnv();
const chainMode = process.env.ARENA_BOT_CHAIN === '1';

async function main(): Promise<void> {
  let chain: BotChain | undefined;

  if (chainMode) {
    const pxeUrl = process.env.AZTEC_PXE_URL;
    const nftAddress = process.env.VITE_NFT_CONTRACT_ADDRESS;
    const gameAddress = process.env.VITE_GAME_CONTRACT_ADDRESS;
    if (!pxeUrl || !nftAddress || !gameAddress) {
      throw new Error(
        'ARENA_BOT_CHAIN=1 needs AZTEC_PXE_URL, VITE_NFT_CONTRACT_ADDRESS and ' +
        'VITE_GAME_CONTRACT_ADDRESS. Refusing to start half-configured: a bot that ' +
        'matches players and then cannot commit its cards is worse than one that never starts.',
      );
    }
    chain = new BotChain({
      pxeUrl,
      nftAddress,
      gameAddress,
      tokenAddress: process.env.VITE_TOKEN_CONTRACT_ADDRESS,
      manifestPath: process.env.ARENA_BOT_MANIFEST
        ?? resolve(import.meta.dirname ?? __dirname,
                   `../.artifacts/arena-bot-${process.env.ARENA_BOT_INDEX ?? '0'}.json`),
    }, m => console.log(`[arena-bot:chain] ${m}`));
    // Connect BEFORE serving: the chain-stamp and address checks in connect()
    // are exactly the ones that must fail at startup rather than per game.
    await chain.connect();
  }

  // Proofs only matter alongside a chain — off-chain mode never submits any.
  const proofs = chain ? new BotProofs(m => console.log(`[arena-bot:proofs] ${m}`)) : undefined;
  const bot = new ArenaBot(cfg, { chain, proofs });

  console.log(
    `[arena-bot] starting: ws=${cfg.wsUrl} threshold=${cfg.joinThresholdMs}ms ` +
    `difficulty=${cfg.difficulty} maxConcurrentGames=${cfg.maxConcurrentGames} ` +
    `mode=${chainMode ? 'CHAIN (wagers real cards)' : 'off-chain (relay only)'}`,
  );
  bot.start();

  // The relay's /metrics cannot see inside this process — proving failures, a
  // card shortage, the watchdog abandoning games. Serve those here.
  const health = cfg.healthPort > 0 ? startHealthServer(bot, cfg.healthPort, m => console.log(`[arena-bot] ${m}`)) : null;

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      console.log(`[arena-bot] ${sig} — shutting down`);
      bot.stop();
      void health?.close().finally(() => process.exit(0));
      if (!health) process.exit(0);
    });
  }
}

main().catch(err => {
  console.error(`[arena-bot] failed to start: ${err?.message ?? err}`);
  process.exit(1);
});
