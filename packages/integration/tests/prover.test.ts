import { describe, it, expect } from 'vitest';
import { ProofService, MockProofBackend } from '../src/prover.js';

describe('MockProofBackend', () => {
  const backend = new MockProofBackend();

  it('generates a prove_hand proof', async () => {
    const proof = await backend.generateProveHandProof({
      card_commit_hash: '0xcommit',
      card_ids: ['1', '2', '3', '4', '5'],
      blinding_factor: '0x12345',
    });

    expect(proof.proof).toBeInstanceOf(Uint8Array);
    expect(proof.proof.length).toBeGreaterThan(0);
    expect(proof.publicInputs).toEqual(['0xcommit']);
  });

  it('generates a game_move proof', async () => {
    const proof = await backend.generateGameMoveProof({
      card_commit_1: '0xcc1',
      card_commit_2: '0xcc2',
      start_state_hash: '0xstart',
      end_state_hash: '0xend',
      game_ended: '0',
      winner_id: '0',
      current_player: '1',
      card_id: '5',
      row: '0',
      col: '0',
      board_before: Array(18).fill('0'),
      board_after: ['5', '1', ...Array(16).fill('0')],
      scores_before: ['5', '5'],
      scores_after: ['5', '5'],
      current_turn_before: '1',
      player_card_ids: ['1', '2', '3', '4', '5'],
      blinding_factor: '0x111',
    });

    expect(proof.proof).toBeInstanceOf(Uint8Array);
    expect(proof.publicInputs).toEqual(['0xcc1', '0xcc2', '0xstart', '0xend', '0', '0']);
  });

  it('verifies a mock proof', async () => {
    const proof = await backend.generateProveHandProof({
      card_commit_hash: '0xcommit',
      card_ids: ['1', '2', '3', '4', '5'],
      blinding_factor: '0x12345',
    });

    const isValid = await backend.verifyProof('prove_hand', proof);
    expect(isValid).toBe(true);
  });

  it('rejects a non-mock proof', async () => {
    const fakeProof = {
      proof: new TextEncoder().encode('not-a-mock-proof'),
      publicInputs: ['0xcommit'],
    };

    const isValid = await backend.verifyProof('prove_hand', fakeProof);
    expect(isValid).toBe(false);
  });
});

describe('ProofService', () => {
  const service = new ProofService(new MockProofBackend());

  it('generates a hand proof with correct type', async () => {
    const handProof = await service.proveHand(
      [1, 2, 3, 4, 5],
      '0x12345',
      '0xcommit',
    );

    expect(handProof.type).toBe('hand');
    expect(handProof.cardCommit).toBe('0xcommit');
    expect(typeof handProof.proof).toBe('string'); // base64
    expect(handProof.publicInputs).toEqual(['0xcommit']);
  });

  it('generates a move proof with correct type', async () => {
    const moveProof = await service.proveGameMove({
      card_commit_1: '0xcc1',
      card_commit_2: '0xcc2',
      start_state_hash: '0xstart',
      end_state_hash: '0xend',
      game_ended: '1',
      winner_id: '2',
      current_player: '2',
      card_id: '10',
      row: '1',
      col: '1',
      board_before: Array(18).fill('0'),
      board_after: Array(18).fill('0'),
      scores_before: ['5', '5'],
      scores_after: ['5', '5'],
      current_turn_before: '2',
      player_card_ids: ['6', '7', '8', '9', '10'],
      blinding_factor: '0x222',
    });

    expect(moveProof.type).toBe('move');
    expect(moveProof.cardCommit1).toBe('0xcc1');
    expect(moveProof.cardCommit2).toBe('0xcc2');
    expect(moveProof.gameEnded).toBe(true);
    expect(moveProof.winnerId).toBe(2);
  });
});
