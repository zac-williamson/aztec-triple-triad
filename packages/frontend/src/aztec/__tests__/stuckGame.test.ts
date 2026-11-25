/**
 * What the menu offers for a game that still holds this player's cards. Every
 * offer must be one the contract accepts right now — a button that reverts
 * after its proof is worse than no button.
 */
import { describe, it, expect } from 'vitest';
import { assessStuckGame, SETTLE_GRACE_MS, type StuckGameFacts } from '../stuckGame';
import { abandonmentPosition } from '../privateGame';
import { DISPUTE_SECONDS, MIN_ABANDON_SECONDS } from '../settlementArgs';
import { chainState } from './privateGameFixtures';

const NOW = 1_000_000_000_000;

function facts(over: Partial<StuckGameFacts> & { state: StuckGameFacts['state'] }): StuckGameFacts {
  return {
    role: 1,
    record2Known: true,
    position: abandonmentPosition(over.state),
    transcriptComplete: false,
    weSettle: false,
    nowMs: NOW,
    chainNow: 10_000,
    ...over,
  };
}

const joined = { created: 5, seat2: 6, joined: 6 };

describe('assessStuckGame', () => {
  it('a resolved game is imported, whatever else is on record', () => {
    expect(assessStuckGame(facts({ state: chainState({ ...joined, done: 50 }) }))).toEqual({ kind: 'resolved' });
  });

  it('a commit that never landed is not a stake', () => {
    expect(assessStuckGame(facts({ role: 1, state: chainState({}) }))).toEqual({ kind: 'not-committed' });
    expect(assessStuckGame(facts({ role: 2, state: chainState({ created: 5 }) }))).toEqual({ kind: 'not-committed' });
  });

  it('the creator of a game nobody joined may cancel it', () => {
    expect(assessStuckGame(facts({ role: 1, record2Known: false, state: chainState({ created: 5 }) })))
      .toEqual({ kind: 'cancellable' });
  });

  it('a creator who never received the joiner\'s record can only wait', () => {
    expect(assessStuckGame(facts({ role: 1, record2Known: false, state: chainState({ created: 5, seat2: 6 }) })))
      .toEqual({ kind: 'wait' });
  });

  it('a full transcript outranks any claim: the settler may settle at once', () => {
    const state = chainState({ ...joined, claimSlots: [20], claims: [[null, 20]] });
    expect(assessStuckGame(facts({ state, transcriptComplete: true, weSettle: true }))).toEqual({ kind: 'settleable' });
  });

  it('the other player waits a grace period for the settler before settling themselves', () => {
    const state = chainState(joined);
    const early = assessStuckGame(facts({ state, transcriptComplete: true, weSettle: false, finishedAt: NOW - 60_000 }));
    expect(early).toEqual({ kind: 'awaiting-winner', waitSeconds: (SETTLE_GRACE_MS - 60_000) / 1000 });
    expect(assessStuckGame(facts({ state, transcriptComplete: true, weSettle: false, finishedAt: NOW - SETTLE_GRACE_MS })))
      .toEqual({ kind: 'settleable' });
  });

  it('an unfinished game is claimable only once the bar has passed since its clock block', () => {
    const state = chainState(joined);
    expect(assessStuckGame(facts({ state, clockAt: 10_000 - MIN_ABANDON_SECONDS }))).toEqual({ kind: 'claimable' });
    expect(assessStuckGame(facts({ state, clockAt: 10_000 - 100 })))
      .toEqual({ kind: 'too-soon', waitSeconds: MIN_ABANDON_SECONDS - 100 });
  });

  it('the opponent\'s claim may be contested while its window is open — once per side', () => {
    const state = chainState({ ...joined, claimSlots: [20], claims: [[null, 20]] });
    const claim = { claimNo: 1, claimSide: 2, claimBlock: 20 };
    expect(assessStuckGame(facts({ role: 1, state, claimAt: 10_000 - 100 })))
      .toEqual({ kind: 'contestable', claim, waitSeconds: DISPUTE_SECONDS - 100 });

    const contestedBefore = chainState({
      ...joined, claimSlots: [20, 40], claims: [[null, 20], [null, 40]],
      contests: [25], resolved: [25], contestedBy: [25, null],
    });
    expect(assessStuckGame(facts({ role: 1, state: contestedBefore, claimAt: 10_000 - 100 })).kind).toBe('claim-pending');
  });

  it('our own claim waits out its window, then anyone may finalize', () => {
    const state = chainState({ ...joined, claimSlots: [20], claims: [[20, null]] });
    expect(assessStuckGame(facts({ role: 1, state, claimAt: 10_000 - 10 })).kind).toBe('claim-pending');
    expect(assessStuckGame(facts({ role: 1, state, claimAt: 10_000 - DISPUTE_SECONDS })))
      .toEqual({ kind: 'finalizable', claim: { claimNo: 1, claimSide: 1, claimBlock: 20 } });
    // The other side's lapsed claim is just as finalizable — it returns both hands.
    const theirs = chainState({ ...joined, claimSlots: [20], claims: [[null, 20]] });
    expect(assessStuckGame(facts({ role: 1, state: theirs, claimAt: 10_000 - DISPUTE_SECONDS })).kind).toBe('finalizable');
  });

  it('offers nothing it cannot time', () => {
    expect(assessStuckGame(facts({ state: chainState(joined) })).kind).toBe('wait');
  });
});
