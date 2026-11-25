/**
 * Real proofs through the Phase B checks (docs/plan/PRIVATE_GAMES.md 6.3):
 * a move proven by `generateGameMoveProof` (what the mover's browser runs) is
 * accepted by `checkOpponentMove` with the real pedersen state hash and the
 * real bb.js verifier (what the receiver's browser runs) — so the two sides'
 * state hashes agree and the verifying key computed from the artifact fits
 * the proofs. A proof for anything else, or a damaged one, is refused. The
 * same for the open-cards proof.
 *
 * Slow: each proof takes seconds to tens of seconds of WASM proving.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { setCircuitSource, resetCircuitSource } from '../aztec/circuitLoader';
import {
  computeBoardStateHash,
  computeCardCommitPoseidon2,
  generateGameMoveProof,
  generateOpenCardsProof,
  verifyGameMoveProof,
  verifyOpenCardsProof,
} from '../aztec/proofWorker';
import { checkOpenCards, checkOpponentMove, type ProofChecks } from '../aztec/moveChecks';
import {
  encodeBoardState,
  encodeOriginalOwners,
  parseMovePayload,
  parseOpenCardsPayload,
  replay,
  winnerIdOf,
  type GameMove,
  type LocalGameFacts,
} from '../aztec/localGame';
import { normalizeField } from '../aztec/privateGame';
import type { MoveProofData } from '../types';

const CIRCUITS = resolve(__dirname, '../../public/circuits');
const P1_HAND = [11, 12, 13, 14, 15];
const P2_HAND = [21, 22, 23, 24, 25];
const B1 = '0x1234';
const B2 = '0x5678';

const REAL: ProofChecks = {
  hashState: computeBoardStateHash,
  verifyMove: verifyGameMoveProof,
  verifyOpenCards: verifyOpenCardsProof,
};

let commits: { commit1: string; commit2: string };

beforeAll(async () => {
  setCircuitSource(async name => JSON.parse(readFileSync(resolve(CIRCUITS, `${name}.json`), 'utf8')));
  commits = {
    commit1: await computeCardCommitPoseidon2(P1_HAND, B1),
    commit2: await computeCardCommitPoseidon2(P2_HAND, B2),
  };
  return () => resetCircuitSource();
}, 120_000);

/** What the mover's client does for `move`: the proof from the boards before and after. */
async function proveAsMover(facts: LocalGameFacts, move: GameMove, blinding: string): Promise<MoveProofData> {
  const before = replay(facts).state;
  const after = replay({ ...facts, moves: [...facts.moves, move] }).state;
  const ended = after.status === 'finished';
  return generateGameMoveProof(
    move.cardId, move.row, move.col, facts.role,
    encodeBoardState(before.board), encodeBoardState(after.board),
    [before.player1Score, before.player2Score], [after.player1Score, after.player2Score],
    commits.commit1, commits.commit2,
    ended, winnerIdOf(ended ? after.winner : null),
    { cardIds: facts.ownHand, blindingFactor: blinding },
    encodeOriginalOwners(before.board), encodeOriginalOwners(after.board),
  );
}

/** The bytes of a proof with one byte changed. */
function damaged(proofB64: string): string {
  const bytes = Uint8Array.from(atob(proofB64), c => c.charCodeAt(0));
  bytes[bytes.length >> 1] ^= 0x01;
  return btoa(String.fromCharCode(...bytes));
}

describe('a real move proof, checked by the opponent', () => {
  it('is accepted by the receiver\'s checks — and refused when damaged or claimed for another statement', async () => {
    // Player 1 moves first, from hidden slot 3; player 2 has not seen any of
    // player 1's cards (no OPEN_CARDS yet).
    const move: GameMove = { moveNumber: 0, cardId: P1_HAND[3], slot: 3, row: 1, col: 2 };
    const proof = await proveAsMover({ role: 1, ownHand: P1_HAND, opponentOpen: null, moves: [] }, move, B1);
    const payload = parseMovePayload({ cardId: move.cardId, slot: move.slot, row: move.row, col: move.col, proof: proof.proof, publicInputs: proof.publicInputs });

    const receiver: LocalGameFacts = { role: 2, ownHand: P2_HAND, opponentOpen: null, moves: [] };
    const accepted = await checkOpponentMove(receiver, commits, 0, payload, REAL);
    expect(accepted).toMatchObject({ ok: true });
    if (accepted.ok) expect(accepted.value.proof).toMatchObject({ placedCardId: P1_HAND[3], placedSlot: 3, gameEnded: false });

    // A damaged proof fails the verifier itself.
    expect(await verifyGameMoveProof(damaged(payload.proof), payload.publicInputs)).toBe(false);
    expect(await checkOpponentMove(receiver, commits, 0, { ...payload, proof: damaged(payload.proof) }, REAL))
      .toEqual({ ok: false, reason: 'its proof does not verify', retryable: false });

    // The proof binds its public inputs: the same proof for another slot does not verify...
    const otherSlot = [...payload.publicInputs];
    otherSlot[7] = normalizeField(2);
    expect(await verifyGameMoveProof(payload.proof, otherSlot)).toBe(false);
    // ...so a sender claiming the card came from open slot 2 — a claim the
    // receiver cannot check before the open cards arrive — is caught there.
    expect(await checkOpponentMove(receiver, commits, 0, { ...payload, slot: 2, publicInputs: otherSlot }, REAL))
      .toEqual({ ok: false, reason: 'its proof does not verify', retryable: false });

    // The second move chains on the first: player 1 checks player 2's reply.
    const reply: GameMove = { moveNumber: 1, cardId: P2_HAND[0], slot: 0, row: 0, col: 0 };
    const replyProof = await proveAsMover({ role: 2, ownHand: P2_HAND, opponentOpen: null, moves: [move] }, reply, B2);
    expect(normalizeField(replyProof.startStateHash)).toBe(normalizeField(proof.endStateHash));
    const p1View: LocalGameFacts = { role: 1, ownHand: P1_HAND, opponentOpen: null, moves: [move] };
    const replyPayload = parseMovePayload({ ...reply, proof: replyProof.proof, publicInputs: replyProof.publicInputs });
    expect(await checkOpponentMove(p1View, commits, 1, replyPayload, REAL)).toMatchObject({ ok: true });
  }, 600_000);
});

describe('a real open-cards proof, checked by the opponent', () => {
  it('is accepted against the prover\'s hand commitment, and refused for other cards', async () => {
    const open = await generateOpenCardsProof(P2_HAND, B2, commits.commit2);
    expect(open.cards).toEqual(P2_HAND.slice(0, 3));
    const payload = parseOpenCardsPayload({ cards: open.cards, proof: open.proof, publicInputs: open.publicInputs });

    const receiver: LocalGameFacts = { role: 1, ownHand: P1_HAND, opponentOpen: null, moves: [] };
    expect(await checkOpenCards(receiver, commits.commit2, payload, REAL)).toEqual({ ok: true, value: P2_HAND.slice(0, 3) });

    // The same proof claimed for other open cards does not verify.
    const otherCards = [P2_HAND[0], P2_HAND[1], P2_HAND[3]];
    const claimed = [payload.publicInputs[0], ...otherCards.map(c => normalizeField(c))];
    expect(await verifyOpenCardsProof(payload.proof, claimed)).toBe(false);
    expect(await checkOpenCards(receiver, commits.commit2, { cards: otherCards, proof: payload.proof, publicInputs: claimed }, REAL))
      .toEqual({ ok: false, reason: 'its proof does not verify', retryable: false });
    // Nor does it pass as player 1's.
    expect(await checkOpenCards({ ...receiver, role: 2, ownHand: P2_HAND }, commits.commit1, payload, REAL))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/card_commit_hash does not match/) });
  }, 600_000);
});
