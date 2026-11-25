/**
 * The private-games protocol's pure core (docs/plan/PRIVATE_GAMES.md): what a
 * player's own data says about a game — its state from nullifier lookups,
 * where the abandonment protocol stands, the prize, and which of the player's
 * own prepared notes to import after each kind of resolution.
 */
import { describe, it, expect } from 'vitest';
import {
  abandonmentPosition,
  defaultPrizeMove,
  FIELD_MODULUS,
  GAME_NULLIFIER_COUNT,
  hasContested,
  loserMoveIndices,
  normalizeField,
  NULLIFIER_INDEX,
  orderTranscript,
  parseGameChainState,
  parseGameSecrets,
  parseRecord,
  placedOf,
  prizeMoveForCard,
  prizeOfMove,
  resolutionFromReleased,
  selectOwnNotes,
  winnerOf,
  ZERO_FIELD,
  ZERO_RECORD,
} from '../privateGame';
import { chainState, P1_HAND, P2_HAND, record, secrets, transcript } from './privateGameFixtures';

describe('field elements', () => {
  it('normalises decimal (simulate results), hex and bigint to one padded form', () => {
    const want = '0x' + '0'.repeat(62) + 'ff';
    expect(normalizeField('255')).toBe(want);
    expect(normalizeField('0xFF')).toBe(want);
    expect(normalizeField(255n)).toBe(want);
    expect(normalizeField(255)).toBe(want);
    expect(normalizeField({ toString: () => '0xff' })).toBe(want);
  });

  it('refuses anything that is not a field element — payloads come from the opponent', () => {
    expect(() => normalizeField('hello')).toThrow();
    expect(() => normalizeField('')).toThrow();
    expect(() => normalizeField(undefined)).toThrow();
    expect(() => normalizeField(FIELD_MODULUS)).toThrow(/out of range/);
    expect(() => normalizeField(-1n)).toThrow();
    expect(() => normalizeField(1.5)).toThrow();
  });
});

describe('records and secrets', () => {
  it('parses a nine-field record into canonical form', () => {
    const r = parseRecord(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(r).toHaveLength(9);
    expect(r[0]).toBe(normalizeField(1n));
    expect(r[8]).toBe(normalizeField(9n));
  });

  it('refuses a record of the wrong length or without a seat / hand commitment', () => {
    expect(() => parseRecord(['1', '2'])).toThrow(/9 fields/);
    expect(() => parseRecord('nope')).toThrow();
    expect(() => parseRecord(['0', '2', '3', '4', '5', '6', '7', '8', '9'])).toThrow(/seat/);
    expect(() => parseRecord(['1', '0', '3', '4', '5', '6', '7', '8', '9'])).toThrow(/hand commitment/);
  });

  it('the zero record is what game_nullifiers takes before a join', () => {
    expect(ZERO_RECORD).toHaveLength(9);
    expect(ZERO_RECORD.every(v => v === ZERO_FIELD)).toBe(true);
  });

  it('reads compute_game_secrets as [blinding, r_0..r_4, prize, reward]', () => {
    const s = parseGameSecrets(['10', '20', '21', '22', '23', '24', '30', '40']);
    expect(s.blinding).toBe(normalizeField(10n));
    expect(s.returns).toEqual([20n, 21n, 22n, 23n, 24n].map(normalizeField));
    expect(s.prize).toBe(normalizeField(30n));
    expect(s.reward).toBe(normalizeField(40n));
    expect(() => parseGameSecrets(['1', '2'])).toThrow(/8 fields/);
  });
});

describe('nullifier state', () => {
  it('indexes game_nullifiers exactly as the contract lays them out', () => {
    // [created, seat2, joined, done, claim_slot(1..3), claim(1,1), claim(1,2),
    //  claim(2,1), claim(2,2), claim(3,1), claim(3,2), contested_by(1),
    //  contested_by(2), contest(1..3), resolved(1..3)]
    const order = [
      NULLIFIER_INDEX.created, NULLIFIER_INDEX.seat2, NULLIFIER_INDEX.joined, NULLIFIER_INDEX.done,
      NULLIFIER_INDEX.claimSlot(1), NULLIFIER_INDEX.claimSlot(2), NULLIFIER_INDEX.claimSlot(3),
      NULLIFIER_INDEX.claim(1, 1), NULLIFIER_INDEX.claim(1, 2), NULLIFIER_INDEX.claim(2, 1),
      NULLIFIER_INDEX.claim(2, 2), NULLIFIER_INDEX.claim(3, 1), NULLIFIER_INDEX.claim(3, 2),
      NULLIFIER_INDEX.contestedBy(1), NULLIFIER_INDEX.contestedBy(2),
      NULLIFIER_INDEX.contest(1), NULLIFIER_INDEX.contest(2), NULLIFIER_INDEX.contest(3),
      NULLIFIER_INDEX.resolved(1), NULLIFIER_INDEX.resolved(2), NULLIFIER_INDEX.resolved(3),
    ];
    expect(order).toEqual(Array.from({ length: GAME_NULLIFIER_COUNT }, (_, i) => i));
  });

  it('parses the lookups into who did what, and in which block', () => {
    const hits = Array.from({ length: GAME_NULLIFIER_COUNT }, () => null as { blockNumber: number } | null);
    hits[NULLIFIER_INDEX.created] = { blockNumber: 10 };
    hits[NULLIFIER_INDEX.seat2] = { blockNumber: 12 };
    hits[NULLIFIER_INDEX.joined] = { blockNumber: 12 };
    hits[NULLIFIER_INDEX.claimSlot(1)] = { blockNumber: 30 };
    hits[NULLIFIER_INDEX.claim(1, 2)] = { blockNumber: 30 };
    const s = parseGameChainState(hits);
    expect(s.created?.blockNumber).toBe(10);
    expect(s.joined?.blockNumber).toBe(12);
    expect(s.done).toBeNull();
    expect(s.claims[0]).toEqual([null, { blockNumber: 30 }]);
    expect(() => parseGameChainState(hits.slice(1))).toThrow(/21/);
  });

  it('reports each side\'s one contest', () => {
    const s = chainState({ created: 1, joined: 2, contestedBy: [null, 40] });
    expect(hasContested(s, 1)).toBe(false);
    expect(hasContested(s, 2)).toBe(true);
  });
});

describe('abandonment position', () => {
  it('nothing to claim before anyone joined', () => {
    expect(abandonmentPosition(chainState({ created: 1 }))).toEqual({ kind: 'not-joined' });
  });

  it('a resolved game is done, whatever else is on record', () => {
    expect(abandonmentPosition(chainState({ created: 1, joined: 2, done: 9 }))).toEqual({ kind: 'done' });
  });

  it('the first claim\'s clock is the block the join landed in', () => {
    expect(abandonmentPosition(chainState({ created: 1, joined: 7 })))
      .toEqual({ kind: 'can-claim', claimNo: 1, clockBlock: 7 });
  });

  it('a standing claim names its claimant and its block', () => {
    expect(abandonmentPosition(chainState({ created: 1, joined: 7, claimSlots: [20], claims: [[20, null]] })))
      .toEqual({ kind: 'open-claim', claimNo: 1, claimSide: 1, claimBlock: 20 });
    expect(abandonmentPosition(chainState({ created: 1, joined: 7, claimSlots: [20], claims: [[null, 21]] })))
      .toEqual({ kind: 'open-claim', claimNo: 1, claimSide: 2, claimBlock: 21 });
  });

  it('a contest restarts the clock: the next claim counts from the contest\'s block', () => {
    const s = chainState({
      created: 1, joined: 7, claimSlots: [20], claims: [[20, null]],
      contestedBy: [null, 25], contests: [25], resolved: [25],
    });
    expect(abandonmentPosition(s)).toEqual({ kind: 'can-claim', claimNo: 2, clockBlock: 25 });
  });

  it('claim 3 is the last: once contested there is nothing left to claim', () => {
    const s = chainState({
      created: 1, joined: 7,
      claimSlots: [20, 40, 60], claims: [[20, null], [null, 40], [60, null]],
      contests: [25, 45, 65], resolved: [25, 45, 65], contestedBy: [45, 25],
    });
    expect(abandonmentPosition(s)).toEqual({ kind: 'no-claims-left' });
  });

  it('a claim resolved without a contest was finalized — the game is done', () => {
    const s = chainState({ created: 1, joined: 7, claimSlots: [20], claims: [[20, null]], resolved: [90] });
    expect(abandonmentPosition(s)).toEqual({ kind: 'done' });
  });

  it('refuses an inconsistent read (a slot with no claimant)', () => {
    expect(() => abandonmentPosition(chainState({ created: 1, joined: 7, claimSlots: [20] }))).toThrow(/inconsistent/);
  });
});

describe('transcript, winner and prize', () => {
  it('orders a shuffled transcript by its state chain and reads the winner off move nine', () => {
    const t = transcript({ winner: 2 });
    const shuffled = [t[4], t[8], t[0], t[2], t[6], t[1], t[3], t[7], t[5]];
    const ordered = orderTranscript(shuffled);
    expect(ordered.map(p => p.startStateHash)).toEqual(t.map(p => p.startStateHash));
    expect(winnerOf(ordered)).toBe(2);
    expect(winnerOf(orderTranscript(transcript({ winner: 3 })))).toBe('draw');
  });

  it('refuses to name a winner without all nine moves', () => {
    expect(() => winnerOf(orderTranscript(transcript({ winner: 1 }).slice(0, 8)))).toThrow(/all 9/);
  });

  it('reads the placed card and slot from the public inputs when the fields are absent', () => {
    const p = transcript({ winner: 1 })[3];
    const bare = { ...p, placedCardId: undefined, placedSlot: undefined };
    expect(placedOf(bare)).toEqual({ cardId: P2_HAND[1], slot: 1 });
  });

  it('the loser\'s moves: odd when player 1 won, even when player 2 won', () => {
    expect(loserMoveIndices(1)).toEqual([1, 3, 5, 7]);
    expect(loserMoveIndices(2)).toEqual([0, 2, 4, 6, 8]);
  });

  it('maps the card the winner picked to the move that placed it, for the loser only', () => {
    const t = transcript({ winner: 1, p2Order: [2, 0, 3, 1] });
    expect(prizeMoveForCard(t, 1, P2_HAND[3])).toBe(5);
    expect(prizeOfMove(t, 1, 5)).toEqual({ cardId: P2_HAND[3], slot: 3 });
  });

  it('refuses a prize the loser never placed: the winner\'s own card, or the unplayed one', () => {
    // Both hands hold card 7 — only the loser's placement of it counts.
    const t = transcript({ winner: 2, p1Hand: [7, 12, 13, 14, 15], p2Hand: [7, 22, 23, 24, 25] });
    expect(prizeMoveForCard(t, 2, 7)).toBe(0);
    expect(() => prizeMoveForCard(transcript({ winner: 1 }), 1, P2_HAND[4])).toThrow(/not placed by the loser/);
    expect(() => prizeMoveForCard(transcript({ winner: 1 }), 1, P1_HAND[0])).toThrow(/not placed by the loser/);
    expect(() => prizeOfMove(transcript({ winner: 1 }), 1, 2)).toThrow(/winner's/);
    expect(() => prizeOfMove(transcript({ winner: 1 }), 1, 9)).toThrow(/out of range/);
  });

  it('defaults to the loser\'s strongest placed card', () => {
    const t = transcript({ winner: 2 });
    const strength = (id: number) => (id === P1_HAND[3] ? 99 : id);
    expect(defaultPrizeMove(t, 2, strength)).toBe(6);
    // Ties go to the earliest move.
    expect(defaultPrizeMove(t, 2, () => 5)).toBe(0);
  });
});

describe('which own notes to import', () => {
  const hand = P2_HAND;
  const s = secrets(2);

  it('win: all five returns, the prize with the prize randomness, and the reward', () => {
    const out = selectOwnNotes({
      role: 2, hand, secrets: s,
      resolution: { kind: 'settled', winner: 2, prize: { cardId: P1_HAND[2], slot: 2 } },
    });
    expect(out.cards.filter(n => n.kind === 'return').map(n => [n.tokenId, n.randomness]))
      .toEqual(hand.map((id, i) => [id, s.returns[i]]));
    expect(out.cards.filter(n => n.kind === 'prize')).toEqual([{ tokenId: P1_HAND[2], randomness: s.prize, kind: 'prize' }]);
    expect(out.reward).toEqual({ amount: 20, randomness: s.reward });
    expect(out.takenCardId).toBeNull();
  });

  it('lose: the four returns that were not the prize slot, and the reward', () => {
    const out = selectOwnNotes({
      role: 2, hand, secrets: s,
      resolution: { kind: 'settled', winner: 1, prize: { cardId: hand[3], slot: 3 } },
    });
    expect(out.cards.map(n => n.tokenId)).toEqual([hand[0], hand[1], hand[2], hand[4]]);
    expect(out.cards.map(n => n.randomness)).toEqual([s.returns[0], s.returns[1], s.returns[2], s.returns[4]]);
    expect(out.cards.every(n => n.kind === 'return')).toBe(true);
    expect(out.reward).toEqual({ amount: 20, randomness: s.reward });
    expect(out.takenCardId).toBe(hand[3]);
  });

  it('lose without knowing the prize slot is refused — guessing would skip the wrong card', () => {
    expect(() => selectOwnNotes({ role: 2, hand, secrets: s, resolution: { kind: 'settled', winner: 1 } }))
      .toThrow(/prize slot/);
  });

  it('draw: all five returns and the reward, no prize', () => {
    const out = selectOwnNotes({ role: 1, hand: P1_HAND, secrets: s, resolution: { kind: 'settled', winner: 'draw' } });
    expect(out.cards.map(n => n.tokenId)).toEqual(P1_HAND);
    expect(out.cards.some(n => n.kind === 'prize')).toBe(false);
    expect(out.reward).not.toBeNull();
  });

  it('cancel: the creator\'s five returns, no reward; nothing for a joiner', () => {
    const creator = selectOwnNotes({ role: 1, hand: P1_HAND, secrets: s, resolution: { kind: 'cancelled' } });
    expect(creator.cards.map(n => n.tokenId)).toEqual(P1_HAND);
    expect(creator.reward).toBeNull();
    expect(selectOwnNotes({ role: 2, hand, secrets: s, resolution: { kind: 'cancelled' } }).cards).toEqual([]);
  });

  it('unwind (finalized abandonment): all five returns, no reward', () => {
    const out = selectOwnNotes({ role: 2, hand, secrets: s, resolution: { kind: 'unwound' } });
    expect(out.cards.map(n => n.tokenId)).toEqual(hand);
    expect(out.reward).toBeNull();
    expect(out.takenCardId).toBeNull();
  });

  it('a won prize nobody named is left out, not guessed', () => {
    const out = selectOwnNotes({ role: 1, hand: P1_HAND, secrets: s, resolution: { kind: 'settled', winner: 1 } });
    expect(out.cards.some(n => n.kind === 'prize')).toBe(false);
    expect(out.cards).toHaveLength(5);
  });
});

describe('reading a resolution off the released notes', () => {
  const all = [true, true, true, true, true];

  it('four of five returns plus the reward: we lost, and the missing slot is the prize', () => {
    const r = resolutionFromReleased({ role: 2, hand: P2_HAND, returns: [true, true, false, true, true], reward: true, winner: null, joined: true });
    expect(r).toEqual({ kind: 'settled', winner: 1, prize: { cardId: P2_HAND[2], slot: 2 } });
  });

  it('five returns plus the reward: a draw, or our win when the transcript says so', () => {
    expect(resolutionFromReleased({ role: 1, hand: P1_HAND, returns: all, reward: true, winner: 'draw', joined: true }))
      .toEqual({ kind: 'settled', winner: 'draw' });
    expect(resolutionFromReleased({ role: 1, hand: P1_HAND, returns: all, reward: true, winner: 1, joined: true }))
      .toEqual({ kind: 'settled', winner: 1 });
  });

  it('five returns and no reward: an unwind — or a cancel when nobody joined', () => {
    expect(resolutionFromReleased({ role: 2, hand: P2_HAND, returns: all, reward: false, winner: null, joined: true }))
      .toEqual({ kind: 'unwound' });
    expect(resolutionFromReleased({ role: 1, hand: P1_HAND, returns: all, reward: false, winner: null, joined: false }))
      .toEqual({ kind: 'cancelled' });
  });

  it('four returns and no reward: we walked away, and a claim took the fifth', () => {
    expect(resolutionFromReleased({ role: 1, hand: P1_HAND, returns: [true, true, true, true, false], reward: false, winner: null, joined: true }))
      .toEqual({ kind: 'forfeited', claimSide: 2, card: { cardId: P1_HAND[4], slot: 4 } });
    expect(resolutionFromReleased({ role: 2, hand: P2_HAND, returns: [false, true, true, true, true], reward: false, winner: null, joined: true }))
      .toEqual({ kind: 'forfeited', claimSide: 1, card: { cardId: P2_HAND[0], slot: 0 } });
  });

  it('refuses what no resolution of this game can look like', () => {
    expect(() => resolutionFromReleased({ role: 1, hand: P1_HAND, returns: [false, false, false, false, false], reward: true, winner: null, joined: true }))
      .toThrow(/not this game's resolution/);
    expect(() => resolutionFromReleased({ role: 1, hand: P1_HAND, returns: [true, true, false, false, true], reward: true, winner: null, joined: true }))
      .toThrow(/at most one/);
    expect(() => resolutionFromReleased({ role: 1, hand: P1_HAND, returns: [true, true, false, true, false], reward: false, winner: null, joined: true }))
      .toThrow(/all but one/);
    // Nobody joined, so nobody could have claimed a card.
    expect(() => resolutionFromReleased({ role: 1, hand: P1_HAND, returns: [true, true, true, true, false], reward: false, winner: null, joined: false }))
      .toThrow(/all but one/);
  });

  it('records are opaque but distinct per player', () => {
    expect(record(1)).not.toEqual(record(2));
  });
});
