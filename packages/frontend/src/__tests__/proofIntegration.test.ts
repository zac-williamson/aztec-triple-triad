/**
 * Integration tests for Noir circuit execution (prove_hand + game_move).
 *
 * These tests ACTUALLY execute the compiled Noir circuits using @noir-lang/noir_js
 * and verify that valid inputs produce valid witnesses and invalid inputs are rejected.
 *
 * Uses @aztec/bb.js for Poseidon2 and Pedersen hash (matching circuit internals).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Noir } from '@noir-lang/noir_js';
import { Barretenberg } from '@aztec/bb.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ====================== Crypto Helpers ======================

let bb: Barretenberg;

async function initCrypto() {
  bb = await Barretenberg.new({ threads: 1 });
}

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

function hexToField(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const padded = clean.padStart(64, '0');
  const buf = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    buf[i] = parseInt(padded.substring(i * 2, i * 2 + 2), 16);
  }
  return buf;
}

function bufToHex(buf: Uint8Array): string {
  return '0x' + Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ====================== Shared Crypto Functions ======================

/**
 * Compute card commitment using Poseidon2.
 * Matches circuit: Poseidon2::hash([card_ids[0..5], blinding_factor], 6)
 */
async function computeCardCommit(
  cardIds: bigint[],
  blindingFactor: bigint,
): Promise<string> {
  const inputs = [
    ...cardIds.map((id) => numToField(id)),
    numToField(blindingFactor),
  ];
  const result = await bb.poseidon2Hash({ inputs });
  return bufToHex(result.hash);
}

/**
 * Compute board state hash using Pedersen.
 * Matches circuit: pedersen_hash([board[18], scores[2], current_turn])
 */
async function hashBoardState(
  board: bigint[],
  scores: [bigint, bigint],
  currentTurn: bigint,
): Promise<string> {
  const inputs = [
    ...board.map((v) => numToField(v)),
    numToField(scores[0]),
    numToField(scores[1]),
    numToField(currentTurn),
  ];
  const result = await bb.pedersenHash({ inputs, hashIndex: 0 });
  return bufToHex(result.hash);
}

// ====================== Test Suite ======================

describe('proof generation integration', () => {
  let proveHandArtifact: any;
  let gameMoveArtifact: any;

  beforeAll(async () => {
    await initCrypto();
    const circuitsDir = resolve(__dirname, '../../public/circuits');
    proveHandArtifact = JSON.parse(
      readFileSync(resolve(circuitsDir, 'prove_hand.json'), 'utf-8'),
    );
    gameMoveArtifact = JSON.parse(
      readFileSync(resolve(circuitsDir, 'game_move.json'), 'utf-8'),
    );
  }, 60000);

  // ====================== prove_hand Tests ======================

  describe('prove_hand circuit', () => {
    const cardIds = [1n, 2n, 3n, 4n, 5n];
    const blindingFactor = 12345n;

    it('executes with valid inputs (cards 1-5)', async () => {
      const cardCommitHash = await computeCardCommit(cardIds, blindingFactor);

      const inputs: Record<string, unknown> = {
        card_commit_hash: cardCommitHash,
        card_ids: cardIds.map((id) => toHex(id)),
        blinding_factor: toHex(blindingFactor),
      };

      const noir = new Noir(proveHandArtifact as never);
      const { witness } = await noir.execute(inputs as never);
      expect(witness).toBeDefined();
      expect(witness.length).toBeGreaterThan(0);
    }, 120000);

    it('rejects card ID 0 (below valid range)', async () => {
      const badIds = [0n, 2n, 3n, 4n, 5n];
      const cardCommitHash = await computeCardCommit(badIds, blindingFactor);

      const inputs: Record<string, unknown> = {
        card_commit_hash: cardCommitHash,
        card_ids: badIds.map((id) => toHex(id)),
        blinding_factor: toHex(blindingFactor),
      };

      const noir = new Noir(proveHandArtifact as never);
      await expect(noir.execute(inputs as never)).rejects.toThrow();
    }, 120000);

    it('rejects card ID 51 (above valid range)', async () => {
      const badIds = [1n, 2n, 3n, 4n, 51n];
      const cardCommitHash = await computeCardCommit(badIds, blindingFactor);

      const inputs: Record<string, unknown> = {
        card_commit_hash: cardCommitHash,
        card_ids: badIds.map((id) => toHex(id)),
        blinding_factor: toHex(blindingFactor),
      };

      const noir = new Noir(proveHandArtifact as never);
      await expect(noir.execute(inputs as never)).rejects.toThrow();
    }, 120000);

    it('rejects wrong card commitment', async () => {
      const inputs: Record<string, unknown> = {
        card_commit_hash: '0xdeadbeef',
        card_ids: cardIds.map((id) => toHex(id)),
        blinding_factor: toHex(blindingFactor),
      };

      const noir = new Noir(proveHandArtifact as never);
      await expect(noir.execute(inputs as never)).rejects.toThrow();
    }, 120000);

    it('rejects duplicate card IDs', async () => {
      const dupeIds = [1n, 2n, 3n, 4n, 1n];
      const cardCommitHash = await computeCardCommit(dupeIds, blindingFactor);

      const inputs: Record<string, unknown> = {
        card_commit_hash: cardCommitHash,
        card_ids: dupeIds.map((id) => toHex(id)),
        blinding_factor: toHex(blindingFactor),
      };

      const noir = new Noir(proveHandArtifact as never);
      await expect(noir.execute(inputs as never)).rejects.toThrow();
    }, 120000);
  });

  // ====================== game_move Tests ======================

  describe('game_move circuit', () => {
    // Player 1: cards 1-5
    const p1CardIds = [1n, 2n, 3n, 4n, 5n];
    const p1BlindingFactor = 111n;

    // Player 2: cards 10-14
    const p2CardIds = [10n, 11n, 12n, 13n, 14n];
    const p2BlindingFactor = 222n;

    it('executes first move (P1 places card 1 at 0,0 on empty board)', async () => {
      const cc1 = await computeCardCommit(p1CardIds, p1BlindingFactor);
      const cc2 = await computeCardCommit(p2CardIds, p2BlindingFactor);

      const boardBefore = new Array(18).fill(0n) as bigint[];
      const scoresBefore: [bigint, bigint] = [5n, 5n];

      const boardAfter = new Array(18).fill(0n) as bigint[];
      boardAfter[0] = 1n; // card_id
      boardAfter[1] = 1n; // owner
      const scoresAfter: [bigint, bigint] = [5n, 5n];

      const startHash = await hashBoardState(boardBefore, scoresBefore, 1n);
      const endHash = await hashBoardState(boardAfter, scoresAfter, 2n);

      const inputs: Record<string, unknown> = {
        card_commit_1: cc1,
        card_commit_2: cc2,
        start_state_hash: startHash,
        end_state_hash: endHash,
        game_ended: '0x0',
        winner_id: '0x0',
        current_player: '0x1',
        card_id: '0x1',
        row: '0x0',
        col: '0x0',
        board_before: boardBefore.map((v) => toHex(v)),
        board_after: boardAfter.map((v) => toHex(v)),
        scores_before: [toHex(scoresBefore[0]), toHex(scoresBefore[1])],
        scores_after: [toHex(scoresAfter[0]), toHex(scoresAfter[1])],
        current_turn_before: '0x1',
        player_card_ids: p1CardIds.map((id) => toHex(id)),
        blinding_factor: toHex(p1BlindingFactor),
      };

      const noir = new Noir(gameMoveArtifact as never);
      const { witness } = await noir.execute(inputs as never);
      expect(witness).toBeDefined();
      expect(witness.length).toBeGreaterThan(0);
    }, 120000);

    it('executes second move (P2 places card 10 at 1,1)', async () => {
      const cc1 = await computeCardCommit(p1CardIds, p1BlindingFactor);
      const cc2 = await computeCardCommit(p2CardIds, p2BlindingFactor);

      const boardBefore = new Array(18).fill(0n) as bigint[];
      boardBefore[0] = 1n; boardBefore[1] = 1n; // P1 card at (0,0)
      const scoresBefore: [bigint, bigint] = [5n, 5n];

      const boardAfter = [...boardBefore];
      boardAfter[8] = 10n; boardAfter[9] = 2n; // P2 card at (1,1)
      const scoresAfter: [bigint, bigint] = [5n, 5n];

      const startHash = await hashBoardState(boardBefore, scoresBefore, 2n);
      const endHash = await hashBoardState(boardAfter, scoresAfter, 1n);

      const inputs: Record<string, unknown> = {
        card_commit_1: cc1,
        card_commit_2: cc2,
        start_state_hash: startHash,
        end_state_hash: endHash,
        game_ended: '0x0',
        winner_id: '0x0',
        current_player: '0x2',
        card_id: toHex(10),
        row: '0x1',
        col: '0x1',
        board_before: boardBefore.map((v) => toHex(v)),
        board_after: boardAfter.map((v) => toHex(v)),
        scores_before: [toHex(scoresBefore[0]), toHex(scoresBefore[1])],
        scores_after: [toHex(scoresAfter[0]), toHex(scoresAfter[1])],
        current_turn_before: '0x2',
        player_card_ids: p2CardIds.map((id) => toHex(id)),
        blinding_factor: toHex(p2BlindingFactor),
      };

      const noir = new Noir(gameMoveArtifact as never);
      const { witness } = await noir.execute(inputs as never);
      expect(witness).toBeDefined();
      expect(witness.length).toBeGreaterThan(0);
    }, 120000);

    it('executes capture move (P1 Sunny captures P2 Peaches)', async () => {
      const cc1 = await computeCardCommit(p1CardIds, p1BlindingFactor);
      const cc2 = await computeCardCommit(p2CardIds, p2BlindingFactor);

      // Board: P1 card 1 at (0,0), P2 card 10 at (0,1)
      // P1 places card 4 (Sunny [6,1,1,2]) at (1,1)
      // top=6 vs Peaches bottom=2 -> CAPTURE
      const boardBefore = new Array(18).fill(0n) as bigint[];
      boardBefore[0] = 1n; boardBefore[1] = 1n;   // (0,0) P1 card 1
      boardBefore[2] = 10n; boardBefore[3] = 2n;  // (0,1) P2 card 10
      const scoresBefore: [bigint, bigint] = [5n, 5n];

      const boardAfter = new Array(18).fill(0n) as bigint[];
      boardAfter[0] = 1n; boardAfter[1] = 1n;     // unchanged
      boardAfter[2] = 10n; boardAfter[3] = 1n;    // CAPTURED by P1
      boardAfter[8] = 4n; boardAfter[9] = 1n;     // placed
      const scoresAfter: [bigint, bigint] = [6n, 4n];

      const startHash = await hashBoardState(boardBefore, scoresBefore, 1n);
      const endHash = await hashBoardState(boardAfter, scoresAfter, 2n);

      const inputs: Record<string, unknown> = {
        card_commit_1: cc1,
        card_commit_2: cc2,
        start_state_hash: startHash,
        end_state_hash: endHash,
        game_ended: '0x0',
        winner_id: '0x0',
        current_player: '0x1',
        card_id: '0x4',
        row: '0x1',
        col: '0x1',
        board_before: boardBefore.map((v) => toHex(v)),
        board_after: boardAfter.map((v) => toHex(v)),
        scores_before: [toHex(scoresBefore[0]), toHex(scoresBefore[1])],
        scores_after: [toHex(scoresAfter[0]), toHex(scoresAfter[1])],
        current_turn_before: '0x1',
        player_card_ids: p1CardIds.map((id) => toHex(id)),
        blinding_factor: toHex(p1BlindingFactor),
      };

      const noir = new Noir(gameMoveArtifact as never);
      const { witness } = await noir.execute(inputs as never);
      expect(witness).toBeDefined();
      expect(witness.length).toBeGreaterThan(0);
    }, 120000);

    it('rejects move with wrong player turn', async () => {
      const cc1 = await computeCardCommit(p1CardIds, p1BlindingFactor);
      const cc2 = await computeCardCommit(p2CardIds, p2BlindingFactor);

      const boardBefore = new Array(18).fill(0n) as bigint[];
      const boardAfter = new Array(18).fill(0n) as bigint[];
      boardAfter[0] = 10n; boardAfter[1] = 2n;
      const startHash = await hashBoardState(boardBefore, [5n, 5n], 1n); // turn=P1
      const endHash = await hashBoardState(boardAfter, [5n, 5n], 1n);

      const inputs: Record<string, unknown> = {
        card_commit_1: cc1,
        card_commit_2: cc2,
        start_state_hash: startHash,
        end_state_hash: endHash,
        game_ended: '0x0',
        winner_id: '0x0',
        current_player: '0x2', // P2 trying to go when it's P1's turn
        card_id: toHex(10),
        row: '0x0',
        col: '0x0',
        board_before: boardBefore.map((v) => toHex(v)),
        board_after: boardAfter.map((v) => toHex(v)),
        scores_before: ['0x5', '0x5'],
        scores_after: ['0x5', '0x5'],
        current_turn_before: '0x1', // It's P1's turn
        player_card_ids: p2CardIds.map((id) => toHex(id)),
        blinding_factor: toHex(p2BlindingFactor),
      };

      const noir = new Noir(gameMoveArtifact as never);
      await expect(noir.execute(inputs as never)).rejects.toThrow();
    }, 120000);

    it('rejects placing card on occupied cell', async () => {
      const cc1 = await computeCardCommit(p1CardIds, p1BlindingFactor);
      const cc2 = await computeCardCommit(p2CardIds, p2BlindingFactor);

      const boardBefore = new Array(18).fill(0n) as bigint[];
      boardBefore[0] = 1n; boardBefore[1] = 1n; // cell (0,0) occupied
      const boardAfter = [...boardBefore];
      boardAfter[0] = 2n; boardAfter[1] = 1n; // overwrite attempt

      const startHash = await hashBoardState(boardBefore, [5n, 5n], 1n);
      const endHash = await hashBoardState(boardAfter, [5n, 5n], 2n);

      const inputs: Record<string, unknown> = {
        card_commit_1: cc1,
        card_commit_2: cc2,
        start_state_hash: startHash,
        end_state_hash: endHash,
        game_ended: '0x0',
        winner_id: '0x0',
        current_player: '0x1',
        card_id: '0x2',
        row: '0x0',
        col: '0x0', // OCCUPIED
        board_before: boardBefore.map((v) => toHex(v)),
        board_after: boardAfter.map((v) => toHex(v)),
        scores_before: ['0x5', '0x5'],
        scores_after: ['0x5', '0x5'],
        current_turn_before: '0x1',
        player_card_ids: p1CardIds.map((id) => toHex(id)),
        blinding_factor: toHex(p1BlindingFactor),
      };

      const noir = new Noir(gameMoveArtifact as never);
      await expect(noir.execute(inputs as never)).rejects.toThrow();
    }, 120000);
  });
});
