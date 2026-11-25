/**
 * The slices of BotChain and BotProofs the game flow uses — narrowed so tests
 * can fake them, and in their own module so ArenaBot, the recovery sweep and
 * the settlement helpers can share them without importing each other.
 */
import type { GameState } from '@axolotl-arena/game-logic';
import type { PxeOps } from '../../frontend/src/aztec/pxe.js';
import type { FoundTx } from '../../frontend/src/aztec/gameChain.js';
import type { GameRecord, NullifierHit } from '../../frontend/src/aztec/privateGame.js';
import type { MoveProofData } from '../../frontend/src/types.js';

/**
 * The PXE operations a private game needs: the frontend's own door (pxe.ts),
 * bound to the bot's wallet, so the bot sends exactly what a browser sends.
 */
export type GamePxe = Pick<PxeOps,
  | 'readNoteNonce'
  | 'computeGameSecrets'
  | 'previewRecord'
  | 'gameNullifiers'
  | 'sendJoinGame'
  | 'sendSettleGame'
  | 'sendClaimAbandonedGame'
  | 'sendContestAbandonment'
  | 'sendFinalizeAbandonedGame'
  | 'importCardNotes'
  | 'importTokenRewardNote'
>;

export interface BotChainLike {
  readonly address: string;
  /** The node client. Send options carry it: pxe.ts reads the live base fee from it. */
  readonly nodeClient?: unknown;
  readonly pxe: GamePxe;
  /** Which of these siloed nullifiers exist, and the block each landed in. */
  lookupNullifiers(nullifiers: string[]): Promise<(NullifierHit | null)[]>;
  /** A block's timestamp, in chain seconds. */
  blockTimestamp(blockNumber: number): Promise<number>;
  /** The chain's time now: the latest block's timestamp, in seconds. */
  chainNow(): Promise<number>;
  /** The tx in `blockNumber` that pushed `nullifier`. */
  findTxWithNullifier(blockNumber: number, nullifier: string): Promise<FoundTx | null>;
  /** Which of our own prepared notes (five returns, the reward) `tx` released. */
  releasedPreparedNotes(tx: FoundTx, ownRecord: GameRecord): Promise<{ returns: boolean[]; reward: boolean }>;
  selectHand(size?: number): Promise<number[]>;
  /** Fee Juice balance; the bot pays its own transaction fees. */
  readFeeJuice?(): Promise<bigint>;
  /**
   * Cards the PXE can currently see. The only honest check that an import
   * worked: import_note swallows per-note failures. Cached — pass force to
   * pay for a fresh page-through.
   */
  readCards(opts?: { force?: boolean }): Promise<number[]>;
  /** Drop the card cache; call whenever cards have moved. */
  invalidateCards?(): void;
}

/** One move, as the bot proves it. */
export interface MoveProofArgs {
  cardId: number;
  row: number;
  col: number;
  currentPlayer: 1 | 2;
  boardBefore: GameState['board'];
  boardAfter: GameState['board'];
  scoresBefore: [number, number];
  scoresAfter: [number, number];
  cardCommit1: string;
  cardCommit2: string;
  gameEnded: boolean;
  winnerId: number;
  /**
   * The mover's hand in COMMITTED order and its blinding factor. The placed
   * card's index in it is the proof's public `placed_slot`, which settlement
   * uses to hold back the right return note.
   */
  hand: { cardIds: number[]; blindingFactor: string };
}

export interface BotProofsLike {
  /** Poseidon2 commitment to a hand — what the move circuit binds. */
  cardCommitHash(cardIds: number[], blindingFactor: string): Promise<string>;
  /** The game_move verification key, as settle_game takes it. */
  moveVerificationKey(): Promise<Uint8Array>;
  proveMove(args: MoveProofArgs): Promise<MoveProofData>;
}
