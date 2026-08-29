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
  proveHand(inputs: { cardIds: number[]; blindingFactor: string; opponentRandomness: string[] }): Promise<any>;
  proveMove(args: any): Promise<any>;
}

/** The slice of BotChain the bot uses — narrowed so tests can fake it. */
export interface BotChainLike {
  readonly address: string;
  selectHand(size?: number): Promise<number[]>;
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
  lastError: string | null;
}

export interface QueueSnapshot {
  length: number;
  oldestWaitMs: number;
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
  private opponentRandomness: string[] | null = null;
  private myCardCommit: string | null = null;
  private opponentCardCommit: string | null = null;
  private handProofSent = false;
  /** Our in-flight move, kept so the proof can bind the before/after transition. */
  private pendingMove: {
    moveNumber: number; cardId: number; row: number; col: number;
    boardBefore: GameState['board']; scoresBefore: [number, number];
  } | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private registered = false;

  private readonly stats: BotStats = {
    state: 'idle', gamesPlayed: 0, wins: 0, losses: 0, draws: 0,
    joinFailures: 0, moveFailures: 0, commitFailures: 0, proofFailures: 0, lastError: null,
  };

  private readonly chain: BotChainLike | null;
  private readonly proofs: BotProofsLike | null;
  private readonly connect: (url: string) => WebSocket;
  private readonly fetchQueue: (httpUrl: string) => Promise<QueueSnapshot>;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly cfg: ArenaBotConfig, deps: ArenaBotDeps = {}) {
    this.chain = deps.chain ?? null;
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

    // In chain mode the hand must come from what the bot ACTUALLY holds — its
    // collection shrinks every time a player beats it, so a configured static
    // hand would eventually name cards it no longer owns and fail at commit.
    let hand = this.cfg.handCardIds;
    if (this.chain) {
      try {
        hand = await this.chain.selectHand(5);
      } catch (err) {
        this.stats.joinFailures += 1;
        return this.recordError('select-hand', err as Error);
      }
    }

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
        this.gameId = msg.gameId;
        this.myPlayer = msg.playerNumber === 1 ? 'player1' : 'player2';
        this.state = 'playing';
        this.log(`matched into ${msg.gameId} as ${this.myPlayer}`);
        // Chain commit runs detached: it takes minutes (proving + inclusion) and
        // must not block the message loop, which still has to answer the relay.
        if (this.chain && this.myPlayer === 'player1') {
          void this.commitAsPlayer1(msg.gameId).catch(err => {
            this.stats.commitFailures += 1;
            this.recordError('commit-create', err as Error);
          });
        }
        this.maybeMove(msg.gameState);
        break;

      case 'OPPONENT_AZTEC_INFO':
        if (this.chain && msg.gameId === this.gameId && Array.isArray(msg.gameRandomness)) {
          this.opponentRandomness = msg.gameRandomness as string[];
          // The hand proof binds the OPPONENT's randomness, so it cannot run
          // until they have shared it.
          void this.maybeProveHand().catch(err => {
            this.stats.proofFailures += 1;
            this.recordError('prove-hand', err as Error);
          });
        }
        // P2 can only join once P1 has told it the on-chain game id.
        if (this.chain && this.myPlayer === 'player2' && msg.gameId === this.gameId && msg.onChainGameId) {
          void this.commitAsPlayer2(msg.gameId, String(msg.onChainGameId)).catch(err => {
            this.stats.commitFailures += 1;
            this.recordError('commit-join', err as Error);
          });
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

      case 'HAND_PROOF':
        // The opponent's hand proof carries their card commitment, which our
        // move proofs must bind.
        if (msg.gameId === this.gameId && msg.handProof?.cardCommit) {
          this.opponentCardCommit = String(msg.handProof.cardCommit);
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

  /**
   * P1's on-chain commit: preview the derived game id + randomness, send
   * create_game, then share the preview so P2 can join. Mirrors
   * useGameSession's createGame pipeline; game_id and randomness are derived
   * IN-CIRCUIT and must never be invented here.
   */
  private async commitAsPlayer1(wsGameId: string): Promise<void> {
    const chain = this.chain!;
    const { gameId, randomness, blindingFactor, status } = await chain.pxe.previewCreateGame(chain.address);
    this.blindingFactor = blindingFactor;
    this.myRandomness = randomness;
    if (status !== 0) {
      throw new Error(`on-chain game ${gameId} already has status ${status} — stale note nonce`);
    }
    // Share BEFORE the slow tx so P2 can prepare while create_game mines.
    this.send({ type: 'SHARE_AZTEC_INFO', gameId: wsGameId, aztecAddress: chain.address, onChainGameId: gameId, gameRandomness: randomness });
    void this.maybeProveHand().catch(() => undefined);
    this.log(`create_game: committing ${this.hand.join(',')} for on-chain game ${String(gameId).slice(0, 18)}…`);

    const txHash = await chain.pxe.sendCreateGame(chain.address, this.hand, { timeoutMs: this.cfg.chainTxTimeoutMs });
    if (this.gameId !== wsGameId) return; // game moved on while we were mining
    this.send({ type: 'TX_CONFIRMED', gameId: wsGameId, txType: 'create_game', txHash });
    this.log(`create_game mined: ${txHash.slice(0, 18)}…`);
    void this.maybeProveHand().catch(err => {
      this.stats.proofFailures += 1;
      this.recordError('prove-hand', err as Error);
    });
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
    this.log(`join_game: committing ${this.hand.join(',')} into ${onChainGameId.slice(0, 18)}…`);

    const txHash = await chain.pxe.sendJoinGame(chain.address, onChainGameId, this.hand, { timeoutMs: this.cfg.chainTxTimeoutMs });
    if (this.gameId !== wsGameId) return;
    this.send({ type: 'TX_CONFIRMED', gameId: wsGameId, txType: 'join_game', txHash });
    this.log(`join_game mined: ${txHash.slice(0, 18)}…`);
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

    this.myCardCommit = await this.proofs.cardCommitHash(this.hand, this.blindingFactor);
    const handProof = await this.proofs.proveHand({
      cardIds: this.hand,
      blindingFactor: this.blindingFactor,
      opponentRandomness: this.opponentRandomness,
    });
    if (this.gameId !== gameId) return; // game ended while proving
    this.send({ type: 'SUBMIT_HAND_PROOF', gameId, handProof });
    this.log('hand proof submitted');
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
    // The echoed state must actually contain our move.
    const occupied = after.board.flat().filter(c => c.card !== null).length;
    if (occupied <= pending.moveNumber) return;
    if (!this.myCardCommit || !this.opponentCardCommit) return;

    this.pendingMove = null;
    const gameId = this.gameId;
    const currentPlayer: 1 | 2 = this.myPlayer === 'player1' ? 1 : 2;
    const ended = after.status === 'finished';
    const winnerId = !ended ? 0 : after.winner === 'player1' ? 1 : after.winner === 'player2' ? 2 : 3;

    const moveProof = await this.proofs.proveMove({
      cardId: pending.cardId, row: pending.row, col: pending.col, currentPlayer,
      boardBefore: pending.boardBefore, boardAfter: after.board,
      scoresBefore: pending.scoresBefore,
      scoresAfter: [after.player1Score, after.player2Score],
      cardCommit1: currentPlayer === 1 ? this.myCardCommit : this.opponentCardCommit,
      cardCommit2: currentPlayer === 1 ? this.opponentCardCommit : this.myCardCommit,
      gameEnded: ended, winnerId,
      playerHandData: { cardIds: this.hand, blindingFactor: this.blindingFactor, handIndex: 0 },
    });
    if (this.gameId !== gameId || !gameId) return;
    this.send({
      type: 'SUBMIT_MOVE_PROOF', gameId,
      handIndex: 0, row: pending.row, col: pending.col,
      moveNumber: pending.moveNumber, moveProof,
    });
    this.log(`move proof ${pending.moveNumber} submitted`);
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

  private resetToIdle(): void {
    this.state = 'idle';
    this.gameId = null;
    this.myPlayer = null;
    this.queuedAt = 0;
    // Per-game proof inputs MUST NOT leak into the next game: a stale blinding
    // factor or opponent randomness would produce a proof that verifies against
    // the wrong commitment and be rejected at settlement.
    this.blindingFactor = null;
    this.myRandomness = null;
    this.opponentRandomness = null;
    this.myCardCommit = null;
    this.opponentCardCommit = null;
    this.handProofSent = false;
    this.pendingMove = null;
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
