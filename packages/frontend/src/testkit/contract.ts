/**
 * Wire contract between the in-page testkit (window.__triadTest) and the
 * Node-side playtest harness (packages/playtest). This file is intentionally
 * import-free so the harness can consume it under a plain Node tsconfig;
 * the implementations in api.ts are type-checked against it by the frontend.
 */

export type PlayerSide = 'player1' | 'player2';

export type ClickTarget =
  | { type: 'cell'; row: number; col: number }
  | { type: 'hand'; index: number };

export interface CellSnapshot {
  cardId: number | null;
  owner: PlayerSide | null;
  originalOwner: PlayerSide | null;
}

export interface PhaseSnapshot {
  seq: number;
  screen: string;
  aztecStatus: string;
  /** Non-null while wallet funding is in flight; the current step's text. */
  fundingProgress: string | null;
  /**
   * The connection error the app is showing, if any.
   *
   * Onboarding failures deliberately leave `aztecStatus` alone so the player
   * keeps their retry, which means the status cannot tell a harness that
   * anything went wrong — only this can.
   */
  aztecError: string | null;
  accountAddress: string | null;
  ownedCardIds: number[];
  tokenBalance: number;
  ws: {
    connected: boolean;
    gameId: string | null;
    playerNumber: 1 | 2 | null;
    matchmakingStatus: string;
    /**
     * The game's result, once over. Kept here for the harness, but the client
     * computes it itself: the relay runs no game and never learns a result
     * (docs/plan/PRIVATE_GAMES.md section 6).
     */
    gameOver: { winner: PlayerSide | 'draw' } | null;
    opponentDisconnected: boolean;
  };
  /**
   * The game as THIS client runs it (useGamePlay), rebuilt from the moves it
   * made and the opponent moves it checked. Our own move shows here at once;
   * the opponent sees it only once its proof is made, sent and checked.
   */
  game: {
    status: string;
    currentTurn: PlayerSide;
    isMyTurn: boolean;
    board: CellSnapshot[][];
    myHandCardIds: number[];
    /**
     * The opponent's unplayed cards in hand-slot order; 0 for a card this
     * player has not been shown (all five until OPEN_CARDS checks out, then
     * the two hidden slots until they are played).
     */
    opponentHandCardIds: number[];
    myScore: number;
    opponentScore: number;
    /** Why the opponent's move or open cards were refused; null while all checks pass. */
    protocolError: string | null;
  } | null;
  chain: {
    /**
     * The game's `created` nullifier (siloed, hex) once known — the one public
     * trace a game's creation leaves, which both players (and nobody else)
     * can compute. Not a contract-side game id: there is none any more.
     */
    onChainGameId: string | null;
    /**
     * Status of the two hand COMMITMENTS (the players' records): 'generating'
     * while this player's commit is in flight, 'ready' once both records are
     * committed and known. Named for the hand proofs it replaced, which no
     * longer exist.
     */
    handProofStatus: string;
    moveProofStatus: string;
    /** Both records known and all nine move proofs collected (no hand proofs any more). */
    canSettle: boolean;
    settleTxStatus: string;
    opponentSettled: boolean;
    takenCardId: number | null;
    onChainError: string | null;
  };
  /**
   * Present-but-idle abandonment flow, for the harness to OBSERVE the warning
   * and the on-chain claim/dispute window. `warning` is null until the relay
   * broadcasts GAME_ABANDONMENT_WARNING; `claimAvailable` is true when the
   * non-idle player may claim now (the warning's countdown has elapsed and the
   * claim is not already running). Trigger the claim via __triadTest.claimAbandonedGame().
   */
  abandonment: {
    warning: { idlePlayer: PlayerSide; secondsIdle: number; secondsUntilClaimable: number } | null;
    isClaimingAbandoned: boolean;
    /** Seconds until the contract accepts the claim, while the flow waits for it. */
    barCountdown: number | null;
    disputeCountdown: number | null;
    claimAvailable: boolean;
  };
  interaction: {
    selectedCardIndex: number | null;
    flying: boolean;
    cascading: boolean;
    /**
     * The selected hand card as the 3D scene has committed it — what a board
     * cell's click acts on. It can lag `selectedCardIndex`: the canvas is a
     * React root of its own, committed a scheduler task later (seconds on a
     * busy main thread), and a cell clicked before it catches up drops the
     * click. Null without a scene.
     */
    sceneSelectedCardIndex: number | null;
    /** Whose turn it is as the 3D scene has committed it (the hand ignores clicks until true). Null without a scene. */
    sceneIsMyTurn: boolean | null;
  } | null;
}

/** txManager entry as seen by the harness (structural copy of TxEntry). */
export interface TxEntrySnapshot {
  id: string;
  type: string;
  phase: string;
  label: string;
  error: string | null;
  txHash: string | null;
  updatedAt: number;
}

/** txProgress event as seen by the harness (structural copy of TxProgressEvent). */
export interface TxEventSnapshot {
  txId: string;
  label: string;
  phase: string;
  startTime: number;
  error?: string;
  aztecTxHash?: string;
}

export interface TriadTestApi {
  /** Monotonic publish counter — bump means state changed. */
  seq(): number;
  /** Cheap synchronous snapshot of app/game/chain state. Null until the app bridge publishes. */
  phase(): PhaseSnapshot | null;
  /** Viewport pixel coords for a board cell or hand-fan strip, via the live camera. */
  getScreenXY(target: ClickTarget): { x: number; y: number };
  /** Direct-dispatch escape hatch ("fast interaction" mode). Click mode is the default. */
  placeCard(handIndex: number, row: number, col: number): void;
  /**
   * Trigger the abandoned-game claim flow for a present-but-idle (or
   * disconnected) opponent — equivalent to clicking "Claim abandoned game".
   * Idempotent (a second call while claiming is a no-op). Returns immediately;
   * observe progress via phase().abandonment.{isClaimingAbandoned,disputeCountdown}.
   */
  claimAbandonedGame(): void;
  /** Card token IDs in THIS tab's PXE (serialized through the app's PXE queue). */
  getPrivateCards(): Promise<number[]>;
  /** Arena Token balance from THIS tab's PXE (serialized through the app's PXE queue). */
  getTokenBalance(): Promise<number>;
  /** Live txManager entries (create_game / join_game / settle_game / cancel / claim / finalize). */
  txEntries(): TxEntrySnapshot[];
  /** Recent txProgress events (wallet-level phases incl. aztecTxHash). */
  txEvents(): TxEventSnapshot[];
}
