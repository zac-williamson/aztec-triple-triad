/**
 * The bot's proof generation.
 *
 * Calls the frontend's own proofWorker — same circuits, same witness encoding,
 * same Barretenberg backend the browser uses. The React hooks around it
 * (useProofGeneration) are only a queue plus board encoding, both of which are
 * plain exported functions, so nothing here re-implements proving.
 *
 * Proofs are SERIALISED through one promise chain, exactly as
 * useProofGeneration does. Concurrent proving on one PXE/wallet is the documented
 * cause of IndexedDB TransactionInactiveError (CLAUDE.md ground rule 6); in Node
 * the store differs but the serial contract is the same, and parallel proving
 * would in any case thrash a machine that is already CPU-bound.
 */
import type { GameState } from '@axolotl-arena/game-logic';

/**
 * Mirrors SerializedProof (HandProofData / MoveProofData) without importing
 * React-side types: `proof` is base64, `publicInputs` are field hex strings.
 */
export interface ProofBundle {
  proof: string;
  publicInputs: string[];
  [key: string]: unknown;
}

export interface HandProofInputs {
  cardIds: number[];
  blindingFactor: string;
  opponentRandomness: string[];
}

export class BotProofs {
  /** All proving runs through here, one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Cached: deriving a VK is expensive and they never change for a build. */
  private vks: { handVk: Uint8Array; moveVk: Uint8Array } | null = null;
  private dummyVkCache: Uint8Array | null = null;

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
   * Verification keys for the two circuits, as settlement's process_game
   * expects them. Derived from the same artifacts used to prove, so the VKs
   * always match the proofs — deriving them from a different source is how a
   * transcript ends up rejected on-chain for no visible reason.
   */
  async verificationKeys(): Promise<{ handVk: Uint8Array; moveVk: Uint8Array }> {
    if (this.vks) return this.vks;
    const { UltraHonkBackend } = await import('@aztec/bb.js');
    const { getBarretenberg } = await import('../../frontend/src/aztec/proofBackend.js');
    const { loadProveHandCircuit, loadGameMoveCircuit } =
      await import('../../frontend/src/aztec/circuitLoader.js');

    const api = await getBarretenberg();
    const [handArtifact, moveArtifact] = await Promise.all([loadProveHandCircuit(), loadGameMoveCircuit()]);
    const handBackend = new UltraHonkBackend(handArtifact.bytecode, api);
    const moveBackend = new UltraHonkBackend(moveArtifact.bytecode, api);
    const [handVk, moveVk] = await Promise.all([
      handBackend.getVerificationKey(),
      moveBackend.getVerificationKey(),
    ]);
    this.vks = { handVk, moveVk };
    return this.vks;
  }

  /**
   * Dummy-circuit VK, needed only by the abandoned-game claim: that call pads a
   * partial move chain up to nine slots, and the contract verifies the padding
   * against this VK rather than the move VK.
   */
  async dummyVerificationKey(): Promise<Uint8Array> {
    if (this.dummyVkCache) return this.dummyVkCache;
    const { UltraHonkBackend } = await import('@aztec/bb.js');
    const { getBarretenberg } = await import('../../frontend/src/aztec/proofBackend.js');
    const { loadDummyMoveCircuit } = await import('../../frontend/src/aztec/circuitLoader.js');
    const api = await getBarretenberg();
    const artifact = await loadDummyMoveCircuit();
    this.dummyVkCache = await new UltraHonkBackend(artifact.bytecode, api).getVerificationKey();
    return this.dummyVkCache;
  }

  /**
   * One padding proof for the abandoned-game claim, base64-encoded to match the
   * transport the rest of the transcript uses. Serialised with every other
   * proof: concurrent proving is what the whole queue exists to prevent.
   */
  proveDummy(): Promise<string> {
    return this.serialise('dummy proof', async () => {
      const { UltraHonkBackend } = await import('@aztec/bb.js');
      const { Noir } = await import('@noir-lang/noir_js');
      const { getBarretenberg } = await import('../../frontend/src/aztec/proofBackend.js');
      const { loadDummyMoveCircuit } = await import('../../frontend/src/aztec/circuitLoader.js');
      const api = await getBarretenberg();
      const artifact = await loadDummyMoveCircuit();
      const { witness } = await new Noir(artifact as any).execute({
        card_commit_1: '0', card_commit_2: '0',
        start_state_hash: '0', end_state_hash: '0',
        game_ended: '0', winner_id: '0',
      });
      const { proof } = await new UltraHonkBackend(artifact.bytecode, api).generateProof(witness);
      return Buffer.from(proof).toString('base64');
    });
  }

  /** poseidon2 commitment to the bot's five cards. */
  async cardCommitHash(cardIds: number[], blindingFactor: string): Promise<string> {
    const { computeCardCommitPoseidon2 } = await import('../../frontend/src/aztec/proofWorker.js');
    return computeCardCommitPoseidon2(cardIds, blindingFactor);
  }

  /** poseidon2 over the opponent's six randomness values. */
  async playerStateHash(randomness: string[]): Promise<string> {
    const { computePlayerStateHash } = await import('../../frontend/src/aztec/proofWorker.js');
    return computePlayerStateHash(randomness);
  }

  /**
   * prove_hand: the bot owns the five cards it committed. Needs the OPPONENT's
   * randomness, so it can only run once they have shared their Aztec info.
   */
  async proveHand(inputs: HandProofInputs): Promise<ProofBundle> {
    return this.serialise('hand proof', async () => {
      const { generateProveHandProof } = await import('../../frontend/src/aztec/proofWorker.js');
      const commit = await this.cardCommitHash(inputs.cardIds, inputs.blindingFactor);
      const opponentStateHash = await this.playerStateHash(inputs.opponentRandomness);
      return await generateProveHandProof(
        inputs.cardIds,
        inputs.blindingFactor,
        commit,
        inputs.opponentRandomness,
        opponentStateHash,
      ) as unknown as ProofBundle;
    });
  }

  /**
   * game_move: one move is legal and the board transition is correct.
   *
   * Board snapshots and original-owner arrays are encoded with the FRONTEND's
   * encoders. Re-deriving them here would be the exact drift that stays
   * invisible until settlement rejects the transcript on-chain.
   */
  async proveMove(args: {
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
    playerHandData: unknown;
  }): Promise<ProofBundle> {
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
        args.playerHandData as never,
        encodeOriginalOwners(args.boardBefore), encodeOriginalOwners(args.boardAfter),
      ) as unknown as ProofBundle;
    });
  }
}
