/**
 * The bot's own decisions in the private-game protocol: what it takes as a
 * prize, what it accepts from the opponent, and what the recovery sweep does
 * next. Pure, so every branch is pinned here rather than discovered on-chain.
 */
import { describe, it, expect } from 'vitest';
import {
  cardValue,
  checkTranscript,
  decideSweepStep,
  normalizeMoveProof,
  outcomeFor,
  parsePeerPayload,
  blocksToTime,
  MIN_ABANDON_SECONDS,
  DISPUTE_SECONDS,
} from '../src/protocol.js';
import { choosePrizeMove } from '../src/settlement.js';
import { cardStrength } from '../../frontend/src/aztec/gameActions.js';
import type { AbandonmentPosition } from '../../frontend/src/aztec/privateGame.js';
import { F, RECORD1, RECORD2, transcript } from './fakes.js';

describe('the prize the bot takes', () => {
  it('values a rarer card above a stronger common one', () => {
    // 247 is legendary, 230 epic, 180 rare, 1 and 2 common.
    expect(cardValue(247)).toBeGreaterThan(cardValue(230));
    expect(cardValue(230)).toBeGreaterThan(cardValue(180));
    expect(cardValue(180)).toBeGreaterThan(cardValue(1));
    expect(cardValue(999)).toBe(0);
  });

  it('when it wins, takes the human\'s placed card it values most', () => {
    // The human (player 1) placed HUMAN_HAND in order at moves 0,2,4,6,8;
    // the legendary 247 went down at move 4.
    const { ordered } = checkTranscript(transcript({ winnerId: 2 }), RECORD1, RECORD2);
    const move = choosePrizeMove(ordered, 2);
    expect(move).toBe(4);
    expect(move % 2, 'the prize must be a move the LOSER made').toBe(0);
  });

  it('never names one of its own moves as the prize, however valuable', () => {
    const rich = transcript({ winnerId: 2, bot: [247, 246, 245, 244, 243], human: [1, 2, 3, 4, 5] });
    const { ordered } = checkTranscript(rich, RECORD1, RECORD2);
    expect(choosePrizeMove(ordered, 2) % 2).toBe(0);
  });

  it('settling a loss for an absent winner, gives them the default every client computes: its strongest placed card', () => {
    // Placed by the bot at moves 1,3,5,7: two commons, a rare and an epic.
    const bot = [7, 200, 9, 240, 11];
    const { ordered } = checkTranscript(transcript({ winnerId: 1, bot }), RECORD1, RECORD2);
    const move = choosePrizeMove(ordered, 1);
    expect(move % 2, 'a card the bot placed').toBe(1);
    const strongest = [1, 3, 5, 7]
      .map(i => ({ i, v: cardStrength(bot[(i - 1) / 2]) }))
      .reduce((a, b) => (b.v > a.v ? b : a));
    expect(move, 'by edge ranks, not by what the bot would least mind losing').toBe(strongest.i);
  });

  it('names move 0 for a draw, which has no prize', () => {
    const { ordered } = checkTranscript(transcript({ winnerId: 3 }), RECORD1, RECORD2);
    expect(choosePrizeMove(ordered, 'draw')).toBe(0);
  });
});

describe('what the bot accepts from the opponent', () => {
  it('reads the four PEER payload kinds', () => {
    expect(parsePeerPayload({ kind: 'RECORD', record: RECORD1 })).toEqual({ kind: 'RECORD', record: RECORD1 });
    expect(parsePeerPayload({ kind: 'SETTLING', prizeMove: 4 })).toEqual({ kind: 'SETTLING', prizeMove: 4 });
    // A draw names no prize; the browser announces it as null.
    expect(parsePeerPayload({ kind: 'SETTLING', prizeMove: null })).toEqual({ kind: 'SETTLING', prizeMove: null });
    expect(parsePeerPayload({ kind: 'SETTLED', txHash: F(0xab).toUpperCase().replace('0X', '0x') }))
      .toEqual({ kind: 'SETTLED', txHash: F(0xab) });
    expect(parsePeerPayload({ kind: 'CANCELLED' })).toEqual({ kind: 'CANCELLED' });
  });

  it('normalises a record that arrives in decimal', () => {
    const decimal = RECORD1.map(h => BigInt(h).toString(10));
    expect(parsePeerPayload({ kind: 'RECORD', record: decimal })).toEqual({ kind: 'RECORD', record: RECORD1 });
  });

  it('drops anything malformed before it can reach a transaction', () => {
    expect(parsePeerPayload({ kind: 'RECORD', record: RECORD1.slice(0, 8) })).toBeNull();
    expect(parsePeerPayload({ kind: 'RECORD', record: [...RECORD1.slice(0, 8), 'nope'] })).toBeNull();
    expect(parsePeerPayload({ kind: 'SETTLING', prizeMove: 9 })).toBeNull();
    expect(parsePeerPayload({ kind: 'SETTLING', prizeMove: 1.5 })).toBeNull();
    expect(parsePeerPayload({ kind: 'SETTLED', txHash: '0x1234' })).toBeNull();
    expect(parsePeerPayload({ kind: 'NOTE_DATA', notes: [] })).toBeNull();
    expect(parsePeerPayload('RECORD')).toBeNull();
    expect(parsePeerPayload(null)).toBeNull();
  });

  it('reads a relayed proof from its public inputs, not from what the sender claimed', () => {
    const inputs = [RECORD1[1], RECORD2[1], F(10), F(11), F(0), F(0), F(247), F(2)];
    const p = normalizeMoveProof({
      proof: 'cHJvb2Y=', publicInputs: inputs,
      startStateHash: F(999), endStateHash: F(998), placedCardId: 1, gameEnded: true,
    })!;
    expect(p.startStateHash).toBe(F(10));
    expect(p.endStateHash).toBe(F(11));
    expect(p.placedCardId).toBe(247);
    expect(p.placedSlot).toBe(2);
    expect(p.gameEnded).toBe(false);
  });

  it('rejects a proof without the eight public inputs settlement needs', () => {
    expect(normalizeMoveProof({ proof: 'p', publicInputs: new Array(6).fill(F(1)) })).toBeNull();
    expect(normalizeMoveProof({ proof: '', publicInputs: new Array(8).fill(F(1)) })).toBeNull();
    expect(normalizeMoveProof({ publicInputs: new Array(8).fill(F(1)) })).toBeNull();
  });

  it('reads the relay\'s verdict from the bot\'s seat', () => {
    expect(outcomeFor('player2', 'player2')).toBe('win');
    expect(outcomeFor('player1', 'player2')).toBe('loss');
    expect(outcomeFor('draw', 'player2')).toBe('draw');
  });
});

describe('checking a transcript before settling it', () => {
  it('accepts nine chained moves bound to both records, and reads the winner', () => {
    const shuffled = transcript({ winnerId: 2 }).reverse();
    const { ordered, winner } = checkTranscript(shuffled, RECORD1, RECORD2);
    expect(winner).toBe(2);
    expect(ordered.map(p => p.placedCardId)).toEqual([1, 7, 180, 8, 247, 9, 2, 10, 230]);
  });

  it('names what is missing', () => {
    expect(() => checkTranscript(transcript({ winnerId: 2, moves: 8 }), RECORD1, RECORD2))
      .toThrow(/transcript incomplete: 1 move proof/);
  });

  it('refuses moves bound to some other game\'s hands', () => {
    const other = RECORD2.map((v, i) => (i === 1 ? F(0xbad) : v));
    expect(() => checkTranscript(transcript({ winnerId: 2 }), RECORD1, other)).toThrow(/not bound to this game/);
  });

  it('refuses a chain with a missing link', () => {
    const t = transcript({ winnerId: 2 });
    t[4] = normalizeMoveProof({ ...t[4], publicInputs: t[4].publicInputs.map((v, i) => (i === 2 ? F(0x7777) : v)) })!;
    expect(() => checkTranscript(t, RECORD1, RECORD2)).toThrow();
  });
});

describe('the sweep\'s next step', () => {
  // Block n lands at 1000 + 36n seconds, as the fake chain has it.
  const t = (n: number) => 1000 + 36 * n;
  const base = { contestedByUs: false, transcriptComplete: false, blockTime: t };
  const at = (position: AbandonmentPosition, now: number, over: Partial<Parameters<typeof decideSweepStep>[0]> = {}) =>
    decideSweepStep({ ...base, position, now, ...over });

  it('leaves a game whose join never landed, and imports from one that is resolved', () => {
    expect(at({ kind: 'not-joined' }, 0)).toEqual({ kind: 'not-joined' });
    expect(at({ kind: 'done' }, 0)).toEqual({ kind: 'resolved' });
  });

  it('settles a complete transcript instead of claiming — a full game outranks any claim', () => {
    const position: AbandonmentPosition = { kind: 'can-claim', claimNo: 1, clockBlock: 5 };
    expect(at(position, t(5) + 9999, { transcriptComplete: true })).toEqual({ kind: 'settle', contest: null });
  });

  it('contests an opponent\'s standing claim first, so their finalize cannot race the settlement', () => {
    const position: AbandonmentPosition = { kind: 'open-claim', claimNo: 1, claimSide: 1, claimBlock: 30 };
    expect(at(position, t(30) + 60, { transcriptComplete: true })).toEqual({
      kind: 'settle',
      contest: { claimNo: 1, claimSide: 1, beforeClaimBlock: 29 },
    });
  });

  it('does not contest once its one contest is spent, or once the window has closed', () => {
    const position: AbandonmentPosition = { kind: 'open-claim', claimNo: 2, claimSide: 1, claimBlock: 30 };
    expect(at(position, t(30) + 60, { transcriptComplete: true, contestedByUs: true }))
      .toEqual({ kind: 'settle', contest: null });
    expect(at(position, t(29) + DISPUTE_SECONDS, { transcriptComplete: true }))
      .toEqual({ kind: 'settle', contest: null });
  });

  it('claims an incomplete game only once the chain is past the abandon bar', () => {
    const position: AbandonmentPosition = { kind: 'can-claim', claimNo: 1, clockBlock: 5 };
    const early = at(position, t(5) + MIN_ABANDON_SECONDS - 1);
    expect(early.kind).toBe('wait');
    expect((early as { reason: string }).reason).toMatch(/claim 1 opens/);
    expect(at(position, t(5) + MIN_ABANDON_SECONDS + 30)).toEqual({ kind: 'claim', claimNo: 1, clockBlock: 5 });
  });

  it('times a later claim from the contest that restarted the clock', () => {
    const position: AbandonmentPosition = { kind: 'can-claim', claimNo: 2, clockBlock: 31 };
    expect(blocksToTime(position)).toEqual([31]);
    expect(at(position, t(31) + MIN_ABANDON_SECONDS + 30)).toEqual({ kind: 'claim', claimNo: 2, clockBlock: 31 });
  });

  it('finalizes its own claim once the dispute window has passed, and not before', () => {
    const position: AbandonmentPosition = { kind: 'open-claim', claimNo: 1, claimSide: 2, claimBlock: 30 };
    expect(blocksToTime(position)).toEqual([30, 29]);
    const waiting = at(position, t(30) + 60);
    expect(waiting.kind).toBe('wait');
    expect((waiting as { reason: string }).reason).toMatch(/^claimed — dispute window, ~\d+min left/);
    expect(at(position, t(30) + DISPUTE_SECONDS + 30))
      .toEqual({ kind: 'finalize', claimNo: 1, claimSide: 2, claimBlock: 30 });
  });

  it('finalizes the OPPONENT\'s claim too once it has stood — anyone may, and both hands come back', () => {
    const position: AbandonmentPosition = { kind: 'open-claim', claimNo: 1, claimSide: 1, claimBlock: 30 };
    expect((at(position, t(30) + 60) as { reason: string }).reason).toMatch(/opponent claimed/);
    expect(at(position, t(30) + DISPUTE_SECONDS + 30))
      .toEqual({ kind: 'finalize', claimNo: 1, claimSide: 1, claimBlock: 30 });
  });

  it('never contests a claim on a game it cannot finish', () => {
    const position: AbandonmentPosition = { kind: 'open-claim', claimNo: 1, claimSide: 1, claimBlock: 30 };
    const step = at(position, t(30) + 60);
    expect(step.kind).toBe('wait');
  });

  it('waits when every claim is spent and it holds no full transcript', () => {
    expect(at({ kind: 'no-claims-left' }, 0).kind).toBe('wait');
    expect(at({ kind: 'no-claims-left' }, 0, { transcriptComplete: true })).toEqual({ kind: 'settle', contest: null });
  });
});
