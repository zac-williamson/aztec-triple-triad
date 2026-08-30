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
/**
 * Point the scripted player at an EXTERNAL relay — the live one — instead of a
 * relay this process starts. With it set, no local relay and no local bot are
 * created: the opponent is whatever arena bot is actually deployed. This is the
 * only check that covers the wiring BETWEEN deployed pieces (the bot's token
 * matching the relay's, the relay carrying SHARE_BLINDING, the bot holding
 * cards for the contracts the frontend is pointed at), which no amount of local
 * testing can.
 */
const EXTERNAL_RELAY = process.env.E2E_EXTERNAL_RELAY ?? null;
const PXE_URL = process.env.AZTEC_PXE_URL ?? 'http://localhost:8080';
const log = (who: string, m: string) => console.log(`[${who}] ${m}`);
const OPPONENT_DIFFICULTY = (process.env.E2E_OPPONENT_DIFFICULTY ?? 'greedy') as 'random' | 'greedy' | 'lookahead';
/**
 * Number of the opponent's own move proofs after which it walks out without a
 * word — the abandonment case. This is not a contrived failure: it is a player
 * closing the tab, and it is the ONLY way the bot's cards get stranded, since
 * the bot never creates and therefore can never cancel.
 */
const ABANDON_AFTER = Number(process.env.E2E_ABANDON_AFTER_MOVES ?? 0);
/**
 * Walk out after the hand proof but BEFORE the first move — the case that was
 * unrecoverable until the contract allowed a zero-move claim. The bot has both
 * hand proofs and no move proofs, which is exactly the transcript the claim now
 * accepts (and only from player 2, who is not the one who failed to move).
 */
const ABANDON_BEFORE_MOVE = process.env.E2E_ABANDON_BEFORE_MOVE === '1';
const TAMPER_CARDS = process.env.E2E_TAMPER_SETTLE_CARDS
  ? JSON.parse(process.env.E2E_TAMPER_SETTLE_CARDS) as number[]
  : null;
/**
 * Fixed hands, to force a specific OUTCOME. A draw in particular cannot be
 * arranged by difficulty alone — ranks are per token_id from a fixed database,
 * so a draw needs a hand pair that happens to end 5-5 under greedy play. The
 * draw path matters because the bot is always player 2, and a draw it fails to
 * settle strands ten cards with NO recovery: the abandonment claim needs 1..8
 * move proofs and a completed draw has all nine.
 */
const OPPONENT_SEED = process.env.E2E_OPPONENT_SEED ? Number(process.env.E2E_OPPONENT_SEED) : undefined;
const FORCED_OPP_HAND = process.env.E2E_OPPONENT_HAND ? JSON.parse(process.env.E2E_OPPONENT_HAND) as number[] : null;
const FORCED_BOT_HAND = process.env.E2E_BOT_HAND ? JSON.parse(process.env.E2E_BOT_HAND) as number[] : null;

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
  private oppBlinding: string | null = null;
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
  /** Move proofs still generating. The last move's proof is produced AFTER
   *  GAME_OVER, so exiting on `over` alone drops it — and the winner then waits
   *  forever for a 9th link that nobody will ever send. */
  private proving = 0;
  private myMoveProofs = 0;
  abandoned = false;
  /** True once every move we made has been proved and relayed. */
  get transcriptFlushed(): boolean { return this.proving === 0 && this.pending === null; }

  constructor(private chain: BotChain, private proofs: BotProofs) {}

  /** Set once MATCH_FOUND lands, so a production run can assert it played the BOT. */
  opponentWasBot: boolean | null = null;
  /** The on-chain id, for reading the settled status afterwards. */
  get onChainGameIdPublic(): string | null { return this.onChainGameId; }

  async run(relayUrl?: string): Promise<void> {
    this.hand = FORCED_OPP_HAND ?? await this.chain.selectHand(5);
    log('opponent', `hand ${this.hand.join(',')}`);
    this.ws = new WebSocket(relayUrl ?? `ws://localhost:${PORT}`);
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
        this.opponentWasBot = msg.opponentIsBot ?? null;
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
      case 'OPPONENT_BLINDING':
        if (typeof msg.blindingFactor === 'string') this.oppBlinding = msg.blindingFactor;
        break;
      case 'MOVE_PROVEN':
        if (msg.moveProof?.startStateHash) this.moveProofs.set(String(msg.moveProof.startStateHash), msg.moveProof);
        break;
      case 'GAME_OVER':
        log('opponent', `game over: ${msg.winner}`);
        // Whoever settles needs BOTH blinding factors to prove the card ids.
        if (this.blinding && this.gameId) {
          this.send({ type: 'SHARE_BLINDING', gameId: this.gameId, blindingFactor: this.blinding });
        }
        if (Array.isArray(msg.player1CardIds) && Array.isArray(msg.player2CardIds)) {
          this.oppCardIds = this.me === 'player1' ? msg.player2CardIds : msg.player1CardIds;
        }
        // Mirror the bot's rule: the winner settles; a draw is single-settler P1.
        // E2E_OPPONENT_SKIP_DRAW_SETTLE simulates the human closing the tab on a
        // draw, which is the ONLY thing standing between the bot and ten
        // permanently stranded cards — the abandonment claim cannot rescue a
        // completed draw (it needs 1..8 move proofs; a draw has nine).
        const skipDraw = process.env.E2E_OPPONENT_SKIP_DRAW_SETTLE === '1' && msg.winner === 'draw';
        if (skipDraw) log('opponent', 'walking away from a DRAW without settling');
        const iSettle = !skipDraw && (msg.winner === 'draw' ? this.me === 'player1' : msg.winner === this.me);
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
    this.proving += 1;
    try {
      // Commits passed explicitly: the null checks above narrow them here, but
      // that narrowing does not survive the call boundary.
      await this.proveAndSend(p, after, this.myCommit, this.oppCommit);
    } finally {
      this.proving -= 1;
    }
  }

  /** Same one-move-per-turn guard as the bot; move() has three callers too. */
  private scheduledFor: number | null = null;

  private async proveAndSend(
    p: NonNullable<ScriptedOpponent['pending']>, after: GameState,
    myCommit: string, oppCommit: string,
  ): Promise<void> {
    const cur: 1 | 2 = this.me === 'player1' ? 1 : 2;
    const ended = after.status === 'finished';
    const winnerId = !ended ? 0 : after.winner === 'player1' ? 1 : after.winner === 'player2' ? 2 : 3;
    const moveProof = await this.proofs.proveMove({
      cardId: p.cardId, row: p.row, col: p.col, currentPlayer: cur,
      boardBefore: p.boardBefore, boardAfter: after.board,
      scoresBefore: p.scoresBefore, scoresAfter: [after.player1Score, after.player2Score],
      cardCommit1: cur === 1 ? myCommit : oppCommit,
      cardCommit2: cur === 1 ? oppCommit : myCommit,
      gameEnded: ended, winnerId,
      playerHandData: { cardIds: this.hand, blindingFactor: this.blinding, handIndex: 0 },
    });
    this.moveProofs.set(String(moveProof.startStateHash), moveProof);
    this.send({ type: 'SUBMIT_MOVE_PROOF', gameId: this.gameId, handIndex: 0, row: p.row, col: p.col, moveNumber: p.moveNumber, moveProof });
    log('opponent', `move proof ${p.moveNumber} submitted`);
    this.myMoveProofs += 1;
    if (ABANDON_AFTER > 0 && this.myMoveProofs >= ABANDON_AFTER) {
      log('opponent', `ABANDONING after ${this.myMoveProofs} move(s) — closing the socket`);
      this.abandoned = true;
      this.close();
    }
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
    if (ABANDON_BEFORE_MOVE && !this.abandoned) {
      log('opponent', 'ABANDONING before playing a single card — closing the socket');
      this.abandoned = true;
      this.close();
      return;
    }
    if (!state || state.status !== 'playing' || state.currentTurn !== this.me) return;
    // Overridable so a run can force a BOT win: the bot settling is a distinct
    // on-chain path from the opponent settling (it is the side that takes a
    // card), and greedy-vs-greedy does not reliably produce one.
    const moveNumber = state.board.flat().filter(c => c.card !== null).length;
    if (this.scheduledFor !== null && this.scheduledFor >= moveNumber) return;
    const m = chooseBotMove(state, {
      difficulty: OPPONENT_DIFFICULTY,
      ...(OPPONENT_SEED !== undefined ? { seed: OPPONENT_SEED } : {}),
    });
    this.scheduledFor = moveNumber;
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
      if (this.myHandProof && this.oppHandProof && this.moveProofs.size >= 9 && this.oppBlinding) break;
      await new Promise(r => setTimeout(r, 500));
    }
    if (!this.myHandProof || !this.oppHandProof || this.moveProofs.size < 9 || !this.oppBlinding) {
      throw new Error(
        `transcript incomplete (moves ${this.moveProofs.size}/9` +
        `${this.oppBlinding ? '' : ', no opponent blinding'})`,
      );
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
      // SECURITY PROBE (E2E_TAMPER_SETTLE_CARDS): settle naming card ids we
      // never committed. The contract binds the hand PROOF's card_commit to the
      // stored commitment, but nothing ties these ids to that commitment — so
      // if this mints, a winner can name any cards they like.
      myCardIds: TAMPER_CARDS ?? this.hand,
      opponentCardIds: this.oppCardIds,
      myRandomness: this.randomness!,
      opponentRandomness: this.oppRandomness!,
      myBlinding: this.blinding!,
      opponentBlinding: this.oppBlinding!,
    });
    log('opponent', 'settling…');
    const tx = await this.chain.pxe.sendProcessGame(this.chain.address, args, { node: this.chain.nodeClient, timeoutMs: 600_000 });
    this.settled = true;
    log('opponent', `settled on-chain ${String(tx).slice(0, 16)}…`);
  }

  close() { this.ws?.close(); }
}

/** A chain for the production run, independent of the local stack's mk(). */
function mkExternal(index: number, addresses: { nft: string; game: string; token?: string }): BotChain {
  return new BotChain({
    pxeUrl: PXE_URL,
    nftAddress: addresses.nft,
    gameAddress: addresses.game,
    tokenAddress: addresses.token,
    manifestPath: `${process.env.ARENA_BOT_ARTIFACTS_DIR ?? 'packages/bot/.artifacts'}/arena-bot-${index}.json`,
  }, m => log(`chain${index}`, m));
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

  // Production mode: drive the LIVE relay and let the DEPLOYED bot be the
  // opponent. Everything else here builds a local stack, which is the wrong
  // thing to test once the pieces are actually deployed.
  if (EXTERNAL_RELAY) {
    const oppChain = mkExternal(Number(process.env.E2E_PLAYER_INDEX ?? '1'), addresses);
    await oppChain.connect();
    const player = new ScriptedOpponent(oppChain, new BotProofs(m => log('player:proofs', m)));
    await player.run(EXTERNAL_RELAY);

    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline && !player.over) await new Promise(r => setTimeout(r, 2_000));
    const flushBy = Date.now() + 180_000;
    while (Date.now() < flushBy && !player.transcriptFlushed) await new Promise(r => setTimeout(r, 1_000));
    // The bot settles when it wins; give that time to land.
    await new Promise(r => setTimeout(r, 120_000));

    const status = player.onChainGameIdPublic
      ? Number(await oppChain.pxe.readGameStatus(oppChain.address, player.onChainGameIdPublic))
      : 0;
    console.log('\n=== PRODUCTION GAME ===');
    console.log('  opponent was the bot :', player.opponentWasBot === true ? 'yes' : `NO (${player.opponentWasBot})`);
    console.log('  result               :', player.over ?? 'TIMED OUT');
    console.log('  on-chain status      :', status, status === 3 ? '(SETTLED)' : '');
    const ok = player.opponentWasBot === true && player.over !== null && status === 3;
    console.log(ok
      ? '\n  ✓ A REAL PLAYER GOT A GAME FROM THE DEPLOYED BOT AND IT SETTLED'
      : '\n  ✗ production did not serve a complete game — see above');
    process.exit(ok ? 0 : 1);
  }

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
    // ARENA_BOT_ARTIFACTS_DIR keeps sandbox and testnet identities apart. The
    // manifest is the only record of an untagged note's plaintext, so the two
    // sets must never share a directory.
    manifestPath: `${process.env.ARENA_BOT_ARTIFACTS_DIR ?? 'packages/bot/.artifacts'}/arena-bot-${index}.json`,
  }, m => log(`chain${index}`, m));

  if (ROLE === 'opponent') {
    const oppChain = mk(1); await oppChain.connect();
    const opponent = new ScriptedOpponent(oppChain, new BotProofs(m => log('opp:proofs', m)));
    await opponent.run();
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline && !opponent.over && !opponent.abandoned) {
      await new Promise(r => setTimeout(r, 1000));
    }
    if (opponent.abandoned) {
      // The whole point is to leave WITHOUT flushing. Exit 0: this is the
      // scenario succeeding, not the harness failing.
      console.log('[opponent] abandoned the game and exited');
      process.exit(0);
    }

    // GAME_OVER is not the end of our work. The final move's proof is generated
    // AFTER the relay declares the game over, so exiting here drops it — and if
    // the BOT won, the bot is the one settling, and it will wait out its whole
    // settle window for a 9th link that nobody is ever going to send. Cost a
    // full run: "transcript incomplete: 1 move proof(s)".
    const flushBy = Date.now() + 120_000;
    while (Date.now() < flushBy && !opponent.transcriptFlushed) await new Promise(r => setTimeout(r, 500));
    if (!opponent.transcriptFlushed) log('opponent', 'WARNING: exiting with proofs still in flight');
    // And a moment for the relay to fan the last one out to the bot.
    await new Promise(r => setTimeout(r, 2_000));
    console.log(`[opponent] finished: ${opponent.over ?? 'TIMED OUT'} (transcript flushed)`);
    opponent.close();
    process.exit(opponent.over ? 0 : 1);
  }

  const botChain = mk(0); await botChain.connect();
  if (FORCED_BOT_HAND) {
    // Test-only: pin the wager so a specific OUTCOME can be reproduced.
    botChain.selectHand = async () => FORCED_BOT_HAND;
    log('bot', `hand pinned to ${FORCED_BOT_HAND.join(',')}`);
  }
  const botProofs = new BotProofs(m => log('bot:proofs', m));
  const { GameJournal } = await import('../src/GameJournal.js');
  const { AbandonmentSweep } = await import('../src/AbandonmentSweep.js');
  const journal = new GameJournal(`packages/bot/.artifacts/games-e2e`);
  const bot = new ArenaBot(
    { ...configFromEnv(), wsUrl: `ws://localhost:${PORT}`, httpUrl: `http://localhost:${PORT}`,
      joinThresholdMs: 1_000, pollIntervalMs: 500,
      // Pace moves like a real player. With moveDelayMs 0 the nine relay moves
      // fly through in milliseconds while each proof takes ~0.1-0.4s, so the
      // game ends before any move proof lands and there is nothing to settle.
      moveDelayMs: 2_000,
      settleWaitMs: 120_000,
      token: process.env.ARENA_BOT_TOKEN! },
    { chain: botChain, proofs: botProofs, journal, log: m => log('bot', m) },
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
  // Fail fast on a card shortage. The bot logs it and correctly stays idle, but
  // the harness would then sit out its full 30-minute deadline waiting for a
  // game that can never start — a seven-minute stare at an empty log before you
  // find the one line that explains it. The bot's collection is a LOSS BUDGET
  // and repeated runs drain it, so this is the ordinary way a run session ends.
  const shortage = setInterval(() => {
    const e = bot.getStats().lastError;
    if (e && /holds only/.test(e)) {
      console.error(`\nE2E ABORTED: ${e}\n` +
        `Top the identities up:\n` +
        `  npx tsx scripts/provision-arena-bot.ts --index 0 --cards 30 --offset <next free id>`);
      process.exit(2);
    }
  }, 2_000);
  shortage.unref?.();

  const settleDeadline = Date.now() + 10 * 60_000;
  while (Date.now() < settleDeadline) {
    const st = bot.getStats();
    if (st.settlements > 0 || st.settleFailures > 0 || st.state === 'idle') break;
    await new Promise(r => setTimeout(r, 2_000));
  }

  // --- Abandonment mode: the opponent walked out, so nothing will ever settle
  // this game normally. Prove the cards actually come BACK, which is the only
  // thing that makes an unattended bot viable.
  if (ABANDON_AFTER > 0 || ABANDON_BEFORE_MOVE) {
    const before = await botChain.readCards();
    const outstanding = journal.outstanding();
    console.log('\n=== ABANDONMENT RECOVERY ===');
    console.log('  journalled games:', outstanding.length,
                outstanding.map(r => `${r.onChainGameId.slice(0, 12)}… ${r.moveProofs.length}/9 moves`));
    console.log('  spendable before:', before.length);

    // The sandbox's automine sequencer only builds a block on TX ACTIVITY, so
    // the dispute window — measured in BLOCKS — never opens on its own while the
    // sweep sits waiting for it. Nudge it. Testnet needs none of this; blocks
    // arrive there whether or not we are doing anything.
    const nudge = setInterval(() => {
      void fetch(PXE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'aztecDebug_mineBlock', params: [] }),
      }).catch(() => {});
    }, 4_000);
    nudge.unref?.();

    const sweep = new AbandonmentSweep({
      journal, chain: botChain, proofs: botProofs,
      log: m => log('sweep', m),
      minAgeMs: 0,          // the game is known-dead here; no need to wait it out
    });
    const swept = await sweep.run();
    clearInterval(nudge);
    // The PXE needs a beat to surface the re-minted notes.
    await new Promise(r => setTimeout(r, 5_000));
    const after = await botChain.readCards();

    console.log('  sweep stats     :', JSON.stringify(swept));
    console.log('  spendable after :', after.length, `(+${after.length - before.length})`);
    bot.stop();

    const ok = swept.recovered === 1 && after.length > before.length;
    console.log(ok
      ? '\n  ✓ ABANDONED GAME RECOVERED — committed cards are back'
      : '\n  ✗ recovery failed — cards are still stranded');
    process.exit(ok ? 0 : 1);
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
    // Read through the ALREADY-CONNECTED bot chain, not a fresh ChainClient.
    // A second client has to resolve the contracts from scratch, and on a
    // rate-limited public node that fails — reporting "GAME NOT SETTLED" for a
    // game that had in fact settled. A verifier that cries wolf is worse than
    // no verifier.
    const status = await botChain.pxe.readGameStatus(botChain.address, stats.lastOnChainGameId);
    onChainSettled = Number(status) === 3;   // 3 = settled
    console.log(`  on-chain status  : ${status}`);
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
