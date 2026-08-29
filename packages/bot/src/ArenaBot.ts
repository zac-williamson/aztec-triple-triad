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

export type BotState = 'idle' | 'queued' | 'playing';

export interface BotStats {
  state: BotState;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  joinFailures: number;
  moveFailures: number;
  lastError: string | null;
}

export interface QueueSnapshot {
  length: number;
  oldestWaitMs: number;
  entries: { playerId: string; queuedAt: number; waitMs: number }[];
}

type Logger = (msg: string) => void;

export interface ArenaBotDeps {
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
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private registered = false;

  private readonly stats: BotStats = {
    state: 'idle', gamesPlayed: 0, wins: 0, losses: 0, draws: 0,
    joinFailures: 0, moveFailures: 0, lastError: null,
  };

  private readonly connect: (url: string) => WebSocket;
  private readonly fetchQueue: (httpUrl: string) => Promise<QueueSnapshot>;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly cfg: ArenaBotConfig, deps: ArenaBotDeps = {}) {
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

    if (this.state === 'queued' && this.now() - this.queuedAt > this.cfg.queueTimeoutMs) {
      this.log('queue timeout; leaving the queue');
      this.send({ type: 'CANCEL_MATCHMAKING' });
      this.resetToIdle();
      return;
    }
    if (this.state !== 'idle') return;

    const snap = await this.fetchQueue(this.cfg.httpUrl);
    // Only our own entry in the queue means there is nobody to rescue.
    if (snap.length === 0) return;
    if (snap.oldestWaitMs < this.cfg.joinThresholdMs) return;

    this.log(`human waiting ${Math.round(snap.oldestWaitMs / 1000)}s — offering a game`);
    this.state = 'queued';
    this.queuedAt = this.now();
    this.send({ type: 'QUEUE_MATCHMAKING', cardIds: this.cfg.handCardIds });
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
        this.gameId = msg.gameId;
        this.myPlayer = msg.playerNumber === 1 ? 'player1' : 'player2';
        this.state = 'playing';
        this.log(`matched into ${msg.gameId} as ${this.myPlayer}`);
        this.maybeMove(msg.gameState);
        break;

      case 'GAME_START':
      case 'GAME_STATE':
        if (msg.gameId === this.gameId) this.maybeMove(msg.gameState);
        break;

      case 'GAME_OVER': {
        if (msg.gameId !== this.gameId) break;
        this.stats.gamesPlayed += 1;
        if (msg.winner === 'draw') this.stats.draws += 1;
        else if (msg.winner === this.myPlayer) this.stats.wins += 1;
        else this.stats.losses += 1;
        this.log(`game over: ${msg.winner} (bot was ${this.myPlayer})`);
        this.resetToIdle();
        break;
      }

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

  /** Play if, and only if, it is our turn in a live game. */
  private maybeMove(state: GameState | undefined): void {
    if (!state || this.state !== 'playing' || !this.myPlayer) return;
    if (state.status !== 'playing') return;
    if (state.currentTurn !== this.myPlayer) return;

    let move;
    try {
      // No seed: production play should not be predictable from the state.
      // The harness passes one when it needs reproducibility.
      move = chooseBotMove(state, { difficulty: this.cfg.difficulty });
    } catch (err) {
      this.stats.moveFailures += 1;
      return this.recordError('choose-move', err as Error);
    }

    const moveNumber = state.board.flat().filter(c => c.card !== null).length;
    const gameId = this.gameId!;
    setTimeout(() => {
      // Re-check: the game may have ended or moved on during the pacing delay.
      if (this.state === 'playing' && this.gameId === gameId) {
        this.send({ type: 'PLACE_CARD', gameId, handIndex: move.handIndex, row: move.row, col: move.col, moveNumber });
      }
    }, this.cfg.moveDelayMs);
  }

  private resetToIdle(): void {
    this.state = 'idle';
    this.gameId = null;
    this.myPlayer = null;
    this.queuedAt = 0;
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
