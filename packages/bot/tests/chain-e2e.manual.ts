/**
 * Full chain-mode game on a LOCAL SANDBOX: the arena bot versus a scripted
 * opponent, both real chain players — key exchange, create/join, prove, settle,
 * import (docs/plan/PRIVATE_GAMES.md).
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
 * bot against a copy of itself would hide any assumption both sides share. It
 * plays the creator's side of the protocol, as a browser does: key exchange,
 * create_game, its RECORD, then play; it settles when it wins and, by
 * convention, a draw.
 *
 * TWO PROCESSES, not one. pxe.ts binds the wallet in a module-level global, so
 * two identities in one process would silently share the last-connected wallet.
 * The parent runs the bot and spawns itself with --role=opponent for the other
 * side. (BotChain enforces this too, and would throw.)
 */
import WebSocket from 'ws';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createServer } from '@axolotl-arena/backend/src/server.js';
import { chooseBotMove } from '@axolotl-arena/game-logic';
import type { GameState, Player } from '@axolotl-arena/game-logic';
import { ArenaBot } from '../src/ArenaBot.js';
import { BotChain } from '../src/BotChain.js';
import { BotProofs } from '../src/BotProofs.js';
import { configFromEnv } from '../src/config.js';
import { checkTranscript, normalizeMoveProof, parsePeerPayload } from '../src/protocol.js';
import { choosePrizeMove } from '../src/settlement.js';
import type { JournalRecord } from '../src/GameJournal.js';
import { NULLIFIER_INDEX, RECORD_HAND, type GameRecord, type GameSecrets } from '../../frontend/src/aztec/privateGame.js';
import type { GameChannel, GameKeyPair } from '../../frontend/src/aztec/gameKeys.js';
import type { MoveProofData } from '../../frontend/src/types.js';

const PORT = 5399;
/**
 * Point the scripted player at an EXTERNAL relay — the live one — instead of a
 * relay this process starts. With it set, no local relay and no local bot are
 * created: the opponent is whatever arena bot is actually deployed. This is the
 * only check that covers the wiring BETWEEN deployed pieces (the bot's token
 * matching the relay's, the relay carrying KEY_EXCHANGE and PEER, the bot
 * holding cards for the contracts the frontend is pointed at).
 */
const EXTERNAL_RELAY = process.env.E2E_EXTERNAL_RELAY ?? null;
const PXE_URL = process.env.AZTEC_PXE_URL ?? 'http://localhost:8080';
const JOURNAL_DIR = 'packages/bot/.artifacts/games-e2e';
const log = (who: string, m: string) => console.log(`[${who}] ${m}`);
const OPPONENT_DIFFICULTY = (process.env.E2E_OPPONENT_DIFFICULTY ?? 'greedy') as 'random' | 'greedy' | 'lookahead';
/**
 * Number of the opponent's own move proofs after which it walks out without a
 * word — the abandonment case. This is not a contrived failure: it is a player
 * closing the tab, and it is the ordinary way the bot's cards get stuck, since
 * the bot never creates and therefore can never cancel.
 */
const ABANDON_AFTER = Number(process.env.E2E_ABANDON_AFTER_MOVES ?? 0);
/** Walk out after both records are exchanged but BEFORE the first move. */
const ABANDON_BEFORE_MOVE = process.env.E2E_ABANDON_BEFORE_MOVE === '1';
/**
 * Fixed hands, to force a specific OUTCOME. A draw in particular cannot be
 * arranged by difficulty alone — ranks are per token_id from a fixed database,
 * so a draw needs a hand pair that happens to end 5-5 under greedy play.
 */
const OPPONENT_SEED = process.env.E2E_OPPONENT_SEED ? Number(process.env.E2E_OPPONENT_SEED) : undefined;
const FORCED_OPP_HAND = process.env.E2E_OPPONENT_HAND ? JSON.parse(process.env.E2E_OPPONENT_HAND) as number[] : null;
const FORCED_BOT_HAND = process.env.E2E_BOT_HAND ? JSON.parse(process.env.E2E_BOT_HAND) as number[] : null;

/** A chain-real opponent: queues first, creates, plays greedily, proves, settles what it wins. */
class ScriptedOpponent {
  private ws!: WebSocket;
  private gameId: string | null = null;
  private me: Player | null = null;
  private hand: number[] = [];
  private keyPair: GameKeyPair | null = null;
  private theirKey: string | null = null;
  private channel: GameChannel | null = null;
  private secrets: GameSecrets | null = null;
  /** Ours (the creator's), and the bot's. */
  private record1: GameRecord | null = null;
  private record2: GameRecord | null = null;
  private committed = false;
  private lastState: GameState | null = null;
  private readonly moveProofs = new Map<string, MoveProofData>();
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

  /** The game's identity, for reading its resolution afterwards. Ours alone — never sent anywhere. */
  get game(): { gameKey: string; record1: GameRecord; record2: GameRecord } | null {
    return this.channel && this.record1 && this.record2
      ? { gameKey: this.channel.gameKey, record1: this.record1, record2: this.record2 }
      : null;
  }

  async run(relayUrl?: string): Promise<void> {
    this.hand = FORCED_OPP_HAND ?? await this.chain.selectHand(5);
    log('opponent', `hand ${this.hand.join(',')}`);
    this.ws = new WebSocket(relayUrl ?? `ws://localhost:${PORT}`);
    await new Promise<void>(r => this.ws.once('open', () => r()));
    this.ws.on('message', raw => void this.handle(JSON.parse(raw.toString())).catch(e =>
      log('opponent', `ERROR ${e?.message ?? e}`)));
  }

  private send(m: unknown) { this.ws.send(JSON.stringify(m)); }

  private async keys() { return import('../../frontend/src/aztec/gameKeys.js'); }

  private sendOpts() { return { node: this.chain.nodeClient, timeoutMs: 600 }; }

  private async sendPeer(payload: unknown): Promise<void> {
    const sealed = await (await this.keys()).sealPeerPayload(this.channel!.channelKey, this.gameId!, payload);
    this.send({ type: 'PEER', gameId: this.gameId, ...sealed });
  }

  private async handle(msg: any): Promise<void> {
    switch (msg.type) {
      case 'SESSION_ESTABLISHED':
        log('opponent', 'queueing');
        this.send({ type: 'QUEUE_MATCHMAKING', cardIds: this.hand });
        break;
      case 'MATCH_FOUND':
        this.gameId = msg.gameId;
        this.me = msg.playerNumber === 1 ? 'player1' : 'player2';
        log('opponent', `matched as ${this.me}`);
        if (this.me !== 'player1') throw new Error('the bot only joins, so the scripted player must be the creator');
        this.keyPair = await (await this.keys()).generateGameKeyPair();
        this.send({ type: 'KEY_EXCHANGE', gameId: this.gameId, publicKey: this.keyPair.publicKey });
        await this.maybeCreate();
        this.move(msg.gameState);
        break;
      case 'OPPONENT_KEY':
        this.theirKey = String(msg.publicKey);
        await this.maybeCreate();
        break;
      case 'PEER': {
        if (!this.channel) break;
        const payload = parsePeerPayload(await (await this.keys()).openPeerPayload(
          this.channel.channelKey, this.gameId!, { iv: msg.iv, ciphertext: msg.ciphertext }));
        if (payload?.kind === 'RECORD' && !this.record2) {
          this.record2 = payload.record;
          log('opponent', 'the bot\'s record arrived — both hands are bound');
          this.move(this.lastState ?? undefined);
        } else if (payload) {
          log('opponent', `PEER ${payload.kind}`);
        }
        break;
      }
      case 'GAME_START':
      case 'GAME_STATE':
        await this.maybeProveMove(msg.gameState);
        this.move(msg.gameState);
        break;
      case 'MOVE_PROVEN': {
        const p = normalizeMoveProof(msg.moveProof);
        if (p) this.moveProofs.set(p.startStateHash, p);
        break;
      }
      case 'GAME_OVER': {
        log('opponent', `game over: ${msg.winner}`);
        // Mirror the protocol: the winner settles; a draw by convention P1.
        // E2E_OPPONENT_SKIP_DRAW_SETTLE simulates the human closing the tab on
        // a draw, which the bot must then settle itself.
        const skipDraw = process.env.E2E_OPPONENT_SKIP_DRAW_SETTLE === '1' && msg.winner === 'draw';
        if (skipDraw) log('opponent', 'walking away from a DRAW without settling');
        const iSettle = !skipDraw && (msg.winner === 'draw' || msg.winner === this.me);
        if (iSettle) { try { await this.settle(); } catch (e) { log('opponent', `settle ERROR ${(e as Error).message}`); } }
        this.over = msg.winner;
        break;
      }
    }
  }

  /** Once both keys are known: commit our hand and send our record. */
  private async maybeCreate(): Promise<void> {
    if (this.channel || !this.keyPair || !this.theirKey || !this.gameId) return;
    this.channel = await (await this.keys()).deriveGameChannel(this.keyPair, this.theirKey, this.gameId);
    const pxe = this.chain.pxe;
    const nonce = await pxe.readNoteNonce(this.chain.address);
    this.secrets = await pxe.computeGameSecrets(this.chain.address, nonce);
    this.record1 = await pxe.previewRecord(this.chain.address, this.channel.gameKey, this.hand, nonce);
    log('opponent', 'create_game…');
    await pxe.sendCreateGame(this.chain.address, this.channel.gameKey, this.hand, this.sendOpts());
    this.send({ type: 'TX_CONFIRMED', gameId: this.gameId, txType: 'create_game' });
    log('opponent', 'create_game mined — sending our record');
    this.committed = true;
    await this.sendPeer({ kind: 'RECORD', record: this.record1 });
    this.move(this.lastState ?? undefined);
  }

  /** Prove OUR move once the relay echoes it back — the bot does the same. */
  private async maybeProveMove(after: GameState | undefined): Promise<void> {
    const p = this.pending;
    if (!p || !after || !this.me || !this.record1 || !this.record2 || !this.secrets) return;
    // Exactly the state our move produced — see the bot's note: a later state
    // may show our card captured, failing "Owner not set correctly".
    if (after.board.flat().filter(c => c.card !== null).length !== p.moveNumber + 1) return;
    this.pending = null;
    this.proving += 1;
    try {
      const ended = after.status === 'finished';
      const winnerId = !ended ? 0 : after.winner === 'player1' ? 1 : after.winner === 'player2' ? 2 : 3;
      const raw = await this.proofs.proveMove({
        cardId: p.cardId, row: p.row, col: p.col, currentPlayer: 1,
        boardBefore: p.boardBefore, boardAfter: after.board,
        scoresBefore: p.scoresBefore, scoresAfter: [after.player1Score, after.player2Score],
        cardCommit1: this.record1[RECORD_HAND], cardCommit2: this.record2[RECORD_HAND],
        gameEnded: ended, winnerId,
        hand: { cardIds: this.hand, blindingFactor: this.secrets.blinding },
      });
      const kept = normalizeMoveProof(raw);
      if (kept) this.moveProofs.set(kept.startStateHash, kept);
      this.send({ type: 'SUBMIT_MOVE_PROOF', gameId: this.gameId, handIndex: 0, row: p.row, col: p.col, moveNumber: p.moveNumber, moveProof: raw });
      log('opponent', `move proof ${p.moveNumber} submitted`);
      this.myMoveProofs += 1;
      if (ABANDON_AFTER > 0 && this.myMoveProofs >= ABANDON_AFTER) {
        log('opponent', `ABANDONING after ${this.myMoveProofs} move(s) — closing the socket`);
        this.abandoned = true;
        this.close();
      }
    } finally {
      this.proving -= 1;
    }
  }

  /** Same one-move-per-turn guard as the bot; move() has several callers too. */
  private scheduledFor: number | null = null;

  private move(state: GameState | undefined): void {
    if (state) this.lastState = state;
    // Same gates as the bot: do not outrun our own commit, and do not play a
    // card we could not prove — a move proof binds BOTH records' hands.
    if (!this.committed || !this.record2) return;
    if (ABANDON_BEFORE_MOVE && !this.abandoned) {
      log('opponent', 'ABANDONING before playing a single card — closing the socket');
      this.abandoned = true;
      this.close();
      return;
    }
    if (!state || state.status !== 'playing' || state.currentTurn !== this.me) return;
    const moveNumber = state.board.flat().filter(c => c.card !== null).length;
    if (this.scheduledFor !== null && this.scheduledFor >= moveNumber) return;
    const m = chooseBotMove(state, {
      difficulty: OPPONENT_DIFFICULTY,
      ...(OPPONENT_SEED !== undefined ? { seed: OPPONENT_SEED } : {}),
    });
    this.scheduledFor = moveNumber;
    const card = state.player1Hand[m.handIndex];
    // Paced like the bot, so proving can keep up with the relay.
    setTimeout(() => {
      this.pending = {
        moveNumber, cardId: card?.id ?? 0, row: m.row, col: m.col,
        boardBefore: state.board, scoresBefore: [state.player1Score, state.player2Score],
      };
      this.send({ type: 'PLACE_CARD', gameId: this.gameId, handIndex: m.handIndex, row: m.row, col: m.col, moveNumber });
    }, 2_000);
  }

  private async settle(): Promise<void> {
    // Wait for the transcript, as the bot does — proving trails the relay.
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && this.moveProofs.size < 9) await new Promise(r => setTimeout(r, 500));
    const { ordered, winner } = checkTranscript([...this.moveProofs.values()], this.record1!, this.record2!);
    const prizeMove = choosePrizeMove(ordered, winner);
    const { Fr } = await import('@aztec-labs/aztec.js/fields');
    const { buildSettleGameArgs } = await import('../../frontend/src/aztec/settlementArgs.js');
    const args = await buildSettleGameArgs({
      Fr, gameKey: this.channel!.gameKey, record1: this.record1!, record2: this.record2!,
      moveVk: await this.proofs.moveVerificationKey(),
      moveProofs: [...this.moveProofs.values()], prizeMove,
    });
    await this.sendPeer({ kind: 'SETTLING', prizeMove });
    log('opponent', `settling (prize move ${prizeMove})…`);
    const txHash = await this.chain.pxe.sendSettleGame(this.chain.address, args, this.sendOpts());
    this.settled = true;
    await this.sendPeer({ kind: 'SETTLED', txHash });
    log('opponent', `settled on-chain ${String(txHash).slice(0, 16)}…`);
  }

  close() { this.ws?.close(); }
}

/** Whether the game's `done` nullifier is on-chain: settled, unwound — resolved either way. */
async function resolvedOnChain(chain: BotChain, game: { gameKey: string; record1: GameRecord; record2: GameRecord }): Promise<boolean> {
  const nullifiers = await chain.pxe.gameNullifiers(chain.address, game.gameKey, game.record1, game.record2);
  const [done] = await chain.lookupNullifiers([nullifiers[NULLIFIER_INDEX.done]]);
  return done !== null;
}

/** The bot's journal entries for this run (newest first). */
function journalled(): JournalRecord[] {
  if (!existsSync(JOURNAL_DIR)) return [];
  return readdirSync(JOURNAL_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(readFileSync(join(JOURNAL_DIR, f), 'utf-8')) as JournalRecord; } catch { return null; } })
    .filter((r): r is JournalRecord => r !== null && r.version === 2)
    .sort((a, b) => b.committedAt - a.committedAt);
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
  if (!addresses.nft || !addresses.game || !addresses.token) throw new Error('source packages/frontend/.env first');

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

    const game = player.game;
    const resolved = game ? await resolvedOnChain(oppChain, game) : false;
    console.log('\n=== PRODUCTION GAME ===');
    console.log('  result               :', player.over ?? 'TIMED OUT');
    console.log('  resolved on-chain    :', resolved);
    const ok = player.over !== null && resolved;
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
    // the BOT won, it is settling and needs that ninth link.
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
  const journal = new GameJournal(JOURNAL_DIR);
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

  // Fail fast on a card shortage. The bot logs it and correctly stays idle, but
  // the harness would then sit out its full deadline waiting for a game that can
  // never start. The bot's collection is a LOSS BUDGET and repeated runs drain it.
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

  // --- Abandonment mode: the opponent walked out, so nothing will ever settle
  // this game normally. Prove the cards actually come BACK: claim, wait out the
  // dispute window, finalize, import — one sweep step per pass.
  if (ABANDON_AFTER > 0 || ABANDON_BEFORE_MOVE) {
    const before = await botChain.readCards({ force: true });
    console.log('\n=== ABANDONMENT RECOVERY ===');
    console.log('  journalled games:', journalled().length);
    console.log('  spendable before:', before.length);

    // The sandbox's automine sequencer only builds a block on TX ACTIVITY, so
    // the chain's clock — which every abandonment bar is measured on — stands
    // still while the sweep waits. Nudge it.
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
    const until = Date.now() + 45 * 60_000;
    while (Date.now() < until && journal.outstanding().length > 0) {
      await sweep.run();
      if (journal.outstanding().length > 0) await new Promise(r => setTimeout(r, 20_000));
    }
    clearInterval(nudge);
    const after = await botChain.readCards({ force: true });

    console.log('  sweep stats     :', JSON.stringify(sweep.stats));
    console.log('  spendable after :', after.length, `(+${after.length - before.length})`);
    bot.stop();

    const ok = sweep.stats.recovered >= 1 && after.length > before.length;
    console.log(ok
      ? '\n  ✓ ABANDONED GAME RECOVERED — committed cards are back'
      : '\n  ✗ recovery failed — cards are still stranded');
    process.exit(ok ? 0 : 1);
  }

  // The bot settles a win (and a draw the opponent leaves) after GAME_OVER, and
  // imports from the opponent's settlement otherwise: wait for its journal
  // entry to be marked resolved — which only happens once our cards are back.
  const resolveBy = Date.now() + 10 * 60_000;
  while (Date.now() < resolveBy && !journalled()[0]?.resolution) {
    await new Promise(r => setTimeout(r, 2_000));
  }

  const stats = bot.getStats();
  const rec = journalled()[0] ?? null;
  console.log('\n=== RESULT ===');
  console.log('  opponent exit  :', code === -1 ? 'TIMED OUT' : code);
  console.log('  bot stats      :', JSON.stringify(stats));
  console.log('  journal        :', rec ? `${rec.outcome ?? '?'} — ${rec.resolution ?? 'UNRESOLVED'}` : 'none');
  // A game that merely FINISHED off-chain proves nothing about the chain path.
  // Require the bot's own record to say the game resolved and its cards came back.
  const noFailures = stats.moveFailures === 0 && stats.commitFailures === 0
    && stats.proofFailures === 0 && stats.settleFailures === 0 && stats.cardsUnimported === 0;
  const resolved = rec?.resolution === 'settled';
  const ok = code === 0 && stats.gamesPlayed === 1 && noFailures && resolved;
  if (!ok) {
    console.log('  MISSING:', [
      code !== 0 && 'opponent exited non-zero',
      stats.gamesPlayed !== 1 && 'no completed game',
      !noFailures && 'failures recorded',
      !resolved && 'GAME NOT SETTLED (or the bot did not take its cards back)',
    ].filter(Boolean).join('; '));
  }
  console.log(ok ? '\n  ✓ FULL CHAIN GAME COMPLETED (committed, proved, settled, imported)'
                 : '\n  ✗ chain path incomplete — see MISSING above');

  bot.stop();
  if (child.exitCode === null) child.kill();
  await new Promise<void>(r => server!.httpServer.close(() => r()));
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error('E2E FAILED:', e?.stack ?? e); process.exit(1); });
