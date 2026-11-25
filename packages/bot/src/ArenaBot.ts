/**
 * The arena bot: a WebSocket client that plays like any other player.
 *
 * It deliberately uses the SAME protocol a browser uses — REGISTER_BOT only
 * marks it for disclosure and metrics, it grants no privileged moves. So the
 * relay, the rules engine and the chain all treat it as an ordinary opponent,
 * which is what "completely mimic a player" has to mean if the demo is to be
 * honest.
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
 *
 * In chain mode a game is private (docs/plan/PRIVATE_GAMES.md). The bot is
 * always the JOINER, player 2:
 *
 *   MATCH_FOUND      make a key pair for this game, send KEY_EXCHANGE
 *   OPPONENT_KEY     derive the game key and the channel that seals PEER payloads
 *   PEER RECORD      the creator's record: wait for its `created` nullifier, read
 *                    our nonce, preview our record, join_game, PEER RECORD back
 *   play             move proofs bind the two records' hand commitments
 *   GAME_OVER        win: SETTLING → settle_game → SETTLED → import our notes.
 *                    draw: let player 1 settle, then do it if they do not.
 *                    loss: wait for the winner's settlement and import from it.
 *
 * Every import is from the tx that resolved the game, found by the game's own
 * `done` nullifier — a SETTLED message is only a hint. Nothing about the human
 * beyond what the game itself reveals ever reaches the bot.
 */
import WebSocket from 'ws';
import { chooseBotMove } from '@axolotl-arena/game-logic';
import type { GameState, Player } from '@axolotl-arena/game-logic';
import type { ArenaBotConfig } from './config.js';
import {
  BOT_SIDE,
  checkTranscript,
  MIN_ABANDON_SECONDS,
  DISPUTE_SECONDS,
  normalizeMoveProof,
  outcomeFor,
  parsePeerPayload,
  type Outcome,
  type PeerPayload,
} from './protocol.js';
import {
  choosePrizeMove,
  describeResolution,
  findResolvingTx,
  importOwnNotes,
  settleGame,
  type BotGame,
  type SettlementDeps,
} from './settlement.js';
import type { BotChainLike, BotProofsLike } from './chainTypes.js';
import type { JournalRecord, JournalResolution } from './GameJournal.js';
import {
  normalizeField,
  NULLIFIER_INDEX,
  placedOf,
  RECORD_HAND,
  sameRecord,
  type GameRecord,
  type GameSecrets,
} from '../../frontend/src/aztec/privateGame.js';
import type { FoundTx } from '../../frontend/src/aztec/gameChain.js';
import type { GameChannel, GameKeyPair, SealedPayload } from '../../frontend/src/aztec/gameKeys.js';
import type { MoveProofData } from '../../frontend/src/types.js';

export type { BotChainLike, BotProofsLike };

/**
 * How long a lost or drawn game stays reachable for the winner's SETTLING and
 * SETTLED after we have reset. Generous: a settlement is a nine-proof recursive
 * verification plus inclusion. Past it, the recovery sweep finds the settlement
 * on-chain by itself, so this bounds memory, not correctness.
 */
const RETURN_WAIT_MS = 60 * 60_000;

/**
 * How long we keep absorbing move proofs for a game that has already ended.
 *
 * The final move of a nine-move game is always player 1's — moves are
 * 0-indexed, so P1 plays 0,2,4,6,8 — and the bot only ever joins, so it is
 * always player 2. The ninth proof is the opponent's and arrives AFTER
 * GAME_OVER, while their browser is still proving it. Without it the journal
 * freezes at 8 of 9, and a game whose winner then walks away could never be
 * settled on its merits by anyone.
 */
const LATE_PROOF_WINDOW_MS = 15 * 60_000;

/** How long to wait for the creator's record after the match before giving up. */
const DEFAULT_RECORD_WAIT_MS = 10 * 60_000;

/**
 * How long to wait for the creator's `created` nullifier once their record
 * arrives. They send the record once create_game is mined, so this only
 * covers a node that has not caught up yet.
 */
const DEFAULT_CREATED_WAIT_MS = 5 * 60_000;
const NULLIFIER_POLL_MS = 3_000;

/** How long to wait for a resolution the bot was just told about (or sent) to show on the node. */
const RESOLUTION_WAIT_MS = 2 * 60_000;

/** PEER payloads held while the channel is still being derived. */
const MAX_PENDING_PEER = 16;

/** Ids in logs: enough to correlate, never a whole on-chain value. */
const short = (id: unknown): string =>
  typeof id === 'string' ? `${id.slice(0, 10)}…` : String(id);

/**
 * Error text for /health: no long hex, because a chain error can quote a
 * nullifier, a record field or a key, and none of those may leave the bot.
 */
export function redactForHealth(message: string): string {
  return message.replace(/0x[0-9a-fA-F]{16,}/g, m => `${m.slice(0, 6)}…`);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** The per-game key exchange (frontend/src/aztec/gameKeys.ts). Injectable for tests. */
export interface GameKeysLike {
  generateGameKeyPair(): Promise<GameKeyPair>;
  deriveGameChannel(own: GameKeyPair, theirPublicKey: string, roomId: string): Promise<GameChannel>;
  sealPeerPayload(channelKey: CryptoKey, roomId: string, payload: unknown): Promise<SealedPayload>;
  openPeerPayload<T = unknown>(channelKey: CryptoKey, roomId: string, sealed: SealedPayload): Promise<T>;
}

/** What the bot journals: GameJournal's surface, narrowed so a stub stays cheap. */
export interface BotJournal {
  read(relayGameId: string): JournalRecord | null;
  write(rec: JournalRecord): void;
  forget(relayGameId: string): void;
  markResolved(relayGameId: string, resolution: JournalResolution, txHash: string): void;
  /** Games still holding our cards. Optional so a stub journal stays cheap. */
  outstanding?(): JournalRecord[];
}

export type BotState = 'idle' | 'queued' | 'playing';

/**
 * What the bot is doing RIGHT NOW, as opposed to what it has done.
 *
 * The counters below answer "has anything broken". They cannot answer "what is
 * happening", and that gap cost real time: diagnosing a live game meant
 * grepping the journal and the systemd log after the fact and inferring the
 * state. Nothing here identifies the game on-chain: no key, record or nullifier.
 */
export interface LiveGame {
  relayGameId: string | null;
  /** 1 or 2. The bot only ever joins, so in practice 2. */
  playerNumber: 1 | 2 | null;
  /** The per-game key exchange has completed. */
  keyed: boolean;
  /** The creator's record has arrived. */
  opponentRecord: boolean;
  /** Cards are at stake from here on. */
  committed: boolean;
  /** Move proofs held for THIS game — the transcript a settlement is built from. */
  moveProofs: number;
  /** True when the board is waiting on us. */
  oweAMove: boolean;
  /** Seconds since the opponent's socket dropped, or null while they are here. */
  opponentGoneFor: number | null;
  /** Seconds since the game started, so a stuck one is visible as a number. */
  ageSeconds: number;
  settling: boolean;
}

/** One outstanding game the sweep is still responsible for. */
export interface JournalEntry {
  relayGameId: string;
  phase: 'joining' | 'joined';
  moveProofs: number;
  outcome: Outcome | null;
  ageSeconds: number;
  /** Why the sweep cannot act yet, or null when it can. */
  blockedBy: string | null;
}

export interface BotStats {
  state: BotState;
  /** The game in progress, or null when idle. */
  game: LiveGame | null;
  /** Games still holding our cards. The sweep's whole worklist. */
  journal: JournalEntry[];
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  joinFailures: number;
  moveFailures: number;
  /** join_game failures. Chain mode only. */
  commitFailures: number;
  /** Proof-generation failures. Chain mode only. */
  proofFailures: number;
  /** Settlement failures, and successful settlements. Chain mode only. */
  settleFailures: number;
  settlements: number;
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
   * import came up short. Every one is a card it cannot field, so this is a
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
   * Persists each committed game so it can be recovered if this process dies.
   * Optional: without it the bot plays identically, but a game interrupted
   * mid-way keeps its five cards until someone else resolves it.
   */
  journal?: BotJournal;
  /** Proof generator. Required alongside `chain`; ignored without it. */
  proofs?: BotProofsLike;
  /** The key exchange; defaults to the frontend's gameKeys (WebCrypto). */
  keys?: GameKeysLike;
  /** Injected for tests; defaults to a real ws client. */
  connect?: (url: string) => WebSocket;
  /** Injected for tests; defaults to fetch. */
  fetchQueue?: (httpUrl: string) => Promise<QueueSnapshot>;
  log?: Logger;
  now?: () => number;
}

/** One committed-or-committing game, chain mode. Lives on past GAME_OVER until it is resolved. */
interface ChainGame {
  relayGameId: string;
  /** Our hand, in committed order. */
  cardIds: number[];
  keyPair: GameKeyPair | null;
  opponentPublicKey: string | null;
  channel: GameChannel | null;
  deriving: boolean;
  /** PEER payloads that arrived before the channel existed. */
  pendingPeer: SealedPayload[];
  record1: GameRecord | null;
  record2: GameRecord | null;
  nonce: string | null;
  secrets: GameSecrets | null;
  joinStarted: boolean;
  committed: boolean;
  committedAt: number;
  moveProofs: Map<string, MoveProofData>;
  outcome: Outcome | null;
  prizeMove: number | null;
  /** We are settling it ourselves; the opponent's SETTLED is then only news. */
  settlingSelf: boolean;
  /** The opponent said they settled (a hint: the chain is what we import from). */
  settledHint: string | null;
  /** The import in flight, if any — a second request waits for it. */
  importing: Promise<void> | null;
  imported: boolean;
}

export class ArenaBot {
  private ws: WebSocket | null = null;
  private state: BotState = 'idle';
  private gameId: string | null = null;
  private myPlayer: Player | null = null;
  private queuedAt = 0;
  private hand: number[] = [];
  /** The current game's chain context (chain mode only). */
  private game: ChainGame | null = null;
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
  /** Move proofs still generating — shutdown waits for them. */
  private proving = 0;
  private settling = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private registered = false;
  /**
   * Games that ended but are not resolved yet, by relay room id: the winner's
   * SETTLING/SETTLED and the opponent's last move proof land after we reset.
   */
  private readonly recentGames = new Map<string, { ctx: ChainGame; proofsUntil: number; until: number }>();

  private readonly stats: Omit<BotStats, 'state' | 'game' | 'journal'> = {
    gamesPlayed: 0, wins: 0, losses: 0, draws: 0,
    joinFailures: 0, moveFailures: 0, commitFailures: 0, proofFailures: 0, settleFailures: 0, settlements: 0,
    abandonedGames: 0, cardsStranded: 0, spendableCards: -1,
    cardsUnimported: 0, feeJuice: '-1', lastError: null,
  };

  private readonly chain: BotChainLike | null;
  private readonly proofs: BotProofsLike | null;
  private readonly journal: BotJournal | null;
  private readonly injectedKeys: GameKeysLike | null;
  private keysModule: Promise<GameKeysLike> | null = null;
  private readonly connect: (url: string) => WebSocket;
  private readonly fetchQueue: (httpUrl: string) => Promise<QueueSnapshot>;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly cfg: ArenaBotConfig, deps: ArenaBotDeps = {}) {
    this.chain = deps.chain ?? null;
    this.journal = deps.journal ?? null;
    this.proofs = deps.proofs ?? null;
    this.injectedKeys = deps.keys ?? null;
    this.connect = deps.connect ?? ((url: string) => new WebSocket(url));
    this.fetchQueue = deps.fetchQueue ?? defaultFetchQueue;
    this.log = deps.log ?? ((m: string) => console.log(`[arena-bot] ${m}`));
    this.now = deps.now ?? (() => Date.now());
  }

  getStats(): BotStats {
    // Built fresh on every read, not accumulated: the point of these two fields
    // is that they describe NOW. A cached snapshot of "what is happening" is
    // the thing that misled us in the first place.
    return {
      ...this.stats,
      state: this.state,
      game: this.liveGame(),
      journal: this.journalSummary(),
    };
  }

  /** True while the bot still owns a game's follow-up (the sweep leaves those alone). */
  isTracking(relayGameId: string): boolean {
    return relayGameId === this.gameId || this.recentGame(relayGameId) !== null;
  }

  private liveGame(): LiveGame | null {
    if (this.state !== 'playing' || !this.gameId) return null;
    const secs = (since: number) => Math.max(0, Math.round((this.now() - since) / 1000));
    return {
      relayGameId: this.gameId,
      playerNumber: this.myPlayer === 'player1' ? 1 : this.myPlayer === 'player2' ? 2 : null,
      keyed: this.game?.channel != null,
      opponentRecord: this.game?.record1 != null,
      committed: this.committed,
      moveProofs: this.game?.moveProofs.size ?? 0,
      oweAMove: this.oweAMove(),
      opponentGoneFor: this.opponentGoneSince === null ? null : secs(this.opponentGoneSince),
      ageSeconds: this.gameStartedAt > 0 ? secs(this.gameStartedAt) : 0,
      settling: this.settling,
    };
  }

  /**
   * The sweep's worklist, and WHY each entry is not moving.
   *
   * "Why not yet" is the part that was invisible: a game sitting untouched
   * looks identical whether it is too young, waiting on its join, or serving
   * out a dispute window, and telling those apart meant reading the log.
   */
  private journalSummary(): JournalEntry[] {
    if (!this.journal) return [];
    const now = this.now();
    const outstanding = this.journal.outstanding?.() ?? [];
    // When the sweep will act: its own minimum age (the game timeout, which
    // index.ts passes it), and never before the contract's bar.
    const sweepAgeSeconds = Math.max(MIN_ABANDON_SECONDS, Math.round(this.cfg.gameTimeoutMs / 1000));
    return outstanding.map(rec => {
      const ageSeconds = Math.max(0, Math.round((now - rec.committedAt) / 1000));
      let blockedBy: string | null = null;
      if (rec.phase === 'joining') blockedBy = 'join not confirmed on-chain yet';
      else if (rec.claimedAt) {
        // Claimed and serving out its dispute window. Without this the entry
        // reports nothing blocking it, which reads as "nobody has touched this"
        // — the opposite of the truth, during the ten minutes it matters most.
        const left = Math.ceil((rec.claimedAt + DISPUTE_SECONDS - Math.floor(now / 1000)) / 60);
        // "passed", not "finalizing": all we know from claimedAt is that the
        // window is over. Whether the sweep is actually finalizing is something
        // else, and a sweep that had died would still read as busy here.
        blockedBy = left > 0
          ? `claimed — dispute window, ~${left}min left`
          : 'claimed — dispute window passed';
      } else if (ageSeconds < sweepAgeSeconds) {
        blockedBy = `too young (${Math.ceil((sweepAgeSeconds - ageSeconds) / 60)}min to go)`;
      }
      return {
        relayGameId: rec.relayGameId,
        phase: rec.phase,
        moveProofs: rec.moveProofs.length,
        outcome: rec.outcome,
        ageSeconds,
        blockedBy,
      };
    });
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

  /**
   * Leave without dropping a move proof that is still being generated.
   *
   * A proof in flight at shutdown is part of the transcript a settlement
   * needs — the winner's, if we just lost — and it exists nowhere else until
   * it is sent and journalled. Everything else is recoverable without us: an
   * unfinished game is claimed and unwound from the journal by the next
   * process. Bounded well inside systemd's 90s stop timeout, because being
   * killed halfway is worse than leaving promptly.
   */
  async shutdown(maxMs = 60_000): Promise<void> {
    if (this.proving > 0) {
      this.log('shutting down with a move proof in flight — letting it finish so the transcript stays whole');
      const deadline = this.now() + maxMs;
      while (this.now() < deadline && this.proving > 0) await sleep(250);
      if (this.proving > 0) this.log('WARNING: a move proof was still generating at exit; that move is missing from the transcript');
    }
    this.stop();
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

    // Stuck-game watchdog. An opponent who never commits, or vanishes mid-game,
    // would otherwise park us in `playing` forever — taking no further players
    // and leaving our five committed cards waiting.
    // Not while settling: that is a finished game, bounded by its own waits.
    if (this.state === 'playing' && !this.settling && this.gameStartedAt > 0
        && this.now() - this.gameStartedAt > this.cfg.gameTimeoutMs) {
      this.abandonGame(`game exceeded ${Math.round(this.cfg.gameTimeoutMs / 60_000)}min`);
      return;
    }

    // A creator who never sends their record never committed anything we
    // could join. Nothing of ours is at stake, so there is no reason to hold
    // the arena's only opponent for the full game timeout.
    if (this.state === 'playing' && this.game && !this.game.record1 && this.gameStartedAt > 0
        && this.now() - this.gameStartedAt > (this.cfg.recordWaitMs ?? DEFAULT_RECORD_WAIT_MS)) {
      this.abandonGame('the creator never sent their game record');
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
    // the same waiting player, so without this they ALL queue for one person.
    // One bot per waiting human is the whole requirement. (Older relays omit
    // these fields; then a single bot is assumed, which is what the pool-less
    // deployment actually is.)
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
        await this.chain.readFeeJuice?.()
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
          this.stats.lastError = redactForHealth(`select-hand: ${(err as Error).message}`);
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
        this.myPlayer = 'player2';
        this.state = 'playing';
        this.gameStartedAt = this.now();
        // One skill for the whole game. Re-rolling per move would make the bot
        // alternate between brilliant and careless within a single game, which
        // reads as broken rather than as a weaker opponent.
        this.gameSkill = this.rollSkill();
        this.log(`matched into ${msg.gameId} as ${this.myPlayer} (skill ${this.gameSkill.toFixed(2)})`);
        if (this.chain) this.beginKeyExchange(String(msg.gameId));
        this.maybeMove(msg.gameState);
        break;

      case 'OPPONENT_KEY':
        this.onOpponentKey(msg);
        break;

      case 'PEER':
        this.onPeer(msg);
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
        if (msg.gameId !== this.gameId || !this.myPlayer) break;
        const outcome = outcomeFor(msg.winner, this.myPlayer);
        this.stats.gamesPlayed += 1;
        if (outcome === 'draw') this.stats.draws += 1;
        else if (outcome === 'win') this.stats.wins += 1;
        else this.stats.losses += 1;
        this.log(`game over: ${msg.winner} (bot was ${this.myPlayer})`);

        const ctx = this.game;
        if (ctx?.committed) {
          ctx.outcome = outcome;
          this.journalGame(ctx);
          // Keep the door open for what lands after we reset: the opponent's
          // final move proof, and the winner's SETTLING / SETTLED.
          this.rememberGame(ctx);
        }
        if (ctx?.committed && this.chain && this.proofs && outcome !== 'loss') {
          // Settle BEFORE resetting: the transcript lives in this game's state.
          // Reset only if we are still on this game — never out of a later one.
          const relayGameId = ctx.relayGameId;
          void this.settle(ctx, outcome).catch(err => {
            this.stats.settleFailures += 1;
            this.recordError('settle', err as Error);
          }).finally(() => { if (this.gameId === relayGameId) this.resetToIdle(); });
        } else {
          // A loss: the winner settles, and their SETTLED (or, failing that,
          // the sweep finding the settlement on-chain) brings our cards back.
          this.resetToIdle();
        }
        break;
      }

      case 'MOVE_PROVEN': {
        const proof = normalizeMoveProof(msg.moveProof);
        if (!proof) break;
        if (msg.gameId === this.gameId && this.game) {
          this.addMoveProof(this.game, proof);
        } else {
          // The ninth proof arrives after the game we just played has ended —
          // see LATE_PROOF_WINDOW_MS. By now this.gameId is null (or another
          // game), so gating on it would drop exactly the proof that completes
          // the transcript. Straight into that game's journal.
          const recent = this.recentGame(String(msg.gameId));
          if (recent && this.now() < recent.proofsUntil) this.addMoveProof(recent.ctx, proof, true);
        }
        break;
      }

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

  // ─── Key exchange and the PEER channel ────────────────────────────────────

  private keys(): Promise<GameKeysLike> {
    if (!this.keysModule) {
      this.keysModule = this.injectedKeys
        ? Promise.resolve(this.injectedKeys)
        : import('../../frontend/src/aztec/gameKeys.js');
    }
    return this.keysModule;
  }

  /** MATCH_FOUND, chain mode: a fresh key pair for this game, its public half to the opponent. */
  private beginKeyExchange(relayGameId: string): void {
    const ctx: ChainGame = {
      relayGameId, cardIds: [...this.hand],
      keyPair: null, opponentPublicKey: null, channel: null, deriving: false, pendingPeer: [],
      record1: null, record2: null, nonce: null, secrets: null,
      joinStarted: false, committed: false, committedAt: 0, moveProofs: new Map(),
      outcome: null, prizeMove: null, settlingSelf: false, settledHint: null,
      importing: null, imported: false,
    };
    this.game = ctx;
    void (async () => {
      const keys = await this.keys();
      ctx.keyPair = await keys.generateGameKeyPair();
      if (this.game !== ctx) return;
      this.send({ type: 'KEY_EXCHANGE', gameId: relayGameId, publicKey: ctx.keyPair.publicKey });
      await this.deriveChannel(ctx);
    })().catch(err => this.recordError('key-exchange', err as Error));
  }

  private onOpponentKey(msg: any): void {
    const ctx = this.game;
    if (!ctx || msg.gameId !== ctx.relayGameId || typeof msg.publicKey !== 'string' || !msg.publicKey) return;
    if (ctx.opponentPublicKey && ctx.opponentPublicKey !== msg.publicKey) {
      // The game key is already derived from the first one, and may already be
      // committed on-chain. A different key now is a confused or hostile peer.
      this.log('ignoring a second, different key from the opponent');
      return;
    }
    ctx.opponentPublicKey = msg.publicKey;
    void this.deriveChannel(ctx).catch(err => this.recordError('key-exchange', err as Error));
  }

  /** Once both public keys are known: the game key and the channel. Then any payloads that were waiting. */
  private async deriveChannel(ctx: ChainGame): Promise<void> {
    if (ctx.channel || ctx.deriving || !ctx.keyPair || !ctx.opponentPublicKey) return;
    ctx.deriving = true;
    try {
      const keys = await this.keys();
      ctx.channel = await keys.deriveGameChannel(ctx.keyPair, ctx.opponentPublicKey, ctx.relayGameId);
      this.log('game key agreed with the opponent');
    } finally {
      ctx.deriving = false;
    }
    for (const sealed of ctx.pendingPeer.splice(0)) await this.openPeer(ctx, sealed);
  }

  private onPeer(msg: any): void {
    const id = String(msg.gameId);
    const ctx = id === this.gameId ? this.game : this.recentGame(id)?.ctx ?? null;
    if (!ctx || typeof msg.iv !== 'string' || typeof msg.ciphertext !== 'string') return;
    const sealed: SealedPayload = { iv: msg.iv, ciphertext: msg.ciphertext };
    if (!ctx.channel) {
      // The relay delivers in order, so this is only ever our own derivation
      // still running. Bounded, so a confused peer cannot grow it.
      if (ctx.pendingPeer.length < MAX_PENDING_PEER) ctx.pendingPeer.push(sealed);
      return;
    }
    void this.openPeer(ctx, sealed);
  }

  private async openPeer(ctx: ChainGame, sealed: SealedPayload): Promise<void> {
    let payload: PeerPayload | null;
    try {
      const keys = await this.keys();
      payload = parsePeerPayload(await keys.openPeerPayload(ctx.channel!.channelKey, ctx.relayGameId, sealed));
    } catch {
      // Tampered with, or sealed under another key: either way not from our
      // opponent in this game.
      this.log('dropped a PEER payload that does not open with this game\'s channel');
      return;
    }
    if (!payload) {
      this.log('dropped a malformed PEER payload');
      return;
    }
    this.onPeerPayload(ctx, payload);
  }

  private onPeerPayload(ctx: ChainGame, p: PeerPayload): void {
    switch (p.kind) {
      case 'RECORD':
        if (ctx !== this.game) return;
        if (ctx.record1) {
          if (!sameRecord(ctx.record1, p.record)) this.log('ignoring a second, different creator record');
          return;
        }
        ctx.record1 = p.record;
        this.log('creator record received');
        void this.join(ctx);
        return;

      case 'SETTLING':
        // The winner names the card they are taking. Only a hint for us: the
        // settlement tx itself says which of our notes it released.
        if (!ctx.settlingSelf) {
          ctx.prizeMove = p.prizeMove;
          this.journalGame(ctx);
        }
        return;

      case 'SETTLED':
        ctx.settledHint = p.txHash;
        // While we are settling this game ourselves, settle() checks the hint
        // against the chain; otherwise (a loss, or a game we left) take our
        // cards back from the settlement, once the chain shows it.
        if (!ctx.settlingSelf && !(this.settling && this.game === ctx)) {
          void this.takeNotesBack(ctx, 'the opponent settled');
        }
        return;

      case 'CANCELLED':
        // The creator cancelled their game. Nothing of ours is committed unless
        // our join already landed — and then their cancel cannot have.
        if (ctx === this.game && !ctx.joinStarted && !ctx.committed) {
          this.abandonGame('the creator cancelled the game');
        }
        return;
    }
  }

  private async sendPeer(ctx: ChainGame, payload: PeerPayload): Promise<void> {
    if (!ctx.channel) throw new Error('no channel to the opponent yet');
    const keys = await this.keys();
    const sealed = await keys.sealPeerPayload(ctx.channel.channelKey, ctx.relayGameId, payload);
    this.send({ type: 'PEER', gameId: ctx.relayGameId, iv: sealed.iv, ciphertext: sealed.ciphertext });
  }

  // ─── Joining ──────────────────────────────────────────────────────────────

  /** pxe.ts hands `timeoutMs` to the SDK's wait, which counts SECONDS. */
  private sendOpts(): { node: unknown; timeoutMs: number } {
    return { node: this.chain?.nodeClient, timeoutMs: Math.ceil(this.cfg.chainTxTimeoutMs / 1000) };
  }

  private settlementDeps(): SettlementDeps {
    return { chain: this.chain!, sendOpts: () => this.sendOpts(), log: this.log };
  }

  /**
   * Join the game whose creator sent us `record1`.
   *
   * join_game proves `created` exists, so the creator's tx must be mined —
   * they send the record once it is, but our node may lag, so we look first.
   * Then: our nonce (read BEFORE committing — the commit advances it), our own
   * secrets, and the record the join will commit. The journal is written
   * BEFORE the send: a crash while the join is in flight is exactly when the
   * cards may be committed with nothing else recording where.
   */
  private async join(ctx: ChainGame): Promise<void> {
    if (ctx.joinStarted || !ctx.record1 || !ctx.channel || !this.chain) return;
    ctx.joinStarted = true;
    const chain = this.chain;
    const here = () => this.game === ctx && this.state === 'playing';
    try {
      const { gameKey } = ctx.channel;
      const nullifiers = await chain.pxe.gameNullifiers(chain.address, gameKey, ctx.record1, null);
      const created = await this.waitForNullifier(
        nullifiers[NULLIFIER_INDEX.created],
        this.cfg.createdWaitMs ?? DEFAULT_CREATED_WAIT_MS,
        here,
      );
      if (!here()) return;
      if (!created) {
        // A record whose game is not on-chain: a wrong key, a forged record, or
        // a create that never landed. Nothing to join, nothing of ours spent.
        this.stats.commitFailures += 1;
        this.recordError('commit-join', new Error('the creator\'s game never appeared on-chain — not joining'));
        this.abandonGame('the creator\'s game is not on-chain');
        return;
      }

      const hand = [...ctx.cardIds];
      const nonce = await chain.pxe.readNoteNonce(chain.address);
      const secrets = await chain.pxe.computeGameSecrets(chain.address, nonce);
      const record2 = await chain.pxe.previewRecord(chain.address, gameKey, hand, nonce);
      if (this.proofs) {
        // Every move proof binds this commitment. If the contract's record
        // disagrees with what we would prove against, no move could ever be
        // proved — find out before committing five cards, not after.
        const commit = normalizeField(await this.proofs.cardCommitHash(hand, secrets.blinding));
        if (commit !== record2[RECORD_HAND]) {
          throw new Error('the previewed record does not commit to our own hand — refusing to join');
        }
      }
      if (!here()) return;
      ctx.nonce = nonce;
      ctx.secrets = secrets;
      ctx.record2 = record2;
      ctx.committedAt = this.now();
      this.journalGame(ctx, 'joining');

      this.log(`join_game: committing ${hand.join(',')}`);
      await chain.pxe.sendJoinGame(chain.address, gameKey, ctx.record1, hand, this.sendOpts());
      ctx.committed = true;
      // Five cards are nullified by the join; the cached collection is stale.
      chain.invalidateCards?.();
      this.journalGame(ctx, 'joined');
      this.log('join_game mined');

      if (!here()) {
        // The game moved on while the join was proving. The cards are committed
        // anyway; the journal has the game, and the sweep will unwind it.
        this.stats.cardsStranded += 5;
        this.log('joined after the game was abandoned — the journal and the sweep have it');
        return;
      }
      this.committed = true;
      this.send({ type: 'TX_CONFIRMED', gameId: ctx.relayGameId, txType: 'join_game' });
      await this.sendPeer(ctx, { kind: 'RECORD', record: record2 });
      this.log('our record sent to the creator');
      // Our turn may have arrived while we were committing.
      this.maybeMove(this.lastState ?? undefined);
    } catch (err) {
      this.stats.commitFailures += 1;
      this.recordError('commit-join', err as Error);
      // Nothing of ours landed (as far as we know — a join that timed out but
      // mined later is in the journal as 'joining', for the sweep). Free the
      // player rather than hold them to a game we cannot play.
      if (here() && !ctx.committed) this.abandonGame('could not join');
    }
  }

  /** Poll for a nullifier; false if it does not appear in `maxMs` or `stillWanted` turns false. */
  private async waitForNullifier(nullifier: string, maxMs: number, stillWanted: () => boolean): Promise<boolean> {
    const deadline = this.now() + maxMs;
    for (;;) {
      const [hit] = await this.chain!.lookupNullifiers([nullifier]);
      if (hit) return true;
      if (!stillWanted() || this.now() >= deadline) return false;
      await sleep(NULLIFIER_POLL_MS);
    }
  }

  // ─── Play and move proofs ─────────────────────────────────────────────────

  /** Both hand commitments and our blinding: everything a move proof needs. */
  private canProve(ctx: ChainGame | null): ctx is ChainGame & { record1: GameRecord; record2: GameRecord; secrets: GameSecrets } {
    return !!ctx && !!ctx.record1 && !!ctx.record2 && !!ctx.secrets;
  }

  /**
   * Prove the move we just made, using the snapshot taken before we sent it and
   * the state the relay echoed back.
   *
   * Only runs for OUR move: the opponent proves their own. The proof binds both
   * records' hand commitments and publishes the card we placed and its slot in
   * our committed hand — which is what lets a settlement hold back the right
   * return note if we lose.
   */
  private async maybeProveMove(after: GameState | undefined): Promise<void> {
    const pending = this.pendingMove;
    const ctx = this.game;
    if (!this.chain || !this.proofs || !pending || !after || !this.myPlayer) return;
    // The echoed state must be EXACTLY the one produced by our move. A later
    // state is not merely redundant — the circuit asserts
    // board_after[cell].owner == current_player, and by a later move our card
    // may already have been captured, so the owner reads as the opponent and
    // the proof fails "Owner not set correctly".
    const occupied = after.board.flat().filter(c => c.card !== null).length;
    if (occupied !== pending.moveNumber + 1) return;
    if (!this.canProve(ctx)) {
      // Unreachable now that maybeMove holds the turn until both records are
      // known. If it ever happens the game is already unsettleable, so say so
      // loudly rather than dropping the move proof in silence.
      this.pendingMove = null;
      this.stats.proofFailures += 1;
      this.recordError('move-proof', new Error(
        `move ${pending.moveNumber} cannot be proved: a record is missing — ` +
        'the transcript is now permanently incomplete',
      ));
      return;
    }

    this.pendingMove = null;
    const gameId = this.gameId;
    const currentPlayer: 1 | 2 = this.myPlayer === 'player1' ? 1 : 2;
    const ended = after.status === 'finished';
    const winnerId = !ended ? 0 : after.winner === 'player1' ? 1 : after.winner === 'player2' ? 2 : 3;

    this.proving += 1;
    let raw: MoveProofData;
    try {
      raw = await this.proofs.proveMove({
        cardId: pending.cardId, row: pending.row, col: pending.col, currentPlayer,
        boardBefore: pending.boardBefore, boardAfter: after.board,
        scoresBefore: pending.scoresBefore,
        scoresAfter: [after.player1Score, after.player2Score],
        cardCommit1: ctx.record1[RECORD_HAND],
        cardCommit2: ctx.record2[RECORD_HAND],
        gameEnded: ended, winnerId,
        hand: { cardIds: [...ctx.cardIds], blindingFactor: ctx.secrets.blinding },
      });
    } finally {
      this.proving -= 1;
    }
    if (!gameId) return;
    // A proof that finishes AFTER the game ended still has to be sent.
    //
    // The move that ends the game is proved after the relay has already
    // announced GAME_OVER, and on a loss `resetToIdle()` has by then nulled
    // `this.gameId`. Dropping the proof on that basis cost real games: it is
    // the WINNER's, and without it nobody can settle. Only a DIFFERENT game is
    // grounds to drop it. The relay routes by the gameId in the message and
    // keeps rooms after they finish.
    const stillOurs = this.game === ctx;
    if (this.gameId !== null && !stillOurs) return;
    const proof = normalizeMoveProof(raw);
    if (!proof) {
      this.stats.proofFailures += 1;
      this.recordError('move-proof', new Error(`move ${pending.moveNumber} produced a proof without 8 public inputs`));
      return;
    }
    // Kept as well as sent: the journal is what a settlement is built from.
    this.addMoveProof(ctx, proof, !stillOurs);
    this.send({
      type: 'SUBMIT_MOVE_PROOF', gameId,
      handIndex: 0, row: pending.row, col: pending.col,
      moveNumber: pending.moveNumber, moveProof: raw,
    });
    this.log(`move proof ${pending.moveNumber} submitted${stillOurs ? '' : ' (after game over)'}`);
  }

  /** Key by the chain link, not the move number: duplicates from a relay replay collapse. */
  private addMoveProof(ctx: ChainGame, proof: MoveProofData, late = false): void {
    if (ctx.moveProofs.has(proof.startStateHash)) return;
    ctx.moveProofs.set(proof.startStateHash, proof);
    this.journalGame(ctx);
    if (late) {
      this.log(`late move proof kept — the journal now holds ${ctx.moveProofs.size}/9` +
        (ctx.moveProofs.size >= 9 ? ' (transcript complete)' : ''));
    }
  }

  // ─── Settling and taking our cards back ───────────────────────────────────

  /**
   * Settle a game we won or drew.
   *
   * A draw is settled by player 1 by convention, but anyone may settle, and
   * the bot is always player 2 — so it gives player 1 `drawFallbackMs` and
   * then settles itself if the game is still unresolved. Checked against the
   * CHAIN, not a message or a timer alone: settling an already-settled game
   * burns a recursive proof to earn a revert, and standing down because
   * somebody merely SAID they settled would leave a won game unsettled.
   */
  private async settle(ctx: ChainGame, outcome: 'win' | 'draw'): Promise<void> {
    if (this.settling) return;
    this.settling = true;
    const deps = this.settlementDeps();

    if (outcome === 'draw') {
      this.log(`draw — giving player 1 ${Math.round(this.cfg.drawFallbackMs / 1000)}s to settle`);
      await sleep(this.cfg.drawFallbackMs);
      if (await this.resolvedElsewhere(ctx, 'player 1 settled the draw')) return;
      this.log('player 1 did not settle the draw — settling it ourselves');
    }

    // Wait for the transcript to complete before judging it. Moves are relayed
    // on PLACE_CARD, but proving each one is slow, so GAME_OVER routinely
    // arrives with move proofs still generating — the ninth always does. If
    // the other side says it settled meanwhile, look: a second settlement can
    // only revert, after a full recursive proof.
    const deadline = this.now() + this.cfg.settleWaitMs;
    let checkedHint: string | null = null;
    for (;;) {
      if (ctx.imported) return;
      if (ctx.settledHint !== null && ctx.settledHint !== checkedHint) {
        checkedHint = ctx.settledHint;
        if (await this.resolvedElsewhere(ctx, 'the game was settled while we waited for the transcript')) return;
      }
      if (ctx.moveProofs.size >= 9 || this.now() >= deadline) break;
      await sleep(500);
    }

    const game = this.botGame(ctx);
    // Fails loudly with WHAT is wrong: an incomplete or mismatched transcript
    // otherwise surfaces as an opaque on-chain revert after the proving.
    const { ordered, winner } = checkTranscript(game.moveProofs, game.record1, game.record2);
    const expected = outcome === 'draw' ? 'draw' : BOT_SIDE;
    if (winner !== expected) {
      this.log(`WARNING: the relay called a ${outcome} but the transcript says ${winner === 'draw' ? 'a draw' : `player ${winner} won`} — settling what the transcript proves`);
    }
    const prizeMove = choosePrizeMove(ordered, winner);
    ctx.prizeMove = prizeMove;
    ctx.settlingSelf = true;
    this.journalGame(ctx);
    // A draw names no prize: announced as null, as the browser does.
    await this.sendPeer(ctx, { kind: 'SETTLING', prizeMove: winner === 'draw' ? null : prizeMove });
    this.log(winner === 'draw'
      ? 'settling the draw…'
      : `settling — the prize is move ${prizeMove}, card ${placedOf(ordered[prizeMove]).cardId}…`);

    let txHash: string;
    try {
      txHash = await settleGame(deps, { ...game, prizeMove }, prizeMove, await this.proofs!.moveVerificationKey());
    } catch (err) {
      // A game resolves once. If something else resolved it first (the other
      // player settling, or a finalize), our cards are in THAT tx — take them
      // from there instead of calling a lost race a failure.
      const resolved = await findResolvingTx(deps, game).catch(() => null);
      if (resolved) {
        this.log('the game was resolved by another tx while we settled — taking our cards back');
        await this.takeNotesBack(ctx, 'resolved elsewhere', resolved);
        return;
      }
      throw err;
    }
    this.stats.settlements += 1;
    this.log(`settled on-chain: ${short(txHash)}`);
    await this.sendPeer(ctx, { kind: 'SETTLED', txHash }).catch(err =>
      this.log(`WARNING: could not tell the opponent we settled (${(err as Error).message}) — they can find it on-chain`));
    await this.takeNotesBack(ctx, 'we settled');
  }

  /**
   * True — and our cards taken back — if the game is already resolved
   * on-chain. When the opponent has said they settled, give our node a little
   * while to see it; a claim the chain does not bear out is ignored.
   */
  private async resolvedElsewhere(ctx: ChainGame, why: string): Promise<boolean> {
    if (ctx.imported) return true;
    let found: FoundTx | null;
    try {
      found = await findResolvingTx(this.settlementDeps(), this.botGame(ctx), {
        waitMs: ctx.settledHint !== null ? RESOLUTION_WAIT_MS : 0,
        pollMs: 5_000,
      });
    } catch (err) {
      // If we cannot read the game's state, settling anyway is the safer error:
      // a duplicate settle reverts and costs a proof, while skipping it leaves
      // the cards waiting on the sweep.
      this.log(`could not read the game's state (${(err as Error).message}) — settling anyway`);
      return false;
    }
    if (!found) {
      if (ctx.settledHint !== null) {
        this.log('the opponent said they settled, but the chain shows no settlement — settling ourselves');
      }
      return false;
    }
    this.log(`${why} — taking our cards back`);
    await this.takeNotesBack(ctx, why, found);
    return true;
  }

  /**
   * Import our own notes from the tx that resolved the game — found from the
   * game's `done` nullifier, whatever anybody said — and mark the game
   * resolved. One import at a time per game: a second request waits for the
   * first and runs only if that one did not get the cards back. A failure
   * leaves the journal entry outstanding for the sweep.
   */
  private async takeNotesBack(ctx: ChainGame, why: string, found?: FoundTx): Promise<void> {
    while (ctx.importing) await ctx.importing.catch(() => undefined);
    if (ctx.imported || !this.chain) return;
    if (!ctx.record1 || !ctx.record2 || !ctx.channel || !ctx.nonce) return;
    const run = this.importResolution(ctx, why, found);
    ctx.importing = run;
    try {
      await run;
    } finally {
      if (ctx.importing === run) ctx.importing = null;
    }
  }

  private async importResolution(ctx: ChainGame, why: string, found?: FoundTx): Promise<void> {
    const deps = this.settlementDeps();
    try {
      const game = this.botGame(ctx);
      const tx = found ?? await findResolvingTx(deps, game, { waitMs: RESOLUTION_WAIT_MS, pollMs: 5_000 });
      if (!tx) {
        this.log(`WARNING: ${why}, but the game is not resolved on-chain — the sweep will look again`);
        return;
      }
      if (ctx.settledHint && normalizeField(ctx.settledHint) !== normalizeField(tx.txHash)) {
        this.log('note: the opponent named a different settlement tx than the one on-chain — using the chain\'s');
      }
      const result = await importOwnNotes(deps, game, tx);
      const missing = Math.max(0, result.expectedCards - result.gainedCards);
      if (missing > 0) {
        this.stats.cardsUnimported += missing;
        this.log(`WARNING: ${describeResolution(result.resolution)}: expected ${result.expectedCards} card(s) back, ` +
          `gained ${result.gainedCards} — ${missing} are ours on-chain but invisible`);
      } else {
        this.log(`${describeResolution(result.resolution)}: took back ${result.expectedCards} card(s)` +
          (result.rewardImported ? ' and the reward' : ''));
      }
      ctx.imported = true;
      this.journal?.markResolved(ctx.relayGameId, result.resolution.kind === 'unwound' ? 'unwound' : 'settled', result.txHash);
      this.recentGames.delete(ctx.relayGameId);
    } catch (err) {
      this.log(`WARNING: taking our cards back failed (${(err as Error).message}) — the sweep will retry`);
    }
  }

  /** The game as settlement and import see it. Only valid once the join has been prepared. */
  private botGame(ctx: ChainGame): BotGame {
    return {
      gameKey: ctx.channel!.gameKey,
      nonce: ctx.nonce!,
      cardIds: [...ctx.cardIds],
      record1: ctx.record1!,
      record2: ctx.record2!,
      moveProofs: [...ctx.moveProofs.values()],
      outcome: ctx.outcome,
      prizeMove: ctx.prizeMove,
    };
  }

  private rememberGame(ctx: ChainGame): void {
    this.pruneRecentGames();
    const now = this.now();
    this.recentGames.set(ctx.relayGameId, { ctx, proofsUntil: now + LATE_PROOF_WINDOW_MS, until: now + RETURN_WAIT_MS });
  }

  private recentGame(relayGameId: string): { ctx: ChainGame; proofsUntil: number; until: number } | null {
    this.pruneRecentGames();
    return this.recentGames.get(relayGameId) ?? null;
  }

  private pruneRecentGames(): void {
    const now = this.now();
    for (const [id, e] of this.recentGames) {
      if (e.until <= now) this.recentGames.delete(id);
    }
  }

  // ─── Bookkeeping ──────────────────────────────────────────────────────────

  /**
   * Record this game to the journal, if one is configured.
   *
   * Called at every point the game grows, not once at the end: the failures
   * this protects against — a crash, a kill, a machine reboot — happen MID-game
   * by definition. Only from the join onward: before it, nothing of ours is
   * at stake and there is nothing to recover.
   */
  private journalGame(ctx: ChainGame, phase?: 'joining' | 'joined'): void {
    const j = this.journal;
    if (!j || !ctx.keyPair || !ctx.opponentPublicKey || !ctx.channel
        || !ctx.nonce || !ctx.record1 || !ctx.record2) return;
    try {
      const existing = j.read(ctx.relayGameId);
      if (!existing && !phase) return;
      j.write({
        ...existing,
        version: 2,
        relayGameId: ctx.relayGameId,
        keyPair: { privateJwk: ctx.keyPair.privateJwk, publicKey: ctx.keyPair.publicKey },
        opponentPublicKey: ctx.opponentPublicKey,
        gameKey: ctx.channel.gameKey,
        nonce: ctx.nonce,
        cardIds: [...ctx.cardIds],
        record1: [...ctx.record1],
        record2: [...ctx.record2],
        moveProofs: [...ctx.moveProofs.values()].map(p => ({ ...p })),
        outcome: ctx.outcome,
        prizeMove: ctx.prizeMove,
        phase: phase ?? existing?.phase ?? 'joining',
        committedAt: existing?.committedAt ?? ctx.committedAt,
        updatedAt: this.now(),
      });
    } catch (err) {
      // Never let bookkeeping take down a live game — but do say so, because a
      // silent journal failure means silent card loss later.
      this.log(`WARNING: could not journal game: ${(err as Error).message}`);
    }
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
   * actually end the arena.
   */
  private async refreshConsumables(): Promise<void> {
    const chain = this.chain;
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
    // Nor until we can PROVE the move: both records' hand commitments and our
    // blinding. Because the proof needs the EXACT post-move board, a card
    // played before then can never be proved afterwards — by the next state it
    // may already be captured — and ONE unprovable move makes the whole game
    // unsettleable. Gated on `proofs`: a bot with no prover has nothing to
    // invalidate by moving.
    if (this.chain && this.proofs && !this.canProve(this.game)) return;

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
   * from several places — a relayed state, our join completing, the creator's
   * record arriving — and any of them can be the one that unblocks a held
   * turn. Without this, two of them schedule two PLACE_CARDs for the SAME turn:
   * the relay applies the first, the second overwrites `pendingMove` with a
   * move that never happened, and no echoed board ever matches it again — the
   * bot stops proving and stops playing. Monotonic, so it needs no clearing
   * between turns and cannot wedge us if a proof is lost.
   */
  private moveScheduledFor: number | null = null;

  /** True when the game is waiting on US to move. */
  private oweAMove(): boolean {
    const s = this.lastState;
    return !!s && s.status === 'playing' && s.currentTurn === this.myPlayer;
  }

  /**
   * End the current game without a settlement, for whatever reason found it.
   *
   * Committed cards are NOT lost here but they are locked: the bot only joins,
   * so it cannot cancel, and they come back when the sweep claims the game as
   * abandoned and finalizes the claim (both hands returned, nobody wins).
   * Counting them is what makes that visible on /health instead of being
   * discovered when the bot runs out of cards.
   */
  private abandonGame(reason: string): void {
    this.log(`${reason} — abandoning`);
    this.stats.abandonedGames += 1;
    // Tell the relay, or it keeps us bound to a game we have left and rejects
    // every queue attempt with "You are already in an active game" until its
    // stale-game sweep gets round to it. Production spent 22 minutes and 578
    // rejected attempts in exactly that state, with no opponent available to
    // anybody. The game itself stays: its transcript may still settle it.
    if (this.gameId) this.send({ type: 'LEAVE_GAME', gameId: this.gameId });
    if (this.committed) {
      this.log('WARNING: 5 cards remain committed to the abandoned game — ' +
               'they come back when the sweep claims and unwinds it');
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
    // Per-game state MUST NOT leak into the next game: a stale record or
    // blinding factor would produce proofs bound to the wrong game. The context
    // itself lives on in recentGames while its follow-up is still due.
    this.game = null;
    this.committed = false;
    this.lastState = null;
    this.pendingMove = null;
    this.moveScheduledFor = null;
    this.settling = false;
  }

  private send(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private recordError(where: string, err: Error): void {
    const message = `${where}: ${err.message}`;
    this.stats.lastError = redactForHealth(message);
    this.log(`ERROR ${message}`);
  }
}

async function defaultFetchQueue(httpUrl: string): Promise<QueueSnapshot> {
  const res = await fetch(`${httpUrl}/queue`);
  if (!res.ok) throw new Error(`/queue returned ${res.status}`);
  return await res.json() as QueueSnapshot;
}
