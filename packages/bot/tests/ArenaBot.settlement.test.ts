/**
 * How a game ends for the bot: it settles what it won (and, as a fallback, a
 * draw), and takes its own notes back from whatever tx resolved the game —
 * found from the game's own `done` nullifier, whatever the opponent says.
 *
 * Real timers, whole games played out against a scripted human, the real
 * pedersen state hash on both sides and the real settle_game argument builder
 * (the transcript has to chain from the real empty-board hash, exactly as the
 * contract will check it), and in one test the real WebCrypto key exchange.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ArenaBot } from '../src/ArenaBot.js';
import {
  BOT_HAND, F, FakeSocket, GAME_KEY, OUTCOMES, RECORD1, RECORD2, RESOLVING_TX, SECRETS,
  chainBot, fakeChain, fakeChecks, fakeProofs, journalSpy, makeConfig, N,
} from './fakes.js';
import type { StateHasher } from '../../frontend/src/aztec/localGame.js';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Poll until `cond` holds (or fail after `ms`). */
async function until(cond: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await wait(10);
  }
}

// The transcript must start at the canonical empty board: the real builder
// chains it from there, exactly as the contract will. So both sides hash the
// board with the real pedersen hash the move circuit uses.
let pedersen: StateHasher;
beforeAll(async () => {
  const { computeBoardStateHash } = await import('../../frontend/src/aztec/proofWorker.js');
  pedersen = computeBoardStateHash;
  await pedersen(Array(18).fill('0'), [5, 5], 1, Array(9).fill(0));
}, 120_000);

/**
 * A game played out to its last move: eight moves in, the ninth — always the
 * human's — still to send.
 */
async function playedTo(
  outcome: keyof typeof OUTCOMES,
  opts: { drawFallbackMs?: number; pxe?: Record<string, unknown> } = {},
) {
  const h = chainBot({
    cfg: { pollIntervalMs: 20, drawFallbackMs: opts.drawFallbackMs ?? 0 },
    pxe: opts.pxe,
    checks: fakeChecks({ hashState: pedersen }),
    wait,
  });
  await h.ready();
  const hu = h.human({ strategy: OUTCOMES[outcome] });
  await h.begin(hu);
  await h.playTo(hu, 8);
  return { h, hu, last: async () => { h.socket.deliver(await hu.move()); } };
}

describe('the bot wins', () => {
  it('names its prize, settles, says so, and takes six cards and the reward back', async () => {
    const { h, last } = await playedTo('win');
    expect(h.f.called('settle'), 'not before the ninth move').toHaveLength(0);
    await last();
    await until(() => h.j.resolved.length === 1);

    expect(h.bot.getStats()).toMatchObject({ gamesPlayed: 1, wins: 1 });
    // SETTLING, then SETTLED — the prize is the human's legendary 247, placed at move 2.
    expect(h.sentPeers().slice(2)).toEqual([
      { kind: 'SETTLING', prizeMove: 2 },
      { kind: 'SETTLED', txHash: RESOLVING_TX.txHash },
    ]);
    // The real builder's flat list: game key, both records, the VK, 9 x (proof, inputs), prize.
    const args = h.f.called('settle')[0][2] as { toString(): string }[];
    expect(args).toHaveLength(1 + 2 + 1 + 18 + 1);
    expect(args[0].toString()).toBe(GAME_KEY);
    expect(BigInt(args[args.length - 1].toString())).toBe(2n);

    const [, txHash, notes] = h.f.called('importCards')[0];
    expect(txHash).toBe(RESOLVING_TX.txHash);
    expect(notes).toEqual([
      ...BOT_HAND.map((tokenId, slot) => ({ tokenId, randomness: SECRETS.returns[slot] })),
      { tokenId: 247, randomness: SECRETS.prize },
    ]);
    expect(h.f.called('importReward')[0].slice(3, 5)).toEqual([20, SECRETS.reward]);
    expect(h.j.resolved[0]).toEqual(['g1', 'settled', RESOLVING_TX.txHash]);
    expect(h.bot.getStats()).toMatchObject({ settlements: 1, settleFailures: 0, cardsUnimported: 0 });
    h.bot.stop();
  }, 60_000);

  it('takes its cards from the tx that beat its settlement, rather than calling the race a failure', async () => {
    let f: ReturnType<typeof fakeChain> | null = null;
    const { h, last } = await playedTo('win', {
      pxe: { sendSettleGame: async () => { f!.resolveIn(41); throw new Error('Existing nullifier'); } },
    });
    f = h.f;
    await last();
    await until(() => h.j.resolved.length === 1);
    expect(h.bot.getStats().settleFailures).toBe(0);
    expect(h.f.called('importCards')).toHaveLength(1);
    h.bot.stop();
  }, 60_000);

  it('counts cards that are ours on-chain but never surfaced', async () => {
    const { h, last } = await playedTo('win');
    h.f.state.lands = n => n.tokenId !== 247;
    await last();
    await until(() => h.j.resolved.length === 1);
    expect(h.bot.getStats().cardsUnimported).toBe(1);
    h.bot.stop();
  }, 60_000);
});

describe('the bot loses', () => {
  it('does not settle; on the winner\'s SETTLED it takes back the four returns the tx released, and the reward', async () => {
    const { h, last } = await playedTo('loss');
    await last();
    await until(() => h.bot.getStats().losses === 1);
    expect(h.bot.getStats().state, 'a loss frees the bot at once').not.toBe('playing');

    // The human settles, taking the bot's card from slot 2.
    h.f.resolveIn(44);
    h.f.state.released = { returns: [true, true, false, true, true], reward: true };
    h.peer('g1', { kind: 'SETTLING', prizeMove: 5 });
    h.peer('g1', { kind: 'SETTLED', txHash: RESOLVING_TX.txHash });
    await until(() => h.j.resolved.length === 1);

    expect(h.f.called('settle')).toHaveLength(0);
    expect(h.sentPeers().map(p => p.kind)).toEqual(['RECORD', 'OPEN_CARDS']);
    expect(h.f.called('importCards')[0][2].map((n: { tokenId: number }) => n.tokenId)).toEqual([7, 8, 10, 11]);
    expect(h.f.called('importReward')).toHaveLength(1);
    expect(h.j.store.get('g1')!.prizeMove, 'the winner\'s word is kept, as a hint').toBe(5);
    expect(h.bot.getStats().cardsUnimported).toBe(0);
    h.bot.stop();
  }, 60_000);

  it('imports from the chain\'s settlement even when SETTLED names a different tx', async () => {
    const { h, last } = await playedTo('loss');
    await last();
    await until(() => h.bot.getStats().losses === 1);
    h.f.resolveIn(44);
    h.f.state.released = { returns: [true, false, true, true, true], reward: true };
    h.peer('g1', { kind: 'SETTLED', txHash: F(0xdead) });
    await until(() => h.j.resolved.length === 1);
    expect(h.f.called('importCards')[0][1]).toBe(RESOLVING_TX.txHash);
    expect(h.logs.join('\n')).toMatch(/different settlement tx/);
    h.bot.stop();
  }, 60_000);
});

describe('a draw', () => {
  it('stands down when player 1 settles it during the fallback wait, and imports from their tx', async () => {
    const { h, last } = await playedTo('draw', { drawFallbackMs: 400 });
    await last();
    await until(() => h.bot.getStats().draws === 1);
    h.f.resolveIn(44);
    h.peer('g1', { kind: 'SETTLED', txHash: RESOLVING_TX.txHash });
    await until(() => h.j.resolved.length === 1);
    await wait(500);
    expect(h.f.called('settle'), 'settling again would revert after a full proof').toHaveLength(0);
    expect(h.f.called('importCards')[0][2].map((n: { tokenId: number }) => n.tokenId)).toEqual(BOT_HAND);
    h.bot.stop();
  }, 60_000);

  it('imports from a settlement it finds on-chain even when nobody said', async () => {
    const { h, last } = await playedTo('draw', { drawFallbackMs: 200 });
    await last();
    await until(() => h.bot.getStats().draws === 1);
    h.f.resolveIn(44);
    await until(() => h.j.resolved.length === 1);
    expect(h.f.called('settle')).toHaveLength(0);
    h.bot.stop();
  }, 60_000);

  it('settles it itself once player 1 has had their chance', async () => {
    const { h, last } = await playedTo('draw', { drawFallbackMs: 100 });
    await last();
    await until(() => h.j.resolved.length === 1);
    expect(h.sentPeers().slice(2)).toEqual([
      // A draw names no prize — announced as null, as the browser does.
      { kind: 'SETTLING', prizeMove: null },
      { kind: 'SETTLED', txHash: RESOLVING_TX.txHash },
    ]);
    const args = h.f.called('settle')[0][2] as { toString(): string }[];
    expect(BigInt(args[args.length - 1].toString()), 'a draw names no prize').toBe(0n);
    h.bot.stop();
  }, 60_000);
});

describe('what never leaves the bot', () => {
  it('after a whole game, its stats name no game key, record, nullifier or tx', async () => {
    const { h, last } = await playedTo('win');
    await last();
    await until(() => h.j.resolved.length === 1);
    const text = JSON.stringify(h.bot.getStats());
    for (const v of [GAME_KEY, ...RECORD1, ...RECORD2, N.created, N.joined, N.done, RESOLVING_TX.txHash]) {
      expect(text).not.toContain(v);
    }
    h.bot.stop();
  }, 60_000);
});

describe('the real key exchange', () => {
  it('agrees the game key with a human who never learns anything but its public key', async () => {
    const keys = await import('../../frontend/src/aztec/gameKeys.js');
    const socket = new FakeSocket();
    const f = fakeChain();
    f.state.hits.set(N.created, 4);
    const j = journalSpy();
    // No `keys` injected: the bot uses the frontend's own WebCrypto module.
    const bot = new ArenaBot(makeConfig({ pollIntervalMs: 20 }), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as never,
      proofs: fakeProofs().proofs,
      journal: j.journal,
      log: () => {},
    });
    bot.start();
    socket.emit('open');
    socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'bot', sessionToken: 't', resumed: false, gameId: null });
    socket.deliver({ type: 'BOT_REGISTERED' });
    await wait(60);
    socket.deliver({ type: 'MATCH_FOUND', gameId: 'room-7', playerNumber: 2 });
    await until(() => socket.countOfType('KEY_EXCHANGE') === 1);

    // The human's side, exactly as the browser does it.
    const human = await keys.generateGameKeyPair();
    const botKey = socket.lastOfType('KEY_EXCHANGE').publicKey;
    const channel = await keys.deriveGameChannel(human, botKey, 'room-7');
    socket.deliver({ type: 'OPPONENT_KEY', gameId: 'room-7', publicKey: human.publicKey });
    const sealed = await keys.sealPeerPayload(channel.channelKey, 'room-7', { kind: 'RECORD', record: RECORD1 });
    socket.deliver({ type: 'PEER', gameId: 'room-7', ...sealed });

    await until(() => f.called('join').length === 1);
    expect(f.called('join')[0][2], 'both sides derived the same game key').toBe(channel.gameKey);

    await until(() => socket.countOfType('PEER') >= 1);
    const reply = socket.ofType('PEER')[0];
    const opened = await keys.openPeerPayload(channel.channelKey, 'room-7', { iv: reply.iv, ciphertext: reply.ciphertext });
    expect(opened).toEqual({ kind: 'RECORD', record: RECORD2 });
    // What the relay carried: two public keys and ciphertext. Never the record in the clear.
    expect(JSON.stringify(socket.sent)).not.toContain(RECORD2[2]);
    // The journal keeps our private key, so a restarted bot can still open the channel.
    expect(j.store.get('room-7')!.keyPair.publicKey).toBe(botKey);
    bot.stop();
  });
});
