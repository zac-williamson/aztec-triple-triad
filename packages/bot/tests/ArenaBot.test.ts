import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ArenaBot, redactForHealth, type QueueSnapshot } from '../src/ArenaBot.js';
import type { ArenaBotConfig } from '../src/config.js';
import { createGame, getCardsByIds, placeCard } from '@axolotl-arena/game-logic';
import type { GameState } from '@axolotl-arena/game-logic';
import {
  BOT_HAND, F, FakeSocket, GAME_KEY, HUMAN_HAND, HUMAN_PK, N, NONCE, NULLIFIERS, RECORD1, RECORD2, SECRETS,
  chainBot, fakeMoveProof, makeConfig, transcript,
} from './fakes.js';

// settle_game's argument list is the frontend's to build (and to test); here a
// settlement only has to be sent. ArenaBot.settlement.test.ts runs the real one.
vi.mock('../../frontend/src/aztec/settlementArgs.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  buildSettleGameArgs: vi.fn(async () => ['settle-args']),
}));

const CARDS = [1, 2, 3, 4, 5];

/** Player 1 is the human, player 2 the bot — the bot only ever joins. */
function freshState(): GameState {
  return createGame(getCardsByIds(HUMAN_HAND), getCardsByIds(BOT_HAND));
}

/** A state where it is PLAYER 2's turn: the human has opened. */
function botTurnState(): GameState {
  return placeCard(freshState(), 'player1', 0, 0, 0).newState;
}

/** Build a bot wired to a fake socket and a settable queue snapshot (off-chain). */
function harness(cfg = makeConfig()) {
  const socket = new FakeSocket();
  let queue: QueueSnapshot = { length: 0, oldestWaitMs: 0, entries: [] };
  let clock = 1_000_000;
  const bot = new ArenaBot(cfg, {
    connect: () => socket as unknown as any,
    fetchQueue: async () => queue,
    log: () => {},
    now: () => clock,
  });
  return {
    bot, socket,
    setQueue: (q: Partial<QueueSnapshot>) => { queue = { length: 1, oldestWaitMs: 0, entries: [], ...q }; },
    advance: (ms: number) => { clock += ms; },
    /** start + open + register, the normal steady state. */
    async ready() {
      bot.start();
      socket.emit('open');
      socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'bot', sessionToken: 't' });
      socket.deliver({ type: 'BOT_REGISTERED' });
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const fakeChainBot = (opts: Omit<Parameters<typeof chainBot>[0], 'wait'> = {}) => chainBot({ ...opts, wait: tick });
const match = (socket: FakeSocket, gameId = 'g1', gameState = freshState()) =>
  socket.deliver({ type: 'MATCH_FOUND', gameId, playerNumber: 2, gameState, opponentIsBot: false });

/** A chain bot matched, keyed, and joined: cards committed, both records known. */
async function joinedBot(opts: Omit<Parameters<typeof chainBot>[0], 'wait'> = {}, gameState = freshState()) {
  const h = fakeChainBot(opts);
  await h.ready();
  match(h.socket, 'g1', gameState);
  h.handshake('g1');
  await tick(50);
  expect(h.f.called('join'), 'the bot should have joined').toHaveLength(1);
  return h;
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
    h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'bot', sessionToken: 't' });
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

  it('offers a game once someone has waited past the threshold', async () => {
    const h = harness();
    await h.ready();
    h.setQueue({ length: 1, oldestWaitMs: 20_000 });
    await tick(1_000);
    expect(h.socket.lastOfType('QUEUE_MATCHMAKING')).toMatchObject({ cardIds: CARDS });
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
    const h = harness(makeConfig({ queueTimeoutMs: 10_000 }));
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
    match(h.socket);
    h.setQueue({ length: 1, oldestWaitMs: 60_000 });
    await tick(5_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    expect(h.bot.getStats().state).toBe('playing');
    h.bot.stop();
  });
});

describe('ArenaBot play', () => {
  it('plays a legal move when it is its turn', async () => {
    const h = harness();
    await h.ready();
    match(h.socket, 'g1', botTurnState());
    await tick(10);

    const placed = h.socket.lastOfType('PLACE_CARD');
    expect(placed).toBeTruthy();
    expect(placed.gameId).toBe('g1');
    // botTurnState already has player 1's opening card, so ours is move 1.
    expect(placed.moveNumber).toBe(1);
    expect(placed.handIndex).toBeGreaterThanOrEqual(0);
    expect(placed.handIndex).toBeLessThan(5);
    expect(placed.row).toBeGreaterThanOrEqual(0);
    expect(placed.col).toBeLessThan(3);
    h.bot.stop();
  });

  it('stays silent when it is the opponent\'s turn', async () => {
    const h = harness();
    await h.ready();
    match(h.socket);
    await tick(10);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(0);
    h.bot.stop();
  });

  it('ignores state for a game it is not in', async () => {
    const h = harness();
    await h.ready();
    match(h.socket);
    await tick(10);
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'OTHER', gameState: botTurnState() });
    await tick(10);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(0);
    h.bot.stop();
  });

  it('does not send a move that the game outran during the pacing delay', async () => {
    const h = harness(makeConfig({ moveDelayMs: 5_000 }));
    await h.ready();
    match(h.socket);
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player2', gameState: freshState() });
    await tick(6_000);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(0);
    h.bot.stop();
  });

  it('off-chain, there is no key exchange — nothing on-chain to key', async () => {
    const h = harness();
    await h.ready();
    match(h.socket);
    await tick(10);
    expect(h.socket.countOfType('KEY_EXCHANGE')).toBe(0);
    h.bot.stop();
  });
});

describe('ArenaBot outcome accounting', () => {
  // The bot only ever JOINS, so it is always player 2.
  const outcomes: [string, 'player1' | 'player2' | 'draw', keyof ReturnType<ArenaBot['getStats']>][] = [
    ['win', 'player2', 'wins'],
    ['loss', 'player1', 'losses'],
    ['draw', 'draw', 'draws'],
  ];

  for (const [label, winner, field] of outcomes) {
    it(`records a ${label}`, async () => {
      const h = harness();
      await h.ready();
      match(h.socket);
      h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner, gameState: freshState() });
      const stats = h.bot.getStats();
      expect(stats.gamesPlayed).toBe(1);
      expect(stats[field]).toBe(1);
      expect(stats.state).toBe('idle');
      h.bot.stop();
    });
  }

  it('resets to idle and counts a join failure when the server rejects the queue', async () => {
    const h = harness();
    await h.ready();
    h.setQueue({ length: 1, oldestWaitMs: 25_000 });
    await tick(1_000);
    expect(h.bot.getStats().state).toBe('queued');

    h.socket.deliver({ type: 'ERROR', message: 'You are already in the matchmaking queue' });
    const stats = h.bot.getStats();
    expect(stats.state).toBe('idle');
    expect(stats.joinFailures).toBe(1);
    expect(stats.lastError).toContain('already in the matchmaking queue');
    h.bot.stop();
  });

  it('does not wedge in playing when the socket drops mid-game', async () => {
    const h = harness();
    await h.ready();
    match(h.socket);
    expect(h.bot.getStats().state).toBe('playing');
    h.socket.close();
    expect(h.bot.getStats().state).toBe('idle');
    h.bot.stop();
  });
});

describe('ArenaBot chain mode: hand and seat', () => {
  it('wagers cards it actually holds, not a static configured hand', async () => {
    const h = fakeChainBot();
    await h.ready();
    // makeConfig's handCardIds are [1..5]; the chain says it holds [7..11].
    expect(h.socket.lastOfType('QUEUE_MATCHMAKING').cardIds).toEqual(BOT_HAND);
    h.bot.stop();
  });

  it('does not queue when it cannot field five cards', async () => {
    const h = fakeChainBot({ chain: { selectHand: async () => { throw new Error('holds only 3 card(s)'); } } });
    await h.ready();
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    expect(h.bot.getStats().state).toBe('idle');
    expect(h.bot.getStats().joinFailures).toBe(1);
    expect(h.bot.getStats().lastError).toMatch(/holds only 3/);
    h.bot.stop();
  });

  it('leaves immediately if the server ever assigns it the creator slot', async () => {
    const h = fakeChainBot();
    await h.ready();
    // The server orders every pair so a bot is never the creator. If that ever
    // failed, the bot must NOT quietly start creating games — creating wagers
    // five cards as player 1, which is exactly what we promised it never does.
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1, gameState: freshState(), opponentIsBot: false });
    await tick(50);
    expect(h.socket.lastOfType('CANCEL_GAME')).toMatchObject({ gameId: 'g1' });
    expect(h.bot.getStats().lastError).toMatch(/only joins/);
    expect(h.socket.countOfType('KEY_EXCHANGE')).toBe(0);
    h.bot.stop();
  });
});

describe('ArenaBot chain mode: key exchange and join', () => {
  it('sends a fresh public key for the game at MATCH_FOUND — and nothing else about itself', async () => {
    const h = fakeChainBot();
    await h.ready();
    match(h.socket);
    await tick(10);
    expect(h.socket.lastOfType('KEY_EXCHANGE')).toEqual({ type: 'KEY_EXCHANGE', gameId: 'g1', publicKey: 'Ym90LXB1Yg==' });
    // No address, no randomness, no on-chain id: those messages are gone.
    expect(h.socket.sent.map(m => m.type)).not.toContain('SHARE_AZTEC_INFO');
    h.bot.stop();
  });

  it('joins once the creator\'s record arrives and their game is on-chain', async () => {
    const h = await joinedBot();
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

  it('tells the relay the join landed without naming the tx, and sends its record to the creator', async () => {
    const h = await joinedBot();
    expect(h.socket.lastOfType('TX_CONFIRMED')).toEqual({ type: 'TX_CONFIRMED', gameId: 'g1', txType: 'join_game' });
    expect(h.sentPeers()).toEqual([{ kind: 'RECORD', record: RECORD2 }]);
    h.bot.stop();
  });

  it('does not join until the creator\'s game is on-chain', async () => {
    const h = fakeChainBot();
    h.f.state.hits.delete(N.created);
    await h.ready();
    match(h.socket);
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
    const h = fakeChainBot({ cfg: { createdWaitMs: 20_000 } });
    h.f.state.hits.delete(N.created);
    await h.ready();
    match(h.socket);
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
    const h = fakeChainBot({ proofs: { cardCommitHash: async () => F(0xbad) } });
    await h.ready();
    match(h.socket);
    h.handshake('g1');
    await tick(50);
    expect(h.f.called('join')).toHaveLength(0);
    expect(h.bot.getStats().lastError).toMatch(/does not commit to our own hand/);
    h.bot.stop();
  });

  it('joins once however often the record is repeated', async () => {
    const h = await joinedBot();
    h.peer('g1', { kind: 'RECORD', record: RECORD1 });
    h.peer('g1', { kind: 'RECORD', record: RECORD1 });
    await tick(50);
    expect(h.f.called('join')).toHaveLength(1);
    h.bot.stop();
  });

  it('keeps the first record and ignores a different second one', async () => {
    const h = await joinedBot();
    h.peer('g1', { kind: 'RECORD', record: RECORD2 });
    await tick(50);
    expect(h.f.called('join')).toHaveLength(1);
    expect(h.logs.join('\n')).toMatch(/second, different creator record/);
    h.bot.stop();
  });

  it('holds payloads that arrive before its own key is ready', async () => {
    let releaseKey: () => void = () => {};
    const h = fakeChainBot();
    const generate = (h.k.keys as any).generateGameKeyPair;
    (h.k.keys as any).generateGameKeyPair = () => new Promise(r => { releaseKey = () => r(generate()); });
    await h.ready();
    match(h.socket);
    h.handshake('g1');
    await tick(50);
    expect(h.f.called('join')).toHaveLength(0);

    releaseKey();
    await tick(50);
    expect(h.f.called('join')).toHaveLength(1);
    h.bot.stop();
  });

  it('drops a payload that does not open with this game\'s channel', async () => {
    const h = fakeChainBot();
    await h.ready();
    match(h.socket);
    h.socket.deliver({ type: 'OPPONENT_KEY', gameId: 'g1', publicKey: HUMAN_PK });
    // Sealed for another room: the associated data does not match.
    h.socket.deliver({ type: 'PEER', gameId: 'g1', ...h.k.seal('other-room', { kind: 'RECORD', record: RECORD1 }) });
    await tick(50);
    expect(h.f.called('join')).toHaveLength(0);
    expect(h.logs.join('\n')).toMatch(/does not open/);
    h.bot.stop();
  });

  it('ignores a second, different key from the opponent', async () => {
    const h = await joinedBot();
    h.socket.deliver({ type: 'OPPONENT_KEY', gameId: 'g1', publicKey: 'b3RoZXI=' });
    await tick(10);
    expect(h.logs.join('\n')).toMatch(/second, different key/);
    h.bot.stop();
  });

  it('leaves when the creator cancels before it joins', async () => {
    const h = fakeChainBot();
    await h.ready();
    match(h.socket);
    h.socket.deliver({ type: 'OPPONENT_KEY', gameId: 'g1', publicKey: HUMAN_PK });
    h.peer('g1', { kind: 'CANCELLED' });
    await tick(50);
    expect(h.socket.lastOfType('LEAVE_GAME')).toMatchObject({ gameId: 'g1' });
    expect(h.bot.getStats().abandonedGames).toBe(1);
    expect(h.bot.getStats().cardsStranded).toBe(0);
    h.bot.stop();
  });

  it('does not wait the whole game out for a record that never comes', async () => {
    const h = fakeChainBot({ cfg: { recordWaitMs: 60_000, pollIntervalMs: 1_000 } });
    await h.ready();
    match(h.socket);
    await tick(61_000);
    expect(h.bot.getStats().abandonedGames).toBe(1);
    expect(h.f.called('join')).toHaveLength(0);
    h.bot.stop();
  });
});

describe('ArenaBot chain mode: commit gate', () => {
  it('does not play before its own cards are committed on-chain', async () => {
    // A join that never resolves — the bot must simply not move.
    const h = fakeChainBot({ pxe: { sendJoinGame: () => new Promise(() => {}) } });
    await h.ready();
    match(h.socket, 'g1', botTurnState());
    h.handshake('g1');
    for (let i = 0; i < 5; i++) {
      h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
      await tick(100);
    }
    // Moving here would prove against a commitment that does not exist yet.
    expect(h.socket.countOfType('PLACE_CARD')).toBe(0);
    h.bot.stop();
  });

  it('plays once committed, even if its turn arrived DURING the commit', async () => {
    let releaseJoin: (v: string) => void = () => {};
    const h = fakeChainBot({ pxe: { sendJoinGame: () => new Promise<string>(r => { releaseJoin = r; }) } });
    await h.ready();
    match(h.socket, 'g1', botTurnState());
    h.handshake('g1');
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await tick(50);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(0);

    // The relay sends a new state only when somebody MOVES, so nothing further
    // will arrive. Committing must replay the last state or the bot deadlocks.
    releaseJoin(F(0x10a));
    await tick(50);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(1);
    h.bot.stop();
  });

  it('plays normally with no chain — off-chain mode is unaffected', async () => {
    const h = harness();
    await h.ready();
    match(h.socket, 'g1', botTurnState());
    await tick(50);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(1);
    h.bot.stop();
  });
});

describe('ArenaBot move proofs', () => {
  /** Take our turn, then echo exactly the board it produced. */
  async function moveAndEcho(h: Awaited<ReturnType<typeof joinedBot>>) {
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await tick(50);
    const placed = h.socket.lastOfType('PLACE_CARD');
    expect(placed, 'the bot should have taken its turn').toBeDefined();
    const before = botTurnState();
    const card = before.player2Hand[placed.handIndex];
    const after: any = botTurnState();
    after.board[placed.row][placed.col] = { card, owner: 'player2', originalOwner: 'player2' };
    after.currentTurn = 'player1';
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: after });
    await tick(50);
    return { placed, card, after };
  }

  it('proves against both records\' hand commitments, with its hand in committed order', async () => {
    const h = await joinedBot();
    const { card } = await moveAndEcho(h);
    expect(h.proved).toHaveLength(1);
    const args = h.proved[0];
    expect(args.cardCommit1).toBe(RECORD1[1]);
    expect(args.cardCommit2).toBe(RECORD2[1]);
    expect(args.hand).toEqual({ cardIds: BOT_HAND, blindingFactor: SECRETS.blinding });
    expect(args.cardId).toBe(card.id);
    expect(args.currentPlayer).toBe(2);

    const sent = h.socket.lastOfType('SUBMIT_MOVE_PROOF');
    expect(sent.moveProof.publicInputs).toHaveLength(8);
    // The placed card and its slot in our committed hand are public.
    expect(BigInt(sent.moveProof.publicInputs[6])).toBe(BigInt(card.id));
    expect(Number(BigInt(sent.moveProof.publicInputs[7]))).toBe(BOT_HAND.indexOf(card.id));
    // ...and kept: the journal is what a settlement is built from.
    expect(h.j.store.get('g1')!.moveProofs).toHaveLength(1);
    h.bot.stop();
  });

  it('will not prove against a LATER board than the one its move produced', async () => {
    const h = await joinedBot();
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await tick(50);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(1);

    // A board TWO moves past ours: by then our card may have been captured —
    // owner no longer us — and the circuit rejects it.
    const late: any = botTurnState();
    late.board[0][1] = { card: { id: 7 }, owner: 'player1', originalOwner: 'player2' };
    late.board[0][2] = { card: { id: 180 }, owner: 'player1', originalOwner: 'player1' };
    late.board[1][0] = { card: { id: 8 }, owner: 'player2', originalOwner: 'player2' };
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: late });
    await tick(50);
    expect(h.proved).toHaveLength(0);
    h.bot.stop();
  });

  it('keeps the opponent\'s relayed proofs, read from their public inputs', async () => {
    const h = await joinedBot();
    const [first] = transcript({ winnerId: 2 });
    h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: { ...first, startStateHash: 'lies' } });
    // A proof without the eight public inputs can never settle anything.
    h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: { proof: 'p', publicInputs: [] } });
    await tick(10);
    const kept = h.j.store.get('g1')!.moveProofs;
    expect(kept).toHaveLength(1);
    expect(kept[0].startStateHash).toBe(first.publicInputs[2]);
    h.bot.stop();
  });

  describe('the final move proof', () => {
    /**
     * The move that ENDS a game is proved after the relay has already announced
     * GAME_OVER. On a loss the bot has reset to idle by then — and that proof is
     * the WINNER's. Without it nobody can settle the game they won.
     */
    async function movingWhenTheGameEnds() {
      let release: (v: any) => void = () => {};
      const h = await joinedBot({
        proofs: { proveMove: (a: any) => new Promise(r => { release = () => r(fakeMoveProof(a)); }) },
      });
      h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
      await tick(50);
      const placed = h.socket.lastOfType('PLACE_CARD');
      const after: any = botTurnState();
      after.board[placed.row][placed.col] = { card: { id: BOT_HAND[0] }, owner: 'player2', originalOwner: 'player2' };
      h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: after });
      await tick(20);
      expect(h.socket.countOfType('SUBMIT_MOVE_PROOF'), 'still proving').toBe(0);
      return { h, after, finish: () => release(undefined) };
    }

    it('sends it — and journals it — even though the game ended while it was proving', async () => {
      const { h, after, finish } = await movingWhenTheGameEnds();
      h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player1', gameState: after });
      await tick(20);
      expect(h.bot.getStats().state, 'a loss resets us to idle').not.toBe('playing');

      finish();
      await tick(50);
      const sent: any = h.socket.lastOfType('SUBMIT_MOVE_PROOF');
      expect(sent, 'the winner cannot settle without this proof').toBeDefined();
      expect(sent.gameId).toBe('g1');
      expect(h.j.store.get('g1')!.moveProofs, 'and kept — a settlement needs it').toHaveLength(1);
      h.bot.stop();
    });

    it('still drops one for a game it has since left for a different one', async () => {
      const { h, after, finish } = await movingWhenTheGameEnds();
      h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player1', gameState: after });
      await tick(20);
      match(h.socket, 'g2');
      await tick(20);
      finish();
      await tick(50);
      expect(h.socket.countOfType('SUBMIT_MOVE_PROOF')).toBe(0);
      h.bot.stop();
    });
  });
});

describe('ArenaBot journals committed games', () => {
  it('journals the game BEFORE the join is sent — a crash mid-join must leave a record', async () => {
    let atSend: any = null;
    const h = fakeChainBot({
      pxe: {
        sendJoinGame: async () => { atSend = JSON.parse(JSON.stringify(h.j.store.get('g1') ?? null)); return F(1); },
      },
    });
    await h.ready();
    match(h.socket);
    h.handshake('g1');
    await tick(50);
    expect(atSend, 'written before the join tx').not.toBeNull();
    expect(atSend.phase).toBe('joining');
    expect(atSend).toMatchObject({ gameKey: GAME_KEY, nonce: NONCE, record1: RECORD1, record2: RECORD2, cardIds: BOT_HAND });
    expect(h.j.store.get('g1')!.phase, 'and marked joined once it lands').toBe('joined');
    h.bot.stop();
  });

  it('keeps what recovery needs and nothing more about the human', async () => {
    const h = await joinedBot();
    const rec = h.j.store.get('g1')!;
    expect(Object.keys(rec).sort()).toEqual([
      'cardIds', 'committedAt', 'gameKey', 'keyPair', 'moveProofs', 'nonce', 'opponentPublicKey',
      'outcome', 'phase', 'prizeMove', 'record1', 'record2', 'relayGameId', 'updatedAt', 'version',
    ]);
    expect(rec.relayGameId).toBe('g1');
    expect(rec.keyPair.privateJwk, 'our private key: a restarted bot can still open the channel').toBeTruthy();
    expect(rec.opponentPublicKey).toBe(HUMAN_PK);
    expect(rec.cardIds, 'OUR hand').toEqual(BOT_HAND);
    // Nothing of the human's beyond their opaque record and public key.
    const text = JSON.stringify(rec);
    for (const id of HUMAN_HAND) expect(text).not.toMatch(new RegExp(`"(tokenId|cardId)":${id}\\b`));
    expect(text).not.toMatch(/address|opponentCardIds|randomness|blinding/i);
    h.bot.stop();
  });

  it('grows the record as the transcript arrives, and records the outcome', async () => {
    const h = await joinedBot();
    const t = transcript({ winnerId: 1 });
    for (const p of t.slice(0, 3)) h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: p });
    await tick(10);
    expect(h.j.store.get('g1')!.moveProofs).toHaveLength(3);
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player1', gameState: freshState() });
    await tick(10);
    expect(h.j.store.get('g1')!.outcome).toBe('loss');
    h.bot.stop();
  });

  it('does NOT forget a game whose settlement FAILED — the cards are still locked', async () => {
    const h = await joinedBot();
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player2', gameState: freshState() });
    await tick(200);
    // The transcript was incomplete, so the settle failed, loudly and by name.
    expect(h.bot.getStats().settleFailures).toBe(1);
    expect(h.bot.getStats().lastError).toMatch(/transcript incomplete/);
    expect(h.bot.getStats().settlements).toBe(0);
    expect(h.f.called('settle')).toHaveLength(0);
    expect(h.j.forgotten).toEqual([]);
    expect(h.j.resolved).toEqual([]);
    h.bot.stop();
  });
});

describe('ArenaBot does not take the opponent\'s word for a settlement', () => {
  it('settles its win anyway when a SETTLED is not borne out on-chain', async () => {
    const h = await joinedBot();
    for (const p of transcript({ winnerId: 2 })) h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: p });
    // "I settled" — but no settlement exists. Standing down on the word alone
    // would leave a won game unsettled until the sweep came round.
    h.peer('g1', { kind: 'SETTLED', txHash: F(0xdead) });
    await tick(10);
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player2', gameState: freshState() });
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

/**
 * The opponent's ninth proof arrives after GAME_OVER: the bot is player 2, so
 * the last move of every game is the human's, still proving in their browser
 * when the relay calls the game. A loss resets the bot first, so that proof
 * has to land in the journal through the game's remembered context.
 */
describe('ArenaBot late move proofs from the opponent', () => {
  async function playToLoss() {
    let clock = 1_000_000;
    const h = await joinedBot({ now: () => clock });
    const t = transcript({ winnerId: 1 });
    for (const p of t.slice(0, 8)) h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: p });
    await tick(20);
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player1', gameState: freshState() });
    await tick(50);
    return { h, t, advanceClock: (ms: number) => { clock += ms; } };
  }

  it('the journal is one proof short when the game ends — the state this fixes', async () => {
    const { h } = await playToLoss();
    expect(h.bot.getStats().state, 'a loss resets to idle').not.toBe('playing');
    expect(h.j.store.get('g1')!.moveProofs).toHaveLength(8);
    h.bot.stop();
  });

  it('absorbs the ninth proof that lands after GAME_OVER', async () => {
    const { h, t } = await playToLoss();
    h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: t[8] });
    await tick(20);
    expect(h.j.store.get('g1')!.moveProofs, 'without it nobody can settle on the result').toHaveLength(9);
    h.bot.stop();
  });

  it('does not double-count a proof the relay redelivers', async () => {
    const { h, t } = await playToLoss();
    h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: t[8] });
    h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: t[8] });
    await tick(20);
    expect(h.j.store.get('g1')!.moveProofs).toHaveLength(9);
    h.bot.stop();
  });

  it('ignores a proof for a game it never played', async () => {
    const { h, t } = await playToLoss();
    h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'someone-elses-game', moveProof: t[8] });
    await tick(20);
    expect(h.j.store.get('g1')!.moveProofs).toHaveLength(8);
    h.bot.stop();
  });

  it('stops absorbing once the window has passed', async () => {
    const { h, t, advanceClock } = await playToLoss();
    advanceClock(16 * 60_000);
    h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: t[8] });
    await tick(20);
    expect(h.j.store.get('g1')!.moveProofs).toHaveLength(8);
    h.bot.stop();
  });
});

describe('ArenaBot stuck-game watchdog', () => {
  it('abandons a stuck game and reports the cards left committed', async () => {
    let clock = 1_000_000;
    const h = await joinedBot({ cfg: { pollIntervalMs: 50, gameTimeoutMs: 10_000 }, now: () => clock });
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
    const h = fakeChainBot({ cfg: { pollIntervalMs: 50, gameTimeoutMs: 10_000 }, now: () => clock, queue: { length: 0, oldestWaitMs: 0, entries: [] } });
    await h.ready();
    match(h.socket);
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

  it('shows the live game: keyed, committed, and whose turn it is', async () => {
    const h = await joinedBot();
    const g = h.bot.getStats().game!;
    expect(g.relayGameId).toBe('g1');
    expect(g.playerNumber).toBe(2);
    expect(g).toMatchObject({ keyed: true, opponentRecord: true, committed: true, moveProofs: 0 });
    expect(typeof g.oweAMove).toBe('boolean');
    expect(g.opponentGoneFor).toBeNull();
    h.bot.stop();
  });

  it('counts how long the opponent has been gone', async () => {
    let clock = 1_000_000;
    const h = await joinedBot({ now: () => clock });
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    clock += 30_000;
    await tick(50);
    expect(h.bot.getStats().game!.opponentGoneFor).toBe(30);
    h.bot.stop();
  });

  it('exposes no game key, record, nullifier or tx hash', async () => {
    const h = await joinedBot();
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
  const mk = async (over: Partial<ArenaBotConfig> = {}) => {
    const clock = { t: 1_000_000 };
    const h = await joinedBot({ cfg: { pollIntervalMs: 50, ...over }, now: () => clock.t });
    return { ...h, clock };
  };

  it('holds the game open while the opponent might still reconnect', async () => {
    const h = await mk({ opponentGraceMs: 90_000 });
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    h.clock.t += 60_000;
    await tick(200);
    expect(h.bot.getStats().state).toBe('playing');
    expect(h.bot.getStats().abandonedGames).toBe(0);
    h.bot.stop();
  });

  it('gives up once the window has passed, not thirty minutes later', async () => {
    const h = await mk({ opponentGraceMs: 90_000 });
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    h.clock.t += 91_000;
    await tick(200);
    expect(['idle', 'queued']).toContain(h.bot.getStats().state);
    expect(h.bot.getStats().abandonedGames).toBe(1);
    expect(h.bot.getStats().cardsStranded).toBe(5);
    h.bot.stop();
  });

  it('gives up on time even when the board is waiting on us — a claim has no turn rule now', async () => {
    const h = await mk({ opponentGraceMs: 90_000 });
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await tick(50);
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    h.clock.t += 91_000;
    await tick(200);
    expect(h.bot.getStats().abandonedGames).toBe(1);
    h.bot.stop();
  });

  it('a reconnecting opponent cancels the countdown', async () => {
    const h = await mk({ opponentGraceMs: 90_000 });
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    h.clock.t += 60_000;
    await tick(100);
    h.socket.deliver({ type: 'OPPONENT_RECONNECTED', gameId: 'g1' });
    h.clock.t += 120_000;
    await tick(200);
    expect(h.bot.getStats().state).toBe('playing');
    expect(h.bot.getStats().abandonedGames).toBe(0);
    h.bot.stop();
  });

  it('does not walk out on a game it is in the middle of settling', async () => {
    // The loser closing their tab the moment the result appears is ORDINARY.
    const h = await mk({ opponentGraceMs: 90_000, drawFallbackMs: 600_000 });
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'draw', gameState: freshState() });
    await tick(50);
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    h.clock.t += 200_000;
    await tick(200);
    expect(h.bot.getStats().abandonedGames).toBe(0);
    h.bot.stop();
  });

  it('does not walk out when the tab closed BEFORE the result arrived', async () => {
    const h = await mk({ opponentGraceMs: 90_000, drawFallbackMs: 600_000 });
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    h.clock.t += 10_000;
    await tick(100);
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'draw', gameState: freshState() });
    await tick(50);
    h.clock.t += 200_000;
    await tick(200);
    expect(h.bot.getStats().abandonedGames).toBe(0);
    h.bot.stop();
  });

  it('tells the relay it has left, so it can queue again', async () => {
    const h = await mk({ opponentGraceMs: 90_000 });
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    h.clock.t += 91_000;
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
  it('lets a move proof that is still generating finish before it goes', async () => {
    // That proof is part of a transcript — the winner's, if we just lost — and
    // it exists nowhere else until it is sent and journalled.
    let release: () => void = () => {};
    const h = await joinedBot({
      proofs: { proveMove: (a: any) => new Promise(r => { release = () => r(fakeMoveProof(a)); }) },
    });
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await tick(50);
    const placed = h.socket.lastOfType('PLACE_CARD');
    const after: any = botTurnState();
    after.board[placed.row][placed.col] = { card: { id: BOT_HAND[0] }, owner: 'player2', originalOwner: 'player2' };
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: after });
    await tick(20);

    let done = false;
    const leaving = h.bot.shutdown(60_000).then(() => { done = true; });
    await tick(1_000);
    expect(done, 'still waiting on the proof').toBe(false);
    release();
    await tick(500);
    await leaving;
    expect(h.socket.countOfType('SUBMIT_MOVE_PROOF')).toBe(1);
  });

  it('shuts down immediately when nothing is proving', async () => {
    const h = await joinedBot();
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
    const h = harness(makeConfig({ joinThresholdMs: 30_000 }));
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

describe('ArenaBot one move per turn', () => {
  it('schedules exactly one PLACE_CARD when a turn is signalled twice', async () => {
    const h = await joinedBot({ cfg: { difficulty: 'random' } });
    // Our turn, signalled twice. Without a guard both schedule, and under
    // difficulty 'random' the second picks a DIFFERENT cell: the relay applies
    // the first, `pendingMove` describes the second, and no echoed board ever
    // matches it again. The bot then stops proving AND stops playing.
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await tick(3_000);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(1);
    h.bot.stop();
  });

  it('still plays the NEXT turn', async () => {
    const h = await joinedBot({ cfg: { difficulty: 'random' } });
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await tick(3_000);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(1);

    // A board with 3 cards: our turn again, two moves later. The guard is
    // monotonic, so it must not block this.
    const later: any = botTurnState();
    later.board[2][2] = { card: { id: 9 }, owner: 'player2', originalOwner: 'player2' };
    later.board[2][1] = { card: { id: 180 }, owner: 'player1', originalOwner: 'player1' };
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: later });
    await tick(3_000);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(2);
    h.bot.stop();
  });
});

describe('ArenaBot card shortage', () => {
  it('logs a persistent shortage once, but counts every occurrence', async () => {
    const h = fakeChainBot({
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
      log: () => {}, now: () => 1_000_000,
    });
    bot.start();
    socket.emit('open');
    socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    socket.deliver({ type: 'BOT_REGISTERED' });
    await tick(100);

    // Match arrives while the queue fetch is still in flight.
    match(socket);
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
  async function matchOnce(over: Partial<Record<string, any>>, gameId: string): Promise<number | null> {
    const socket = new FakeSocket();
    const logs: string[] = [];
    const bot = new ArenaBot(makeConfig({ pollIntervalMs: 20, ...over }), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      log: (m: string) => logs.push(m), now: () => Date.now(),
    });
    bot.start();
    socket.emit('open');
    socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    socket.deliver({ type: 'BOT_REGISTERED' });
    await new Promise(r => setTimeout(r, 60));
    match(socket, gameId);
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
