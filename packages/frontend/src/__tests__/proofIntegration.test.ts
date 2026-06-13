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
 * Matches circuit hash_board_state (C2 round-2, original-owner replay guard):
 *   pedersen_hash([board[18], scores[2], current_turn, original_owners[9]]) = 30 fields.
 * original_owners[i] = who FIRST placed the card on cell i (0 if empty); it is
 * publicly agreed and never changes on capture, so consecutive moves' hashes
 * agree across peers (the private placed-slot masks of round 1 could not).
 */
async function hashBoardState(
  board: bigint[],
  scores: [bigint, bigint],
  currentTurn: bigint,
  originalOwners: bigint[] = [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
): Promise<string> {
  const inputs = [
    ...board.map((v) => numToField(v)),
    numToField(scores[0]),
    numToField(scores[1]),
    numToField(currentTurn),
    ...originalOwners.map((v) => numToField(v)),
  ];
  const result = await bb.pedersenHash({ inputs, hashIndex: 0 });
  return bufToHex(result.hash);
}

/**
 * Compute player_state_hash using Poseidon2.
 * Matches circuit: Poseidon2::hash(randomness, 6)
 */
async function computePlayerStateHash(randomness: bigint[]): Promise<string> {
  const inputs = randomness.map((v) => numToField(v));
  const result = await bb.poseidon2Hash({ inputs });
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
    const oppRandomness = [100n, 200n, 300n, 400n, 500n, 600n];

    async function makeHandInputs(
      ids: bigint[],
      bf: bigint,
      oppRand: bigint[] = oppRandomness,
      overrides: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> {
      const cardCommitHash = await computeCardCommit(ids, bf);
      const oppStateHash = await computePlayerStateHash(oppRand);
      return {
        card_commit_hash: cardCommitHash,
        opponent_player_state_hash: oppStateHash,
        card_ids: ids.map((id) => toHex(id)),
        blinding_factor: toHex(bf),
        opponent_randomness: oppRand.map((r) => toHex(r)),
        ...overrides,
      };
    }

    it('executes with valid inputs (cards 1-5)', async () => {
      const inputs = await makeHandInputs(cardIds, blindingFactor);

      const noir = new Noir(proveHandArtifact as never);
      const { witness } = await noir.execute(inputs as never);
      expect(witness).toBeDefined();
      expect(witness.length).toBeGreaterThan(0);
    }, 120000);

    it('rejects card ID 0 (below valid range)', async () => {
      const badIds = [0n, 2n, 3n, 4n, 5n];
      const inputs = await makeHandInputs(badIds, blindingFactor);

      const noir = new Noir(proveHandArtifact as never);
      await expect(noir.execute(inputs as never)).rejects.toThrow();
    }, 120000);

    it('rejects card ID 257 (above valid range)', async () => {
      const badIds = [1n, 2n, 3n, 4n, 257n];
      const inputs = await makeHandInputs(badIds, blindingFactor);

      const noir = new Noir(proveHandArtifact as never);
      await expect(noir.execute(inputs as never)).rejects.toThrow();
    }, 120000);

    it('rejects wrong card commitment', async () => {
      const oppStateHash = await computePlayerStateHash(oppRandomness);
      const inputs: Record<string, unknown> = {
        card_commit_hash: '0xdeadbeef',
        opponent_player_state_hash: oppStateHash,
        card_ids: cardIds.map((id) => toHex(id)),
        blinding_factor: toHex(blindingFactor),
        opponent_randomness: oppRandomness.map((r) => toHex(r)),
      };

      const noir = new Noir(proveHandArtifact as never);
      await expect(noir.execute(inputs as never)).rejects.toThrow();
    }, 120000);

    it('rejects duplicate card IDs', async () => {
      const dupeIds = [1n, 2n, 3n, 4n, 1n];
      const inputs = await makeHandInputs(dupeIds, blindingFactor);

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

    /** Build the per-cell original-owner array (len 9) from [cellIdx, player] pairs. */
    function owners(...placed: Array<[number, number]>): bigint[] {
      const a = new Array(9).fill(0n) as bigint[];
      for (const [cell, player] of placed) a[cell] = BigInt(player);
      return a;
    }

    it('executes first move (P1 places card 1 at 0,0 on empty board)', async () => {
      const cc1 = await computeCardCommit(p1CardIds, p1BlindingFactor);
      const cc2 = await computeCardCommit(p2CardIds, p2BlindingFactor);

      const boardBefore = new Array(18).fill(0n) as bigint[];
      const scoresBefore: [bigint, bigint] = [5n, 5n];

      const boardAfter = new Array(18).fill(0n) as bigint[];
      boardAfter[0] = 1n; // card_id
      boardAfter[1] = 1n; // owner
      const scoresAfter: [bigint, bigint] = [5n, 5n];

      // Empty board → no original owners; after the move, cell 0's original
      // owner is P1.
      const startHash = await hashBoardState(boardBefore, scoresBefore, 1n, owners());
      const endHash = await hashBoardState(boardAfter, scoresAfter, 2n, owners([0, 1]));

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
        original_owners_before: owners().map((v) => toHex(v)),
        original_owners_after: owners([0, 1]).map((v) => toHex(v)),
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
      boardAfter[8] = 10n; boardAfter[9] = 2n; // P2 card at (1,1) = cell 4
      const scoresAfter: [bigint, bigint] = [5n, 5n];

      // cell 0 original owner P1 (move 0); cell 4 becomes P2.
      const startHash = await hashBoardState(boardBefore, scoresBefore, 2n, owners([0, 1]));
      const endHash = await hashBoardState(boardAfter, scoresAfter, 1n, owners([0, 1], [4, 2]));

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
        original_owners_before: owners([0, 1]).map((v) => toHex(v)),
        original_owners_after: owners([0, 1], [4, 2]).map((v) => toHex(v)),
        player_card_ids: p2CardIds.map((id) => toHex(id)),
        blinding_factor: toHex(p2BlindingFactor),
      };

      const noir = new Noir(gameMoveArtifact as never);
      const { witness } = await noir.execute(inputs as never);
      expect(witness).toBeDefined();
      expect(witness.length).toBeGreaterThan(0);
    }, 120000);

    it('executes capture move, leaving the captured card original owner unchanged', async () => {
      const cc1 = await computeCardCommit(p1CardIds, p1BlindingFactor);
      const cc2 = await computeCardCommit(p2CardIds, p2BlindingFactor);

      // Board: P1 card 1 at (0,0)=cell0, P2 card 10 at (0,1)=cell1.
      // P1 places card 4 (Sunny [6,1,1,2]) at (1,1)=cell4: top=6 vs Peaches
      // bottom=2 → CAPTURE of cell1. cell1's OWNER flips to P1 but its ORIGINAL
      // owner stays P2 (the property the replay guard relies on).
      const boardBefore = new Array(18).fill(0n) as bigint[];
      boardBefore[0] = 1n; boardBefore[1] = 1n;   // cell0 P1 card 1
      boardBefore[2] = 10n; boardBefore[3] = 2n;  // cell1 P2 card 10
      const scoresBefore: [bigint, bigint] = [5n, 5n];

      const boardAfter = new Array(18).fill(0n) as bigint[];
      boardAfter[0] = 1n; boardAfter[1] = 1n;     // unchanged
      boardAfter[2] = 10n; boardAfter[3] = 1n;    // CAPTURED by P1 (owner → 1)
      boardAfter[8] = 4n; boardAfter[9] = 1n;     // placed at cell4
      const scoresAfter: [bigint, bigint] = [6n, 4n];

      // cell0=P1, cell1=P2 (stays P2 after capture), cell4 becomes P1.
      const startHash = await hashBoardState(boardBefore, scoresBefore, 1n, owners([0, 1], [1, 2]));
      const endHash = await hashBoardState(boardAfter, scoresAfter, 2n, owners([0, 1], [1, 2], [4, 1]));

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
        original_owners_before: owners([0, 1], [1, 2]).map((v) => toHex(v)),
        original_owners_after: owners([0, 1], [1, 2], [4, 1]).map((v) => toHex(v)),
        player_card_ids: p1CardIds.map((id) => toHex(id)),
        blinding_factor: toHex(p1BlindingFactor),
      };

      const noir = new Noir(gameMoveArtifact as never);
      const { witness } = await noir.execute(inputs as never);
      expect(witness).toBeDefined();
      expect(witness.length).toBeGreaterThan(0);
    }, 120000);

    it('accepts placing a card whose id collides with a captured opponent card (finding-19)', async () => {
      // Duplicate-deck soundness guard: P2 placed its card 5, P1 captured it
      // (cell1 now OWNED by P1 but original_owner stays 2). P1 legitimately
      // places its OWN card 5 elsewhere. A *current*-owner replay check would
      // FALSE-REJECT this; the original-owner check must accept it.
      const cc1 = await computeCardCommit(p1CardIds, p1BlindingFactor);
      const cc2 = await computeCardCommit(p2CardIds, p2BlindingFactor);

      // Reachable filled=4 board (P1 c0, P2 c1, P1 c2 captures c1, P2 c8).
      const boardBefore = new Array(18).fill(0n) as bigint[];
      boardBefore[0] = 1n;  boardBefore[1] = 1n;   // cell0 P1 card1
      boardBefore[2] = 5n;  boardBefore[3] = 1n;   // cell1 P2's card5, captured by P1
      boardBefore[4] = 3n;  boardBefore[5] = 1n;   // cell2 P1 card3 (the capturer)
      boardBefore[16] = 11n; boardBefore[17] = 2n; // cell8 P2 card11
      const ooBefore = owners([0, 1], [1, 2], [2, 1], [8, 2]);
      const scoresBefore: [bigint, bigint] = [6n, 4n];

      // P1 places its own card 5 at cell4 (1,1). cell4's only occupied neighbor
      // (cell1) is already P1's → no captures.
      const boardAfter = [...boardBefore];
      boardAfter[8] = 5n; boardAfter[9] = 1n; // cell4 P1 card5
      const ooAfter = owners([0, 1], [1, 2], [2, 1], [4, 1], [8, 2]);
      const scoresAfter: [bigint, bigint] = [6n, 4n];

      const startHash = await hashBoardState(boardBefore, scoresBefore, 1n, ooBefore);
      const endHash = await hashBoardState(boardAfter, scoresAfter, 2n, ooAfter);

      const inputs: Record<string, unknown> = {
        card_commit_1: cc1,
        card_commit_2: cc2,
        start_state_hash: startHash,
        end_state_hash: endHash,
        game_ended: '0x0',
        winner_id: '0x0',
        current_player: '0x1',
        card_id: '0x5',
        row: '0x1',
        col: '0x1',
        board_before: boardBefore.map((v) => toHex(v)),
        board_after: boardAfter.map((v) => toHex(v)),
        scores_before: [toHex(scoresBefore[0]), toHex(scoresBefore[1])],
        scores_after: [toHex(scoresAfter[0]), toHex(scoresAfter[1])],
        current_turn_before: '0x1',
        original_owners_before: ooBefore.map((v) => toHex(v)),
        original_owners_after: ooAfter.map((v) => toHex(v)),
        player_card_ids: p1CardIds.map((id) => toHex(id)),
        blinding_factor: toHex(p1BlindingFactor),
      };

      const noir = new Noir(gameMoveArtifact as never);
      const { witness } = await noir.execute(inputs as never);
      expect(witness).toBeDefined();
      expect(witness.length).toBeGreaterThan(0);
    }, 120000);

    it('chains across the P1→P2 boundary with no private per-player state', async () => {
      // The exact failure the round-1 chained masks caused: at the P1→P2
      // boundary, P2's independently-derived start_state_hash must equal P1's
      // end_state_hash. original_owners is publicly agreed — both peers derive
      // it from the shared placements — so the hashes match. The private
      // placed-slot masks could not (P2 only learned P1's mask via the lagging
      // relay, so its start hash used a stale value → sortProofChain broke).
      const board = new Array(18).fill(0n) as bigint[];
      board[0] = 1n; board[1] = 1n; // P1 placed card 1 at (0,0) in move 0
      const scores: [bigint, bigint] = [5n, 5n];

      // P1 (the mover) ends move 0 on this state.
      const p1EndHash = await hashBoardState(board, scores, 2n, owners([0, 1]));

      // P2 receives the relayed board and reconstructs original owners purely
      // from the public placement history (cell 0 was first placed by player 1)
      // — no access to P1's hand or any private state.
      const p2StartHash = await hashBoardState(board, scores, 2n, owners([0, 1]));

      expect(p2StartHash).toBe(p1EndHash);
    });

    it('rejects move with wrong player turn', async () => {
      const cc1 = await computeCardCommit(p1CardIds, p1BlindingFactor);
      const cc2 = await computeCardCommit(p2CardIds, p2BlindingFactor);

      const boardBefore = new Array(18).fill(0n) as bigint[];
      const boardAfter = new Array(18).fill(0n) as bigint[];
      boardAfter[0] = 10n; boardAfter[1] = 2n;
      const startHash = await hashBoardState(boardBefore, [5n, 5n], 1n, owners()); // turn=P1
      const endHash = await hashBoardState(boardAfter, [5n, 5n], 1n, owners([0, 2]));

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
        original_owners_before: owners().map((v) => toHex(v)),
        original_owners_after: owners([0, 2]).map((v) => toHex(v)),
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

      const startHash = await hashBoardState(boardBefore, [5n, 5n], 1n, owners([0, 1]));
      const endHash = await hashBoardState(boardAfter, [5n, 5n], 2n, owners([0, 1]));

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
        original_owners_before: owners([0, 1]).map((v) => toHex(v)),
        original_owners_after: owners([0, 1]).map((v) => toHex(v)),
        player_card_ids: p1CardIds.map((id) => toHex(id)),
        blinding_factor: toHex(p1BlindingFactor),
      };

      const noir = new Noir(gameMoveArtifact as never);
      await expect(noir.execute(inputs as never)).rejects.toThrow();
    }, 120000);

    it('rejects replaying a card this player already placed (C2 original-owner check)', async () => {
      // P1's card 1 is on the board with original_owner P1; P1 tries to place
      // card 1 AGAIN at a fresh cell. Mirrors the circuit's
      // test_card_replay_rejected. Rejected by §4b: a cell holds card_id 1 whose
      // original owner is the mover.
      const cc1 = await computeCardCommit(p1CardIds, p1BlindingFactor);
      const cc2 = await computeCardCommit(p2CardIds, p2BlindingFactor);

      const boardBefore = new Array(18).fill(0n) as bigint[];
      boardBefore[0] = 1n; boardBefore[1] = 1n; // card 1 already on board, placed by P1
      const boardAfter = [...boardBefore];
      boardAfter[8] = 1n; boardAfter[9] = 1n;   // attempt to place card 1 again at (1,1)

      const startHash = await hashBoardState(boardBefore, [5n, 5n], 1n, owners([0, 1]));
      const endHash = await hashBoardState(boardAfter, [5n, 5n], 2n, owners([0, 1], [4, 1]));

      const inputs: Record<string, unknown> = {
        card_commit_1: cc1,
        card_commit_2: cc2,
        start_state_hash: startHash,
        end_state_hash: endHash,
        game_ended: '0x0',
        winner_id: '0x0',
        current_player: '0x1',
        card_id: '0x1',
        row: '0x1',
        col: '0x1',
        board_before: boardBefore.map((v) => toHex(v)),
        board_after: boardAfter.map((v) => toHex(v)),
        scores_before: ['0x5', '0x5'],
        scores_after: ['0x5', '0x5'],
        current_turn_before: '0x1',
        original_owners_before: owners([0, 1]).map((v) => toHex(v)),
        original_owners_after: owners([0, 1], [4, 1]).map((v) => toHex(v)),
        player_card_ids: p1CardIds.map((id) => toHex(id)),
        blinding_factor: toHex(p1BlindingFactor),
      };

      const noir = new Noir(gameMoveArtifact as never);
      await expect(noir.execute(inputs as never)).rejects.toThrow();
    }, 120000);
  });
});
