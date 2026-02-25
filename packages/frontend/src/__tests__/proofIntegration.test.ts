/**
 * Integration tests for Noir circuit execution (prove_hand + game_move).
 *
 * These tests ACTUALLY execute the compiled Noir circuits using @noir-lang/noir_js
 * and verify that valid inputs produce valid witnesses and invalid inputs are rejected.
 *
 * Uses @aztec/foundation for Pedersen hash and Grumpkin key derivation (matching circuit internals).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Noir } from '@noir-lang/noir_js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ====================== Crypto Helpers ======================

// Lazy-loaded modules (ESM-only @aztec/foundation)
let pedersenHash: (inputs: bigint[]) => Promise<bigint>;
let grumpkinMul: (point: any, scalar: any) => Promise<any>;
let GrumpkinScalar: any;
let circuitGenerator: any;

async function initCrypto() {
  const pedersen = await import('@aztec/foundation/crypto/pedersen');
  pedersenHash = pedersen.pedersenHash;

  const grumpkinMod = await import('@aztec/foundation/crypto/grumpkin');
  const Grumpkin = grumpkinMod.Grumpkin;
  grumpkinMul = Grumpkin.mul.bind(Grumpkin);

  const curvesMod = await import('@aztec/foundation/curves/grumpkin');
  GrumpkinScalar = curvesMod.GrumpkinScalar;

  // Build circuit generator point using foundation's Fr type
  const gen = Grumpkin.generator;
  const Fr = gen.x.constructor;
  const PointCtor = gen.constructor;
  circuitGenerator = new PointCtor(
    new Fr(0x083e7911d835097629f0067531fc15cafd79a89beecb39903f69572c636f4a5an),
    new Fr(0x1a7f5efaad7f315c25a918f30cc8d7333fccab7ad7c90f14de81bcc528f9935dn),
    false,
  );
}

function toHex(v: number | bigint): string {
  return '0x' + BigInt(v).toString(16);
}

// Card ranks matching the hardcoded circuit database
const CARD_RANKS: Record<number, [bigint, bigint, bigint, bigint]> = {
  1: [1n, 4n, 1n, 5n],   // Mudwalker
  2: [5n, 1n, 1n, 3n],   // Blushy
  3: [1n, 3n, 3n, 5n],   // Snowdrop
  4: [6n, 1n, 1n, 2n],   // Sunny
  5: [2n, 3n, 1n, 5n],   // Inkwell
  10: [4n, 3n, 2n, 4n],  // Peaches
  11: [2n, 6n, 1n, 6n],  // Freckles
  12: [7n, 1n, 3n, 1n],  // Camo
  13: [6n, 2n, 2n, 3n],  // Neon
  14: [5n, 3n, 3n, 4n],  // Glow Bug
};

const BN254_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ====================== Shared Crypto Functions ======================

async function computeCardCommit(
  secret: bigint,
  address: bigint,
  gameId: bigint,
  cardIds: bigint[],
  cardRanks: bigint[][],
  nullSecrets: bigint[],
): Promise<bigint> {
  return pedersenHash([
    secret, address, gameId,
    ...cardIds,
    ...cardRanks.flat(),
    ...nullSecrets,
  ]);
}

async function hashBoardState(
  board: bigint[],
  scores: [bigint, bigint],
  currentTurn: bigint,
): Promise<bigint> {
  return pedersenHash([...board, scores[0], scores[1], currentTurn]);
}

async function deriveGrumpkinPubkey(privKey: bigint): Promise<{ x: string; y: string }> {
  const scalar = new GrumpkinScalar(privKey);
  const point = await grumpkinMul(circuitGenerator, scalar);
  return { x: point.x.toString(), y: point.y.toString() };
}

async function computeEncryptedNullifier(
  nullifierSecret: bigint,
  myPrivKey: bigint,
  oppPubX: string,
  oppPubY: string,
  moveIndex: bigint,
): Promise<bigint> {
  // Build opponent pubkey as a Point
  const gen = circuitGenerator;
  const Fr = gen.x.constructor;
  const PointCtor = gen.constructor;
  const oppPubkey = new PointCtor(
    new Fr(BigInt(oppPubX)),
    new Fr(BigInt(oppPubY)),
    false,
  );

  // shared_secret = my_private_key * opponent_pubkey
  const sharedPoint = await grumpkinMul(oppPubkey, new GrumpkinScalar(myPrivKey));
  const sharedSecretX = BigInt(sharedPoint.x.toString());

  // expand_secret = pedersen_hash([shared_secret_x, move_index])
  const expandedKey = await pedersenHash([sharedSecretX, moveIndex]);

  // encrypted = (nullifier + expanded_key) mod p
  return (nullifierSecret + BigInt(expandedKey.toString())) % BN254_MODULUS;
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
    const playerSecret = 12345n;
    const playerAddress = 0xabcdefn;
    const gameId = 1n;
    const cardIds = [1n, 2n, 3n, 4n, 5n];
    const cardRanks = cardIds.map((id) => CARD_RANKS[Number(id)]);
    const nullSecrets = [100n, 200n, 300n, 400n, 500n];
    const grumpkinPrivKey = 42n;

    it('executes with valid inputs (cards 1-5)', async () => {
      const cardCommit = await computeCardCommit(
        playerSecret, playerAddress, gameId, cardIds, cardRanks, nullSecrets,
      );
      const pubkey = await deriveGrumpkinPubkey(grumpkinPrivKey);

      const inputs: Record<string, unknown> = {
        card_commit: toHex(cardCommit),
        player_address: toHex(playerAddress),
        game_id: toHex(gameId),
        grumpkin_public_key_x: pubkey.x,
        grumpkin_public_key_y: pubkey.y,
        player_secret: toHex(playerSecret),
        card_ids: cardIds.map((id) => toHex(id)),
        card_ranks: cardRanks.map((r) => r.map((v) => toHex(v))),
        card_nullifier_secrets: nullSecrets.map((s) => toHex(s)),
        grumpkin_private_key: toHex(grumpkinPrivKey),
      };

      const noir = new Noir(proveHandArtifact as never);
      const { witness } = await noir.execute(inputs as never);
      expect(witness).toBeDefined();
      expect(witness.length).toBeGreaterThan(0);
    }, 120000);

    it('rejects card ID 0 (below valid range)', async () => {
      const badIds = [0n, 2n, 3n, 4n, 5n];
      const badRanks = [[0n, 0n, 0n, 0n], ...cardRanks.slice(1)];
      const commit = await computeCardCommit(
        playerSecret, playerAddress, gameId, badIds, badRanks, nullSecrets,
      );
      const pubkey = await deriveGrumpkinPubkey(grumpkinPrivKey);

      const inputs: Record<string, unknown> = {
        card_commit: toHex(commit),
        player_address: toHex(playerAddress),
        game_id: toHex(gameId),
        grumpkin_public_key_x: pubkey.x,
        grumpkin_public_key_y: pubkey.y,
        player_secret: toHex(playerSecret),
        card_ids: badIds.map((id) => toHex(id)),
        card_ranks: badRanks.map((r) => r.map((v) => toHex(v))),
        card_nullifier_secrets: nullSecrets.map((s) => toHex(s)),
        grumpkin_private_key: toHex(grumpkinPrivKey),
      };

      const noir = new Noir(proveHandArtifact as never);
      await expect(noir.execute(inputs as never)).rejects.toThrow();
    }, 120000);

    it('rejects card ID 51 (above valid range)', async () => {
      const badIds = [1n, 2n, 3n, 4n, 51n];
      const badRanks = [...cardRanks.slice(0, 4), [0n, 0n, 0n, 0n]];
      const commit = await computeCardCommit(
        playerSecret, playerAddress, gameId, badIds, badRanks, nullSecrets,
      );
      const pubkey = await deriveGrumpkinPubkey(grumpkinPrivKey);

      const inputs: Record<string, unknown> = {
        card_commit: toHex(commit),
        player_address: toHex(playerAddress),
        game_id: toHex(gameId),
        grumpkin_public_key_x: pubkey.x,
        grumpkin_public_key_y: pubkey.y,
        player_secret: toHex(playerSecret),
        card_ids: badIds.map((id) => toHex(id)),
        card_ranks: badRanks.map((r) => r.map((v) => toHex(v))),
        card_nullifier_secrets: nullSecrets.map((s) => toHex(s)),
        grumpkin_private_key: toHex(grumpkinPrivKey),
      };

      const noir = new Noir(proveHandArtifact as never);
      await expect(noir.execute(inputs as never)).rejects.toThrow();
    }, 120000);

    it('rejects zero grumpkin private key', async () => {
      const commit = await computeCardCommit(
        playerSecret, playerAddress, gameId, cardIds, cardRanks, nullSecrets,
      );

      const inputs: Record<string, unknown> = {
        card_commit: toHex(commit),
        player_address: toHex(playerAddress),
        game_id: toHex(gameId),
        grumpkin_public_key_x: '0x0',
        grumpkin_public_key_y: '0x0',
        player_secret: toHex(playerSecret),
        card_ids: cardIds.map((id) => toHex(id)),
        card_ranks: cardRanks.map((r) => r.map((v) => toHex(v))),
        card_nullifier_secrets: nullSecrets.map((s) => toHex(s)),
        grumpkin_private_key: '0x0',
      };

      const noir = new Noir(proveHandArtifact as never);
      await expect(noir.execute(inputs as never)).rejects.toThrow();
    }, 120000);

    it('rejects wrong card commitment', async () => {
      const pubkey = await deriveGrumpkinPubkey(grumpkinPrivKey);

      const inputs: Record<string, unknown> = {
        card_commit: '0xdeadbeef',
        player_address: toHex(playerAddress),
        game_id: toHex(gameId),
        grumpkin_public_key_x: pubkey.x,
        grumpkin_public_key_y: pubkey.y,
        player_secret: toHex(playerSecret),
        card_ids: cardIds.map((id) => toHex(id)),
        card_ranks: cardRanks.map((r) => r.map((v) => toHex(v))),
        card_nullifier_secrets: nullSecrets.map((s) => toHex(s)),
        grumpkin_private_key: toHex(grumpkinPrivKey),
      };

      const noir = new Noir(proveHandArtifact as never);
      await expect(noir.execute(inputs as never)).rejects.toThrow();
    }, 120000);

    it('rejects duplicate card IDs', async () => {
      const dupeIds = [1n, 2n, 3n, 4n, 1n];
      const dupeRanks = [...cardRanks.slice(0, 4), CARD_RANKS[1]];
      const commit = await computeCardCommit(
        playerSecret, playerAddress, gameId, dupeIds, dupeRanks, nullSecrets,
      );
      const pubkey = await deriveGrumpkinPubkey(grumpkinPrivKey);

      const inputs: Record<string, unknown> = {
        card_commit: toHex(commit),
        player_address: toHex(playerAddress),
        game_id: toHex(gameId),
        grumpkin_public_key_x: pubkey.x,
        grumpkin_public_key_y: pubkey.y,
        player_secret: toHex(playerSecret),
        card_ids: dupeIds.map((id) => toHex(id)),
        card_ranks: dupeRanks.map((r) => r.map((v) => toHex(v))),
        card_nullifier_secrets: nullSecrets.map((s) => toHex(s)),
        grumpkin_private_key: toHex(grumpkinPrivKey),
      };

      const noir = new Noir(proveHandArtifact as never);
      await expect(noir.execute(inputs as never)).rejects.toThrow();
    }, 120000);
  });

  // ====================== game_move Tests ======================

  describe('game_move circuit', () => {
    // Player 1: cards 1-5
    const p1Secret = 111n;
    const p1Address = 0xaaan;
    const p1CardIds = [1n, 2n, 3n, 4n, 5n];
    const p1Ranks = p1CardIds.map((id) => CARD_RANKS[Number(id)]);
    const p1NullSecrets = [100n, 200n, 300n, 400n, 500n];
    const p1PrivKey = 42n;

    // Player 2: cards 10-14
    const p2Secret = 222n;
    const p2Address = 0xbbbn;
    const p2CardIds = [10n, 11n, 12n, 13n, 14n];
    const p2Ranks = p2CardIds.map((id) => CARD_RANKS[Number(id)]);
    const p2NullSecrets = [600n, 700n, 800n, 900n, 1000n];
    const p2PrivKey = 77n;

    const testGameId = 1n;

    it('executes first move (P1 places card 1 at 0,0 on empty board)', async () => {
      const cc1 = await computeCardCommit(p1Secret, p1Address, testGameId, p1CardIds, p1Ranks, p1NullSecrets);
      const cc2 = await computeCardCommit(p2Secret, p2Address, testGameId, p2CardIds, p2Ranks, p2NullSecrets);
      const p2Pubkey = await deriveGrumpkinPubkey(p2PrivKey);

      const boardBefore = new Array(18).fill(0n) as bigint[];
      const scoresBefore: [bigint, bigint] = [5n, 5n];

      const boardAfter = new Array(18).fill(0n) as bigint[];
      boardAfter[0] = 1n; // card_id
      boardAfter[1] = 1n; // owner
      const scoresAfter: [bigint, bigint] = [5n, 5n];

      const startHash = await hashBoardState(boardBefore, scoresBefore, 1n);
      const endHash = await hashBoardState(boardAfter, scoresAfter, 2n);

      const encNullifier = await computeEncryptedNullifier(
        100n, p1PrivKey, p2Pubkey.x, p2Pubkey.y, 0n,
      );

      const inputs: Record<string, unknown> = {
        card_commit_1: toHex(cc1),
        card_commit_2: toHex(cc2),
        start_state_hash: toHex(startHash),
        end_state_hash: toHex(endHash),
        game_ended: '0x0',
        winner_id: '0x0',
        encrypted_card_nullifier: toHex(encNullifier),
        current_player: '0x1',
        card_id: '0x1',
        row: '0x0',
        col: '0x0',
        board_before: boardBefore.map((v) => toHex(v)),
        board_after: boardAfter.map((v) => toHex(v)),
        scores_before: [toHex(scoresBefore[0]), toHex(scoresBefore[1])],
        scores_after: [toHex(scoresAfter[0]), toHex(scoresAfter[1])],
        current_turn_before: '0x1',
        player_secret: toHex(p1Secret),
        player_address: toHex(p1Address),
        game_id: toHex(testGameId),
        player_card_ids: p1CardIds.map((id) => toHex(id)),
        player_card_ranks: p1Ranks.map((r) => r.map((v) => toHex(v))),
        player_nullifier_secrets: p1NullSecrets.map((s) => toHex(s)),
        grumpkin_private_key: toHex(p1PrivKey),
        opponent_pubkey_x: p2Pubkey.x,
        opponent_pubkey_y: p2Pubkey.y,
        move_index: '0x0',
      };

      const noir = new Noir(gameMoveArtifact as never);
      const { witness } = await noir.execute(inputs as never);
      expect(witness).toBeDefined();
      expect(witness.length).toBeGreaterThan(0);
    }, 120000);

    it('executes second move (P2 places card 10 at 1,1)', async () => {
      const cc1 = await computeCardCommit(p1Secret, p1Address, testGameId, p1CardIds, p1Ranks, p1NullSecrets);
      const cc2 = await computeCardCommit(p2Secret, p2Address, testGameId, p2CardIds, p2Ranks, p2NullSecrets);
      const p1Pubkey = await deriveGrumpkinPubkey(p1PrivKey);

      const boardBefore = new Array(18).fill(0n) as bigint[];
      boardBefore[0] = 1n; boardBefore[1] = 1n; // P1 card at (0,0)
      const scoresBefore: [bigint, bigint] = [5n, 5n];

      const boardAfter = [...boardBefore];
      boardAfter[8] = 10n; boardAfter[9] = 2n; // P2 card at (1,1)
      const scoresAfter: [bigint, bigint] = [5n, 5n];

      const startHash = await hashBoardState(boardBefore, scoresBefore, 2n);
      const endHash = await hashBoardState(boardAfter, scoresAfter, 1n);

      const encNullifier = await computeEncryptedNullifier(
        600n, p2PrivKey, p1Pubkey.x, p1Pubkey.y, 1n,
      );

      const inputs: Record<string, unknown> = {
        card_commit_1: toHex(cc1),
        card_commit_2: toHex(cc2),
        start_state_hash: toHex(startHash),
        end_state_hash: toHex(endHash),
        game_ended: '0x0',
        winner_id: '0x0',
        encrypted_card_nullifier: toHex(encNullifier),
        current_player: '0x2',
        card_id: toHex(10),
        row: '0x1',
        col: '0x1',
        board_before: boardBefore.map((v) => toHex(v)),
        board_after: boardAfter.map((v) => toHex(v)),
        scores_before: [toHex(scoresBefore[0]), toHex(scoresBefore[1])],
        scores_after: [toHex(scoresAfter[0]), toHex(scoresAfter[1])],
        current_turn_before: '0x2',
        player_secret: toHex(p2Secret),
        player_address: toHex(p2Address),
        game_id: toHex(testGameId),
        player_card_ids: p2CardIds.map((id) => toHex(id)),
        player_card_ranks: p2Ranks.map((r) => r.map((v) => toHex(v))),
        player_nullifier_secrets: p2NullSecrets.map((s) => toHex(s)),
        grumpkin_private_key: toHex(p2PrivKey),
        opponent_pubkey_x: p1Pubkey.x,
        opponent_pubkey_y: p1Pubkey.y,
        move_index: '0x1',
      };

      const noir = new Noir(gameMoveArtifact as never);
      const { witness } = await noir.execute(inputs as never);
      expect(witness).toBeDefined();
      expect(witness.length).toBeGreaterThan(0);
    }, 120000);

    it('executes capture move (P1 Sunny captures P2 Peaches)', async () => {
      const cc1 = await computeCardCommit(p1Secret, p1Address, testGameId, p1CardIds, p1Ranks, p1NullSecrets);
      const cc2 = await computeCardCommit(p2Secret, p2Address, testGameId, p2CardIds, p2Ranks, p2NullSecrets);
      const p2Pubkey = await deriveGrumpkinPubkey(p2PrivKey);

      // Board: P1 card 1 at (0,0), P2 card 10 at (0,1)
      // P1 places card 4 (Sunny [6,1,1,2]) at (1,1)
      // top=6 vs Peaches bottom=2 -> CAPTURE
      const boardBefore = new Array(18).fill(0n) as bigint[];
      boardBefore[0] = 1n; boardBefore[1] = 1n;   // (0,0) P1 card 1
      boardBefore[2] = 10n; boardBefore[3] = 2n;  // (0,1) P2 card 10
      const scoresBefore: [bigint, bigint] = [5n, 5n];

      const boardAfter = new Array(18).fill(0n) as bigint[];
      boardAfter[0] = 1n; boardAfter[1] = 1n;     // unchanged
      boardAfter[2] = 10n; boardAfter[3] = 1n;    // CAPTURED
      boardAfter[8] = 4n; boardAfter[9] = 1n;     // placed
      const scoresAfter: [bigint, bigint] = [6n, 4n];

      const startHash = await hashBoardState(boardBefore, scoresBefore, 1n);
      const endHash = await hashBoardState(boardAfter, scoresAfter, 2n);

      // Card 4 (Sunny) is index 3 in P1 hand, nullifier = 400
      const encNullifier = await computeEncryptedNullifier(
        400n, p1PrivKey, p2Pubkey.x, p2Pubkey.y, 2n, // move_index=2 (2 cards on board)
      );

      const inputs: Record<string, unknown> = {
        card_commit_1: toHex(cc1),
        card_commit_2: toHex(cc2),
        start_state_hash: toHex(startHash),
        end_state_hash: toHex(endHash),
        game_ended: '0x0',
        winner_id: '0x0',
        encrypted_card_nullifier: toHex(encNullifier),
        current_player: '0x1',
        card_id: '0x4',
        row: '0x1',
        col: '0x1',
        board_before: boardBefore.map((v) => toHex(v)),
        board_after: boardAfter.map((v) => toHex(v)),
        scores_before: [toHex(scoresBefore[0]), toHex(scoresBefore[1])],
        scores_after: [toHex(scoresAfter[0]), toHex(scoresAfter[1])],
        current_turn_before: '0x1',
        player_secret: toHex(p1Secret),
        player_address: toHex(p1Address),
        game_id: toHex(testGameId),
        player_card_ids: p1CardIds.map((id) => toHex(id)),
        player_card_ranks: p1Ranks.map((r) => r.map((v) => toHex(v))),
        player_nullifier_secrets: p1NullSecrets.map((s) => toHex(s)),
        grumpkin_private_key: toHex(p1PrivKey),
        opponent_pubkey_x: p2Pubkey.x,
        opponent_pubkey_y: p2Pubkey.y,
        move_index: '0x2',
      };

      const noir = new Noir(gameMoveArtifact as never);
      const { witness } = await noir.execute(inputs as never);
      expect(witness).toBeDefined();
      expect(witness.length).toBeGreaterThan(0);
    }, 120000);

    it('rejects move with wrong player turn', async () => {
      const cc1 = await computeCardCommit(p1Secret, p1Address, testGameId, p1CardIds, p1Ranks, p1NullSecrets);
      const cc2 = await computeCardCommit(p2Secret, p2Address, testGameId, p2CardIds, p2Ranks, p2NullSecrets);
      const p1Pubkey = await deriveGrumpkinPubkey(p1PrivKey);

      const boardBefore = new Array(18).fill(0n) as bigint[];
      const boardAfter = new Array(18).fill(0n) as bigint[];
      boardAfter[0] = 10n; boardAfter[1] = 2n;
      const startHash = await hashBoardState(boardBefore, [5n, 5n], 1n); // turn=P1
      const endHash = await hashBoardState(boardAfter, [5n, 5n], 1n);
      const encNullifier = await computeEncryptedNullifier(
        600n, p2PrivKey, p1Pubkey.x, p1Pubkey.y, 0n,
      );

      const inputs: Record<string, unknown> = {
        card_commit_1: toHex(cc1),
        card_commit_2: toHex(cc2),
        start_state_hash: toHex(startHash),
        end_state_hash: toHex(endHash),
        game_ended: '0x0',
        winner_id: '0x0',
        encrypted_card_nullifier: toHex(encNullifier),
        current_player: '0x2', // P2 trying to go when it's P1's turn
        card_id: toHex(10),
        row: '0x0',
        col: '0x0',
        board_before: boardBefore.map((v) => toHex(v)),
        board_after: boardAfter.map((v) => toHex(v)),
        scores_before: ['0x5', '0x5'],
        scores_after: ['0x5', '0x5'],
        current_turn_before: '0x1', // It's P1's turn
        player_secret: toHex(p2Secret),
        player_address: toHex(p2Address),
        game_id: toHex(testGameId),
        player_card_ids: p2CardIds.map((id) => toHex(id)),
        player_card_ranks: p2Ranks.map((r) => r.map((v) => toHex(v))),
        player_nullifier_secrets: p2NullSecrets.map((s) => toHex(s)),
        grumpkin_private_key: toHex(p2PrivKey),
        opponent_pubkey_x: p1Pubkey.x,
        opponent_pubkey_y: p1Pubkey.y,
        move_index: '0x0',
      };

      const noir = new Noir(gameMoveArtifact as never);
      await expect(noir.execute(inputs as never)).rejects.toThrow();
    }, 120000);

    it('rejects placing card on occupied cell', async () => {
      const cc1 = await computeCardCommit(p1Secret, p1Address, testGameId, p1CardIds, p1Ranks, p1NullSecrets);
      const cc2 = await computeCardCommit(p2Secret, p2Address, testGameId, p2CardIds, p2Ranks, p2NullSecrets);
      const p2Pubkey = await deriveGrumpkinPubkey(p2PrivKey);

      const boardBefore = new Array(18).fill(0n) as bigint[];
      boardBefore[0] = 1n; boardBefore[1] = 1n; // cell (0,0) occupied
      const boardAfter = [...boardBefore];
      boardAfter[0] = 2n; boardAfter[1] = 1n; // overwrite attempt

      const startHash = await hashBoardState(boardBefore, [5n, 5n], 1n);
      const endHash = await hashBoardState(boardAfter, [5n, 5n], 2n);
      const encNullifier = await computeEncryptedNullifier(
        200n, p1PrivKey, p2Pubkey.x, p2Pubkey.y, 1n,
      );

      const inputs: Record<string, unknown> = {
        card_commit_1: toHex(cc1),
        card_commit_2: toHex(cc2),
        start_state_hash: toHex(startHash),
        end_state_hash: toHex(endHash),
        game_ended: '0x0',
        winner_id: '0x0',
        encrypted_card_nullifier: toHex(encNullifier),
        current_player: '0x1',
        card_id: '0x2',
        row: '0x0',
        col: '0x0', // OCCUPIED
        board_before: boardBefore.map((v) => toHex(v)),
        board_after: boardAfter.map((v) => toHex(v)),
        scores_before: ['0x5', '0x5'],
        scores_after: ['0x5', '0x5'],
        current_turn_before: '0x1',
        player_secret: toHex(p1Secret),
        player_address: toHex(p1Address),
        game_id: toHex(testGameId),
        player_card_ids: p1CardIds.map((id) => toHex(id)),
        player_card_ranks: p1Ranks.map((r) => r.map((v) => toHex(v))),
        player_nullifier_secrets: p1NullSecrets.map((s) => toHex(s)),
        grumpkin_private_key: toHex(p1PrivKey),
        opponent_pubkey_x: p2Pubkey.x,
        opponent_pubkey_y: p2Pubkey.y,
        move_index: '0x1',
      };

      const noir = new Noir(gameMoveArtifact as never);
      await expect(noir.execute(inputs as never)).rejects.toThrow();
    }, 120000);
  });
});
