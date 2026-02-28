import { describe, it, expect, beforeAll } from 'vitest';
import { GameSession } from '../src/game-session.js';
import { ProofService, MockProofBackend } from '../src/prover.js';
import type { PlayerSession, MoveProof } from '../src/types.js';
import { getCardsByIds } from '@aztec-triple-triad/game-logic';

/**
 * Simple hash function for testing (deterministic, non-cryptographic).
 * In production, this would be Poseidon2 or Pedersen.
 */
async function mockComputeStateHash(fields: string[]): Promise<string> {
  let hash = 0n;
  for (const f of fields) {
    const val = BigInt(f);
    hash = hash ^ val;
    hash = (hash * 31n + 17n) % (1n << 254n);
  }
  return '0x' + hash.toString(16).padStart(64, '0');
}

describe('E2E Game Flow', () => {
  let proofService: ProofService;
  let player1Session: PlayerSession;
  let player2Session: PlayerSession;
  let session1: GameSession;
  let session2: GameSession;

  const p1CardIds = [1, 2, 3, 4, 5];
  const p2CardIds = [6, 7, 8, 9, 10];

  beforeAll(() => {
    const backend = new MockProofBackend();
    proofService = new ProofService(backend);

    player1Session = {
      cardIds: p1CardIds,
      blindingFactor: '0x' + '01'.repeat(32),
      cardCommit: '0x' + 'aa'.repeat(32),
    };

    player2Session = {
      cardIds: p2CardIds,
      blindingFactor: '0x' + '02'.repeat(32),
      cardCommit: '0x' + 'bb'.repeat(32),
    };

    session1 = new GameSession(
      proofService, player1Session, 'player1', 'game-001', mockComputeStateHash,
    );
    session2 = new GameSession(
      proofService, player2Session, 'player2', 'game-001', mockComputeStateHash,
    );
  });

  it('should complete a full game with proof exchange', async () => {
    // 1. Both players generate hand proofs
    const handProof1 = await session1.initializeHand();
    const handProof2 = await session2.initializeHand();

    expect(handProof1.type).toBe('hand');
    expect(handProof1.cardCommit).toBe(player1Session.cardCommit);
    expect(handProof2.type).toBe('hand');
    expect(handProof2.cardCommit).toBe(player2Session.cardCommit);

    // 2. Exchange hand proofs
    session1.setOpponentHandProof(handProof2);
    session2.setOpponentHandProof(handProof1);

    // 3. Start the game
    const p1Cards = getCardsByIds(p1CardIds);
    const p2Cards = getCardsByIds(p2CardIds);
    await session1.startGame(p1Cards, p2Cards);
    await session2.startGame(p1Cards, p2Cards);

    expect(session1.isMyTurn()).toBe(true);
    expect(session2.isMyTurn()).toBe(false);

    // 4. Play 9 moves (alternating turns)
    // Always use handIndex 0 (play the first remaining card), since the hand
    // shrinks after each move. Row/col fill the board in order.
    const moves: [number, number, number][] = [
      [0, 0, 0], // P1 plays first remaining card to (0,0)
      [0, 0, 1], // P2 plays first remaining card to (0,1)
      [0, 0, 2], // P1
      [0, 1, 0], // P2
      [0, 1, 1], // P1
      [0, 1, 2], // P2
      [0, 2, 0], // P1
      [0, 2, 1], // P2
      [0, 2, 2], // P1 — last move, board full
    ];

    const allMoveProofs: MoveProof[] = [];

    for (let i = 0; i < moves.length; i++) {
      const [handIdx, row, col] = moves[i];
      const isP1Turn = i % 2 === 0;
      const activeSession = isP1Turn ? session1 : session2;
      const waitingSession = isP1Turn ? session2 : session1;

      expect(activeSession.isMyTurn()).toBe(true);

      // Active player makes a move and generates proof
      const moveProof = await activeSession.makeMove(handIdx, row, col);
      allMoveProofs.push(moveProof);

      expect(moveProof.type).toBe('move');
      expect(moveProof.cardCommit1).toBeTruthy();
      expect(moveProof.cardCommit2).toBeTruthy();
      expect(moveProof.startStateHash).toBeTruthy();
      expect(moveProof.endStateHash).toBeTruthy();

      // Waiting player applies the opponent's move
      await waitingSession.applyOpponentMove(moveProof, handIdx, row, col);
    }

    // 5. Verify game ended
    expect(session1.isFinished()).toBe(true);
    expect(session2.isFinished()).toBe(true);

    // Both sessions should agree on game state
    const state1 = session1.getGameState();
    const state2 = session2.getGameState();
    expect(state1.status).toBe('finished');
    expect(state2.status).toBe('finished');
    expect(state1.winner).toBe(state2.winner);

    // 6. Verify proof chain: endStateHash[i] === startStateHash[i+1]
    for (let i = 0; i < allMoveProofs.length - 1; i++) {
      expect(allMoveProofs[i].endStateHash).toBe(
        allMoveProofs[i + 1].startStateHash,
      );
    }

    // 7. Verify all 9 move proofs were generated
    expect(allMoveProofs.length).toBe(9);

    // 8. Winner (or player1 in case of draw) can get proof bundle
    const winner = state1.winner;
    expect(winner).not.toBeNull();

    if (winner !== 'draw') {
      const winnerSession = winner === 'player1' ? session1 : session2;
      const bundle = winnerSession.getProofBundle(1); // claim card ID 1
      expect(bundle.gameId).toBe('game-001');
      expect(bundle.handProof1.type).toBe('hand');
      expect(bundle.handProof2.type).toBe('hand');
      expect(bundle.moveProofs.length).toBe(9);
      expect(bundle.selectedCardId).toBe(1);
    } else {
      // In a draw, no card transfer occurs, but we verify the game is complete
      expect(state1.player1Score).toBe(state2.player1Score);
      expect(state1.player2Score).toBe(state2.player2Score);
    }
  });

  it('should reject a player making two moves in a row', async () => {
    const backend = new MockProofBackend();
    const ps = new ProofService(backend);

    const s1 = new GameSession(
      ps,
      { cardIds: p1CardIds, blindingFactor: '0x' + '01'.repeat(32), cardCommit: '0x' + 'aa'.repeat(32) },
      'player1', 'game-double-move', mockComputeStateHash,
    );
    const s2 = new GameSession(
      ps,
      { cardIds: p2CardIds, blindingFactor: '0x' + '02'.repeat(32), cardCommit: '0x' + 'bb'.repeat(32) },
      'player2', 'game-double-move', mockComputeStateHash,
    );

    const hp1 = await s1.initializeHand();
    const hp2 = await s2.initializeHand();
    s1.setOpponentHandProof(hp2);
    s2.setOpponentHandProof(hp1);

    const p1Cards = getCardsByIds(p1CardIds);
    const p2Cards = getCardsByIds(p2CardIds);
    await s1.startGame(p1Cards, p2Cards);
    await s2.startGame(p1Cards, p2Cards);

    // P1 makes a valid first move
    await s1.makeMove(0, 0, 0);

    // P1 tries to make a second move in a row — should fail (it's P2's turn)
    await expect(s1.makeMove(0, 0, 1)).rejects.toThrow("It is not player1's turn");
  });

  it('should reject making moves before the game is joined (started)', async () => {
    const backend = new MockProofBackend();
    const ps = new ProofService(backend);

    const s1 = new GameSession(
      ps,
      { cardIds: p1CardIds, blindingFactor: '0x' + '01'.repeat(32), cardCommit: '0x' + 'aa'.repeat(32) },
      'player1', 'game-not-started', mockComputeStateHash,
    );

    // Game created but never started (no opponent joined / startGame never called).
    // Attempting to make a move should fail because gameState is null.
    await expect(s1.makeMove(0, 0, 0)).rejects.toThrow();
  });

  it('should reject starting a game without opponent hand proof (game not joined)', async () => {
    const backend = new MockProofBackend();
    const ps = new ProofService(backend);

    const s1 = new GameSession(
      ps,
      { cardIds: p1CardIds, blindingFactor: '0x' + '01'.repeat(32), cardCommit: '0x' + 'aa'.repeat(32) },
      'player1', 'game-no-opponent', mockComputeStateHash,
    );

    await s1.initializeHand();
    // Do NOT set opponent hand proof — simulates no opponent having joined

    const p1Cards = getCardsByIds(p1CardIds);
    const p2Cards = getCardsByIds(p2CardIds);

    // startGame accesses opponentHandProof!.cardCommit which is null → throws
    await expect(s1.startGame(p1Cards, p2Cards)).rejects.toThrow();
  });

  it('should reject placing a card on an occupied cell', async () => {
    const backend = new MockProofBackend();
    const ps = new ProofService(backend);

    const s1 = new GameSession(
      ps,
      { cardIds: p1CardIds, blindingFactor: '0x' + '01'.repeat(32), cardCommit: '0x' + 'aa'.repeat(32) },
      'player1', 'game-occupied-cell', mockComputeStateHash,
    );
    const s2 = new GameSession(
      ps,
      { cardIds: p2CardIds, blindingFactor: '0x' + '02'.repeat(32), cardCommit: '0x' + 'bb'.repeat(32) },
      'player2', 'game-occupied-cell', mockComputeStateHash,
    );

    const hp1 = await s1.initializeHand();
    const hp2 = await s2.initializeHand();
    s1.setOpponentHandProof(hp2);
    s2.setOpponentHandProof(hp1);

    const p1Cards = getCardsByIds(p1CardIds);
    const p2Cards = getCardsByIds(p2CardIds);
    await s1.startGame(p1Cards, p2Cards);
    await s2.startGame(p1Cards, p2Cards);

    // P1 places at (1,1)
    const moveProof = await s1.makeMove(0, 1, 1);
    await s2.applyOpponentMove(moveProof, 0, 1, 1);

    // P2 tries to place at (1,1) — already occupied
    await expect(s2.makeMove(0, 1, 1)).rejects.toThrow('Cell (1, 1) is already occupied');
  });

  it('should reject getting proof bundle when game is not finished', async () => {
    const backend = new MockProofBackend();
    const ps = new ProofService(backend);

    const s1 = new GameSession(
      ps,
      { cardIds: p1CardIds, blindingFactor: '0x01', cardCommit: '0xaa' },
      'player1', 'game-003', mockComputeStateHash,
    );
    const s2 = new GameSession(
      ps,
      { cardIds: p2CardIds, blindingFactor: '0x02', cardCommit: '0xbb' },
      'player2', 'game-003', mockComputeStateHash,
    );

    const hp1 = await s1.initializeHand();
    const hp2 = await s2.initializeHand();
    s1.setOpponentHandProof(hp2);
    s2.setOpponentHandProof(hp1);

    const p1Cards = getCardsByIds(p1CardIds);
    const p2Cards = getCardsByIds(p2CardIds);
    await s1.startGame(p1Cards, p2Cards);

    // Game not finished, getProofBundle should throw
    expect(() => s1.getProofBundle(1)).toThrow('Game is not finished');
  });
});
