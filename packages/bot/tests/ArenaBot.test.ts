import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ArenaBot, redactForHealth, withoutCardDetails, type QueueSnapshot } from '../src/ArenaBot.js';
import type { ArenaBotConfig } from '../src/config.js';
import {
  BOT_HAND, F, FakeSocket, GAME_KEY, HUMAN_HAND, HUMAN_PK, N, NONCE, NULLIFIERS, OUTCOMES, RECORD1, RECORD2, SECRETS,
  chainBot, fakeChain, fakeChecks, fakeKeys, fakeProofB64, fakeProofs, makeConfig, proveLike,
} from './fakes.js';
import type { MoveProofArgs } from '../src/chainTypes.js';

// settle_game's argument list is the frontend's to build (and to test); here a
// settlement only has to be sent. ArenaBot.settlement.test.ts runs the real one.
vi.mock('../../frontend/src/aztec/settlementArgs.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  buildSettleGameArgs: vi.fn(async () => ['settle-args']),
}));

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
type BotOpts = Omit<Parameters<typeof chainBot>[0], 'wait'>;
const fakeBot = (opts: BotOpts = {}) => chainBot({ ...opts, wait: tick });

/** A bot with a settable queue snapshot and clock — what the queueing policy is judged on. */
function harness(cfg: Partial<ArenaBotConfig> = {}) {
  let queue: QueueSnapshot = { length: 0, oldestWaitMs: 0, entries: [] };
  let clock = 1_000_000;
  const h = fakeBot({ cfg, queue: () => queue, now: () => clock });
  return Object.assign(h, {
    setQueue: (q: Partial<QueueSnapshot>) => { queue = { length: 1, oldestWaitMs: 0, entries: [], ...q }; },
    advance: (ms: number) => { clock += ms; },
  });
}

/** A bot matched, keyed and joined, and a human whose open cards both sides have checked. */
async function begun(opts: BotOpts = {}, human: Parameters<ReturnType<typeof chainBot>['human']>[0] = {}) {
  const h = fakeBot(opts);
  await h.ready();
  const hu = h.human(human);
  await h.begin(hu);
  return { h, hu };
}

/** A bot matched, keyed and joined — open cards not exchanged. */
async function joined(opts: BotOpts = {}) {
  const h = fakeBot(opts);
  await h.ready();
  h.match();
  h.handshake('g1');
  await tick(50);
  expect(h.f.called('join'), 'the bot should have joined').toHaveLength(1);
  return h;
}

/** What a refused game leaves behind: the bot gone, the game the sweep's, and nothing about the human's cards in the log. */
function expectHalted(h: ReturnType<typeof fakeBot>, reason: RegExp) {
  const stats = h.bot.getStats();
  expect(stats.opponentFaults).toBe(1);
  expect(stats.abandonedGames).toBe(1);
  expect(stats.cardsStranded, 'its five cards wait for the sweep').toBe(5);
  expect(['idle', 'queued']).toContain(stats.state);
  expect(h.socket.lastOfType('LEAVE_GAME')).toMatchObject({ gameId: 'g1' });
  const rec = h.j.store.get('g1')!;
  expect(rec.protocolError).toMatch(reason);
  expect(rec.resolution, 'still outstanding: the sweep claims it').toBeUndefined();
  // Logged, and kept, without card details: no number but the move's own.
  const refusal = h.logs.find(l => l.includes('refused'));
  expect(refusal).toMatch(/refused (their open cards|their move \d): [^\d]*$/);
  expect(rec.protocolError).toMatch(/^(their open cards|their move \d): [^\d]*$/);
  expect(stats.lastError).toMatch(/: [^\d]*$/);
  const log = h.logs.join('\n');
  for (const id of [180, 247, 230]) expect(log).not.toMatch(new RegExp(`\\b${id}\\b`));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ArenaBot queueing policy', () => {
  it('registers with the relay on connect', async () => {
    const h = harness();
    h.bot.start();
    h.socket.emit('open');
    // Must NOT register before the server has given us a session.
    expect(h.socket.lastOfType('REGISTER_BOT')).toBeUndefined();
    h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'bot', sessionToken: 't', resumed: false, gameId: null });
    expect(h.socket.lastOfType('REGISTER_BOT')).toMatchObject({ token: 'tok' });
    h.bot.stop();
  });

  it('does not queue while nobody is waiting', async () => {
    const h = harness();
    await h.ready();
    h.setQueue({ length: 0, oldestWaitMs: 0 });
    await tick(5_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    expect(h.bot.getStats().state).toBe('idle');
    h.bot.stop();
  });

  it('does not queue below the join threshold', async () => {
    const h = harness();
    await h.ready();
    h.setQueue({ length: 1, oldestWaitMs: 19_999 });
    await tick(5_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    h.bot.stop();
  });

  it('offers a game once someone has waited past the threshold — and names no card doing it', async () => {
    const h = harness();
    await h.ready();
    h.setQueue({ length: 1, oldestWaitMs: 20_000 });
    await tick(1_000);
    expect(h.socket.lastOfType('QUEUE_MATCHMAKING')).toEqual({ type: 'QUEUE_MATCHMAKING' });
    expect(h.bot.getStats().state).toBe('queued');
    h.bot.stop();
  });

  it('queues only once while still waiting for a match', async () => {
    const h = harness();
    await h.ready();
    h.setQueue({ length: 1, oldestWaitMs: 30_000 });
    await tick(5_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(1);
    h.bot.stop();
  });

  it('leaves the queue if no match forms — otherwise it would ambush the next player', async () => {
    const h = harness({ queueTimeoutMs: 10_000 });
    await h.ready();
    h.setQueue({ length: 1, oldestWaitMs: 25_000 });
    await tick(1_000);
    expect(h.bot.getStats().state).toBe('queued');

    h.advance(11_000);
    await tick(1_000);
    expect(h.socket.lastOfType('CANCEL_MATCHMAKING')).toBeTruthy();
    expect(h.bot.getStats().state).toBe('idle');
    h.bot.stop();
  });

  it('does not take a second game while already playing', async () => {
    const h = harness();
    await h.ready();
    h.match();
    h.setQueue({ length: 1, oldestWaitMs: 60_000 });
    await tick(5_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    expect(h.bot.getStats().state).toBe('playing');
    h.bot.stop();
  });

  it('never offers a game it could not play: without a prover it does not queue at all', async () => {
    // Every move carries a proof over both committed hands, checked by the
    // opponent's client. A bot that cannot prove would match a player and
    // then never make a move they would accept.
    const h = fakeBot({ noProofs: true });
    await h.ready();
    await tick(5_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    expect(h.logs.join('\n')).toMatch(/needs a chain and a prover/);
    h.bot.stop();
  });
});

describe('ArenaBot hand and seat', () => {
  it('wagers cards it actually holds — chosen when it queues, named only to the chain', async () => {
    const h = await joined();
    // makeConfig names no hand; the chain says it holds [7..11].
    expect(h.f.called('join')[0][4]).toEqual(BOT_HAND);
    expect(h.socket.lastOfType('QUEUE_MATCHMAKING')).toEqual({ type: 'QUEUE_MATCHMAKING' });
    h.bot.stop();
  });

  it('does not queue when it cannot field five cards', async () => {
    const h = fakeBot({ chain: { selectHand: async () => { throw new Error('holds only 3 card(s)'); } } });
    await h.ready();
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    expect(h.bot.getStats().state).toBe('idle');
    expect(h.bot.getStats().joinFailures).toBe(1);
    expect(h.bot.getStats().lastError).toMatch(/holds only 3/);
    h.bot.stop();
  });

  it('leaves immediately if the server ever assigns it the creator slot', async () => {
    const h = fakeBot();
    await h.ready();
    // The server orders every pair so a bot is never the creator. If that ever
    // failed, the bot must NOT quietly start creating games — creating wagers
    // five cards as player 1, which is exactly what we promised it never does.
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1 });
    await tick(50);
    expect(h.socket.lastOfType('LEAVE_GAME')).toMatchObject({ gameId: 'g1' });
    expect(h.bot.getStats().lastError).toMatch(/only joins/);
    expect(h.socket.countOfType('KEY_EXCHANGE')).toBe(0);
    h.bot.stop();
  });
});

describe('ArenaBot key exchange and join', () => {
  it('sends a fresh public key for the game at MATCH_FOUND — and nothing else about itself', async () => {
    const h = fakeBot();
    await h.ready();
    h.match();
    await tick(10);
    expect(h.socket.lastOfType('KEY_EXCHANGE')).toEqual({ type: 'KEY_EXCHANGE', gameId: 'g1', publicKey: 'Ym90LXB1Yg==' });
    expect(h.socket.sent.map(m => m.type)).not.toContain('SHARE_AZTEC_INFO');
    h.bot.stop();
  });

  it('joins once the creator\'s record arrives and their game is on-chain', async () => {
    const h = await joined();
    // Everything keyed by the game key the exchange produced — never an id the relay knows.
    expect(h.f.called('nullifiers')[0].slice(2)).toEqual([GAME_KEY, RECORD1, null]);
    // The nonce is read BEFORE committing: the commit advances it.
    expect(h.f.called('secrets')[0].slice(2)).toEqual([NONCE]);
    expect(h.f.called('preview')[0].slice(2)).toEqual([GAME_KEY, BOT_HAND, NONCE]);
    const [, owner, gameKey, record1, hand, opts] = h.f.called('join')[0];
    expect([owner, gameKey, record1, hand]).toEqual(['0xbot', GAME_KEY, RECORD1, BOT_HAND]);
    // pxe.ts hands this to the SDK's wait, which counts seconds.
    expect(opts.timeoutMs).toBe(600);
    expect(h.bot.getStats().game).toMatchObject({ keyed: true, opponentRecord: true, committed: true });
    h.bot.stop();
  });

  it('tells the relay the join landed without naming the tx, then sends its record and its open cards', async () => {
    const h = await joined();
    expect(h.socket.lastOfType('TX_CONFIRMED')).toEqual({ type: 'TX_CONFIRMED', gameId: 'g1', txType: 'join_game' });
    expect(h.sentPeers().map(p => p.kind)).toEqual(['RECORD', 'OPEN_CARDS']);
    expect(h.sentPeers()[0]).toEqual({ kind: 'RECORD', record: RECORD2 });
    h.bot.stop();
  });

  it('does not join until the creator\'s game is on-chain', async () => {
    const h = fakeBot();
    h.f.state.hits.delete(N.created);
    await h.ready();
    h.match();
    h.handshake('g1');
    await tick(10_000);
    // join_game proves `created` exists; sending it now would revert.
    expect(h.f.called('join')).toHaveLength(0);

    h.f.state.hits.set(N.created, 7);
    await tick(5_000);
    expect(h.f.called('join')).toHaveLength(1);
    h.bot.stop();
  });

  it('gives up on a record whose game never appears — nothing of ours was spent', async () => {
    const h = fakeBot({ cfg: { createdWaitMs: 20_000 } });
    h.f.state.hits.delete(N.created);
    await h.ready();
    h.match();
    h.handshake('g1');
    await tick(30_000);
    expect(h.f.called('join')).toHaveLength(0);
    expect(h.f.called('nonce'), 'not even a nonce read').toHaveLength(0);
    expect(h.bot.getStats().commitFailures).toBe(1);
    expect(h.socket.lastOfType('LEAVE_GAME')).toMatchObject({ gameId: 'g1' });
    expect(['idle', 'queued']).toContain(h.bot.getStats().state);
    expect(h.bot.getStats().cardsStranded).toBe(0);
    h.bot.stop();
  });

  it('refuses to commit when the contract\'s record does not commit to its own hand', async () => {
    // Every move proof binds that commitment: joining anyway would commit five
    // cards to a game whose moves can never be proved.
    const h = fakeBot({ proofs: { cardCommitHash: async () => F(0xbad) } });
    await h.ready();
    h.match();
    h.handshake('g1');
    await tick(50);
    expect(h.f.called('join')).toHaveLength(0);
    expect(h.bot.getStats().lastError).toMatch(/does not commit to our own hand/);
    h.bot.stop();
  });

  it('joins once however often the record is repeated', async () => {
    const h = await joined();
    h.peer('g1', { kind: 'RECORD', record: RECORD1 });
    h.peer('g1', { kind: 'RECORD', record: RECORD1 });
    await tick(50);
    expect(h.f.called('join')).toHaveLength(1);
    h.bot.stop();
  });

  it('keeps the first record and ignores a different second one', async () => {
    const h = await joined();
    h.peer('g1', { kind: 'RECORD', record: RECORD2 });
    await tick(50);
    expect(h.f.called('join')).toHaveLength(1);
    expect(h.logs.join('\n')).toMatch(/second, different creator record/);
    h.bot.stop();
  });

  it('holds payloads that arrive before its own key is ready', async () => {
    let releaseKey: () => void = () => {};
    const h = fakeBot();
    const generate = h.k.keys.generateGameKeyPair;
    h.k.keys.generateGameKeyPair = () => new Promise(r => { releaseKey = () => r(generate()); });
    await h.ready();
    h.match();
    h.handshake('g1');
    await tick(50);
    expect(h.f.called('join')).toHaveLength(0);

    releaseKey();
    await tick(50);
    expect(h.f.called('join')).toHaveLength(1);
    h.bot.stop();
  });

  it('drops a payload that does not open with this game\'s channel', async () => {
    const h = fakeBot();
    await h.ready();
    h.match();
    h.socket.deliver({ type: 'OPPONENT_KEY', gameId: 'g1', publicKey: HUMAN_PK });
    // Sealed for another room: the associated data does not match.
    h.socket.deliver({ type: 'PEER', gameId: 'g1', ...h.k.seal('other-room', { kind: 'RECORD', record: RECORD1 }) });
    await tick(50);
    expect(h.f.called('join')).toHaveLength(0);
    expect(h.logs.join('\n')).toMatch(/does not open/);
    h.bot.stop();
  });

  it('ignores a second, different key from the opponent', async () => {
    const h = await joined();
    h.socket.deliver({ type: 'OPPONENT_KEY', gameId: 'g1', publicKey: 'b3RoZXI=' });
    await tick(10);
    expect(h.logs.join('\n')).toMatch(/second, different key/);
    h.bot.stop();
  });

  it('leaves when the creator cancels before it joins', async () => {
    const h = fakeBot();
    await h.ready();
    h.match();
    h.socket.deliver({ type: 'OPPONENT_KEY', gameId: 'g1', publicKey: HUMAN_PK });
    h.peer('g1', { kind: 'CANCELLED' });
    await tick(50);
    expect(h.socket.lastOfType('LEAVE_GAME')).toMatchObject({ gameId: 'g1' });
    expect(h.bot.getStats().abandonedGames).toBe(1);
    expect(h.bot.getStats().cardsStranded).toBe(0);
    h.bot.stop();
  });

  it('does not wait the whole game out for a record that never comes', async () => {
    const h = fakeBot({ cfg: { recordWaitMs: 60_000, pollIntervalMs: 1_000 } });
    await h.ready();
    h.match();
    await tick(61_000);
    expect(h.bot.getStats().abandonedGames).toBe(1);
    expect(h.f.called('join')).toHaveLength(0);
    h.bot.stop();
  });
});

describe('ArenaBot open cards', () => {
  it('proves its first three committed slots against its own record, and the human\'s client accepts them', async () => {
    const h = await joined();
    expect(h.openProved).toEqual([{ hand: BOT_HAND, blinding: SECRETS.blinding, handCommit: RECORD2[1] }]);
    const sent = h.sentPeers().find(p => p.kind === 'OPEN_CARDS');
    expect(sent.cards).toEqual(BOT_HAND.slice(0, 3));
    const hu = h.human();
    await hu.receiveOpenCards(sent);
    expect(hu.botOpen).toEqual(BOT_HAND.slice(0, 3));
    h.bot.stop();
  });

  it('checks the human\'s open cards against the creator\'s record before they count', async () => {
    const { h } = await begun();
    expect(h.j.store.get('g1')!.opponentOpenCards).toEqual(HUMAN_HAND.slice(0, 3));
    expect(h.logs.join('\n')).toMatch(/their open cards check out/);
    h.bot.stop();
  });

  it('holds open cards that arrive before the join, and checks them once both records are known', async () => {
    let releaseJoin: (v: string) => void = () => {};
    const h = fakeBot({ pxe: { sendJoinGame: () => new Promise<string>(r => { releaseJoin = r; }) } });
    await h.ready();
    const hu = h.human();
    h.match();
    h.handshake('g1');
    h.peer('g1', hu.openCards());
    await tick(50);
    expect(h.j.store.get('g1')!.opponentOpenCards ?? null, 'nothing is checked before our cards are in').toBeNull();

    releaseJoin(F(0x10a));
    await tick(50);
    expect(h.j.store.get('g1')!.opponentOpenCards).toEqual(HUMAN_HAND.slice(0, 3));
    h.bot.stop();
  });

  it('refuses open cards whose proof does not verify — and plays no further', async () => {
    const h = fakeBot({ checks: fakeChecks({ verifyOpenCards: async () => false }) });
    await h.ready();
    const hu = h.human({ checks: fakeChecks() });
    h.match();
    h.handshake('g1');
    await tick(50);
    h.peer('g1', hu.openCards());
    await tick(50);
    expectHalted(h, /their open cards: its proof does not verify/);
    h.socket.deliver(await hu.move());
    await tick(1_000);
    expect(h.sent('MOVE'), 'a halted game gets no more moves').toHaveLength(0);
    h.bot.stop();
  });

  it('refuses open cards proven against another hand commitment', async () => {
    const h = await joined();
    const hu = h.human();
    const theirs = hu.openCards();
    theirs.publicInputs[0] = RECORD2[1];
    h.peer('g1', theirs);
    await tick(50);
    expectHalted(h, /card_commit_hash does not match/);
    h.bot.stop();
  });

  it('takes the same open cards again (a resend), but refuses a different set', async () => {
    const { h, hu } = await begun();
    h.peer('g1', hu.openCards());
    await tick(50);
    expect(h.bot.getStats().opponentFaults).toBe(0);

    const other = hu.openCards();
    other.cards = [1, 180, 2];
    h.peer('g1', other);
    await tick(50);
    expectHalted(h, /a second, different set of open cards/);
    h.bot.stop();
  });

  it('plays on when its own open-cards proof fails — the human just sees its hand face down', async () => {
    const h = fakeBot({ proofs: { proveOpenCards: async () => { throw new Error('prover crashed'); } } });
    await h.ready();
    const hu = h.human();
    h.match();
    h.handshake('g1');
    await tick(50);
    expect(h.sentPeers().map(p => p.kind)).toEqual(['RECORD']);
    expect(h.bot.getStats().proofFailures).toBe(1);
    h.socket.deliver(await hu.move());
    await hu.receive(await h.botMove(1));
    h.bot.stop();
  });
});

describe('ArenaBot moves', () => {
  it('checks the human\'s move, then replies with a proven, sealed move numbered next — one the human\'s client accepts', async () => {
    const { h, hu } = await begun();
    h.socket.deliver(await hu.move());
    const reply = await h.botMove(1);
    // The relay reads the number and nothing else.
    expect(Object.keys(reply).sort()).toEqual(['ciphertext', 'gameId', 'iv', 'moveNumber', 'type']);
    expect(reply).toMatchObject({ type: 'MOVE', gameId: 'g1', moveNumber: 1 });
    // The human's browser checks it: bounds, state hashes, all eight public inputs.
    const link = await hu.receive(reply);
    expect(BOT_HAND).toContain(link.cardId);
    expect(link.slot).toBe(BOT_HAND.indexOf(link.cardId));
    h.bot.stop();
  });

  it('proves against both records\' hand commitments, with its hand in committed order', async () => {
    const { h, hu } = await begun();
    h.socket.deliver(await hu.move());
    await h.botMove(1);
    expect(h.proved).toHaveLength(1);
    const args = h.proved[0];
    expect(args.cardCommit1).toBe(RECORD1[1]);
    expect(args.cardCommit2).toBe(RECORD2[1]);
    expect(args.hand).toEqual({ cardIds: BOT_HAND, blindingFactor: SECRETS.blinding });
    expect(args.currentPlayer).toBe(2);
    expect(args.gameEnded).toBe(false);
    h.bot.stop();
  });

  it('plays a whole game: all nine moves, each accepted by the other side, in one transcript', async () => {
    const { h, hu } = await begun({}, { strategy: OUTCOMES.loss });
    await h.playTo(hu);
    await tick(50);
    const rec = h.j.store.get('g1')!;
    expect(rec.moves!.map(m => m.moveNumber)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // The bot's transcript is the human's, move for move and proof for proof.
    expect(rec.moves).toEqual(hu.moves.map(({ moveNumber, cardId, slot, row, col }) => ({ moveNumber, cardId, slot, row, col })));
    expect(rec.moveProofs.map(p => p.publicInputs)).toEqual(hu.moves.map(m => m.proof.publicInputs));
    // One proof per move of the bot's own; the human's checked, never re-proven.
    expect(h.proved).toHaveLength(4);
    h.bot.stop();
  });

  describe('refuses a move that does not check out, and halts the game', () => {
    it('a public input that is not this board\'s', async () => {
      const { h, hu } = await begun();
      h.socket.deliver(await hu.move(p => { p.publicInputs[2] = F(1); }));
      await tick(100);
      expectHalted(h, /their move 0: its proof's start_state_hash does not match/);
      expect(h.sent('MOVE')).toHaveLength(0);
      h.bot.stop();
    });

    it('a proof that does not verify', async () => {
      const { h, hu } = await begun({ checks: fakeChecks({ verifyMove: async () => false }) }, { checks: fakeChecks() });
      h.socket.deliver(await hu.move());
      await tick(100);
      expectHalted(h, /their move 0: its proof does not verify/);
      expect(h.sent('MOVE')).toHaveLength(0);
      h.bot.stop();
    });

    it('a card that is not the open card proven for its slot', async () => {
      const { h, hu } = await begun();
      // Slot 0 is proven to hold card 1; the move claims card 247 came out of it.
      h.socket.deliver(await hu.move(p => { p.cardId = 247; }));
      await tick(100);
      expectHalted(h, /their move 0: slot # holds open card #, but the move plays card #/);
      h.bot.stop();
    });

    it('a card placed on an occupied cell', async () => {
      const { h, hu } = await begun();
      await h.playTo(hu, 2);
      const taken = hu.moves[0];
      h.socket.deliver(await hu.move(p => { p.row = taken.row; p.col = taken.col; }));
      await tick(100);
      expectHalted(h, /their move 2: cell \(#, #\) is occupied/);
      expect(h.sent('MOVE')).toHaveLength(1);
      h.bot.stop();
    });

    it('a move that does not open with this game\'s channel', async () => {
      const { h, hu } = await begun();
      const move = hu.plan();
      const payload = await hu.payloadFor(move);
      h.socket.deliver({ type: 'MOVE', gameId: 'g1', moveNumber: 0, ...h.k.seal('another-room', payload) });
      await tick(100);
      expectHalted(h, /their move 0: it does not open/);
      h.bot.stop();
    });

    it('a second, different move under a number already played', async () => {
      const { h, hu } = await begun();
      await h.playTo(hu, 2);
      // Move 0 again — another card, another cell.
      const first = hu.moves[0];
      const again = await hu.frame(0, {
        cardId: 180, slot: 1, row: 2, col: 2, proof: fakeProofB64(), publicInputs: first.proof.publicInputs,
      });
      h.socket.deliver(again);
      await tick(100);
      expectHalted(h, /their move 0: a second, different move with the same number/);
      h.bot.stop();
    });
  });

  it('does not hold a check that could not run against the human: the move waits, and is checked again', async () => {
    let verifierUp = false;
    const { h, hu } = await begun(
      { checks: fakeChecks({ verifyMove: async () => { if (!verifierUp) throw new Error('bb.js crashed'); return true; } }) },
      { checks: fakeChecks() },
    );
    h.socket.deliver(await hu.move());
    await tick(100);
    expect(h.sent('MOVE')).toHaveLength(0);
    expect(h.bot.getStats()).toMatchObject({ opponentFaults: 0, abandonedGames: 0, state: 'playing' });
    expect(h.bot.getStats().lastError).toMatch(/could not be checked/);

    verifierUp = true;
    await tick(30_000);
    await hu.receive(await h.botMove(1));
    h.bot.stop();
  });

  it('takes a move delivered twice as one move', async () => {
    const { h, hu } = await begun();
    const frame = await hu.move();
    h.socket.deliver(frame);
    await tick(50);
    h.socket.deliver(frame);
    await tick(500);
    expect(h.sent('MOVE')).toHaveLength(1);
    expect(h.bot.getStats().opponentFaults).toBe(0);
    h.bot.stop();
  });

  it('ignores a move for a game it is not in', async () => {
    const { h, hu } = await begun();
    const frame = await hu.move();
    h.socket.deliver({ ...frame, gameId: 'someone-elses-game' });
    await tick(500);
    expect(h.sent('MOVE')).toHaveLength(0);
    expect(h.bot.getStats().opponentFaults).toBe(0);
    h.bot.stop();
  });

  it('holds the human\'s move until its own cards are committed — then plays, even though its turn came DURING the commit', async () => {
    let releaseJoin: (v: string) => void = () => {};
    const h = fakeBot({ pxe: { sendJoinGame: () => new Promise<string>(r => { releaseJoin = r; }) } });
    await h.ready();
    const hu = h.human();
    h.match();
    h.handshake('g1');
    h.socket.deliver(await hu.move());
    await tick(1_000);
    // Moving here would prove against a commitment that is not on-chain yet.
    expect(h.sent('MOVE')).toHaveLength(0);

    // The relay sends a move once: committing must pick up the one it holds.
    releaseJoin(F(0x10a));
    await hu.receive(await h.botMove(1));
    h.bot.stop();
  });

  it('gives the game up when its own move cannot be proved — nothing was sent, and the sweep has its cards', async () => {
    const { h, hu } = await begun({ proofs: { proveMove: async () => { throw new Error('prover out of memory'); } } });
    h.socket.deliver(await hu.move());
    await tick(100);
    expect(h.sent('MOVE')).toHaveLength(0);
    const stats = h.bot.getStats();
    expect(stats).toMatchObject({ proofFailures: 1, abandonedGames: 1, cardsStranded: 5, opponentFaults: 0 });
    expect(['idle', 'queued']).toContain(stats.state);
    expect(h.socket.lastOfType('LEAVE_GAME')).toMatchObject({ gameId: 'g1' });
    // The transcript holds only what both sides have.
    expect(h.j.store.get('g1')!.moves).toHaveLength(1);
    h.bot.stop();
  });

  it('plays one move per turn, however often the turn is signalled', async () => {
    const { h, hu } = await begun({ cfg: { difficulty: 'random', moveSeed: undefined } });
    const frame = await hu.move();
    h.socket.deliver(frame);
    h.socket.deliver(frame);
    h.socket.deliver({ type: 'OPPONENT_KEY', gameId: 'g1', publicKey: HUMAN_PK });
    await tick(3_000);
    expect(h.sent('MOVE')).toHaveLength(1);
    expect(h.proved).toHaveLength(1);
    h.bot.stop();
  });
});

describe('ArenaBot game end', () => {
  it('reports its own result once the ninth move checks out — and a loss frees it at once', async () => {
    const { h, hu } = await begun({}, { strategy: OUTCOMES.loss });
    await h.playTo(hu);
    await tick(50);
    const stats = h.bot.getStats();
    expect(stats).toMatchObject({ gamesPlayed: 1, losses: 1, wins: 0, draws: 0 });
    expect(['idle', 'queued']).toContain(stats.state);
    expect(h.j.store.get('g1')!.outcome).toBe('loss');
    // The winner settles a loss; the bot waits for their settlement.
    expect(h.f.called('settle')).toHaveLength(0);
    expect(h.bot.isTracking('g1'), 'the winner\'s SETTLED is still due').toBe(true);
    h.bot.stop();
  });

  it('a win is its own to settle', async () => {
    const { h, hu } = await begun({}, { strategy: OUTCOMES.win });
    await h.playTo(hu);
    await tick(50);
    expect(h.bot.getStats()).toMatchObject({ gamesPlayed: 1, wins: 1 });
    expect(h.j.store.get('g1')!.outcome).toBe('win');
    await vi.waitFor(() => expect(h.f.called('settle')).toHaveLength(1), { timeout: 20_000, interval: 50 });
    h.bot.stop();
  });
});

describe('ArenaBot resumes its seat after a dropped socket', () => {
  /** Drop the socket and come back: RESUME, then the relay's answer. */
  async function reconnect(h: ReturnType<typeof fakeBot>, answer: Record<string, unknown>) {
    const before = h.sockets.length;
    h.socket.close();
    await tick(1_100);
    expect(h.sockets.length, 'it reconnects').toBe(before + 1);
    h.socket.emit('open');
    expect(h.socket.sent[0], 'RESUME is the first frame').toEqual({ type: 'RESUME', sessionToken: 'session-1' });
    h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'bot', sessionToken: 'session-1', ...answer });
    h.socket.deliver({ type: 'BOT_REGISTERED' });
  }

  it('keeps its game through a dropped socket, and resumes the same session', async () => {
    const { h } = await begun();
    await reconnect(h, { resumed: true, gameId: 'g1' });
    expect(h.socket.lastOfType('REGISTER_BOT'), 'registration is per connection').toBeDefined();
    expect(h.bot.getStats().state).toBe('playing');
    expect(h.bot.getStats().abandonedGames).toBe(0);
    h.bot.stop();
  });

  it('sends again exactly the moves the relay never got', async () => {
    const { h, hu } = await begun();
    h.socket.deliver(await hu.move());
    // The socket drops before our reply is out: the reply is proven, journalled — and lost.
    h.socket.close();
    await tick(50);
    expect(h.j.store.get('g1')!.moves, 'in the transcript all the same').toHaveLength(2);
    await reconnect(h, { resumed: true, gameId: 'g1' });
    h.socket.deliver({ type: 'ROOM_STATE', gameId: 'g1', playerNumber: 2, movesMade: 1, opponentConnected: true });
    await tick(50);
    const resent = h.socket.ofType('MOVE');
    expect(resent.map(m => m.moveNumber)).toEqual([1]);
    await hu.receive(resent[0]);
    // And everything else the other side may have missed, each idempotent there.
    expect(h.socket.lastOfType('TX_CONFIRMED')).toEqual({ type: 'TX_CONFIRMED', gameId: 'g1', txType: 'join_game' });
    expect(h.socket.ofType('PEER').map(m => h.k.open(m).kind)).toEqual(['RECORD', 'OPEN_CARDS']);
    h.bot.stop();
  });

  it('sends nothing again that the relay already holds', async () => {
    const { h, hu } = await begun();
    await h.playTo(hu, 2);
    await reconnect(h, { resumed: true, gameId: 'g1' });
    h.socket.deliver({ type: 'ROOM_STATE', gameId: 'g1', playerNumber: 2, movesMade: 2, opponentConnected: true });
    await tick(50);
    expect(h.socket.ofType('MOVE')).toHaveLength(0);
    h.bot.stop();
  });

  it('checks the moves the relay replays, and plays on', async () => {
    const { h, hu } = await begun();
    await h.playTo(hu, 2);
    await reconnect(h, { resumed: true, gameId: 'g1' });
    // Buffered while we were away: a stale copy of move 0 and the new move 2.
    const m0 = hu.moves[0];
    h.socket.deliver(await hu.frame(0, {
      cardId: m0.cardId, slot: m0.slot, row: m0.row, col: m0.col, proof: m0.proof.proof, publicInputs: m0.proof.publicInputs,
    }));
    h.socket.deliver(await hu.move());
    h.socket.deliver({ type: 'ROOM_STATE', gameId: 'g1', playerNumber: 2, movesMade: 3, opponentConnected: true });
    await hu.receive(await h.botMove(3));
    expect(h.bot.getStats().opponentFaults).toBe(0);
    h.bot.stop();
  });

  it('sends its key again when the creator\'s record never came — they may never have had it', async () => {
    const h = fakeBot();
    await h.ready();
    h.match();
    await tick(50);
    await reconnect(h, { resumed: true, gameId: 'g1' });
    h.socket.deliver({ type: 'ROOM_STATE', gameId: 'g1', playerNumber: 2, movesMade: 0, opponentConnected: true });
    await tick(10);
    expect(h.socket.lastOfType('KEY_EXCHANGE')).toEqual({ type: 'KEY_EXCHANGE', gameId: 'g1', publicKey: 'Ym90LXB1Yg==' });
    h.bot.stop();
  });

  it('starts the departure countdown when the opponent is not there either', async () => {
    let clock = 1_000_000;
    const { h } = await begun({ now: () => clock });
    await reconnect(h, { resumed: true, gameId: 'g1' });
    h.socket.deliver({ type: 'ROOM_STATE', gameId: 'g1', playerNumber: 2, movesMade: 0, opponentConnected: false });
    clock += 20_000;
    await tick(10);
    expect(h.bot.getStats().game!.opponentGoneFor).toBe(20);
    h.bot.stop();
  });

  it('gives the game up when the relay could not resume the session — its seat is gone', async () => {
    const { h } = await begun();
    await reconnect(h, { resumed: false, gameId: null, sessionToken: 'session-2' });
    expect(h.bot.getStats().abandonedGames).toBe(1);
    expect(h.bot.getStats().cardsStranded).toBe(5);
    expect(['idle', 'queued']).toContain(h.bot.getStats().state);
    h.bot.stop();
  });

  it('leaves a game it walked out of while disconnected, so the relay stops holding it there', async () => {
    let clock = 1_000_000;
    const { h } = await begun({ cfg: { gameTimeoutMs: 60_000 }, now: () => clock });
    h.socket.close();
    clock += 61_000;
    await tick(1_100);
    expect(h.bot.getStats().abandonedGames, 'the watchdog runs while the relay is away').toBe(1);
    h.socket.emit('open');
    h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'bot', sessionToken: 'session-1', resumed: true, gameId: 'g1' });
    expect(h.socket.lastOfType('LEAVE_GAME')).toEqual({ type: 'LEAVE_GAME', gameId: 'g1' });
    h.bot.stop();
  });

  it('goes back to idle if the socket drops while it is only queued', async () => {
    const h = harness();
    await h.ready();
    h.setQueue({ length: 1, oldestWaitMs: 25_000 });
    await tick(1_000);
    expect(h.bot.getStats().state).toBe('queued');
    h.socket.close();
    expect(h.bot.getStats().state).toBe('idle');
    h.bot.stop();
  });
});

describe('ArenaBot journals committed games', () => {
  it('journals the game BEFORE the join is sent — a crash mid-join must leave a record', async () => {
    let atSend: any = null;
    const h = fakeBot({
      pxe: {
        sendJoinGame: async () => { atSend = JSON.parse(JSON.stringify(h.j.store.get('g1') ?? null)); return F(1); },
      },
    });
    await h.ready();
    h.match();
    h.handshake('g1');
    await tick(50);
    expect(atSend, 'written before the join tx').not.toBeNull();
    expect(atSend.phase).toBe('joining');
    expect(atSend).toMatchObject({ gameKey: GAME_KEY, nonce: NONCE, record1: RECORD1, record2: RECORD2, cardIds: BOT_HAND });
    expect(h.j.store.get('g1')!.phase, 'and marked joined once it lands').toBe('joined');
    h.bot.stop();
  });

  it('keeps what recovery needs — and of the human only what the game showed', async () => {
    const { h, hu } = await begun({}, { strategy: OUTCOMES.loss });
    await h.playTo(hu, 4);
    await tick(50);
    const rec = h.j.store.get('g1')!;
    expect(Object.keys(rec).sort()).toEqual([
      'cardIds', 'committedAt', 'gameKey', 'keyPair', 'moveProofs', 'moves', 'nonce', 'opponentOpenCards',
      'opponentPublicKey', 'outcome', 'ownOpenCards', 'phase', 'prizeMove', 'protocolError', 'record1', 'record2',
      'relayGameId', 'updatedAt', 'version',
    ]);
    expect(rec.keyPair.privateJwk, 'our private key: a restarted bot can still open the channel').toBeTruthy();
    expect(rec.opponentPublicKey).toBe(HUMAN_PK);
    expect(rec.cardIds, 'OUR hand').toEqual(BOT_HAND);
    expect(rec.ownOpenCards!.cards).toEqual(BOT_HAND.slice(0, 3));
    // Theirs: the three open cards and the two cards they have placed (slots 0
    // and 1) — never the hidden cards still in their hand.
    expect(rec.opponentOpenCards).toEqual([1, 180, 247]);
    const hidden = [HUMAN_HAND[3], HUMAN_HAND[4]];
    const theirs = rec.moves!.filter(m => m.moveNumber % 2 === 0);
    expect(theirs.map(m => m.cardId)).toEqual([1, 180]);
    for (const p of rec.moveProofs) expect(hidden).not.toContain(Number(BigInt(p.publicInputs[6])));
    expect(JSON.stringify(rec)).not.toMatch(/address|randomness|blinding/i);
    h.bot.stop();
  });

  it('grows the transcript as moves are checked — both sides, each with its proof, in order', async () => {
    const { h, hu } = await begun();
    await h.playTo(hu, 4);
    await tick(50);
    const rec = h.j.store.get('g1')!;
    expect(rec.moves!.map(m => m.moveNumber)).toEqual([0, 1, 2, 3]);
    expect(rec.moveProofs).toHaveLength(4);
    rec.moves!.forEach((m, i) => {
      expect(rec.moveProofs[i].placedCardId).toBe(m.cardId);
      expect(rec.moveProofs[i].placedSlot).toBe(m.slot);
    });
    // Each proof chains on the one before.
    for (let i = 1; i < 4; i++) expect(rec.moveProofs[i].startStateHash).toBe(rec.moveProofs[i - 1].endStateHash);
    h.bot.stop();
  });

  it('does NOT forget a game whose settlement FAILED — the cards are still locked', async () => {
    const { h, hu } = await begun(
      { pxe: { sendSettleGame: async () => { throw new Error('Assertion failed: transcript'); } } },
      { strategy: OUTCOMES.win },
    );
    await h.playTo(hu);
    await vi.waitFor(() => expect(h.bot.getStats().settleFailures).toBe(1), { timeout: 20_000, interval: 50 });
    expect(h.bot.getStats().settlements).toBe(0);
    expect(h.j.forgotten).toEqual([]);
    expect(h.j.resolved).toEqual([]);
    h.bot.stop();
  });
});

describe('ArenaBot does not take the opponent\'s word for a settlement', () => {
  it('settles its win anyway when a SETTLED is not borne out on-chain', async () => {
    const { h, hu } = await begun({}, { strategy: OUTCOMES.win });
    await h.playTo(hu, 8);
    // "I settled" — but no settlement exists. Standing down on the word alone
    // would leave a won game unsettled until the sweep came round.
    h.peer('g1', { kind: 'SETTLED', txHash: F(0xdead) });
    await tick(10);
    h.socket.deliver(await hu.move());
    await tick(10);
    expect(h.f.called('settle'), 'it looks at the chain first').toHaveLength(0);

    await tick(130_000);
    expect(h.logs.join('\n')).toMatch(/chain shows no settlement/);
    // The rest crosses lazy SDK imports, which are real I/O: poll in real time.
    await vi.waitFor(() => expect(h.j.resolved).toEqual([['g1', 'settled', F(0x5e77)]]), { timeout: 20_000, interval: 50 });
    expect(h.f.called('settle')).toHaveLength(1);
    expect(h.bot.getStats().settlements).toBe(1);
    h.bot.stop();
  });
});

describe('ArenaBot stuck-game watchdog', () => {
  it('abandons a stuck game and reports the cards left committed', async () => {
    let clock = 1_000_000;
    const { h } = await begun({ cfg: { pollIntervalMs: 50, gameTimeoutMs: 10_000 }, now: () => clock });
    expect(h.bot.getStats().state).toBe('playing');

    clock += 11_000;
    await tick(200);
    // Back in service: idle, or already re-queued for the next waiting player.
    expect(['idle', 'queued']).toContain(h.bot.getStats().state);
    expect(h.bot.getStats().abandonedGames).toBe(1);
    // The bot only JOINS, so it cannot cancel; the sweep unwinds the game.
    expect(h.bot.getStats().cardsStranded).toBe(5);
    expect(h.socket.lastOfType('LEAVE_GAME')).toMatchObject({ gameId: 'g1' });
    h.bot.stop();
  });

  it('strands nothing when it gives up before committing', async () => {
    let clock = 1_000_000;
    const h = fakeBot({ cfg: { pollIntervalMs: 50, gameTimeoutMs: 10_000 }, now: () => clock, queue: { length: 0, oldestWaitMs: 0, entries: [] } });
    await h.ready();
    h.match();
    await tick(100);
    clock += 11_000;
    await tick(200);
    expect(h.bot.getStats().abandonedGames).toBe(1);
    expect(h.bot.getStats().cardsStranded).toBe(0);
    h.bot.stop();
  });
});

/**
 * What the bot is doing RIGHT NOW — and nothing that would let a reader of
 * /health find the game on-chain.
 */
describe('ArenaBot live state', () => {
  it('reports no game when idle, rather than a stale one', async () => {
    const h = harness();
    await h.ready();
    expect(h.bot.getStats().game).toBeNull();
    h.bot.stop();
  });

  it('shows the live game: keyed, committed, how far it got, and whose turn it is', async () => {
    let releaseProof: () => void = () => {};
    const { h, hu } = await begun({
      proofs: { proveMove: (a: MoveProofArgs) => new Promise(r => { releaseProof = () => r(proveLike(a)); }) },
    });
    let g = h.bot.getStats().game!;
    expect(g).toMatchObject({ relayGameId: 'g1', playerNumber: 2, keyed: true, opponentRecord: true, committed: true, moveProofs: 0, oweAMove: false });
    expect(g.opponentGoneFor).toBeNull();
    h.socket.deliver(await hu.move());
    await tick(50);
    g = h.bot.getStats().game!;
    expect(g).toMatchObject({ moveProofs: 1, oweAMove: true });
    releaseProof();
    await h.botMove(1);
    expect(h.bot.getStats().game).toMatchObject({ moveProofs: 2, oweAMove: false });
    h.bot.stop();
  });

  it('counts how long the opponent has been gone', async () => {
    let clock = 1_000_000;
    const { h } = await begun({ now: () => clock });
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    clock += 30_000;
    await tick(50);
    expect(h.bot.getStats().game!.opponentGoneFor).toBe(30);
    h.bot.stop();
  });

  it('exposes no game key, record, nullifier or tx hash', async () => {
    const { h } = await begun();
    h.socket.deliver({ type: 'ERROR', message: `Existing nullifier ${NULLIFIERS[3]} for game ${GAME_KEY}` });
    const text = JSON.stringify(h.bot.getStats());
    for (const secret of [GAME_KEY, ...RECORD1, ...RECORD2, ...NULLIFIERS, F(0x10a)]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(secret.slice(2, 40));
    }
    expect(h.bot.getStats().lastError).toMatch(/Existing nullifier 0x0000…/);
    h.bot.stop();
  });

  it('redacts long hex from error text', () => {
    expect(redactForHealth(`bad ${F(0xabc)} and 0x1234`)).toBe('bad 0x0000… and 0x1234');
  });

  it('keeps every number out of a refusal\'s reason — card, slot, cell and field alike', () => {
    expect(withoutCardDetails('slot 0 holds open card 247, but the move plays card 12'))
      .toBe('slot # holds open card #, but the move plays card #');
    expect(withoutCardDetails(`not a field element: ${F(0xabc)}`)).toBe('not a field element: #');
  });
});

describe('ArenaBot worklist', () => {
  const withJournal = (recs: any[], now = 2_000_000_000) => new ArenaBot(makeConfig(), {
    connect: () => new FakeSocket() as unknown as any,
    fetchQueue: async () => ({ length: 0, oldestWaitMs: 0, entries: [] }),
    journal: { outstanding: () => recs, read: () => null, write: () => {}, forget: () => {}, markResolved: () => {} },
    log: () => {}, now: () => now,
  });
  const base = { relayGameId: 'g1', phase: 'joined', moveProofs: [1, 2, 3, 4], outcome: null, committedAt: 2_000_000_000 - 7_200_000 };

  it('says WHY each outstanding game is not moving', () => {
    const j = withJournal([
      { ...base, relayGameId: 'young', committedAt: 2_000_000_000 - 60_000 },
      { ...base, relayGameId: 'joining', phase: 'joining' },
      { ...base, relayGameId: 'ready' },
    ]).getStats().journal;
    expect(j.find(e => e.relayGameId === 'young')!.blockedBy).toMatch(/too young/);
    expect(j.find(e => e.relayGameId === 'joining')!.blockedBy).toMatch(/join not confirmed/);
    expect(j.find(e => e.relayGameId === 'ready')!.blockedBy).toBeNull();
    expect(j.find(e => e.relayGameId === 'ready')!.moveProofs).toBe(4);
  });

  it('says the dispute window is running, not that nothing is blocking it', () => {
    const [entry] = withJournal([{ ...base, claimedAt: 2_000_000_000 / 1000 - 120 }]).getStats().journal;
    expect(entry.blockedBy).toMatch(/dispute window, ~\d+min left/);
  });

  it('says only that the window has passed — not that a finalize is under way', () => {
    const [entry] = withJournal([{ ...base, claimedAt: 2_000_000_000 / 1000 - 900 }]).getStats().journal;
    expect(entry.blockedBy).toBe('claimed — dispute window passed');
  });
});

describe('ArenaBot opponent disconnect', () => {
  const mk = async (over: Partial<ArenaBotConfig> = {}, human: { strategy?: typeof OUTCOMES.draw } = {}) => {
    const clock = { t: 1_000_000 };
    const r = await begun({ cfg: { pollIntervalMs: 50, ...over }, now: () => clock.t }, human);
    return { ...r, clock };
  };

  it('holds the game open while the opponent might still reconnect', async () => {
    const { h, clock } = await mk({ opponentGraceMs: 90_000 });
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    clock.t += 60_000;
    await tick(200);
    expect(h.bot.getStats().state).toBe('playing');
    expect(h.bot.getStats().abandonedGames).toBe(0);
    h.bot.stop();
  });

  it('gives up once the window has passed, not thirty minutes later', async () => {
    const { h, clock } = await mk({ opponentGraceMs: 90_000 });
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    clock.t += 91_000;
    await tick(200);
    expect(['idle', 'queued']).toContain(h.bot.getStats().state);
    expect(h.bot.getStats().abandonedGames).toBe(1);
    expect(h.bot.getStats().cardsStranded).toBe(5);
    h.bot.stop();
  });

  it('gives up on time even when the board is waiting on us — a claim has no turn rule now', async () => {
    const clock = { t: 1_000_000 };
    const { h, hu } = await begun({
      cfg: { pollIntervalMs: 50, opponentGraceMs: 90_000 }, now: () => clock.t,
      // Our reply is still proving: the board waits on us.
      proofs: { proveMove: () => new Promise(() => {}) },
    });
    h.socket.deliver(await hu.move());
    await tick(50);
    expect(h.bot.getStats().game!.oweAMove).toBe(true);
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    clock.t += 91_000;
    await tick(200);
    expect(h.bot.getStats().abandonedGames).toBe(1);
    h.bot.stop();
  });

  it('ignores a departure from a game it is not in', async () => {
    const { h, clock } = await mk({ opponentGraceMs: 90_000 });
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'another-room' });
    clock.t += 91_000;
    await tick(200);
    expect(h.bot.getStats().abandonedGames).toBe(0);
    h.bot.stop();
  });

  it('a reconnecting opponent cancels the countdown', async () => {
    const { h, clock } = await mk({ opponentGraceMs: 90_000 });
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    clock.t += 60_000;
    await tick(100);
    h.socket.deliver({ type: 'OPPONENT_RECONNECTED', gameId: 'g1' });
    clock.t += 120_000;
    await tick(200);
    expect(h.bot.getStats().state).toBe('playing');
    expect(h.bot.getStats().abandonedGames).toBe(0);
    h.bot.stop();
  });

  it('does not walk out on a game it is in the middle of settling', async () => {
    // The loser closing their tab the moment the result appears is ORDINARY.
    const { h, hu, clock } = await mk({ opponentGraceMs: 90_000, drawFallbackMs: 600_000 }, { strategy: OUTCOMES.draw });
    await h.playTo(hu);
    await tick(50);
    expect(h.bot.getStats().draws).toBe(1);
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    clock.t += 200_000;
    await tick(200);
    expect(h.bot.getStats().abandonedGames).toBe(0);
    h.bot.stop();
  });

  it('does not walk out when the tab closed right after the last move', async () => {
    const { h, hu, clock } = await mk({ opponentGraceMs: 90_000, drawFallbackMs: 600_000 }, { strategy: OUTCOMES.draw });
    await h.playTo(hu, 8);
    h.socket.deliver(await hu.move());
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    await tick(50);
    clock.t += 200_000;
    await tick(200);
    expect(h.bot.getStats().abandonedGames).toBe(0);
    expect(h.bot.getStats().draws).toBe(1);
    h.bot.stop();
  });

  it('tells the relay it has left, so it can queue again', async () => {
    const { h, clock } = await mk({ opponentGraceMs: 90_000 });
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    clock.t += 91_000;
    await tick(200);
    const left: any = h.socket.lastOfType('LEAVE_GAME');
    expect(left, 'the relay must be told, or we stay bound to a game we left').toBeDefined();
    expect(left.gameId).toBe('g1');
    h.bot.stop();
  });

  it('defaults to just over the relay\'s 60s reconnection window', async () => {
    const { configFromEnv } = await import('../src/config.js');
    expect(configFromEnv({ ARENA_BOT_TOKEN: 't' } as NodeJS.ProcessEnv).opponentGraceMs).toBe(90_000);
  });
});

describe('ArenaBot shutdown', () => {
  it('lets a move proof that is still generating finish — and sends it — before it goes', async () => {
    let release: () => void = () => {};
    const { h, hu } = await begun({
      proofs: { proveMove: (a: MoveProofArgs) => new Promise(r => { release = () => r(proveLike(a)); }) },
    });
    h.socket.deliver(await hu.move());
    await tick(50);

    let done = false;
    const leaving = h.bot.shutdown(60_000).then(() => { done = true; });
    await tick(1_000);
    expect(done, 'still waiting on the proof').toBe(false);
    release();
    await tick(500);
    await leaving;
    expect(h.sent('MOVE')).toHaveLength(1);
  });

  it('shuts down immediately when nothing is proving', async () => {
    const { h } = await begun();
    const done = h.bot.shutdown(60_000);
    await tick(20);
    await done;
  });
});

describe('ArenaBot join-only policy', () => {
  it('defaults to a 30s wait before offering itself', async () => {
    const { configFromEnv } = await import('../src/config.js');
    const cfg = configFromEnv({ ARENA_BOT_TOKEN: 't' } as NodeJS.ProcessEnv);
    expect(cfg.joinThresholdMs).toBe(30_000);
  });

  it('does not offer a game at 29s, but does at 30s', async () => {
    const h = harness({ joinThresholdMs: 30_000 });
    await h.ready();
    h.setQueue({ length: 1, oldestWaitMs: 29_000 });
    await tick(3_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);

    h.setQueue({ length: 1, oldestWaitMs: 30_000 });
    await tick(3_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(1);
    h.bot.stop();
  });
});

describe('ArenaBot card shortage', () => {
  it('logs a persistent shortage once, but counts every occurrence', async () => {
    const h = fakeBot({
      cfg: { pollIntervalMs: 50 },
      chain: { selectHand: async () => { throw new Error('holds only 2 card(s)'); } },
    });
    await h.ready();
    await tick(1_000);
    expect(h.logs.filter(l => l.includes('select-hand'))).toHaveLength(1);
    expect(h.bot.getStats().joinFailures).toBeGreaterThan(1);
    expect(h.bot.getStats().lastError).toMatch(/holds only 2/);
    h.bot.stop();
  });
});

describe('ArenaBot queue race', () => {
  it('does not re-queue when a match lands during the /queue fetch', async () => {
    const socket = new FakeSocket();
    let releaseFetch: (v: QueueSnapshot) => void = () => {};
    const bot = new ArenaBot(makeConfig({ pollIntervalMs: 50 }), {
      connect: () => socket as unknown as any,
      fetchQueue: () => new Promise<QueueSnapshot>(r => { releaseFetch = r; }),
      chain: fakeChain().chain as never,
      proofs: fakeProofs().proofs,
      keys: fakeKeys().keys,
      log: () => {}, now: () => 1_000_000,
    });
    bot.start();
    socket.emit('open');
    socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't', resumed: false, gameId: null });
    socket.deliver({ type: 'BOT_REGISTERED' });
    await tick(100);

    // Match arrives while the queue fetch is still in flight.
    socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2 });
    releaseFetch({ length: 1, oldestWaitMs: 30_000, entries: [] });
    await tick(100);

    // Queueing now would be rejected "already in an active game", and the ERROR
    // path would then reset us out of a game we are actually playing.
    expect(socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    expect(bot.getStats().state).toBe('playing');
    bot.stop();
  });
});

describe('ArenaBot pool behaviour', () => {
  it('does not offer when another bot is already covering the waiting player', async () => {
    const h = harness();
    await h.ready();
    h.setQueue({ length: 2, oldestWaitMs: 60_000, humansWaiting: 1, botsQueued: 1 });
    await tick(3_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    h.bot.stop();
  });

  it('offers when there are more waiting humans than bots', async () => {
    const h = harness();
    await h.ready();
    h.setQueue({ length: 3, oldestWaitMs: 60_000, humansWaiting: 2, botsQueued: 1 });
    await tick(3_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(1);
    h.bot.stop();
  });

  it('offers against an older relay that reports no bot counts', async () => {
    const h = harness();
    await h.ready();
    h.setQueue({ length: 1, oldestWaitMs: 60_000 });
    await tick(3_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(1);
    h.bot.stop();
  });
});

describe('per-game skill', () => {
  // Real timers: this drives the bot through actual awaits.
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useFakeTimers());

  /**
   * A fixed-strength opponent is either always beatable or never worth
   * beating. Skill is drawn once per game so a player meets a spread — and
   * once per GAME, not per move, because a bot that alternates between
   * brilliant and careless inside one game reads as broken.
   */
  async function matchOnce(over: Partial<ArenaBotConfig>, gameId: string): Promise<number | null> {
    const socket = new FakeSocket();
    const logs: string[] = [];
    const bot = new ArenaBot(makeConfig({ pollIntervalMs: 20, ...over }), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: fakeChain().chain as never,
      proofs: fakeProofs().proofs,
      keys: fakeKeys().keys,
      log: (m: string) => logs.push(m), now: () => Date.now(),
    });
    bot.start();
    socket.emit('open');
    socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't', resumed: false, gameId: null });
    socket.deliver({ type: 'BOT_REGISTERED' });
    await new Promise(r => setTimeout(r, 60));
    socket.deliver({ type: 'MATCH_FOUND', gameId, playerNumber: 2 });
    await new Promise(r => setTimeout(r, 30));
    bot.stop();
    const line = logs.find(l => /skill \d\.\d+/.test(l));
    const m = line?.match(/skill (\d\.\d+)/);
    return m ? Number(m[1]) : null;
  }

  it('draws a different skill for each game', async () => {
    const skills: number[] = [];
    for (let i = 0; i < 12; i++) {
      const s = await matchOnce({ skillMin: 0, skillMax: 1 }, `g${i}`);
      if (s !== null) skills.push(s);
    }
    expect(skills.length, 'a skill is drawn and logged per match').toBeGreaterThanOrEqual(10);
    expect(new Set(skills).size, 'and it is not the same every game').toBeGreaterThan(1);
    for (const s of skills) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  }, 30_000);

  it('respects a narrowed range, so the economy can be tuned', async () => {
    for (let i = 0; i < 8; i++) {
      const s = await matchOnce({ skillMin: 0.8, skillMax: 1 }, `n${i}`);
      if (s !== null) expect(s).toBeGreaterThanOrEqual(0.8);
    }
  }, 30_000);
});
