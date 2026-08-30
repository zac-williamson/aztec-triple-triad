import { describe, it, expect, afterEach } from 'vitest';
import { startHealthServer, type HealthServer } from '../src/health.js';
import type { ArenaBot } from '../src/ArenaBot.js';

const PORT = 5399 + Math.floor(Math.random() * 500);
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

const get = async (path: string) => {
  const res = await fetch(`http://localhost:${PORT}${path}`);
  return { status: res.status, body: await res.json() as any };
};

describe('bot health endpoint', () => {
  it('reports healthy for an idle bot with no failures', async () => {
    running = startHealthServer(stubBot(), PORT);
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
    running = startHealthServer(stubBot({
      proofFailures: 2, commitFailures: 1, abandonedGames: 3, cardsStranded: 15,
      lastError: 'prove-hand: boom',
    }), PORT);
    const { body } = await get('/metrics');
    expect(body.healthy).toBe(false);
    expect(body.totalFailures).toBe(3);
    expect(body.abandonedGames).toBe(3);
    expect(body.cardsStranded).toBe(15);
    expect(body.lastError).toBe('prove-hand: boom');
  });

  it('serves the same payload on /health and /metrics', async () => {
    running = startHealthServer(stubBot({ gamesPlayed: 4 }), PORT);
    const a = await get('/health');
    const b = await get('/metrics');
    expect(a.body.gamesPlayed).toBe(4);
    expect(b.body.gamesPlayed).toBe(4);
  });

  it('404s anything else rather than leaking a default', async () => {
    running = startHealthServer(stubBot(), PORT);
    const { status } = await get('/secrets');
    expect(status).toBe(404);
  });

  it('never exposes keys or card contents', async () => {
    running = startHealthServer(stubBot({ lastOnChainGameId: '0xabc' }), PORT);
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
    const body = await (await fetch(`http://localhost:${port}/health`)).json();
    await srv.close();

    // An out-of-cards bot idles, which is correct and indistinguishable from a
    // quiet night — so the count has to be visible from outside the process.
    expect(body.spendableCards).toBe(7);
    expect(body.healthy).toBe(true);
  });
});
