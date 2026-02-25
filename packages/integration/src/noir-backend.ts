import type { ProveHandInput, GameMoveInput, Proof } from './types.js';
import type { ProofBackend } from './prover.js';

/**
 * Proof backend using @noir-lang/noir_js and @aztec/bb.js.
 * This runs in Node.js or browser environments.
 *
 * Usage:
 *   const backend = await NoirProofBackend.create(proveHandArtifact, gameMoveArtifact);
 *   const proof = await backend.generateProveHandProof(input);
 *   await backend.destroy();
 */
export class NoirProofBackend implements ProofBackend {
  private noirHand: any;
  private noirMove: any;
  private bbHand: any;
  private bbMove: any;

  private constructor() {}

  /**
   * Create a NoirProofBackend by loading circuit artifacts and initializing.
   * @param proveHandArtifact - The compiled prove_hand circuit JSON artifact
   * @param gameMoveArtifact - The compiled game_move circuit JSON artifact
   */
  static async create(
    proveHandArtifact: any,
    gameMoveArtifact: any,
  ): Promise<NoirProofBackend> {
    const backend = new NoirProofBackend();

    // Dynamically import to support both Node.js and browser
    const { Noir } = await import('@noir-lang/noir_js');
    const { UltraHonkBackend } = await import('@aztec/bb.js');

    // Initialize prove_hand circuit
    backend.bbHand = new UltraHonkBackend(proveHandArtifact.bytecode);
    backend.noirHand = new Noir(proveHandArtifact);

    // Initialize game_move circuit
    backend.bbMove = new UltraHonkBackend(gameMoveArtifact.bytecode);
    backend.noirMove = new Noir(gameMoveArtifact);

    return backend;
  }

  async generateProveHandProof(input: ProveHandInput): Promise<Proof> {
    // Generate witness
    const { witness } = await this.noirHand.execute(input as any);

    // Generate proof
    const { proof, publicInputs } = await this.bbHand.generateProof(witness);

    return {
      proof: new Uint8Array(proof),
      publicInputs: publicInputs.map(String),
    };
  }

  async generateGameMoveProof(input: GameMoveInput): Promise<Proof> {
    const { witness } = await this.noirMove.execute(input as any);
    const { proof, publicInputs } = await this.bbMove.generateProof(witness);

    return {
      proof: new Uint8Array(proof),
      publicInputs: publicInputs.map(String),
    };
  }

  async verifyProof(circuitName: string, proofData: Proof): Promise<boolean> {
    const bb = circuitName === 'prove_hand' ? this.bbHand : this.bbMove;
    return bb.verifyProof({
      proof: proofData.proof,
      publicInputs: proofData.publicInputs,
    });
  }

  async destroy(): Promise<void> {
    await this.bbHand?.destroy();
    await this.bbMove?.destroy();
  }
}
