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
    gameOver: { winner: PlayerSide | 'draw' } | null;
    opponentDisconnected: boolean;
  };
  game: {
    status: string;
    currentTurn: PlayerSide;
    isMyTurn: boolean;
    board: CellSnapshot[][];
    myHandCardIds: number[];
    myScore: number;
    opponentScore: number;
  } | null;
  chain: {
    onChainGameId: string | null;
    handProofStatus: string;
    moveProofStatus: string;
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
    disputeCountdown: number | null;
    claimAvailable: boolean;
  };
  interaction: {
    selectedCardIndex: number | null;
    flying: boolean;
    cascading: boolean;
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
  /** Live txManager entries (create_game / join_game / settle_game lifecycle). */
  txEntries(): TxEntrySnapshot[];
  /** Recent txProgress events (wallet-level phases incl. aztecTxHash). */
  txEvents(): TxEventSnapshot[];
}
