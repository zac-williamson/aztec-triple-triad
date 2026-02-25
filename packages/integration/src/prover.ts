import type { ProveHandInput, GameMoveInput, Proof, HandProof, MoveProof } from './types.js';
import { createHandProof, createMoveProof } from './proof-utils.js';

/**
 * Abstract interface for proof generation backends.
 * Implementations can use noir.js (browser), nargo CLI (dev), or mocks (testing).
 */
export interface ProofBackend {
  /** Generate a proof for the prove_hand circuit. */
  generateProveHandProof(input: ProveHandInput): Promise<Proof>;
  /** Generate a proof for the game_move circuit. */
  generateGameMoveProof(input: GameMoveInput): Promise<Proof>;
  /** Verify a proof (optional, for testing). */
  verifyProof?(circuitName: string, proof: Proof): Promise<boolean>;
  /** Clean up resources. */
  destroy?(): Promise<void>;
}

/**
 * High-level proof service that wraps a ProofBackend.
 * Manages proof generation and serialization.
 */
export class ProofService {
  constructor(private backend: ProofBackend) {}

  /**
   * Generate a hand ownership proof.
   */
  async proveHand(
    playerSecret: string,
    playerAddress: string,
    gameId: string,
    cardIds: number[],
    cardNullifierSecrets: string[],
    cardCommit: string,
  ): Promise<HandProof> {
    const input: ProveHandInput = {
      card_commit: cardCommit,
      player_address: playerAddress,
      game_id: gameId,
      player_secret: playerSecret,
      card_ids: cardIds.map(String),
      card_nullifier_secrets: cardNullifierSecrets,
    };

    const proof = await this.backend.generateProveHandProof(input);
    return createHandProof(proof, cardCommit, playerAddress, gameId);
  }

  /**
   * Generate a game move proof.
   */
  async proveGameMove(input: GameMoveInput): Promise<MoveProof> {
    const proof = await this.backend.generateGameMoveProof(input);
    return createMoveProof(
      proof,
      input.card_commit_1,
      input.card_commit_2,
      input.start_state_hash,
      input.end_state_hash,
      input.game_ended === '1',
      parseInt(input.winner_id),
    );
  }

  /**
   * Clean up backend resources.
   */
  async destroy(): Promise<void> {
    await this.backend.destroy?.();
  }
}

/**
 * Mock proof backend for testing.
 * Generates deterministic fake proofs without actual ZK proving.
 */
export class MockProofBackend implements ProofBackend {
  async generateProveHandProof(input: ProveHandInput): Promise<Proof> {
    // Create a deterministic mock proof from the inputs
    const proofData = new TextEncoder().encode(
      `mock-hand-proof:${input.card_commit}:${input.player_address}`
    );
    return {
      proof: proofData,
      publicInputs: [input.card_commit, input.player_address, input.game_id],
    };
  }

  async generateGameMoveProof(input: GameMoveInput): Promise<Proof> {
    const proofData = new TextEncoder().encode(
      `mock-move-proof:${input.start_state_hash}:${input.end_state_hash}`
    );
    return {
      proof: proofData,
      publicInputs: [
        input.card_commit_1,
        input.card_commit_2,
        input.start_state_hash,
        input.end_state_hash,
        input.game_ended,
        input.winner_id,
      ],
    };
  }

  async verifyProof(_circuitName: string, proof: Proof): Promise<boolean> {
    // Mock verification: check proof starts with "mock-"
    const text = new TextDecoder().decode(proof.proof);
    return text.startsWith('mock-');
  }
}
