/**
 * Matchmaking selection rules.
 *
 * These matter far more once a POOL of arena bots watches the queue. Popping the
 * first two entries blindly pairs two BOTS: both wager five real cards, play a
 * full game, and one takes a card from the other — pure waste, and it consumes
 * the slot the waiting human was supposed to get.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { GameManager } from '../src/GameManager.js';
import { MemoryGameStore } from '../src/store/MemoryGameStore.js';

const CARDS_A = [1, 2, 3, 4, 5];
const CARDS_B = [6, 7, 8, 9, 10];

describe('GameManager.tryMatch', () => {
  let manager: GameManager;
  const bots = new Set<string>();
  const isBot = (id: string) => bots.has(id);

  beforeEach(() => {
    manager = new GameManager(new MemoryGameStore());
    bots.clear();
  });

  async function queue(...ids: string[]) {
    for (const id of ids) await manager.queuePlayer(id, id.startsWith('bot') ? CARDS_B : CARDS_A);
  }
  const live = (...ids: string[]) => new Set(ids);

  it('matches two humans, oldest as creator', async () => {
    await queue('human-1', 'human-2');
    const m = await manager.tryMatch(live('human-1', 'human-2'), isBot);
    expect(m?.entry1.playerId).toBe('human-1');
    expect(m?.entry2.playerId).toBe('human-2');
  });

  it('never pairs two bots', async () => {
    bots.add('bot-0'); bots.add('bot-1');
    await queue('bot-0', 'bot-1');

    // A bot exists to give a HUMAN an opponent. Two of them playing each other
    // burns ten committed cards and serves nobody.
    expect(await manager.tryMatch(live('bot-0', 'bot-1'), isBot)).toBeNull();
    // and both stay queued for a human who might still arrive
    expect(await manager.getQueueLength()).toBe(2);
  });

  it('puts the human in the CREATOR slot when matched with a bot', async () => {
    bots.add('bot-0');
    await queue('bot-0', 'human-1');   // bot queued FIRST

    const m = await manager.tryMatch(live('bot-0', 'human-1'), isBot);

    // Order alone would have made the bot the creator, and creating wagers five
    // cards on a game nobody may join.
    expect(m?.entry1.playerId).toBe('human-1');
    expect(m?.entry2.playerId).toBe('bot-0');
  });

  it('prefers a human opponent over a bot for a waiting human', async () => {
    bots.add('bot-0');
    await queue('human-1', 'bot-0', 'human-2');

    const m = await manager.tryMatch(live('human-1', 'bot-0', 'human-2'), isBot);

    // Two humans waiting should play EACH OTHER, not each take a bot — the bot
    // is a fallback for an empty queue, not a competitor for players.
    expect([m?.entry1.playerId, m?.entry2.playerId]).toEqual(['human-1', 'human-2']);
    expect(await manager.getQueueLength()).toBe(1);
  });

  it('matches a lone human with a bot', async () => {
    bots.add('bot-0');
    await queue('human-1', 'bot-0');
    const m = await manager.tryMatch(live('human-1', 'bot-0'), isBot);
    expect(m?.entry1.playerId).toBe('human-1');
    expect(m?.entry2.playerId).toBe('bot-0');
  });

  it('matches one human against one of several queued bots, leaving the rest', async () => {
    bots.add('bot-0'); bots.add('bot-1'); bots.add('bot-2');
    await queue('bot-0', 'bot-1', 'human-1', 'bot-2');

    const m = await manager.tryMatch(live('bot-0', 'bot-1', 'human-1', 'bot-2'), isBot);
    expect(m?.entry1.playerId).toBe('human-1');
    expect(bots.has(m!.entry2.playerId)).toBe(true);

    // The two remaining bots must not then pair off with each other.
    expect(await manager.tryMatch(live('bot-0', 'bot-1', 'bot-2'), isBot)).toBeNull();
  });

  it('does not match a disconnected player', async () => {
    await queue('human-1', 'human-2');
    // human-2 dropped: matching them would open a game nobody is in.
    expect(await manager.tryMatch(live('human-1'), isBot)).toBeNull();
  });

  it('needs two players', async () => {
    await queue('human-1');
    expect(await manager.tryMatch(live('human-1'), isBot)).toBeNull();
    expect(await manager.getQueueLength()).toBe(1);
  });

  it('removes both matched players from the queue', async () => {
    await queue('human-1', 'human-2', 'human-3');
    await manager.tryMatch(live('human-1', 'human-2', 'human-3'), isBot);
    const remaining = await manager.queueSnapshot();
    expect(remaining.entries.map(e => e.playerId)).toEqual(['human-3']);
  });

  it('treats everyone as human when no predicate is supplied', async () => {
    await queue('a', 'b');
    const m = await manager.tryMatch(live('a', 'b'));
    expect(m?.entry1.playerId).toBe('a');
  });
});

describe('server declines a redundant bot offer', () => {
  it('reports botsQueued and humansWaiting, counting oldestWaitMs over humans only', async () => {
    const manager = new GameManager(new MemoryGameStore());
    const bots = new Set(['bot-0']);
    await manager.queuePlayer('bot-0', CARDS_B);
    await manager.queuePlayer('human-1', CARDS_A);
    // Read from 10s in the future: waitMs clamps at 0, so a `now` in the past
    // would make every wait zero and the assertion vacuous.
    const now = Date.now() + 10_000;

    const snap = await manager.queueSnapshot(now, id => bots.has(id));

    expect(snap.humansWaiting).toBe(1);
    expect(snap.botsQueued).toBe(1);
    expect(snap.entries.find(e => e.playerId === 'bot-0')!.isBot).toBe(true);
    // A bot sitting in the queue must never be what makes ANOTHER bot offer:
    // oldestWaitMs is "how long has the person I would rescue been waiting".
    const human = snap.entries.find(e => e.playerId === 'human-1')!;
    expect(snap.oldestWaitMs).toBe(now - human.queuedAt);
    // …and strictly less than the bot's wait, which is older and must not count.
    const bot = snap.entries.find(e => e.playerId === 'bot-0')!;
    expect(snap.oldestWaitMs).toBeLessThanOrEqual(bot.waitMs);
  });

  it('reports zero wait when only bots are queued', async () => {
    const manager = new GameManager(new MemoryGameStore());
    await manager.queuePlayer('bot-0', CARDS_B);
    const snap = await manager.queueSnapshot(Date.now(), () => true);
    expect(snap.oldestWaitMs).toBe(0);
    expect(snap.humansWaiting).toBe(0);
  });
});
