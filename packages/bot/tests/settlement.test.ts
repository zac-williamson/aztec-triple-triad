/**
 * Which of its own notes the bot imports after a game resolves — the step
 * that decides whether its cards come back. Read off what the resolving tx
 * released, never off anybody's word, and measured by what the wallet can see
 * afterwards.
 */
import { describe, it, expect } from 'vitest';
import { findResolvingTx, importOwnNotes, planOwnImport, type BotGame, type SettlementDeps } from '../src/settlement.js';
import {
  BOT_HAND, GAME_KEY, HUMAN_HAND, N, NONCE, RECORD1, RECORD2, RESOLVING_TX, SECRETS, fakeChain, transcript,
} from './fakes.js';

function game(over: Partial<BotGame> = {}): BotGame {
  return {
    gameKey: GAME_KEY, nonce: NONCE, cardIds: [...BOT_HAND], record1: RECORD1, record2: RECORD2,
    moveProofs: transcript({ winnerId: 2 }), outcome: 'win', prizeMove: null, ...over,
  };
}

const ALL = [true, true, true, true, true];

describe('planOwnImport: which notes are ours to import', () => {
  it('a win: our five returns, the prize our own prize move names, and the reward', () => {
    // We settled, choosing move 4 — the human's legendary 247.
    const plan = planOwnImport({ game: game({ prizeMove: 4 }), secrets: SECRETS, released: { returns: ALL, reward: true } });
    expect(plan.cards).toEqual([
      ...BOT_HAND.map((tokenId, slot) => ({ tokenId, randomness: SECRETS.returns[slot] })),
      { tokenId: 247, randomness: SECRETS.prize },
    ]);
    expect(plan.expectedCards).toBe(6);
    expect(plan.reward).toEqual({ amount: 20, randomness: SECRETS.reward });
  });

  it('a win somebody else settled without saying: every card the loser placed is a prize candidate', () => {
    const plan = planOwnImport({ game: game({ prizeMove: null }), secrets: SECRETS, released: { returns: ALL, reward: true } });
    const prizes = plan.cards.filter(c => c.randomness === SECRETS.prize).map(c => c.tokenId);
    // Only the human's cards — import_note keeps the one that is really there.
    expect(prizes.sort((a, b) => a - b)).toEqual([...HUMAN_HAND].sort((a, b) => a - b));
    expect(plan.expectedCards, 'one prize, however many candidates').toBe(6);
  });

  it('a loss: the four returns the tx released — the withheld slot is the card the winner took', () => {
    const plan = planOwnImport({
      game: game({ moveProofs: transcript({ winnerId: 1 }), outcome: 'loss' }),
      secrets: SECRETS,
      released: { returns: [true, true, false, true, true], reward: true },
    });
    expect(plan.resolution).toMatchObject({ kind: 'settled', winner: 1, prize: { cardId: 9, slot: 2 } });
    expect(plan.cards.map(c => c.tokenId)).toEqual([7, 8, 10, 11]);
    expect(plan.cards.map(c => c.randomness)).toEqual([SECRETS.returns[0], SECRETS.returns[1], SECRETS.returns[3], SECRETS.returns[4]]);
    expect(plan.cards.some(c => c.randomness === SECRETS.prize), 'no prize for the loser').toBe(false);
    expect(plan.expectedCards).toBe(4);
    expect(plan.reward).not.toBeNull();
  });

  it('a loss even without the relay\'s word or the winner\'s SETTLING: the tx says which slot went', () => {
    const plan = planOwnImport({
      game: game({ moveProofs: [], outcome: null }),
      secrets: SECRETS,
      released: { returns: [true, true, true, false, true], reward: true },
    });
    expect(plan.cards.map(c => c.tokenId)).toEqual([7, 8, 9, 11]);
  });

  it('a draw: all five back and the reward, no prize', () => {
    const plan = planOwnImport({
      game: game({ moveProofs: transcript({ winnerId: 3 }), outcome: 'draw' }),
      secrets: SECRETS,
      released: { returns: ALL, reward: true },
    });
    expect(plan.resolution).toMatchObject({ kind: 'settled', winner: 'draw' });
    expect(plan.cards.map(c => c.tokenId)).toEqual(BOT_HAND);
    expect(plan.expectedCards).toBe(5);
  });

  it('an unwound game: all five back and no reward', () => {
    const plan = planOwnImport({
      game: game({ moveProofs: transcript({ winnerId: 2, moves: 4 }), outcome: null }),
      secrets: SECRETS,
      released: { returns: ALL, reward: false },
    });
    expect(plan.resolution).toEqual({ kind: 'unwound' });
    expect(plan.cards.map(c => c.tokenId)).toEqual(BOT_HAND);
    expect(plan.reward).toBeNull();
  });

  it('if none of our notes match the tx, imports every note it could own rather than none', () => {
    // The tx carries this game's `done`, so a match of nothing means the match
    // is wrong, not the chain. Importing too much costs a simulation; too
    // little strands cards invisibly.
    const logs: string[] = [];
    const plan = planOwnImport({
      game: game({ prizeMove: 4 }),
      secrets: SECRETS,
      released: { returns: [false, false, false, false, false], reward: false },
      log: m => logs.push(m),
    });
    expect(plan.cards.filter(c => c.randomness !== SECRETS.prize).map(c => c.tokenId)).toEqual(BOT_HAND);
    expect(plan.reward).not.toBeNull();
    expect(logs.join('\n')).toMatch(/WARNING/);
  });
});

describe('importOwnNotes', () => {
  const deps = (f: ReturnType<typeof fakeChain>): SettlementDeps => ({
    chain: f.chain as never, sendOpts: () => ({ node: null, timeoutMs: 600 }), log: () => {},
  });

  it('imports exactly the planned notes and the reward, and measures what landed', async () => {
    const f = fakeChain();
    f.state.released = { returns: [true, true, false, true, true], reward: true };
    const result = await importOwnNotes(deps(f), game({ moveProofs: transcript({ winnerId: 1 }), outcome: 'loss' }), RESOLVING_TX);
    const [, txHash, notes] = f.called('importCards')[0];
    expect(txHash).toBe(RESOLVING_TX.txHash);
    expect(notes.map((n: { tokenId: number }) => n.tokenId)).toEqual([7, 8, 10, 11]);
    expect(f.called('importReward')[0].slice(3, 5)).toEqual([20, SECRETS.reward]);
    expect(result).toMatchObject({ expectedCards: 4, gainedCards: 4, rewardImported: true, txHash: RESOLVING_TX.txHash });
  });

  it('re-derives our secrets from the journalled nonce rather than keeping them anywhere', async () => {
    const f = fakeChain();
    await importOwnNotes(deps(f), game({ prizeMove: 4 }), RESOLVING_TX);
    expect(f.called('secrets')[0]).toEqual(['secrets', '0xbot', NONCE]);
  });

  it('reports a shortfall honestly when an import does not surface', async () => {
    const f = fakeChain();
    f.state.lands = n => n.tokenId !== 9;   // one note never shows up
    const result = await importOwnNotes(deps(f), game({ prizeMove: 4 }), RESOLVING_TX);
    expect(result.expectedCards).toBe(6);
    expect(result.gainedCards).toBe(5);
  });
});

describe('findResolvingTx', () => {
  const deps = (f: ReturnType<typeof fakeChain>): SettlementDeps => ({
    chain: f.chain as never, sendOpts: () => ({ node: null, timeoutMs: 600 }), log: () => {},
  });

  it('finds the resolution by the game\'s own done nullifier — nobody has to say', async () => {
    const f = fakeChain();
    f.resolveIn(44);
    expect(await findResolvingTx(deps(f), game())).toEqual(RESOLVING_TX);
    expect(f.called('nullifiers')[0].slice(2)).toEqual([GAME_KEY, RECORD1, RECORD2]);
  });

  it('is null while the game is unresolved', async () => {
    const f = fakeChain();
    expect(await findResolvingTx(deps(f), game())).toBeNull();
  });

  it('waits for a node that has not seen a just-mined resolution yet', async () => {
    const f = fakeChain();
    setTimeout(() => f.resolveIn(45), 30);
    expect(await findResolvingTx(deps(f), game(), { waitMs: 2_000, pollMs: 10 })).toEqual(RESOLVING_TX);
  });

  it('fails loudly if the block holds the done nullifier but no tx carries it', async () => {
    const f = fakeChain();
    f.state.hits.set(N.done, 46);
    await expect(findResolvingTx(deps(f), game())).rejects.toThrow(/no tx in it/);
  });

});
