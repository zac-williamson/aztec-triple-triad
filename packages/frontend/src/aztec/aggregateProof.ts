/**
 * Aggregate proof generation module.
 *
 * After a game ends, the winner generates an aggregate proof that recursively
 * verifies all 11 inner proofs (2 hand proofs + 9 move proofs).
 *
 * This aggregate proof is what gets submitted on-chain to the game contract.
 */

import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend, deflattenFields } from '@aztec/bb.js';
import type { HandProofData, MoveProofData } from '../types';
import { loadProveHandCircuit, loadGameMoveCircuit, loadAggregateGameCircuit } from './circuitLoader';
import { getBarretenberg } from './proofBackend';

// ====================== Types ======================

export interface AggregateProofData {
  /** Base64-encoded aggregate proof bytes */
  proof: string;
  /** 15 public input field elements */
  publicInputs: string[];
  /** 115-element VK field array for aggregate circuit */
  vkAsFields: string[];
  /** Aggregate circuit VK hash (1 field) */
  vkHash: string;
}

interface RecursiveArtifacts {
  proofAsFields: string[];
  vkAsFields: string[];
  vkHash: string;
}

// ====================== Helpers ======================

/**
 * Convert a base64-encoded proof string back to Uint8Array.
 */
function base64ToProof(b64: string): Uint8Array {
  const binaryStr = atob(b64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

/**
 * Base64-encode a Uint8Array for JSON serialization.
 */
function proofToBase64(proof: Uint8Array): string {
  return btoa(
    Array.from(proof)
      .map((b) => String.fromCharCode(b))
      .join(''),
  );
}

/**
 * Extract recursive proof artifacts (proofAsFields, vkAsFields, vkHash)
 * from an inner proof using bb.js.
 */
async function extractRecursiveArtifacts(
  circuitBytecode: string,
  proofBytes: Uint8Array,
  numPublicInputs: number,
): Promise<RecursiveArtifacts> {
  const api = await getBarretenberg();
  const backend = new UltraHonkBackend(circuitBytecode, api);
  const artifacts = await backend.generateRecursiveProofArtifacts(
    proofBytes,
    numPublicInputs,
    { verifierTarget: 'noir-recursive' },
  );
  return artifacts;
}

/**
 * Pad or truncate a field array to a specific length.
 * Circuit expects exact array sizes.
 */
function padFields(fields: string[], targetLength: number): string[] {
  if (fields.length >= targetLength) {
    return fields.slice(0, targetLength);
  }
  const padded = [...fields];
  while (padded.length < targetLength) {
    padded.push('0x0');
  }
  return padded;
}

// ====================== Main Export ======================

/**
 * Generate the aggregate proof that recursively verifies all 11 inner proofs.
 *
 * @param handProof1 - Player 1's hand proof
 * @param handProof2 - Player 2's hand proof
 * @param moveProofs - All 9 move proofs in order
 * @param onProgress - Optional callback for progress updates
 *
 * @returns AggregateProofData for on-chain settlement
 */
export async function generateAggregateProof(
  handProof1: HandProofData,
  handProof2: HandProofData,
  moveProofs: MoveProofData[],
  onProgress?: (step: string, current: number, total: number) => void,
): Promise<AggregateProofData> {
  if (moveProofs.length !== 9) {
    throw new Error(`Expected 9 move proofs, got ${moveProofs.length}`);
  }

  const totalSteps = 14; // 2 hand artifacts + 9 move artifacts + load circuit + witness + proof
  let step = 0;

  const report = (msg: string) => {
    step++;
    console.log(`[aggregateProof] [${step}/${totalSteps}] ${msg}`);
    onProgress?.(msg, step, totalSteps);
  };

  // ===== 1. Load circuit artifacts =====
  report('Loading circuit artifacts...');
  const [proveHandCircuit, gameMoveCircuit, aggregateCircuit] = await Promise.all([
    loadProveHandCircuit(),
    loadGameMoveCircuit(),
    loadAggregateGameCircuit(),
  ]);

  // ===== 2. Extract recursive artifacts for hand proofs =====
  // Both hand proofs use the same circuit (prove_hand), so they share VK
  report('Extracting hand proof 1 artifacts...');
  const hp1Bytes = base64ToProof(handProof1.proof);
  const hp1Artifacts = await extractRecursiveArtifacts(
    proveHandCircuit.bytecode, hp1Bytes, 5, // 5 public inputs
  );

  report('Extracting hand proof 2 artifacts...');
  const hp2Bytes = base64ToProof(handProof2.proof);
  const hp2Artifacts = await extractRecursiveArtifacts(
    proveHandCircuit.bytecode, hp2Bytes, 5,
  );

  // Use VK from proof 1 (both should be identical)
  const handVkAsFields = padFields(hp1Artifacts.vkAsFields, 115);
  const handVkHash = hp1Artifacts.vkHash;

  // ===== 3. Extract recursive artifacts for move proofs =====
  // All 9 move proofs use the same circuit (game_move), so they share VK
  const moveProofArtifacts: RecursiveArtifacts[] = [];
  for (let i = 0; i < 9; i++) {
    report(`Extracting move proof ${i + 1} artifacts...`);
    const mpBytes = base64ToProof(moveProofs[i].proof);
    const mpArtifacts = await extractRecursiveArtifacts(
      gameMoveCircuit.bytecode, mpBytes, 7, // 7 public inputs
    );
    moveProofArtifacts.push(mpArtifacts);
  }

  // Use VK from move proof 1 (all should be identical)
  const moveVkAsFields = padFields(moveProofArtifacts[0].vkAsFields, 115);
  const moveVkHash = moveProofArtifacts[0].vkHash;

  // ===== 4. Build aggregate circuit inputs =====
  // Public inputs (15 fields)
  const lastMove = moveProofs[8];
  const firstMove = moveProofs[0];

  const inputs: Record<string, unknown> = {
    // Public outputs (verified by contract)
    card_commit_1: handProof1.cardCommit,
    card_commit_2: handProof2.cardCommit,
    player1_address: handProof1.playerAddress,
    player2_address: handProof2.playerAddress,
    game_id: handProof1.gameId,
    initial_state_hash: firstMove.startStateHash,
    final_state_hash: lastMove.endStateHash,
    game_ended: lastMove.gameEnded ? '0x1' : '0x0',
    winner_id: '0x' + lastMove.winnerId.toString(16),
    hand_vk_hash: handVkHash,
    move_vk_hash: moveVkHash,
    player1_grumpkin_pubkey_x: handProof1.grumpkinPublicKeyX,
    player1_grumpkin_pubkey_y: handProof1.grumpkinPublicKeyY,
    player2_grumpkin_pubkey_x: handProof2.grumpkinPublicKeyX,
    player2_grumpkin_pubkey_y: handProof2.grumpkinPublicKeyY,

    // Private inputs: hand proofs
    hand_vk: handVkAsFields,
    hand_proof_1: padFields(hp1Artifacts.proofAsFields, 500),
    hand_proof_1_inputs: handProof1.publicInputs,
    hand_proof_2: padFields(hp2Artifacts.proofAsFields, 500),
    hand_proof_2_inputs: handProof2.publicInputs,

    // Private inputs: move proofs
    move_vk: moveVkAsFields,
  };

  // Add each move proof and its inputs
  for (let i = 0; i < 9; i++) {
    const proofFields = padFields(moveProofArtifacts[i].proofAsFields, 500);
    inputs[`move_proof_${i + 1}`] = proofFields;
    inputs[`move_inputs_${i + 1}`] = moveProofs[i].publicInputs;
  }

  // ===== 5. Generate aggregate witness =====
  report('Generating aggregate witness...');
  const noir = new Noir(aggregateCircuit as never);
  const { witness } = await noir.execute(inputs as never);

  // ===== 6. Generate aggregate proof =====
  report('Generating aggregate proof (this may take a while)...');
  const api = await getBarretenberg();
  const backend = new UltraHonkBackend(aggregateCircuit.bytecode, api);
  const proofData = await backend.generateProof(witness, {
    verifierTarget: 'noir-recursive',
  });

  console.log(`[aggregateProof] Aggregate proof generated!`);
  console.log(`[aggregateProof]   publicInputs: ${proofData.publicInputs.length} fields`);
  console.log(`[aggregateProof]   proof size: ${proofData.proof.length} bytes`);

  // Extract aggregate VK for contract submission
  const aggArtifacts = await backend.generateRecursiveProofArtifacts(
    proofData.proof,
    proofData.publicInputs.length,
    { verifierTarget: 'noir-recursive' },
  );

  return {
    proof: proofToBase64(proofData.proof),
    publicInputs: proofData.publicInputs,
    vkAsFields: aggArtifacts.vkAsFields,
    vkHash: aggArtifacts.vkHash,
  };
}
