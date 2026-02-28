import { describe, it, expect } from 'vitest';
import { GameSession } from '../src/game-session.js';
import { ProofService, MockProofBackend } from '../src/prover.js';
import { getCardsByIds } from '@aztec-triple-triad/game-logic';
import type { PlayerSession } from '../src/types.js';
import { createHandProof } from '../src/proof-utils.js';

// Simple hash mock: just concatenate fields
async function mockComputeHash(fields: string[]): Promise<string> {
  return '0x' + fields.join('_');
}

function createPlayerSession(
  cardIds: number[],
  blindingFactor: string,
): PlayerSession {
  return {
    cardIds,
    blindingFactor,
    cardCommit: `commit_${blindingFactor}`,
  };
}

describe('GameSession', () => {
  const backend = new MockProofBackend();
  const service = new ProofService(backend);

  const p1CardIds = [1, 2, 3, 4, 5];
  const p2CardIds = [6, 7, 8, 9, 10];
  const p1Cards = getCardsByIds(p1CardIds);
  const p2Cards = getCardsByIds(p2CardIds);

  const p1Session = createPlayerSession(p1CardIds, '0xp1blinding');
  const p2Session = createPlayerSession(p2CardIds, '0xp2blinding');

  it('initializes hand proof', async () => {
    const session = new GameSession(
      service,
      p1Session,
      'player1',
      'game-1',
      mockComputeHash,
    );

    const handProof = await session.initializeHand();
    expect(handProof.type).toBe('hand');
    expect(handProof.cardCommit).toBe(p1Session.cardCommit);
  });

  it('starts a game after hand proof exchange', async () => {
    const session = new GameSession(
      service,
      p1Session,
      'player1',
      'game-1',
      mockComputeHash,
    );

    const handProof = await session.initializeHand();

    // Simulate opponent hand proof
    const opponentProof = createHandProof(
      { proof: new Uint8Array([1, 2, 3]), publicInputs: [p2Session.cardCommit] },
      p2Session.cardCommit,
    );
    session.setOpponentHandProof(opponentProof);

    await session.startGame(p1Cards, p2Cards);

    const state = session.getGameState();
    expect(state).toBeDefined();
    expect(state.player1Hand).toHaveLength(5);
    expect(state.player2Hand).toHaveLength(5);
    expect(state.currentTurn).toBe('player1');
    expect(session.isMyTurn()).toBe(true);
  });

  it('makes a move and generates a proof', async () => {
    const session = new GameSession(
      service,
      p1Session,
      'player1',
      'game-1',
      mockComputeHash,
    );

    await session.initializeHand();
    const opponentProof = createHandProof(
      { proof: new Uint8Array([1, 2, 3]), publicInputs: [p2Session.cardCommit] },
      p2Session.cardCommit,
    );
    session.setOpponentHandProof(opponentProof);
    await session.startGame(p1Cards, p2Cards);

    // Make first move
    const moveProof = await session.makeMove(0, 0, 0);

    expect(moveProof.type).toBe('move');
    expect(moveProof.gameEnded).toBe(false);
    expect(moveProof.winnerId).toBe(0);

    // After the move, it should be opponent's turn
    expect(session.isMyTurn()).toBe(false);
  });

  it('applies opponent moves', async () => {
    const session = new GameSession(
      service,
      p1Session,
      'player1',
      'game-1',
      mockComputeHash,
    );

    await session.initializeHand();
    const opponentProof = createHandProof(
      { proof: new Uint8Array([1, 2, 3]), publicInputs: [p2Session.cardCommit] },
      p2Session.cardCommit,
    );
    session.setOpponentHandProof(opponentProof);
    await session.startGame(p1Cards, p2Cards);

    // Player 1 makes a move
    const p1MoveProof = await session.makeMove(0, 0, 0);

    // Simulate opponent's move proof
    const mockOpponentMoveProof = {
      type: 'move' as const,
      proof: 'base64data',
      publicInputs: ['0xcc1', '0xcc2', '0xstart', '0xend', '0', '0'],
      cardCommit1: p1Session.cardCommit,
      cardCommit2: p2Session.cardCommit,
      startStateHash: '0xstart',
      endStateHash: '0xend',
      gameEnded: false,
      winnerId: 0,
    };

    // Apply opponent move
    await session.applyOpponentMove(mockOpponentMoveProof, 0, 1, 1);

    // It should be player 1's turn again
    expect(session.isMyTurn()).toBe(true);

    const state = session.getGameState();
    expect(state.board[0][0].card).not.toBeNull(); // p1's card
    expect(state.board[1][1].card).not.toBeNull(); // p2's card
  });

  it('detects game over and winner correctly', async () => {
    const session = new GameSession(
      service,
      p1Session,
      'player1',
      'game-1',
      mockComputeHash,
    );

    await session.initializeHand();
    const opponentProof = createHandProof(
      { proof: new Uint8Array([1, 2, 3]), publicInputs: [p2Session.cardCommit] },
      p2Session.cardCommit,
    );
    session.setOpponentHandProof(opponentProof);
    await session.startGame(p1Cards, p2Cards);

    // Simulate a full game
    const mockMoveProof = {
      type: 'move' as const,
      proof: 'base64data',
      publicInputs: ['0xcc1', '0xcc2', '0xstart', '0xend', '0', '0'],
      cardCommit1: p1Session.cardCommit,
      cardCommit2: p2Session.cardCommit,
      startStateHash: '0xstart',
      endStateHash: '0xend',
      gameEnded: false,
      winnerId: 0,
    };

    // Play through 9 moves (5 p1, 4 p2)
    const positions = [
      [0, 0], [0, 1], [0, 2],
      [1, 0], [1, 1], [1, 2],
      [2, 0], [2, 1], [2, 2],
    ];

    for (let i = 0; i < 9; i++) {
      const [row, col] = positions[i];
      if (i % 2 === 0) {
        // Player 1's turn
        await session.makeMove(0, row, col);
      } else {
        // Player 2's turn - apply opponent move
        await session.applyOpponentMove(mockMoveProof, 0, row, col);
      }
    }

    expect(session.isFinished()).toBe(true);
  });

  it('generates proof bundle for settlement', async () => {
    const session = new GameSession(
      service,
      p1Session,
      'player1',
      'game-1',
      mockComputeHash,
    );

    await session.initializeHand();
    const opponentProof = createHandProof(
      { proof: new Uint8Array([1, 2, 3]), publicInputs: [p2Session.cardCommit] },
      p2Session.cardCommit,
    );
    session.setOpponentHandProof(opponentProof);
    await session.startGame(p1Cards, p2Cards);

    const mockMoveProof = {
      type: 'move' as const,
      proof: 'base64data',
      publicInputs: ['0xcc1', '0xcc2', '0xstart', '0xend', '0', '0'],
      cardCommit1: p1Session.cardCommit,
      cardCommit2: p2Session.cardCommit,
      startStateHash: '0xstart',
      endStateHash: '0xend',
      gameEnded: false,
      winnerId: 0,
    };

    // Play full game
    const positions = [
      [0, 0], [0, 1], [0, 2],
      [1, 0], [1, 1], [1, 2],
      [2, 0], [2, 1], [2, 2],
    ];
    for (let i = 0; i < 9; i++) {
      const [row, col] = positions[i];
      if (i % 2 === 0) {
        await session.makeMove(0, row, col);
      } else {
        await session.applyOpponentMove(mockMoveProof, 0, row, col);
      }
    }

    const bundle = session.getProofBundle(6); // take card 6 from opponent
    expect(bundle.gameId).toBe('game-1');
    expect(bundle.handProof1.type).toBe('hand');
    expect(bundle.handProof2.type).toBe('hand');
    expect(bundle.moveProofs.length).toBe(9);
    expect(bundle.selectedCardId).toBe(6);
    expect(bundle.winner).toBeDefined();
  });

  it('throws when getting proof bundle before game ends', async () => {
    const session = new GameSession(
      service,
      p1Session,
      'player1',
      'game-1',
      mockComputeHash,
    );

    await session.initializeHand();
    const opponentProof = createHandProof(
      { proof: new Uint8Array([1, 2, 3]), publicInputs: [p2Session.cardCommit] },
      p2Session.cardCommit,
    );
    session.setOpponentHandProof(opponentProof);
    await session.startGame(p1Cards, p2Cards);

    expect(() => session.getProofBundle(1)).toThrow('Game is not finished');
  });
});
