/**
 * The bot's proof generation.
 *
 * Calls the frontend's own proofWorker — same circuits, same witness encoding,
 * same Barretenberg backend the browser uses. The React hooks around it
 * (useProofGeneration) are only a queue plus board encoding, both of which are
 * plain exported functions, so nothing here re-implements proving.
 *
 * Only move proofs exist now (docs/plan/PRIVATE_GAMES.md section 4): hands are
 * checked on-chain when they are committed, and abandonment needs no proofs at
 * all, so there is no hand proof and no dummy padding proof any more.
 *
 * Proofs are SERIALISED through one promise chain, exactly as
 * useProofGeneration does. Concurrent proving on one PXE/wallet is the documented
 * cause of IndexedDB TransactionInactiveError (CLAUDE.md ground rule 6); in Node
 * the store differs but the serial contract is the same, and parallel proving
 * would in any case thrash a machine that is already CPU-bound.
 */
import type { MoveProofData } from '../../frontend/src/types.js';
import type { MoveProofArgs } from './chainTypes.js';

export type { MoveProofArgs };

export class BotProofs {
  /** All proving runs through here, one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Cached: deriving a VK is expensive and it never changes for a build. */
  private moveVk: Uint8Array | null = null;

  constructor(private readonly log: (msg: string) => void = () => {}) {}

  private serialise<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const started = Date.now();
      const out = await fn();
      this.log(`${label} proved in ${Math.round((Date.now() - started) / 1000)}s`);
      return out;
    });
    // Keep the chain alive even when this link rejects, or one failure would
    // permanently wedge every later proof behind a rejected promise.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * The game_move verification key, as settle_game expects it. Derived from
   * the same artifact used to prove, so the VK always matches the proofs —
   * deriving it from a different source is how a transcript ends up rejected
   * on-chain for no visible reason.
   */
  async moveVerificationKey(): Promise<Uint8Array> {
    if (this.moveVk) return this.moveVk;
    const { UltraHonkBackend } = await import('@aztec-foundation/bb.js');
    const { getBarretenberg } = await import('../../frontend/src/aztec/proofBackend.js');
    const { loadGameMoveCircuit } = await import('../../frontend/src/aztec/circuitLoader.js');
    const api = await getBarretenberg();
    const artifact = await loadGameMoveCircuit();
    this.moveVk = await new UltraHonkBackend(artifact.bytecode, api).getVerificationKey();
    return this.moveVk;
  }

  /** poseidon2 commitment to the bot's five cards. */
  async cardCommitHash(cardIds: number[], blindingFactor: string): Promise<string> {
    const { computeCardCommitPoseidon2 } = await import('../../frontend/src/aztec/proofWorker.js');
    return computeCardCommitPoseidon2(cardIds, blindingFactor);
  }

  /**
   * game_move: one move is legal and the board transition is correct.
   *
   * Board snapshots and original-owner arrays are encoded with the FRONTEND's
   * encoders. Re-deriving them here would be the exact drift that stays
   * invisible until settlement rejects the transcript on-chain. The placed
   * slot is derived by the frontend too, from the hand in committed order.
   */
  async proveMove(args: MoveProofArgs): Promise<MoveProofData> {
    return this.serialise(`move proof (card ${args.cardId} → [${args.row},${args.col}])`, async () => {
      const { generateGameMoveProof } = await import('../../frontend/src/aztec/proofWorker.js');
      const { encodeBoardState, encodeOriginalOwners } =
        await import('../../frontend/src/hooks/useProofGeneration.js');

      return await generateGameMoveProof(
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
}
