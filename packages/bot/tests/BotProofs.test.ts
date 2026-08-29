/**
 * Generates REAL proofs (no mocks). Both circuits are small enough that this
 * runs in well under a second each — and a mocked proof test would assert
 * nothing about the thing that actually matters, which is that the bot's
 * witness encoding is accepted by the same circuits players use.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { installNodeArtifactSources } from '../src/circuits.js';
import { BotProofs } from '../src/BotProofs.js';
import { createGame, getCardsByIds, placeCard } from '@axolotl-arena/game-logic';

const P1 = [1, 2, 3, 4, 5];
const P2 = [6, 7, 8, 9, 10];
const BF1 = '0x' + '11'.padStart(64, '0');
const BF2 = '0x' + '22'.padStart(64, '0');
const RANDOMNESS = Array.from({ length: 6 }, (_, i) => '0x' + String(i + 1).padStart(64, '0'));

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

  it('player state hash requires exactly six randomness values', async () => {
    await expect(proofs.playerStateHash(['0x1'])).rejects.toThrow(/expected 6 values/);
  });
});

describe('BotProofs prove_hand', () => {
  it('produces a real proof binding the card commitment as a public input', async () => {
    const proof: any = await proofs.proveHand({
      cardIds: P1, blindingFactor: BF1, opponentRandomness: RANDOMNESS,
    });
    expect(typeof proof.proof).toBe('string');
    expect(proof.proof.length).toBeGreaterThan(0);
    expect(proof.publicInputs).toHaveLength(2);
    // The circuit's first public input IS the commitment — verify against one
    // computed independently, so a witness-encoding drift cannot pass silently.
    expect(proof.cardCommit).toBe(await proofs.cardCommitHash(P1, BF1));
  }, 120_000);
});

describe('BotProofs game_move', () => {
  it('produces a real proof whose state hash advances across the move', async () => {
    const before = createGame(getCardsByIds(P1), getCardsByIds(P2));
    const { newState: after } = placeCard(before, 'player1', 0, 0, 0);

    const proof: any = await proofs.proveMove({
      cardId: before.player1Hand[0].id, row: 0, col: 0, currentPlayer: 1,
      boardBefore: before.board, boardAfter: after.board,
      scoresBefore: [before.player1Score, before.player2Score],
      scoresAfter: [after.player1Score, after.player2Score],
      cardCommit1: await proofs.cardCommitHash(P1, BF1),
      cardCommit2: await proofs.cardCommitHash(P2, BF2),
      gameEnded: false, winnerId: 0,
      playerHandData: { cardIds: P1, blindingFactor: BF1, handIndex: 0 },
    });

    expect(typeof proof.proof).toBe('string');
    expect(proof.publicInputs).toHaveLength(6);
    expect(proof.startStateHash).not.toBe(proof.endStateHash);
    expect(proof.gameEnded).toBe(false);
  }, 180_000);
});

describe('BotProofs serialisation', () => {
  it('a failed proof does not wedge every later one behind a rejected promise', async () => {
    const p = new BotProofs();
    await expect(p.cardCommitHash([1], BF1)).rejects.toThrow();
    await expect(p.proveHand({ cardIds: [1, 2], blindingFactor: BF1, opponentRandomness: RANDOMNESS }))
      .rejects.toThrow();
    // The queue must still accept work after two failures.
    const ok: any = await p.proveHand({ cardIds: P1, blindingFactor: BF1, opponentRandomness: RANDOMNESS });
    expect(typeof ok.proof).toBe('string');
  }, 180_000);
});
