/**
 * Real UltraHonk proof generation tests.
 *
 * These tests go beyond witness generation — they use the actual UltraHonkBackend
 * to create and verify proofs for prove_hand and game_move circuits.
 * This catches TS↔Noir serialization mismatches that witness-only tests miss.
 *
 * @slow — each proof takes 10-30+ seconds due to WASM compilation.
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend, UltraHonkVerifierBackend, Barretenberg } from '@aztec/bb.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Circuit artifacts are in the frontend public dir
const CIRCUITS_DIR = resolve(__dirname, '../../frontend/public/circuits');

let bb: Barretenberg;
let proveHandArtifact: any;
let gameMoveArtifact: any;

function toHex(v: number | bigint): string {
  return '0x' + BigInt(v).toString(16);
}

function numToField(n: number | bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let val = BigInt(n);
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return buf;
}

function bufToHex(buf: Uint8Array): string {
  return '0x' + Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function poseidon2Hash(values: bigint[]): Promise<string> {
  const inputs = values.map((v) => numToField(v));
  const result = await bb.poseidon2Hash({ inputs });
  return bufToHex(result.hash);
}

async function pedersenHash(values: bigint[]): Promise<string> {
  const inputs = values.map((v) => numToField(v));
  const result = await bb.pedersenHash({ inputs, hashIndex: 0 });
  return bufToHex(result.hash);
}

async function computeCardCommit(cardIds: bigint[], blindingFactor: bigint): Promise<string> {
  return poseidon2Hash([...cardIds, blindingFactor]);
}

async function computePlayerStateHash(randomness: bigint[]): Promise<string> {
  return poseidon2Hash(randomness);
}

describe('real UltraHonk proof generation', () => {
  beforeAll(async () => {
    bb = await Barretenberg.new({ threads: 1 });
    proveHandArtifact = JSON.parse(
      readFileSync(resolve(CIRCUITS_DIR, 'prove_hand.json'), 'utf-8'),
    );
    gameMoveArtifact = JSON.parse(
      readFileSync(resolve(CIRCUITS_DIR, 'game_move.json'), 'utf-8'),
    );
  }, 120000);

  afterAll(async () => {
    if (bb) await bb.destroy();
  });

  describe('prove_hand', () => {
    it('generates and verifies an UltraHonk proof', async () => {
      const cardIds = [1n, 2n, 3n, 4n, 5n];
      const blindingFactor = 12345n;
      const oppRandomness = [100n, 200n, 300n, 400n, 500n, 600n];

      const cardCommitHash = await computeCardCommit(cardIds, blindingFactor);
      const oppStateHash = await computePlayerStateHash(oppRandomness);

      const inputs = {
        card_commit_hash: cardCommitHash,
        opponent_player_state_hash: oppStateHash,
        card_ids: cardIds.map(toHex),
        blinding_factor: toHex(blindingFactor),
        opponent_randomness: oppRandomness.map(toHex),
      };

      // Step 1: Generate witness
      const noir = new Noir(proveHandArtifact as never);
      const { witness } = await noir.execute(inputs as never);
      expect(witness).toBeDefined();

      // Step 2: Generate UltraHonk proof
      const backend = new UltraHonkBackend(proveHandArtifact.bytecode, bb);
      const proofData = await backend.generateProof(witness);

      expect(proofData).toBeDefined();
      expect(proofData.proof).toBeDefined();
      expect(proofData.proof.length).toBeGreaterThan(0);
      expect(proofData.publicInputs).toBeDefined();
      // prove_hand has 2 public inputs: card_commit_hash, opponent_player_state_hash
      expect(proofData.publicInputs.length).toBeGreaterThanOrEqual(1);

      // Step 3: Verify the proof
      const vk = await backend.getVerificationKey();
      const verifier = new UltraHonkVerifierBackend(bb);
      const verified = await verifier.verifyProof({ ...proofData, verificationKey: vk });
      expect(verified).toBe(true);
    }, 180000);
  });

  describe('game_move', () => {
    it('generates and verifies an UltraHonk proof for a single move', async () => {
      const cardIds = [1n, 2n, 3n, 4n, 5n];
      const blindingFactor = 12345n;

      const cardCommit1 = await computeCardCommit(cardIds, blindingFactor);
      const cardCommit2 = await computeCardCommit([6n, 7n, 8n, 9n, 10n], 67890n);

      // Empty board state (all zeros): [cardId, owner] for each of 9 cells
      const emptyBoard = Array(18).fill(toHex(0n));

      // After placing card 1 at (0,0) by player 1
      const boardAfter = [...emptyBoard];
      boardAfter[0] = toHex(1n); // card_id
      boardAfter[1] = toHex(1n); // owner = player 1

      // Scores: each player's count = cards in hand + owned board cells
      // Before: P1 has 5 in hand, P2 has 5 in hand → scores 5,5
      // After: P1 has 4 in hand + 1 on board = 5, P2 has 5 in hand = 5 → scores 5,5

      // Compute board hashes using pedersen (21 fields: 18 board + 2 scores + currentTurn)
      const boardBeforeFields = [...Array(18).fill(0n), 5n, 5n, 1n]; // scores 5-5, turn=player1
      const boardAfterFields = [1n, 1n, ...Array(16).fill(0n), 5n, 5n, 2n]; // card1@p1, scores 5-5, turn=player2

      const startStateHash = await pedersenHash(boardBeforeFields);
      const endStateHash = await pedersenHash(boardAfterFields);

      const inputs = {
        // Public inputs
        card_commit_1: cardCommit1,
        card_commit_2: cardCommit2,
        start_state_hash: startStateHash,
        end_state_hash: endStateHash,
        game_ended: toHex(0n),
        winner_id: toHex(0n),
        // Private inputs
        current_player: toHex(1n),
        card_id: toHex(1n),
        row: toHex(0n),
        col: toHex(0n),
        board_before: emptyBoard,
        board_after: boardAfter,
        scores_before: [toHex(5n), toHex(5n)],
        scores_after: [toHex(5n), toHex(5n)],
        current_turn_before: toHex(1n),
        player_card_ids: cardIds.map(toHex),
        blinding_factor: toHex(blindingFactor),
      };

      // Step 1: Generate witness
      const noir = new Noir(gameMoveArtifact as never);
      const { witness } = await noir.execute(inputs as never);
      expect(witness).toBeDefined();

      // Step 2: Generate UltraHonk proof
      const backend = new UltraHonkBackend(gameMoveArtifact.bytecode, bb);
      const proofData = await backend.generateProof(witness);

      expect(proofData).toBeDefined();
      expect(proofData.proof).toBeDefined();
      expect(proofData.proof.length).toBeGreaterThan(0);
      expect(proofData.publicInputs).toBeDefined();
      // game_move has 6 public inputs
      expect(proofData.publicInputs.length).toBeGreaterThanOrEqual(6);

      // Step 3: Verify the proof
      const vk = await backend.getVerificationKey();
      const verifier = new UltraHonkVerifierBackend(bb);
      const verified = await verifier.verifyProof({ ...proofData, verificationKey: vk });
      expect(verified).toBe(true);
    }, 180000);
  });
});
