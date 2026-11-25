/**
 * How a game ends for the bot: it settles what it won (and, as a fallback, a
 * draw), and takes its own notes back from whatever tx resolved the game —
 * found from the game's own `done` nullifier, whatever the opponent says.
 *
 * Real timers, the real settle_game argument builder (the transcript has to
 * chain from the real empty-board hash), and in one test the real WebCrypto
 * key exchange against a simulated human.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ArenaBot } from '../src/ArenaBot.js';
import { createGame, getCardsByIds } from '@axolotl-arena/game-logic';
import {
  BOT_HAND, F, FakeSocket, GAME_KEY, HUMAN_HAND, RECORD1, RECORD2, RESOLVING_TX, SECRETS,
  chainBot, fakeChain, journalSpy, makeConfig, N, transcript,
} from './fakes.js';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const freshState = () => createGame(getCardsByIds(HUMAN_HAND), getCardsByIds(BOT_HAND));

/** Poll until `cond` holds (or fail after `ms`). */
async function until(cond: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await wait(10);
  }
}

// The transcript must start at the canonical empty board: the real builder
// chains it from there, exactly as the contract will.
let start: string;
beforeAll(async () => {
  const { computeCanonicalInitialHash } = await import('../../frontend/src/aztec/settlementArgs.js');
  start = await computeCanonicalInitialHash();
}, 120_000);

async function playedTo(winnerId: 1 | 2 | 3, opts: { drawFallbackMs?: number; pxe?: Record<string, unknown> } = {}) {
  const h = chainBot({
    cfg: { pollIntervalMs: 20, settleWaitMs: 3_000, drawFallbackMs: opts.drawFallbackMs ?? 0 },
    pxe: opts.pxe,
    wait,
  });
  await h.ready();
  h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
  h.handshake('g1');
  await until(() => h.f.called('join').length === 1);
  const moves = transcript({ winnerId, start });
  // Eight proofs before the game ends; the ninth — the human's last move —
  // always lands after GAME_OVER.
  for (const p of moves.slice(0, 8)) h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: p });
  const winner = winnerId === 1 ? 'player1' : winnerId === 2 ? 'player2' : 'draw';
  return { h, moves, over: () => h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner, gameState: freshState() }) };
}

describe('the bot wins', () => {
  it('waits for the ninth proof, names its prize, settles, says so, and takes six cards and the reward back', async () => {
    const { h, moves, over } = await playedTo(2);
    over();
    await wait(100);
    expect(h.f.called('settle'), 'not before the transcript is whole').toHaveLength(0);
    h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: moves[8] });
    await until(() => h.j.resolved.length === 1);

    // SETTLING, then SETTLED — the prize is the human's legendary 247, placed at move 4.
    expect(h.sentPeers()).toEqual([
      { kind: 'RECORD', record: RECORD2 },
      { kind: 'SETTLING', prizeMove: 4 },
      { kind: 'SETTLED', txHash: RESOLVING_TX.txHash },
    ]);
    // The real builder's flat list: game key, both records, the VK, 9 x (proof, inputs), prize.
    const args = h.f.called('settle')[0][2] as { toString(): string }[];
    expect(args).toHaveLength(1 + 2 + 1 + 18 + 1);
    expect(args[0].toString()).toBe(GAME_KEY);
    expect(BigInt(args[args.length - 1].toString())).toBe(4n);

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
  });

  it('takes its cards from the tx that beat its settlement, rather than calling the race a failure', async () => {
    let f: ReturnType<typeof fakeChain> | null = null;
    const { h, moves, over } = await playedTo(2, {
      pxe: { sendSettleGame: async () => { f!.resolveIn(41); throw new Error('Existing nullifier'); } },
    });
    f = h.f;
    over();
    h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: moves[8] });
    await until(() => h.j.resolved.length === 1);
    expect(h.bot.getStats().settleFailures).toBe(0);
    expect(h.f.called('importCards')).toHaveLength(1);
    h.bot.stop();
  });

  it('stands down if the other side settles while it is still waiting for the ninth proof', async () => {
    // Anyone may settle; a second settlement can only revert, after the proving.
    const { h, over } = await playedTo(2);
    over();
    await wait(50);
    h.f.resolveIn(44);
    h.peer('g1', { kind: 'SETTLED', txHash: RESOLVING_TX.txHash });
    await until(() => h.j.resolved.length === 1);
    await until(() => h.bot.getStats().state !== 'playing', 4_000);
    expect(h.f.called('settle')).toHaveLength(0);
    expect(h.sentPeers().map(p => p.kind), 'no SETTLING for a settlement it never sent').toEqual(['RECORD']);
    expect(h.bot.getStats().settleFailures).toBe(0);
    h.bot.stop();
  });

  it('counts cards that are ours on-chain but never surfaced', async () => {
    const { h, moves, over } = await playedTo(2);
    h.f.state.lands = n => n.tokenId !== 247;
    over();
    h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: moves[8] });
    await until(() => h.j.resolved.length === 1);
    expect(h.bot.getStats().cardsUnimported).toBe(1);
    h.bot.stop();
  });
});

describe('the bot loses', () => {
  it('does not settle; on the winner\'s SETTLED it takes back the four returns the tx released, and the reward', async () => {
    const { h, over } = await playedTo(1);
    over();
    await wait(50);
    expect(h.bot.getStats().state, 'a loss resets at once').not.toBe('playing');

    // The human settles, taking the bot's card from slot 2 (move 5).
    h.f.resolveIn(44);
    h.f.state.released = { returns: [true, true, false, true, true], reward: true };
    h.peer('g1', { kind: 'SETTLING', prizeMove: 5 });
    h.peer('g1', { kind: 'SETTLED', txHash: RESOLVING_TX.txHash });
    await until(() => h.j.resolved.length === 1);

    expect(h.f.called('settle')).toHaveLength(0);
    expect(h.sentPeers().map(p => p.kind)).toEqual(['RECORD']);
    expect(h.f.called('importCards')[0][2].map((n: { tokenId: number }) => n.tokenId)).toEqual([7, 8, 10, 11]);
    expect(h.f.called('importReward')).toHaveLength(1);
    expect(h.j.store.get('g1')!.prizeMove, 'the winner\'s word is kept, as a hint').toBe(5);
    expect(h.bot.getStats().cardsUnimported).toBe(0);
    h.bot.stop();
  });

  it('imports from the chain\'s settlement even when SETTLED names a different tx', async () => {
    const { h, over } = await playedTo(1);
    over();
    h.f.resolveIn(44);
    h.f.state.released = { returns: [true, false, true, true, true], reward: true };
    h.peer('g1', { kind: 'SETTLED', txHash: F(0xdead) });
    await until(() => h.j.resolved.length === 1);
    expect(h.f.called('importCards')[0][1]).toBe(RESOLVING_TX.txHash);
    expect(h.logs.join('\n')).toMatch(/different settlement tx/);
    h.bot.stop();
  });
});

describe('a draw', () => {
  it('stands down when player 1 settles it during the fallback wait, and imports from their tx', async () => {
    const { h, moves, over } = await playedTo(3, { drawFallbackMs: 400 });
    over();
    h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: moves[8] });
    h.f.resolveIn(44);
    h.peer('g1', { kind: 'SETTLED', txHash: RESOLVING_TX.txHash });
    await until(() => h.j.resolved.length === 1);
    await wait(500);
    expect(h.f.called('settle'), 'settling again would revert after a full proof').toHaveLength(0);
    expect(h.f.called('importCards')[0][2].map((n: { tokenId: number }) => n.tokenId)).toEqual(BOT_HAND);
    h.bot.stop();
  });

  it('imports from a settlement it finds on-chain even when nobody said', async () => {
    const { h, moves, over } = await playedTo(3, { drawFallbackMs: 200 });
    over();
    h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: moves[8] });
    h.f.resolveIn(44);
    await until(() => h.j.resolved.length === 1);
    expect(h.f.called('settle')).toHaveLength(0);
    h.bot.stop();
  });

  it('settles it itself once player 1 has had their chance', async () => {
    const { h, moves, over } = await playedTo(3, { drawFallbackMs: 100 });
    over();
    h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: moves[8] });
    await until(() => h.j.resolved.length === 1);
    expect(h.sentPeers().slice(1)).toEqual([
      // A draw names no prize — announced as null, as the browser does.
      { kind: 'SETTLING', prizeMove: null },
      { kind: 'SETTLED', txHash: RESOLVING_TX.txHash },
    ]);
    const args = h.f.called('settle')[0][2] as { toString(): string }[];
    expect(BigInt(args[args.length - 1].toString()), 'a draw names no prize').toBe(0n);
    h.bot.stop();
  });
});

describe('what never leaves the bot', () => {
  it('after a whole game, its stats name no game key, record, nullifier or tx', async () => {
    const { h, moves, over } = await playedTo(2);
    over();
    h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: moves[8] });
    await until(() => h.j.resolved.length === 1);
    const text = JSON.stringify(h.bot.getStats());
    for (const v of [GAME_KEY, ...RECORD1, ...RECORD2, N.created, N.joined, N.done, RESOLVING_TX.txHash]) {
      expect(text).not.toContain(v);
    }
    h.bot.stop();
  });
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
      journal: j.journal,
      log: () => {},
    });
    bot.start();
    socket.emit('open');
    socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'bot', sessionToken: 't' });
    socket.deliver({ type: 'BOT_REGISTERED' });
    await wait(60);
    socket.deliver({ type: 'MATCH_FOUND', gameId: 'room-7', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
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

    await until(() => socket.countOfType('PEER') === 1);
    const reply = socket.lastOfType('PEER');
    const opened = await keys.openPeerPayload(channel.channelKey, 'room-7', { iv: reply.iv, ciphertext: reply.ciphertext });
    expect(opened).toEqual({ kind: 'RECORD', record: RECORD2 });
    // What the relay carried: two public keys and ciphertext. Never the record in the clear.
    expect(JSON.stringify(socket.sent)).not.toContain(RECORD2[2]);
    // The journal keeps our private key, so a restarted bot can still open the channel.
    expect(j.store.get('room-7')!.keyPair.publicKey).toBe(botKey);
    bot.stop();
  });
});
