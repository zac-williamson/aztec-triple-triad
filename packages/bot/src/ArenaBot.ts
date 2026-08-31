/**
 * The arena bot: a WebSocket client that plays like any other player.
 *
 * It deliberately uses the SAME protocol a browser uses — REGISTER_BOT only
 * marks it for disclosure and metrics, it grants no privileged moves. So the
 * relay, the rules engine and (from phase 3) the chain all treat it as an
 * ordinary opponent, which is what "completely mimic a player" has to mean if
 * the demo is to be honest.
 *
 * State machine: idle → queued → playing → idle.
 *
 *   idle    poll /queue; if a human has waited past joinThresholdMs and we have
 *           a free slot, queue ourselves and let the server's normal tryMatch
 *           pair us. We never reach into matchmaking directly.
 *   queued  waiting for MATCH_FOUND. Bounded by queueTimeoutMs: if the human
 *           cancels just as we queue, an un-timed-out bot would sit in the queue
 *           and instantly grab the NEXT human, which is exactly the behaviour
 *           this feature is supposed to avoid.
 *   playing drive our own turns from GAME_STATE; ignore the opponent's.
 */
import WebSocket from 'ws';
import { chooseBotMove } from '@axolotl-arena/game-logic';
import type { GameState, Player } from '@axolotl-arena/game-logic';
import type { ArenaBotConfig } from './config.js';

/** The slice of BotProofs the bot uses — narrowed so tests can fake it. */
export interface BotProofsLike {
  cardCommitHash(cardIds: number[], blindingFactor: string): Promise<string>;
  verificationKeys(): Promise<{ handVk: Uint8Array; moveVk: Uint8Array }>;
  proveHand(inputs: { cardIds: number[]; blindingFactor: string; opponentRandomness: string[] }): Promise<any>;
  proveMove(args: any): Promise<any>;
}

/** The slice of BotChain the bot uses — narrowed so tests can fake it. */
/**
 * How long we keep waiting for a winner to hand back our cards. Generous: their
 * settlement is an eleven-proof recursive verification plus inclusion, and a
 * forgotten entry costs us four cards permanently.
 */
const RETURN_WAIT_MS = 60 * 60_000;

/**
 * How long to wait for the opponent's hand proof before declining to commit.
 * Generous: it is a client-side proof over a hand they already hold, so it
 * takes seconds, and the cost of giving up early is a game that could have
 * been played.
 */
const HAND_PROOF_WAIT_MS = 3 * 60_000;

/** Game ids are 62 hex chars; logs stay readable with the first few. */
const short = (id: unknown): string =>
  typeof id === 'string' ? `${id.slice(0, 10)}…` : String(id);

export interface BotChainLike {
  readonly address: string;
  readonly nodeClient?: any;
  selectHand(size?: number): Promise<number[]>;
  /** Fee Juice balance; the bot pays its own transaction fees. */
  readFeeJuice?(): Promise<bigint>;
  /** Cards the PXE can currently see. The only honest check that an import
   *  worked: import_note swallows per-note failures. Cached — pass force to
   *  pay for a fresh page-through. */
  readCards(opts?: { force?: boolean }): Promise<number[]>;
  /** Drop the card cache; call whenever cards have moved. */
  invalidateCards?(): void;
  pxe: any;
}

export type BotState = 'idle' | 'queued' | 'playing';

export interface BotStats {
  state: BotState;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  joinFailures: number;
  moveFailures: number;
  /** Card-commit (create_game/join_game) failures. Chain mode only. */
  commitFailures: number;
  /** Proof-generation failures. Chain mode only. */
  proofFailures: number;
  /** Settlement failures, and successful settlements. Chain mode only. */
  settleFailures: number;
  settlements: number;
  /** On-chain id of the game just played, so callers can verify it independently. */
  lastOnChainGameId: string | null;
  /** Games abandoned by the watchdog, and cards left locked in them. */
  abandonedGames: number;
  cardsStranded: number;
  /**
   * Cards the bot could field at its last hand selection, or -1 off-chain.
   * The number to alert on: it is what predicts the bot going idle, and an
   * idle bot looks exactly like a quiet night.
   */
  spendableCards: number;
  /**
   * Cards that are the bot's on-chain but which its PXE cannot see, because an
   * import failed. Every one is a card it can never field again, so this is a
   * loss counter, not a warning.
   */
  cardsUnimported: number;
  /**
   * Fee Juice at the last hand selection, as a decimal string (it exceeds
   * Number's safe range), or "-1" if never read. The bot pays its own fees;
   * empty means it plays whole games it then cannot settle.
   */
  feeJuice: string;
  lastError: string | null;
}

export interface QueueSnapshot {
  length: number;
  oldestWaitMs: number;
  /** Humans waiting, and bots already offering. Absent on an older relay. */
  humansWaiting?: number;
  botsQueued?: number;
  entries: { playerId: string; queuedAt: number; waitMs: number }[];
}

type Logger = (msg: string) => void;

export interface ArenaBotDeps {
  /**
   * Chain adapter. OPTIONAL: without it the bot plays the off-chain relay game
   * only (what the unit and integration tests exercise). With it, the bot also
   * commits its cards on-chain like any player.
   */
  chain?: BotChainLike;
  /**
   * Persists each committed game's transcript so it can be recovered if this
   * process dies. Optional: without it the bot plays identically but a wedged
   * game strands its five cards for good.
   */
  journal?: {
    read(id: string): any;
    write(rec: any): void;
    forget(id: string): void;
    markSettled(id: string): void;
  };
  /** Proof generator. Required alongside `chain`; ignored without it. */
  proofs?: BotProofsLike;
  /** Injected for tests; defaults to a real ws client. */
  connect?: (url: string) => WebSocket;
  /** Injected for tests; defaults to fetch. */
  fetchQueue?: (httpUrl: string) => Promise<QueueSnapshot>;
  log?: Logger;
  now?: () => number;
}

export class ArenaBot {
  private ws: WebSocket | null = null;
  private state: BotState = 'idle';
  private gameId: string | null = null;
  private myPlayer: Player | null = null;
  private queuedAt = 0;
  private hand: number[] = [];
  /** on-chain game ids already committed, so a repeated relay message cannot double-send. */
  private readonly committedGameIds = new Set<string>();
  /** Preview data for the current game — needed as private proof inputs. */
  private blindingFactor: string | null = null;
  private myRandomness: string[] | null = null;
  /** The opponent's blinding factor, relayed at game over. Settlement cannot
   *  prove their card ids without it. */
  private opponentBlinding: string | null = null;
  private opponentRandomness: string[] | null = null;
  private myCardCommit: string | null = null;
  private opponentCardCommit: string | null = null;
  private handProofSent = false;
  /** Suppresses repeat logging of a persistent card shortage. */
  private handShortageLogged = false;
  /** When the current game started, for the stuck-game watchdog. */
  private gameStartedAt = 0;
  /**
   * When the relay told us the opponent's socket dropped, or null while they
   * are present. The stuck-game watchdog is a timer for SILENCE — it cannot
   * tell a slow player from a departed one, so it has to be generous. A
   * disconnect is not silence: the relay saw it happen and says so, and with
   * one bot every minute spent waiting is a minute the arena has no opponent
   * for anybody.
   */
  private opponentGoneSince: number | null = null;
  /** True once OUR cards are committed on-chain. Gates play in chain mode. */
  private committed = false;
  /**
   * Latest state seen for the current game. The commit gate drops states that
   * arrive before we are committed, and the relay sends a new one only when
   * somebody MOVES — so without replaying the last state after committing, a
   * bot whose turn arrived during its commit waits forever for a message that
   * will never come. That deadlock cost a 30-minute sandbox run.
   */
  private lastState: GameState | null = null;
  /** Our in-flight move, kept so the proof can bind the before/after transition. */
  private pendingMove: {
    moveNumber: number; cardId: number; row: number; col: number;
    boardBefore: GameState['board']; scoresBefore: [number, number];
  } | null = null;
  /** The settlement transcript, gathered from BOTH players over the relay. */
  private myHandProof: any = null;
  private opponentHandProof: any = null;
  private readonly moveProofs = new Map<string, any>();
  private opponentAddress: string | null = null;
  private opponentCardIds: number[] = [];
  private onChainGameId: string | null = null;
  private settling = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private registered = false;

  private readonly stats: BotStats = {
    state: 'idle', gamesPlayed: 0, wins: 0, losses: 0, draws: 0,
    joinFailures: 0, moveFailures: 0, commitFailures: 0, proofFailures: 0, settleFailures: 0, settlements: 0,
    lastOnChainGameId: null, abandonedGames: 0, cardsStranded: 0, spendableCards: -1,
    cardsUnimported: 0, feeJuice: '-1', lastError: null,
  };

  private readonly chain: BotChainLike | null;
  private readonly proofs: BotProofsLike | null;
  private readonly connect: (url: string) => WebSocket;
  private readonly fetchQueue: (httpUrl: string) => Promise<QueueSnapshot>;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly cfg: ArenaBotConfig, deps: ArenaBotDeps = {}) {
    this.chain = deps.chain ?? null;
    this.journal = deps.journal ?? null;
    this.proofs = deps.proofs ?? null;
    this.connect = deps.connect ?? ((url: string) => new WebSocket(url));
    this.fetchQueue = deps.fetchQueue ?? defaultFetchQueue;
    this.log = deps.log ?? ((m: string) => console.log(`[arena-bot] ${m}`));
    this.now = deps.now ?? (() => Date.now());
  }

  getStats(): BotStats {
    return { ...this.stats, state: this.state };
  }

  start(): void {
    this.stopped = false;
    this.openSocket();
    // Publish the consumables immediately rather than waiting for the first
    // match: a bot that has not been matched since restart was reporting -1 for
    // both, so the health probe passed while blind to the two numbers that end
    // the arena.
    void this.refreshConsumables();
    this.pollTimer = setInterval(() => {
      void this.tick().catch(err => this.recordError('poll', err));
    }, this.cfg.pollIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  private openSocket(): void {
    const ws = this.connect(this.cfg.wsUrl);
    this.ws = ws;
    // NOTE: do NOT register on 'open'. The server assigns the playerId and
    // establishes the session asynchronously, so a frame sent immediately after
    // the socket opens can arrive before this connection has an identity and be
    // dropped. Wait for SESSION_ESTABLISHED, exactly as the browser client does.
    ws.on('open', () => this.log('connected; awaiting session'));
    ws.on('message', (raw: WebSocket.RawData) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); }
      catch { return this.recordError('parse', new Error('non-JSON frame')); }
      this.handle(msg);
    });
    ws.on('close', () => {
      this.registered = false;
      // A dropped socket mid-game loses the game; reset so we do not wedge in
      // 'playing' forever waiting for a GAME_OVER that can no longer arrive.
      if (this.state !== 'idle') this.log(`socket closed while ${this.state}; resetting to idle`);
      this.resetToIdle();
      if (!this.stopped) setTimeout(() => this.openSocket(), this.cfg.pollIntervalMs);
    });
    ws.on('error', err => this.recordError('socket', err as Error));
  }

  /** One poll: decide whether to offer ourselves as an opponent. */
  private async tick(): Promise<void> {
    if (this.stopped || !this.registered) return;

    // Stuck-game watchdog. An opponent who never joins, or vanishes mid-game,
    // would otherwise park us in `playing` forever — taking no further players
    // and leaving our five committed cards stranded.
    if (this.state === 'playing' && this.gameStartedAt > 0
        && this.now() - this.gameStartedAt > this.cfg.gameTimeoutMs) {
      this.abandonGame(`game exceeded ${Math.round(this.cfg.gameTimeoutMs / 60_000)}min`);
      return;
    }

    // A departure the relay already witnessed. Same ending as the watchdog's,
    // reached in a minute and a half instead of thirty.
    if (this.state === 'playing' && !this.settling && this.opponentGoneSince !== null
        && this.now() - this.opponentGoneSince > this.cfg.opponentGraceMs) {
      this.abandonGame('opponent disconnected and did not come back');
      return;
    }

    if (this.state === 'queued' && this.now() - this.queuedAt > this.cfg.queueTimeoutMs) {
      this.log('queue timeout; leaving the queue');
      this.send({ type: 'CANCEL_MATCHMAKING' });
      this.resetToIdle();
      return;
    }
    if (this.state !== 'idle') return;

    const snap = await this.fetchQueue(this.cfg.httpUrl);
    // Re-check: a MATCH_FOUND can land WHILE the /queue fetch is in flight, and
    // queueing again then gets rejected "You are already in an active game" —
    // which the ERROR path treats as a join failure and resets us out of a game
    // we are actually in.
    if (this.state !== 'idle') return;
    // Only our own entry in the queue means there is nobody to rescue.
    if (snap.length === 0) return;
    if (snap.oldestWaitMs < this.cfg.joinThresholdMs) return;

    // Do not stampede. Every bot in the pool polls this same endpoint and sees
    // the same waiting player, so without this they ALL queue for one person:
    // the extras then sit in the queue holding five committed cards each, doing
    // nothing, until they time out. One bot per waiting human is the whole
    // requirement. (Older relays omit these fields; then a single bot is
    // assumed, which is what the pool-less deployment actually is.)
    if (snap.botsQueued !== undefined && snap.humansWaiting !== undefined) {
      if (snap.botsQueued >= snap.humansWaiting) return;
    }

    // In chain mode the hand must come from what the bot ACTUALLY holds — its
    // collection shrinks every time a player beats it, so a configured static
    // hand would eventually name cards it no longer owns and fail at commit.
    let hand = this.cfg.handCardIds;
    if (this.chain) {
      try {
        hand = await this.chain.selectHand(5);
        this.stats.spendableCards = (this.chain as { lastKnownCardCount?: number }).lastKnownCardCount ?? -1;
        // Same cadence as the card count: both are things that end the arena
        // quietly when they hit zero, and both are cheap to read here.
        await (this.chain as { readFeeJuice?: () => Promise<bigint> }).readFeeJuice?.()
          .then(v => { this.stats.feeJuice = v.toString(); })
          .catch(() => { /* a failed read must not stop the bot queueing */ });
        this.handShortageLogged = false;
      } catch (err) {
        // This condition persists until someone re-provisions, and tick() runs
        // every pollIntervalMs — so log it ONCE per episode rather than several
        // times a second. The stat still counts every occurrence.
        this.stats.joinFailures += 1;
        if (!this.handShortageLogged) {
          this.handShortageLogged = true;
          this.recordError('select-hand', err as Error);
        } else {
          this.stats.lastError = `select-hand: ${(err as Error).message}`;
        }
        return;
      }
    }

    // selectHand() is async too — same hazard.
    if (this.state !== 'idle') return;

    this.log(`human waiting ${Math.round(snap.oldestWaitMs / 1000)}s — offering a game`);
    this.state = 'queued';
    this.queuedAt = this.now();
    this.hand = hand;
    this.send({ type: 'QUEUE_MATCHMAKING', cardIds: hand });
  }

  private handle(msg: any): void {
    switch (msg?.type) {
      case 'SESSION_ESTABLISHED':
        this.log('session established; registering as bot');
        this.send({ type: 'REGISTER_BOT', token: this.cfg.token });
        break;

      case 'BOT_REGISTERED':
        this.registered = true;
        this.log('registered with the relay');
        break;

      case 'MATCH_FOUND':
        // The bot JOINS games; it never creates them. The server orders the
        // pair so a bot is never the creator, but if that ever failed we must
        // not silently start creating games and wagering cards as player 1 —
        // leave immediately and let a human take the slot.
        if (msg.playerNumber === 1) {
          this.stats.joinFailures += 1;
          this.recordError('match', new Error('assigned as game CREATOR — the bot only joins; leaving'));
          this.send({ type: 'CANCEL_GAME', gameId: msg.gameId });
          this.resetToIdle();
          break;
        }
        this.gameId = msg.gameId;
        this.myPlayer = msg.playerNumber === 1 ? 'player1' : 'player2';
        this.state = 'playing';
        this.gameStartedAt = this.now();
        // One skill for the whole game. Re-rolling per move would make the bot
        // alternate between brilliant and careless within a single game, which
        // reads as broken rather than as a weaker opponent.
        this.gameSkill = this.rollSkill();
        this.log(`matched into ${msg.gameId} as ${this.myPlayer} (skill ${this.gameSkill.toFixed(2)})`);
        this.maybeMove(msg.gameState);
        break;

      case 'OPPONENT_AZTEC_INFO':
        // Announce what arrived. Without this, an info share that is missing a
        // field — or that arrives for a game we have already left — is
        // indistinguishable from one that never came, and the bot simply never
        // joins while the player waits out the whole game.
        this.log(`opponent info for ${short(msg.gameId)}: ` +
          `addr=${msg.aztecAddress ? 'yes' : 'no'} onChainId=${msg.onChainGameId ? 'yes' : 'no'} ` +
          `randomness=${Array.isArray(msg.gameRandomness) ? msg.gameRandomness.length : 'no'}` +
          (msg.gameId === this.gameId ? '' : `  IGNORED (our game is ${short(this.gameId)})`));
        if (this.chain && msg.gameId === this.gameId) {
          // Record each field independently: they are optional on the wire, and
          // coupling the id to the randomness meant a share without randomness
          // left P2 with no game to join.
          if (msg.aztecAddress) this.opponentAddress = String(msg.aztecAddress);
          if (msg.onChainGameId) {
            this.onChainGameId = String(msg.onChainGameId);
            this.stats.lastOnChainGameId = this.onChainGameId;
          }
          if (Array.isArray(msg.gameRandomness)) {
            this.opponentRandomness = msg.gameRandomness as string[];
            // The hand proof binds the OPPONENT's randomness, so it cannot run
            // until they have shared it.
            void this.maybeProveHand().catch(err => {
              this.stats.proofFailures += 1;
              this.recordError('prove-hand', err as Error);
            });
          }
        }
        // P2 records the id here but does NOT join yet — see ON_CHAIN_STATUS.
        break;

      case 'ON_CHAIN_STATUS':
        // join_game asserts the game is in `created` state, so P2 must wait for
        // P1's create_game to be CONFIRMED — not merely for the id to be shared.
        // P1 shares the id EARLY (before its tx mines) so P2 can prepare, and
        // joining on that share alone races the chain and fails
        // "Game not in created state".
        if (this.chain && this.myPlayer === 'player2' && msg.gameId === this.gameId
            && msg.status?.player1Tx === 'confirmed' && this.onChainGameId) {
          this.log(`player 1 confirmed on-chain — joining ${short(this.onChainGameId)}`);
          void this.commitAsPlayer2(msg.gameId, this.onChainGameId).catch(err => {
            this.stats.commitFailures += 1;
            this.recordError('commit-join', err as Error);
          });
        } else if (this.myPlayer === 'player2' && msg.gameId === this.gameId && !this.committed) {
          // Say WHY we are not joining. This condition failing silently is what
          // let a production game sit at move zero for eighteen minutes: every
          // message had arrived and been handled, and nothing said which term
          // was false.
          const missing = [
            !this.chain && 'chain mode off',
            msg.status?.player1Tx !== 'confirmed' && `player1Tx=${msg.status?.player1Tx ?? 'absent'}`,
            !this.onChainGameId && 'no on-chain game id yet',
          ].filter(Boolean).join(', ');
          if (missing) this.log(`not joining yet: ${missing}`);
        }
        break;

      case 'GAME_START':
      case 'GAME_STATE':
        if (msg.gameId === this.gameId) {
          // Prove OUR move first: the state that just arrived is its `after`.
          void this.maybeProveMove(msg.gameState).catch(err => {
            this.stats.proofFailures += 1;
            this.recordError('prove-move', err as Error);
          });
          this.maybeMove(msg.gameState);
        }
        break;

      // The relay holds a 60s window for a dropped player to resume their
      // session, so a blip is not a departure; we wait that out plus a margin
      // before giving up. Reconnecting cancels it outright.
      case 'OPPONENT_DISCONNECTED':
        if (this.state === 'playing' && !this.settling && this.opponentGoneSince === null) {
          this.opponentGoneSince = this.now();
          this.log(`opponent disconnected — giving them ` +
            `${Math.round(this.cfg.opponentGraceMs / 1000)}s to come back`);
        }
        break;

      case 'OPPONENT_RECONNECTED':
        if (this.opponentGoneSince !== null) {
          this.log(`opponent reconnected after ` +
            `${Math.round((this.now() - this.opponentGoneSince) / 1000)}s — carrying on`);
          this.opponentGoneSince = null;
        }
        break;

      case 'GAME_OVER': {
        if (msg.gameId !== this.gameId) break;
        this.stats.gamesPlayed += 1;
        if (msg.winner === 'draw') this.stats.draws += 1;
        else if (msg.winner === this.myPlayer) this.stats.wins += 1;
        else this.stats.losses += 1;
        this.log(`game over: ${msg.winner} (bot was ${this.myPlayer})`);
        // Share our blinding factor so whichever side settles can prove BOTH
        // players' card ids. Sent unconditionally, including when we lose: the
        // winner cannot settle without it, and a game nobody can settle leaves
        // both hands locked.
        if (this.blindingFactor && this.gameId) {
          this.send({ type: 'SHARE_BLINDING', gameId: this.gameId, blindingFactor: this.blindingFactor });
        }
        if (Array.isArray(msg.player1CardIds) && Array.isArray(msg.player2CardIds)) {
          this.opponentCardIds = this.myPlayer === 'player1' ? msg.player2CardIds : msg.player1CardIds;
          this.journalGame();
        }
        if (this.chain && this.proofs && this.shouldSettle(msg.winner)) {
          // Settle BEFORE resetting: the transcript lives in this game's state.
          void this.settle(msg.winner).catch(err => {
            this.stats.settleFailures += 1;
            this.recordError('settle', err as Error);
          }).finally(() => this.resetToIdle());
        } else {
          // Somebody else settles this one, which means somebody else owes us
          // the plaintexts for our returned cards. Remember it: we are about to
          // forget the game id, and their message can be minutes away.
          if (this.chain && this.gameId) this.expectReturnedNotes(this.gameId);
          this.resetToIdle();
        }
        break;
      }

      case 'HAND_PROOF':
        // The opponent's hand proof carries their card commitment, which our
        // move proofs must bind — and it is half of the settlement transcript.
        if (msg.gameId === this.gameId && msg.handProof?.cardCommit) {
          this.opponentCardCommit = String(msg.handProof.cardCommit);
          this.opponentHandProof = msg.handProof;
          this.journalGame();
          // We may have been holding our turn waiting for exactly this (see
          // maybeMove). Nothing else will re-trigger us: the relay only pushes
          // GAME_STATE on a move, and it is our move that is missing.
          this.maybeMove(this.lastState ?? undefined);
        }
        break;

      case 'OPPONENT_BLINDING':
        if (msg.gameId === this.gameId && typeof msg.blindingFactor === 'string') {
          this.opponentBlinding = msg.blindingFactor;
        }
        break;

      case 'NOTE_DATA':
        // We lost, and the winner has settled and handed our remaining cards
        // back. This is the ONLY way we ever see them again: they are minted
        // with offchain delivery, so nothing discovers them passively, and only
        // the settler can compute their randomness.
        //
        // Deliberately NOT gated on the current gameId. We reset to idle the
        // moment we lose, while the winner still has minutes of proving ahead
        // of it, so by the time this arrives `this.gameId` is null — and may
        // already belong to a different game. Matching against the games we are
        // still owed cards for is the only correct test.
        if (typeof msg.txHash === 'string' && Array.isArray(msg.notes) && this.isAwaitingReturn(msg.gameId)) {
          this.awaitingReturn.delete(String(msg.gameId));
          void this.importRelayedNotes(msg.txHash, msg.notes);
        }
        break;

      case 'MOVE_PROVEN':
        // The opponent's move proofs complete the 9-link chain.
        if (msg.gameId === this.gameId && msg.moveProof?.startStateHash) {
          this.moveProofs.set(String(msg.moveProof.startStateHash), msg.moveProof);
          this.journalGame();
        }
        break;

      case 'QUEUE_DECLINED':
        // The relay says other bots already cover everyone waiting. This is a
        // normal outcome of a pool, not a failure: go back to idle WITHOUT
        // touching joinFailures, or a healthy pool would report itself broken.
        if (this.state === 'queued') {
          this.log(msg.reason === 'nobody-waiting'
            ? 'stood down: the waiting player was matched before we got there'
            : `stood down: ${msg.botsQueued} bot(s) already cover ${msg.humansWaiting} waiting player(s)`);
          this.resetToIdle();
        }
        break;

      case 'ERROR':
        // A queue rejection must not strand us in 'queued'.
        this.recordError('server', new Error(String(msg.message)));
        if (this.state === 'queued') {
          this.stats.joinFailures += 1;
          this.resetToIdle();
        }
        break;

      default:
        break;
    }
  }

  /** P2's on-chain commit: join the game id P1 shared. */
  private async commitAsPlayer2(wsGameId: string, onChainGameId: string): Promise<void> {
    if (this.committedGameIds.has(onChainGameId)) return; // OPPONENT_AZTEC_INFO can repeat
    this.committedGameIds.add(onChainGameId);
    const chain = this.chain!;
    const { randomness, blindingFactor } = await chain.pxe.previewJoinGame(chain.address, onChainGameId);
    this.blindingFactor = blindingFactor;
    this.myRandomness = randomness;
    this.send({ type: 'SHARE_AZTEC_INFO', gameId: wsGameId, aztecAddress: chain.address, onChainGameId, gameRandomness: randomness });

    // Do not commit cards we could not get back.
    //
    // Recovering an abandoned game requires BOTH hand proofs — the claim binds
    // each side's committed hand — so a player who leaves before proving theirs
    // strands our five permanently. Two such games are locked for good.
    //
    // Sharing our randomness above is exactly what unblocks their hand proof
    // (they cannot build it without it), so waiting here cannot deadlock: we
    // have already given them everything they need. If it never comes we simply
    // never commit, and the watchdog resets a game in which nothing was at
    // stake — strictly better than holding cards nobody can ever release.
    if (!(await this.awaitOpponentHandProof(wsGameId))) {
      this.committedGameIds.delete(onChainGameId);
      this.log('no opponent hand proof — NOT committing, so nothing can be stranded');
      return;
    }

    this.log(`join_game: committing ${this.hand.join(',')} into ${onChainGameId.slice(0, 18)}…`);

    const txHash = await chain.pxe.sendJoinGame(chain.address, onChainGameId, this.hand, { node: chain.nodeClient, timeoutMs: this.cfg.chainTxTimeoutMs });
    if (this.gameId !== wsGameId) return;
    this.send({ type: 'TX_CONFIRMED', gameId: wsGameId, txType: 'join_game', txHash });
    this.committed = true;
    // Five cards are nullified by the join; the cached collection is now stale.
    (chain as { invalidateCards?: () => void }).invalidateCards?.();
    this.log(`join_game mined: ${txHash.slice(0, 18)}…`);
    // Our cards are locked from THIS moment. Journal before anything else can
    // fail, or a crash in the next few seconds strands them unrecoverably.
    this.journalGame();
    // Our turn may have arrived while we were committing.
    this.maybeMove(this.lastState ?? undefined);
    void this.maybeProveHand().catch(err => {
      this.stats.proofFailures += 1;
      this.recordError('prove-hand', err as Error);
    });
  }

  /**
   * Generate and submit the hand proof, once every input exists.
   *
   * Inputs arrive out of order — our own preview lands when our commit runs, the
   * opponent's randomness when they share it — so this is called from both paths
   * and simply no-ops until it has everything. Guarded by handProofSent so the
   * two callers cannot each submit one.
   */
  private async maybeProveHand(): Promise<void> {
    if (!this.chain || !this.proofs) return;
    if (this.handProofSent) return;
    if (!this.blindingFactor || !this.opponentRandomness || this.hand.length !== 5) return;

    const gameId = this.gameId;
    if (!gameId) return;
    this.handProofSent = true;

    // Snapshot every input BEFORE awaiting. resetToIdle() nulls these on
    // GAME_OVER, and proving is slow enough that a game ending mid-proof would
    // otherwise read a null blinding factor ("Cannot read properties of null").
    const cardIds = [...this.hand];
    const blindingFactor = this.blindingFactor;
    const opponentRandomness = [...this.opponentRandomness];

    this.myCardCommit = await this.proofs.cardCommitHash(cardIds, blindingFactor);
    const handProof = await this.proofs.proveHand({
      cardIds, blindingFactor, opponentRandomness,
    });
    if (this.gameId !== gameId) return; // game ended while proving
    this.myHandProof = handProof;
    this.send({ type: 'SUBMIT_HAND_PROOF', gameId, handProof });
    this.log('hand proof submitted');
    this.journalGame();
    // Symmetric with the HAND_PROOF handler: maybeMove holds our turn until
    // BOTH commitments are known, and either one can be the last to arrive.
    // Whichever completes second has to release the held turn, because the
    // relay pushes a new state only when somebody moves — and the move it is
    // waiting for is ours. Missing this half deadlocks the bot whenever the
    // opponent's hand proof beats our own.
    this.maybeMove(this.lastState ?? undefined);
  }

  /**
   * Prove the move we just made, using the snapshot taken before we sent it and
   * the state the relay echoed back.
   *
   * Only runs for OUR move: the opponent proves their own. Requires both card
   * commitments, since the circuit binds them — ours from our preview, theirs
   * from the hand proof they submitted.
   */
  private async maybeProveMove(after: GameState | undefined): Promise<void> {
    const pending = this.pendingMove;
    if (!this.chain || !this.proofs || !pending || !after || !this.myPlayer) return;
    // The echoed state must be EXACTLY the one produced by our move. A later
    // state is not merely redundant — the circuit asserts
    // board_after[cell].owner == current_player, and by a later move our card
    // may already have been captured, so the owner reads as the opponent and
    // the proof fails "Owner not set correctly".
    const occupied = after.board.flat().filter(c => c.card !== null).length;
    if (occupied !== pending.moveNumber + 1) return;
    if (!this.myCardCommit || !this.opponentCardCommit) {
      // Unreachable now that maybeMove holds the turn until both are known.
      // If it ever happens the game is already unsettleable, so say so loudly
      // rather than dropping the move proof in silence, which is how this cost
      // a full chain run.
      this.pendingMove = null;
      this.stats.proofFailures += 1;
      this.recordError('move-proof', new Error(
        `move ${pending.moveNumber} cannot be proved: card commitments missing ` +
        `(mine=${!!this.myCardCommit}, opponent=${!!this.opponentCardCommit}) — ` +
        `the transcript is now permanently incomplete`,
      ));
      return;
    }

    this.pendingMove = null;
    const gameId = this.gameId;
    // Snapshot before awaiting — resetToIdle() clears these on GAME_OVER.
    const blindingFactor = this.blindingFactor;
    const myCommit = this.myCardCommit;
    const oppCommit = this.opponentCardCommit;
    const currentPlayer: 1 | 2 = this.myPlayer === 'player1' ? 1 : 2;
    const ended = after.status === 'finished';
    const winnerId = !ended ? 0 : after.winner === 'player1' ? 1 : after.winner === 'player2' ? 2 : 3;

    const moveProof = await this.proofs.proveMove({
      cardId: pending.cardId, row: pending.row, col: pending.col, currentPlayer,
      boardBefore: pending.boardBefore, boardAfter: after.board,
      scoresBefore: pending.scoresBefore,
      scoresAfter: [after.player1Score, after.player2Score],
      cardCommit1: currentPlayer === 1 ? myCommit : oppCommit,
      cardCommit2: currentPlayer === 1 ? oppCommit : myCommit,
      gameEnded: ended, winnerId,
      playerHandData: { cardIds: [...this.hand], blindingFactor, handIndex: 0 },
    });
    if (this.gameId !== gameId || !gameId) return;
    // Key by the chain link, not the move number: sortProofChain orders the
    // transcript by state hash, and duplicates from a relay replay must collapse.
    this.moveProofs.set(String(moveProof.startStateHash), moveProof);
    this.journalGame();
    this.send({
      type: 'SUBMIT_MOVE_PROOF', gameId,
      handIndex: 0, row: pending.row, col: pending.col,
      moveNumber: pending.moveNumber, moveProof,
    });
    this.log(`move proof ${pending.moveNumber} submitted`);
  }

  /**
   * Who sends process_game.
   *
   * A win: the winner settles, claiming a card. A DRAW is single-settler —
   * player 1 alone fires process_game(winner_id=3), which re-mints both hands;
   * player 2 must send nothing or its tx reverts (see the draw-settlement path
   * in tests/draw-game.spec.ts). A loss: the winner settles, we just wait.
   */
  /**
   * A draw is settled by ONE player, by convention player 1 — the contract
   * accepts either (`settle_game_draw`: "For draws, caller could be either
   * player"), but both settling at once wastes a recursive proof and reverts.
   *
   * The bot is ALWAYS player 2, so that convention alone means a draw against
   * the bot settles only if the human stays to do it. If they close the tab,
   * both hands stay locked — and the abandonment sweep cannot rescue this one:
   * a completed draw has all 9 move proofs, and the claim requires 1..8. So the
   * bot settles draws too, but only as a FALLBACK, after giving player 1 time
   * to do it (see settle()).
   */
  private shouldSettle(winner: string): boolean {
    if (winner === 'draw') return true;
    return winner === this.myPlayer;
  }

  /**
   * Assemble the 11-proof transcript and send process_game.
   *
   * Uses the SAME buildProcessGameArgs the browser uses: the argument list is
   * flat and order-critical, and a wrong order is only rejected on-chain after
   * the expensive recursive verification.
   */
  private async settle(winner: string): Promise<void> {
    if (this.settling) return;
    this.settling = true;
    const chain = this.chain!, proofs = this.proofs!;

    // Draw fallback: player 1 settles by convention, so stand back and only step
    // in if they did not. Checked against the CHAIN, not a timer alone — the
    // human may have settled at any point during the wait, and settling an
    // already-settled game burns a recursive proof to earn a revert.
    if (winner === 'draw' && this.myPlayer !== 'player1') {
      this.log(`draw — giving player 1 ${Math.round(this.cfg.drawFallbackMs / 1000)}s to settle`);
      await new Promise(r => setTimeout(r, this.cfg.drawFallbackMs));
      const gameId = this.onChainGameId;
      if (!gameId) return;
      try {
        const status = await chain.pxe.readGameStatus(chain.address, gameId);
        if (status !== 2) {   // 2 = active; anything else means it is resolved
          this.log(`draw already settled by player 1 (status ${status}) — standing down`);
          return;
        }
      } catch (err) {
        // If we cannot read the status, settling anyway is the safer error: a
        // duplicate settle reverts and costs a proof, while skipping it can
        // strand ten cards permanently.
        this.log(`could not read game status (${(err as Error).message}) — settling the draw anyway`);
      }
      this.log('player 1 did not settle the draw — settling it ourselves');
    }


    // Wait for the transcript to complete before judging it. Moves are relayed
    // on PLACE_CARD, but proving each one is slow, so GAME_OVER routinely
    // arrives with our own move proofs still generating. The browser waits for
    // `canSettle` for exactly this reason; failing immediately here would call
    // a merely-slow transcript a broken one.
    const deadline = this.now() + this.cfg.settleWaitMs;
    while (this.now() < deadline) {
      const complete = this.myHandProof && this.opponentHandProof && this.moveProofs.size >= 9;
      if (complete) break;
      await new Promise(r => setTimeout(r, 500));
    }

    const missing: string[] = [];
    if (!this.myHandProof) missing.push('own hand proof');
    if (!this.opponentHandProof) missing.push('opponent hand proof');
    if (!this.onChainGameId) missing.push('on-chain game id');
    if (!this.opponentAddress) missing.push('opponent address');
    if (!this.myRandomness || !this.opponentRandomness) missing.push('randomness');
    if (!this.blindingFactor) missing.push('own blinding factor');
    if (!this.opponentBlinding) missing.push('opponent blinding factor');
    if (this.moveProofs.size < 9) missing.push(`${9 - this.moveProofs.size} move proof(s)`);
    if (missing.length) {
      // Fail loudly with WHAT is missing: an incomplete transcript otherwise
      // surfaces as an opaque on-chain revert.
      throw new Error(`cannot settle — transcript incomplete: ${missing.join(', ')}`);
    }

    const { handVk, moveVk } = await proofs.verificationKeys();
    const { Fr } = await import('@aztec/aztec.js/fields');
    const { AztecAddress } = await import('@aztec/aztec.js/addresses');
    const { buildProcessGameArgs } = await import('../../frontend/src/aztec/settlementArgs.js');

    // On a draw no card changes hands (winner_id=3 re-mints both), so 0.
    const selectedCardId = winner === 'draw' ? 0 : (this.opponentCardIds[0] ?? 0);
    const iAmPlayer1 = this.myPlayer === 'player1';

    const args = await buildProcessGameArgs({
      Fr, AztecAddress,
      onChainGameId: this.onChainGameId!,
      handVk, moveVk,
      handProof1: iAmPlayer1 ? this.myHandProof : this.opponentHandProof,
      handProof2: iAmPlayer1 ? this.opponentHandProof : this.myHandProof,
      moveProofs: [...this.moveProofs.values()],
      opponentAddress: this.opponentAddress!,
      selectedCardId,
      myCardIds: this.hand,
      opponentCardIds: this.opponentCardIds,
      myRandomness: this.myRandomness!,
      opponentRandomness: this.opponentRandomness!,
      myBlinding: this.blindingFactor!,
      opponentBlinding: this.opponentBlinding!,
    });

    this.log(`settling ${winner === 'draw' ? '(draw, single settler)' : `(claiming card ${selectedCardId})`}…`);
    const txHash = await chain.pxe.sendProcessGame(chain.address, args, { node: chain.nodeClient, timeoutMs: this.cfg.chainTxTimeoutMs });
    this.stats.settlements += 1;
    this.log(`settled on-chain: ${String(txHash).slice(0, 18)}…`);

    // Hand the loser back the plaintexts for THEIR returned cards.
    //
    // process_game re-mints the loser's non-wagered cards, but as untagged
    // notes their PXE cannot discover on its own (ground rule 9) — only the
    // settler can compute the randomness, so only the settler can tell them.
    // A human winner does this (useGameSettlement relayNoteData); the bot did
    // not, so anyone who LOST to the bot watched "Opponent is settling…"
    // forever and never got four of their five cards back. Losing one card is
    // the game; losing the hand is a bug.
    this.relayReturnedNotes(String(txHash), selectedCardId, winner);
    // Take our OWN cards back into the PXE. process_game re-mints them with
    // create_and_push_note + offchain delivery, which nothing discovers
    // passively (ground rule 9) — settling without this silently burned all
    // five every game, win or lose.
    await this.importOwnReturnedCards(chain, String(txHash), selectedCardId, winner);
    // Marked settled rather than deleted. The entry exists to mark cards as
    // locked, and settled cards are not locked — but the record is also the
    // only surviving copy of this game's randomness, which is what recovering
    // a failed import needs. Deleting it is how forty cards became
    // unrecoverable rather than merely unimported.
    if (this.onChainGameId) this.journal?.markSettled(this.onChainGameId);
  }

  /**
   * Skill for the current game, drawn at match time from the configured range.
   * 1 until a game starts, so anything that plays outside a match plays well.
   */
  private gameSkill = 1;

  /**
   * Read the two consumables once at startup.
   *
   * They were refreshed only when the bot picked a hand, so a bot that had not
   * been matched since its last restart reported "-1 spendable, -1 FJ" — the
   * health probe went green while saying nothing about the two numbers that
   * actually end the arena. BotChain already knows the card count by the time
   * it is connected; this just publishes it.
   */
  private async refreshConsumables(): Promise<void> {
    const chain = this.chain as (BotChainLike & { lastKnownCardCount?: number }) | null;
    if (!chain) return;
    try {
      const held = await chain.readCards({ force: true });
      this.stats.spendableCards = held.length;
    } catch { /* a failed read must not stop the bot starting */ }
    try {
      const fj = await chain.readFeeJuice?.();
      if (fj !== undefined) this.stats.feeJuice = fj.toString();
    } catch { /* likewise */ }
  }

  /** Uniform in [skillMin, skillMax]. */
  private rollSkill(): number {
    const { skillMin, skillMax } = this.cfg;
    return skillMin + Math.random() * (skillMax - skillMin);
  }

  /**
   * Games we lost (or drew and did not settle) whose returned cards are still
   * owed to us, mapped to when we stop waiting. Bounded and expiring, because
   * an opponent who never settles must not leak an entry per game forever.
   */
  private readonly awaitingReturn = new Map<string, number>();

  private expectReturnedNotes(gameId: string): void {
    this.pruneAwaitingReturn();
    this.awaitingReturn.set(gameId, this.now() + RETURN_WAIT_MS);
  }

  private isAwaitingReturn(gameId: unknown): boolean {
    this.pruneAwaitingReturn();
    return typeof gameId === 'string' && this.awaitingReturn.has(gameId);
  }

  private pruneAwaitingReturn(): void {
    const now = this.now();
    for (const [id, deadline] of this.awaitingReturn) {
      if (deadline <= now) this.awaitingReturn.delete(id);
    }
  }

  /**
   * Wait for the opponent's hand proof, which recovery will need.
   *
   * Bounded: an opponent who never proves is one we never commit against, and
   * the watchdog tidies up an empty game soon enough.
   */
  private async awaitOpponentHandProof(wsGameId: string): Promise<boolean> {
    const deadline = this.now() + HAND_PROOF_WAIT_MS;
    while (this.now() < deadline) {
      if (this.gameId !== wsGameId) return false;   // game moved on without us
      if (this.opponentHandProof) return true;
      await new Promise(r => setTimeout(r, 1000));
    }
    return false;
  }

  /**
   * Re-import the cards process_game just minted back to us.
   *
   * Both mint paths use create_and_push_note with offchain delivery, so NOTHING
   * discovers these passively — not the settler, not the opponent. The frontend
   * winner has always done this ("Winner import"); the bot never did, so every
   * settled game removed its five committed cards from view permanently. At
   * five a game that is the arena's whole card supply on a timer.
   *
   * Win : our five at randomness[0..4], plus the claimed card at randomness[5]
   *       (mint_for_game_winner takes a [Field; 6] in exactly that order).
   * Draw: our five at randomness[0..4]; nothing changes hands.
   */
  private async importOwnReturnedCards(
    chain: BotChainLike,
    txHash: string,
    selectedCardId: number,
    winner: string,
  ): Promise<void> {
    const randomness = this.myRandomness;
    if (!randomness || this.hand.length < 5) {
      this.stats.cardsUnimported += this.hand.length;
      this.log(`WARNING: cannot re-import our own cards for ${txHash.slice(0, 18)}… ` +
        `(no randomness) — ${this.hand.length} card(s) are ours on-chain but invisible`);
      return;
    }
    const notes = this.hand.slice(0, 5).map((tokenId, i) => ({
      tokenId, randomness: String(randomness[i]),
    }));
    if (winner !== 'draw' && selectedCardId !== 0) {
      notes.push({ tokenId: selectedCardId, randomness: String(randomness[5]) });
    }
    try {
      const { fetchTxEffectData } = await import('../../frontend/src/aztec/noteImporter.js');
      const txEffect = await fetchTxEffectData(chain.nodeClient as never, txHash);
      if (!txEffect) {
        this.stats.cardsUnimported += notes.length;
        this.log(`WARNING: no TxEffect for ${txHash.slice(0, 18)}… — ${notes.length} card(s) ` +
          `are ours on-chain but the PXE cannot see them`);
        return;
      }
      const held = await chain.readCards();
      await chain.pxe.importCardNotes(chain.address, txHash, notes, 'settlement return', txEffect);
      // import_note swallows per-note failures, so the only honest check is
      // whether the wallet can actually see more cards afterwards. Cards have
      // definitely moved, so this read must not come from the cache.
      chain.invalidateCards?.();
      const after = await chain.readCards({ force: true });
      const gained = after.length - held.length;
      if (gained < notes.length) {
        this.stats.cardsUnimported += notes.length - gained;
        this.log(`WARNING: imported ${gained}/${notes.length} returned card(s) — ` +
          `${notes.length - gained} are ours on-chain but invisible`);
      } else {
        this.log(`re-imported ${notes.length} returned card(s); now holding ${after.length}`);
      }
    } catch (err) {
      this.stats.cardsUnimported += notes.length;
      this.log(`WARNING: re-import of our own cards failed: ${(err as Error).message}`);
    }
  }

  /**
   * Import the cards the WINNER handed back to us after they settled.
   *
   * The mirror of relayReturnedNotes: when we lose, only the settler can
   * compute the randomness for our returned cards, so this message is the only
   * way we ever see them again.
   */
  private async importRelayedNotes(
    txHash: string,
    notes: { tokenId: number; randomness: string }[],
  ): Promise<void> {
    const chain = this.chain;
    if (!chain || notes.length === 0) return;
    try {
      const { fetchTxEffectData } = await import('../../frontend/src/aztec/noteImporter.js');
      const txEffect = await fetchTxEffectData(chain.nodeClient as never, txHash);
      if (!txEffect) {
        this.stats.cardsUnimported += notes.length;
        this.log(`WARNING: no TxEffect for relayed notes ${txHash.slice(0, 18)}… — ` +
          `${notes.length} card(s) invisible`);
        return;
      }
      const held = await chain.readCards();
      await chain.pxe.importCardNotes(chain.address, txHash, notes, 'opponent settlement', txEffect);
      chain.invalidateCards?.();
      const after = await chain.readCards({ force: true });
      const gained = after.length - held.length;
      if (gained < notes.length) {
        this.stats.cardsUnimported += notes.length - gained;
        this.log(`WARNING: imported ${gained}/${notes.length} relayed card(s)`);
      } else {
        this.log(`imported ${notes.length} card(s) returned by the winner; now holding ${after.length}`);
      }
    } catch (err) {
      this.stats.cardsUnimported += notes.length;
      this.log(`WARNING: import of relayed notes failed: ${(err as Error).message}`);
    }
  }

  /**
   * Send the loser the notes for the cards coming back to them.
   *
   * Mirrors the frontend winner's payload exactly: every opponent card except
   * the one claimed, paired with the randomness for that slot. On a draw
   * nothing is claimed and all five go back.
   *
   * Best-effort by design — the settlement is already on-chain and must not be
   * undone by a socket that closed. A failure here is logged, not thrown.
   */
  private relayReturnedNotes(txHash: string, selectedCardId: number, winner: string): void {
    const gameId = this.gameId;
    const randomness = this.opponentRandomness;
    if (!gameId || !randomness) {
      this.log('WARNING: cannot relay returned notes (no game id or opponent randomness) — ' +
        'the loser will not be able to import their cards');
      return;
    }
    try {
      const notes: { tokenId: number; randomness: string }[] = [];
      let removed = false;
      for (let i = 0; i < this.opponentCardIds.length && i < 5; i++) {
        // Skip exactly ONE copy of the claimed card: a hand may hold duplicates,
        // and dropping both would keep a card the loser still owns.
        if (winner !== 'draw' && this.opponentCardIds[i] === selectedCardId && !removed) {
          removed = true;
          continue;
        }
        notes.push({ tokenId: this.opponentCardIds[i], randomness: String(randomness[i]) });
      }
      this.send({ type: 'RELAY_NOTE_DATA', gameId, txHash, notes });
      this.log(`relayed ${notes.length} returned card note(s) to the loser`);
    } catch (err) {
      this.log(`WARNING: failed to relay returned notes: ${(err as Error).message}`);
    }
  }

  /** Play if, and only if, it is our turn in a live game. */
  private maybeMove(state: GameState | undefined): void {
    if (state) this.lastState = state;
    if (!state || this.state !== 'playing' || !this.myPlayer) return;
    if (state.status !== 'playing') return;
    if (state.currentTurn !== this.myPlayer) return;
    // In chain mode, do not play until OUR cards are committed. A move proof
    // binds the card commitment, so moving first would prove against a
    // commitment that does not exist yet — and lets the relay game finish
    // before the chain has caught up, leaving nothing to settle.
    if (this.chain && !this.committed) return;
    // Nor until we know BOTH card commitments. A move proof binds cardCommit1
    // AND cardCommit2, so a card played before the opponent's hand proof
    // arrives cannot be proved — and because the proof needs the EXACT
    // post-move board, it can never be caught up afterwards either: by the next
    // state our card may already be captured. ONE unprovable move makes the
    // whole game unsettleable, so waiting is strictly better than moving.
    // Gated on `proofs`, not `chain`: the constraint comes from the move proof
    // that will have to bind these commitments, so a bot with no prover has
    // nothing to invalidate by moving early.
    if (this.chain && this.proofs && (!this.myCardCommit || !this.opponentCardCommit)) return;

    // One move per turn, however many callers reach here (see moveScheduledFor).
    // Checked BEFORE choosing: chooseBotMove is not deterministic under
    // difficulty 'random', so a duplicate call would pick a DIFFERENT cell and
    // the divergence is what actually breaks the transcript.
    const moveNumber = state.board.flat().filter(c => c.card !== null).length;
    if (this.moveScheduledFor !== null && this.moveScheduledFor >= moveNumber) return;

    let move;
    try {
      // No seed in production: play should not be predictable from the board.
      // The harness sets one when it needs a reproducible OUTCOME.
      move = chooseBotMove(state, {
        difficulty: this.cfg.difficulty,
        skill: this.gameSkill,
        ...(this.cfg.moveSeed !== undefined ? { seed: this.cfg.moveSeed } : {}),
      });
    } catch (err) {
      this.stats.moveFailures += 1;
      return this.recordError('choose-move', err as Error);
    }
    this.moveScheduledFor = moveNumber;
    const gameId = this.gameId!;
    const card = (this.myPlayer === 'player1' ? state.player1Hand : state.player2Hand)[move.handIndex];
    setTimeout(() => {
      // Re-check: the game may have ended or moved on during the pacing delay.
      if (this.state !== 'playing' || this.gameId !== gameId) return;
      // Snapshot the pre-move board NOW: the move proof needs the transition,
      // and once GAME_STATE arrives the `before` side is gone.
      this.pendingMove = {
        moveNumber, cardId: card?.id ?? 0, row: move.row, col: move.col,
        boardBefore: state.board,
        scoresBefore: [state.player1Score, state.player2Score],
      };
      this.send({ type: 'PLACE_CARD', gameId, handIndex: move.handIndex, row: move.row, col: move.col, moveNumber });
    }, this.cfg.moveDelayMs);
  }

  /**
   * The move number we have already committed to playing. maybeMove is called
   * from several places — a relayed state, our own hand proof finishing, the
   * opponent's arriving — and any of them can be the one that unblocks a held
   * turn. Without this, two of them schedule two PLACE_CARDs for the SAME turn:
   * the relay applies the first, the second overwrites `pendingMove` with a
   * move that never happened, and no echoed board ever matches it again — the
   * bot stops proving and stops playing. Monotonic, so it needs no clearing
   * between turns and cannot wedge us if a proof is lost.
   */
  private moveScheduledFor: number | null = null;
  private readonly journal: ArenaBotDeps['journal'] | null;

  /**
   * Record this game to the journal, if one is configured.
   *
   * Called at every point the transcript grows, not once at the end: the
   * failures this protects against — a crash, a kill, a machine reboot — happen
   * MID-game by definition, and a game whose journal entry never got written is
   * a game whose five cards can never be recovered. Cheap enough (one small
   * atomic file write) that doing it eagerly is the obvious trade.
   */
  private journalGame(): void {
    const j = this.journal;
    if (!j || !this.chain || !this.onChainGameId || !this.committed) return;
    try {
      const existing = j.read(this.onChainGameId);
      j.write({
        onChainGameId: this.onChainGameId,
        relayGameId: this.gameId,
        botAddress: this.chain.address,
        opponentAddress: this.opponentAddress,
        botIsPlayer1: this.myPlayer === 'player1',
        cardIds: [...this.hand],
        randomness: this.myRandomness ? [...this.myRandomness] : [],
        blindingFactor: this.blindingFactor,
        opponentCardIds: [...this.opponentCardIds],
        myHandProof: this.myHandProof ?? null,
        opponentHandProof: this.opponentHandProof ?? null,
        moveProofs: [...this.moveProofs.values()] as any,
        committedAt: existing?.committedAt ?? this.now(),
        updatedAt: this.now(),
      });
    } catch (err) {
      // Never let bookkeeping take down a live game — but do say so, because a
      // silent journal failure means silent card loss later.
      this.log(`WARNING: could not journal game: ${(err as Error).message}`);
    }
  }

  /**
   * End the current game without a settlement, for whatever reason found it.
   *
   * Committed cards are NOT lost here but they are locked: releasing them
   * needs the abandonment claim, which is creator-only, and the bot never
   * creates. Counting them is what makes inventory drain visible on /health
   * instead of being discovered when the bot runs out of cards.
   */
  private abandonGame(reason: string): void {
    this.log(`${reason} — abandoning`);
    this.stats.abandonedGames += 1;
    if (this.committed) {
      this.log('WARNING: 5 cards remain committed to the abandoned game — ' +
               'recoverable only via the abandonment claim');
      this.stats.cardsStranded += 5;
    }
    this.resetToIdle();
  }

  private resetToIdle(): void {
    this.state = 'idle';
    this.gameId = null;
    this.myPlayer = null;
    this.queuedAt = 0;
    this.gameStartedAt = 0;
    this.opponentGoneSince = null;
    // Per-game proof inputs MUST NOT leak into the next game: a stale blinding
    // factor or opponent randomness would produce a proof that verifies against
    // the wrong commitment and be rejected at settlement.
    this.blindingFactor = null;
    this.myRandomness = null;
    this.opponentRandomness = null;
    this.myCardCommit = null;
    this.opponentCardCommit = null;
    this.opponentBlinding = null;
    this.handProofSent = false;
    this.committed = false;
    this.lastState = null;
    this.pendingMove = null;
    this.moveScheduledFor = null;
    this.myHandProof = null;
    this.opponentHandProof = null;
    this.moveProofs.clear();
    this.opponentAddress = null;
    this.opponentCardIds = [];
    this.onChainGameId = null;
    this.settling = false;
  }

  private send(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private recordError(where: string, err: Error): void {
    this.stats.lastError = `${where}: ${err.message}`;
    this.log(`ERROR ${this.stats.lastError}`);
  }
}

async function defaultFetchQueue(httpUrl: string): Promise<QueueSnapshot> {
  const res = await fetch(`${httpUrl}/queue`);
  if (!res.ok) throw new Error(`/queue returned ${res.status}`);
  return await res.json() as QueueSnapshot;
}
