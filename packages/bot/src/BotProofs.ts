/**
 * The bot's proofs, and its checks of the opponent's.
 *
 * Calls the frontend's own proofWorker — same circuits, same witness encoding,
 * same Barretenberg backend the browser uses — and the frontend's circuit
 * encodings (localGame.ts), so nothing here re-implements proving or hashing.
 *
 * Since the relay stopped running the game (docs/plan/PRIVATE_GAMES.md section
 * 6), each side is the other's referee: the bot proves its own moves and its
 * three open cards, and checks the human's with the same pedersen state hash
 * and bb.js verifiers a browser checks the bot's with.
 *
 * Everything that touches Barretenberg runs on the frontend's ONE prover line
 * (proverQueue.ts), in the order asked for: a check never interleaves with a
 * proof in flight, and our open cards are proven before a move queued after
 * them. Concurrent use of one wallet's prover is the documented cause of
 * IndexedDB TransactionInactiveError (CLAUDE.md ground rule 6); in Node the
 * store differs but the serial contract is the same, and parallel proving would
 * in any case thrash a machine that is already CPU-bound.
 */
import type { MoveProofData } from '../../frontend/src/types.js';
import type { OpenCardsPayload } from '../../frontend/src/aztec/localGame.js';
import type { ProofChecks } from '../../frontend/src/aztec/moveChecks.js';
import { onProver } from '../../frontend/src/aztec/proverQueue.js';
import type { BotProofsLike, MoveProofArgs } from './chainTypes.js';

export type { MoveProofArgs };

const worker = () => import('../../frontend/src/aztec/proofWorker.js');

/**
 * The real checks: the state hash the move circuit uses, and bb.js
 * verification against keys computed from the same artifacts the proofs are
 * made with. They do NOT queue themselves — `check` runs the whole check on
 * the prover line, and a check that queued its own parts would wait on itself.
 */
const realChecks: ProofChecks = {
  hashState: async (board, scores, turn, owners) => (await worker()).computeBoardStateHash(board, scores, turn, owners),
  verifyMove: async (proof, publicInputs) => (await worker()).verifyGameMoveProof(proof, publicInputs),
  verifyOpenCards: async (proof, publicInputs) => (await worker()).verifyOpenCardsProof(proof, publicInputs),
  prepare: async () => {
    const w = await worker();
    await w.circuitVerificationKey('game_move');
    await w.circuitVerificationKey('prove_hand');
  },
};

export class BotProofs implements BotProofsLike {
  constructor(private readonly log: (msg: string) => void = () => {}) {}

  /** On the prover line, with its duration logged. */
  private serialise<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return onProver(async () => {
      const started = Date.now();
      const out = await fn();
      this.log(`${label} proved in ${Math.round((Date.now() - started) / 1000)}s`);
      return out;
    });
  }

  /**
   * The game_move verification key, as settle_game expects it: the cached key
   * the move checks use, derived from the same artifact used to prove — a key
   * from any other source is how a transcript ends up rejected on-chain for no
   * visible reason.
   */
  async moveVerificationKey(): Promise<Uint8Array> {
    const { circuitVerificationKey } = await worker();
    return onProver(() => circuitVerificationKey('game_move'));
  }

  /** poseidon2 commitment to the bot's five cards. */
  async cardCommitHash(cardIds: number[], blindingFactor: string): Promise<string> {
    const { computeCardCommitPoseidon2 } = await worker();
    return onProver(() => computeCardCommitPoseidon2(cardIds, blindingFactor));
  }

  /**
   * game_move: one move is legal and the board transition is correct.
   *
   * Board snapshots and original-owner arrays are encoded with the FRONTEND's
   * encoders. Re-deriving them here would be the exact drift that stays
   * invisible until the opponent refuses the move, or settlement rejects the
   * transcript on-chain. The placed slot is derived by the frontend too, from
   * the hand in committed order.
   */
  proveMove(args: MoveProofArgs): Promise<MoveProofData> {
    return this.serialise(`move proof (card ${args.cardId} → [${args.row},${args.col}])`, async () => {
      const { generateGameMoveProof } = await worker();
      const { encodeBoardState, encodeOriginalOwners } = await import('../../frontend/src/aztec/localGame.js');
      return generateGameMoveProof(
        args.cardId, args.row, args.col, args.currentPlayer,
        encodeBoardState(args.boardBefore), encodeBoardState(args.boardAfter),
        args.scoresBefore, args.scoresAfter,
        args.cardCommit1, args.cardCommit2,
        args.gameEnded, args.winnerId,
        { cardIds: [...args.hand.cardIds], blindingFactor: args.hand.blindingFactor },
        encodeOriginalOwners(args.boardBefore), encodeOriginalOwners(args.boardAfter),
      );
    });
  }

  /** Our three open cards — the committed hand's slots 0..2 — against our record's hand commitment. */
  proveOpenCards(hand: number[], blindingFactor: string, handCommit: string): Promise<OpenCardsPayload> {
    const committed = [...hand];
    return this.serialise('open-cards proof', async () => {
      const { generateOpenCardsProof } = await worker();
      return generateOpenCardsProof(committed, blindingFactor, handCommit);
    });
  }

  check<T>(run: (checks: ProofChecks) => Promise<T>): Promise<T> {
    return onProver(() => run(realChecks));
  }

  /** Both verification keys take seconds: computed while the join runs, not when the first move waits on them. */
  prepareChecks(): Promise<void> {
    return onProver(() => realChecks.prepare!());
  }
}
