/**
 * Generates REAL proofs (no mocks). The move circuit is small enough that this
 * runs in seconds — and a mocked proof test would assert nothing about the
 * thing that actually matters, which is that the bot's witness encoding is
 * accepted by the same circuit players use.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { installNodeArtifactSources } from '../src/circuits.js';
import { BotProofs } from '../src/BotProofs.js';
import { normalizeMoveProof } from '../src/protocol.js';
import { createGame, getCardsByIds, placeCard } from '@axolotl-arena/game-logic';

const P1 = [1, 2, 3, 4, 5];
const P2 = [6, 7, 8, 9, 10];
const BF1 = '0x' + '11'.padStart(64, '0');
const BF2 = '0x' + '22'.padStart(64, '0');

let proofs: BotProofs;
beforeAll(async () => {
  await installNodeArtifactSources();
  proofs = new BotProofs();
}, 120_000);

describe('BotProofs hashes', () => {
  it('card commitment is deterministic and blinding-factor dependent', async () => {
    const a = await proofs.cardCommitHash(P1, BF1);
    const b = await proofs.cardCommitHash(P1, BF1);
    const c = await proofs.cardCommitHash(P1, BF2);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^0x[0-9a-f]+$/);
  });

  it('rejects a hand that is not five cards rather than proving nonsense', async () => {
    await expect(proofs.cardCommitHash([1, 2, 3], BF1)).rejects.toThrow(/expected 5 card IDs/);
  });
});

describe('BotProofs game_move', () => {
  it('proves player 2\'s move and publishes the placed card and its committed slot', async () => {
    const opened = placeCard(createGame(getCardsByIds(P1), getCardsByIds(P2)), 'player1', 0, 0, 0).newState;
    // Player 2 plays card 9 — slot 3 of the hand as committed.
    const handIndex = opened.player2Hand.findIndex(c => c.id === 9);
    const { newState: after } = placeCard(opened, 'player2', handIndex, 1, 1);
    const commit1 = await proofs.cardCommitHash(P1, BF1);
    const commit2 = await proofs.cardCommitHash(P2, BF2);

    const raw = await proofs.proveMove({
      cardId: 9, row: 1, col: 1, currentPlayer: 2,
      boardBefore: opened.board, boardAfter: after.board,
      scoresBefore: [opened.player1Score, opened.player2Score],
      scoresAfter: [after.player1Score, after.player2Score],
      cardCommit1: commit1, cardCommit2: commit2,
      gameEnded: false, winnerId: 0,
      hand: { cardIds: P2, blindingFactor: BF2 },
    });

    expect(typeof raw.proof).toBe('string');
    expect(raw.publicInputs).toHaveLength(8);
    // What the bot keeps is read from those inputs; they must say what settlement needs.
    const kept = normalizeMoveProof(raw)!;
    expect(kept).not.toBeNull();
    expect(kept.cardCommit1).toBe(commit1);
    expect(kept.cardCommit2).toBe(commit2);
    expect(kept.placedCardId).toBe(9);
    expect(kept.placedSlot).toBe(3);
    expect(kept.startStateHash).not.toBe(kept.endStateHash);
    expect(kept.gameEnded).toBe(false);
  }, 180_000);

  it('cannot prove a card that is not in the hand it committed', async () => {
    const before = createGame(getCardsByIds(P1), getCardsByIds(P2));
    const { newState: after } = placeCard(before, 'player1', 0, 0, 0);
    await expect(proofs.proveMove({
      cardId: 1, row: 0, col: 0, currentPlayer: 1,
      boardBefore: before.board, boardAfter: after.board,
      scoresBefore: [before.player1Score, before.player2Score],
      scoresAfter: [after.player1Score, after.player2Score],
      cardCommit1: await proofs.cardCommitHash(P1, BF1),
      cardCommit2: await proofs.cardCommitHash(P2, BF2),
      gameEnded: false, winnerId: 0,
      // The wrong hand: card 1 is not in it, so it has no slot to name.
      hand: { cardIds: P2, blindingFactor: BF1 },
    })).rejects.toThrow();
  }, 180_000);
});

describe('BotProofs serialisation', () => {
  it('a failed proof does not wedge every later one behind a rejected promise', async () => {
    const p = new BotProofs();
    const before = createGame(getCardsByIds(P1), getCardsByIds(P2));
    const { newState: after } = placeCard(before, 'player1', 0, 0, 0);
    const move = async (hand: number[]) => p.proveMove({
      cardId: 1, row: 0, col: 0, currentPlayer: 1,
      boardBefore: before.board, boardAfter: after.board,
      scoresBefore: [before.player1Score, before.player2Score],
      scoresAfter: [after.player1Score, after.player2Score],
      cardCommit1: await p.cardCommitHash(P1, BF1),
      cardCommit2: await p.cardCommitHash(P2, BF2),
      gameEnded: false, winnerId: 0,
      hand: { cardIds: hand, blindingFactor: BF1 },
    });
    await expect(move(P2)).rejects.toThrow();
    // The queue must still accept work after a failure.
    const ok = await move(P1);
    expect(ok.publicInputs).toHaveLength(8);
  }, 180_000);
});

describe('BotProofs verification key', () => {
  it('derives the move VK from the artifact it proves with, and caches it', async () => {
    const t0 = Date.now();
    const a = await proofs.moveVerificationKey();
    const firstMs = Date.now() - t0;
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.length).toBeGreaterThan(0);
    // settle_game takes it as 32-byte fields.
    expect(a.length % 32).toBe(0);

    const t1 = Date.now();
    const b = await proofs.moveVerificationKey();
    expect(b).toBe(a);              // same object — cached
    expect(Date.now() - t1).toBeLessThan(Math.max(50, firstMs));
  }, 180_000);
});
