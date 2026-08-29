/**
 * Full chain-mode game on a LOCAL SANDBOX: the arena bot versus a scripted
 * opponent, both real chain players — commit, prove, settle.
 *
 * Not part of `npm test`: it needs a running sandbox, deployed contracts and two
 * provisioned identities, and it takes minutes. Run it explicitly:
 *
 *   ./start-sandbox.sh
 *   npx tsx scripts/deploy-contracts.ts
 *   set -a; . packages/frontend/.env; set +a
 *   npx tsx scripts/provision-arena-bot.ts --index 0 --cards 12 --offset 0
 *   npx tsx scripts/provision-arena-bot.ts --index 1 --cards 8  --offset 12
 *   ARENA_BOT_TOKEN=t AZTEC_PXE_URL=http://localhost:8080 \
 *     npx tsx packages/bot/tests/chain-e2e.manual.ts
 *
 * The opponent is a SEPARATE driver rather than a second ArenaBot: testing the
 * bot against a copy of itself would hide any assumption both sides share.
 */
import WebSocket from 'ws';
import { createServer } from '@axolotl-arena/backend/src/server.js';
import { chooseBotMove } from '@axolotl-arena/game-logic';
import type { GameState, Player } from '@axolotl-arena/game-logic';
import { ArenaBot } from '../src/ArenaBot.js';
import { BotChain } from '../src/BotChain.js';
import { BotProofs } from '../src/BotProofs.js';
import { configFromEnv } from '../src/config.js';

const PORT = 5399;
const PXE_URL = process.env.AZTEC_PXE_URL ?? 'http://localhost:8080';
const log = (who: string, m: string) => console.log(`[${who}] ${m}`);

/** A chain-real opponent: queues first, plays greedily, commits/proves/settles. */
class ScriptedOpponent {
  private ws!: WebSocket;
  private gameId: string | null = null;
  private me: Player | null = null;
  private hand: number[] = [];
  private onChainGameId: string | null = null;
  private blinding: string | null = null;
  private randomness: string[] | null = null;
  settled = false;
  over: string | null = null;

  constructor(private chain: BotChain, private proofs: BotProofs) {}

  async run(): Promise<void> {
    this.hand = await this.chain.selectHand(5);
    log('opponent', `hand ${this.hand.join(',')}`);
    this.ws = new WebSocket(`ws://localhost:${PORT}`);
    await new Promise<void>(r => this.ws.once('open', () => r()));
    this.ws.on('message', raw => void this.handle(JSON.parse(raw.toString())).catch(e =>
      log('opponent', `ERROR ${e?.message ?? e}`)));
  }

  private send(m: unknown) { this.ws.send(JSON.stringify(m)); }

  private async handle(msg: any): Promise<void> {
    switch (msg.type) {
      case 'SESSION_ESTABLISHED':
        log('opponent', 'queueing');
        this.send({ type: 'QUEUE_MATCHMAKING', cardIds: this.hand });
        break;
      case 'MATCH_FOUND': {
        this.gameId = msg.gameId;
        this.me = msg.playerNumber === 1 ? 'player1' : 'player2';
        log('opponent', `matched as ${this.me} (opponentIsBot=${msg.opponentIsBot})`);
        if (this.me === 'player1') await this.createOnChain();
        this.move(msg.gameState);
        break;
      }
      case 'OPPONENT_AZTEC_INFO':
        if (this.me === 'player2' && msg.onChainGameId && !this.onChainGameId) {
          this.onChainGameId = String(msg.onChainGameId);
          await this.joinOnChain();
        }
        break;
      case 'GAME_START':
      case 'GAME_STATE':
        this.move(msg.gameState);
        break;
      case 'GAME_OVER':
        this.over = msg.winner;
        log('opponent', `game over: ${msg.winner}`);
        break;
    }
  }

  private async createOnChain(): Promise<void> {
    const { gameId, randomness, blindingFactor, status } =
      await this.chain.pxe.previewCreateGame(this.chain.address);
    if (status !== 0) throw new Error(`stale nonce, status ${status}`);
    this.onChainGameId = String(gameId);
    this.blinding = blindingFactor;
    this.randomness = randomness;
    this.send({ type: 'SHARE_AZTEC_INFO', gameId: this.gameId, aztecAddress: this.chain.address, onChainGameId: gameId, gameRandomness: randomness });
    log('opponent', 'create_game…');
    const tx = await this.chain.pxe.sendCreateGame(this.chain.address, this.hand, { timeoutMs: 600_000 });
    this.send({ type: 'TX_CONFIRMED', gameId: this.gameId, txType: 'create_game', txHash: tx });
    log('opponent', `create_game mined ${String(tx).slice(0, 16)}…`);
  }

  private async joinOnChain(): Promise<void> {
    const { randomness, blindingFactor } =
      await this.chain.pxe.previewJoinGame(this.chain.address, this.onChainGameId);
    this.blinding = blindingFactor;
    this.randomness = randomness;
    this.send({ type: 'SHARE_AZTEC_INFO', gameId: this.gameId, aztecAddress: this.chain.address, onChainGameId: this.onChainGameId, gameRandomness: randomness });
    log('opponent', 'join_game…');
    const tx = await this.chain.pxe.sendJoinGame(this.chain.address, this.onChainGameId, this.hand, { timeoutMs: 600_000 });
    this.send({ type: 'TX_CONFIRMED', gameId: this.gameId, txType: 'join_game', txHash: tx });
    log('opponent', `join_game mined ${String(tx).slice(0, 16)}…`);
  }

  private move(state: GameState | undefined): void {
    if (!state || state.status !== 'playing' || state.currentTurn !== this.me) return;
    const m = chooseBotMove(state, { difficulty: 'greedy' });
    const moveNumber = state.board.flat().filter(c => c.card !== null).length;
    this.send({ type: 'PLACE_CARD', gameId: this.gameId, handIndex: m.handIndex, row: m.row, col: m.col, moveNumber });
  }

  close() { this.ws?.close(); }
}

async function main(): Promise<void> {
  process.env.ARENA_BOT_TOKEN ??= 'e2e-token';
  const addresses = {
    nft: process.env.VITE_NFT_CONTRACT_ADDRESS!,
    game: process.env.VITE_GAME_CONTRACT_ADDRESS!,
    token: process.env.VITE_TOKEN_CONTRACT_ADDRESS,
  };
  if (!addresses.nft || !addresses.game) throw new Error('source packages/frontend/.env first');

  const server = createServer({ port: PORT });
  await new Promise<void>(r => server.httpServer.listen(PORT, () => r()));
  log('stack', `relay on ${PORT}`);

  const mk = (index: number) => new BotChain({
    pxeUrl: PXE_URL,
    nftAddress: addresses.nft,
    gameAddress: addresses.game,
    tokenAddress: addresses.token,
    manifestPath: `packages/bot/.artifacts/arena-bot-${index}.json`,
  }, m => log(`chain${index}`, m));

  // SERIAL connect: all PXE work is serial per wallet.
  const botChain = mk(0); await botChain.connect();
  const oppChain = mk(1); await oppChain.connect();

  const bot = new ArenaBot(
    { ...configFromEnv(), wsUrl: `ws://localhost:${PORT}`, httpUrl: `http://localhost:${PORT}`,
      joinThresholdMs: 1_000, pollIntervalMs: 500, moveDelayMs: 0, token: process.env.ARENA_BOT_TOKEN! },
    { chain: botChain, proofs: new BotProofs(m => log('bot:proofs', m)), log: m => log('bot', m) },
  );
  bot.start();

  const opponent = new ScriptedOpponent(oppChain, new BotProofs(m => log('opp:proofs', m)));
  await opponent.run();

  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline && !opponent.over) await new Promise(r => setTimeout(r, 1000));

  const stats = bot.getStats();
  console.log('\n=== RESULT ===');
  console.log('  outcome        :', opponent.over ?? 'TIMED OUT');
  console.log('  bot stats      :', JSON.stringify(stats));
  const ok = !!opponent.over && stats.gamesPlayed === 1 && stats.moveFailures === 0
    && stats.commitFailures === 0 && stats.proofFailures === 0;
  console.log(ok ? '\n  ✓ FULL CHAIN GAME COMPLETED' : '\n  ✗ see stats above');

  bot.stop(); opponent.close();
  await new Promise<void>(r => server.httpServer.close(() => r()));
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error('E2E FAILED:', e?.stack ?? e); process.exit(1); });
