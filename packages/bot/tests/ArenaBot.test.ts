import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { EventEmitter } from 'events';
import { ArenaBot, type QueueSnapshot } from '../src/ArenaBot.js';
import type { ArenaBotConfig } from '../src/config.js';
import { createGame, getCardsByIds, placeCard } from '@axolotl-arena/game-logic';
import type { GameState } from '@axolotl-arena/game-logic';

/** Minimal stand-in for the `ws` client: records what the bot sends. */
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit('close'); }
  /** Deliver a server frame to the bot. */
  deliver(msg: unknown) { this.emit('message', Buffer.from(JSON.stringify(msg))); }
  lastOfType(type: string) { return [...this.sent].reverse().find(m => m.type === type); }
  countOfType(type: string) { return this.sent.filter(m => m.type === type).length; }
}

const CARDS = [1, 2, 3, 4, 5];

function makeConfig(over: Partial<ArenaBotConfig> = {}): ArenaBotConfig {
  return {
    wsUrl: 'ws://test', httpUrl: 'http://test', token: 'tok',
    joinThresholdMs: 20_000, pollIntervalMs: 1_000, queueTimeoutMs: 60_000,
    handCardIds: CARDS, difficulty: 'greedy', moveDelayMs: 0,
    // Full strength by default in tests: a bot that blunders at random makes
    // every move assertion flaky for reasons unrelated to what is being tested.
    skillMin: 1, skillMax: 1,
    maxConcurrentGames: 1,
    chainTxTimeoutMs: 600_000,
    // Unit tests assert the IMMEDIATE verdict on an incomplete transcript.
    settleWaitMs: 0,
    sweepIntervalMs: 900_000,
    drawFallbackMs: 0,
    gameTimeoutMs: 1_800_000,
    opponentGraceMs: 90_000,
    moveCatchUpMs: 120_000,
    healthPort: 0,
    ...over,
  };
}

function freshState(): GameState {
  return createGame(getCardsByIds(CARDS), getCardsByIds(CARDS));
}

/**
 * A state where it is PLAYER 2's turn — the bot only ever joins, so it is always
 * player 2 and never moves on a fresh board.
 */
function botTurnState(): GameState {
  return placeCard(freshState(), 'player1', 0, 0, 0).newState;
}

/**
 * The join handshake the bot needs before it will commit (and therefore before
 * it will play): the creator shares its on-chain id, then its create_game is
 * confirmed. As a joiner the bot has no other route to `committed`.
 */
function deliverJoinHandshake(socket: FakeSocket, gameId = 'g1', onChainGameId = FIELD(0xc1)): void {
  socket.deliver({ type: 'OPPONENT_AZTEC_INFO', gameId, aztecAddress: FIELD(0xdef), onChainGameId, gameRandomness: SIX_RANDOM });
  socket.deliver({ type: 'ON_CHAIN_STATUS', gameId, status: { player1Tx: 'confirmed', player2Tx: 'pending' } });
  // The bot will not commit cards until it holds the opponent's hand proof —
  // recovery needs it, so committing first is how five cards get stranded for
  // good. The real opponent sends this as soon as our randomness reaches them,
  // which the OPPONENT_AZTEC_INFO above is standing in for.
  socket.deliver({
    type: 'HAND_PROOF', gameId, fromPlayer: 1,
    handProof: { proof: 'p', publicInputs: ['0x1', '0x2'], cardCommit: FIELD(0x222) },
  });
}

/** Build a bot wired to a fake socket and a settable queue snapshot. */
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
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    expect(h.bot.getStats().state).toBe('idle');
    h.bot.stop();
  });

  it('does not queue below the join threshold', async () => {
    const h = harness();
    await h.ready();
    h.setQueue({ length: 1, oldestWaitMs: 19_999 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    h.bot.stop();
  });

  it('offers a game once someone has waited past the threshold', async () => {
    const h = harness();
    await h.ready();
    h.setQueue({ length: 1, oldestWaitMs: 20_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.socket.lastOfType('QUEUE_MATCHMAKING')).toMatchObject({ cardIds: CARDS });
    expect(h.bot.getStats().state).toBe('queued');
    h.bot.stop();
  });

  it('queues only once while still waiting for a match', async () => {
    const h = harness();
    await h.ready();
    h.setQueue({ length: 1, oldestWaitMs: 30_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(1);
    h.bot.stop();
  });

  it('leaves the queue if no match forms — otherwise it would ambush the next player', async () => {
    const h = harness(makeConfig({ queueTimeoutMs: 10_000 }));
    await h.ready();
    h.setQueue({ length: 1, oldestWaitMs: 25_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.bot.getStats().state).toBe('queued');

    h.advance(11_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.socket.lastOfType('CANCEL_MATCHMAKING')).toBeTruthy();
    expect(h.bot.getStats().state).toBe('idle');
    h.bot.stop();
  });

  it('does not take a second game while already playing', async () => {
    const h = harness();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    h.setQueue({ length: 1, oldestWaitMs: 60_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    expect(h.bot.getStats().state).toBe('playing');
    h.bot.stop();
  });
});

describe('ArenaBot play', () => {
  it('plays a legal move when it is its turn', async () => {
    const h = harness();
    await h.ready();
    // The bot joins as player 2, so it acts on a board where it is its turn.
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: botTurnState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(10);

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
    // Fresh board: it is player1's turn, so the bot must stay silent.
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(0);
    h.bot.stop();
  });

  it('ignores state for a game it is not in', async () => {
    const h = harness();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(10);
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'OTHER', gameState: freshState() });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(0);
    h.bot.stop();
  });

  it('does not send a move that the game outran during the pacing delay', async () => {
    const h = harness(makeConfig({ moveDelayMs: 5_000 }));
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    // Game ends before the delayed move fires.
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player2', gameState: freshState() });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(0);
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
      h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
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
    await vi.advanceTimersByTimeAsync(1_000);
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
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    expect(h.bot.getStats().state).toBe('playing');
    h.socket.close();
    expect(h.bot.getStats().state).toBe('idle');
    h.bot.stop();
  });
});

/** Well-formed field hex: the settlement args builder really parses these. */
const FIELD = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const SIX_RANDOM = Array.from({ length: 6 }, (_, i) => FIELD(0x100 + i));

/** Minimal fake of the chain adapter, recording what the bot asks of it. */
function fakeChain(over: Partial<Record<string, any>> = {}) {
  const calls: any[] = [];
  const imported = { calls: [] as any[][], held: [] as number[] };
  return {
    calls,
    imported,
    chain: {
      address: '0xbot',
      // A real node response shape, so the production fetchTxEffectData runs
      // for real rather than being mocked away.
      nodeClient: over.nodeClient ?? {
        getTxEffect: async () => ({
          data: { noteHashes: [FIELD(0xa11)], nullifiers: [FIELD(0xa22)] },
        }),
      },
      selectHand: over.selectHand ?? (async () => [7, 8, 9, 10, 11]),
      // Grows as imports land, so a test can assert the bot actually got its
      // cards back rather than merely that it called import.
      readCards: over.readCards ?? (async () => [...imported.held]),
      pxe: {
        importCardNotes: over.importCardNotes ?? (async (_o: string, _t: string, notes: any[]) => {
          imported.calls.push(notes);
          for (const n of notes) imported.held.push(n.tokenId);
          return notes.map((n: any) => n.tokenId);
        }),
        previewCreateGame: over.previewCreateGame ?? (async () => ({
          gameId: FIELD(0xabc), randomness: SIX_RANDOM, blindingFactor: FIELD(0xb), status: 0,
        })),
        previewJoinGame: over.previewJoinGame ?? (async () => ({ randomness: SIX_RANDOM, blindingFactor: FIELD(0xb) })),
        sendCreateGame: over.sendCreateGame ?? (async (...a: any[]) => { calls.push(['create', ...a]); return '0xtxcreate'; }),
        sendJoinGame: over.sendJoinGame ?? (async (...a: any[]) => { calls.push(['join', ...a]); return '0xtxjoin'; }),
        sendProcessGame: over.sendProcessGame ?? (async (...a: any[]) => { calls.push(['settle', ...a]); return '0xtxsettle'; }),
        sendCancelGame: over.sendCancelGame ?? (async (...a: any[]) => { calls.push(['cancel', ...a]); return '0xtxcancel'; }),
        // 2 = active. The draw fallback reads this to decide whether player 1
        // has already settled.
        readGameStatus: over.readGameStatus ?? (async () => 2),
      },
    },
  };
}

describe('ArenaBot chain mode', () => {
  const chainHarness = (over: Partial<Record<string, any>> = {}, cfg = makeConfig()) => {
    const socket = new FakeSocket();
    const f = fakeChain(over);
    let queue: QueueSnapshot = { length: 1, oldestWaitMs: 30_000, entries: [] };
    const bot = new ArenaBot(cfg, {
      connect: () => socket as unknown as any,
      fetchQueue: async () => queue,
      chain: f.chain as any,
      log: () => {},
      now: () => 1_000_000,
    });
    return { bot, socket, f, async ready() {
      bot.start();
      socket.emit('open');
      socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'bot', sessionToken: 't' });
      socket.deliver({ type: 'BOT_REGISTERED' });
      await vi.advanceTimersByTimeAsync(0);
    } };
  };

  it('wagers cards it actually holds, not a static configured hand', async () => {
    const h = chainHarness();
    await h.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    // makeConfig's handCardIds are [1..5]; the chain says it holds [7..11].
    expect(h.socket.lastOfType('QUEUE_MATCHMAKING').cardIds).toEqual([7, 8, 9, 10, 11]);
  });

  it('does not queue when it cannot field five cards', async () => {
    const h = chainHarness({ selectHand: async () => { throw new Error('holds only 3 card(s)'); } });
    await h.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    expect(h.bot.getStats().state).toBe('idle');
    expect(h.bot.getStats().joinFailures).toBe(1);
    expect(h.bot.getStats().lastError).toMatch(/holds only 3/);
  });



  it('as player2: does NOT join on the shared id alone — that races the chain', async () => {
    const h = chainHarness();
    await h.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(50);

    // P1 shares its id EARLY, before its create_game has mined.
    h.socket.deliver({ type: 'OPPONENT_AZTEC_INFO', gameId: 'g1', aztecAddress: '0xhuman', onChainGameId: FIELD(0xc1) });
    await vi.advanceTimersByTimeAsync(50);
    // join_game asserts the game is in `created` state, so joining now would
    // fail "Game not in created state".
    expect(h.f.calls.some(c => c[0] === 'join')).toBe(false);
  });

  it('leaves immediately if the server ever assigns it the creator slot', async () => {
    const h = chainHarness();
    await h.ready();
    await vi.advanceTimersByTimeAsync(1_000);

    // The server orders every pair so a bot is never the creator. If that ever
    // failed, the bot must NOT quietly start creating games — creating wagers
    // five cards as player 1, which is exactly what we promised it never does.
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(50);

    expect(h.socket.lastOfType('CANCEL_GAME')).toMatchObject({ gameId: 'g1' });
    expect(h.bot.getStats().lastError).toMatch(/only joins/);
    expect(h.f.calls.some((c: any[]) => c[0] === 'create' || c[0] === 'join')).toBe(false);
  });

  it('as player2: joins once the opponent\'s create_game is confirmed', async () => {
    const h = chainHarness();
    await h.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    h.socket.deliver({ type: 'OPPONENT_AZTEC_INFO', gameId: 'g1', aztecAddress: '0xhuman', onChainGameId: FIELD(0xc1) });
    // Recovery needs the opponent's hand proof, so the bot holds off committing
    // until it has one — otherwise a player who leaves early strands our five.
    h.socket.deliver({
      type: 'HAND_PROOF', gameId: 'g1', fromPlayer: 1,
      handProof: { proof: 'p', publicInputs: ['0x1', '0x2'], cardCommit: FIELD(0x222) },
    });
    await vi.advanceTimersByTimeAsync(50);

    h.socket.deliver({ type: 'ON_CHAIN_STATUS', gameId: 'g1', status: { player1Tx: 'confirmed', player2Tx: 'pending' } });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(h.f.calls.some(c => c[0] === 'join')).toBe(true);
    expect(h.socket.lastOfType('TX_CONFIRMED')).toMatchObject({ txType: 'join_game' });
  });

  it('as player2: a repeated confirmation does not double-join', async () => {
    const h = chainHarness();
    await h.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    h.socket.deliver({ type: 'OPPONENT_AZTEC_INFO', gameId: 'g1', aztecAddress: '0xhuman', onChainGameId: FIELD(0xc1) });
    // Committing waits on the opponent's hand proof, since recovery needs it.
    h.socket.deliver({
      type: 'HAND_PROOF', gameId: 'g1', fromPlayer: 1,
      handProof: { proof: 'p', publicInputs: ['0x1', '0x2'], cardCommit: FIELD(0x222) },
    });
    for (let i = 0; i < 3; i++) {
      h.socket.deliver({ type: 'ON_CHAIN_STATUS', gameId: 'g1', status: { player1Tx: 'confirmed', player2Tx: 'pending' } });
      await vi.advanceTimersByTimeAsync(1_500);
    }
    expect(h.f.calls.filter(c => c[0] === 'join')).toHaveLength(1);
  });

  describe('never commit cards it could not recover', () => {
    /**
     * Recovering an abandoned game requires BOTH hand proofs, so a player who
     * leaves before proving theirs used to strand the bot's five cards for good.
     * Two production games are locked that way and cannot be claimed by anyone.
     *
     * Sharing our randomness is what unblocks their hand proof — they cannot
     * build it without it — so waiting for that proof before committing cannot
     * deadlock. If it never arrives we never commit, and the watchdog tidies up a
     * game in which nothing was at stake.
     */
    const withoutHandProof = (socket: FakeSocket) => {
      socket.deliver({
        type: 'OPPONENT_AZTEC_INFO', gameId: 'g1', aztecAddress: FIELD(0xdef),
        onChainGameId: FIELD(0xc1), gameRandomness: SIX_RANDOM,
      });
      socket.deliver({
        type: 'ON_CHAIN_STATUS', gameId: 'g1',
        status: { player1Tx: 'confirmed', player2Tx: 'pending' },
      });
    };

    it('shares its randomness before waiting, so the opponent CAN prove', async () => {
      const h = chainHarness();
      await h.ready();
      await vi.advanceTimersByTimeAsync(1_000);
      h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
      withoutHandProof(h.socket);
      await vi.advanceTimersByTimeAsync(2_000);

      // The share must go out FIRST, or waiting for their proof deadlocks.
      const shared = h.socket.lastOfType('SHARE_AZTEC_INFO');
      expect(shared, 'randomness shared before committing').toBeTruthy();
      expect(Array.isArray(shared.gameRandomness)).toBe(true);
      expect(h.f.calls.filter(c => c[0] === 'join'), 'but no cards committed yet').toHaveLength(0);
    });

    it('commits once the opponent proves their hand', async () => {
      const h = chainHarness();
      await h.ready();
      await vi.advanceTimersByTimeAsync(1_000);
      h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
      withoutHandProof(h.socket);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.f.calls.filter(c => c[0] === 'join')).toHaveLength(0);

      h.socket.deliver({
        type: 'HAND_PROOF', gameId: 'g1', fromPlayer: 1,
        handProof: { proof: 'p', publicInputs: ['0x1', '0x2'], cardCommit: FIELD(0x222) },
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.f.calls.filter(c => c[0] === 'join'), 'now it is safe to commit').toHaveLength(1);
    });
  });

});

describe('ArenaBot proof flow', () => {
  function fakeProofs() {
    const calls: any[] = [];
    return {
      calls,
      proofs: {
        cardCommitHash: async (ids: number[]) => `0xcommit-${ids.join('')}`,
        verificationKeys: async () => ({ handVk: new Uint8Array([1]), moveVk: new Uint8Array([2]) }),
        proveHand: async (i: any) => { calls.push(['hand', i]); return { proof: 'p', publicInputs: ['a', 'b'], cardCommit: `0xcommit-${i.cardIds.join('')}` }; },
        proveMove: async (a: any) => { calls.push(['move', a]); return { proof: 'p', publicInputs: new Array(6).fill('x') }; },
      },
    };
  }

  const h2 = (over: any = {}) => {
    const socket = new FakeSocket();
    const f = fakeChain();
    const p = fakeProofs();
    const bot = new ArenaBot(makeConfig(over), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, proofs: p.proofs as any,
      log: () => {}, now: () => 1_000_000,
    });
    return { bot, socket, f, p, async ready() {
      bot.start(); socket.emit('open');
      socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
      socket.deliver({ type: 'BOT_REGISTERED' });
      await vi.advanceTimersByTimeAsync(1_000);
    } };
  };

  it('waits for the opponent randomness before proving its hand', async () => {
    const h = h2();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(50);
    // Nothing shared yet: as the joiner we have neither our own preview nor the
    // opponent's randomness, so no hand proof is possible.
    expect(h.p.calls.some(c => c[0] === 'hand')).toBe(false);

    deliverJoinHandshake(h.socket);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.p.calls.some(c => c[0] === 'hand')).toBe(true);
    expect(h.socket.lastOfType('SUBMIT_HAND_PROOF')).toBeTruthy();
  });

  it('submits exactly one hand proof however many times inputs re-arrive', async () => {
    const h = h2();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    for (let i = 0; i < 3; i++) {
      deliverJoinHandshake(h.socket);
      await vi.advanceTimersByTimeAsync(30);
    }
    expect(h.socket.countOfType('SUBMIT_HAND_PROOF')).toBe(1);
  });

  it('will not even PLACE a card until both card commitments are known', async () => {
    const h = h2();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    // Deliberately WITHOUT the opponent's hand proof.
    h.socket.deliver({ type: 'OPPONENT_AZTEC_INFO', gameId: 'g1', aztecAddress: FIELD(0xdef), onChainGameId: FIELD(0xc1), gameRandomness: SIX_RANDOM });
    h.socket.deliver({ type: 'ON_CHAIN_STATUS', gameId: 'g1', status: { player1Tx: 'confirmed', player2Tx: 'pending' } });
    await vi.advanceTimersByTimeAsync(50);

    // Without the opponent's hand proof the bot does not commit at all — that
    // proof is what recovery would need, so committing first is how cards get
    // stranded. It follows that it cannot place either: a move proof binds BOTH
    // commitments and needs the EXACT post-move board, so a card played now
    // could never be proved, and one unprovable move makes the whole game
    // unsettleable.
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(0);

    // The opponent's hand proof releases both: the bot commits, then plays.
    h.socket.deliver({ type: 'HAND_PROOF', gameId: 'g1', fromPlayer: 1, handProof: { proof: 'q', publicInputs: [], cardCommit: FIELD(0x2) } });
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(1);

    // …and that move is now provable.
    const placed = h.socket.lastOfType('PLACE_CARD');
    const st: any = botTurnState();
    st.board[placed.row][placed.col] = { card: { id: 1 }, owner: 'player2', originalOwner: 'player2' };
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: st });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.p.calls.some(c => c[0] === 'move')).toBe(true);
  });

  it('releases a held turn when OUR hand proof is the one that lands last', async () => {
    const h = h2();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    // Opponent's commitment first, ours still in flight — the mirror image of
    // the case above. Whichever lands second must release the turn; only
    // covering one direction deadlocks the bot on the other.
    h.socket.deliver({ type: 'HAND_PROOF', gameId: 'g1', fromPlayer: 1, handProof: { proof: 'q', publicInputs: [], cardCommit: FIELD(0x2) } });
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(0);

    deliverJoinHandshake(h.socket);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(1);
  });

  it('clears per-game proof inputs so they cannot leak into the next game', async () => {
    const h = h2();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.socket.countOfType('SUBMIT_HAND_PROOF')).toBe(1);

    // The bot is player 2 (it only joins). Winning means it attempts to settle;
    // the transcript is incomplete here so that attempt fails — and only THEN
    // does it reset, which is the window this test is about.
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player2', gameState: freshState() });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.bot.getStats().settleFailures).toBe(1);
    expect(h.bot.getStats().lastError).toMatch(/transcript incomplete/);

    // A second game must prove its own hand afresh, not reuse the first's state.
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g2', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    // A DIFFERENT on-chain id: the bot's committedGameIds guard refuses to
    // re-commit one it has already handled, which is what we want in reality.
    deliverJoinHandshake(h.socket, 'g2', FIELD(0xc2));
    await vi.advanceTimersByTimeAsync(50);
    expect(h.socket.countOfType('SUBMIT_HAND_PROOF')).toBe(2);
  });
});

describe('ArenaBot settlement', () => {
  // Real timers here: settle() awaits genuine dynamic imports of the Aztec SDK,
  // which fake timers cannot advance through.
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useFakeTimers());

  // The move-proof chain must start at the REAL canonical initial hash —
  // sortProofChain walks from it, so a made-up starting hash is rejected at
  // step 0 (which is the C2 replay guard doing its job).
  let initialHash: string;
  beforeAll(async () => {
    const { installNodeArtifactSources } = await import('../src/circuits.js');
    await installNodeArtifactSources();
    const { computeCanonicalInitialHash } = await import('../../frontend/src/aztec/settlementArgs.js');
    initialHash = await computeCanonicalInitialHash();
  }, 120_000);

  /** Well-formed field/address hex — buildProcessGameArgs really parses these. */
  const hex = FIELD;
  const SETTLE_TX = hex(0x5e77);
  const CHAIN_GAME_ID = hex(0xabc);
  const OPP_ADDRESS = hex(0xdef);
  const RANDOMNESS = SIX_RANDOM;

  /** Valid base64 for N 32-byte field elements — the args builder really decodes it. */
  const fakeProofB64 = (fields = 4) => Buffer.alloc(32 * fields).toString('base64');

  function settleHarness(winner: string, playerNumber: 1 | 2, seedTranscript: boolean, over: any = {}) {
    const socket = new FakeSocket();
    // `over` carries chain overrides (nodeClient) as well as config ones.
    const f = fakeChain(over);
    const sent: any[] = [];
    const logs: string[] = [];
    f.chain.pxe.sendProcessGame = async (...a: any[]) => { sent.push(a); return SETTLE_TX; };
    const proofs = {
      cardCommitHash: async (ids: number[]) => `0xc-${ids.join('')}`,
      verificationKeys: async () => ({ handVk: new Uint8Array([1]), moveVk: new Uint8Array([2]) }),
      proveHand: async () => ({ proof: fakeProofB64(), publicInputs: ['0x1', '0x2'], cardCommit: hex(0x111) }),
      proveMove: async () => ({ proof: fakeProofB64(), publicInputs: [], startStateHash: 'unused', endStateHash: '0x0' }),
    };
    // The draw fallback reads on-chain status; 2 = still active, i.e. player 1
    // has not settled, which is the case these tests care about.
    f.chain.pxe.readGameStatus = over.readGameStatus ?? (async () => 2);
    const bot = new ArenaBot(makeConfig({ pollIntervalMs: 20, settleWaitMs: 300, ...over }), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, proofs: proofs as any, log: (m: string) => logs.push(m), now: () => Date.now(),
    });
    return { bot, socket, sent, logs, imported: f.imported, async run() {
      const settle = (ms: number) => new Promise(r => setTimeout(r, ms));
      bot.start(); socket.emit('open');
      socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
      socket.deliver({ type: 'BOT_REGISTERED' });
      // Let the bot QUEUE first — that is what selects and stores its hand.
      // Skipping it leaves the hand empty and the hand proof never runs.
      await settle(80);
      socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber, gameState: freshState(), opponentIsBot: false });
      socket.deliver({ type: 'OPPONENT_AZTEC_INFO', gameId: 'g1', aztecAddress: OPP_ADDRESS, onChainGameId: CHAIN_GAME_ID, gameRandomness: RANDOMNESS });
      socket.deliver({ type: 'ON_CHAIN_STATUS', gameId: 'g1', status: { player1Tx: 'confirmed', player2Tx: 'pending' } });
      // The opponent's HAND proof gates COMMITTING (recovery needs it), which
      // is a separate concern from the MOVE proofs that gate settling. It is
      // always delivered, so `seedTranscript` still means "is the move
      // transcript complete" — which is what the settlement tests are about.
      socket.deliver({
        type: 'HAND_PROOF', gameId: 'g1', fromPlayer: playerNumber === 1 ? 2 : 1,
        handProof: { proof: fakeProofB64(), publicInputs: ['0x3', '0x4'], cardCommit: hex(0x222) },
      });
      await settle(1400);
      if (seedTranscript) {
        let start = initialHash;
        for (let i = 0; i < 9; i++) {
          const end = `0x${String(i + 1).padStart(64, '0')}`;
          socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: { proof: fakeProofB64(), publicInputs: [], startStateHash: start, endStateHash: end } });
          start = end;
        }
      }
      // The opponent shares its blinding factor at game over — settlement
      // cannot prove their card ids without it, so it is now part of the
      // transcript just like a hand proof.
      socket.deliver({ type: 'OPPONENT_BLINDING', gameId: 'g1', blindingFactor: hex(0xb2) });
      socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner, gameState: freshState(), player1CardIds: [1,2,3,4,5], player2CardIds: [6,7,8,9,10] });
      // Long enough for the settle wait (300ms) plus its 500ms poll tick.
      await settle(1200);
      // Late-arriving messages (a winner's NOTE_DATA lands minutes after we
      // reset to idle) must be delivered while the bot is still alive.
      if (over.afterGameOver) { await over.afterGameOver(socket); await settle(400); }
      bot.stop();
    } };
  }

  it('settles when it wins', async () => {
    const h = settleHarness('player2', 2, true);
    await h.run();
    expect(h.sent).toHaveLength(1);
    expect(h.bot.getStats().settlements).toBe(1);
  });

  it('does not settle when it loses — the winner does that', async () => {
    const h = settleHarness('player1', 2, true);
    await h.run();
    expect(h.sent).toHaveLength(0);
    expect(h.bot.getStats().settlements).toBe(0);
  });

  it('settles a draw as player 2 once player 1 has had its chance', async () => {
    // Draws are single-settler and player 1 fires it by convention, but the
    // CONTRACT accepts either side ("For draws, caller could be either
    // player"). Since the bot is always the JOINER, deferring unconditionally
    // would mean a human who closes the tab on a draw locks BOTH hands forever
    // — and the abandonment sweep cannot rescue it, because a completed draw
    // has all 9 move proofs and the claim requires 1..8.
    const h = settleHarness('draw', 2, true, { drawFallbackMs: 0 });
    await h.run();
    expect(h.sent).toHaveLength(1);
  });

  it('sends the loser back the notes for their returned cards', async () => {
    // process_game re-mints the loser's non-wagered cards as untagged notes
    // their PXE cannot discover; only the settler can compute the randomness.
    // Without this relay, losing to the bot costs a player their whole hand,
    // and their client waits on "Opponent is settling…" forever.
    const h = settleHarness('player2', 2, true);
    await h.run();

    const relay = h.socket.lastOfType('RELAY_NOTE_DATA');
    expect(relay, 'the bot relays note data after settling').toBeTruthy();
    expect(relay.gameId).toBe('g1');
    expect(relay.txHash).toBe(SETTLE_TX);
    // The bot claims opponentCardIds[0] (= 1); the other four go home.
    expect(relay.notes.map((n: { tokenId: number }) => n.tokenId)).toEqual([2, 3, 4, 5]);
    // Randomness must stay paired with its own slot, or the loser imports
    // notes that do not exist.
    expect(relay.notes.map((n: { randomness: string }) => n.randomness))
      .toEqual([SIX_RANDOM[1], SIX_RANDOM[2], SIX_RANDOM[3], SIX_RANDOM[4]]);
  });

  it('returns all five on a draw, where no card is claimed', async () => {
    const h = settleHarness('draw', 2, true, { drawFallbackMs: 0 });
    await h.run();
    const relay = h.socket.lastOfType('RELAY_NOTE_DATA');
    expect(relay.notes.map((n: { tokenId: number }) => n.tokenId)).toEqual([1, 2, 3, 4, 5]);
  });

  it('relays nothing when it did not settle', async () => {
    // The loser never owes anyone notes — sending them would import cards the
    // winner is about to take.
    const h = settleHarness('player1', 2, true);
    await h.run();
    expect(h.socket.lastOfType('RELAY_NOTE_DATA')).toBeUndefined();
  });

  it('takes its own five cards back after settling a win', async () => {
    // process_game re-mints the settler's cards with create_and_push_note and
    // offchain delivery — nothing discovers them passively. Skipping this
    // import removed five cards from the bot's wallet EVERY settled game, which
    // is the arena's entire card supply on a timer.
    const h = settleHarness('player2', 2, true);
    await h.run();

    const batches = h.imported.calls;
    expect(batches.length, 'the bot imported its returned cards').toBeGreaterThan(0);
    const own = batches[0];
    // Its five, plus the card it claimed — mint_for_game_winner takes [Field; 6].
    expect(own.map((n: { tokenId: number }) => n.tokenId)).toEqual([7, 8, 9, 10, 11, 1]);
    // randomness[i] pairs with slot i; the claimed card takes randomness[5].
    expect(own.map((n: { randomness: string }) => n.randomness)).toEqual([
      SIX_RANDOM[0], SIX_RANDOM[1], SIX_RANDOM[2], SIX_RANDOM[3], SIX_RANDOM[4], SIX_RANDOM[5],
    ]);
  });

  it('takes five back on a draw, and claims nothing', async () => {
    const h = settleHarness('draw', 2, true, { drawFallbackMs: 0 });
    await h.run();
    const own = h.imported.calls[0];
    expect(own.map((n: { tokenId: number }) => n.tokenId)).toEqual([7, 8, 9, 10, 11]);
  });

  it('imports the cards the winner relays back when it loses', async () => {
    // The mirror of relayReturnedNotes. Losing must cost exactly one card.
    const h = settleHarness('player1', 2, true, {
      // Delivered AFTER the bot has reset to idle, which is when it really
      // arrives: the winner still had an eleven-proof settlement to do.
      afterGameOver: (socket: FakeSocket) => socket.deliver({
        type: 'NOTE_DATA', gameId: 'g1', txHash: SETTLE_TX,
        notes: [
          { tokenId: 8, randomness: SIX_RANDOM[1] },
          { tokenId: 9, randomness: SIX_RANDOM[2] },
          { tokenId: 10, randomness: SIX_RANDOM[3] },
          { tokenId: 11, randomness: SIX_RANDOM[4] },
        ],
      }),
    });
    await h.run();
    expect(h.sent, 'the loser does not settle').toHaveLength(0);

    const relayed = h.imported.calls[h.imported.calls.length - 1];
    expect(relayed.map((n: { tokenId: number }) => n.tokenId)).toEqual([8, 9, 10, 11]);
  });

  it('counts cards it could not import, rather than losing them quietly', async () => {
    // An unimported note is a card the bot owns on-chain and can never field.
    // Silence here is what let 40 cards go missing unnoticed.
    // A throwing node fails immediately; `{data:null}` would retry 5x3s and
    // outlast the harness, which is a property of noteImporter, not of this.
    const h = settleHarness('player2', 2, true, {
      nodeClient: { getTxEffect: async () => { throw new Error('node unreachable'); } },
    });
    await h.run();
    expect(h.bot.getStats().cardsUnimported).toBe(6);
  });

  it('names what is missing rather than sending an incomplete transcript', async () => {
    const h = settleHarness('player2', 2, false);
    await h.run();
    expect(h.sent).toHaveLength(0);
    expect(h.bot.getStats().settleFailures).toBe(1);
    expect(h.bot.getStats().lastError).toMatch(/transcript incomplete.*move proof/s);
  });
});

describe('ArenaBot commit gate', () => {
  it('does not play before its own cards are committed on-chain', async () => {
    const socket = new FakeSocket();
    // A commit that never resolves — the bot must simply not move.
    const f = fakeChain({ sendJoinGame: () => new Promise(() => {}) });
    const bot = new ArenaBot(makeConfig(), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, log: () => {}, now: () => 1_000_000,
    });
    bot.start();
    socket.emit('open');
    socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(1_000);

    socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    for (let i = 0; i < 5; i++) {
      socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: freshState() });
      await vi.advanceTimersByTimeAsync(100);
    }
    // Moving here would prove against a commitment that does not exist yet, and
    // would let the relay game finish before the chain caught up.
    expect(socket.countOfType('PLACE_CARD')).toBe(0);
    bot.stop();
  });

  it('plays normally with no chain — off-chain mode is unaffected', async () => {
    const h = harness();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: botTurnState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(1);
    h.bot.stop();
  });


  it('plays once committed, even if its turn arrived DURING the commit', async () => {
    const socket = new FakeSocket();
    let releaseCommit: (v: string) => void = () => {};
    const f = fakeChain({ sendJoinGame: () => new Promise<string>(r => { releaseCommit = r; }) });
    const bot = new ArenaBot(makeConfig(), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, log: () => {}, now: () => 1_000_000,
    });
    bot.start();
    socket.emit('open');
    socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(1_000);

    socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: botTurnState(), opponentIsBot: false });
    deliverJoinHandshake(socket);
    // Our turn arrives while the commit is still in flight — and is dropped.
    socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await vi.advanceTimersByTimeAsync(50);
    expect(socket.countOfType('PLACE_CARD')).toBe(0);

    // The relay sends a new state only when somebody MOVES, so nothing further
    // will arrive. Committing must replay the last state or the bot deadlocks.
    releaseCommit('0xtx');
    await vi.advanceTimersByTimeAsync(50);
    expect(socket.countOfType('PLACE_CARD')).toBe(1);
    bot.stop();
  });
});

describe('ArenaBot card shortage', () => {
  it('logs a persistent shortage once, but counts every occurrence', async () => {
    const socket = new FakeSocket();
    const logs: string[] = [];
    const f = fakeChain({ selectHand: async () => { throw new Error('holds only 2 card(s)'); } });
    const bot = new ArenaBot(makeConfig({ pollIntervalMs: 50 }), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, log: m => logs.push(m), now: () => 1_000_000,
    });
    bot.start();
    socket.emit('open');
    socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(1_000);

    // The shortage persists until someone re-provisions; tick() runs constantly.
    const shortageLogs = logs.filter(l => l.includes('select-hand'));
    expect(shortageLogs).toHaveLength(1);
    expect(bot.getStats().joinFailures).toBeGreaterThan(1);
    expect(bot.getStats().lastError).toMatch(/holds only 2/);
    bot.stop();
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
    await vi.advanceTimersByTimeAsync(100);

    // Match arrives while the queue fetch is still in flight.
    socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    releaseFetch({ length: 1, oldestWaitMs: 30_000, entries: [] });
    await vi.advanceTimersByTimeAsync(100);

    // Queueing now would be rejected "already in an active game", and the ERROR
    // path would then reset us out of a game we are actually playing.
    expect(socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    expect(bot.getStats().state).toBe('playing');
    bot.stop();
  });
});

describe('ArenaBot move proof staleness', () => {
  it('will not prove against a LATER board than the one its move produced', async () => {
    const socket = new FakeSocket();
    const f = fakeChain();
    const proved: any[] = [];
    const proofs = {
      cardCommitHash: async () => FIELD(0x1),
      verificationKeys: async () => ({ handVk: new Uint8Array([1]), moveVk: new Uint8Array([2]) }),
      proveHand: async () => ({ proof: 'p', publicInputs: ['a', 'b'], cardCommit: FIELD(0x1) }),
      proveMove: async (a: any) => { proved.push(a); return { proof: 'p', publicInputs: [], startStateHash: 's' }; },
    };
    const bot = new ArenaBot(makeConfig({ pollIntervalMs: 20 }), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, proofs: proofs as any, log: () => {}, now: () => 1_000_000,
    });
    bot.start();
    socket.emit('open');
    socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(1_000);
    socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(socket);
    socket.deliver({ type: 'HAND_PROOF', gameId: 'g1', fromPlayer: 1, handProof: { proof: 'q', publicInputs: [], cardCommit: FIELD(0x2) } });
    socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await vi.advanceTimersByTimeAsync(50);
    expect(socket.countOfType('PLACE_CARD')).toBe(1);

    // A board TWO moves past ours. The bot moved on a board that already had 1
    // card, so its own after-state has 2; this has 4, by which point its card
    // may have been captured — owner no longer us, and the circuit rejects it.
    const late: any = botTurnState();
    late.board[0][1] = { card: { id: 6 }, owner: 'player1', originalOwner: 'player2' };
    late.board[0][2] = { card: { id: 7 }, owner: 'player1', originalOwner: 'player1' };
    late.board[1][0] = { card: { id: 8 }, owner: 'player2', originalOwner: 'player2' };
    socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: late });
    await vi.advanceTimersByTimeAsync(50);
    expect(proved).toHaveLength(0);
    bot.stop();
  });
});

/**
 * The move that ENDS a game is proved after the relay has already announced
 * GAME_OVER — that is the ordinary sequence, not an edge case. On a loss the
 * bot has reset to idle by then, and it used to check `this.gameId !== gameId`
 * after the await and drop the finished proof on the floor.
 *
 * That proof is the WINNER's. Without it they sit at 8/9, their wait expires,
 * and the game can never be settled: five cards stranded a side. Seen twice on
 * production, where it was misread as a timeout being too short — no wait
 * would have been long enough, because the ninth proof was never coming.
 */
describe('ArenaBot final move proof', () => {
  const setup = () => {
    const socket = new FakeSocket();
    const f = fakeChain();
    let release: (v: any) => void = () => {};
    const proofs = {
      cardCommitHash: async () => FIELD(0x1),
      verificationKeys: async () => ({ handVk: new Uint8Array([1]), moveVk: new Uint8Array([2]) }),
      proveHand: async () => ({ proof: 'p', publicInputs: [], cardCommit: FIELD(0x1) }),
      // Held open so the test decides when proving finishes.
      proveMove: () => new Promise(res => { release = res; }),
    };
    const bot = new ArenaBot(makeConfig({ pollIntervalMs: 20 }), {
      connect: () => socket as unknown as any,
      // A waiting human, so the bot QUEUES and thereby picks its hand — without
      // one it never has cards to play and never takes a turn.
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, proofs: proofs as any, log: () => {}, now: () => 1_000_000,
    });
    return { socket, bot, finishProving: () => release({ proof: 'p', publicInputs: [], startStateHash: 's' }) };
  };

  /** Play one bot move and echo the board it produced, leaving it mid-proof. */
  async function moveAndStartProving(h: ReturnType<typeof setup>) {
    h.bot.start();
    h.socket.emit('open');
    h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    h.socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket);
    h.socket.deliver({ type: 'HAND_PROOF', gameId: 'g1', fromPlayer: 1, handProof: { proof: 'q', publicInputs: [], cardCommit: FIELD(0x2) } });
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await vi.advanceTimersByTimeAsync(50);
    const placed: any = h.socket.lastOfType('PLACE_CARD');
    expect(placed, 'the bot should have taken its turn').toBeDefined();

    // The echoed state must be EXACTLY the one its move produced.
    const after: any = botTurnState();
    after.board[placed.row][placed.col] = { card: { id: 1 }, owner: 'player2', originalOwner: 'player2' };
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: after });
    await vi.advanceTimersByTimeAsync(20);
    expect(h.socket.countOfType('SUBMIT_MOVE_PROOF'), 'still proving').toBe(0);
    return after;
  }

  it('sends it even though the game ended while it was still proving', async () => {
    const h = setup();
    const after = await moveAndStartProving(h);

    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player1', gameState: after });
    await vi.advanceTimersByTimeAsync(20);
    expect(h.bot.getStats().state, 'a loss resets us to idle').not.toBe('playing');

    h.finishProving();
    await vi.advanceTimersByTimeAsync(50);

    const sent: any = h.socket.lastOfType('SUBMIT_MOVE_PROOF');
    expect(sent, 'the winner cannot settle without this proof').toBeDefined();
    expect(sent.gameId).toBe('g1');
    h.bot.stop();
  });

  it('still drops one for a game it has since left for a different one', async () => {
    const h = setup();
    const after = await moveAndStartProving(h);

    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player1', gameState: after });
    await vi.advanceTimersByTimeAsync(20);
    // Straight into the next game, so `gameId` is set again — and to something
    // else. Sending g1's proof now would be answering for a game we are no
    // longer part of.
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g2', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(20);

    h.finishProving();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.socket.countOfType('SUBMIT_MOVE_PROOF')).toBe(0);
    h.bot.stop();
  });
});

describe('ArenaBot stuck-game watchdog', () => {
  it('abandons a stuck game and reports the cards left committed', async () => {
    const socket = new FakeSocket();
    const f = fakeChain();
    const cancels: any[] = [];
    f.chain.pxe.sendCancelGame = async (...a: any[]) => { cancels.push(a); return '0xcancel'; };
    let clock = 1_000_000;
    const bot = new ArenaBot(makeConfig({ pollIntervalMs: 50, gameTimeoutMs: 10_000 }), {
      connect: () => socket as unknown as any,
      // A waiting player, so the bot QUEUES and thereby selects its hand —
      // without that there is no wagered hand to recover.
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, log: () => { /* quiet */ }, now: () => clock,
    });
    bot.start();
    socket.emit('open');
    socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(100);

    // Joined and committed, then the game simply never finishes.
    socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(socket);
    await vi.advanceTimersByTimeAsync(100);
    expect(bot.getStats().state).toBe('playing');

    clock += 11_000;
    await vi.advanceTimersByTimeAsync(200);

    // Without this the bot would sit in `playing` forever, taking no further
    // players, with its five committed cards stranded. Back in service means
    // idle OR already re-queued for the next waiting player.
    expect(['idle', 'queued']).toContain(bot.getStats().state);
    expect(bot.getStats().abandonedGames).toBe(1);
    // The bot only JOINS, so it cannot cancel (creator-only). Its committed
    // cards stay locked pending the abandonment claim — surfaced, not silent.
    expect(cancels).toHaveLength(0);
    expect(bot.getStats().cardsStranded).toBe(5);
    bot.stop();
  });

  it('does not try to cancel a game the opponent actually joined', async () => {
    const socket = new FakeSocket();
    const f = fakeChain();
    const cancels: any[] = [];
    f.chain.pxe.sendCancelGame = async (...a: any[]) => { cancels.push(a); return '0xcancel'; };
    let clock = 1_000_000;
    const bot = new ArenaBot(makeConfig({ pollIntervalMs: 50, gameTimeoutMs: 10_000 }), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 0, oldestWaitMs: 0, entries: [] }),
      chain: f.chain as any, log: () => {}, now: () => clock,
    });
    bot.start();
    socket.emit('open');
    socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(100);
    // As player2 we are the joiner — cancel_game is creator-only, and a joined
    // game needs the abandonment-claim path instead.
    socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(100);
    clock += 11_000;
    await vi.advanceTimersByTimeAsync(200);

    expect(['idle', 'queued']).toContain(bot.getStats().state);
    expect(bot.getStats().abandonedGames).toBe(1);
    expect(cancels).toHaveLength(0);
    bot.stop();
  });
});

/**
 * A disconnect the relay WITNESSED is different information from silence, and
 * the bot used to throw it away: it ignored OPPONENT_DISCONNECTED entirely and
 * sat in `playing` until the 30-minute stuck-game watchdog fired. With one bot
 * in the arena that is thirty minutes in which nobody can get an opponent.
 *
 * Every test here leaves `gameTimeoutMs` at its 30-minute default, so nothing
 * below can be the watchdog firing early.
 */
/**
 * What the bot is doing RIGHT NOW.
 *
 * The counters answer "has anything broken"; they cannot answer "what is
 * happening". Without that, diagnosing a live game meant grepping the journal
 * and the systemd log after the fact and inferring — which was wrong as often
 * as right: seven move proofs read as nine, a sweep assumed to have run that
 * had not, a game believed committed that never was.
 */
describe('ArenaBot live state', () => {
  const mk = () => {
    const socket = new FakeSocket();
    const f = fakeChain();
    const clock = { t: 1_000_000 };
    const outstanding: any[] = [];
    const bot = new ArenaBot(makeConfig({ pollIntervalMs: 50 }), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, log: () => {}, now: () => clock.t,
      journal: {
        read: () => null, write: () => {}, forget: () => {}, markSettled: () => {},
        outstanding: () => outstanding,
      },
    });
    return { bot, socket, clock, outstanding };
  };

  it('reports no game when idle, rather than a stale one', async () => {
    const h = mk();
    h.bot.start();
    h.socket.emit('open');
    h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    h.socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.bot.getStats().game).toBeNull();
    h.bot.stop();
  });

  it('shows the live game: whether cards are at stake and whose turn it is', async () => {
    const h = mk();
    h.bot.start();
    h.socket.emit('open');
    h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    h.socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(100);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket);
    await vi.advanceTimersByTimeAsync(100);

    const g = h.bot.getStats().game!;
    expect(g.relayGameId).toBe('g1');
    expect(g.playerNumber).toBe(2);
    // The two facts that decide whether walking away is safe.
    expect(typeof g.committed).toBe('boolean');
    expect(typeof g.oweAMove).toBe('boolean');
    expect(g.opponentGoneFor).toBeNull();
    h.bot.stop();
  });

  it('counts how long the opponent has been gone', async () => {
    const h = mk();
    h.bot.start();
    h.socket.emit('open');
    h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    h.socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(100);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket);
    await vi.advanceTimersByTimeAsync(100);
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    h.clock.t += 30_000;
    await vi.advanceTimersByTimeAsync(50);

    expect(h.bot.getStats().game!.opponentGoneFor).toBe(30);
    h.bot.stop();
  });

  it('says WHY each outstanding game is not moving', async () => {
    // A game sitting untouched looks identical whether it is too young, missing
    // a hand proof, or already settled. Telling those apart meant reading logs.
    const h = mk();
    h.outstanding.push(
      { onChainGameId: '0xyoung', committedAt: 1_000_000 - 60_000, moveProofs: [1, 2],
        myHandProof: {}, opponentHandProof: {} },
      { onChainGameId: '0xnohands', committedAt: 1_000_000 - 7_200_000, moveProofs: [],
        myHandProof: {}, opponentHandProof: null },
      { onChainGameId: '0xready', committedAt: 1_000_000 - 7_200_000, moveProofs: [1, 2, 3, 4],
        myHandProof: {}, opponentHandProof: {} },
    );
    const j = h.bot.getStats().journal;
    expect(j.find(e => e.onChainGameId === '0xyoung')!.blockedBy).toMatch(/too young/);
    expect(j.find(e => e.onChainGameId === '0xnohands')!.blockedBy).toMatch(/hand proof/);
    expect(j.find(e => e.onChainGameId === '0xready')!.blockedBy).toBeNull();
    expect(j.find(e => e.onChainGameId === '0xready')!.moveProofs).toBe(4);
    h.bot.stop();
  });
});

describe('ArenaBot opponent disconnect', () => {
  const mk = (over: Partial<ArenaBotConfig> = {}) => {
    const socket = new FakeSocket();
    const f = fakeChain();
    const clock = { t: 1_000_000 };
    // `proofs` is not optional scaffolding here: without it the GAME_OVER
    // handler takes the "somebody else settles" branch and resets to idle, so
    // a test meaning to exercise settlement would quietly exercise nothing.
    const proofs = {
      cardCommitHash: async () => FIELD(0x1),
      verificationKeys: async () => ({ handVk: new Uint8Array([1]), moveVk: new Uint8Array([2]) }),
      proveHand: async () => ({ proof: 'p', publicInputs: ['a', 'b'], cardCommit: FIELD(0x1) }),
      proveMove: async () => ({ proof: 'p', publicInputs: [], startStateHash: 's' }),
    };
    const bot = new ArenaBot(makeConfig({ pollIntervalMs: 50, ...over }), {
      connect: () => socket as unknown as any,
      // A waiting human, so the bot QUEUES and thereby picks its hand. Without
      // one it holds no cards and can never take a turn — which silently makes
      // "does it play the move it owes?" untestable.
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, proofs: proofs as any, log: () => {}, now: () => clock.t,
    });
    return { bot, socket, f, clock };
  };

  async function inGame(h: ReturnType<typeof mk>) {
    h.bot.start();
    h.socket.emit('open');
    h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    h.socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(100);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.bot.getStats().state).toBe('playing');
  }

  it('holds the game open while the opponent might still reconnect', async () => {
    const h = mk({ opponentGraceMs: 90_000 });
    await inGame(h);
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    // The relay itself holds a 60s window for a resumed session. Bailing inside
    // it would forfeit games to a wifi blip and strand the cards for nothing.
    h.clock.t += 60_000;
    await vi.advanceTimersByTimeAsync(200);
    expect(h.bot.getStats().state).toBe('playing');
    expect(h.bot.getStats().abandonedGames).toBe(0);
    h.bot.stop();
  });

  it('gives up once the window has passed, not thirty minutes later', async () => {
    const h = mk({ opponentGraceMs: 90_000 });
    await inGame(h);
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    h.clock.t += 91_000;
    await vi.advanceTimersByTimeAsync(200);
    // Back in service: idle, or already re-queued for the next waiting player.
    expect(['idle', 'queued']).toContain(h.bot.getStats().state);
    expect(h.bot.getStats().abandonedGames).toBe(1);
    // Same ending as the watchdog's — the cards are locked, not lost, and the
    // count is what makes that visible on /health.
    expect(h.bot.getStats().cardsStranded).toBe(5);
    h.bot.stop();
  });

  it('a reconnecting opponent cancels the countdown', async () => {
    const h = mk({ opponentGraceMs: 90_000 });
    await inGame(h);
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    h.clock.t += 60_000;
    await vi.advanceTimersByTimeAsync(100);
    h.socket.deliver({ type: 'OPPONENT_RECONNECTED', gameId: 'g1' });
    // Well past the grace: if the countdown had merely been paused rather than
    // cancelled, the bot would walk out on a game that is still being played.
    h.clock.t += 120_000;
    await vi.advanceTimersByTimeAsync(200);
    expect(h.bot.getStats().state).toBe('playing');
    expect(h.bot.getStats().abandonedGames).toBe(0);
    h.bot.stop();
  });

  it('does not walk out on a game it is in the middle of settling', async () => {
    // The loser closing their tab the moment the result appears is ORDINARY,
    // and it arrives while the winner is still assembling an 11-proof
    // transcript. Abandoning there would throw away a game already won.
    const h = mk({ opponentGraceMs: 90_000, drawFallbackMs: 600_000 });
    h.f.chain.pxe.readGameStatus = async () => 2;   // still active, so it waits
    await inGame(h);
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'draw', gameState: freshState() });
    await vi.advanceTimersByTimeAsync(50);
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    h.clock.t += 200_000;
    await vi.advanceTimersByTimeAsync(200);
    expect(h.bot.getStats().abandonedGames).toBe(0);
    h.bot.stop();
  });

  it('does not walk out when the tab closed BEFORE the result arrived', async () => {
    // The likelier ordering, and the one the message handler's own guard does
    // not cover: they close the tab on their last move, so the disconnect is
    // already counting down when GAME_OVER lands and settlement begins. The
    // countdown has to notice that the game is now being settled.
    const h = mk({ opponentGraceMs: 90_000, drawFallbackMs: 600_000 });
    h.f.chain.pxe.readGameStatus = async () => 2;
    await inGame(h);
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    h.clock.t += 10_000;
    await vi.advanceTimersByTimeAsync(100);
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'draw', gameState: freshState() });
    await vi.advanceTimersByTimeAsync(50);
    h.clock.t += 200_000;
    await vi.advanceTimersByTimeAsync(200);
    expect(h.bot.getStats().abandonedGames).toBe(0);
    h.bot.stop();
  });

  /**
   * Leaves the bot owing a move it cannot yet play: it takes its turn, then the
   * relay re-sends the SAME state, which `maybeMove` declines (one move per
   * turn) while `currentTurn` still points at us.
   */
  async function owingAMove(h: ReturnType<typeof mk>) {
    await inGame(h);
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(1);
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await vi.advanceTimersByTimeAsync(20);
  }

  it('will not abandon while the game is waiting on OUR move', async () => {
    // The one that matters. `claim_abandoned_game` is only valid for the player
    // who is NOT next to move, so abandoning mid-turn hands the sole claim to
    // the opponent who has just left, and ten cards are locked for good.
    // Production had six games in that state, two of them unrecoverable.
    const h = mk({ opponentGraceMs: 90_000, moveCatchUpMs: 120_000 });
    await owingAMove(h);

    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    h.clock.t += 91_000;
    await vi.advanceTimersByTimeAsync(200);

    expect(h.bot.getStats().abandonedGames, 'must not leave the claim with the departed player').toBe(0);
    expect(h.bot.getStats().state).toBe('playing');
    h.bot.stop();
  });

  it('abandons anyway once the owed move has had long enough', async () => {
    // Holding the arena open forever is its own failure, so the wait is bounded.
    const h = mk({ opponentGraceMs: 90_000, moveCatchUpMs: 120_000 });
    await owingAMove(h);

    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    h.clock.t += 91_000;
    await vi.advanceTimersByTimeAsync(200);
    expect(h.bot.getStats().abandonedGames).toBe(0);

    h.clock.t += 121_000;
    await vi.advanceTimersByTimeAsync(200);
    expect(h.bot.getStats().abandonedGames).toBe(1);
    h.bot.stop();
  });

  it('plays the move it owes before shutting down', async () => {
    // Deploys and reboots are routine. We do not resume sessions, so a restart
    // mid-turn orphans the game — the move can never be made afterwards, and
    // the abandonment claim belongs to whoever is NOT next to move. Dying
    // mid-turn therefore hands it to the opponent and strands five cards.
    const h = mk({ opponentGraceMs: 90_000 });
    await inGame(h);
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(1);
    // Same trick as owingAMove: re-send the state so the move is owed but the
    // one-move-per-turn guard has already fired.
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await vi.advanceTimersByTimeAsync(20);

    const done = h.bot.shutdown(1_000);
    await vi.advanceTimersByTimeAsync(50);
    // It is trying, not exiting on the spot.
    expect(h.bot.getStats().state).toBe('playing');

    h.clock.t += 2_000;
    await vi.advanceTimersByTimeAsync(1_500);
    await done;
  });

  it('shuts down immediately when it owes nothing', async () => {
    const h = mk();
    await inGame(h);
    const done = h.bot.shutdown(60_000);
    await vi.advanceTimersByTimeAsync(20);
    await done;   // resolves without burning the budget
  });

  it('tells the relay it has left, so it can queue again', async () => {
    // The relay releases both players at GAME OVER, but an abandoned game never
    // reaches game over. Without an explicit leave the bot stays bound and
    // every queue attempt is rejected with "You are already in an active game"
    // until the stale-game sweep — production burned 578 attempts over 22
    // minutes in that state, with no opponent available to anyone.
    const h = mk({ opponentGraceMs: 90_000 });
    await inGame(h);
    h.socket.deliver({ type: 'OPPONENT_DISCONNECTED', gameId: 'g1' });
    h.clock.t += 91_000;
    await vi.advanceTimersByTimeAsync(200);

    expect(h.bot.getStats().abandonedGames).toBe(1);
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
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);

    h.setQueue({ length: 1, oldestWaitMs: 30_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(1);
    h.bot.stop();
  });
});

describe('ArenaBot one move per turn', () => {
  const mk = (over: any = {}) => {
    const socket = new FakeSocket();
    const f = fakeChain();
    const proofs = {
      cardCommitHash: async () => FIELD(0x1),
      verificationKeys: async () => ({ handVk: new Uint8Array([1]), moveVk: new Uint8Array([2]) }),
      proveHand: async () => ({ proof: 'p', publicInputs: ['a', 'b'], cardCommit: FIELD(0x1) }),
      proveMove: async () => ({ proof: 'p', publicInputs: [], startStateHash: 's' }),
    };
    const bot = new ArenaBot(makeConfig({ difficulty: 'random', ...over }), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, proofs: proofs as any, log: () => {}, now: () => 1_000_000,
    });
    return { bot, socket, f };
  };

  /** start → registered → committed → both card commitments known. */
  async function playing(h: ReturnType<typeof mk>) {
    h.bot.start();
    h.socket.emit('open');
    h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    h.socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket);
    h.socket.deliver({ type: 'HAND_PROOF', gameId: 'g1', fromPlayer: 1, handProof: { proof: 'q', publicInputs: [], cardCommit: FIELD(0x2) } });
    await vi.advanceTimersByTimeAsync(200);
  }

  it('schedules exactly one PLACE_CARD when a turn is signalled twice', async () => {
    const h = mk();
    await playing(h);

    // Our turn, signalled twice. In production the second signal is any of the
    // several callers of maybeMove — a re-broadcast state, our own hand proof
    // completing, the opponent's arriving — landing inside the pacing delay.
    // Without a guard both schedule, and under difficulty 'random' the second
    // picks a DIFFERENT cell: the relay applies the first, `pendingMove`
    // describes the second, and no echoed board ever matches it again. The bot
    // then stops proving AND stops playing. That deadlock cost a chain run.
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(h.socket.countOfType('PLACE_CARD')).toBe(1);
    h.bot.stop();
  });

  it('still plays the NEXT turn', async () => {
    const h = mk();
    await playing(h);
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(1);

    // A board with 3 cards: our turn again, two moves later. The guard is
    // monotonic, so it must not block this.
    const later: any = botTurnState();
    later.board[2][2] = { card: { id: 9 }, owner: 'player2', originalOwner: 'player2' };
    later.board[2][1] = { card: { id: 10 }, owner: 'player1', originalOwner: 'player1' };
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: later });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(2);
    h.bot.stop();
  });
});

describe('ArenaBot journals committed games', () => {
  function journalSpy() {
    const written: any[] = [];
    const forgotten: string[] = [];
    const store = new Map<string, any>();
    const settledIds: string[] = [];
    return {
      written, forgotten, settledIds, store,
      journal: {
        read: (id: string) => store.get(id) ?? null,
        write: (rec: any) => { store.set(rec.onChainGameId, rec); written.push(rec); },
        forget: (id: string) => { store.delete(id); forgotten.push(id); },
        markSettled: (id: string) => {
          const rec = store.get(id);
          if (rec) store.set(id, { ...rec, settled: true });
          settledIds.push(id);
        },
      },
    };
  }

  const mk = (over: any = {}) => {
    const socket = new FakeSocket();
    const f = fakeChain();
    const j = journalSpy();
    const proofs = {
      cardCommitHash: async () => FIELD(0x1),
      verificationKeys: async () => ({ handVk: new Uint8Array([1]), moveVk: new Uint8Array([2]) }),
      proveHand: async () => ({ proof: 'p', publicInputs: ['a', 'b'], cardCommit: FIELD(0x1) }),
      proveMove: async () => ({ proof: 'p', publicInputs: [], startStateHash: 's' }),
    };
    const bot = new ArenaBot(makeConfig(over), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, proofs: proofs as any, journal: j.journal,
      log: () => {}, now: () => 1_000_000,
    });
    return { bot, socket, f, j };
  };

  it('records the game the moment its cards are committed', async () => {
    const h = mk();
    h.bot.start();
    h.socket.emit('open');
    h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    h.socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket);
    await vi.advanceTimersByTimeAsync(50);

    // The cards are locked from the join onward; a crash a second later must
    // still leave a record, or they can never be recovered.
    expect(h.j.written.length).toBeGreaterThan(0);
    expect(h.j.written[0]).toMatchObject({
      onChainGameId: FIELD(0xc1),
      botIsPlayer1: false,
      cardIds: [7, 8, 9, 10, 11],
    });
    h.bot.stop();
  });

  it('grows the record as the transcript arrives', async () => {
    const h = mk();
    h.bot.start();
    h.socket.emit('open');
    h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    h.socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket);
    await vi.advanceTimersByTimeAsync(50);

    h.socket.deliver({ type: 'HAND_PROOF', gameId: 'g1', fromPlayer: 1, handProof: { proof: 'q', publicInputs: [], cardCommit: FIELD(0x2) } });
    h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: { proof: 'm', publicInputs: [], startStateHash: 'x' } });
    await vi.advanceTimersByTimeAsync(50);

    const last = h.j.written[h.j.written.length - 1];
    expect(last.opponentHandProof).toBeTruthy();
    expect(last.myHandProof).toBeTruthy();
    expect(last.moveProofs.length).toBeGreaterThan(0);
    h.bot.stop();
  });

  it('does NOT forget a game whose settlement FAILED — the cards are still locked', async () => {
    const h = mk({ settleWaitMs: 0 });
    h.bot.start();
    h.socket.emit('open');
    h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    h.socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket);
    await vi.advanceTimersByTimeAsync(50);

    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player2', gameState: freshState() });
    await vi.advanceTimersByTimeAsync(200);

    // The transcript was incomplete, so the settle failed. Forgetting here
    // would delete the only record that five cards are committed, and the
    // sweep would never come back for them.
    expect(h.bot.getStats().settleFailures).toBe(1);
    expect(h.bot.getStats().settlements).toBe(0);
    expect(h.j.forgotten).toEqual([]);
    h.bot.stop();
  });
});

describe('ArenaBot pool behaviour', () => {
  it('does not offer when another bot is already covering the waiting player', async () => {
    const h = harness();
    await h.ready();
    // One human waiting, one bot already queued for them. A second offer just
    // parks five more committed cards in the queue doing nothing.
    h.setQueue({ length: 2, oldestWaitMs: 60_000, humansWaiting: 1, botsQueued: 1 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    h.bot.stop();
  });

  it('offers when there are more waiting humans than bots', async () => {
    const h = harness();
    await h.ready();
    h.setQueue({ length: 3, oldestWaitMs: 60_000, humansWaiting: 2, botsQueued: 1 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(1);
    h.bot.stop();
  });

  it('offers against an older relay that reports no bot counts', async () => {
    const h = harness();
    await h.ready();
    // Without the fields, a single-bot deployment is the right assumption —
    // refusing to play would be a worse failure than a rare double-offer.
    h.setQueue({ length: 1, oldestWaitMs: 60_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(1);
    h.bot.stop();
  });
});

describe('ArenaBot draw settlement', () => {
  const mk = (over: any = {}, statusFn?: () => Promise<number>) => {
    const socket = new FakeSocket();
    const f = fakeChain();
    f.chain.pxe.readGameStatus = statusFn ?? (async () => 2);  // 2 = still active
    const proofs = {
      cardCommitHash: async () => FIELD(0x1),
      verificationKeys: async () => ({ handVk: new Uint8Array([1]), moveVk: new Uint8Array([2]) }),
      proveHand: async () => ({ proof: 'p', publicInputs: ['a', 'b'], cardCommit: FIELD(0x1) }),
      proveMove: async () => ({ proof: 'p', publicInputs: [], startStateHash: 's' }),
    };
    const bot = new ArenaBot(makeConfig({ settleWaitMs: 0, ...over }), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, proofs: proofs as any, log: () => {}, now: () => 1_000_000,
    });
    return { bot, socket, f };
  };

  async function playToDraw(h: ReturnType<typeof mk>) {
    h.bot.start();
    h.socket.emit('open');
    h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    h.socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket);
    await vi.advanceTimersByTimeAsync(50);
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'draw', gameState: freshState() });
    await vi.advanceTimersByTimeAsync(50);
  }

  it('attempts to settle a draw even though it is player 2', async () => {
    // The bot is ALWAYS player 2 now. If it deferred to the "player 1 settles a
    // draw" convention unconditionally, a human who closes the tab on a draw
    // would lock both hands forever — the sweep cannot rescue it either, since
    // a completed draw has all 9 move proofs and the claim needs 1..8.
    const h = mk({ drawFallbackMs: 0 });
    await playToDraw(h);
    // The transcript is incomplete in this harness, so it fails at that check —
    // which still proves it TRIED, rather than standing down on player number.
    expect(h.bot.getStats().settleFailures).toBe(1);
    expect(h.bot.getStats().lastError).toMatch(/transcript incomplete/);
    h.bot.stop();
  });

  it('stands down if player 1 settled the draw during the fallback wait', async () => {
    // status 3 = settled. Settling again burns a recursive proof to earn a revert.
    const h = mk({ drawFallbackMs: 1_000 }, async () => 3);
    await playToDraw(h);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.bot.getStats().settleFailures).toBe(0);
    expect(h.bot.getStats().settlements).toBe(0);
    h.bot.stop();
  });

  it('settles anyway when the status read fails', async () => {
    // A duplicate settle reverts and costs a proof; skipping can strand ten
    // cards permanently. Prefer the recoverable error.
    const h = mk({ drawFallbackMs: 0 }, async () => { throw new Error('node down'); });
    await playToDraw(h);
    expect(h.bot.getStats().lastError).toMatch(/transcript incomplete/);
    h.bot.stop();
  });

  it('still settles a win immediately, with no fallback wait', async () => {
    const h = mk({ drawFallbackMs: 600_000 });
    h.bot.start();
    h.socket.emit('open');
    h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    h.socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket);
    await vi.advanceTimersByTimeAsync(50);
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player2', gameState: freshState() });
    await vi.advanceTimersByTimeAsync(50);
    // No wait: winning is unambiguous, only draws have a second claimant.
    expect(h.bot.getStats().settleFailures).toBe(1);
    h.bot.stop();
  });
});

describe('ArenaBot blinding factors', () => {
  const h2 = (over: any = {}) => {
    const socket = new FakeSocket();
    const f = fakeChain();
    const proofs = {
      cardCommitHash: async () => FIELD(0x1),
      verificationKeys: async () => ({ handVk: new Uint8Array([1]), moveVk: new Uint8Array([2]) }),
      proveHand: async () => ({ proof: 'p', publicInputs: ['a', 'b'], cardCommit: FIELD(0x1) }),
      proveMove: async () => ({ proof: 'p', publicInputs: [], startStateHash: 's' }),
    };
    const bot = new ArenaBot(makeConfig(over), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, proofs: proofs as any, log: () => {}, now: () => 1_000_000,
    });
    return { bot, socket, f, async ready() {
      bot.start(); socket.emit('open');
      socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
      socket.deliver({ type: 'BOT_REGISTERED' });
      await vi.advanceTimersByTimeAsync(1_000);
    } };
  };

  it('shares its own blinding at game over, even when it LOSES', async () => {
    const h = h2();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket);
    await vi.advanceTimersByTimeAsync(50);

    // Losing, so we are not the one settling — but the WINNER cannot settle
    // without our blinding factor, and a game nobody can settle locks both
    // hands. Sharing is unconditional.
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player1', gameState: freshState() });
    await vi.advanceTimersByTimeAsync(50);

    expect(h.socket.lastOfType('SHARE_BLINDING')).toMatchObject({ gameId: 'g1', blindingFactor: FIELD(0xb) });
  });

  it('will not settle without the opponent\'s blinding, and says which is missing', async () => {
    const h = h2({ settleWaitMs: 0 });
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket);
    h.socket.deliver({ type: 'HAND_PROOF', gameId: 'g1', fromPlayer: 1, handProof: { proof: 'q', publicInputs: [], cardCommit: FIELD(0x2) } });
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 9; i++) {
      h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: { proof: 'm', publicInputs: [], startStateHash: `s${i}` } });
    }
    // Winning, so we settle — but nobody sent us their blinding factor.
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player2', gameState: freshState() });
    await vi.advanceTimersByTimeAsync(200);

    // Naming what is missing matters: without it this reads as an opaque
    // on-chain revert instead of "the other side never sent one thing".
    expect(h.bot.getStats().settleFailures).toBe(1);
    expect(h.bot.getStats().lastError).toMatch(/opponent blinding factor/);
  });

  it('does not carry a blinding factor into the next game', async () => {
    const h = h2();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket);
    h.socket.deliver({ type: 'OPPONENT_BLINDING', gameId: 'g1', blindingFactor: FIELD(0xdead) });
    await vi.advanceTimersByTimeAsync(50);
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player1', gameState: freshState() });
    await vi.advanceTimersByTimeAsync(50);

    // A stale factor would prove the WRONG game's cards and revert on-chain
    // after all the settlement work.
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g2', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket, 'g2', FIELD(0xc2));
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g2', winner: 'player2', gameState: freshState() });
    await vi.advanceTimersByTimeAsync(200);
    expect(h.bot.getStats().lastError).toMatch(/opponent blinding factor/);
  });
});

describe('per-game skill', () => {
  // Real timers: this drives the bot through actual awaits, and the file's
  // default fake timers would leave every one of them pending forever.
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
    socket.deliver({
      type: 'MATCH_FOUND', gameId, playerNumber: 2,
      gameState: freshState(), opponentIsBot: false,
    });
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

/**
 * The mirror of the bug above, on the RECEIVING side.
 *
 * Moves are 0-indexed, so player 1 plays 0,2,4,6,8 and player 2 plays 1,3,5,7.
 * The bot only ever joins, so it is always player 2 — meaning the ninth and
 * final proof of every game it plays belongs to the OPPONENT and arrives after
 * GAME_OVER, while their browser is still proving it.
 *
 * When the bot settles, settle() waits for that proof. When it loses, nothing
 * did: resetToIdle() had already nulled `gameId`, MOVE_PROVEN's
 * `msg.gameId === this.gameId` guard failed, and the proof was dropped. The
 * journal froze at 8 of 9 — so if the winner then walked away, the loser could
 * never claim the game, which is exactly the case claim_abandoned_game's
 * n == 9 branch was added to serve. Observed on production: the bot finished a
 * completed game holding 8 proofs.
 *
 * The NOTE_DATA handler one case above already carries this reasoning verbatim
 * for returned cards. MOVE_PROVEN did not.
 */
describe('ArenaBot late move proofs from the opponent', () => {
  function journalSpy() {
    const store = new Map<string, any>();
    return {
      store,
      journal: {
        read: (id: string) => store.get(id) ?? null,
        write: (rec: any) => { store.set(rec.onChainGameId, rec); },
        forget: (id: string) => { store.delete(id); },
        markSettled: (id: string) => {
          const rec = store.get(id);
          if (rec) store.set(id, { ...rec, settled: true });
        },
      },
    };
  }

  /**
   * Play to a loss, leaving the journal one proof short — the production shape.
   *
   * The clock is MUTABLE here. Elsewhere in this file `now` is a constant,
   * which is fine when nothing under test reads a deadline — but the late-proof
   * window is a deadline, and against a frozen clock it never expires no matter
   * how far vitest's timers advance.
   */
  async function playToLoss() {
    let clock = 1_000_000;
    const advanceClock = (ms: number) => { clock += ms; };
    const socket = new FakeSocket();
    const f = fakeChain();
    const j = journalSpy();
    const proofs = {
      cardCommitHash: async () => FIELD(0x1),
      verificationKeys: async () => ({ handVk: new Uint8Array([1]), moveVk: new Uint8Array([2]) }),
      proveHand: async () => ({ proof: 'p', publicInputs: ['a', 'b'], cardCommit: FIELD(0x1) }),
      proveMove: async () => ({ proof: 'p', publicInputs: [], startStateHash: 'mine' }),
    };
    const bot = new ArenaBot(makeConfig(), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, proofs: proofs as any, journal: j.journal,
      log: () => {}, now: () => clock,
    });
    bot.start();
    socket.emit('open');
    socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(1_000);
    socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(socket);
    socket.deliver({ type: 'HAND_PROOF', gameId: 'g1', fromPlayer: 1, handProof: { proof: 'q', publicInputs: [], cardCommit: FIELD(0x2) } });
    await vi.advanceTimersByTimeAsync(50);

    // Eight of the nine proofs are in before the game ends.
    for (let i = 0; i < 8; i++) {
      socket.deliver({
        type: 'MOVE_PROVEN', gameId: 'g1',
        moveProof: { proof: 'p', publicInputs: [], startStateHash: `s${i}` },
      });
    }
    await vi.advanceTimersByTimeAsync(20);

    socket.deliver({
      type: 'GAME_OVER', gameId: 'g1', winner: 'player1', gameState: freshState(),
      player1CardIds: [1, 2, 3, 4, 5], player2CardIds: [6, 7, 8, 9, 10],
    });
    await vi.advanceTimersByTimeAsync(50);
    return { socket, bot, j, advanceClock };
  }

  const record = (j: ReturnType<typeof journalSpy>) => [...j.store.values()][0];

  it('the journal is one proof short when the game ends — the state this fixes', async () => {
    const h = await playToLoss();
    expect(h.bot.getStats().state, 'a loss resets to idle').not.toBe('playing');
    expect(record(h.j).moveProofs).toHaveLength(8);
    h.bot.stop();
  });

  it('absorbs the ninth proof that lands after GAME_OVER', async () => {
    const h = await playToLoss();

    // The winner's final move proof, arriving from a browser that was still
    // proving when the relay called the game.
    h.socket.deliver({
      type: 'MOVE_PROVEN', gameId: 'g1',
      moveProof: { proof: 'p', publicInputs: [], startStateHash: 'final' },
    });
    await vi.advanceTimersByTimeAsync(20);

    const rec = record(h.j);
    expect(rec.moveProofs, 'without this the loser can never claim a completed game').toHaveLength(9);
    expect(rec.moveProofs.map((p: any) => p.startStateHash)).toContain('final');
    h.bot.stop();
  });

  it('does not double-count a proof the relay redelivers', async () => {
    const h = await playToLoss();
    const dup = { proof: 'p', publicInputs: [], startStateHash: 'final' };
    h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: dup });
    h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: dup });
    await vi.advanceTimersByTimeAsync(20);
    expect(record(h.j).moveProofs).toHaveLength(9);
    h.bot.stop();
  });

  it('ignores a proof for a game it never played', async () => {
    const h = await playToLoss();
    h.socket.deliver({
      type: 'MOVE_PROVEN', gameId: 'someone-elses-game',
      moveProof: { proof: 'p', publicInputs: [], startStateHash: 'final' },
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(record(h.j).moveProofs).toHaveLength(8);
    h.bot.stop();
  });

  it('stops absorbing once the window has passed', async () => {
    // A proof this late is not the game-ending one; accepting it would write a
    // record whose contents no longer match any transcript we can reason about.
    const h = await playToLoss();
    h.advanceClock(16 * 60_000);
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    h.socket.deliver({
      type: 'MOVE_PROVEN', gameId: 'g1',
      moveProof: { proof: 'p', publicInputs: [], startStateHash: 'final' },
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(record(h.j).moveProofs).toHaveLength(8);
    h.bot.stop();
  });
});

/**
 * The worklist has to say when a game is mid-recovery.
 *
 * A claim is followed by a ten-minute dispute window. During it the record is
 * unsettled, old enough, and has both hand proofs — so every "why is this
 * stuck" test passed and the entry reported nothing blocking it, which reads
 * as "nobody has touched this". For the ten minutes the state matters most,
 * the worklist said the opposite of the truth.
 */
describe('ArenaBot worklist reports a claim in progress', () => {
  const withJournal = (rec: any) => {
    const socket = new FakeSocket();
    const bot = new ArenaBot(makeConfig(), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 0, oldestWaitMs: 0, entries: [] }),
      journal: { outstanding: () => [rec], read: () => rec, write: () => {}, forget: () => {}, markSettled: () => {} } as any,
      log: () => {}, now: () => 2_000_000_000,
    });
    return bot;
  };

  const base = {
    onChainGameId: '0xabc',
    committedAt: 2_000_000_000 - 7200_000,   // two hours old: past the bar
    myHandProof: { proof: 'p' }, opponentHandProof: { proof: 'q' },
    moveProofs: Array(9).fill({ proof: 'm' }),
  };

  it('says the dispute window is running, not that nothing is blocking it', () => {
    const bot = withJournal({ ...base, claimedAt: 2_000_000_000 / 1000 - 120 });
    const [entry] = bot.getStats().journal;
    expect(entry.blockedBy).toMatch(/dispute window/);
    expect(entry.blockedBy).not.toBeNull();
  });

  it('says only that the window has passed — not that a settle is under way', () => {
    // Elapsed time is all claimedAt can tell us. Reporting "settling" would
    // read the same whether the sweep was working or had died.
    const bot = withJournal({ ...base, claimedAt: 2_000_000_000 / 1000 - 900 });
    expect(bot.getStats().journal[0].blockedBy).toBe('claimed — dispute window passed');
  });

  it('still reports an unclaimed, old-enough game as ready', () => {
    const bot = withJournal({ ...base });
    expect(bot.getStats().journal[0].blockedBy).toBeNull();
  });
});
