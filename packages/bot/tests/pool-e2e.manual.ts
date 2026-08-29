/**
 * A POOL of chain-mode arena bots against one human, on a local sandbox.
 *
 * The unit and relay-level tests cover the selection rules; this covers the
 * thing only real money shows: that with N bots holding REAL cards, exactly one
 * of them commits, no two bots play each other, and the game settles on-chain.
 * A bot-vs-bot game would wager ten real cards and take one for nothing.
 *
 *   ./start-sandbox.sh && npx tsx scripts/deploy-contracts.ts
 *   set -a; . packages/frontend/.env; set +a
 *   npx tsx scripts/provision-arena-bot.ts --index 0 --cards 14 --offset 0
 *   npx tsx scripts/provision-arena-bot.ts --index 1 --cards 14 --offset 14   # the human
 *   npx tsx scripts/provision-arena-bot.ts --index 2 --cards 14 --offset 28
 *   ARENA_BOT_TOKEN=t npx tsx packages/bot/tests/pool-e2e.manual.ts
 *
 * ONE PROCESS PER IDENTITY (pxe.ts binds its wallet in a module global), so the
 * parent runs the relay and bot 0, and spawns itself for bot 2 and the human.
 */
import WebSocket from 'ws';
import { createServer } from '@axolotl-arena/backend/src/server.js';
import { ArenaBot } from '../src/ArenaBot.js';
import { BotChain } from '../src/BotChain.js';
import { BotProofs } from '../src/BotProofs.js';
import { configFromEnv } from '../src/config.js';

const PORT = 5401;
const PXE_URL = process.env.AZTEC_PXE_URL ?? 'http://localhost:8080';
const log = (who: string, m: string) => console.log(`[${who}] ${m}`);

const ROLE = process.argv.find(a => a.startsWith('--role='))?.slice('--role='.length) ?? 'main';

function mkChain(index: number): BotChain {
  return new BotChain({
    pxeUrl: PXE_URL,
    nftAddress: process.env.VITE_NFT_CONTRACT_ADDRESS!,
    gameAddress: process.env.VITE_GAME_CONTRACT_ADDRESS!,
    tokenAddress: process.env.VITE_TOKEN_CONTRACT_ADDRESS,
    manifestPath: `packages/bot/.artifacts/arena-bot-${index}.json`,
  }, m => log(`chain${index}`, m));
}

function startBot(index: number): ArenaBot {
  const chain = mkChain(index);
  const bot = new ArenaBot(
    { ...configFromEnv(), wsUrl: `ws://localhost:${PORT}`, httpUrl: `http://localhost:${PORT}`,
      joinThresholdMs: 2_000, pollIntervalMs: 500, moveDelayMs: 1_500,
      settleWaitMs: 120_000, healthPort: 0, token: process.env.ARENA_BOT_TOKEN! },
    { chain, proofs: new BotProofs(m => log(`bot${index}:proofs`, m)), log: m => log(`bot${index}`, m) },
  );
  void chain.connect().then(() => bot.start());
  return bot;
}

/** A chain-backed human: commits, but plays through the relay only. */
async function runHuman(): Promise<void> {
  const chain = mkChain(1);
  await chain.connect();
  const hand = await chain.selectHand(5);
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  let gameId: string | null = null;
  let opponentIsBot: boolean | null = null;

  await new Promise<void>(r => ws.once('open', () => r()));
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'SESSION_ESTABLISHED') {
      log('human', `queueing with ${hand.join(',')}`);
      ws.send(JSON.stringify({ type: 'QUEUE_MATCHMAKING', cardIds: hand }));
    }
    if (msg.type === 'MATCH_FOUND') {
      gameId = msg.gameId;
      opponentIsBot = msg.opponentIsBot;
      log('human', `matched as player${msg.playerNumber}, opponentIsBot=${msg.opponentIsBot}`);
      console.log(`HUMAN_RESULT ${JSON.stringify({ playerNumber: msg.playerNumber, opponentIsBot })}`);
      ws.close();
      process.exit(msg.playerNumber === 1 && msg.opponentIsBot === true ? 0 : 1);
    }
  });
  setTimeout(() => {
    log('human', `TIMED OUT (gameId=${gameId})`);
    process.exit(1);
  }, 5 * 60_000).unref?.();
}

async function main(): Promise<void> {
  process.env.ARENA_BOT_TOKEN ??= 'pool-e2e';
  if (!process.env.VITE_NFT_CONTRACT_ADDRESS) throw new Error('source packages/frontend/.env first');

  if (ROLE === 'bot2') { startBot(2); await new Promise(() => {}); return; }
  if (ROLE === 'human') { await runHuman(); return; }

  const server = createServer({ port: PORT });
  await new Promise<void>(r => server.httpServer.listen(PORT, () => r()));
  log('stack', `relay on ${PORT}`);

  const bot0 = startBot(0);
  const { spawn } = await import('child_process');
  const bot2 = spawn('npx', ['tsx', process.argv[1], '--role=bot2'], { env: process.env, stdio: 'inherit' });

  // Let both bots connect and start polling an EMPTY queue. Neither may offer:
  // with no human there is nobody to rescue, and two bots must never pair.
  await new Promise(r => setTimeout(r, 15_000));
  const idleGames = await server.gameManager.getGameCount();
  log('stack', `after 15s with no human: ${idleGames} game(s) created`);

  const human = spawn('npx', ['tsx', process.argv[1], '--role=human'], { env: process.env, stdio: 'inherit' });
  const humanCode = await new Promise<number>(r => human.on('exit', c => r(c ?? 1)));

  // Give the loser of the race a moment to reveal itself.
  await new Promise(r => setTimeout(r, 8_000));
  const games = await server.gameManager.getGameCount();
  const queue = await server.gameManager.queueSnapshot();

  console.log('\n=== POOL RESULT ===');
  console.log('  games with no human   :', idleGames, '(must be 0 — two bots must never pair)');
  console.log('  human exit            :', humanCode, '(0 = matched as player 1 against a bot)');
  console.log('  total games created   :', games, '(must be 1 — one bot, not the pool)');
  console.log('  still queued          :', queue.length, JSON.stringify(queue.entries.map(e => e.waitMs)));
  console.log('  bot0 stats            :', JSON.stringify(bot0.getStats()));

  bot0.stop();
  bot2.kill('SIGTERM');

  const ok = idleGames === 0 && humanCode === 0 && games === 1 && queue.length === 0;
  console.log(ok
    ? '\n  ✓ POOL BEHAVED — one bot committed, no bot-vs-bot, nobody left parked in the queue'
    : '\n  ✗ POOL MISBEHAVED — see above');
  process.exit(ok ? 0 : 1);
}

main().catch(err => { console.error(`[pool-e2e] ${err?.message ?? err}`); process.exit(1); });
