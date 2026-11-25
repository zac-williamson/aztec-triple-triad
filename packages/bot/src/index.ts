/**
 * Arena bot entry point. The bot commits real cards like any player, so it
 * needs a provisioned identity:
 *   npx tsx scripts/provision-arena-bot.ts --cards 40
 *   ARENA_BOT_TOKEN=... ARENA_BOT_CHAIN=1 \
 *   AZTEC_PXE_URL=... VITE_NFT_CONTRACT_ADDRESS=... VITE_GAME_CONTRACT_ADDRESS=... \
 *   VITE_TOKEN_CONTRACT_ADDRESS=... \
 *   npm run dev -w packages/bot
 *
 * There is no off-chain mode any more. Every move carries a proof over both
 * players' committed hands, checked by the opponent's client
 * (docs/plan/PRIVATE_GAMES.md section 6), so a bot without a chain could match
 * a player and then never make a move they would accept.
 */
import { resolve } from 'path';
import { configFromEnv } from './config.js';
import { ArenaBot } from './ArenaBot.js';
import { BotChain } from './BotChain.js';
import { BotProofs } from './BotProofs.js';
import { startHealthServer } from './health.js';
import { GameJournal } from './GameJournal.js';
import { AbandonmentSweep } from './AbandonmentSweep.js';

const cfg = configFromEnv();
const chainMode = process.env.ARENA_BOT_CHAIN === '1';

function botIndex(): string {
  return process.env.ARENA_BOT_INDEX ?? '0';
}

function artifactsDir(): string {
  return process.env.ARENA_BOT_ARTIFACTS_DIR
    ?? resolve(import.meta.dirname ?? __dirname, '../.artifacts');
}

function botManifestPath(): string {
  return process.env.ARENA_BOT_MANIFEST ?? resolve(artifactsDir(), `arena-bot-${botIndex()}.json`);
}

async function main(): Promise<void> {
  if (!chainMode) {
    throw new Error(
      'ARENA_BOT_CHAIN=1 is required: every move carries a proof over both players\' committed ' +
      'hands, so a bot that cannot commit cards cannot play a game. Refusing to start rather ' +
      'than match players it could never move against.',
    );
  }
  const pxeUrl = process.env.AZTEC_PXE_URL;
  const nftAddress = process.env.VITE_NFT_CONTRACT_ADDRESS;
  const gameAddress = process.env.VITE_GAME_CONTRACT_ADDRESS;
  // The token too: every settlement releases a reward note to each player,
  // and telling a win or a draw from an unwind reads ours off the tx.
  const tokenAddress = process.env.VITE_TOKEN_CONTRACT_ADDRESS;
  if (!pxeUrl || !nftAddress || !gameAddress || !tokenAddress) {
    throw new Error(
      'ARENA_BOT_CHAIN=1 needs AZTEC_PXE_URL, VITE_NFT_CONTRACT_ADDRESS, ' +
      'VITE_GAME_CONTRACT_ADDRESS and VITE_TOKEN_CONTRACT_ADDRESS. Refusing to start ' +
      'half-configured: a bot that matches players and then cannot commit or recover ' +
      'its cards is worse than one that never starts.',
    );
  }
  const chain = new BotChain({
    pxeUrl,
    nftAddress,
    gameAddress,
    tokenAddress,
    // ARENA_BOT_MANIFEST names one file; ARENA_BOT_ARTIFACTS_DIR names the
    // directory and is what the provisioner, the harness and the deployed
    // unit all use — on a real box the manifests live outside the checkout
    // (they carry account keys and the note plaintexts), so the default
    // relative path is only right in development.
    manifestPath: botManifestPath(),
  }, m => console.log(`[arena-bot:chain] ${m}`));
  // Connect BEFORE serving: the chain-stamp and address checks in connect()
  // are exactly the ones that must fail at startup rather than per game.
  await chain.connect();

  const proofs = new BotProofs(m => console.log(`[arena-bot:proofs] ${m}`));
  const journal = new GameJournal(resolve(artifactsDir(), `games-${botIndex()}`));
  const bot = new ArenaBot(cfg, { chain, proofs, journal });

  console.log(
    `[arena-bot] starting: ws=${cfg.wsUrl} threshold=${cfg.joinThresholdMs}ms ` +
    `difficulty=${cfg.difficulty} maxConcurrentGames=${cfg.maxConcurrentGames} (wagers real cards)`,
  );
  bot.start();

  // The relay's /metrics cannot see inside this process — proving failures, a
  // card shortage, the watchdog abandoning games, the bot's own results. Serve
  // those here.
  const health = cfg.healthPort > 0 ? startHealthServer(bot, cfg.healthPort, m => console.log(`[arena-bot] ${m}`)) : null;

  // Bring cards back from games that will not resolve the ordinary way. The bot
  // only joins, and cancel is creator-only, so without this every wedged game
  // keeps five cards — and it fails quietly, by going idle, once it runs out.
  //
  // Runs on a timer AND at startup: a crash mid-game is the common case, and the
  // restarted process is the only thing that will ever look at that journal
  // again. The first pass is deliberately not awaited — recovery involves
  // proving and a dispute window, and holding up matchmaking behind it would
  // trade a slow leak for an outage.
  const sweep = new AbandonmentSweep({
    journal, chain, proofs,
    log: m => console.log(`[arena-bot:sweep] ${m}`),
    // Never compete with a live game for the PXE queue.
    isBusy: () => bot.getStats().state !== 'idle',
    // Nor with the bot's own follow-up of a game it just finished.
    isTracking: id => bot.isTracking(id),
    minAgeMs: cfg.gameTimeoutMs,
    txTimeoutMs: cfg.chainTxTimeoutMs,
  });
  const pass = () => void sweep.run().catch(err =>
    console.error(`[arena-bot:sweep] pass failed: ${err?.message ?? err}`));
  pass();
  const sweepTimer = setInterval(pass, cfg.sweepIntervalMs);
  sweepTimer.unref?.();

  // A move proof still generating at shutdown is a move the opponent waits
  // for: see ArenaBot.shutdown. Asked twice, we stop arguing and go.
  let leaving = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (leaving) { process.exit(0); }
      leaving = true;
      console.log(`[arena-bot] ${sig} — shutting down`);
      void bot.shutdown().catch(err => {
        console.error(`[arena-bot] shutdown: ${err?.message ?? err}`);
      }).finally(() => {
        clearInterval(sweepTimer);
        if (!health) process.exit(0);
        void health.close().finally(() => process.exit(0));
      });
    });
  }
}

main().catch(err => {
  console.error(`[arena-bot] failed to start: ${err?.message ?? err}`);
  process.exit(1);
});
