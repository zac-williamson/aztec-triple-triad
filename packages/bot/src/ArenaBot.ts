/**
 * The arena bot: a WebSocket client that plays like any other player.
 *
 * It deliberately uses the SAME protocol a browser uses — REGISTER_BOT only
 * marks it for matchmaking and metrics, it grants no privileged moves. So the
 * relay, the opponent's client and the chain all treat it as an ordinary
 * opponent, which is what "completely mimic a player" has to mean if the demo
 * is to be honest.
 *
 * State machine: idle → queued → playing → idle.
 *
 *   idle    poll /queue; if a human has waited past joinThresholdMs, queue
 *           ourselves (QUEUE_MATCHMAKING names no card) and let the server's
 *           normal tryMatch pair us. We never reach into matchmaking directly.
 *   queued  waiting for MATCH_FOUND. Bounded by queueTimeoutMs: if the human
 *           cancels just as we queue, an un-timed-out bot would sit in the queue
 *           and instantly grab the NEXT human, which is exactly the behaviour
 *           this feature is supposed to avoid.
 *   playing the game, run HERE. The relay is a pipe (docs/plan/PRIVATE_GAMES.md
 *           section 6): it pairs us, forwards sealed payloads and counts moves.
 *           It holds no board, hand or result, so each client runs the game
 *           itself and referees the other's proofs.
 *
 * A game is private and the bot is always the JOINER, player 2:
 *
 *   MATCH_FOUND   a key pair for this game → KEY_EXCHANGE; a local game, our
 *                 five cards against five face-down ones
 *   OPPONENT_KEY  derive the game key and the channel that seals PEER and MOVE
 *   PEER RECORD   the creator's record: wait for its `created` nullifier, read
 *                 our nonce, preview our record, join_game, PEER RECORD back
 *   OPEN_CARDS    ours: proven and sent once both records are known, before our
 *                 first move. Theirs: checked against their record's hand
 *                 commitment before they count
 *   MOVE          theirs: opened and checked — bounds, state hashes, the eight
 *                 public inputs, the proof (moveChecks.ts) — before it is
 *                 applied. Ours: chosen on the local board, proven, sealed and
 *                 sent with its move number, the only thing the relay reads
 *   ninth move    the transcript's result is the game's: a win settles
 *                 (SETTLING → settle_game → SETTLED → import our notes); a draw
 *                 gives player 1 first go at settling; a loss waits for the
 *                 winner's settlement and imports from it
 *
 * Anything of theirs that fails a check halts the game for the bot: such a game
 * can never settle, so the bot leaves it and its cards to the abandonment sweep.
 * A dropped socket resumes the same relay session (RESUME → ROOM_STATE), and any
 * of our moves the relay never got goes again.
 *
 * Every import is from the tx that resolved the game, found by the game's own
 * `done` nullifier — a SETTLED message is only a hint. Nothing about the human
 * beyond what the game itself reveals ever reaches the bot.
 */
import WebSocket from 'ws';
import { chooseBotMove } from '@axolotl-arena/game-logic';
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
  moverOf,
  normalizeField,
  NULLIFIER_INDEX,
  placedOf,
  RECORD_HAND,
  sameRecord,
  type GameRecord,
  type GameSecrets,
} from '../../frontend/src/aztec/privateGame.js';
import {
  parseMovePayload,
  planOwnMove,
  replay,
  winnerIdOf,
  type GameMove,
  type LocalGameFacts,
  type MovePayload,
  type OpenCardsPayload,
  type TranscriptMove,
} from '../../frontend/src/aztec/localGame.js';
import { checkOpenCards, checkOpponentMove } from '../../frontend/src/aztec/moveChecks.js';
import { TOTAL_MOVES } from '../../frontend/src/aztec/gameConstants.js';
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

/**
 * Opponent MOVEs held unchecked: nine numbers, each possibly delivered twice
 * (once live, once replayed after a resume). Bounded, so a confused peer
 * cannot grow it.
 */
const MAX_INBOX = 2 * TOTAL_MOVES;

/**
 * When a check could not RUN (the verifier itself threw), how long before the
 * payload is checked again. Such a failure says nothing about the payload, so
 * it is never held against the opponent; the game's own timeout bounds how
 * long this goes on.
 */
const RECHECK_MS = 30_000;

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

/**
 * Why the opponent's payload was refused, fit for a log: every number and
 * field value replaced by `#`. A check's reason can name the card a move
 * played, the slot it came from or the open cards it contradicts, and the
 * human's hand is theirs — even when they cheat.
 */
export function withoutCardDetails(reason: string): string {
  return reason.replace(/0x[0-9a-fA-F]+|\d+/g, '#');
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const sameCards = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((c, i) => c === b[i]);

const sameMove = (a: GameMove, b: GameMove): boolean =>
  a.cardId === b.cardId && a.slot === b.slot && a.row === b.row && a.col === b.col;

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
  /** Moves in the transcript, each with its proof — what a settlement is built from. */
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
  /** Games played to the ninth move, and how they ended — the bot's own count; the relay cannot know. */
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  joinFailures: number;
  moveFailures: number;
  /** join_game failures. */
  commitFailures: number;
  /** Failures to prove (or to run a check of the opponent's proof). */
  proofFailures: number;
  /** Settlement failures, and successful settlements. */
  settleFailures: number;
  settlements: number;
  /**
   * Games halted because the opponent sent a move or open cards that did not
   * check out. Rare from a real player; a run of them means our checks and the
   * players' clients disagree — which ends every game the bot plays.
   */
  opponentFaults: number;
  /** Games abandoned by the watchdog, and cards left locked in them. */
  abandonedGames: number;
  cardsStranded: number;
  /**
   * Cards the bot could field at its last hand selection, or -1 if never read.
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
   * Chain adapter. Without it, and a prover, the bot never queues: every move
   * carries a proof over both players' committed hands, so a bot that cannot
   * commit cannot play. (Optional only so tests of the parts that do not play
   * stay cheap.)
   */
  chain?: BotChainLike;
  /**
   * Persists each committed game so it can be recovered if this process dies.
   * Optional: without it the bot plays identically, but a game interrupted
   * mid-way keeps its five cards until someone else resolves it.
   */
  journal?: BotJournal;
  /** Proofs, and the checks of the opponent's. Required alongside `chain`. */
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

/** An opponent MOVE as the relay delivered it: still sealed, not yet checked. */
interface InboundMove extends SealedPayload {
  moveNumber: number;
}

/** One game, from MATCH_FOUND until it is resolved. Lives on past the ninth move until then. */
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

  // ── The game itself (section 6.2) ──
  /** The transcript: our moves as sent, theirs as checked, in move order. */
  moves: TranscriptMove[];
  /** The opponent's three open cards, once their proof checked out. */
  opponentOpen: number[] | null;
  /** Their OPEN_CARDS as delivered, until it is checked. */
  openCardsClaim: OpenCardsPayload | null;
  /** Their MOVEs as delivered, until each is checked. */
  inbox: InboundMove[];
  /** The checks of what they sent, one at a time, in order. */
  inbound: Promise<void>;
  /** A check that could not run, waiting to go again. */
  recheck: NodeJS.Timeout | null;
  /** Our open cards, proven: sent once both records are known, and again after a resume. */
  ownOpen: OpenCardsPayload | null;
  ownOpenTask: Promise<void> | null;
  /** The number of our move being chosen and proven: one move per turn. */
  moveInFlight: number | null;
  /** The connection each of our moves last went out on: a resume resends only what it has not. */
  sentOn: Map<number, WebSocket>;
  /** Why the opponent's play was refused. Set, the game cannot settle and is the sweep's. */
  protocolError: string | null;

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

function newGame(relayGameId: string, cardIds: number[]): ChainGame {
  return {
    relayGameId, cardIds: [...cardIds],
    keyPair: null, opponentPublicKey: null, channel: null, deriving: false, pendingPeer: [],
    record1: null, record2: null, nonce: null, secrets: null,
    joinStarted: false, committed: false, committedAt: 0,
    moves: [], opponentOpen: null, openCardsClaim: null, inbox: [], inbound: Promise.resolve(), recheck: null,
    ownOpen: null, ownOpenTask: null, moveInFlight: null, sentOn: new Map(), protocolError: null,
    outcome: null, prizeMove: null, settlingSelf: false, settledHint: null,
    importing: null, imported: false,
  };
}

export class ArenaBot {
  private ws: WebSocket | null = null;
  private state: BotState = 'idle';
  private gameId: string | null = null;
  private queuedAt = 0;
  private hand: number[] = [];
  /** The current game. */
  private game: ChainGame | null = null;
  /** Suppresses repeat logging of a persistent card shortage. */
  private handShortageLogged = false;
  /** Suppresses repeat logging of a bot that cannot play at all. */
  private unplayableLogged = false;
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
  /** Move proofs still generating — shutdown waits for them. */
  private proving = 0;
  private settling = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private registered = false;
  /**
   * The relay session. Kept so a dropped socket RESUMEs it: the room knows us
   * by the session's player id, so a fresh session mid-game is a stranger to
   * our own game, and whatever the relay buffered for us is lost with it.
   */
  private sessionToken: string | null = null;
  /**
   * Games that ended but are not resolved yet, by relay room id: the winner's
   * SETTLING/SETTLED land after we reset.
   */
  private readonly recentGames = new Map<string, { ctx: ChainGame; until: number }>();

  private readonly stats: Omit<BotStats, 'state' | 'game' | 'journal'> = {
    gamesPlayed: 0, wins: 0, losses: 0, draws: 0,
    joinFailures: 0, moveFailures: 0, commitFailures: 0, proofFailures: 0, settleFailures: 0, settlements: 0,
    opponentFaults: 0, abandonedGames: 0, cardsStranded: 0, spendableCards: -1,
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
    const ctx = this.game;
    return {
      relayGameId: this.gameId,
      playerNumber: BOT_SIDE,
      keyed: ctx?.channel != null,
      opponentRecord: ctx?.record1 != null,
      committed: ctx?.committed ?? false,
      moveProofs: ctx?.moves.length ?? 0,
      oweAMove: ctx ? this.oweAMove(ctx) : false,
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
   * A proof in flight at shutdown is a move the opponent is waiting for. It is
   * finished, journalled and sent rather than thrown away, so the transcript
   * both sides hold is as long as the game actually got. Everything else is
   * recoverable without us: an unfinished game is claimed and unwound from the
   * journal by the next process. Bounded well inside systemd's 90s stop
   * timeout, because being killed halfway is worse than leaving promptly.
   */
  async shutdown(maxMs = 60_000): Promise<void> {
    if (this.proving > 0) {
      this.log('shutting down with a move proof in flight — letting it finish so the transcript stays whole');
      const deadline = this.now() + maxMs;
      while (this.now() < deadline && this.proving > 0) await sleep(250);
      if (this.proving > 0) this.log('WARNING: a move proof was still generating at exit; that move was never sent');
    }
    this.stop();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.game?.recheck) clearTimeout(this.game.recheck);
    this.ws?.close();
    this.ws = null;
  }

  private openSocket(): void {
    const ws = this.connect(this.cfg.wsUrl);
    this.ws = ws;
    ws.on('open', () => {
      // RESUME, if we have a session, must be the FIRST frame: the relay only
      // reads one as a resume before it hands out a fresh session. Anything
      // else — REGISTER_BOT included — waits for SESSION_ESTABLISHED, exactly
      // as the browser client does: a frame sent before this connection has an
      // identity is dropped.
      if (this.sessionToken) {
        this.log('connected; resuming our session');
        ws.send(JSON.stringify({ type: 'RESUME', sessionToken: this.sessionToken }));
      } else {
        this.log('connected; awaiting session');
      }
    });
    ws.on('message', (raw: WebSocket.RawData) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); }
      catch { return this.recordError('parse', new Error('non-JSON frame')); }
      this.handle(msg);
    });
    ws.on('close', () => {
      this.registered = false;
      if (this.state === 'queued') {
        // The relay drops a closed socket from the queue.
        this.log('socket closed while queued; back to idle');
        this.resetToIdle();
      } else if (this.state === 'playing') {
        // The room knows us by our session: resuming it keeps our seat, and
        // the relay buffers what the opponent sends meanwhile.
        this.log('socket closed mid-game; resuming the session on reconnect');
      }
      if (!this.stopped) setTimeout(() => this.openSocket(), this.cfg.pollIntervalMs);
    });
    ws.on('error', err => this.recordError('socket', err as Error));
  }

  /** One poll: the stuck-game watchdogs, then whether to offer ourselves as an opponent. */
  private async tick(): Promise<void> {
    if (this.stopped) return;

    // Whether or not the relay is reachable: a game these end is unwound by the
    // sweep, and the sweep never runs while we are 'playing'.
    if (this.state === 'playing') {
      // An opponent who never commits, or vanishes mid-game, would otherwise
      // park us here forever — taking no further players and leaving our five
      // committed cards waiting. Not while settling: that is a finished game,
      // bounded by its own waits.
      if (!this.settling && this.gameStartedAt > 0
          && this.now() - this.gameStartedAt > this.cfg.gameTimeoutMs) {
        this.abandonGame(`game exceeded ${Math.round(this.cfg.gameTimeoutMs / 60_000)}min`);
        return;
      }
      // A creator who never sends their record never committed anything we
      // could join. Nothing of ours is at stake, so there is no reason to hold
      // the arena's only opponent for the full game timeout.
      if (this.game && !this.game.record1 && this.gameStartedAt > 0
          && this.now() - this.gameStartedAt > (this.cfg.recordWaitMs ?? DEFAULT_RECORD_WAIT_MS)) {
        this.abandonGame('the creator never sent their game record');
        return;
      }
      // A departure the relay already witnessed. Same ending as the watchdog's,
      // reached in a minute and a half instead of thirty.
      if (!this.settling && this.opponentGoneSince !== null
          && this.now() - this.opponentGoneSince > this.cfg.opponentGraceMs) {
        this.abandonGame('opponent disconnected and did not come back');
      }
      return;
    }

    if (!this.registered) return;

    if (this.state === 'queued' && this.now() - this.queuedAt > this.cfg.queueTimeoutMs) {
      this.log('queue timeout; leaving the queue');
      this.send({ type: 'CANCEL_MATCHMAKING' });
      this.resetToIdle();
      return;
    }
    if (this.state !== 'idle') return;

    // Every move carries a proof over both players' committed hands, so a bot
    // that cannot commit or prove cannot play a game at all. Matching a human
    // it can never move against is worse than not offering.
    const chain = this.chain;
    if (!chain || !this.proofs) {
      if (!this.unplayableLogged) {
        this.unplayableLogged = true;
        this.log('not offering games: playing one needs a chain and a prover');
      }
      return;
    }

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

    // The hand must come from what the bot ACTUALLY holds — its collection
    // shrinks every time a player beats it. Chosen now, committed at the join,
    // and named to nobody: the queue message carries no card.
    let hand: number[];
    try {
      hand = await chain.selectHand(5);
      this.stats.spendableCards = (chain as { lastKnownCardCount?: number }).lastKnownCardCount ?? -1;
      // Same cadence as the card count: both are things that end the arena
      // quietly when they hit zero, and both are cheap to read here.
      await chain.readFeeJuice?.()
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

    // selectHand() is async too — same hazard.
    if (this.state !== 'idle') return;

    this.log(`human waiting ${Math.round(snap.oldestWaitMs / 1000)}s — offering a game`);
    this.state = 'queued';
    this.queuedAt = this.now();
    this.hand = hand;
    this.send({ type: 'QUEUE_MATCHMAKING' });
  }

  private handle(msg: any): void {
    switch (msg?.type) {
      case 'SESSION_ESTABLISHED':
        this.onSession(msg);
        break;

      case 'BOT_REGISTERED':
        this.registered = true;
        this.log('registered with the relay');
        break;

      case 'MATCH_FOUND':
        this.onMatch(msg);
        break;

      case 'OPPONENT_KEY':
        this.onOpponentKey(msg);
        break;

      case 'PEER':
        this.onPeer(msg);
        break;

      case 'MOVE':
        this.onMove(msg);
        break;

      case 'ROOM_STATE':
        this.onRoomState(msg);
        break;

      // The relay holds a 60s window for a dropped player to resume their
      // session, so a blip is not a departure; we wait that out plus a margin
      // before giving up. Reconnecting cancels it outright.
      case 'OPPONENT_DISCONNECTED':
        if (this.state === 'playing' && msg.gameId === this.gameId && !this.settling && this.opponentGoneSince === null) {
          this.opponentGoneSince = this.now();
          this.log(`opponent disconnected — giving them ` +
            `${Math.round(this.cfg.opponentGraceMs / 1000)}s to come back`);
        }
        break;

      case 'OPPONENT_RECONNECTED':
        if (msg.gameId === this.gameId && this.opponentGoneSince !== null) {
          this.log(`opponent reconnected after ` +
            `${Math.round((this.now() - this.opponentGoneSince) / 1000)}s — carrying on`);
          this.opponentGoneSince = null;
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

  // ─── The relay session ─────────────────────────────────────────────────────

  private onSession(msg: any): void {
    const resumed = msg.resumed === true;
    if (typeof msg.sessionToken === 'string' && msg.sessionToken) this.sessionToken = msg.sessionToken;
    this.log(resumed ? 'session resumed; registering as bot' : 'session established; registering as bot');
    // Per connection: the relay forgets a bot's registration when its socket drops.
    this.send({ type: 'REGISTER_BOT', token: this.cfg.token });

    const ctx = this.game;
    if (this.state === 'playing' && ctx && !this.settling && ctx.moves.length < TOTAL_MOVES) {
      // Mid-game, the room knows us only by the session we just lost or kept.
      // Without our seat nothing we send reaches the opponent, so there is no
      // game left to play: it is the sweep's.
      if (!resumed) this.abandonGame('the relay did not resume our session — our seat in the game is gone');
      else if (msg.gameId !== ctx.relayGameId) this.abandonGame('the relay no longer has us in the game');
      // Otherwise ROOM_STATE follows, after the relay replays what it buffered.
    }
    // Resumed into a game we are not playing — we left it while the socket was
    // down, so the relay never heard. Leave it now, or every queue attempt is
    // refused "You are already in an active game".
    if (resumed && typeof msg.gameId === 'string' && msg.gameId && msg.gameId !== this.gameId) {
      this.send({ type: 'LEAVE_GAME', gameId: msg.gameId });
    }
  }

  /**
   * After a RESUME the relay replays what it buffered, then says where the room
   * stands. Whatever we sent while the socket was down never left: it goes
   * again, and each piece is one the other side takes only once.
   */
  private onRoomState(msg: any): void {
    const ctx = this.game;
    if (!ctx || msg.gameId !== ctx.relayGameId) return;
    const movesMade = Number(msg.movesMade);
    if (!Number.isInteger(movesMade) || movesMade < 0) return;
    this.log(`back in the game: the relay holds ${movesMade} move(s), we hold ${ctx.moves.length}`);

    if (msg.opponentConnected === false) {
      if (this.opponentGoneSince === null && !this.settling) this.opponentGoneSince = this.now();
    } else if (msg.opponentConnected === true) {
      this.opponentGoneSince = null;
    }

    // No record from them yet: they may not have our key either.
    if (ctx.keyPair && !ctx.record1) {
      this.send({ type: 'KEY_EXCHANGE', gameId: ctx.relayGameId, publicKey: ctx.keyPair.publicKey });
    }
    void (async () => {
      if (ctx.committed && ctx.record2) {
        this.send({ type: 'TX_CONFIRMED', gameId: ctx.relayGameId, txType: 'join_game' });
        await this.sendPeer(ctx, { kind: 'RECORD', record: ctx.record2 });
      }
      if (ctx.ownOpen) await this.sendPeer(ctx, { kind: 'OPEN_CARDS', ...ctx.ownOpen });
      // The relay takes moves strictly in order, so it holds every move before
      // `movesMade` and none after: ours from there on never reached it —
      // unless it went out on this connection, after the relay counted.
      for (const m of ctx.moves) {
        if (m.moveNumber < movesMade || moverOf(m.moveNumber) !== BOT_SIDE) continue;
        if (this.ws && ctx.sentOn.get(m.moveNumber) === this.ws) continue;
        await this.sendOwnMove(ctx, m);
      }
    })().catch(err => this.log(`WARNING: could not resend after the resume (${(err as Error).message})`));
    if (movesMade > ctx.moves.length + (ctx.moveInFlight !== null ? 1 : 0)) {
      this.log(`the relay holds ${movesMade} moves, we have ${ctx.moves.length} — waiting for the rest`);
    }
    this.kickInbound(ctx);
  }

  // ─── Matching, the key exchange and the PEER channel ──────────────────────

  private onMatch(msg: any): void {
    const gameId = typeof msg.gameId === 'string' && msg.gameId ? msg.gameId : null;
    if (!gameId) return;
    // The bot JOINS games; it never creates them. The server orders the pair
    // so a bot is never the creator, but if that ever failed we must not
    // silently start creating games and wagering cards as player 1 — leave
    // immediately and let a human take the slot.
    if (msg.playerNumber !== BOT_SIDE) {
      this.stats.joinFailures += 1;
      this.recordError('match', new Error('assigned as game CREATOR — the bot only joins; leaving'));
      this.send({ type: 'LEAVE_GAME', gameId });
      this.resetToIdle();
      return;
    }
    if (this.state === 'playing') {
      this.log('ignoring a second match while a game is in progress');
      return;
    }
    if (!this.chain || !this.proofs) {
      // tick() never queues without them; leave rather than hold a human to a
      // game we cannot move in.
      this.send({ type: 'LEAVE_GAME', gameId });
      this.resetToIdle();
      return;
    }
    this.gameId = gameId;
    this.state = 'playing';
    this.gameStartedAt = this.now();
    // One skill for the whole game. Re-rolling per move would make the bot
    // alternate between brilliant and careless within a single game, which
    // reads as broken rather than as a weaker opponent.
    this.gameSkill = this.rollSkill();
    this.log(`matched into ${gameId} as player ${BOT_SIDE} (skill ${this.gameSkill.toFixed(2)})`);
    // The game starts here, as ours to run: our five cards against five face down.
    const ctx = newGame(gameId, this.hand);
    this.game = ctx;
    this.beginKeyExchange(ctx);
    // The verification keys take seconds: computed while the join runs, not
    // when the creator's first move is waiting on them.
    void this.proofs.prepareChecks?.().catch(err =>
      this.log(`WARNING: could not prepare the proof checks (${(err as Error).message})`));
  }

  private keys(): Promise<GameKeysLike> {
    if (!this.keysModule) {
      this.keysModule = this.injectedKeys
        ? Promise.resolve(this.injectedKeys)
        : import('../../frontend/src/aztec/gameKeys.js');
    }
    return this.keysModule;
  }

  /** A fresh key pair for this game, its public half to the opponent. */
  private beginKeyExchange(ctx: ChainGame): void {
    void (async () => {
      const keys = await this.keys();
      ctx.keyPair = await keys.generateGameKeyPair();
      if (this.game !== ctx) return;
      this.send({ type: 'KEY_EXCHANGE', gameId: ctx.relayGameId, publicKey: ctx.keyPair.publicKey });
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

  /** Once both public keys are known: the game key and the channel. Then anything that was waiting on it. */
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
    this.kickInbound(ctx);
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

      case 'OPEN_CARDS': {
        if (ctx !== this.game || ctx.protocolError) return;
        const claim: OpenCardsPayload = { cards: p.cards, proof: p.proof, publicInputs: p.publicInputs };
        if (ctx.opponentOpen) {
          // A repeat — they send theirs again after a reconnect — changes
          // nothing. A different set is a hand that changed mid-game.
          if (!sameCards(ctx.opponentOpen, claim.cards)) {
            this.refuse(ctx, 'their open cards', 'a second, different set of open cards');
          }
          return;
        }
        // Checked in order with their moves, once both records are known.
        ctx.openCardsClaim = claim;
        this.kickInbound(ctx);
        return;
      }

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
      this.send({ type: 'TX_CONFIRMED', gameId: ctx.relayGameId, txType: 'join_game' });
      await this.sendPeer(ctx, { kind: 'RECORD', record: record2 });
      this.log('our record sent to the creator');
      // Both records are known: our open cards, then whatever they have sent.
      void this.ensureOwnOpenCards(ctx);
      this.kickInbound(ctx);
      this.maybeMove(ctx);
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

  // ─── The game ─────────────────────────────────────────────────────────────

  /** Everything the board is rebuilt from: our hand, their proven open cards, the transcript. */
  private facts(ctx: ChainGame): LocalGameFacts {
    return { role: BOT_SIDE, ownHand: ctx.cardIds, opponentOpen: ctx.opponentOpen, moves: ctx.moves };
  }

  /** True when the game is waiting on US to move. */
  private oweAMove(ctx: ChainGame): boolean {
    try {
      const { state } = replay(this.facts(ctx));
      return state.status === 'playing' && state.currentTurn === 'player2';
    } catch {
      return false;
    }
  }

  /**
   * Prove and send our three open cards, once both records are known and
   * before our first move — so the opponent sees our hand before our first
   * card lands. Proven once: a failure is reported, not retried, and play goes
   * on; the opponent's client then shows our whole hand face down, and nothing
   * else needs it.
   */
  private ensureOwnOpenCards(ctx: ChainGame): Promise<void> {
    if (ctx.ownOpenTask) return ctx.ownOpenTask;
    const proofs = this.proofs;
    const { record2, secrets } = ctx;
    if (!proofs || !record2 || !secrets || !ctx.committed) return Promise.resolve();
    ctx.ownOpenTask = (async () => {
      try {
        const payload = await proofs.proveOpenCards(ctx.cardIds, secrets.blinding, record2[RECORD_HAND]);
        ctx.ownOpen = payload;
        this.journalGame(ctx);
        if (this.game !== ctx) return;
        await this.sendPeer(ctx, { kind: 'OPEN_CARDS', ...payload });
        this.log('our open cards proved and sent');
      } catch (err) {
        this.stats.proofFailures += 1;
        this.recordError('open-cards', new Error(
          `our open cards could not be proved or sent (${(err as Error).message}) — the opponent sees our hand face down`));
      }
    })();
    return ctx.ownOpenTask;
  }

  /** An opponent MOVE from the relay: kept as delivered, then checked in order. */
  private onMove(msg: any): void {
    const ctx = this.game;
    if (!ctx || msg.gameId !== ctx.relayGameId) return;
    const n = msg.moveNumber;
    if (!Number.isInteger(n) || n < 0 || n >= TOTAL_MOVES) return;
    if (typeof msg.iv !== 'string' || typeof msg.ciphertext !== 'string') return;
    // The same frame twice (a replay of something still unchecked) is one move.
    if (ctx.inbox.some(e => e.moveNumber === n && e.ciphertext === msg.ciphertext)) return;
    if (ctx.inbox.length >= MAX_INBOX) {
      this.log('dropped a MOVE: too many unchecked moves held for this game');
      return;
    }
    ctx.inbox.push({ moveNumber: n, iv: msg.iv, ciphertext: msg.ciphertext });
    this.kickInbound(ctx);
  }

  /** Check whatever the opponent has sent, one item at a time, in order. */
  private kickInbound(ctx: ChainGame): void {
    ctx.inbound = ctx.inbound
      .then(() => this.processInbound(ctx))
      .catch(err => this.recordError('check', new Error(withoutCardDetails((err as Error).message))));
  }

  /**
   * The referee (section 6.3). Their open cards first — they decide how their
   * hand is read — then their moves, strictly in order: each opened, checked
   * against our board (bounds, the state hashes before and after, all eight
   * public inputs, the proof) and only then applied. Nothing is checked before
   * both records — both hand commitments — are known and our cards are in.
   */
  private async processInbound(ctx: ChainGame): Promise<void> {
    const proofs = this.proofs;
    for (;;) {
      if (!proofs || this.game !== ctx || ctx.protocolError) return;
      const { record1, record2, channel } = ctx;
      if (!record1 || !record2 || !channel || !ctx.committed) return;
      const commits = { commit1: record1[RECORD_HAND], commit2: record2[RECORD_HAND] };
      const facts = this.facts(ctx);

      const claim = ctx.openCardsClaim;
      if (claim) {
        ctx.openCardsClaim = null;
        if (ctx.opponentOpen) {
          if (!sameCards(ctx.opponentOpen, claim.cards)) {
            return this.refuse(ctx, 'their open cards', 'a second, different set of open cards');
          }
          continue;
        }
        const result = await proofs.check(c => checkOpenCards(facts, commits.commit1, claim, c));
        if (this.game !== ctx || ctx.protocolError) return;
        if (!result.ok) {
          if (result.retryable) {
            ctx.openCardsClaim ??= claim;
            return this.recheckLater(ctx, 'their open cards', result.reason);
          }
          return this.refuse(ctx, 'their open cards', result.reason);
        }
        ctx.opponentOpen = result.value;
        this.journalGame(ctx);
        this.log('their open cards check out');
        continue;
      }

      // The next move to check, or a stale copy of one already in. Anything
      // beyond a gap waits for the moves before it.
      const entry = ctx.inbox
        .filter(e => e.moveNumber <= ctx.moves.length)
        .sort((a, b) => a.moveNumber - b.moveNumber)[0];
      if (!entry) return;
      const drop = () => { ctx.inbox = ctx.inbox.filter(e => e !== entry); };
      const n = entry.moveNumber;

      let payload: MovePayload;
      try {
        payload = await this.openMove(ctx.relayGameId, channel, entry);
      } catch {
        if (this.game !== ctx || ctx.protocolError) return;
        // A stale copy that does not open loses nothing: that move is in already.
        if (n < ctx.moves.length) { drop(); continue; }
        return this.refuse(ctx, `their move ${n}`, 'it does not open: tampered with, or sealed for another game');
      }
      if (this.game !== ctx || ctx.protocolError) return;

      if (n < ctx.moves.length) {
        // Delivered again — the relay replays its buffer after a resume. The
        // same move is fine; a different one under the same number is not.
        drop();
        if (sameMove(ctx.moves[n], { ...payload, moveNumber: n })) continue;
        return this.refuse(ctx, `their move ${n}`, 'a second, different move with the same number');
      }

      const result = await proofs.check(c => checkOpponentMove(facts, commits, n, payload, c));
      if (this.game !== ctx || ctx.protocolError) return;
      // The game moved on while this was checked: look again from the top.
      if (ctx.moves.length !== n) continue;
      if (!result.ok) {
        if (result.retryable) return this.recheckLater(ctx, `their move ${n}`, result.reason);
        return this.refuse(ctx, `their move ${n}`, result.reason);
      }
      drop();
      ctx.moves.push(result.value);
      this.journalGame(ctx);
      this.afterMove(ctx);
    }
  }

  private async openMove(room: string, channel: GameChannel, sealed: SealedPayload): Promise<MovePayload> {
    const keys = await this.keys();
    return parseMovePayload(await keys.openPeerPayload(channel.channelKey, room, sealed));
  }

  /**
   * The opponent sent something that does not check out. The game can never
   * settle — settlement verifies every move, and this one would not pass — so
   * the bot stops playing it and leaves it, with its cards, to the abandonment
   * sweep: claim, dispute window, both hands back. The reason is logged and
   * journalled without card details.
   */
  private refuse(ctx: ChainGame, what: string, reason: string): void {
    const why = `${what}: ${withoutCardDetails(reason)}`;
    ctx.protocolError = why;
    ctx.openCardsClaim = null;
    ctx.inbox = [];
    this.stats.opponentFaults += 1;
    this.recordError('opponent', new Error(`refused ${why}`));
    this.journalGame(ctx);
    if (this.game === ctx) {
      this.abandonGame('the opponent broke the protocol, so the game can never settle — the abandonment sweep has it');
    }
  }

  /** A check that could not run says nothing about the payload: it stays, and is checked again later. */
  private recheckLater(ctx: ChainGame, what: string, reason: string): void {
    this.stats.proofFailures += 1;
    this.recordError('check', new Error(`${what} could not be checked (${withoutCardDetails(reason)}) — trying again`));
    if (ctx.recheck) return;
    ctx.recheck = setTimeout(() => {
      ctx.recheck = null;
      this.kickInbound(ctx);
    }, RECHECK_MS);
    ctx.recheck.unref?.();
  }

  /** A move is in the transcript: the game is over, or it may be our turn. */
  private afterMove(ctx: ChainGame): void {
    let state;
    try {
      state = replay(this.facts(ctx)).state;
    } catch (err) {
      // Every move was checked against this board before it went in.
      this.recordError('replay', err as Error);
      return;
    }
    if (state.status === 'finished') {
      this.gameOver(ctx, state.winner ?? 'draw');
      return;
    }
    this.maybeMove(ctx);
  }

  /** Play if, and only if, it is our turn in a live game whose moves we can prove. */
  private maybeMove(ctx: ChainGame): void {
    if (this.game !== ctx || this.state !== 'playing' || ctx.protocolError) return;
    // Not before OUR cards are committed and both records and our blinding are
    // known: every move proof binds both hand commitments, and a move we
    // cannot prove is one we must not make.
    if (!ctx.committed || !ctx.record1 || !ctx.record2 || !ctx.secrets || !ctx.channel) return;
    // One move per turn, however many callers reach here: our move is chosen
    // and proven once, and a second attempt would put a different card down.
    if (ctx.moveInFlight !== null) return;
    if (!this.oweAMove(ctx)) return;
    const moveNumber = ctx.moves.length;
    ctx.moveInFlight = moveNumber;
    setTimeout(() => { void this.playOwnMove(ctx, moveNumber); }, this.cfg.moveDelayMs);
  }

  /**
   * Our move `moveNumber`: chosen on our own board, proven from the boards
   * before and after it — the same boards, scores and hashes the opponent
   * rebuilds to check it — journalled, then sealed and sent. The relay reads
   * its number and nothing else.
   */
  private async playOwnMove(ctx: ChainGame, moveNumber: number): Promise<void> {
    const proofs = this.proofs;
    const live = () => !this.stopped && this.game === ctx && this.state === 'playing'
      && !ctx.protocolError && ctx.moves.length === moveNumber;
    try {
      if (!proofs || !live()) return;
      await this.ensureOwnOpenCards(ctx);
      if (!live()) return;

      const facts = this.facts(ctx);
      const before = replay(facts);
      let move: GameMove;
      try {
        // No seed in production: play should not be predictable from the board.
        // The harness sets one when it needs a reproducible OUTCOME.
        const choice = chooseBotMove(before.state, {
          difficulty: this.cfg.difficulty,
          skill: this.gameSkill,
          ...(this.cfg.moveSeed !== undefined ? { seed: this.cfg.moveSeed } : {}),
        });
        move = planOwnMove(facts, before, choice.handIndex, choice.row, choice.col);
      } catch (err) {
        this.stats.moveFailures += 1;
        this.recordError('choose-move', err as Error);
        return this.giveUp(ctx, 'we could not choose a move');
      }
      const after = replay({ ...facts, moves: [...facts.moves, move] }).state;
      const ended = after.status === 'finished';

      this.proving += 1;
      let raw: MoveProofData;
      try {
        raw = await proofs.proveMove({
          cardId: move.cardId, row: move.row, col: move.col, currentPlayer: BOT_SIDE,
          boardBefore: before.state.board, boardAfter: after.board,
          scoresBefore: [before.state.player1Score, before.state.player2Score],
          scoresAfter: [after.player1Score, after.player2Score],
          cardCommit1: ctx.record1![RECORD_HAND],
          cardCommit2: ctx.record2![RECORD_HAND],
          gameEnded: ended,
          winnerId: winnerIdOf(ended ? after.winner : null),
          hand: { cardIds: [...ctx.cardIds], blindingFactor: ctx.secrets!.blinding },
        });
      } catch (err) {
        this.stats.proofFailures += 1;
        this.recordError('move-proof', new Error(`move ${moveNumber} could not be proved: ${(err as Error).message}`));
        return this.giveUp(ctx, `our move ${moveNumber} could not be proved`);
      } finally {
        this.proving -= 1;
      }
      const proof = normalizeMoveProof(raw);
      if (!proof || placedOf(proof).cardId !== move.cardId || placedOf(proof).slot !== move.slot) {
        this.stats.proofFailures += 1;
        this.recordError('move-proof', new Error(`move ${moveNumber} produced a proof that is not of this move`));
        return this.giveUp(ctx, `our move ${moveNumber} could not be proved`);
      }
      // The game ended under us while we proved (abandoned): the move was never
      // sent, and a transcript only ever holds what both sides have.
      if (!live()) return;
      const link: TranscriptMove = { ...move, proof };
      ctx.moves.push(link);
      // Written down BEFORE it is sent: after a resume we must know every move
      // the relay may have.
      this.journalGame(ctx);
      await this.sendOwnMove(ctx, link);
      this.log(`move ${moveNumber} proved and sent`);
    } finally {
      if (ctx.moveInFlight === moveNumber) ctx.moveInFlight = null;
    }
    if (ctx.moves.length > moveNumber) {
      this.afterMove(ctx);
      // Anything held for after this move can be checked now.
      this.kickInbound(ctx);
    }
  }

  /**
   * Our own move failed, and it is not retried. Nothing was sent, so both
   * transcripts still agree — but the opponent waits on a move that will not
   * come, so the game is over for us: leave it now, its cards to the sweep,
   * rather than hold the arena's opponent until the watchdog.
   */
  private giveUp(ctx: ChainGame, why: string): void {
    if (this.game === ctx) this.abandonGame(`${why} — the game cannot go on`);
  }

  private async sendOwnMove(ctx: ChainGame, link: TranscriptMove): Promise<void> {
    try {
      const channel = ctx.channel;
      if (!channel) throw new Error('no channel to the opponent');
      const keys = await this.keys();
      const body: MovePayload = {
        cardId: link.cardId, slot: link.slot, row: link.row, col: link.col,
        proof: link.proof.proof, publicInputs: link.proof.publicInputs,
      };
      const sealed = await keys.sealPeerPayload(channel.channelKey, ctx.relayGameId, body);
      const ws = this.ws;
      if (this.send({ type: 'MOVE', gameId: ctx.relayGameId, moveNumber: link.moveNumber, iv: sealed.iv, ciphertext: sealed.ciphertext }) && ws) {
        ctx.sentOn.set(link.moveNumber, ws);
      }
    } catch (err) {
      // It is in the transcript: ROOM_STATE after a resume sends it again.
      this.log(`WARNING: could not send move ${link.moveNumber} (${(err as Error).message})`);
    }
  }

  /**
   * All nine moves are in, each checked: the result is the transcript's. The
   * bot counts its own results — the relay cannot know them.
   */
  private gameOver(ctx: ChainGame, winner: 'player1' | 'player2' | 'draw'): void {
    if (ctx.outcome !== null) return;
    const outcome = outcomeFor(winner, 'player2');
    ctx.outcome = outcome;
    this.stats.gamesPlayed += 1;
    if (outcome === 'draw') this.stats.draws += 1;
    else if (outcome === 'win') this.stats.wins += 1;
    else this.stats.losses += 1;
    this.log(`game over: ${outcome === 'draw' ? 'a draw' : outcome === 'win' ? 'we won' : 'we lost'}`);
    this.journalGame(ctx);
    // Keep the door open for what lands after we reset: the SETTLING / SETTLED.
    this.rememberGame(ctx);
    if (outcome === 'loss') {
      // The winner settles, and their SETTLED (or, failing that, the sweep
      // finding the settlement on-chain) brings our cards back.
      this.resetToIdle();
      return;
    }
    // Reset only if we are still on this game — never out of a later one.
    void this.settle(ctx, outcome).catch(err => {
      this.stats.settleFailures += 1;
      this.recordError('settle', err as Error);
    }).finally(() => { if (this.game === ctx) this.resetToIdle(); });
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
    } else if (ctx.settledHint !== null || ctx.importing) {
      // Anyone may settle, and they say they have: look before proving a
      // second settlement, which can only revert.
      if (await this.resolvedElsewhere(ctx, 'the game was settled by the other side')) return;
    }

    const game = this.botGame(ctx);
    // Fails loudly with WHAT is wrong: an incomplete or mismatched transcript
    // otherwise surfaces as an opaque on-chain revert after the proving.
    const { ordered, winner } = checkTranscript(game.moveProofs, game.record1, game.record2);
    const expected = outcome === 'draw' ? 'draw' : BOT_SIDE;
    if (winner !== expected) {
      this.log(`WARNING: our board says ${outcome} but the proofs say ${winner === 'draw' ? 'a draw' : `player ${winner} won`} — settling what the proofs prove`);
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
      moveProofs: ctx.moves.map(m => m.proof),
      outcome: ctx.outcome,
      prizeMove: ctx.prizeMove,
    };
  }

  private rememberGame(ctx: ChainGame): void {
    this.pruneRecentGames();
    this.recentGames.set(ctx.relayGameId, { ctx, until: this.now() + RETURN_WAIT_MS });
  }

  private recentGame(relayGameId: string): { ctx: ChainGame; until: number } | null {
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
   *
   * Of the human it keeps only what the game revealed: their record and public
   * key, the moves they made (with their proofs) and their three open cards.
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
        moveProofs: ctx.moves.map(m => ({ ...m.proof, publicInputs: [...m.proof.publicInputs] })),
        moves: ctx.moves.map(({ moveNumber, cardId, slot, row, col }) => ({ moveNumber, cardId, slot, row, col })),
        opponentOpenCards: ctx.opponentOpen ? [...ctx.opponentOpen] : null,
        ownOpenCards: ctx.ownOpen
          ? { cards: [...ctx.ownOpen.cards], proof: ctx.ownOpen.proof, publicInputs: [...ctx.ownOpen.publicInputs] }
          : null,
        protocolError: ctx.protocolError,
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
    if (this.game?.committed) {
      this.log('WARNING: 5 cards remain committed to the abandoned game — ' +
               'they come back when the sweep claims and unwinds it');
      this.stats.cardsStranded += 5;
    }
    this.resetToIdle();
  }

  private resetToIdle(): void {
    this.state = 'idle';
    this.gameId = null;
    this.queuedAt = 0;
    this.gameStartedAt = 0;
    this.opponentGoneSince = null;
    // Per-game state MUST NOT leak into the next game: a stale record or
    // blinding factor would produce proofs bound to the wrong game. The context
    // itself lives on in recentGames while its follow-up is still due.
    const ctx = this.game;
    if (ctx?.recheck) {
      clearTimeout(ctx.recheck);
      ctx.recheck = null;
    }
    this.game = null;
    this.settling = false;
  }

  /** Send if the socket is open; false if the frame did not go (a resume sends what matters again). */
  private send(msg: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
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
