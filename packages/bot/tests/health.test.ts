import { describe, it, expect, afterEach } from 'vitest';
import { startHealthServer, type HealthServer } from '../src/health.js';
import { ArenaBot } from '../src/ArenaBot.js';
import { EventEmitter } from 'events';

// A fresh OS-assigned port per test, not one fixed port for the whole file.
// Servers that start and stop around each test on the SAME port leave undici
// holding a keep-alive socket to a server that has since closed, and the next
// request on it fails with "other side closed" — an intermittent CI failure
// with nothing wrong in the code under test. It duly failed a CI run.
let running: HealthServer | null = null;
afterEach(async () => { await running?.close(); running = null; });

/** A bot stub returning whatever stats a test needs. */
const stubBot = (over: Partial<ReturnType<ArenaBot['getStats']>> = {}) => ({
  getStats: () => ({
    state: 'idle', gamesPlayed: 0, wins: 0, losses: 0, draws: 0,
    joinFailures: 0, moveFailures: 0, commitFailures: 0, proofFailures: 0,
    settleFailures: 0, settlements: 0, lastOnChainGameId: null,
    abandonedGames: 0, cardsStranded: 0, lastError: null, ...over,
  }),
}) as unknown as ArenaBot;

/** Start a server on an ephemeral port; returns a `get` bound to it. */
async function serve(bot: ArenaBot) {
  running = startHealthServer(bot, 0);
  const port = await running.ready;
  return async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.json() as any };
  };
}

describe('bot health endpoint', () => {
  it('reports healthy for an idle bot with no failures', async () => {
    const get = await serve(stubBot());
    const { status, body } = await get('/health');
    expect(status).toBe(200);
    // An idle bot is the NORMAL state when nobody is queuing — alerting on it
    // would train people to ignore the alert.
    expect(body.healthy).toBe(true);
    expect(body.state).toBe('idle');
    expect(body.totalFailures).toBe(0);
    expect(typeof body.uptimeMs).toBe('number');
  });

  it('surfaces the counters an operator needs to see a breakage', async () => {
    const get = await serve(stubBot({
      proofFailures: 2, commitFailures: 1, abandonedGames: 3, cardsStranded: 15,
      lastError: 'prove-hand: boom',
    }));
    const { body } = await get('/metrics');
    expect(body.healthy).toBe(false);
    expect(body.totalFailures).toBe(3);
    expect(body.abandonedGames).toBe(3);
    expect(body.cardsStranded).toBe(15);
    expect(body.lastError).toBe('prove-hand: boom');
  });

  it('serves the same payload on /health and /metrics', async () => {
    const get = await serve(stubBot({ gamesPlayed: 4 }));
    const a = await get('/health');
    const b = await get('/metrics');
    expect(a.body.gamesPlayed).toBe(4);
    expect(b.body.gamesPlayed).toBe(4);
  });

  it('404s anything else rather than leaking a default', async () => {
    const get = await serve(stubBot());
    const { status } = await get('/secrets');
    expect(status).toBe(404);
  });

  it('never exposes keys or card contents', async () => {
    const get = await serve(stubBot({ lastOnChainGameId: '0xabc' }));
    const { body } = await get('/health');
    const keys = Object.keys(body).join(',');
    expect(keys).not.toMatch(/secret|salt|signingKey|cardIds|hand/i);
  });
});

describe('health surfaces the number that predicts going idle', () => {
  it('reports spendableCards so an alert can fire BEFORE the bot goes quiet', async () => {
    const bot = {
      getStats: () => ({
        state: 'idle', gamesPlayed: 0, wins: 0, losses: 0, draws: 0,
        joinFailures: 0, moveFailures: 0, commitFailures: 0, proofFailures: 0,
        settleFailures: 0, settlements: 0, lastOnChainGameId: null,
        abandonedGames: 0, cardsStranded: 0, spendableCards: 7, lastError: null,
      }),
    } as unknown as import('../src/ArenaBot.js').ArenaBot;

    const srv = startHealthServer(bot, 0);
    const port = (srv.server.address() as { port: number }).port;
    const body = await (await fetch(`http://localhost:${port}/health`)).json() as Record<string, unknown>;
    await srv.close();

    // An out-of-cards bot idles, which is correct and indistinguishable from a
    // quiet night — so the count has to be visible from outside the process.
    expect(body.spendableCards).toBe(7);
    expect(body.healthy).toBe(true);
  });
});

describe('consumables at startup', () => {
  /**
   * Both numbers used to be refreshed only when the bot picked a hand, so a bot
   * that had not been matched since restart reported -1 for each and the health
   * probe went green while blind to the two things that actually end the arena.
   */
  it('reports cards and fee juice without waiting for a match', async () => {
    const socket = new EventEmitter() as any;
    socket.readyState = 1; socket.send = () => {}; socket.close = () => {};
    const bot = new ArenaBot(
      {
        wsUrl: 'ws://t', httpUrl: 'http://t', token: 't', joinThresholdMs: 1_000,
        pollIntervalMs: 10_000, queueTimeoutMs: 60_000, handCardIds: [1, 2, 3, 4, 5],
        difficulty: 'greedy', skillMin: 1, skillMax: 1, moveDelayMs: 0,
        maxConcurrentGames: 1, chainTxTimeoutMs: 1, settleWaitMs: 0,
        sweepIntervalMs: 900_000, drawFallbackMs: 0, gameTimeoutMs: 1, healthPort: 0,
      } as never,
      {
        connect: () => socket,
        fetchQueue: async () => ({ length: 0, oldestWaitMs: 0, entries: [] }),
        chain: {
          address: '0xbot',
          selectHand: async () => [1, 2, 3, 4, 5],
          readCards: async () => Array.from({ length: 1382 }, (_, i) => i % 12),
          readFeeJuice: async () => 953447137296251479537n,
          pxe: {},
        } as never,
        log: () => {},
      },
    );
    bot.start();
    await new Promise(r => setTimeout(r, 50));
    bot.stop();

    expect(bot.getStats().spendableCards).toBe(1382);
    expect(bot.getStats().feeJuice).toBe('953447137296251479537');
  });
});
