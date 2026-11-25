/**
 * Checking the opponent's MOVE and OPEN_CARDS (docs/plan/PRIVATE_GAMES.md
 * section 6.3), with a stand-in hasher and verifiers: every way a payload can
 * be refused, and the one way it is accepted. The real hasher and verifier
 * are exercised against real proofs in peerProofs.integration.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { checkOpenCards, checkOpponentMove, type ProofChecks } from '../moveChecks';
import {
  expectedMoveInputs,
  expectedOpenCardsInputs,
  moveStateHashes,
  replay,
  type GameMove,
  type LocalGameFacts,
  type MovePayload,
  type StateHasher,
} from '../localGame';
import { moverOf, normalizeField } from '../privateGame';
import { P1_HAND, P2_HAND } from './privateGameFixtures';

const COMMITS = { commit1: normalizeField(0xc1), commit2: normalizeField(0xc2) };

/** A deterministic stand-in for pedersen over the 30-field state. */
const fakeHash: StateHasher = async (board, scores, turn, owners) => {
  let h = 0xcbf29ce484222325n;
  for (const v of [...board, ...scores.map(String), String(turn), ...owners.map(String)]) {
    for (const ch of v + '|') h = ((h ^ BigInt(ch.charCodeAt(0))) * 0x100000001b3n) & ((1n << 64n) - 1n);
  }
  return normalizeField(h);
};

function checks(over: Partial<ProofChecks> = {}): ProofChecks {
  return {
    hashState: vi.fn(fakeHash),
    verifyMove: vi.fn(async () => true),
    verifyOpenCards: vi.fn(async () => true),
    ...over,
  };
}

const CELLS: [number, number][] = [[0, 0], [1, 1], [0, 1], [2, 2], [0, 2], [1, 0], [2, 0], [1, 2], [2, 1]];
function moveAt(i: number, p2Order = [3, 0, 4, 1]): GameMove {
  const p1 = i % 2 === 0;
  const slot = p1 ? i / 2 : p2Order[(i - 1) / 2];
  return { moveNumber: i, cardId: p1 ? P1_HAND[slot] : P2_HAND[slot], slot, row: CELLS[i][0], col: CELLS[i][1] };
}
const movesTo = (n: number) => Array.from({ length: n }, (_, i) => moveAt(i));

/** The payload an honest opponent sends for `move`, given the facts before it. */
async function honestPayload(facts: LocalGameFacts, move: GameMove): Promise<MovePayload> {
  const before = replay(facts).state;
  const after = replay({ ...facts, moves: [...facts.moves, move] }).state;
  const hashes = await moveStateHashes(before, after, moverOf(move.moveNumber), fakeHash);
  return {
    cardId: move.cardId, slot: move.slot, row: move.row, col: move.col,
    proof: btoa(`proof-${move.moveNumber}`),
    publicInputs: expectedMoveInputs({ ...COMMITS, hashes, after, move }),
  };
}

// Player 1 checking player 2's moves.
const asP1 = (moves: GameMove[], opponentOpen: number[] | null = null): LocalGameFacts =>
  ({ role: 1, ownHand: P1_HAND, opponentOpen, moves });

describe('the opponent\'s move', () => {
  it('is accepted when it fits, its inputs are this board\'s, and its proof verifies', async () => {
    const facts = asP1(movesTo(1));
    const payload = await honestPayload(facts, moveAt(1));
    const c = checks();
    const result = await checkOpponentMove(facts, COMMITS, 1, payload, c);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ moveNumber: 1, cardId: P2_HAND[3], slot: 3, row: 1, col: 1 });
    // The transcript link is rebuilt from the public inputs, not the sender's fields.
    expect(result.value.proof).toMatchObject({
      proof: payload.proof, publicInputs: payload.publicInputs,
      cardCommit1: COMMITS.commit1, placedCardId: P2_HAND[3], placedSlot: 3, gameEnded: false, winnerId: 0,
    });
    expect(c.verifyMove).toHaveBeenCalledWith(payload.proof, payload.publicInputs);
  });

  it('the game-ending move must carry game_ended and the winner this board gives', async () => {
    // Player 2 checks player 1's ninth move.
    const facts: LocalGameFacts = { role: 2, ownHand: P2_HAND, opponentOpen: null, moves: movesTo(8) };
    const payload = await honestPayload(facts, moveAt(8));
    const ok = await checkOpponentMove(facts, COMMITS, 8, payload, checks());
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.proof.gameEnded).toBe(true);

    const notEnded = { ...payload, publicInputs: [...payload.publicInputs] };
    notEnded.publicInputs[4] = normalizeField(0);
    expect(await checkOpponentMove(facts, COMMITS, 8, notEnded, checks())).toMatchObject({ ok: false, reason: expect.stringMatching(/game_ended does not match/) });

    const otherWinner = { ...payload, publicInputs: [...payload.publicInputs] };
    otherWinner.publicInputs[5] = normalizeField(BigInt(payload.publicInputs[5]) === 1n ? 2 : 1);
    expect(await checkOpponentMove(facts, COMMITS, 8, otherWinner, checks())).toMatchObject({ ok: false, reason: expect.stringMatching(/winner_id does not match/) });
  });

  it.each([
    ['card_commit_1', 0], ['card_commit_2', 1], ['start_state_hash', 2], ['end_state_hash', 3],
    ['game_ended', 4], ['winner_id', 5], ['placed_card_id', 6], ['placed_slot', 7],
  ])('is refused when %s is not what this board implies — and the proof is never checked', async (name, i) => {
    const facts = asP1(movesTo(1));
    const payload = await honestPayload(facts, moveAt(1));
    payload.publicInputs[i] = normalizeField(BigInt(payload.publicInputs[i]) + 1n);
    const c = checks();
    const result = await checkOpponentMove(facts, COMMITS, 1, payload, c);
    expect(result).toEqual({ ok: false, reason: `its proof's ${name} does not match`, retryable: false });
    expect(c.verifyMove).not.toHaveBeenCalled();
  });

  it('is refused when its commitments are the right ones in the wrong order', async () => {
    const facts = asP1(movesTo(1));
    const payload = await honestPayload(facts, moveAt(1));
    [payload.publicInputs[0], payload.publicInputs[1]] = [payload.publicInputs[1], payload.publicInputs[0]];
    expect(await checkOpponentMove(facts, COMMITS, 1, payload, checks())).toMatchObject({ ok: false, reason: expect.stringMatching(/card_commit_1/) });
  });

  it('is refused when it replays a position from earlier in the game (start hash of a past state)', async () => {
    const facts = asP1(movesTo(3));
    const stale = await honestPayload(asP1(movesTo(1)), moveAt(1)); // move 1's proof, sent again as move 3
    const result = await checkOpponentMove(facts, COMMITS, 3, { ...stale, cardId: P2_HAND[0], slot: 0, row: 2, col: 2 }, checks());
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/start_state_hash does not match/) });
  });

  it('is refused by the bounds check before anything is hashed or verified', async () => {
    const facts = asP1(movesTo(1), P2_HAND.slice(0, 3));
    const payload = await honestPayload(facts, moveAt(1));
    const c = checks();
    const result = await checkOpponentMove(facts, COMMITS, 1, { ...payload, cardId: P2_HAND[2], slot: 1 }, c);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/slot 1 holds open card/), retryable: false });
    expect(c.hashState).not.toHaveBeenCalled();
    expect(c.verifyMove).not.toHaveBeenCalled();
  });

  it('is refused when its proof does not verify', async () => {
    const facts = asP1(movesTo(1));
    const payload = await honestPayload(facts, moveAt(1));
    const result = await checkOpponentMove(facts, COMMITS, 1, payload, checks({ verifyMove: vi.fn(async () => false) }));
    expect(result).toEqual({ ok: false, reason: 'its proof does not verify', retryable: false });
  });

  it('a verifier that throws says nothing about the move: retryable, not a rejection', async () => {
    const facts = asP1(movesTo(1));
    const payload = await honestPayload(facts, moveAt(1));
    const thrown = await checkOpponentMove(facts, COMMITS, 1, payload, checks({ verifyMove: vi.fn(async () => { throw new Error('wasm out of memory'); }) }));
    expect(thrown).toMatchObject({ ok: false, retryable: true, reason: expect.stringMatching(/wasm out of memory/) });
    const hashFails = await checkOpponentMove(facts, COMMITS, 1, payload, checks({ hashState: vi.fn(async () => { throw new Error('bb down'); }) }));
    expect(hashFails).toMatchObject({ ok: false, retryable: true });
  });
});

describe('the opponent\'s open cards', () => {
  const THEIR_COMMIT = COMMITS.commit2;
  const payloadFor = (cards: number[]) => ({ cards, proof: btoa('open'), publicInputs: expectedOpenCardsInputs(THEIR_COMMIT, cards) });

  it('are accepted against their record\'s hand commitment, with a verifying proof', async () => {
    const c = checks();
    const result = await checkOpenCards(asP1([]), THEIR_COMMIT, payloadFor(P2_HAND.slice(0, 3)), c);
    expect(result).toEqual({ ok: true, value: P2_HAND.slice(0, 3) });
    expect(c.verifyOpenCards).toHaveBeenCalledWith(btoa('open'), expectedOpenCardsInputs(THEIR_COMMIT, P2_HAND.slice(0, 3)));
  });

  it('are refused for another commitment (our own, say)', async () => {
    const result = await checkOpenCards(asP1([]), THEIR_COMMIT, { ...payloadFor(P2_HAND.slice(0, 3)), publicInputs: expectedOpenCardsInputs(COMMITS.commit1, P2_HAND.slice(0, 3)) }, checks());
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/card_commit_hash does not match/) });
  });

  it('are refused when the proof shows other cards than the ones named', async () => {
    const named = payloadFor(P2_HAND.slice(0, 3));
    const result = await checkOpenCards(asP1([]), THEIR_COMMIT, { ...named, cards: [P2_HAND[0], P2_HAND[1], P2_HAND[3]] }, checks());
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/open_2 does not match/) });
  });

  it('are refused when they contradict a card already played', async () => {
    const moves = movesTo(2); // player 2 played hidden slot 3
    const result = await checkOpenCards(asP1(moves), THEIR_COMMIT, payloadFor([P2_HAND[0], P2_HAND[3], P2_HAND[2]]), checks());
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/hidden slot 3/) });
  });

  it('are refused when the proof does not verify, and retried when the verifier throws', async () => {
    expect(await checkOpenCards(asP1([]), THEIR_COMMIT, payloadFor(P2_HAND.slice(0, 3)), checks({ verifyOpenCards: vi.fn(async () => false) })))
      .toEqual({ ok: false, reason: 'its proof does not verify', retryable: false });
    expect(await checkOpenCards(asP1([]), THEIR_COMMIT, payloadFor(P2_HAND.slice(0, 3)), checks({ verifyOpenCards: vi.fn(async () => { throw new Error('x'); }) })))
      .toMatchObject({ ok: false, retryable: true });
  });
});
