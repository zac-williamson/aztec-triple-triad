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
 *
 * TWO PROCESSES, not one. pxe.ts binds the wallet in a module-level global, so
 * two identities in one process would silently share the last-connected wallet.
 * The parent runs the bot and spawns itself with --role=opponent for the other
 * side. (BotChain enforces this too, and would throw.)
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
  private oppRandomness: string[] | null = null;
  private handProofSent = false;
  private committed = false;
  private lastState: GameState | null = null;
  private myHandProof: any = null;
  private oppHandProof: any = null;
  private readonly moveProofs = new Map<string, any>();
  private oppAddress: string | null = null;
  private myCommit: string | null = null;
  private oppCommit: string | null = null;
  private oppCardIds: number[] = [];
  private pending: { moveNumber: number; cardId: number; row: number; col: number;
    boardBefore: GameState['board']; scoresBefore: [number, number] } | null = null;
  over: string | null = null;
  settled = false;

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
        if (msg.aztecAddress) this.oppAddress = String(msg.aztecAddress);
        if (Array.isArray(msg.gameRandomness)) {
          this.oppRandomness = msg.gameRandomness as string[];
          await this.maybeProveHand();
        }
        if (this.me === 'player2' && msg.onChainGameId && !this.onChainGameId) {
          this.onChainGameId = String(msg.onChainGameId);
          await this.joinOnChain();
        }
        break;
      case 'GAME_START':
      case 'GAME_STATE':
        await this.maybeProveMove(msg.gameState);
        this.move(msg.gameState);
        break;
      case 'ON_CHAIN_STATUS':
        break;
      case 'HAND_PROOF':
        if (msg.handProof?.cardCommit) {
          this.oppHandProof = msg.handProof;
          this.oppCommit = String(msg.handProof.cardCommit);
          // We may have been holding our turn waiting for this; the relay will
          // not push another GAME_STATE, because the missing move is ours.
          this.move(this.lastState ?? undefined);
        }
        break;
      case 'MOVE_PROVEN':
        if (msg.moveProof?.startStateHash) this.moveProofs.set(String(msg.moveProof.startStateHash), msg.moveProof);
        break;
      case 'GAME_OVER':
        log('opponent', `game over: ${msg.winner}`);
        if (Array.isArray(msg.player1CardIds) && Array.isArray(msg.player2CardIds)) {
          this.oppCardIds = this.me === 'player1' ? msg.player2CardIds : msg.player1CardIds;
        }
        // Mirror the bot's rule: the winner settles; a draw is single-settler P1.
        const iSettle = msg.winner === 'draw' ? this.me === 'player1' : msg.winner === this.me;
        if (iSettle) { try { await this.settle(msg.winner); } catch (e) { log('opponent', `settle ERROR ${(e as Error).message}`); } }
        this.over = msg.winner;
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
    const tx = await this.chain.pxe.sendCreateGame(this.chain.address, this.hand, { node: this.chain.nodeClient, timeoutMs: 600_000 });
    this.send({ type: 'TX_CONFIRMED', gameId: this.gameId, txType: 'create_game', txHash: tx });
    log('opponent', `create_game mined ${String(tx).slice(0, 16)}…`);
    this.committed = true;
    await this.maybeProveHand();
    this.move(this.lastState ?? undefined);
  }

  private async joinOnChain(): Promise<void> {
    const { randomness, blindingFactor } =
      await this.chain.pxe.previewJoinGame(this.chain.address, this.onChainGameId);
    this.blinding = blindingFactor;
    this.randomness = randomness;
    this.send({ type: 'SHARE_AZTEC_INFO', gameId: this.gameId, aztecAddress: this.chain.address, onChainGameId: this.onChainGameId, gameRandomness: randomness });
    log('opponent', 'join_game…');
    const tx = await this.chain.pxe.sendJoinGame(this.chain.address, this.onChainGameId, this.hand, { node: this.chain.nodeClient, timeoutMs: 600_000 });
    this.send({ type: 'TX_CONFIRMED', gameId: this.gameId, txType: 'join_game', txHash: tx });
    log('opponent', `join_game mined ${String(tx).slice(0, 16)}…`);
    this.committed = true;
    await this.maybeProveHand();
    this.move(this.lastState ?? undefined);
  }

  /** The bot's move proofs bind BOTH commitments, so we must publish ours. */
  private async maybeProveHand(): Promise<void> {
    if (this.handProofSent || !this.blinding || !this.oppRandomness || !this.gameId) return;
    this.handProofSent = true;
    const handProof = await this.proofs.proveHand({
      cardIds: this.hand, blindingFactor: this.blinding, opponentRandomness: this.oppRandomness,
    });
    this.myHandProof = handProof;
    this.myCommit = String(handProof.cardCommit);
    this.send({ type: 'SUBMIT_HAND_PROOF', gameId: this.gameId, handProof });
    log('opponent', 'hand proof submitted');
    this.move(this.lastState ?? undefined);
  }

  /** Prove OUR move once the relay echoes it back — the bot does the same. */
  private async maybeProveMove(after: GameState | undefined): Promise<void> {
    const p = this.pending;
    if (!p || !after || !this.me || !this.myCommit || !this.oppCommit) return;
    // Exactly the state our move produced — see the bot's note: a later state
    // may show our card captured, failing "Owner not set correctly".
    if (after.board.flat().filter(c => c.card !== null).length !== p.moveNumber + 1) return;
    this.pending = null;
    const cur: 1 | 2 = this.me === 'player1' ? 1 : 2;
    const ended = after.status === 'finished';
    const winnerId = !ended ? 0 : after.winner === 'player1' ? 1 : after.winner === 'player2' ? 2 : 3;
    const moveProof = await this.proofs.proveMove({
      cardId: p.cardId, row: p.row, col: p.col, currentPlayer: cur,
      boardBefore: p.boardBefore, boardAfter: after.board,
      scoresBefore: p.scoresBefore, scoresAfter: [after.player1Score, after.player2Score],
      cardCommit1: cur === 1 ? this.myCommit : this.oppCommit,
      cardCommit2: cur === 1 ? this.oppCommit : this.myCommit,
      gameEnded: ended, winnerId,
      playerHandData: { cardIds: this.hand, blindingFactor: this.blinding, handIndex: 0 },
    });
    this.moveProofs.set(String(moveProof.startStateHash), moveProof);
    this.send({ type: 'SUBMIT_MOVE_PROOF', gameId: this.gameId, handIndex: 0, row: p.row, col: p.col, moveNumber: p.moveNumber, moveProof });
    log('opponent', `move proof ${p.moveNumber} submitted`);
  }

  private move(state: GameState | undefined): void {
    if (state) this.lastState = state;
    // Same gates as the bot: do not outrun our own commit, and do not play a
    // card we could not prove. A move proof binds BOTH card commitments, and it
    // needs the EXACT post-move board — so a card played before the opponent's
    // hand proof arrives is unprovable forever, and one unprovable move makes
    // the game unsettleable. As player 1 we move FIRST, so this is the normal
    // case here, not an edge case: it cost a full chain run (moves 8/9).
    if (!this.committed) return;
    if (!this.myCommit || !this.oppCommit) return;
    if (!state || state.status !== 'playing' || state.currentTurn !== this.me) return;
    const m = chooseBotMove(state, { difficulty: 'greedy' });
    const moveNumber = state.board.flat().filter(c => c.card !== null).length;
    const card = (this.me === 'player1' ? state.player1Hand : state.player2Hand)[m.handIndex];
    // Paced like the bot, so proving can keep up with the relay.
    setTimeout(() => {
      this.pending = {
        moveNumber, cardId: card?.id ?? 0, row: m.row, col: m.col,
        boardBefore: state.board, scoresBefore: [state.player1Score, state.player2Score],
      };
      this.send({ type: 'PLACE_CARD', gameId: this.gameId, handIndex: m.handIndex, row: m.row, col: m.col, moveNumber });
    }, 2_000);
  }

  private async settle(winner: string): Promise<void> {
    // Wait for the transcript, as the bot does — proving trails the relay.
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (this.myHandProof && this.oppHandProof && this.moveProofs.size >= 9) break;
      await new Promise(r => setTimeout(r, 500));
    }
    if (!this.myHandProof || !this.oppHandProof || this.moveProofs.size < 9) {
      throw new Error(`transcript incomplete (moves ${this.moveProofs.size}/9)`);
    }
    const { handVk, moveVk } = await this.proofs.verificationKeys();
    const { Fr } = await import('@aztec/aztec.js/fields');
    const { AztecAddress } = await import('@aztec/aztec.js/addresses');
    const { buildProcessGameArgs } = await import('../../frontend/src/aztec/settlementArgs.js');
    const iAmP1 = this.me === 'player1';
    const args = await buildProcessGameArgs({
      Fr, AztecAddress,
      onChainGameId: this.onChainGameId!,
      handVk, moveVk,
      handProof1: iAmP1 ? this.myHandProof : this.oppHandProof,
      handProof2: iAmP1 ? this.oppHandProof : this.myHandProof,
      moveProofs: [...this.moveProofs.values()],
      opponentAddress: this.oppAddress!,
      selectedCardId: winner === 'draw' ? 0 : (this.oppCardIds[0] ?? 0),
      myCardIds: this.hand,
      opponentCardIds: this.oppCardIds,
      myRandomness: this.randomness!,
      opponentRandomness: this.oppRandomness!,
    });
    log('opponent', 'settling…');
    const tx = await this.chain.pxe.sendProcessGame(this.chain.address, args, { node: this.chain.nodeClient, timeoutMs: 600_000 });
    this.settled = true;
    log('opponent', `settled on-chain ${String(tx).slice(0, 16)}…`);
  }

  close() { this.ws?.close(); }
}

const ROLE = process.argv.includes('--role=opponent') ? 'opponent' : 'bot';

async function main(): Promise<void> {
  process.env.ARENA_BOT_TOKEN ??= 'e2e-token';
  const addresses = {
    nft: process.env.VITE_NFT_CONTRACT_ADDRESS!,
    game: process.env.VITE_GAME_CONTRACT_ADDRESS!,
    token: process.env.VITE_TOKEN_CONTRACT_ADDRESS,
  };
  if (!addresses.nft || !addresses.game) throw new Error('source packages/frontend/.env first');

  let server: ReturnType<typeof createServer> | null = null;
  if (ROLE === 'bot') {
    server = createServer({ port: PORT });
    await new Promise<void>(r => server!.httpServer.listen(PORT, () => r()));
    log('stack', `relay on ${PORT}`);
  }

  const mk = (index: number) => new BotChain({
    pxeUrl: PXE_URL,
    nftAddress: addresses.nft,
    gameAddress: addresses.game,
    tokenAddress: addresses.token,
    manifestPath: `packages/bot/.artifacts/arena-bot-${index}.json`,
  }, m => log(`chain${index}`, m));

  if (ROLE === 'opponent') {
    const oppChain = mk(1); await oppChain.connect();
    const opponent = new ScriptedOpponent(oppChain, new BotProofs(m => log('opp:proofs', m)));
    await opponent.run();
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline && !opponent.over) await new Promise(r => setTimeout(r, 1000));
    console.log(`[opponent] finished: ${opponent.over ?? 'TIMED OUT'}`);
    opponent.close();
    process.exit(opponent.over ? 0 : 1);
  }

  const botChain = mk(0); await botChain.connect();
  const bot = new ArenaBot(
    { ...configFromEnv(), wsUrl: `ws://localhost:${PORT}`, httpUrl: `http://localhost:${PORT}`,
      joinThresholdMs: 1_000, pollIntervalMs: 500,
      // Pace moves like a real player. With moveDelayMs 0 the nine relay moves
      // fly through in milliseconds while each proof takes ~0.1-0.4s, so the
      // game ends before any move proof lands and there is nothing to settle.
      moveDelayMs: 2_000,
      settleWaitMs: 120_000,
      token: process.env.ARENA_BOT_TOKEN! },
    { chain: botChain, proofs: new BotProofs(m => log('bot:proofs', m)), log: m => log('bot', m) },
  );
  bot.start();

  // Spawn the opponent in its own process (see the header note on pxe.ts).
  const { spawn } = await import('child_process');
  const child = spawn('npx', ['tsx', process.argv[1], '--role=opponent'], {
    env: process.env, stdio: 'inherit',
  });
  const childExit = new Promise<number>(r => child.on('exit', code => r(code ?? 1)));

  const timeout = new Promise<number>(r => setTimeout(() => r(-1), 30 * 60_000));
  const code = await Promise.race([childExit, timeout]);

  // The child exits at GAME_OVER, but the winner's settlement runs AFTER that —
  // gathering the last relayed move proof, building the transcript, then a slow
  // process_game. Killing the bot here would abort a settlement in flight, which
  // is exactly what the harness is meant to observe.
  const settleDeadline = Date.now() + 10 * 60_000;
  while (Date.now() < settleDeadline) {
    const st = bot.getStats();
    if (st.settlements > 0 || st.settleFailures > 0 || st.state === 'idle') break;
    await new Promise(r => setTimeout(r, 2_000));
  }

  const stats = bot.getStats();
  console.log('\n=== RESULT ===');
  console.log('  opponent exit  :', code === -1 ? 'TIMED OUT' : code);
  console.log('  bot stats      :', JSON.stringify(stats));
  // A game that merely FINISHED off-chain proves nothing about the chain path.
  // Require the on-chain work to have actually happened, or this harness would
  // pass while the relay game outran every commit — which is exactly what it
  // did the first time it was run.
  const noFailures = stats.moveFailures === 0 && stats.commitFailures === 0
    && stats.proofFailures === 0 && stats.settleFailures === 0;
  // Either side may settle — the winner does. So assert the GAME reached the
  // settled state on-chain, read independently, rather than that the BOT settled.
  let onChainSettled = false;
  try {
    if (!stats.lastOnChainGameId) throw new Error('bot never learned an on-chain game id');
    const { ChainClient, GAME_STATUS } = await import('@axolotl-arena/playtest/src/chain.js');
    const chainClient = await ChainClient.connect(addresses as never);
    onChainSettled = await chainClient.gameStatus(stats.lastOnChainGameId!) === GAME_STATUS.settled;
  } catch (e) {
    console.log('  (could not read on-chain status:', (e as Error).message, ')');
  }
  console.log('  on-chain settled:', onChainSettled);
  const ok = code === 0 && stats.gamesPlayed === 1 && noFailures && onChainSettled;
  if (!ok) {
    console.log('  MISSING:', [
      code !== 0 && 'opponent exited non-zero',
      stats.gamesPlayed !== 1 && 'no completed game',
      !noFailures && 'failures recorded',
      !onChainSettled && 'GAME NOT SETTLED ON-CHAIN — the relay game likely outran the proofs',
    ].filter(Boolean).join('; '));
  }
  console.log(ok ? '\n  ✓ FULL CHAIN GAME COMPLETED (committed, proved, settled)'
                 : '\n  ✗ chain path incomplete — see MISSING above');

  bot.stop();
  if (child.exitCode === null) child.kill();
  await new Promise<void>(r => server!.httpServer.close(() => r()));
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error('E2E FAILED:', e?.stack ?? e); process.exit(1); });
