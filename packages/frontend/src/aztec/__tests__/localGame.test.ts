/**
 * The client-side game (docs/plan/PRIVATE_GAMES.md section 6.2): each player
 * rebuilds the board from their own hand, the opponent's proven open cards
 * and the moves — with face-down placeholders where they know nothing — and
 * must get exactly the board, scores and result the full-knowledge rules
 * engine gets, because both players' state hashes have to agree.
 */
import { describe, it, expect } from 'vitest';
import { createGame, placeCard } from '@axolotl-arena/game-logic';
import {
  cardOf,
  encodeBoardState,
  encodeOriginalOwners,
  expectedMoveInputs,
  HIDDEN_CARD_ID,
  moveStateHashes,
  openCardsProblem,
  opponentMoveProblem,
  parseMovePayload,
  parseOpenCardsPayload,
  planOwnMove,
  publicInputsMismatch,
  MOVE_INPUT_NAMES,
  replay,
  unplayedSlots,
  type GameMove,
  type LocalGameFacts,
} from '../localGame';
import { moverOf, normalizeField } from '../privateGame';
import { P1_HAND, P2_HAND } from './privateGameFixtures';
import type { GameState } from '../../types';

/** A full game: every cell once, P1 plays its slots in order, P2 a chosen order (slot 4 left over). */
const CELLS: [number, number][] = [[0, 0], [1, 1], [0, 1], [2, 2], [0, 2], [1, 0], [2, 0], [1, 2], [2, 1]];
function fullGame(p2Order = [3, 0, 4, 1]): GameMove[] {
  return CELLS.map(([row, col], i) => {
    const p1 = i % 2 === 0;
    const slot = p1 ? i / 2 : p2Order[(i - 1) / 2];
    return { moveNumber: i, cardId: p1 ? P1_HAND[slot] : P2_HAND[slot], slot, row, col };
  });
}

/** The same moves through the rules engine with BOTH hands known — the referee the relay used to be. */
function refereeState(moves: GameMove[]): GameState {
  let state: GameState = createGame(P1_HAND.map(cardOf), P2_HAND.map(cardOf));
  const played = [new Set<number>(), new Set<number>()];
  for (const m of moves) {
    const side = moverOf(m.moveNumber);
    const handIndex = [...Array(m.slot).keys()].filter(s => !played[side - 1].has(s)).length;
    state = placeCard(state, side === 1 ? 'player1' : 'player2', handIndex, m.row, m.col).newState;
    played[side - 1].add(m.slot);
  }
  return state;
}

const facts = (over: Partial<LocalGameFacts> = {}): LocalGameFacts =>
  ({ role: 1, ownHand: P1_HAND, opponentOpen: null, moves: [], ...over });

const ids = (cards: { id: number }[]) => cards.map(c => c.id);
const H = HIDDEN_CARD_ID;

describe('replaying the game from what one player knows', () => {
  it('starts with our hand and five face-down cards opposite, 5-5, player 1 to move', () => {
    const { state } = replay(facts());
    expect(ids(state.player1Hand)).toEqual(P1_HAND);
    expect(ids(state.player2Hand)).toEqual([H, H, H, H, H]);
    expect([state.player1Score, state.player2Score]).toEqual([5, 5]);
    expect(state.currentTurn).toBe('player1');
    expect(state.status).toBe('playing');
  });

  it('shows the three proven open cards, and keeps the two hidden slots face down', () => {
    const { state } = replay(facts({ opponentOpen: P2_HAND.slice(0, 3) }));
    expect(ids(state.player2Hand)).toEqual([P2_HAND[0], P2_HAND[1], P2_HAND[2], H, H]);
  });

  it('a move from a hidden slot reveals that card on the board; the count left in hand still scores', () => {
    const moves = fullGame().slice(0, 2); // P1 slot 0, then P2 from hidden slot 3
    const { state } = replay(facts({ moves, opponentOpen: P2_HAND.slice(0, 3) }));
    expect(state.board[1][1].card?.id).toBe(P2_HAND[3]);
    expect(ids(state.player2Hand)).toEqual([P2_HAND[0], P2_HAND[1], P2_HAND[2], H]);
    const ref = refereeState(moves);
    expect([state.player1Score, state.player2Score]).toEqual([ref.player1Score, ref.player2Score]);
  });

  it.each([1, 2] as const)('agrees with the full-knowledge referee on every move of a full game (as player %i, open cards unknown)', (role) => {
    const moves = fullGame();
    for (let n = 1; n <= moves.length; n++) {
      const ours = replay({ role, ownHand: role === 1 ? P1_HAND : P2_HAND, opponentOpen: null, moves: moves.slice(0, n) }).state;
      const ref = refereeState(moves.slice(0, n));
      expect(encodeBoardState(ours.board), `board after ${n}`).toEqual(encodeBoardState(ref.board));
      expect(encodeOriginalOwners(ours.board)).toEqual(encodeOriginalOwners(ref.board));
      expect([ours.player1Score, ours.player2Score, ours.currentTurn, ours.status, ours.winner], `after ${n}`)
        .toEqual([ref.player1Score, ref.player2Score, ref.currentTurn, ref.status, ref.winner]);
    }
  });

  it('player 2 ends a full game holding the one card it never played (face down to player 1 if hidden)', () => {
    const { state } = replay(facts({ moves: fullGame([3, 0, 1, 2]), opponentOpen: P2_HAND.slice(0, 3) }));
    expect(state.status).toBe('finished');
    expect(ids(state.player2Hand)).toEqual([H]); // slot 4: hidden, never played
    const asP2 = replay({ role: 2, ownHand: P2_HAND, opponentOpen: P1_HAND.slice(0, 3), moves: fullGame([3, 0, 1, 2]) }).state;
    expect(ids(asP2.player2Hand)).toEqual([P2_HAND[4]]);
  });

  it('refuses a transcript that does not fit: out of order, a slot twice, an occupied cell', () => {
    const [m0, m1] = fullGame();
    expect(() => replay(facts({ moves: [m1] }))).toThrow(/numbered 1/);
    expect(() => replay(facts({ moves: [m0, { ...m1 }, { ...m0, moveNumber: 2, row: 2, col: 2 }] }))).toThrow(/already played/);
    expect(() => replay(facts({ moves: [m0, { ...m1, row: 0, col: 0 }] }))).toThrow(/occupied/);
  });
});

describe('our move', () => {
  it('maps the hand as shown to committed slots, whatever was played before', () => {
    // P1 played slot 0; P2 played; P1 now sees [s1, s2, s3, s4] — index 2 is slot 3.
    const f = facts({ moves: fullGame().slice(0, 2) });
    const r = replay(f);
    expect(unplayedSlots(r, 1)).toEqual([1, 2, 3, 4]);
    expect(planOwnMove(f, r, 2, 0, 1)).toEqual({ moveNumber: 2, cardId: P1_HAND[3], slot: 3, row: 0, col: 1 });
  });

  it('is refused off-turn, on an occupied cell, for a card not in hand, and after the end', () => {
    const one = facts({ moves: fullGame().slice(0, 1) });
    expect(() => planOwnMove(one, replay(one), 0, 2, 2)).toThrow(/not your turn/);
    const two = facts({ moves: fullGame().slice(0, 2) });
    expect(() => planOwnMove(two, replay(two), 0, 1, 1)).toThrow(/occupied/);
    expect(() => planOwnMove(two, replay(two), 4, 2, 2)).toThrow(/no card at hand index 4/);
    const done = facts({ moves: fullGame() });
    expect(() => planOwnMove(done, replay(done), 0, 0, 0)).toThrow(/over/);
  });
});

describe('bounds-checking the opponent\'s move', () => {
  const asP1 = (over: Partial<LocalGameFacts> = {}) => facts({ moves: fullGame().slice(0, 1), ...over });
  const theirs = (over: Partial<GameMove> = {}): GameMove => ({ moveNumber: 1, cardId: P2_HAND[3], slot: 3, row: 1, col: 1, ...over });
  const problem = (f: LocalGameFacts, m: GameMove) => opponentMoveProblem(f, replay(f), m);

  it('accepts a hidden slot, and an open slot before the open cards are proven', () => {
    expect(problem(asP1(), theirs())).toBeNull();
    expect(problem(asP1(), theirs({ cardId: P2_HAND[0], slot: 0 }))).toBeNull();
    expect(problem(asP1({ opponentOpen: P2_HAND.slice(0, 3) }), theirs({ cardId: P2_HAND[1], slot: 1 }))).toBeNull();
  });

  it.each([
    ['not the next number', theirs({ moveNumber: 2 }), /expected move 1, got move 2/],
    ['a slot that is not a slot', theirs({ slot: 5 }), /not a hand slot/],
    ['a card that does not exist', theirs({ cardId: 300 }), /does not exist/],
    ['an occupied cell', theirs({ row: 0, col: 0 }), /occupied/],
    ['a cell off the board', theirs({ row: 3 }), /not a cell/],
  ])('refuses %s', (_label, move, reason) => {
    expect(problem(asP1(), move)).toMatch(reason);
  });

  it('refuses a move that is ours to make', () => {
    expect(problem(facts(), { moveNumber: 0, cardId: P2_HAND[0], slot: 0, row: 0, col: 0 })).toMatch(/ours to make/);
  });

  it('refuses a slot already played', () => {
    const f = facts({ moves: fullGame().slice(0, 3) }); // P2 played slot 3 at move 1
    expect(problem(f, { moveNumber: 3, cardId: P2_HAND[3], slot: 3, row: 2, col: 2 })).toMatch(/already played their slot 3/);
  });

  it('refuses a card other than the open card proven for that slot', () => {
    expect(problem(asP1({ opponentOpen: P2_HAND.slice(0, 3) }), theirs({ cardId: P2_HAND[2], slot: 1 })))
      .toMatch(/slot 1 holds open card/);
  });

  it('refuses a card the opponent has already shown at another slot', () => {
    // An open card claimed to come out of a hidden slot...
    expect(problem(asP1({ opponentOpen: P2_HAND.slice(0, 3) }), theirs({ cardId: P2_HAND[0], slot: 4 })))
      .toMatch(/is the opponent's slot 0, not slot 4/);
    // ...or a card already played from another slot.
    const f = facts({ moves: fullGame().slice(0, 3) });
    expect(problem(f, { moveNumber: 3, cardId: P2_HAND[3], slot: 4, row: 2, col: 2 })).toMatch(/slot 3, not slot 4/);
  });

  it('refuses anything after the ninth move', () => {
    const done = facts({ moves: fullGame() });
    expect(problem(done, { moveNumber: 9, cardId: P2_HAND[2], slot: 2, row: 0, col: 0 })).toMatch(/over/);
  });
});

describe('checking the open cards against what was played', () => {
  const asP1 = (moves: GameMove[], open: number[] | null = null) => facts({ moves, opponentOpen: open });
  const problem = (f: LocalGameFacts, cards: number[]) => openCardsProblem(f, replay(f), cards);

  it('accepts the committed first three, before or after moves from hidden slots', () => {
    expect(problem(asP1([]), P2_HAND.slice(0, 3))).toBeNull();
    expect(problem(asP1(fullGame().slice(0, 2)), P2_HAND.slice(0, 3))).toBeNull();
    // ...and an identical repeat once known
    expect(problem(asP1([], P2_HAND.slice(0, 3)), P2_HAND.slice(0, 3))).toBeNull();
  });

  it.each([
    ['two cards', [21, 22], /are 3, got 2/],
    ['a repeated card', [21, 21, 22], /repeat/],
  ])('refuses %s', (_l, cards, reason) => {
    expect(problem(asP1([]), cards)).toMatch(reason);
  });

  it('refuses a second, different set', () => {
    expect(problem(asP1([], P2_HAND.slice(0, 3)), [P2_HAND[0], P2_HAND[1], P2_HAND[3]])).toMatch(/second, different/);
  });

  it('refuses open cards that contradict a card already played from an open slot', () => {
    const moves = fullGame([0, 3, 4, 1]).slice(0, 2); // P2 played slot 0
    expect(problem(asP1(moves), [P2_HAND[1], P2_HAND[1] + 100, P2_HAND[2]])).toMatch(/from open slot 0/);
  });

  it('refuses open cards that include a card played from a hidden slot', () => {
    const moves = fullGame().slice(0, 2); // P2 played hidden slot 3
    expect(problem(asP1(moves), [P2_HAND[0], P2_HAND[3], P2_HAND[2]])).toMatch(/hidden slot 3, is also an open card/);
  });
});

describe('what a move\'s proof must say', () => {
  const hasher = async (board: string[], scores: [number, number], turn: number, owners: number[]) =>
    normalizeField(BigInt(board.filter(v => v !== '0').length * 1000 + scores[0] * 100 + scores[1] * 10 + turn + owners.reduce((a, b) => a + b, 0) * 7));

  it('hashes the state before (mover to play) and after (the other to play)', async () => {
    const calls: number[] = [];
    const before = replay(facts()).state;
    const after = replay(facts({ moves: fullGame().slice(0, 1) })).state;
    await moveStateHashes(before, after, 1, async (b, s, turn, o) => { calls.push(turn); return hasher(b, s, turn, o); });
    expect(calls).toEqual([1, 2]);
  });

  it('commits, hashes, game_ended / winner_id from the board, then the card and slot', async () => {
    const moves = fullGame();
    const before = replay(facts({ moves: moves.slice(0, 8) })).state;
    const after = replay(facts({ moves })).state;
    const hashes = await moveStateHashes(before, after, 1, hasher);
    const inputs = expectedMoveInputs({ commit1: '0xc1', commit2: '0xc2', hashes, after, move: moves[8] });
    const ref = refereeState(moves);
    expect(inputs.map(v => BigInt(v))).toEqual([
      0xc1n, 0xc2n, BigInt(hashes.start), BigInt(hashes.end), 1n,
      BigInt(ref.winner === 'player1' ? 1 : ref.winner === 'player2' ? 2 : 3), BigInt(moves[8].cardId), BigInt(moves[8].slot),
    ]);
  });

  it('names the first public input that disagrees', () => {
    const expected = ['0x1', '0x2', '0x3', '0x4', '0x0', '0x0', '0x5', '0x1'].map(normalizeField);
    expect(publicInputsMismatch(expected, [...expected], MOVE_INPUT_NAMES)).toBeNull();
    // Formatting does not matter, values do.
    expect(publicInputsMismatch(expected, ['1', '2', '3', '4', '0', '0', '5', '1'], MOVE_INPUT_NAMES)).toBeNull();
    MOVE_INPUT_NAMES.forEach((name, i) => {
      const actual = [...expected];
      actual[i] = normalizeField(BigInt(actual[i]) + 1n);
      expect(publicInputsMismatch(expected, actual, MOVE_INPUT_NAMES)).toBe(`${name} does not match`);
    });
    expect(publicInputsMismatch(expected, expected.slice(0, 7), MOVE_INPUT_NAMES)).toMatch(/8 public inputs expected, got 7/);
    expect(publicInputsMismatch(expected, ['zz', ...expected.slice(1)], MOVE_INPUT_NAMES)).toMatch(/card_commit_1 is not a field/);
  });
});

describe('sealed payloads, as opened', () => {
  const inputs8 = Array.from({ length: 8 }, (_, i) => `0x${(i + 1).toString(16)}`);
  const good = { cardId: 21, slot: 3, row: 1, col: 2, proof: btoa('proof'), publicInputs: inputs8 };

  it('a MOVE body is normalised and checked for shape', () => {
    const p = parseMovePayload(good);
    expect(p.publicInputs[0]).toBe(normalizeField(1));
    expect(p).toMatchObject({ cardId: 21, slot: 3, row: 1, col: 2 });
  });

  it.each([
    ['no object', null],
    ['card 0', { ...good, cardId: 0 }],
    ['card 257', { ...good, cardId: 257 }],
    ['a fractional slot', { ...good, slot: 1.5 }],
    ['slot 5', { ...good, slot: 5 }],
    ['row 3', { ...good, row: 3 }],
    ['col -1', { ...good, col: -1 }],
    ['a string card', { ...good, cardId: '21' }],
    ['a proof that is not base64', { ...good, proof: 'not base64!' }],
    ['an empty proof', { ...good, proof: '' }],
    ['seven public inputs', { ...good, publicInputs: inputs8.slice(0, 7) }],
    ['a public input that is not a field', { ...good, publicInputs: ['0xzz', ...inputs8.slice(1)] }],
  ])('refuses %s', (_l, raw) => {
    expect(() => parseMovePayload(raw)).toThrow();
  });

  it('OPEN_CARDS carries three real cards and four public inputs', () => {
    const ok = { cards: [21, 22, 23], proof: btoa('p'), publicInputs: ['0x9', '0x15', '0x16', '0x17'] };
    expect(parseOpenCardsPayload(ok).publicInputs[1]).toBe(normalizeField(21));
    expect(() => parseOpenCardsPayload({ ...ok, cards: [21, 22] })).toThrow(/3 cards/);
    expect(() => parseOpenCardsPayload({ ...ok, cards: [21, 22, 0] })).toThrow(/open card 2/);
    expect(() => parseOpenCardsPayload({ ...ok, publicInputs: ok.publicInputs.slice(0, 3) })).toThrow(/4 public inputs/);
  });
});
