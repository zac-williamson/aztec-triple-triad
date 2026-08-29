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
export interface BotChainLike {
  readonly address: string;
  readonly nodeClient?: any;
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
  /** Settlement failures, and successful settlements. Chain mode only. */
  settleFailures: number;
  settlements: number;
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
  /** Suppresses repeat logging of a persistent card shortage. */
  private handShortageLogged = false;
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
    joinFailures: 0, moveFailures: 0, commitFailures: 0, proofFailures: 0, settleFailures: 0, settlements: 0, lastError: null,
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
    // Re-check: a MATCH_FOUND can land WHILE the /queue fetch is in flight, and
    // queueing again then gets rejected "You are already in an active game" —
    // which the ERROR path treats as a join failure and resets us out of a game
    // we are actually in.
    if (this.state !== 'idle') return;
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
        if (this.chain && msg.gameId === this.gameId) {
          // Record each field independently: they are optional on the wire, and
          // coupling the id to the randomness meant a share without randomness
          // left P2 with no game to join.
          if (msg.aztecAddress) this.opponentAddress = String(msg.aztecAddress);
          if (msg.onChainGameId) this.onChainGameId = String(msg.onChainGameId);
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
          void this.commitAsPlayer2(msg.gameId, this.onChainGameId).catch(err => {
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
        if (Array.isArray(msg.player1CardIds) && Array.isArray(msg.player2CardIds)) {
          this.opponentCardIds = this.myPlayer === 'player1' ? msg.player2CardIds : msg.player1CardIds;
        }
        if (this.chain && this.proofs && this.shouldSettle(msg.winner)) {
          // Settle BEFORE resetting: the transcript lives in this game's state.
          void this.settle(msg.winner).catch(err => {
            this.stats.settleFailures += 1;
            this.recordError('settle', err as Error);
          }).finally(() => this.resetToIdle());
        } else {
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
        }
        break;

      case 'MOVE_PROVEN':
        // The opponent's move proofs complete the 9-link chain.
        if (msg.gameId === this.gameId && msg.moveProof?.startStateHash) {
          this.moveProofs.set(String(msg.moveProof.startStateHash), msg.moveProof);
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

    const txHash = await chain.pxe.sendCreateGame(chain.address, this.hand, { node: chain.nodeClient, timeoutMs: this.cfg.chainTxTimeoutMs });
    if (this.gameId !== wsGameId) return; // game moved on while we were mining
    this.send({ type: 'TX_CONFIRMED', gameId: wsGameId, txType: 'create_game', txHash });
    this.committed = true;
    this.log(`create_game mined: ${txHash.slice(0, 18)}…`);
    // Our turn may have arrived while we were committing.
    this.maybeMove(this.lastState ?? undefined);
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

    const txHash = await chain.pxe.sendJoinGame(chain.address, onChainGameId, this.hand, { node: chain.nodeClient, timeoutMs: this.cfg.chainTxTimeoutMs });
    if (this.gameId !== wsGameId) return;
    this.send({ type: 'TX_CONFIRMED', gameId: wsGameId, txType: 'join_game', txHash });
    this.committed = true;
    this.log(`join_game mined: ${txHash.slice(0, 18)}…`);
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
  private shouldSettle(winner: string): boolean {
    if (winner === 'draw') return this.myPlayer === 'player1';
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
    });

    this.log(`settling ${winner === 'draw' ? '(draw, single settler)' : `(claiming card ${selectedCardId})`}…`);
    const txHash = await chain.pxe.sendProcessGame(chain.address, args, { node: chain.nodeClient, timeoutMs: this.cfg.chainTxTimeoutMs });
    this.stats.settlements += 1;
    this.log(`settled on-chain: ${String(txHash).slice(0, 18)}…`);
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
    this.committed = false;
    this.lastState = null;
    this.pendingMove = null;
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
