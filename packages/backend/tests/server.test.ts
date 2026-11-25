import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import http from 'http';
import crypto from 'crypto';
import { createServer, type CardGameServer } from '../src/server.js';
import { MemoryGameStore } from '../src/store/MemoryGameStore.js';
import * as metrics from '../src/metrics.js';
import type { ServerMessage, ClientMessage } from '../src/types.js';

// Skip session establishment messages when filtering for game messages
const isSessionMsg = (m: ServerMessage) => m.type === 'SESSION_ESTABLISHED';

let server: CardGameServer;
let port: number;

function getUrl(p: number = port): string {
  return `ws://localhost:${p}`;
}

function getHttpUrl(): string {
  return `http://localhost:${port}`;
}

/** Create a client and wait for SESSION_ESTABLISHED before resolving. */
function createClient(): Promise<WebSocket> {
  return createClientWithSession().then(r => r.ws);
}

/** Create a client and return both the WebSocket and session token. */
function createClientWithSession(p: number = port): Promise<{ ws: WebSocket; sessionToken: string; playerId: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getUrl(p));
    ws.on('error', reject);
    ws.on('message', function onFirst(data: WebSocket.Data) {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'SESSION_ESTABLISHED') {
        ws.removeListener('message', onFirst);
        resolve({ ws, sessionToken: msg.sessionToken, playerId: msg.playerId });
      }
    });
  });
}

function sendMessage(ws: WebSocket, msg: ClientMessage): void {
  ws.send(JSON.stringify(msg));
}

// Buffered message collector that ensures no messages are lost.
// Automatically skips SESSION_ESTABLISHED messages.
class MessageCollector {
  private buffer: ServerMessage[] = [];
  private waiters: { filter?: (msg: ServerMessage) => boolean; resolve: (msg: ServerMessage) => void; reject: (err: Error) => void; timeout: NodeJS.Timeout }[] = [];
  /** Every message received, in arrival order, whether or not a wait consumed it. */
  readonly log: ServerMessage[] = [];
  public sessionToken: string | null = null;

  constructor(private ws: WebSocket) {
    ws.on('message', (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      // Capture session token but don't buffer session messages
      if (msg.type === 'SESSION_ESTABLISHED') {
        this.sessionToken = (msg as any).sessionToken;
        return;
      }
      if (isSessionMsg(msg)) return;
      this.log.push(msg);
      // Check if any waiter matches
      for (let i = 0; i < this.waiters.length; i++) {
        const waiter = this.waiters[i];
        if (!waiter.filter || waiter.filter(msg)) {
          this.waiters.splice(i, 1);
          clearTimeout(waiter.timeout);
          waiter.resolve(msg);
          return;
        }
      }
      // No waiter matched, buffer it
      this.buffer.push(msg);
    });
  }

  wait(filter?: (msg: ServerMessage) => boolean): Promise<ServerMessage> {
    // Check buffer first
    for (let i = 0; i < this.buffer.length; i++) {
      if (!filter || filter(this.buffer[i])) {
        return Promise.resolve(this.buffer.splice(i, 1)[0]);
      }
    }
    // Wait for future message
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for message')), 5000);
      this.waiters.push({ filter, resolve, reject, timeout });
    });
  }

  /** Whether a matching message arrived and is still unconsumed. Does not consume it. */
  has(filter: (msg: ServerMessage) => boolean): boolean {
    return this.buffer.some(filter);
  }
}

/** True if nothing matching `filter` reaches `c` within `ms` (no waiter may be pending on it). */
async function staysQuiet(c: MessageCollector, filter: (msg: ServerMessage) => boolean, ms = 200): Promise<boolean> {
  await new Promise(r => setTimeout(r, ms));
  return !c.has(filter);
}

type MoveMsg = Extract<ServerMessage, { type: 'MOVE' }>;
const isMove = (m: ServerMessage): m is MoveMsg => m.type === 'MOVE';
/** The move numbers a collector has received, in arrival order. */
const movesIn = (c: MessageCollector): number[] => c.log.filter(isMove).map(m => m.moveNumber);

/** A sealed payload of realistic shape: a 12-byte IV and a few hundred bytes of ciphertext. */
function sealed(): { iv: string; ciphertext: string } {
  return { iv: crypto.randomBytes(12).toString('base64'), ciphertext: crypto.randomBytes(300).toString('base64') };
}

/**
 * Two connected players matched into one room, each with a collector. Both
 * queue with nothing but QUEUE_MATCHMAKING; the first to queue is player 1.
 */
async function seatTwoPlayers(p: number = port) {
  const p1 = await createClientWithSession(p);
  const p2 = await createClientWithSession(p);
  const c1 = new MessageCollector(p1.ws);
  const c2 = new MessageCollector(p2.ws);
  sendMessage(p1.ws, { type: 'QUEUE_MATCHMAKING' });
  await c1.wait((m) => m.type === 'MATCHMAKING_QUEUED');
  sendMessage(p2.ws, { type: 'QUEUE_MATCHMAKING' });
  await c2.wait((m) => m.type === 'MATCHMAKING_QUEUED');
  const found1 = await c1.wait((m) => m.type === 'MATCH_FOUND') as Extract<ServerMessage, { type: 'MATCH_FOUND' }>;
  const found2 = await c2.wait((m) => m.type === 'MATCH_FOUND') as Extract<ServerMessage, { type: 'MATCH_FOUND' }>;
  expect(found1.playerNumber).toBe(1);
  expect(found2.playerNumber).toBe(2);
  expect(found2.gameId).toBe(found1.gameId);
  return { p1, p2, c1, c2, gameId: found1.gameId };
}

type Seated = Awaited<ReturnType<typeof seatTwoPlayers>>;

/**
 * Send MOVE `n` from the player who owns it (player 1 at even numbers, player 2
 * at odd) and resolve with what the opponent received.
 */
async function playMove(s: Seated, n: number, payload = sealed()): Promise<MoveMsg> {
  const [from, to] = n % 2 === 0 ? [s.p1.ws, s.c2] : [s.p2.ws, s.c1];
  sendMessage(from, { type: 'MOVE', gameId: s.gameId, moveNumber: n, ...payload });
  return await to.wait((m) => isMove(m) && m.moveNumber === n) as MoveMsg;
}

/** Play moves `from` up to (not including) `to`. */
async function playMoves(s: Seated, from: number, to: number): Promise<void> {
  for (let n = from; n < to; n++) await playMove(s, n);
}

/** Both players report their commit mined: the game is on-chain and the turn clock starts. */
async function confirmCommits(s: Seated): Promise<void> {
  sendMessage(s.p1.ws, { type: 'TX_CONFIRMED', gameId: s.gameId, txType: 'create_game' });
  for (const c of [s.c1, s.c2]) await c.wait((m) => m.type === 'ON_CHAIN_STATUS');
  sendMessage(s.p2.ws, { type: 'TX_CONFIRMED', gameId: s.gameId, txType: 'join_game' });
  for (const c of [s.c1, s.c2]) await c.wait((m) => m.type === 'ON_CHAIN_STATUS');
}

function closeAll(...sockets: WebSocket[]): void {
  for (const ws of sockets) ws.close();
}

/**
 * Reconnect with a session token. The collector is attached before the
 * handshake, so it sees everything the server replays on resume.
 */
async function resumeSession(sessionToken: string, p: number = port): Promise<{ ws: WebSocket; c: MessageCollector; resumed: boolean; gameId: string | null }> {
  const ws = new WebSocket(getUrl(p));
  const c = new MessageCollector(ws);
  const established = await new Promise<{ resumed: boolean; gameId: string | null }>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'RESUME', sessionToken })));
    ws.on('message', function onMsg(data: WebSocket.Data) {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'SESSION_ESTABLISHED') {
        ws.removeListener('message', onMsg);
        resolve({ resumed: msg.resumed, gameId: msg.gameId });
      }
    });
  });
  return { ws, c, ...established };
}

// Wait for a single message, skipping session management messages
function waitForMessage(ws: WebSocket, filter?: (msg: ServerMessage) => boolean): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for message')), 5000);
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      if (isSessionMsg(msg)) return; // Skip session messages
      if (!filter || filter(msg)) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

function httpGet(path: string, p: number = port): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${p}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode!, body: JSON.parse(data) });
      });
    }).on('error', reject);
  });
}

/** Like httpGet, but keeps the response headers — CORS lives there. */
function httpGetRaw(path: string): Promise<{ status: number; headers: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    http.get(`${getHttpUrl()}${path}`, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers as any }));
    }).on('error', reject);
  });
}

async function until(check: () => Promise<boolean> | boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise(r => setTimeout(r, 10));
  }
}

/** Capture (and silence) everything the server writes to the console. */
function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    }),
  );
  return { lines, restore: () => spies.forEach(s => s.mockRestore()) };
}

/** Start an extra relay with its own options; the caller closes it. */
async function startServer(options: Parameters<typeof createServer>[0] = {}): Promise<{ srv: CardGameServer; p: number }> {
  const p = 4300 + Math.floor(Math.random() * 600);
  const srv = createServer({ port: p, sessionHandshakeMs: 50, ...options });
  await new Promise<void>((resolve) => srv.httpServer.listen(p, resolve));
  return { srv, p };
}

beforeEach(async () => {
  port = 3100 + Math.floor(Math.random() * 900);
  server = createServer({ port, sessionHandshakeMs: 50 }); // Fast handshake for tests
  await new Promise<void>((resolve) => {
    server.httpServer.listen(port, resolve);
  });
});

afterEach(async () => {
  await server.close();
});

describe('HTTP REST endpoints', () => {
  it('should return health status', async () => {
    const { status, body } = await httpGet('/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.games).toBe(0);
  });

  describe('/arena-health', () => {
    /**
     * The bot's own /health is localhost-only by design, which leaves the
     * failure that matters most invisible from outside: a bot that is up and
     * cannot play. That state lasted eight hours unnoticed. This endpoint is
     * what an off-box uptime check can watch.
     */
    it('reports the bot unreachable rather than pretending things are fine', async () => {
      // No bot listening in tests, which is exactly the outage case.
      const { status, body } = await httpGet('/arena-health');
      expect(status).toBe(503);
      expect(body.botHealthy).toBe(false);
      expect(body.status).toBe('bot-unreachable');
    });

    it('can be read from anywhere — a dashboard is the point', async () => {
      // Every other route is origin-allowlisted. This one cannot be, or it
      // cannot be watched from a phone or a hosted checker.
      const { headers } = await httpGetRaw('/arena-health');
      expect(headers['access-control-allow-origin']).toBe('*');
    });

    it('never leaks anything a stranger should not have', async () => {
      const { body } = await httpGet('/arena-health');
      const keys = Object.keys(body).join(',');
      // Addresses, card ids and raw error text can all name a player or a game.
      expect(keys).not.toMatch(/address|cardIds|hand|secret|key|lastError/i);
    });
  });

  it('no longer lists rooms: GET /games is gone', async () => {
    // Nothing used it, and it handed every room id to anyone who asked.
    const { status } = await httpGet('/games');
    expect(status).toBe(404);
  });

  it('should return 404 for unknown routes', async () => {
    const { status } = await httpGet('/unknown');
    expect(status).toBe(404);
  });

  it('should return 404 for unknown game', async () => {
    const { status, body } = await httpGet('/games/nonexistent');
    expect(status).toBe(404);
    expect(body.error).toBe('Game not found');
  });
});

/**
 * The endpoint with a bot actually answering behind it.
 *
 * The rest of the suite runs with no bot listening, which only ever exercises
 * the 503 branch — so the passthrough could drop every interesting field and
 * stay green. It did: for a while this reported seven booleans and counters,
 * none of which could answer "what is the bot doing right now", and answering
 * that meant SSHing to the box and grepping a journal.
 */
describe('/arena-health with a bot behind it', () => {
  let bot: http.Server;
  let botPort: number;
  let relay: CardGameServer;
  let relayPort: number;
  let previousEnv: string | undefined;

  // Everything the bot's own /health serves, so the test fails if the relay
  // stops forwarding a field rather than silently thinning the payload.
  const BOT_HEALTH = {
    healthy: true,
    uptimeMs: 987_000,
    state: 'playing',
    spendableCards: 952,
    cardsStranded: 0,
    cardsUnimported: 0,
    totalFailures: 0,
    lastError: null,
    feeJuice: '832976136304307151998',
    gamesPlayed: 12, wins: 7, losses: 4, draws: 1,
    settlements: 12, abandonedGames: 0,
    joinFailures: 0, moveFailures: 0, commitFailures: 0,
    proofFailures: 0, settleFailures: 0,
    game: {
      onChainGameId: '0x1234abcd',
      relayGameId: 'relay-session-should-not-escape',
      playerNumber: 2,
      committed: true,
      moveProofs: 5,
      myHandProof: true,
      opponentHandProof: true,
      oweAMove: false,
      opponentGoneFor: null,
      ageSeconds: 143,
      settling: false,
    },
    journal: [
      { onChainGameId: '0xdeadbeef', moveProofs: 9, settled: false, ageSeconds: 900, blockedBy: 'too young (45min to go)' },
    ],
  };

  beforeEach(async () => {
    bot = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(BOT_HEALTH));
    });
    await new Promise<void>(resolve => bot.listen(0, resolve));
    botPort = (bot.address() as any).port;

    previousEnv = process.env.ARENA_BOT_HEALTH_PORT;
    process.env.ARENA_BOT_HEALTH_PORT = String(botPort);
    relayPort = 4100 + Math.floor(Math.random() * 800);
    relay = createServer({ port: relayPort, sessionHandshakeMs: 50 });
    await new Promise<void>(resolve => relay.httpServer.listen(relayPort, resolve));
  });

  afterEach(async () => {
    if (previousEnv === undefined) delete process.env.ARENA_BOT_HEALTH_PORT;
    else process.env.ARENA_BOT_HEALTH_PORT = previousEnv;
    await relay.close();
    bot.closeAllConnections?.();
    await new Promise<void>(resolve => bot.close(() => resolve()));
  });

  const read = (): Promise<any> => new Promise((resolve, reject) => {
    http.get(`http://localhost:${relayPort}/arena-health`, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });

  it('says what the bot is doing right now, not just whether it is alive', async () => {
    const body = await read();
    expect(body.botState).toBe('playing');
    expect(body.game).not.toBeNull();
    expect(body.game.onChainGameId).toBe('0x1234abcd');
    expect(body.game.moveProofs).toBe(5);
    // Both hands proven collapses to a count — the fact, not the proofs.
    expect(body.game.handProofs).toBe(2);
    expect(body.game.ageSeconds).toBe(143);
    expect(body.game.oweAMove).toBe(false);
  });

  it('lists every game still holding cards, and why each is stuck', async () => {
    const body = await read();
    expect(body.journal).toHaveLength(1);
    expect(body.journal[0].onChainGameId).toBe('0xdeadbeef');
    expect(body.journal[0].blockedBy).toBe('too young (45min to go)');
  });

  it('reports Fee Juice in whole units — wei overflows a JS number', async () => {
    // A bot that cannot pay cannot settle, and an unsettled game locks ten
    // cards. It fails the same silent way as running out of cards: idle.
    const body = await read();
    expect(body.feeJuice).toBe(832);
  });

  it('reports null Fee Juice rather than guessing when the bot omits it', async () => {
    // An off-chain bot has no balance at all; inventing a 0 would read as an
    // outage that is not happening.
    const prior = { ...BOT_HEALTH } as any;
    delete (BOT_HEALTH as any).feeJuice;
    try {
      expect((await read()).feeJuice).toBeNull();
    } finally {
      Object.assign(BOT_HEALTH, prior);
    }
  });

  it('names the commit it is running — deploys diverge from the working tree', async () => {
    // Deploying is `git pull` + restart, so the box can be running older code
    // than the tree you are editing. That happened: a bot restarted before a
    // fix landed in a module it imports failed in production with an error
    // string that no longer existed in the source, and nothing short of SSH
    // could show it.
    const body = await read();
    expect(body).toHaveProperty('deployedCommit');
    if (body.deployedCommit !== null) {
      expect(body.deployedCommit).toMatch(/^[0-9a-f]{7,40}$/);
    }
  });

  it('carries the record, the failure breakdown and the relay counts', async () => {
    const body = await read();
    expect(body.record).toMatchObject({ gamesPlayed: 12, wins: 7, losses: 4, draws: 1, settlements: 12 });
    expect(body.failures).toMatchObject({ join: 0, move: 0, commit: 0, proof: 0, settle: 0 });
    expect(body.relay).toMatchObject({ connectedClients: 0, queueLength: 0, activeGames: 0 });
  });

  it('stamps the time it answered, so a reader can tell fresh from frozen', async () => {
    // A dashboard cannot honestly show "12s old" off its own clock; a page left
    // open on a dead connection would keep rendering the last body as current.
    const before = Date.now();
    const body = await read();
    expect(body.generatedAt).toBeGreaterThanOrEqual(before);
    expect(body.generatedAt).toBeLessThanOrEqual(Date.now());
  });

  it('drops the relay session id — it names a socket, not a public game', async () => {
    const body = await read();
    expect(JSON.stringify(body)).not.toContain('relay-session-should-not-escape');
  });

  it('is never cached — a stale body reports the past as the present', async () => {
    const headers = await new Promise<Record<string, any>>((resolve, reject) => {
      http.get(`http://localhost:${relayPort}/arena-health`, res => {
        res.resume();
        res.on('end', () => resolve(res.headers as any));
      }).on('error', reject);
    });
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['access-control-allow-origin']).toBe('*');
  });
});

describe('Room info over HTTP', () => {
  it('says only what a pipe knows: status, move count, who is connected', async () => {
    const s = await seatTwoPlayers();
    const { status, body } = await httpGet(`/games/${s.gameId}`);
    expect(status).toBe(200);
    expect(body).toEqual({ id: s.gameId, status: 'waiting', movesMade: 0, player1Connected: true, player2Connected: true });
    closeAll(s.p1.ws, s.p2.ws);
  });

  it('goes waiting → active → moves-complete', async () => {
    const s = await seatTwoPlayers();
    const info = async () => (await httpGet(`/games/${s.gameId}`)).body;

    // Matched, but nobody can move until both records are on-chain.
    expect(await info()).toMatchObject({ status: 'waiting', movesMade: 0 });
    await confirmCommits(s);
    expect(await info()).toMatchObject({ status: 'active', movesMade: 0 });
    await playMoves(s, 0, 4);
    expect(await info()).toMatchObject({ status: 'active', movesMade: 4 });
    await playMoves(s, 4, 9);
    expect(await info()).toMatchObject({ status: 'moves-complete', movesMade: 9 });

    closeAll(s.p1.ws, s.p2.ws);
  });

  it('shows a player who dropped as disconnected', async () => {
    const s = await seatTwoPlayers();
    s.p2.ws.close();
    await s.c1.wait((m) => m.type === 'OPPONENT_DISCONNECTED');
    expect((await httpGet(`/games/${s.gameId}`)).body).toMatchObject({ player1Connected: true, player2Connected: false });
    s.p1.ws.close();
  });
});

describe('Message validation', () => {
  it('should accept connections', async () => {
    const ws = await createClient();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('should handle invalid JSON', async () => {
    const ws = await createClient();
    ws.send('not json');
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    expect((error as any).message).toBe('Invalid message format');
    ws.close();
  });

  it('should reject messages without a type field', async () => {
    const ws = await createClient();
    ws.send(JSON.stringify({ foo: 'bar' }));
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    expect((error as any).message).toContain('Unknown or missing message type');
    ws.close();
  });

  it('should reject unknown message types', async () => {
    const ws = await createClient();
    ws.send(JSON.stringify({ type: 'UNKNOWN_TYPE' }));
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    expect((error as any).message).toContain('Unknown or missing message type');
    ws.close();
  });

  it('should reject oversized messages (>1MB)', async () => {
    const ws = await createClient();
    ws.send(JSON.stringify({ type: 'PING', padding: 'x'.repeat(1024 * 1024 + 1) }));
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    expect((error as any).message).toContain('too large');
    ws.close();
  });
});

describe('Matchmaking', () => {
  it('matches two players who send nothing but QUEUE_MATCHMAKING', async () => {
    const { ws: ws1 } = await createClientWithSession();
    const { ws: ws2 } = await createClientWithSession();
    const c1 = new MessageCollector(ws1);
    const c2 = new MessageCollector(ws2);

    sendMessage(ws1, { type: 'QUEUE_MATCHMAKING' });
    expect(await c1.wait((m) => m.type === 'MATCHMAKING_QUEUED')).toEqual({ type: 'MATCHMAKING_QUEUED', position: 1 });
    sendMessage(ws2, { type: 'QUEUE_MATCHMAKING' });

    const match1 = await c1.wait((m) => m.type === 'MATCH_FOUND') as any;
    const match2 = await c2.wait((m) => m.type === 'MATCH_FOUND') as any;
    // A room and a seat. No game state: the relay has none to send.
    expect(match1).toEqual({ type: 'MATCH_FOUND', gameId: match1.gameId, playerNumber: 1 });
    expect(match2).toEqual({ type: 'MATCH_FOUND', gameId: match1.gameId, playerNumber: 2 });

    closeAll(ws1, ws2);
  });

  it('ignores the hand an older client still sends: never stored, forwarded or logged', async () => {
    const captured = captureConsole();
    try {
      const p1 = await createClientWithSession();
      const p2 = await createClientWithSession();
      const c1 = new MessageCollector(p1.ws);
      const c2 = new MessageCollector(p2.ws);
      const oldHand = [211, 223, 227, 229, 233];

      p1.ws.send(JSON.stringify({ type: 'QUEUE_MATCHMAKING', cardIds: oldHand }));
      await c1.wait((m) => m.type === 'MATCHMAKING_QUEUED');
      const [entry] = await server.store.listQueue();
      expect(Object.keys(entry).sort()).toEqual(['lastPing', 'playerId', 'queuedAt']);

      // Not even validated: a malformed one is ignored, not refused.
      p2.ws.send(JSON.stringify({ type: 'QUEUE_MATCHMAKING', cardIds: 'not a hand' }));
      const found1 = await c1.wait((m) => m.type === 'MATCH_FOUND') as any;
      const found2 = await c2.wait((m) => m.type === 'MATCH_FOUND') as any;
      for (const found of [found1, found2]) expect(Object.keys(found).sort()).toEqual(['gameId', 'playerNumber', 'type']);

      const room = await server.store.getGame(found1.gameId);
      expect(Object.keys(room!).sort()).toEqual([
        'createdAt', 'id', 'lastActivity', 'lastMoveTimestamp', 'movesMade', 'onChainStatus', 'player1Id', 'player2Id',
      ]);
      const seen = JSON.stringify({ room, queue: (await httpGet('/queue')).body, log: captured.lines });
      expect(seen).not.toContain(oldHand.join(','));
      expect(seen).not.toContain('not a hand');
      expect(seen).not.toMatch(/cardIds/i);

      closeAll(p1.ws, p2.ws);
    } finally {
      captured.restore();
    }
  });

  it('should cancel matchmaking', async () => {
    const ws = await createClient();

    sendMessage(ws, { type: 'QUEUE_MATCHMAKING' });
    await waitForMessage(ws, (m) => m.type === 'MATCHMAKING_QUEUED');

    sendMessage(ws, { type: 'CANCEL_MATCHMAKING' });
    const cancelled = await waitForMessage(ws, (m) => m.type === 'MATCHMAKING_CANCELLED');
    expect(cancelled.type).toBe('MATCHMAKING_CANCELLED');

    ws.close();
  });

  it('refuses to queue a player who is still in a room', async () => {
    const s = await seatTwoPlayers();
    sendMessage(s.p1.ws, { type: 'QUEUE_MATCHMAKING' });
    expect((await s.c1.wait((m) => m.type === 'ERROR') as any).message).toBe('You are already in an active game');
    closeAll(s.p1.ws, s.p2.ws);
  });

  it('lets both players queue again the moment the ninth move is in', async () => {
    const s = await seatTwoPlayers();
    await playMoves(s, 0, 9);

    sendMessage(s.p1.ws, { type: 'QUEUE_MATCHMAKING' });
    expect(await s.c1.wait((m) => m.type === 'MATCHMAKING_QUEUED' || m.type === 'ERROR'))
      .toEqual({ type: 'MATCHMAKING_QUEUED', position: 1 });
    sendMessage(s.p2.ws, { type: 'QUEUE_MATCHMAKING' });
    const again = await s.c2.wait((m) => m.type === 'MATCH_FOUND') as any;
    expect(again.gameId).not.toBe(s.gameId);

    closeAll(s.p1.ws, s.p2.ws);
  });

  it('should skip stale queue entry and match two live players', async () => {
    // Inject a stale queue entry directly into the store (simulates a server
    // restart where the entry persisted but the player disconnected).
    await server.store.pushQueue({
      playerId: 'stale-ghost-player',
      queuedAt: Date.now() - 60_000,
      lastPing: Date.now() - 60_000,
    });

    const { ws: ws1 } = await createClientWithSession();
    const { ws: ws2 } = await createClientWithSession();
    const c1 = new MessageCollector(ws1);
    const c2 = new MessageCollector(ws2);

    // P1 queues — should NOT be paired with the stale entry
    sendMessage(ws1, { type: 'QUEUE_MATCHMAKING' });
    await c1.wait((m) => m.type === 'MATCHMAKING_QUEUED');

    // P2 queues — both live players should be matched together
    sendMessage(ws2, { type: 'QUEUE_MATCHMAKING' });

    const match1 = await c1.wait((m) => m.type === 'MATCH_FOUND') as any;
    const match2 = await c2.wait((m) => m.type === 'MATCH_FOUND') as any;

    expect(match1.gameId).toBe(match2.gameId);
    expect(match1.playerNumber).toBe(1);
    expect(match2.playerNumber).toBe(2);

    closeAll(ws1, ws2);
  });

  it('should skip multiple stale entries and match live players', async () => {
    // Three stale entries — none should pair with live players
    for (let i = 0; i < 3; i++) {
      await server.store.pushQueue({
        playerId: `stale-ghost-${i}`,
        queuedAt: Date.now() - 60_000,
        lastPing: Date.now() - 60_000,
      });
    }

    const { ws: ws1 } = await createClientWithSession();
    const { ws: ws2 } = await createClientWithSession();
    const c1 = new MessageCollector(ws1);
    const c2 = new MessageCollector(ws2);

    sendMessage(ws1, { type: 'QUEUE_MATCHMAKING' });
    await c1.wait((m) => m.type === 'MATCHMAKING_QUEUED');

    sendMessage(ws2, { type: 'QUEUE_MATCHMAKING' });

    const match1 = await c1.wait((m) => m.type === 'MATCH_FOUND') as any;
    const match2 = await c2.wait((m) => m.type === 'MATCH_FOUND') as any;

    expect(match1.gameId).toBe(match2.gameId);

    closeAll(ws1, ws2);
  });

  it('should allow queueing when player has a stale game mapping to a nonexistent game', async () => {
    // Simulate: player had a game mapping, but the game was cleaned up/deleted
    // while the mapping remained (can happen on server restart or crash).
    const { ws, playerId } = await createClientWithSession();

    // Manually insert a stale player→game mapping pointing to a nonexistent game
    await server.store.setPlayerGame(playerId, 'nonexistent-game-id');

    // Player tries to queue — should succeed (stale mapping cleaned up)
    sendMessage(ws, { type: 'QUEUE_MATCHMAKING' });

    const msg = await waitForMessage(ws, (m) =>
      m.type === 'MATCHMAKING_QUEUED' || m.type === 'ERROR'
    );
    expect(msg.type).toBe('MATCHMAKING_QUEUED');

    ws.close();
  });

  it('session RESUME with stale game mapping returns gameId=null', async () => {
    // Create a session, then manually add a stale player→game mapping
    const { ws, sessionToken, playerId } = await createClientWithSession();
    await server.store.setPlayerGame(playerId, 'nonexistent-game-id');
    ws.close();
    await new Promise(r => setTimeout(r, 50));

    // Resume with the same token — SESSION_ESTABLISHED should have gameId=null
    // because the referenced game no longer exists.
    const back = await resumeSession(sessionToken);
    expect(back.resumed).toBe(true);
    expect(back.gameId).toBeNull();
    expect(await staysQuiet(back.c, (m) => m.type === 'ROOM_STATE')).toBe(true);

    back.ws.close();
  });

  it('should deliver MATCH_FOUND to both players even after first matchmaking attempt with stale data', async () => {
    // Even more adversarial: 2 stale entries present when P1 queues.
    // First tryMatch would pop both stale entries together (bad outcome
    // without the fix: game created for 2 dead players).
    // After the fix: stale entries are discarded before matching.
    await server.store.pushQueue({
      playerId: 'stale-A',
      queuedAt: Date.now() - 60_000,
      lastPing: Date.now() - 60_000,
    });
    await server.store.pushQueue({
      playerId: 'stale-B',
      queuedAt: Date.now() - 60_000,
      lastPing: Date.now() - 60_000,
    });

    const { ws: ws1 } = await createClientWithSession();
    const c1 = new MessageCollector(ws1);
    sendMessage(ws1, { type: 'QUEUE_MATCHMAKING' });
    await c1.wait((m) => m.type === 'MATCHMAKING_QUEUED');

    // Give time for any incorrect early match to occur (it shouldn't)
    await new Promise(r => setTimeout(r, 200));

    // Now P2 queues → live pair [P1, P2] should match
    const { ws: ws2 } = await createClientWithSession();
    const c2 = new MessageCollector(ws2);
    sendMessage(ws2, { type: 'QUEUE_MATCHMAKING' });

    const match1 = await c1.wait((m) => m.type === 'MATCH_FOUND') as any;
    const match2 = await c2.wait((m) => m.type === 'MATCH_FOUND') as any;

    expect(match1.gameId).toBe(match2.gameId);
    expect(match1.playerNumber).toBe(1);
    expect(match2.playerNumber).toBe(2);

    closeAll(ws1, ws2);
  });
});

// ── Private games, Phase B: the relay is a pipe (docs/plan/PRIVATE_GAMES.md §6) ──

describe('MOVE relay', () => {
  it('forwards a MOVE to the opponent exactly as sealed, and nothing else a client attaches', async () => {
    const s = await seatTwoPlayers();
    const payload = sealed();

    // Plaintext riding next to the sealed fields must not reach the opponent.
    s.p1.ws.send(JSON.stringify({ type: 'MOVE', gameId: s.gameId, moveNumber: 0, ...payload, cardId: 3, slot: 0, row: 1, col: 1 }));
    expect(await s.c2.wait(isMove)).toEqual({ type: 'MOVE', gameId: s.gameId, moveNumber: 0, ...payload });
    // Never echoed to the sender.
    expect(await staysQuiet(s.c1, (m) => isMove(m) || m.type === 'ERROR')).toBe(true);

    closeAll(s.p1.ws, s.p2.ws);
  });

  it('carries a whole game: nine moves, alternating, each delivered once to the other player', async () => {
    const s = await seatTwoPlayers();
    for (let n = 0; n < 9; n++) {
      const payload = sealed();
      expect(await playMove(s, n, payload)).toEqual({ type: 'MOVE', gameId: s.gameId, moveNumber: n, ...payload });
    }
    expect(movesIn(s.c2)).toEqual([0, 2, 4, 6, 8]);
    expect(movesIn(s.c1)).toEqual([1, 3, 5, 7]);
    for (const c of [s.c1, s.c2]) expect(c.log.some((m) => m.type === 'ERROR')).toBe(false);

    closeAll(s.p1.ws, s.p2.ws);
  });

  it('takes move numbers strictly in order: no skipping ahead, no replays', async () => {
    const s = await seatTwoPlayers();
    const send = (ws: WebSocket, moveNumber: number) =>
      sendMessage(ws, { type: 'MOVE', gameId: s.gameId, moveNumber, ...sealed() });
    const error = async (c: MessageCollector) => (await c.wait((m) => m.type === 'ERROR') as any).message;

    send(s.p1.ws, 1);
    expect(await error(s.c1)).toBe('Invalid move number: expected 0, got 1');
    await playMove(s, 0);
    send(s.p2.ws, 0);
    expect(await error(s.c2)).toBe('Invalid move number: expected 1, got 0');
    send(s.p2.ws, 3);
    expect(await error(s.c2)).toBe('Invalid move number: expected 1, got 3');
    await playMove(s, 1);

    // Only the two accepted moves went anywhere.
    expect(await staysQuiet(s.c2, isMove)).toBe(true);
    expect(movesIn(s.c2)).toEqual([0]);
    expect(movesIn(s.c1)).toEqual([1]);
    expect((await server.store.getGame(s.gameId))!.movesMade).toBe(2);

    closeAll(s.p1.ws, s.p2.ws);
  });

  it('takes each move only from the player whose turn it is: player 1 even, player 2 odd', async () => {
    const s = await seatTwoPlayers();

    sendMessage(s.p2.ws, { type: 'MOVE', gameId: s.gameId, moveNumber: 0, ...sealed() });
    expect((await s.c2.wait((m) => m.type === 'ERROR') as any).message).toBe('Not your turn');
    await playMove(s, 0);
    sendMessage(s.p1.ws, { type: 'MOVE', gameId: s.gameId, moveNumber: 1, ...sealed() });
    expect((await s.c1.wait((m) => m.type === 'ERROR') as any).message).toBe('Not your turn');
    await playMove(s, 1);

    expect(await staysQuiet(s.c1, isMove)).toBe(true);
    expect(movesIn(s.c1)).toEqual([1]);
    expect(movesIn(s.c2)).toEqual([0]);

    closeAll(s.p1.ws, s.p2.ws);
  });

  it('refuses a MOVE from someone not in the room, and for a room that does not exist', async () => {
    const s = await seatTwoPlayers();
    const outsider = await createClient();
    const co = new MessageCollector(outsider);

    sendMessage(outsider, { type: 'MOVE', gameId: s.gameId, moveNumber: 0, ...sealed() });
    expect((await co.wait((m) => m.type === 'ERROR') as any).message).toBe('Not in this game');
    sendMessage(outsider, { type: 'MOVE', gameId: 'no-such-game', moveNumber: 0, ...sealed() });
    expect((await co.wait((m) => m.type === 'ERROR') as any).message).toBe('Game not found');

    for (const c of [s.c1, s.c2]) expect(await staysQuiet(c, isMove)).toBe(true);
    expect((await server.store.getGame(s.gameId))!.movesMade).toBe(0);

    closeAll(outsider, s.p1.ws, s.p2.ws);
  });

  it('enforces the move number, encoding and size limits, delivering nothing it refuses', async () => {
    const s = await seatTwoPlayers();
    const b64 = (n: number) => 'A'.repeat(n); // valid base64 whenever n % 4 === 0
    const ok = { iv: b64(16), ciphertext: b64(8) };
    const gameId = s.gameId;

    const refused: [Record<string, unknown>, RegExp][] = [
      [{ type: 'MOVE', gameId, ...ok }, /moveNumber/],
      [{ type: 'MOVE', gameId, moveNumber: -1, ...ok }, /moveNumber/],
      [{ type: 'MOVE', gameId, moveNumber: 9, ...ok }, /moveNumber/],
      [{ type: 'MOVE', gameId, moveNumber: 1.5, ...ok }, /moveNumber/],
      [{ type: 'MOVE', gameId, moveNumber: '0', ...ok }, /moveNumber/],
      [{ type: 'MOVE', gameId, moveNumber: null, ...ok }, /moveNumber/],
      [{ type: 'MOVE', moveNumber: 0, ...ok }, /gameId/],
      [{ type: 'MOVE', gameId, moveNumber: 0, iv: b64(68), ciphertext: b64(8) }, /iv/],
      [{ type: 'MOVE', gameId, moveNumber: 0, iv: 'AAA', ciphertext: b64(8) }, /iv/], // unpadded
      [{ type: 'MOVE', gameId, moveNumber: 0, ciphertext: b64(8) }, /iv/],
      [{ type: 'MOVE', gameId, moveNumber: 0, iv: b64(16), ciphertext: b64(64 * 1024 + 4) }, /ciphertext/],
      [{ type: 'MOVE', gameId, moveNumber: 0, iv: b64(16), ciphertext: '' }, /ciphertext/],
      [{ type: 'MOVE', gameId, moveNumber: 0, iv: b64(16), ciphertext: 'not base64!' }, /ciphertext/],
      [{ type: 'MOVE', gameId, moveNumber: 0, iv: b64(16), ciphertext: { sealed: true } }, /ciphertext/],
      [{ type: 'MOVE', gameId, moveNumber: 0, iv: b64(16) }, /ciphertext/],
    ];
    for (const [msg, field] of refused) {
      s.p1.ws.send(JSON.stringify(msg));
      const err = await s.c1.wait((m) => m.type === 'ERROR') as any;
      expect(err.message).toMatch(field);
    }
    expect(await staysQuiet(s.c2, isMove)).toBe(true);
    expect((await server.store.getGame(gameId))!.movesMade).toBe(0);

    // Exactly at each cap is accepted.
    const atCaps = { iv: b64(64), ciphertext: b64(64 * 1024) };
    sendMessage(s.p1.ws, { type: 'MOVE', gameId, moveNumber: 0, ...atCaps });
    expect(await s.c2.wait(isMove)).toEqual({ type: 'MOVE', gameId, moveNumber: 0, ...atCaps });

    closeAll(s.p1.ws, s.p2.ws);
  });

  it('completes the room after move 8 and takes no further MOVE', async () => {
    const s = await seatTwoPlayers();
    await playMoves(s, 0, 9);

    for (const [ws, c] of [[s.p1.ws, s.c1], [s.p2.ws, s.c2]] as const) {
      sendMessage(ws, { type: 'MOVE', gameId: s.gameId, moveNumber: 8, ...sealed() });
      expect((await c.wait((m) => m.type === 'ERROR') as any).message).toBe('All nine moves are already in');
    }
    for (const c of [s.c1, s.c2]) expect(await staysQuiet(c, isMove)).toBe(true);
    expect(movesIn(s.c2)).toEqual([0, 2, 4, 6, 8]);
    expect((await server.store.getGame(s.gameId))!.movesMade).toBe(9);

    closeAll(s.p1.ws, s.p2.ws);
  });

  it('buffers moves for an offline opponent and replays them in order, before ROOM_STATE', async () => {
    const s = await seatTwoPlayers();
    await playMove(s, 0);
    // Player 1 drops; player 2 sends a sealed note and then its move.
    s.p1.ws.close();
    await s.c2.wait((m) => m.type === 'OPPONENT_DISCONNECTED');
    const note = sealed();
    const move = sealed();
    sendMessage(s.p2.ws, { type: 'PEER', gameId: s.gameId, ...note });
    sendMessage(s.p2.ws, { type: 'MOVE', gameId: s.gameId, moveNumber: 1, ...move });

    const expected = [
      { type: 'PEER', gameId: s.gameId, ...note },
      { type: 'MOVE', gameId: s.gameId, moveNumber: 1, ...move },
    ];
    await until(async () => (await server.store.getInbox(s.p1.playerId)).length === 2);
    expect(await server.store.getInbox(s.p1.playerId)).toEqual(expected);
    expect(s.c2.log.some((m) => m.type === 'ERROR')).toBe(false);

    const back = await resumeSession(s.p1.sessionToken);
    expect(back.resumed).toBe(true);
    expect(back.gameId).toBe(s.gameId);
    await back.c.wait((m) => m.type === 'ROOM_STATE');
    expect(back.c.log).toEqual([
      ...expected,
      { type: 'ROOM_STATE', gameId: s.gameId, playerNumber: 1, movesMade: 2, opponentConnected: true },
    ]);
    await until(async () => (await server.store.getInbox(s.p1.playerId)).length === 0);

    // And the game goes on from the returned socket.
    sendMessage(back.ws, { type: 'MOVE', gameId: s.gameId, moveNumber: 2, ...sealed() });
    expect((await s.c2.wait(isMove)).moveNumber).toBe(2);

    closeAll(back.ws, s.p2.ws);
  });

  it('replays on RESUME a move written to a dying socket — neither delivered nor buffered', async () => {
    // The relay's end of each connection, in connection order: player 1's, then player 2's.
    const serverSockets: WebSocket[] = [];
    server.wss.on('connection', (ws: WebSocket) => serverSockets.push(ws));
    const s = await seatTwoPlayers();
    const first = sealed();
    await playMove(s, 0, first);
    await playMove(s, 1);

    // Player 2's connection dies before the relay notices: it still reads
    // OPEN, and what the relay writes to it goes nowhere.
    const dying = serverSockets[1];
    dying.send = (() => {}) as typeof dying.send;
    const lost = sealed();
    sendMessage(s.p1.ws, { type: 'MOVE', gameId: s.gameId, moveNumber: 2, ...lost });
    await until(async () => (await server.store.getGame(s.gameId))!.movesMade === 3);
    // Not buffered either: as far as the relay could tell, it was delivered.
    expect(await server.store.getInbox(s.p2.playerId)).toEqual([]);
    s.p2.ws.close();
    await s.c1.wait((m) => m.type === 'OPPONENT_DISCONNECTED');

    // Back: player 1's moves again, in order — move 0, which it had, and
    // move 2, which it never got — then where the room stands. Never its own
    // move 1: ROOM_STATE is how a client learns which of its own to resend.
    const back = await resumeSession(s.p2.sessionToken);
    await back.c.wait((m) => m.type === 'ROOM_STATE');
    expect(back.c.log).toEqual([
      { type: 'MOVE', gameId: s.gameId, moveNumber: 0, ...first },
      { type: 'MOVE', gameId: s.gameId, moveNumber: 2, ...lost },
      { type: 'ROOM_STATE', gameId: s.gameId, playerNumber: 2, movesMade: 3, opponentConnected: true },
    ]);

    closeAll(back.ws, s.p1.ws);
  });

  it("keeps one sender's messages in order: a PEER sent right after a MOVE arrives after it", async () => {
    // A store whose room lock is slow to take: a MOVE waits on it, a PEER does
    // not, so handling the two concurrently would deliver the PEER first.
    class SlowLockStore extends MemoryGameStore {
      override async acquireGameLock(gameId: string, ttlMs: number): Promise<boolean> {
        await new Promise(r => setTimeout(r, 50));
        return super.acquireGameLock(gameId, ttlMs);
      }
    }
    const { srv, p } = await startServer({ store: new SlowLockStore() });
    try {
      const s = await seatTwoPlayers(p);
      const move = sealed();
      const note = sealed();
      sendMessage(s.p1.ws, { type: 'MOVE', gameId: s.gameId, moveNumber: 0, ...move });
      sendMessage(s.p1.ws, { type: 'PEER', gameId: s.gameId, ...note });

      await s.c2.wait((m) => m.type === 'PEER');
      await s.c2.wait(isMove);
      expect(s.c2.log.filter((m) => m.type === 'MOVE' || m.type === 'PEER')).toEqual([
        { type: 'MOVE', gameId: s.gameId, moveNumber: 0, ...move },
        { type: 'PEER', gameId: s.gameId, ...note },
      ]);

      closeAll(s.p1.ws, s.p2.ws);
    } finally {
      await srv.close();
    }
  });
});

describe('ROOM_STATE on RESUME', () => {
  it('tells a returning player its seat, the move count and whether the opponent is there', async () => {
    const s = await seatTwoPlayers();
    await playMoves(s, 0, 3);
    s.p2.ws.close();
    await s.c1.wait((m) => m.type === 'OPPONENT_DISCONNECTED');

    const back = await resumeSession(s.p2.sessionToken);
    expect(back.gameId).toBe(s.gameId);
    const state = await back.c.wait((m) => m.type === 'ROOM_STATE');
    expect(state).toEqual({ type: 'ROOM_STATE', gameId: s.gameId, playerNumber: 2, movesMade: 3, opponentConnected: true });
    // The other player hears it is back.
    expect(await s.c1.wait((m) => m.type === 'OPPONENT_RECONNECTED')).toEqual({ type: 'OPPONENT_RECONNECTED', gameId: s.gameId });

    closeAll(back.ws, s.p1.ws);
  });

  it('reports an opponent who is offline', async () => {
    const s = await seatTwoPlayers();
    s.p1.ws.close();
    await s.c2.wait((m) => m.type === 'OPPONENT_DISCONNECTED');
    s.p2.ws.close();
    await new Promise(r => setTimeout(r, 50));

    const back = await resumeSession(s.p2.sessionToken);
    expect(await back.c.wait((m) => m.type === 'ROOM_STATE'))
      .toEqual({ type: 'ROOM_STATE', gameId: s.gameId, playerNumber: 2, movesMade: 0, opponentConnected: false });

    back.ws.close();
  });

  it('sends none to a player who is in no room', async () => {
    const { ws, sessionToken } = await createClientWithSession();
    ws.close();
    await new Promise(r => setTimeout(r, 50));

    const back = await resumeSession(sessionToken);
    expect(back.resumed).toBe(true);
    expect(back.gameId).toBeNull();
    expect(await staysQuiet(back.c, () => true)).toBe(true);

    back.ws.close();
  });

  it('sends none once the moves are complete: both players were released', async () => {
    const s = await seatTwoPlayers();
    await playMoves(s, 0, 9);
    s.p1.ws.close();
    await new Promise(r => setTimeout(r, 50));

    const back = await resumeSession(s.p1.sessionToken);
    expect(back.gameId).toBeNull();
    expect(await staysQuiet(back.c, (m) => m.type === 'ROOM_STATE')).toBe(true);

    closeAll(back.ws, s.p2.ws);
  });
});

describe('Disconnection handling', () => {
  it('should notify opponent when player disconnects', async () => {
    const s = await seatTwoPlayers();
    s.p1.ws.close();
    const disc = await s.c2.wait((m) => m.type === 'OPPONENT_DISCONNECTED');
    expect(disc).toEqual({ type: 'OPPONENT_DISCONNECTED', gameId: s.gameId });
    // The room stays: the game may still be resumed or recovered.
    expect(await server.gameManager.getGameCount()).toBe(1);
    s.p2.ws.close();
  });
});

describe('Session management', () => {
  it('should issue SESSION_ESTABLISHED on new connection', async () => {
    // createClient already waits for SESSION_ESTABLISHED, so this just verifies it works
    const ws = await createClient();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('should resume session with valid token', async () => {
    const first = await createClientWithSession();
    first.ws.close();
    await new Promise(r => setTimeout(r, 100));

    const back = await resumeSession(first.sessionToken);
    expect(back.resumed).toBe(true);
    back.ws.close();
  });

  it('should create new session for invalid token', async () => {
    const back = await resumeSession('bogus-token');
    expect(back.resumed).toBe(false);
    back.ws.close();
  });
});

describe('Message inbox replay', () => {
  it('should buffer and replay a PEER payload when recipient is offline', async () => {
    const s = await seatTwoPlayers();

    // Disconnect player 2
    s.p2.ws.close();
    await s.c1.wait((m) => m.type === 'OPPONENT_DISCONNECTED');

    // Player 1 sends a sealed payload while player 2 is offline
    sendMessage(s.p1.ws, { type: 'PEER', gameId: s.gameId, iv: 'YnVmZmVyZWQtaXY=', ciphertext: 'YnVmZmVyZWQ=' });
    await until(async () => (await server.store.getInbox(s.p2.playerId)).length === 1);

    // Player 2 reconnects with session token and receives it
    const back = await resumeSession(s.p2.sessionToken);
    const peer = await back.c.wait((m) => m.type === 'PEER');
    expect(peer).toEqual({ type: 'PEER', gameId: s.gameId, iv: 'YnVmZmVyZWQtaXY=', ciphertext: 'YnVmZmVyZWQ=' });

    closeAll(s.p1.ws, back.ws);
  });

  it('should notify opponent when player reconnects', async () => {
    const s = await seatTwoPlayers();

    s.p2.ws.close();
    await s.c1.wait((m) => m.type === 'OPPONENT_DISCONNECTED');

    const back = await resumeSession(s.p2.sessionToken);
    expect(back.resumed).toBe(true);

    const reconnected = await s.c1.wait((m) => m.type === 'OPPONENT_RECONNECTED');
    expect(reconnected.type).toBe('OPPONENT_RECONNECTED');

    closeAll(s.p1.ws, back.ws);
  });
});

describe('Session staleness (item G)', () => {
  /** Connect to an arbitrary port and resolve on SESSION_ESTABLISHED. */
  function establish(p: number, resumeToken?: string): Promise<{ ws: WebSocket; sessionToken: string; playerId: string; resumed: boolean }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${p}`);
      ws.on('error', reject);
      if (resumeToken) {
        ws.on('open', () => ws.send(JSON.stringify({ type: 'RESUME', sessionToken: resumeToken })));
      }
      ws.on('message', function onFirst(data: WebSocket.Data) {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'SESSION_ESTABLISHED') {
          ws.removeListener('message', onFirst);
          resolve({ ws, sessionToken: msg.sessionToken, playerId: msg.playerId, resumed: msg.resumed });
        }
      });
    });
  }

  it('rejects RESUME when lastSeen is older than 24h and issues a fresh session', async () => {
    // Infinite store TTL so only the server-side SESSION_STALE_MS check can reject.
    const store = new MemoryGameStore({ sessionTtlMs: Infinity });
    const stalePort = 4100 + Math.floor(Math.random() * 400);
    const staleServer = createServer({ port: stalePort, sessionHandshakeMs: 50, store });
    await new Promise<void>((resolve) => staleServer.httpServer.listen(stalePort, resolve));

    try {
      const first = await establish(stalePort);
      first.ws.close();
      await new Promise(r => setTimeout(r, 50));

      // Back-date the session beyond the 24h staleness window
      await store.setSession(first.sessionToken, {
        playerId: first.playerId,
        createdAt: Date.now() - 26 * 60 * 60 * 1000,
        lastSeen: Date.now() - 25 * 60 * 60 * 1000,
      });

      const second = await establish(stalePort, first.sessionToken);
      expect(second.resumed).toBe(false);
      expect(second.playerId).not.toBe(first.playerId);
      expect(second.sessionToken).not.toBe(first.sessionToken);
      // The stale session was discarded, not left behind (TTL here is Infinity,
      // so only the server can have deleted it).
      expect(await store.getSession(first.sessionToken)).toBeNull();
      expect(await store.getSessionTokenByPlayer(first.playerId)).toBeNull();
      second.ws.close();
    } finally {
      await staleServer.close();
    }
  });

  it('still resumes a session last seen under 24h ago', async () => {
    const store = new MemoryGameStore({ sessionTtlMs: Infinity });
    const freshPort = 4500 + Math.floor(Math.random() * 400);
    const freshServer = createServer({ port: freshPort, sessionHandshakeMs: 50, store });
    await new Promise<void>((resolve) => freshServer.httpServer.listen(freshPort, resolve));

    try {
      const first = await establish(freshPort);
      first.ws.close();
      await new Promise(r => setTimeout(r, 50));

      await store.setSession(first.sessionToken, {
        playerId: first.playerId,
        createdAt: Date.now() - 23 * 60 * 60 * 1000,
        lastSeen: Date.now() - 23 * 60 * 60 * 1000,
      });

      const second = await establish(freshPort, first.sessionToken);
      expect(second.resumed).toBe(true);
      expect(second.playerId).toBe(first.playerId);
      second.ws.close();
    } finally {
      await freshServer.close();
    }
  });

  it('PING refreshes the session lastSeen so active connections never go stale', async () => {
    const { ws, sessionToken } = await createClientWithSession();
    const before = (await server.store.getSession(sessionToken))!.lastSeen;

    await new Promise(r => setTimeout(r, 20));
    sendMessage(ws, { type: 'PING' });
    await waitForMessage(ws, (m) => m.type === 'PONG');

    const after = (await server.store.getSession(sessionToken))!.lastSeen;
    expect(after).toBeGreaterThan(before);
    ws.close();
  });

  it('periodic cleanup loop sweeps stale sessions', async () => {
    class SpyStore extends MemoryGameStore {
      cleanupSessionCalls = 0;
      override async cleanupStaleSessions(staleMs: number): Promise<number> {
        this.cleanupSessionCalls++;
        return super.cleanupStaleSessions(staleMs);
      }
    }
    const spy = new SpyStore();
    const loopPort = 4900 + Math.floor(Math.random() * 90);
    const loopServer = createServer({ port: loopPort, sessionHandshakeMs: 50, cleanupIntervalMs: 40, store: spy });
    await new Promise<void>((resolve) => loopServer.httpServer.listen(loopPort, resolve));

    try {
      await new Promise(r => setTimeout(r, 150));
      expect(spy.cleanupSessionCalls).toBeGreaterThan(0);
    } finally {
      await loopServer.close();
    }
  });
});

describe('Present-but-idle abandonment warning', () => {
  // A server tuned for fast detection: 150ms no-move threshold, checked every
  // 25ms. Lets these tests exercise the real interval without sleeping 60s.
  // warnLead=0 → warn AT the deadline (these tests assert detection, not the
  // impending-warning runway, which has its own test below).
  const MOVE_INACTIVITY = 150;
  const makeFastServer = () => startServer({
    moveInactivityMs: MOVE_INACTIVITY,
    abandonmentWarnLeadMs: 0,
    abandonmentCheckIntervalMs: 25,
  });
  const isWarning = (m: ServerMessage) => m.type === 'GAME_ABANDONMENT_WARNING';

  /** Match two players and put their game on-chain: the first turn starts. */
  async function startGame(p: number): Promise<Seated> {
    const s = await seatTwoPlayers(p);
    await confirmCommits(s);
    return s;
  }

  it('warns BOTH players when the current player goes idle, with the correct shape', async () => {
    const { srv, p } = await makeFastServer();
    try {
      const s = await startGame(p);

      // No move within the threshold → player1 (to move) is idle.
      const w1 = await s.c1.wait(isWarning) as any;
      const w2 = await s.c2.wait(isWarning) as any;

      for (const w of [w1, w2]) {
        expect(w.gameId).toBe(s.gameId);
        expect(w.idlePlayer).toBe('player1');
        expect(typeof w.secondsIdle).toBe('number');
        expect(w.secondsIdle).toBeGreaterThanOrEqual(0);
        expect(typeof w.secondsUntilClaimable).toBe('number');
        // It used to carry the idle player's whole hand, to both players.
        expect(Object.keys(w).sort()).toEqual(['gameId', 'idlePlayer', 'secondsIdle', 'secondsUntilClaimable', 'type']);
      }

      closeAll(s.p1.ws, s.p2.ws);
    } finally {
      await srv.close();
    }
  });

  it('warns of IMPENDING abandonment before the deadline, with a countdown (not a constant)', async () => {
    // Deadline 6s, warn 5s before it → the first warning fires at ~1s of idle
    // (well before the 6s deadline) carrying a countdown to the deadline, so the
    // about-to-forfeit player sees their time running out.
    const { srv, p } = await startServer({
      moveInactivityMs: 6000, abandonmentWarnLeadMs: 5000, abandonmentCheckIntervalMs: 50,
    });
    try {
      const s = await startGame(p);
      const w = await s.c1.wait(isWarning) as any;
      expect(w.gameId).toBe(s.gameId);
      expect(w.idlePlayer).toBe('player1');
      // Impending: still time on the clock (not yet claimable).
      expect(w.secondsUntilClaimable).toBeGreaterThan(0);
      // A real countdown to the 6s deadline — strictly less than the full window.
      expect(w.secondsUntilClaimable).toBeLessThan(6);
      closeAll(s.p1.ws, s.p2.ws);
    } finally {
      await srv.close();
    }
  });

  it('names the player who owes the next move by the move count: player2 after move 0', async () => {
    const { srv, p } = await makeFastServer();
    try {
      const s = await startGame(p);
      await playMove(s, 0);

      const w = await s.c2.wait((m) => isWarning(m) && (m as any).idlePlayer === 'player2') as any;
      expect(w.gameId).toBe(s.gameId);

      closeAll(s.p1.ws, s.p2.ws);
    } finally {
      await srv.close();
    }
  });

  it('stops warning once a move arrives', async () => {
    const { srv, p } = await makeFastServer();
    try {
      const s = await startGame(p);

      // First warning (player1 idle).
      await s.c1.wait(isWarning);

      // player1 finally moves → idle clock resets, warnings about it should cease.
      await playMove(s, 0);

      // Confirm no NEW warning about player1 arrives in a window covering
      // several detector ticks. (A warning about player2 would be legitimate
      // once player2 then goes idle, so we assert specifically on player1.)
      const warnPromise = s.c1
        .wait((m) => isWarning(m) && (m as any).idlePlayer === 'player1')
        .then(() => 'warned')
        .catch(() => 'rejected');
      const result = await Promise.race([
        warnPromise,
        new Promise<string>((r) => setTimeout(() => r('quiet'), 400)),
      ]);
      expect(result).not.toBe('warned');

      closeAll(s.p1.ws, s.p2.ws);
    } finally {
      await srv.close();
    }
  });

  it('does not warn while the game is not on-chain yet, then starts the clock when it is', async () => {
    // Every MOVE carries a proof over both hand commitments, so nobody can move
    // before both records are on-chain. A clock running from the match would
    // flag player 1 idle through every game's setup.
    const { srv, p } = await makeFastServer();
    try {
      const s = await seatTwoPlayers(p);
      sendMessage(s.p1.ws, { type: 'TX_CONFIRMED', gameId: s.gameId, txType: 'create_game' });
      for (const c of [s.c1, s.c2]) expect(await staysQuiet(c, isWarning, 500)).toBe(true);

      sendMessage(s.p2.ws, { type: 'TX_CONFIRMED', gameId: s.gameId, txType: 'join_game' });
      const w = await s.c2.wait(isWarning) as any;
      expect(w.idlePlayer).toBe('player1');

      closeAll(s.p1.ws, s.p2.ws);
    } finally {
      await srv.close();
    }
  });

  it('runs the clock from the first move even if nobody reported a commit', async () => {
    const { srv, p } = await makeFastServer();
    try {
      const s = await seatTwoPlayers(p);
      await playMove(s, 0);
      const w = await s.c1.wait(isWarning) as any;
      expect(w.idlePlayer).toBe('player2');

      closeAll(s.p1.ws, s.p2.ws);
    } finally {
      await srv.close();
    }
  });

  it('does not warn once all nine moves are in', async () => {
    const { srv, p } = await makeFastServer();
    try {
      const s = await startGame(p);
      await playMoves(s, 0, 9);
      // A warning decided a tick before the ninth move landed may still be in
      // flight; anything after that is a bug.
      await new Promise(r => setTimeout(r, 100));
      const seen = [s.c1.log.length, s.c2.log.length];
      await new Promise(r => setTimeout(r, 500));
      expect(s.c1.log.slice(seen[0]).filter(isWarning)).toEqual([]);
      expect(s.c2.log.slice(seen[1]).filter(isWarning)).toEqual([]);

      closeAll(s.p1.ws, s.p2.ws);
    } finally {
      await srv.close();
    }
  });

  it('buffers the warning for an offline player and replays it on reconnect', async () => {
    const { srv, p } = await makeFastServer();
    try {
      const s = await startGame(p);

      // player2 disconnects while it is player1's turn — player1 is the idle
      // one and player2 is offline; the warning must be buffered for player2.
      s.p2.ws.close();
      await s.c1.wait((m) => m.type === 'OPPONENT_DISCONNECTED');

      // Let the detector fire at least once while player2 is offline.
      await s.c1.wait(isWarning);

      // player2 reconnects and should receive the buffered warning.
      const back = await resumeSession(s.p2.sessionToken, p);
      const replayed = await back.c.wait(isWarning) as any;
      expect(replayed.gameId).toBe(s.gameId);
      expect(replayed.idlePlayer).toBe('player1');

      closeAll(s.p1.ws, back.ws);
    } finally {
      await srv.close();
    }
  });
});

// ── Private games, Phase A (docs/plan/PRIVATE_GAMES.md §5.1, §7) ─────────────

/** A fresh uncompressed P-256 public key in base64, exactly as the clients send it. */
async function realPublicKey(): Promise<string> {
  const { subtle } = crypto.webcrypto;
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return Buffer.from(await subtle.exportKey('raw', pair.publicKey)).toString('base64');
}

const isRelayed = (m: ServerMessage) => m.type === 'OPPONENT_KEY' || m.type === 'PEER' || m.type === 'MOVE';

describe('Key exchange and sealed PEER payloads', () => {
  it('forwards KEY_EXCHANGE to the other player as OPPONENT_KEY, never back to the sender', async () => {
    const { p1, p2, c1, c2, gameId } = await seatTwoPlayers();
    const key1 = await realPublicKey();
    const key2 = await realPublicKey();
    expect(key1).toHaveLength(88);

    sendMessage(p1.ws, { type: 'KEY_EXCHANGE', gameId, publicKey: key1 });
    sendMessage(p2.ws, { type: 'KEY_EXCHANGE', gameId, publicKey: key2 });

    expect(await c2.wait((m) => m.type === 'OPPONENT_KEY')).toEqual({ type: 'OPPONENT_KEY', gameId, publicKey: key1 });
    expect(await c1.wait((m) => m.type === 'OPPONENT_KEY')).toEqual({ type: 'OPPONENT_KEY', gameId, publicKey: key2 });
    for (const c of [c1, c2]) {
      expect(await staysQuiet(c, (m) => isRelayed(m) || m.type === 'ERROR')).toBe(true);
    }

    closeAll(p1.ws, p2.ws);
  });

  it('forwards PEER both ways exactly as sealed, and nothing else a client attaches', async () => {
    const { p1, p2, c1, c2, gameId } = await seatTwoPlayers();
    const fromP1 = sealed();
    const fromP2 = sealed();

    // Plaintext riding next to the sealed fields must not reach the opponent.
    p1.ws.send(JSON.stringify({ type: 'PEER', gameId, ...fromP1, kind: 'RECORD', record: ['0x1'], fromPlayer: 1 }));
    sendMessage(p2.ws, { type: 'PEER', gameId, ...fromP2 });

    expect(await c2.wait((m) => m.type === 'PEER')).toEqual({ type: 'PEER', gameId, ...fromP1 });
    expect(await c1.wait((m) => m.type === 'PEER')).toEqual({ type: 'PEER', gameId, ...fromP2 });
    for (const c of [c1, c2]) {
      expect(await staysQuiet(c, (m) => isRelayed(m) || m.type === 'ERROR')).toBe(true);
    }

    closeAll(p1.ws, p2.ws);
  });

  it('buffers KEY_EXCHANGE and PEER for an offline opponent and replays them in order on RESUME', async () => {
    const { p1, p2, c1, gameId } = await seatTwoPlayers();
    p2.ws.close();
    await c1.wait((m) => m.type === 'OPPONENT_DISCONNECTED');

    const key = await realPublicKey();
    const first = sealed();
    const second = sealed();
    sendMessage(p1.ws, { type: 'KEY_EXCHANGE', gameId, publicKey: key });
    sendMessage(p1.ws, { type: 'PEER', gameId, ...first });
    sendMessage(p1.ws, { type: 'PEER', gameId, ...second });

    const expected = [
      { type: 'OPPONENT_KEY', gameId, publicKey: key },
      { type: 'PEER', gameId, ...first },
      { type: 'PEER', gameId, ...second },
    ];
    await until(async () => (await server.store.getInbox(p2.playerId)).length === 3);
    expect(await server.store.getInbox(p2.playerId)).toEqual(expected);
    expect(c1.has((m) => m.type === 'ERROR')).toBe(false);

    const back = await resumeSession(p2.sessionToken);
    expect(back.resumed).toBe(true);
    const replayed = [];
    for (let i = 0; i < 3; i++) replayed.push(await back.c.wait(isRelayed));
    expect(replayed).toEqual(expected);
    await until(async () => (await server.store.getInbox(p2.playerId)).length === 0);

    closeAll(back.ws, p1.ws);
  });

  it('refuses a sender who is not in the game, and delivers nothing', async () => {
    const { p1, p2, c1, c2, gameId } = await seatTwoPlayers();
    const outsider = await createClient();
    const co = new MessageCollector(outsider);

    sendMessage(outsider, { type: 'KEY_EXCHANGE', gameId, publicKey: await realPublicKey() });
    expect((await co.wait((m) => m.type === 'ERROR') as any).message).toBe('Not in this game');
    sendMessage(outsider, { type: 'PEER', gameId, ...sealed() });
    expect((await co.wait((m) => m.type === 'ERROR') as any).message).toBe('Not in this game');

    for (const c of [c1, c2]) expect(await staysQuiet(c, isRelayed)).toBe(true);
    expect(await server.store.getInbox(p1.playerId)).toEqual([]);
    expect(await server.store.getInbox(p2.playerId)).toEqual([]);

    closeAll(outsider, p1.ws, p2.ws);
  });

  it('refuses unknown games', async () => {
    const ws = await createClient();
    const c = new MessageCollector(ws);

    sendMessage(ws, { type: 'PEER', gameId: 'no-such-game', ...sealed() });
    expect((await c.wait((m) => m.type === 'ERROR') as any).message).toBe('Game not found');
    sendMessage(ws, { type: 'KEY_EXCHANGE', gameId: 'no-such-game', publicKey: await realPublicKey() });
    expect((await c.wait((m) => m.type === 'ERROR') as any).message).toBe('Game not found');

    ws.close();
  });

  it('still carries PEER after the moves are complete, when the settlement notices travel', async () => {
    const s = await seatTwoPlayers();
    await playMoves(s, 0, 9);
    const notice = sealed();

    sendMessage(s.p1.ws, { type: 'PEER', gameId: s.gameId, ...notice });
    expect(await s.c2.wait((m) => m.type === 'PEER')).toEqual({ type: 'PEER', gameId: s.gameId, ...notice });

    closeAll(s.p1.ws, s.p2.ws);
  });

  it('enforces encoding and size limits, delivering nothing it refuses', async () => {
    const { p1, p2, c1, c2, gameId } = await seatTwoPlayers();
    const b64 = (n: number) => 'A'.repeat(n); // valid base64 whenever n % 4 === 0

    const refused: [Record<string, unknown>, RegExp][] = [
      [{ type: 'KEY_EXCHANGE', gameId }, /publicKey/],
      [{ type: 'KEY_EXCHANGE', gameId, publicKey: '' }, /publicKey/],
      [{ type: 'KEY_EXCHANGE', gameId, publicKey: 42 }, /publicKey/],
      [{ type: 'KEY_EXCHANGE', gameId, publicKey: b64(260) }, /publicKey/],
      [{ type: 'KEY_EXCHANGE', gameId, publicKey: 'not base64!' }, /publicKey/],
      [{ type: 'KEY_EXCHANGE', gameId, publicKey: 'ab-_' }, /publicKey/], // base64url
      [{ type: 'KEY_EXCHANGE', publicKey: b64(88) }, /gameId/],
      [{ type: 'PEER', gameId, iv: b64(68), ciphertext: b64(8) }, /iv/],
      [{ type: 'PEER', gameId, iv: 'AAA', ciphertext: b64(8) }, /iv/], // unpadded
      [{ type: 'PEER', gameId, ciphertext: b64(8) }, /iv/],
      [{ type: 'PEER', gameId, iv: b64(16), ciphertext: b64(64 * 1024 + 4) }, /ciphertext/],
      [{ type: 'PEER', gameId, iv: b64(16), ciphertext: '' }, /ciphertext/],
      [{ type: 'PEER', gameId, iv: b64(16), ciphertext: { sealed: true } }, /ciphertext/],
      [{ type: 'PEER', gameId, iv: b64(16) }, /ciphertext/],
      [{ type: 'PEER', iv: b64(16), ciphertext: b64(8) }, /gameId/],
    ];
    for (const [msg, field] of refused) {
      p1.ws.send(JSON.stringify(msg));
      const err = await c1.wait((m) => m.type === 'ERROR') as any;
      expect(err.message).toMatch(field);
    }
    expect(await staysQuiet(c2, isRelayed)).toBe(true);

    // Exactly at each cap is accepted.
    const atCaps = { iv: b64(64), ciphertext: b64(64 * 1024) };
    sendMessage(p1.ws, { type: 'KEY_EXCHANGE', gameId, publicKey: b64(256) });
    sendMessage(p1.ws, { type: 'PEER', gameId, ...atCaps });
    expect(await c2.wait((m) => m.type === 'OPPONENT_KEY')).toEqual({ type: 'OPPONENT_KEY', gameId, publicKey: b64(256) });
    expect(await c2.wait((m) => m.type === 'PEER')).toEqual({ type: 'PEER', gameId, ...atCaps });

    closeAll(p1.ws, p2.ws);
  });

  it('never logs a public key or a sealed payload, only the message types and move numbers', async () => {
    const captured = captureConsole();
    try {
      const s = await seatTwoPlayers();
      const { p1, p2, c1, c2, gameId } = s;
      const key = await realPublicKey();
      const live = sealed();
      const smuggled = sealed();
      const buffered = sealed();
      const moves = [sealed(), sealed(), sealed()];

      sendMessage(p1.ws, { type: 'KEY_EXCHANGE', gameId, publicKey: key });
      await c2.wait((m) => m.type === 'OPPONENT_KEY');
      sendMessage(p1.ws, { type: 'PEER', gameId, ...live });
      await c2.wait((m) => m.type === 'PEER');
      // A valid PEER with a stray free-text field: the old logger printed any
      // `message` a client attached.
      p1.ws.send(JSON.stringify({ type: 'PEER', gameId, ...sealed(), message: smuggled.ciphertext }));
      await c2.wait((m) => m.type === 'PEER');
      // A refused payload.
      p1.ws.send(JSON.stringify({ type: 'PEER', gameId, iv: smuggled.iv, ciphertext: `${live.ciphertext}!` }));
      await c1.wait((m) => m.type === 'ERROR');
      // Two live moves.
      await playMove(s, 0, moves[0]);
      await playMove(s, 1, moves[1]);

      // Through the inbox: buffered while the opponent is offline, replayed on RESUME.
      p2.ws.close();
      await c1.wait((m) => m.type === 'OPPONENT_DISCONNECTED');
      sendMessage(p1.ws, { type: 'PEER', gameId, ...buffered });
      sendMessage(p1.ws, { type: 'MOVE', gameId, moveNumber: 2, ...moves[2] });
      await until(async () => (await server.store.getInbox(p2.playerId)).length === 2);
      const back = await resumeSession(p2.sessionToken);
      await back.c.wait((m) => m.type === 'PEER');
      await back.c.wait(isMove);

      const secrets = [key, live.iv, live.ciphertext, smuggled.iv, smuggled.ciphertext, buffered.iv, buffered.ciphertext,
        ...moves.flatMap(m => [m.iv, m.ciphertext])];
      for (const secret of secrets) {
        // A 12-character prefix catches a truncated dump as well as a whole one.
        const needle = secret.slice(0, 12);
        expect(captured.lines.filter(l => l.includes(needle))).toEqual([]);
      }
      // The per-message type lines are still written.
      for (const type of ['KEY_EXCHANGE', 'OPPONENT_KEY', 'PEER', 'MOVE']) {
        expect(captured.lines.some(l => l.includes(`"type":"${type}"`))).toBe(true);
      }
      // A MOVE line carries its room and number — the two things the relay reads — and nothing else.
      const moveLines = captured.lines.filter(l => l.includes('"type":"MOVE"'));
      expect(moveLines.length).toBeGreaterThanOrEqual(6); // 3 in, 3 out
      for (const line of moveLines) {
        expect(line).toMatch(/\{"type":"MOVE","gameId":"0x[0-9a-f]{10}\.\.\.","moveNumber":[0-8]\}$/);
      }

      closeAll(back.ws, p1.ws);
    } finally {
      captured.restore();
    }
  });
});

describe('Removed relay messages', () => {
  const REMOVED: Record<string, unknown>[] = [
    // Phase A: each carried identifying data in plaintext — an Aztec address
    // and per-game randomness, a blinding factor, note preimages, the prize
    // card, a hand proof.
    { type: 'SHARE_AZTEC_INFO', aztecAddress: '0x1234', onChainGameId: '0x5678', gameRandomness: ['0x1'] },
    { type: 'SHARE_BLINDING', blindingFactor: '0x99' },
    { type: 'RELAY_NOTE_DATA', txHash: '0xabc', notes: [{ tokenId: 3, randomness: '0x1' }] },
    { type: 'SETTLE_STARTED', selectedCardId: 3 },
    { type: 'SUBMIT_HAND_PROOF', handProof: { proof: 'p', publicInputs: [], cardCommit: '0x1' } },
    // Phase B: the rules engine, which needed both hands and every move in the
    // clear, and the lobby that fed it card ids.
    { type: 'PLACE_CARD', handIndex: 0, row: 0, col: 0, moveNumber: 0 },
    { type: 'SUBMIT_MOVE_PROOF', handIndex: 0, row: 0, col: 0, moveNumber: 0, moveProof: { proof: 'p', publicInputs: [] } },
    { type: 'CREATE_GAME', cardIds: [1, 2, 3, 4, 5] },
    { type: 'JOIN_GAME', cardIds: [6, 7, 8, 9, 10] },
    { type: 'LIST_GAMES' },
    { type: 'GET_GAME' },
    { type: 'CANCEL_GAME' },
    { type: 'ABANDONED_GAME_SETTLED' },
  ];

  for (const removed of REMOVED) {
    it(`rejects ${removed.type} as an unknown type and forwards nothing`, async () => {
      const { p1, p2, c1, c2, gameId } = await seatTwoPlayers();

      p1.ws.send(JSON.stringify({ ...removed, gameId }));
      expect((await c1.wait((m) => m.type === 'ERROR') as any).message).toBe('Unknown or missing message type');
      expect(await staysQuiet(c2, () => true)).toBe(true);
      expect((await server.store.getGame(gameId))!.movesMade).toBe(0);

      closeAll(p1.ws, p2.ws);
    });
  }
});

describe('TX status', () => {
  it('accepts TX_CONFIRMED without a tx hash', async () => {
    const { p1, p2, c1, c2, gameId } = await seatTwoPlayers();

    sendMessage(p1.ws, { type: 'TX_CONFIRMED', gameId, txType: 'create_game' });
    for (const c of [c1, c2]) {
      const status = await c.wait((m) => m.type === 'ON_CHAIN_STATUS') as any;
      expect(status.status).toEqual({ player1Tx: 'confirmed', player2Tx: 'idle', canSettle: false });
    }

    closeAll(p1.ws, p2.ws);
  });

  it('ignores a tx hash an older client still sends: never stored, forwarded or logged', async () => {
    const captured = captureConsole();
    try {
      const { p1, p2, c1, c2, gameId } = await seatTwoPlayers();
      const hash = (): string => '0x' + crypto.randomBytes(32).toString('hex');
      const confirmed = hash();
      const failed = hash();

      p1.ws.send(JSON.stringify({ type: 'TX_CONFIRMED', gameId, txType: 'create_game', txHash: confirmed }));
      const statuses = [
        await c1.wait((m) => m.type === 'ON_CHAIN_STATUS'),
        await c2.wait((m) => m.type === 'ON_CHAIN_STATUS'),
      ];
      p2.ws.send(JSON.stringify({ type: 'TX_FAILED', gameId, txType: 'join_game', error: 'reverted', txHash: failed }));
      statuses.push(
        await c1.wait((m) => m.type === 'ON_CHAIN_STATUS'),
        await c2.wait((m) => m.type === 'ON_CHAIN_STATUS'),
      );
      expect((statuses[3] as any).status).toEqual({ player1Tx: 'confirmed', player2Tx: 'failed', canSettle: false });

      const stored = JSON.stringify(await server.store.getGame(gameId));
      for (const txHash of [confirmed, failed]) {
        const needle = txHash.slice(2, 14);
        for (const s of statuses) expect(JSON.stringify(s)).not.toContain(needle);
        expect(stored).not.toContain(needle);
        expect(captured.lines.filter(l => l.includes(needle))).toEqual([]);
      }

      closeAll(p1.ws, p2.ws);
    } finally {
      captured.restore();
    }
  });

  it('says canSettle only once both commits are confirmed AND all nine moves are in', async () => {
    const s = await seatTwoPlayers();
    await confirmCommits(s);
    // Both commits alone are not enough: settling needs the whole transcript.
    const afterCommits = s.c1.log.filter((m) => m.type === 'ON_CHAIN_STATUS').at(-1) as any;
    expect(afterCommits.status).toEqual({ player1Tx: 'confirmed', player2Tx: 'confirmed', canSettle: false });

    await playMoves(s, 0, 8);
    expect(s.c1.has((m) => m.type === 'ON_CHAIN_STATUS')).toBe(false);
    await playMove(s, 8);
    // The ninth move is what makes the game settleable: both players hear so.
    for (const c of [s.c1, s.c2]) {
      const status = await c.wait((m) => m.type === 'ON_CHAIN_STATUS') as any;
      expect(status).toEqual({
        type: 'ON_CHAIN_STATUS', gameId: s.gameId,
        status: { player1Tx: 'confirmed', player2Tx: 'confirmed', canSettle: true },
      });
    }

    closeAll(s.p1.ws, s.p2.ws);
  });

  it('gets to canSettle when the last commit is reported after the moves', async () => {
    const s = await seatTwoPlayers();
    await playMoves(s, 0, 9);
    // Nothing to settle yet, so the ninth move announces nothing.
    expect(await staysQuiet(s.c1, (m) => m.type === 'ON_CHAIN_STATUS')).toBe(true);

    sendMessage(s.p1.ws, { type: 'TX_CONFIRMED', gameId: s.gameId, txType: 'create_game' });
    expect((await s.c2.wait((m) => m.type === 'ON_CHAIN_STATUS') as any).status.canSettle).toBe(false);
    sendMessage(s.p2.ws, { type: 'TX_CONFIRMED', gameId: s.gameId, txType: 'join_game' });
    expect((await s.c2.wait((m) => m.type === 'ON_CHAIN_STATUS') as any).status.canSettle).toBe(true);

    closeAll(s.p1.ws, s.p2.ws);
  });

  it('refuses a report for a room the sender is not in', async () => {
    const s = await seatTwoPlayers();
    const outsider = await createClient();
    const co = new MessageCollector(outsider);

    sendMessage(outsider, { type: 'TX_CONFIRMED', gameId: s.gameId, txType: 'create_game' });
    expect((await co.wait((m) => m.type === 'ERROR') as any).message).toBe('Game not found or player not in game');
    for (const c of [s.c1, s.c2]) expect(await staysQuiet(c, (m) => m.type === 'ON_CHAIN_STATUS')).toBe(true);

    closeAll(outsider, s.p1.ws, s.p2.ws);
  });
});

describe('/metrics', () => {
  it('counts matches and completed games, and says nothing about who won', async () => {
    metrics.reset();
    const s = await seatTwoPlayers();
    await playMoves(s, 0, 9);

    const { body } = await httpGet('/metrics');
    expect(body).toMatchObject({ matchesFormed: 1, gamesCreated: 1, gamesCompleted: 1, botMatchesFormed: 0 });
    // The relay cannot know who won: it never sees a card.
    for (const outcome of ['botWins', 'botLosses', 'botDraws']) expect(body).not.toHaveProperty(outcome);

    closeAll(s.p1.ws, s.p2.ws);
  });
});

describe('CORS restriction (V7 Fix 4.4)', () => {
  function healthWithOrigin(origin?: string): Promise<http.IncomingHttpHeaders> {
    return new Promise((resolve, reject) => {
      const req = http.request(`${getHttpUrl()}/health`, {
        headers: origin ? { 'Origin': origin } : {},
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.headers));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('should set CORS header for allowed origin localhost:5174', async () => {
    expect((await healthWithOrigin('http://localhost:5174'))['access-control-allow-origin']).toBe('http://localhost:5174');
  });

  it('should set CORS header for allowed origin localhost:3000', async () => {
    expect((await healthWithOrigin('http://localhost:3000'))['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('should not set CORS header for disallowed origin', async () => {
    expect((await healthWithOrigin('http://evil.com'))['access-control-allow-origin']).toBeUndefined();
  });

  it('should not set CORS header when no origin is provided', async () => {
    expect((await healthWithOrigin())['access-control-allow-origin']).toBeUndefined();
  });
});
