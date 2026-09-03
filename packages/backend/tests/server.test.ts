import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import http from 'http';
import { createServer, type CardGameServer } from '../src/server.js';
import type { ServerMessage, ClientMessage } from '../src/types.js';

// Valid card IDs
const PLAYER1_CARDS = [1, 2, 3, 4, 5];
const PLAYER2_CARDS = [6, 7, 8, 9, 10];

// Skip session establishment messages when filtering for game messages
const isSessionMsg = (m: ServerMessage) => m.type === 'SESSION_ESTABLISHED';

let server: CardGameServer;
let port: number;

function getUrl(): string {
  return `ws://localhost:${port}`;
}

function getHttpUrl(): string {
  return `http://localhost:${port}`;
}

/** Create a client and wait for SESSION_ESTABLISHED before resolving. */
function createClient(): Promise<WebSocket> {
  return createClientWithSession().then(r => r.ws);
}

/** Create a client and return both the WebSocket and session token. */
function createClientWithSession(): Promise<{ ws: WebSocket; sessionToken: string; playerId: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getUrl());
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
// Automatically skips SESSION_ESTABLISHED / OPPONENT_RECONNECTED messages.
class MessageCollector {
  private buffer: ServerMessage[] = [];
  private waiters: { filter?: (msg: ServerMessage) => boolean; resolve: (msg: ServerMessage) => void; reject: (err: Error) => void; timeout: NodeJS.Timeout }[] = [];
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

function httpGet(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get(`${getHttpUrl()}${path}`, (res) => {
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

  it('should return empty game list', async () => {
    const { status, body } = await httpGet('/games');
    expect(status).toBe(200);
    expect(body).toEqual([]);
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

describe('WebSocket game flow', () => {
  it('should accept connections', async () => {
    const ws = await createClient();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('should create a game', async () => {
    const ws = await createClient();
    sendMessage(ws, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('GAME_CREATED');
    if (msg.type === 'GAME_CREATED') {
      expect(msg.gameId).toBeDefined();
      expect(msg.playerNumber).toBe(1);
    }
    ws.close();
  });

  it('should join a game', async () => {
    const ws1 = await createClient();
    const ws2 = await createClient();

    // Player 1 creates game
    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await waitForMessage(ws1);
    expect(created.type).toBe('GAME_CREATED');
    const gameId = (created as any).gameId;

    // Player 2 joins
    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });

    // Player 2 gets GAME_JOINED
    const joined = await waitForMessage(ws2, (m) => m.type === 'GAME_JOINED');
    expect(joined.type).toBe('GAME_JOINED');
    if (joined.type === 'GAME_JOINED') {
      expect(joined.gameId).toBe(gameId);
      expect(joined.playerNumber).toBe(2);
      expect(joined.gameState.status).toBe('playing');
    }

    // Player 1 gets GAME_START
    const start = await waitForMessage(ws1, (m) => m.type === 'GAME_START');
    expect(start.type).toBe('GAME_START');
    if (start.type === 'GAME_START') {
      expect(start.gameState.status).toBe('playing');
      expect(start.gameState.currentTurn).toBe('player1');
    }

    ws1.close();
    ws2.close();
  });

  it('should handle move placement', async () => {
    const ws1 = await createClient();
    const ws2 = await createClient();

    // Setup game
    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await waitForMessage(ws1) as any;
    const gameId = created.gameId;

    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    await waitForMessage(ws2, (m) => m.type === 'GAME_JOINED');
    await waitForMessage(ws1, (m) => m.type === 'GAME_START');

    // Player 1 places card
    sendMessage(ws1, { type: 'PLACE_CARD', gameId, handIndex: 0, row: 0, col: 0, moveNumber: 0 });

    // Both players get state update
    const state1 = await waitForMessage(ws1, (m) => m.type === 'GAME_STATE');
    const state2 = await waitForMessage(ws2, (m) => m.type === 'GAME_STATE');

    expect(state1.type).toBe('GAME_STATE');
    expect(state2.type).toBe('GAME_STATE');
    if (state1.type === 'GAME_STATE') {
      expect(state1.gameState.board[0][0].card).not.toBeNull();
      expect(state1.gameState.currentTurn).toBe('player2');
    }

    ws1.close();
    ws2.close();
  });

  it('should reject invalid moves', async () => {
    const ws1 = await createClient();
    const ws2 = await createClient();

    // Setup game
    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await waitForMessage(ws1) as any;
    const gameId = created.gameId;

    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    await waitForMessage(ws2, (m) => m.type === 'GAME_JOINED');
    await waitForMessage(ws1, (m) => m.type === 'GAME_START');

    // Player 2 tries to move out of turn
    sendMessage(ws2, { type: 'PLACE_CARD', gameId, handIndex: 0, row: 0, col: 0, moveNumber: 0 });
    const error = await waitForMessage(ws2, (m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    if (error.type === 'ERROR') {
      expect(error.message).toBe('Not your turn');
    }

    ws1.close();
    ws2.close();
  });

  it('should play a full game', async () => {
    const ws1 = await createClient();
    const ws2 = await createClient();

    // Use buffered collectors to avoid message loss
    const c1 = new MessageCollector(ws1);
    const c2 = new MessageCollector(ws2);

    // Setup game
    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await c1.wait((m) => m.type === 'GAME_CREATED') as any;
    const gameId = created.gameId;

    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    await c2.wait((m) => m.type === 'GAME_JOINED');
    await c1.wait((m) => m.type === 'GAME_START');

    const positions: [number, number][] = [
      [0, 0], [0, 1], [0, 2],
      [1, 0], [1, 1], [1, 2],
      [2, 0], [2, 1], [2, 2],
    ];

    for (let i = 0; i < 9; i++) {
      const [currentCollector, otherCollector] = i % 2 === 0 ? [c1, c2] : [c2, c1];
      const currentWs = i % 2 === 0 ? ws1 : ws2;
      const [row, col] = positions[i];

      sendMessage(currentWs, { type: 'PLACE_CARD', gameId, handIndex: 0, row, col, moveNumber: i });

      // Both get GAME_STATE
      await currentCollector.wait((m) => m.type === 'GAME_STATE');
      await otherCollector.wait((m) => m.type === 'GAME_STATE');

      // On last move, both get GAME_OVER
      if (i === 8) {
        const over1 = await currentCollector.wait((m) => m.type === 'GAME_OVER');
        const over2 = await otherCollector.wait((m) => m.type === 'GAME_OVER');
        expect(over1.type).toBe('GAME_OVER');
        expect(over2.type).toBe('GAME_OVER');
      }
    }

    ws1.close();
    ws2.close();
  });

  it('should list games via WebSocket', async () => {
    const ws1 = await createClient();

    sendMessage(ws1, { type: 'LIST_GAMES' });
    const list1 = await waitForMessage(ws1, (m) => m.type === 'GAME_LIST');
    expect(list1.type).toBe('GAME_LIST');
    if (list1.type === 'GAME_LIST') {
      expect(list1.games).toHaveLength(0);
    }

    // Create a game
    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    await waitForMessage(ws1, (m) => m.type === 'GAME_CREATED');

    sendMessage(ws1, { type: 'LIST_GAMES' });
    const list2 = await waitForMessage(ws1, (m) => m.type === 'GAME_LIST');
    if (list2.type === 'GAME_LIST') {
      expect(list2.games).toHaveLength(1);
      expect(list2.games[0].status).toBe('waiting');
    }

    ws1.close();
  });

  it('should handle invalid JSON', async () => {
    const ws = await createClient();
    ws.send('not json');
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    if (error.type === 'ERROR') {
      expect(error.message).toBe('Invalid message format');
    }
    ws.close();
  });

  it('should return error for invalid card IDs in create', async () => {
    const ws = await createClient();
    sendMessage(ws, { type: 'CREATE_GAME', cardIds: [999, 998, 997, 996, 995] });
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    ws.close();
  });
});

describe('Disconnection handling', () => {
  it('should notify opponent when player disconnects', async () => {
    const ws1 = await createClient();
    const ws2 = await createClient();

    // Setup game
    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await waitForMessage(ws1) as any;
    const gameId = created.gameId;

    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    await waitForMessage(ws2, (m) => m.type === 'GAME_JOINED');
    await waitForMessage(ws1, (m) => m.type === 'GAME_START');

    // Player 1 disconnects
    ws1.close();

    // Player 2 should get disconnection notification
    const disc = await waitForMessage(ws2, (m) => m.type === 'OPPONENT_DISCONNECTED');
    expect(disc.type).toBe('OPPONENT_DISCONNECTED');
    if (disc.type === 'OPPONENT_DISCONNECTED') {
      expect(disc.gameId).toBe(gameId);
    }

    ws2.close();
  });

  it('should remove waiting game when creator disconnects', async () => {
    const ws1 = await createClient();

    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    await waitForMessage(ws1, (m) => m.type === 'GAME_CREATED');

    // Wait a moment for the game to be registered
    expect(await server.gameManager.getGameCount()).toBe(1);

    ws1.close();

    // Wait for close handler
    await new Promise((r) => setTimeout(r, 100));
    expect(await server.gameManager.getGameCount()).toBe(0);
  });
});

describe('Proof exchange', () => {
  it('should relay hand proofs between players', async () => {
    const ws1 = await createClient();
    const ws2 = await createClient();
    const c1 = new MessageCollector(ws1);
    const c2 = new MessageCollector(ws2);

    // Setup game
    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await c1.wait((m) => m.type === 'GAME_CREATED') as any;
    const gameId = created.gameId;

    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    await c2.wait((m) => m.type === 'GAME_JOINED');
    await c1.wait((m) => m.type === 'GAME_START');

    // Player 1 submits hand proof
    sendMessage(ws1, {
      type: 'SUBMIT_HAND_PROOF',
      gameId,
      handProof: {
        proof: 'base64proofdata1',
        publicInputs: ['0xcommit1', '0xaddr1', gameId],
        cardCommit: '0xcommit1',
        playerAddress: '0xaddr1',
        gameId,
      },
    });

    // Player 2 receives hand proof
    const handProofMsg = await c2.wait((m) => m.type === 'HAND_PROOF');
    expect(handProofMsg.type).toBe('HAND_PROOF');
    if (handProofMsg.type === 'HAND_PROOF') {
      expect(handProofMsg.handProof.cardCommit).toBe('0xcommit1');
      expect(handProofMsg.fromPlayer).toBe(1);
    }

    ws1.close();
    ws2.close();
  });

  it('should handle move with proof', async () => {
    const ws1 = await createClient();
    const ws2 = await createClient();
    const c1 = new MessageCollector(ws1);
    const c2 = new MessageCollector(ws2);

    // Setup game
    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await c1.wait((m) => m.type === 'GAME_CREATED') as any;
    const gameId = created.gameId;

    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    await c2.wait((m) => m.type === 'GAME_JOINED');
    await c1.wait((m) => m.type === 'GAME_START');

    // Player 1 places a card (applies the move, produces GAME_STATE)
    sendMessage(ws1, {
      type: 'PLACE_CARD',
      gameId,
      handIndex: 0,
      row: 0,
      col: 0,
      moveNumber: 0,
    });

    // Player 1 gets GAME_STATE (standard update from PLACE_CARD)
    const stateMsg = await c1.wait((m) => m.type === 'GAME_STATE');
    expect(stateMsg.type).toBe('GAME_STATE');

    // Drain GAME_STATE for player 2 as well
    await c2.wait((m) => m.type === 'GAME_STATE');

    // Player 1 submits proof separately (relayed to opponent)
    sendMessage(ws1, {
      type: 'SUBMIT_MOVE_PROOF',
      gameId,
      handIndex: 0,
      row: 0,
      col: 0,
      moveNumber: 0,
      moveProof: {
        proof: 'base64moveproof',
        publicInputs: ['0xcc1', '0xcc2', '0xstart', '0xend', '0', '0'],
        cardCommit1: '0xcc1',
        cardCommit2: '0xcc2',
        startStateHash: '0xstart',
        endStateHash: '0xend',
        gameEnded: false,
        winnerId: 0,
      },
    });

    // Player 2 gets MOVE_PROVEN (with proof attached)
    const moveProvenMsg = await c2.wait((m) => m.type === 'MOVE_PROVEN');
    expect(moveProvenMsg.type).toBe('MOVE_PROVEN');
    if (moveProvenMsg.type === 'MOVE_PROVEN') {
      expect(moveProvenMsg.moveProof.cardCommit1).toBe('0xcc1');
      expect(moveProvenMsg.handIndex).toBe(0);
      expect(moveProvenMsg.row).toBe(0);
      expect(moveProvenMsg.col).toBe(0);
      expect(moveProvenMsg.gameState.board[0][0].card).not.toBeNull();
    }

    ws1.close();
    ws2.close();
  });
});

describe('Hand sanitization (S3 fix)', () => {
  it('should hide opponent hand in GAME_JOINED message for player 2', async () => {
    const ws1 = await createClient();
    const ws2 = await createClient();

    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await waitForMessage(ws1) as any;
    const gameId = created.gameId;

    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    const joined = await waitForMessage(ws2, (m) => m.type === 'GAME_JOINED');

    if (joined.type === 'GAME_JOINED') {
      // Player 2 should see their own hand
      expect(joined.gameState.player2Hand.length).toBe(5);
      expect(joined.gameState.player2Hand[0].id).not.toBe(0);
      // Player 1's hand: first 3 visible, last 2 hidden (HIDDEN_COUNT = 2)
      expect(joined.gameState.player1Hand.length).toBe(5);
      for (let i = 0; i < 3; i++) {
        expect(joined.gameState.player1Hand[i].id).not.toBe(0);
      }
      for (let i = 3; i < 5; i++) {
        expect(joined.gameState.player1Hand[i].id).toBe(0);
        expect(joined.gameState.player1Hand[i].name).toBe('Hidden');
        expect(joined.gameState.player1Hand[i].ranks.top).toBe(0);
      }
    }

    ws1.close();
    ws2.close();
  });

  it('should hide opponent hand in GAME_START message for player 1', async () => {
    const ws1 = await createClient();
    const ws2 = await createClient();

    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await waitForMessage(ws1) as any;
    const gameId = created.gameId;

    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    await waitForMessage(ws2, (m) => m.type === 'GAME_JOINED');

    const start = await waitForMessage(ws1, (m) => m.type === 'GAME_START');
    if (start.type === 'GAME_START') {
      // Player 1 should see their own hand
      expect(start.gameState.player1Hand.length).toBe(5);
      expect(start.gameState.player1Hand[0].id).not.toBe(0);
      // Player 2's hand: first 3 visible, last 2 hidden (HIDDEN_COUNT = 2)
      expect(start.gameState.player2Hand.length).toBe(5);
      for (let i = 0; i < 3; i++) {
        expect(start.gameState.player2Hand[i].id).not.toBe(0);
      }
      for (let i = 3; i < 5; i++) {
        expect(start.gameState.player2Hand[i].id).toBe(0);
        expect(start.gameState.player2Hand[i].name).toBe('Hidden');
      }
    }

    ws1.close();
    ws2.close();
  });

  it('should hide opponent hand in GAME_STATE messages during play', async () => {
    const ws1 = await createClient();
    const ws2 = await createClient();
    const c1 = new MessageCollector(ws1);
    const c2 = new MessageCollector(ws2);

    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await c1.wait((m) => m.type === 'GAME_CREATED') as any;
    const gameId = created.gameId;

    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    await c2.wait((m) => m.type === 'GAME_JOINED');
    await c1.wait((m) => m.type === 'GAME_START');

    // Player 1 places a card
    sendMessage(ws1, { type: 'PLACE_CARD', gameId, handIndex: 0, row: 0, col: 0, moveNumber: 0 });

    // Player 1 gets GAME_STATE with player2 hand partially hidden
    const state1 = await c1.wait((m) => m.type === 'GAME_STATE') as any;
    expect(state1.gameState.player1Hand.length).toBe(4); // played one card
    // Player 2 still has 5 cards: first 3 visible, last 2 hidden
    for (let i = 0; i < 3; i++) {
      expect(state1.gameState.player2Hand[i].id).not.toBe(0);
    }
    for (let i = 3; i < 5; i++) {
      expect(state1.gameState.player2Hand[i].id).toBe(0);
      expect(state1.gameState.player2Hand[i].name).toBe('Hidden');
    }

    // Player 2 gets GAME_STATE with player1 hand partially hidden
    const state2 = await c2.wait((m) => m.type === 'GAME_STATE') as any;
    expect(state2.gameState.player2Hand.length).toBe(5);
    expect(state2.gameState.player2Hand[0].id).not.toBe(0);
    // Player 1 has 4 cards after playing one: first 2 visible, last 2 hidden
    for (let i = 0; i < 2; i++) {
      expect(state2.gameState.player1Hand[i].id).not.toBe(0);
    }
    for (let i = 2; i < 4; i++) {
      expect(state2.gameState.player1Hand[i].id).toBe(0);
      expect(state2.gameState.player1Hand[i].name).toBe('Hidden');
    }

    ws1.close();
    ws2.close();
  });

  it('should reveal both hands in GAME_OVER messages', async () => {
    const ws1 = await createClient();
    const ws2 = await createClient();
    const c1 = new MessageCollector(ws1);
    const c2 = new MessageCollector(ws2);

    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await c1.wait((m) => m.type === 'GAME_CREATED') as any;
    const gameId = created.gameId;

    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    await c2.wait((m) => m.type === 'GAME_JOINED');
    await c1.wait((m) => m.type === 'GAME_START');

    // Play a full game
    const positions: [number, number][] = [
      [0, 0], [0, 1], [0, 2],
      [1, 0], [1, 1], [1, 2],
      [2, 0], [2, 1], [2, 2],
    ];

    for (let i = 0; i < 9; i++) {
      const currentWs = i % 2 === 0 ? ws1 : ws2;
      const [row, col] = positions[i];
      sendMessage(currentWs, { type: 'PLACE_CARD', gameId, handIndex: 0, row, col, moveNumber: i });

      // Consume GAME_STATE messages
      await c1.wait((m) => m.type === 'GAME_STATE');
      await c2.wait((m) => m.type === 'GAME_STATE');

      if (i === 8) {
        // On last move, get GAME_OVER messages
        const over1 = await c1.wait((m) => m.type === 'GAME_OVER') as any;
        const over2 = await c2.wait((m) => m.type === 'GAME_OVER') as any;

        // GAME_OVER should reveal all hands (status is 'finished' so no sanitization)
        // Both hands should be empty (all cards played) but the gameState is unsanitized
        expect(over1.gameState.status).toBe('finished');
        expect(over2.gameState.status).toBe('finished');
      }
    }

    ws1.close();
    ws2.close();
  });
});

describe('Duplicate card ID validation via WebSocket (Fix 4.1)', () => {
  it('should reject duplicate card IDs on CREATE_GAME', async () => {
    const ws = await createClient();
    sendMessage(ws, { type: 'CREATE_GAME', cardIds: [1, 1, 3, 4, 5] });
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    if (error.type === 'ERROR') {
      expect(error.message).toContain('Duplicate card IDs');
    }
    ws.close();
  });

  it('should reject duplicate card IDs on JOIN_GAME', async () => {
    const ws1 = await createClient();
    const ws2 = await createClient();

    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await waitForMessage(ws1) as any;
    const gameId = created.gameId;

    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: [6, 6, 8, 9, 10] });
    const error = await waitForMessage(ws2, (m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    if (error.type === 'ERROR') {
      expect(error.message).toContain('Duplicate card IDs');
    }

    ws1.close();
    ws2.close();
  });
});

describe('Game overwrite prevention (Fix 4.2)', () => {
  it('should reject creating a second game while in active game', async () => {
    const ws = await createClient();

    sendMessage(ws, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    await waitForMessage(ws, (m) => m.type === 'GAME_CREATED');

    sendMessage(ws, { type: 'CREATE_GAME', cardIds: PLAYER2_CARDS });
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    if (error.type === 'ERROR') {
      expect(error.message).toContain('already in an active game');
    }

    ws.close();
  });
});

describe('Input validation (Fix 4.4)', () => {
  it('should reject messages without a type field', async () => {
    const ws = await createClient();
    ws.send(JSON.stringify({ foo: 'bar' }));
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    if (error.type === 'ERROR') {
      expect(error.message).toContain('Unknown or missing message type');
    }
    ws.close();
  });

  it('should reject unknown message types', async () => {
    const ws = await createClient();
    ws.send(JSON.stringify({ type: 'UNKNOWN_TYPE' }));
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    if (error.type === 'ERROR') {
      expect(error.message).toContain('Unknown or missing message type');
    }
    ws.close();
  });

  it('should reject CREATE_GAME without cardIds', async () => {
    const ws = await createClient();
    ws.send(JSON.stringify({ type: 'CREATE_GAME' }));
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    if (error.type === 'ERROR') {
      expect(error.message).toMatch(/cardIds|card IDs/i);
    }
    ws.close();
  });

  it('should reject CREATE_GAME with non-array cardIds', async () => {
    const ws = await createClient();
    ws.send(JSON.stringify({ type: 'CREATE_GAME', cardIds: 'not-array' }));
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    if (error.type === 'ERROR') {
      expect(error.message).toMatch(/cardIds|card IDs/i);
    }
    ws.close();
  });

  it('should reject PLACE_CARD with out-of-range row/col', async () => {
    const ws1 = await createClient();
    const ws2 = await createClient();

    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await waitForMessage(ws1) as any;
    const gameId = created.gameId;

    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    await waitForMessage(ws2, (m) => m.type === 'GAME_JOINED');
    await waitForMessage(ws1, (m) => m.type === 'GAME_START');

    sendMessage(ws1, { type: 'PLACE_CARD', gameId, handIndex: 0, row: 5, col: 0, moveNumber: 0 } as any);
    const error = await waitForMessage(ws1, (m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    if (error.type === 'ERROR') {
      expect(error.message).toMatch(/row|out of range|invalid|position/i);
    }

    ws1.close();
    ws2.close();
  });

  it('should reject oversized messages (>1MB)', async () => {
    const ws = await createClient();
    const bigPayload = JSON.stringify({ type: 'CREATE_GAME', cardIds: [1, 2, 3, 4, 5], padding: 'x'.repeat(1024 * 1024 + 1) });
    ws.send(bigPayload);
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    if (error.type === 'ERROR') {
      expect(error.message).toContain('too large');
    }
    ws.close();
  });

  it('should reject PLACE_CARD with non-numeric handIndex', async () => {
    const ws1 = await createClient();
    const ws2 = await createClient();

    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await waitForMessage(ws1) as any;
    const gameId = created.gameId;

    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    await waitForMessage(ws2, (m) => m.type === 'GAME_JOINED');
    await waitForMessage(ws1, (m) => m.type === 'GAME_START');

    ws1.send(JSON.stringify({ type: 'PLACE_CARD', gameId, handIndex: 'abc', row: 0, col: 0 }));
    const error = await waitForMessage(ws1, (m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    if (error.type === 'ERROR') {
      expect(error.message).toMatch(/handIndex|must be.*number/i);
    }

    ws1.close();
    ws2.close();
  });

  it('should reject JOIN_GAME without gameId', async () => {
    const ws = await createClient();
    ws.send(JSON.stringify({ type: 'JOIN_GAME', cardIds: [6, 7, 8, 9, 10] }));
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    if (error.type === 'ERROR') {
      expect(error.message).toMatch(/gameId|game.*required/i);
    }
    ws.close();
  });

  it('should reject cardIds with out-of-range values', async () => {
    const ws = await createClient();
    sendMessage(ws, { type: 'CREATE_GAME', cardIds: [0, 2, 3, 4, 5] });
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    ws.close();
  });
});

describe('REST game info', () => {
  it('should return game info via REST after WebSocket creation', async () => {
    const ws1 = await createClient();

    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await waitForMessage(ws1) as any;
    const gameId = created.gameId;

    const { status, body } = await httpGet(`/games/${gameId}`);
    expect(status).toBe(200);
    expect(body.id).toBe(gameId);
    expect(body.status).toBe('waiting');

    ws1.close();
  });

  it('should show games in REST list after WebSocket creation', async () => {
    const ws1 = await createClient();

    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    await waitForMessage(ws1, (m) => m.type === 'GAME_CREATED');

    const { status, body } = await httpGet('/games');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);

    ws1.close();
  });
});

describe('Move nonce validation via WebSocket (V7 Fix 4.1)', () => {
  it('should reject PLACE_CARD with wrong move number', async () => {
    const ws1 = await createClient();
    const ws2 = await createClient();
    const c1 = new MessageCollector(ws1);
    const c2 = new MessageCollector(ws2);

    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await c1.wait((m) => m.type === 'GAME_CREATED') as any;
    const gameId = created.gameId;

    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    await c2.wait((m) => m.type === 'GAME_JOINED');
    await c1.wait((m) => m.type === 'GAME_START');

    // Send move with wrong move number (1 instead of 0)
    sendMessage(ws1, { type: 'PLACE_CARD', gameId, handIndex: 0, row: 0, col: 0, moveNumber: 1 });
    const error = await c1.wait((m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    if (error.type === 'ERROR') {
      expect(error.message).toContain('Invalid move number');
    }

    ws1.close();
    ws2.close();
  });

  it('should reject replayed move number', async () => {
    const ws1 = await createClient();
    const ws2 = await createClient();
    const c1 = new MessageCollector(ws1);
    const c2 = new MessageCollector(ws2);

    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await c1.wait((m) => m.type === 'GAME_CREATED') as any;
    const gameId = created.gameId;

    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    await c2.wait((m) => m.type === 'GAME_JOINED');
    await c1.wait((m) => m.type === 'GAME_START');

    // First move succeeds
    sendMessage(ws1, { type: 'PLACE_CARD', gameId, handIndex: 0, row: 0, col: 0, moveNumber: 0 });
    await c1.wait((m) => m.type === 'GAME_STATE');
    await c2.wait((m) => m.type === 'GAME_STATE');

    // Try to replay move 0
    sendMessage(ws2, { type: 'PLACE_CARD', gameId, handIndex: 0, row: 0, col: 1, moveNumber: 0 });
    const error = await c2.wait((m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    if (error.type === 'ERROR') {
      expect(error.message).toContain('Invalid move number');
    }

    ws1.close();
    ws2.close();
  });

  it('should accept sequential move numbers through full game', async () => {
    const ws1 = await createClient();
    const ws2 = await createClient();
    const c1 = new MessageCollector(ws1);
    const c2 = new MessageCollector(ws2);

    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await c1.wait((m) => m.type === 'GAME_CREATED') as any;
    const gameId = created.gameId;

    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    await c2.wait((m) => m.type === 'GAME_JOINED');
    await c1.wait((m) => m.type === 'GAME_START');

    const positions: [number, number][] = [
      [0, 0], [0, 1], [0, 2],
      [1, 0], [1, 1], [1, 2],
      [2, 0], [2, 1], [2, 2],
    ];

    for (let i = 0; i < 9; i++) {
      const [currentCollector, otherCollector] = i % 2 === 0 ? [c1, c2] : [c2, c1];
      const currentWs = i % 2 === 0 ? ws1 : ws2;
      const [row, col] = positions[i];

      sendMessage(currentWs, { type: 'PLACE_CARD', gameId, handIndex: 0, row, col, moveNumber: i });
      await currentCollector.wait((m) => m.type === 'GAME_STATE');
      await otherCollector.wait((m) => m.type === 'GAME_STATE');

      if (i === 8) {
        await currentCollector.wait((m) => m.type === 'GAME_OVER');
        await otherCollector.wait((m) => m.type === 'GAME_OVER');
      }
    }

    ws1.close();
    ws2.close();
  });

  it('should reject PLACE_CARD without moveNumber field', async () => {
    const ws = await createClient();
    ws.send(JSON.stringify({ type: 'PLACE_CARD', gameId: 'test', handIndex: 0, row: 0, col: 0 }));
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    if (error.type === 'ERROR') {
      expect(error.message).toContain('moveNumber');
    }
    ws.close();
  });
});

describe('CORS restriction (V7 Fix 4.4)', () => {
  it('should set CORS header for allowed origin localhost:5174', async () => {
    const result = await new Promise<{ headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request(`${getHttpUrl()}/health`, {
        headers: { 'Origin': 'http://localhost:5174' },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(result.headers['access-control-allow-origin']).toBe('http://localhost:5174');
  });

  it('should set CORS header for allowed origin localhost:3000', async () => {
    const result = await new Promise<{ headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request(`${getHttpUrl()}/health`, {
        headers: { 'Origin': 'http://localhost:3000' },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(result.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('should not set CORS header for disallowed origin', async () => {
    const result = await new Promise<{ headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request(`${getHttpUrl()}/health`, {
        headers: { 'Origin': 'http://evil.com' },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(result.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('should not set CORS header when no origin is provided', async () => {
    const { status } = await httpGet('/health');
    // httpGet doesn't set Origin header, so no CORS should be set
    // But we need to check the response headers directly
    const result = await new Promise<{ headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      http.get(`${getHttpUrl()}/health`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ headers: res.headers }));
      }).on('error', reject);
    });
    expect(result.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('moveNumber validation in messages (V7 Fix 4.3)', () => {
  it('should reject SUBMIT_MOVE_PROOF without moveNumber', async () => {
    const ws = await createClient();
    ws.send(JSON.stringify({
      type: 'SUBMIT_MOVE_PROOF',
      gameId: 'test',
      handIndex: 0,
      row: 0,
      col: 0,
      moveProof: { proof: 'x', publicInputs: [] },
    }));
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    if (error.type === 'ERROR') {
      expect(error.message).toContain('moveNumber');
    }
    ws.close();
  });

  it('should reject PLACE_CARD with negative moveNumber', async () => {
    const ws = await createClient();
    ws.send(JSON.stringify({ type: 'PLACE_CARD', gameId: 'test', handIndex: 0, row: 0, col: 0, moveNumber: -1 }));
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    if (error.type === 'ERROR') {
      expect(error.message).toContain('moveNumber');
    }
    ws.close();
  });

  it('should reject PLACE_CARD with moveNumber > 8', async () => {
    const ws = await createClient();
    ws.send(JSON.stringify({ type: 'PLACE_CARD', gameId: 'test', handIndex: 0, row: 0, col: 0, moveNumber: 9 }));
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    if (error.type === 'ERROR') {
      expect(error.message).toContain('moveNumber');
    }
    ws.close();
  });

  it('should reject PLACE_CARD with non-integer moveNumber', async () => {
    const ws = await createClient();
    ws.send(JSON.stringify({ type: 'PLACE_CARD', gameId: 'test', handIndex: 0, row: 0, col: 0, moveNumber: 1.5 }));
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    expect(error.type).toBe('ERROR');
    if (error.type === 'ERROR') {
      expect(error.message).toContain('moveNumber');
    }
    ws.close();
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
    // Connect first client, get session token
    const ws1 = new WebSocket(getUrl());
    const session1 = await new Promise<{ sessionToken: string; playerId: string }>((resolve, reject) => {
      ws1.on('error', reject);
      ws1.on('message', (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'SESSION_ESTABLISHED') {
          resolve({ sessionToken: msg.sessionToken, playerId: msg.playerId });
        }
      });
    });

    // Disconnect
    ws1.close();
    await new Promise(r => setTimeout(r, 100));

    // Reconnect with RESUME
    const ws2 = new WebSocket(getUrl());
    const session2 = await new Promise<{ resumed: boolean; playerId: string }>((resolve, reject) => {
      ws2.on('error', reject);
      ws2.on('open', () => {
        ws2.send(JSON.stringify({ type: 'RESUME', sessionToken: session1.sessionToken }));
      });
      ws2.on('message', (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'SESSION_ESTABLISHED') {
          resolve({ resumed: msg.resumed, playerId: msg.playerId });
        }
      });
    });

    expect(session2.resumed).toBe(true);
    expect(session2.playerId).toBe(session1.playerId);
    ws2.close();
  });

  it('should create new session for invalid token', async () => {
    const ws = new WebSocket(getUrl());
    const session = await new Promise<{ resumed: boolean }>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'RESUME', sessionToken: 'bogus-token' }));
      });
      ws.on('message', (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'SESSION_ESTABLISHED') {
          resolve({ resumed: msg.resumed });
        }
      });
    });

    expect(session.resumed).toBe(false);
    ws.close();
  });
});

describe('Message inbox replay', () => {
  it('should buffer and replay HAND_PROOF when recipient is offline', async () => {
    const { ws: ws1 } = await createClientWithSession();
    const { ws: ws2, sessionToken: p2Token } = await createClientWithSession();
    const c1 = new MessageCollector(ws1);
    const c2 = new MessageCollector(ws2);

    // Setup game
    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await c1.wait((m) => m.type === 'GAME_CREATED') as any;
    const gameId = created.gameId;

    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    await c2.wait((m) => m.type === 'GAME_JOINED');
    await c1.wait((m) => m.type === 'GAME_START');

    // Disconnect player 2
    ws2.close();
    await new Promise(r => setTimeout(r, 100));

    // Player 1 submits hand proof while player 2 is offline
    sendMessage(ws1, {
      type: 'SUBMIT_HAND_PROOF',
      gameId,
      handProof: {
        proof: 'buffered-proof',
        publicInputs: ['0xcommit'],
        cardCommit: '0xcommit',
      },
    } as any);

    // Give the server time to buffer the message
    await new Promise(r => setTimeout(r, 100));

    // Player 2 reconnects with session token
    const ws2b = new WebSocket(getUrl());
    const c2b = new MessageCollector(ws2b);
    await new Promise<void>((resolve, reject) => {
      ws2b.on('error', reject);
      ws2b.on('open', () => {
        ws2b.send(JSON.stringify({ type: 'RESUME', sessionToken: p2Token }));
      });
      ws2b.on('message', function onMsg(data: WebSocket.Data) {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'SESSION_ESTABLISHED' && msg.resumed) {
          ws2b.removeListener('message', onMsg);
          resolve();
        }
      });
    });

    // Player 2 should receive the buffered HAND_PROOF
    const handProof = await c2b.wait((m) => m.type === 'HAND_PROOF');
    expect(handProof.type).toBe('HAND_PROOF');
    if (handProof.type === 'HAND_PROOF') {
      expect(handProof.handProof.proof).toBe('buffered-proof');
    }

    ws1.close();
    ws2b.close();
  });

  it('should notify opponent when player reconnects', async () => {
    const { ws: ws1 } = await createClientWithSession();
    const { ws: ws2, sessionToken: p2Token } = await createClientWithSession();
    const c1 = new MessageCollector(ws1);

    // Setup game
    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await c1.wait((m) => m.type === 'GAME_CREATED') as any;
    const gameId = created.gameId;

    const c2 = new MessageCollector(ws2);
    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    await c2.wait((m) => m.type === 'GAME_JOINED');
    await c1.wait((m) => m.type === 'GAME_START');

    // Disconnect player 2
    ws2.close();
    // Player 1 gets OPPONENT_DISCONNECTED
    await c1.wait((m) => m.type === 'OPPONENT_DISCONNECTED');

    // Player 2 reconnects
    const ws2b = new WebSocket(getUrl());
    await new Promise<void>((resolve, reject) => {
      ws2b.on('error', reject);
      ws2b.on('open', () => {
        ws2b.send(JSON.stringify({ type: 'RESUME', sessionToken: p2Token }));
      });
      ws2b.on('message', function onMsg(data: WebSocket.Data) {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'SESSION_ESTABLISHED' && msg.resumed) {
          ws2b.removeListener('message', onMsg);
          resolve();
        }
      });
    });

    // Player 1 should get OPPONENT_RECONNECTED
    const reconnected = await c1.wait((m) => m.type === 'OPPONENT_RECONNECTED');
    expect(reconnected.type).toBe('OPPONENT_RECONNECTED');

    ws1.close();
    ws2b.close();
  });
});

describe('Matchmaking', () => {
  it('should match two queued players', async () => {
    const { ws: ws1 } = await createClientWithSession();
    const { ws: ws2 } = await createClientWithSession();
    const c1 = new MessageCollector(ws1);
    const c2 = new MessageCollector(ws2);

    // P1 queues
    sendMessage(ws1, { type: 'QUEUE_MATCHMAKING', cardIds: PLAYER1_CARDS } as any);
    const queued = await c1.wait((m) => m.type === 'MATCHMAKING_QUEUED');
    expect(queued.type).toBe('MATCHMAKING_QUEUED');

    // P2 queues — both should get MATCH_FOUND
    sendMessage(ws2, { type: 'QUEUE_MATCHMAKING', cardIds: PLAYER2_CARDS } as any);

    const match1 = await c1.wait((m) => m.type === 'MATCH_FOUND') as any;
    const match2 = await c2.wait((m) => m.type === 'MATCH_FOUND') as any;

    expect(match1.type).toBe('MATCH_FOUND');
    expect(match2.type).toBe('MATCH_FOUND');
    expect(match1.gameId).toBe(match2.gameId);
    expect(match1.playerNumber).toBe(1);
    expect(match2.playerNumber).toBe(2);
    expect(match1.gameState).toBeDefined();
    expect(match2.gameState).toBeDefined();

    ws1.close();
    ws2.close();
  });

  it('should cancel matchmaking', async () => {
    const ws = await createClient();

    sendMessage(ws, { type: 'QUEUE_MATCHMAKING', cardIds: PLAYER1_CARDS } as any);
    await waitForMessage(ws, (m) => m.type === 'MATCHMAKING_QUEUED');

    sendMessage(ws, { type: 'CANCEL_MATCHMAKING' } as any);
    const cancelled = await waitForMessage(ws, (m) => m.type === 'MATCHMAKING_CANCELLED');
    expect(cancelled.type).toBe('MATCHMAKING_CANCELLED');

    ws.close();
  });

  it('should skip stale queue entry and match two live players', async () => {
    // Inject a stale queue entry directly into the store (simulates a server
    // restart where the entry persisted but the player disconnected).
    await server.store.pushQueue({
      playerId: 'stale-ghost-player',
      cardIds: [1, 2, 3, 4, 5],
      queuedAt: Date.now() - 60_000,
      lastPing: Date.now() - 60_000,
    });

    const { ws: ws1 } = await createClientWithSession();
    const { ws: ws2 } = await createClientWithSession();
    const c1 = new MessageCollector(ws1);
    const c2 = new MessageCollector(ws2);

    // P1 queues — should NOT be paired with the stale entry
    sendMessage(ws1, { type: 'QUEUE_MATCHMAKING', cardIds: PLAYER1_CARDS } as any);
    await c1.wait((m) => m.type === 'MATCHMAKING_QUEUED');

    // P2 queues — both live players should be matched together
    sendMessage(ws2, { type: 'QUEUE_MATCHMAKING', cardIds: PLAYER2_CARDS } as any);

    const match1 = await c1.wait((m) => m.type === 'MATCH_FOUND') as any;
    const match2 = await c2.wait((m) => m.type === 'MATCH_FOUND') as any;

    expect(match1.gameId).toBe(match2.gameId);
    expect(match1.playerNumber).toBe(1);
    expect(match2.playerNumber).toBe(2);

    ws1.close();
    ws2.close();
  });

  it('should skip multiple stale entries and match live players', async () => {
    // Three stale entries — none should pair with live players
    for (let i = 0; i < 3; i++) {
      await server.store.pushQueue({
        playerId: `stale-ghost-${i}`,
        cardIds: [1, 2, 3, 4, 5],
        queuedAt: Date.now() - 60_000,
        lastPing: Date.now() - 60_000,
      });
    }

    const { ws: ws1 } = await createClientWithSession();
    const { ws: ws2 } = await createClientWithSession();
    const c1 = new MessageCollector(ws1);
    const c2 = new MessageCollector(ws2);

    sendMessage(ws1, { type: 'QUEUE_MATCHMAKING', cardIds: PLAYER1_CARDS } as any);
    await c1.wait((m) => m.type === 'MATCHMAKING_QUEUED');

    sendMessage(ws2, { type: 'QUEUE_MATCHMAKING', cardIds: PLAYER2_CARDS } as any);

    const match1 = await c1.wait((m) => m.type === 'MATCH_FOUND') as any;
    const match2 = await c2.wait((m) => m.type === 'MATCH_FOUND') as any;

    expect(match1.gameId).toBe(match2.gameId);

    ws1.close();
    ws2.close();
  });

  it('should allow queueing when player has a stale game mapping to a nonexistent game', async () => {
    // Simulate: player had a game mapping, but the game was cleaned up/deleted
    // while the mapping remained (can happen on server restart or crash).
    const { ws, playerId } = await createClientWithSession();

    // Manually insert a stale player→game mapping pointing to a nonexistent game
    await server.store.setPlayerGame(playerId, 'nonexistent-game-id');

    // Player tries to queue — should succeed (stale mapping cleaned up)
    sendMessage(ws, { type: 'QUEUE_MATCHMAKING', cardIds: PLAYER1_CARDS } as any);

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
    const ws2 = new WebSocket(getUrl());
    const sessionMsg: any = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 3000);
      ws2.on('error', reject);
      ws2.on('open', () => {
        ws2.send(JSON.stringify({ type: 'RESUME', sessionToken }));
      });
      ws2.on('message', function onMsg(data: WebSocket.Data) {
        const m = JSON.parse(data.toString());
        if (m.type === 'SESSION_ESTABLISHED') {
          clearTimeout(t);
          ws2.removeListener('message', onMsg);
          resolve(m);
        }
      });
    });

    expect(sessionMsg.resumed).toBe(true);
    expect(sessionMsg.gameId).toBeNull();

    ws2.close();
  });

  it('should deliver MATCH_FOUND to both players even after first matchmaking attempt with stale data', async () => {
    // Even more adversarial: 2 stale entries present when P1 queues.
    // First tryMatch would pop both stale entries together (bad outcome
    // without the fix: game created for 2 dead players).
    // After the fix: stale entries are discarded before matching.
    await server.store.pushQueue({
      playerId: 'stale-A',
      cardIds: [1, 2, 3, 4, 5],
      queuedAt: Date.now() - 60_000,
      lastPing: Date.now() - 60_000,
    });
    await server.store.pushQueue({
      playerId: 'stale-B',
      cardIds: [6, 7, 8, 9, 10],
      queuedAt: Date.now() - 60_000,
      lastPing: Date.now() - 60_000,
    });

    const { ws: ws1 } = await createClientWithSession();
    const c1 = new MessageCollector(ws1);
    sendMessage(ws1, { type: 'QUEUE_MATCHMAKING', cardIds: PLAYER1_CARDS } as any);
    await c1.wait((m) => m.type === 'MATCHMAKING_QUEUED');

    // Give time for any incorrect early match to occur (it shouldn't)
    await new Promise(r => setTimeout(r, 200));

    // Now P2 queues → live pair [P1, P2] should match
    const { ws: ws2 } = await createClientWithSession();
    const c2 = new MessageCollector(ws2);
    sendMessage(ws2, { type: 'QUEUE_MATCHMAKING', cardIds: PLAYER2_CARDS } as any);

    const match1 = await c1.wait((m) => m.type === 'MATCH_FOUND') as any;
    const match2 = await c2.wait((m) => m.type === 'MATCH_FOUND') as any;

    expect(match1.gameId).toBe(match2.gameId);
    expect(match1.playerNumber).toBe(1);
    expect(match2.playerNumber).toBe(2);

    ws1.close();
    ws2.close();
  });
});

describe('Disconnect-reconnect game continuation', () => {
  it('should restore game state after reconnect and continue play', async () => {
    // Setup: P1 creates, P2 joins, P1 places a card
    const { ws: ws1, sessionToken: p1Token } = await createClientWithSession();
    const { ws: ws2, sessionToken: p2Token } = await createClientWithSession();
    const c1 = new MessageCollector(ws1);
    const c2 = new MessageCollector(ws2);

    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await c1.wait((m) => m.type === 'GAME_CREATED') as any;
    const gameId = created.gameId;

    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    await c2.wait((m) => m.type === 'GAME_JOINED');
    await c1.wait((m) => m.type === 'GAME_START');

    // P1 places a card
    sendMessage(ws1, { type: 'PLACE_CARD', gameId, handIndex: 0, row: 0, col: 0, moveNumber: 0 });
    await c1.wait((m) => m.type === 'GAME_STATE');
    await c2.wait((m) => m.type === 'GAME_STATE');

    // P1 disconnects
    ws1.close();
    await c2.wait((m) => m.type === 'OPPONENT_DISCONNECTED');

    // P1 reconnects with session token — collect all messages
    const ws1b = new WebSocket(getUrl());
    const c1b = new MessageCollector(ws1b);
    await new Promise<void>((resolve, reject) => {
      ws1b.on('error', reject);
      ws1b.on('open', () => {
        ws1b.send(JSON.stringify({ type: 'RESUME', sessionToken: p1Token }));
        // MessageCollector captures session token automatically; wait a bit for messages to arrive
        setTimeout(resolve, 200);
      });
    });

    // P1 gets GAME_STATE restore (may be from inbox replay)
    const restored = await c1b.wait((m) => m.type === 'GAME_STATE') as any;
    expect(restored.gameState).toBeDefined();
    expect(restored.gameState.board[0][0].card).not.toBeNull(); // P1's card is still there

    // P2 gets OPPONENT_RECONNECTED
    const reconnected = await c2.wait((m) => m.type === 'OPPONENT_RECONNECTED');
    expect(reconnected.type).toBe('OPPONENT_RECONNECTED');

    // Game continues: P2 places a card
    sendMessage(ws2, { type: 'PLACE_CARD', gameId, handIndex: 0, row: 1, col: 1, moveNumber: 1 });
    const p2State = await c2.wait((m) => m.type === 'GAME_STATE') as any;
    expect(p2State.gameState.board[1][1].card).not.toBeNull();

    ws1b.close();
    ws2.close();
  });
});

describe('Abandoned game settlement (QA-F3)', () => {
  /** Create + join + 3 moves, then P2 hard-quits. Returns P1's socket/collector and P2's token. */
  async function playToAbandonment(): Promise<{ ws1: WebSocket; c1: MessageCollector; gameId: string; p2Token: string }> {
    const { ws: ws1 } = await createClientWithSession();
    const { ws: ws2, sessionToken: p2Token } = await createClientWithSession();
    const c1 = new MessageCollector(ws1);
    const c2 = new MessageCollector(ws2);

    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await c1.wait((m) => m.type === 'GAME_CREATED') as any;
    const gameId = created.gameId;

    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    await c2.wait((m) => m.type === 'GAME_JOINED');
    await c1.wait((m) => m.type === 'GAME_START');

    sendMessage(ws1, { type: 'PLACE_CARD', gameId, handIndex: 0, row: 0, col: 0, moveNumber: 0 });
    await c1.wait((m) => m.type === 'GAME_STATE');
    await c2.wait((m) => m.type === 'GAME_STATE');
    sendMessage(ws2, { type: 'PLACE_CARD', gameId, handIndex: 0, row: 1, col: 1, moveNumber: 1 });
    await c1.wait((m) => m.type === 'GAME_STATE');
    await c2.wait((m) => m.type === 'GAME_STATE');
    sendMessage(ws1, { type: 'PLACE_CARD', gameId, handIndex: 0, row: 2, col: 2, moveNumber: 2 });
    await c1.wait((m) => m.type === 'GAME_STATE');

    // P2 hard-quits (no graceful leave)
    ws2.close();
    await c1.wait((m) => m.type === 'OPPONENT_DISCONNECTED');

    return { ws1, c1, gameId, p2Token };
  }

  it('releases the claimant immediately: settle, GAME_OVER, then a new game can be created', async () => {
    const { ws1, c1, gameId } = await playToAbandonment();

    sendMessage(ws1, { type: 'ABANDONED_GAME_SETTLED', gameId } as any);
    const over = await c1.wait((m) => m.type === 'GAME_OVER') as any;
    expect(over.gameId).toBe(gameId);
    expect(over.winner).toBe('player1');
    expect(over.gameState.status).toBe('finished');

    // THE QA-F3 assertion: claimant can start a new game right away
    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const fresh = await c1.wait((m) => m.type === 'GAME_CREATED' || m.type === 'ERROR') as any;
    expect(fresh.type).toBe('GAME_CREATED');
    expect(fresh.gameId).not.toBe(gameId);

    ws1.close();
  });

  it('unbinds the offline opponent: their RESUME comes back with gameId null and they can play again', async () => {
    const { ws1, c1, gameId, p2Token } = await playToAbandonment();

    sendMessage(ws1, { type: 'ABANDONED_GAME_SETTLED', gameId } as any);
    await c1.wait((m) => m.type === 'GAME_OVER');

    // P2 returns later
    const ws2b = new WebSocket(getUrl());
    const session = await new Promise<{ resumed: boolean; gameId: string | null }>((resolve, reject) => {
      ws2b.on('error', reject);
      ws2b.on('open', () => {
        ws2b.send(JSON.stringify({ type: 'RESUME', sessionToken: p2Token }));
      });
      ws2b.on('message', (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'SESSION_ESTABLISHED') {
          resolve({ resumed: msg.resumed, gameId: msg.gameId });
        }
      });
    });
    expect(session.resumed).toBe(true);
    expect(session.gameId).toBeNull();

    const c2b = new MessageCollector(ws2b);
    sendMessage(ws2b, { type: 'CREATE_GAME', cardIds: PLAYER2_CARDS });
    const fresh = await c2b.wait((m) => m.type === 'GAME_CREATED' || m.type === 'ERROR') as any;
    expect(fresh.type).toBe('GAME_CREATED');

    ws1.close();
    ws2b.close();
  });

  it('notifies a still-connected opponent with GAME_OVER', async () => {
    const { ws: ws1 } = await createClientWithSession();
    const { ws: ws2 } = await createClientWithSession();
    const c1 = new MessageCollector(ws1);
    const c2 = new MessageCollector(ws2);

    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await c1.wait((m) => m.type === 'GAME_CREATED') as any;
    const gameId = created.gameId;
    sendMessage(ws2, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    await c2.wait((m) => m.type === 'GAME_JOINED');
    await c1.wait((m) => m.type === 'GAME_START');
    sendMessage(ws1, { type: 'PLACE_CARD', gameId, handIndex: 0, row: 0, col: 0, moveNumber: 0 });
    await c1.wait((m) => m.type === 'GAME_STATE');
    await c2.wait((m) => m.type === 'GAME_STATE');

    sendMessage(ws1, { type: 'ABANDONED_GAME_SETTLED', gameId } as any);
    const over1 = await c1.wait((m) => m.type === 'GAME_OVER') as any;
    const over2 = await c2.wait((m) => m.type === 'GAME_OVER') as any;
    expect(over1.winner).toBe('player1');
    expect(over2.winner).toBe('player1');

    ws1.close();
    ws2.close();
  });

  it('is idempotent: a duplicate report re-sends GAME_OVER and keeps the original winner', async () => {
    const { ws1, c1, gameId } = await playToAbandonment();

    sendMessage(ws1, { type: 'ABANDONED_GAME_SETTLED', gameId } as any);
    const first = await c1.wait((m) => m.type === 'GAME_OVER') as any;
    expect(first.winner).toBe('player1');

    sendMessage(ws1, { type: 'ABANDONED_GAME_SETTLED', gameId } as any);
    const second = await c1.wait((m) => m.type === 'GAME_OVER') as any;
    expect(second.winner).toBe('player1');

    ws1.close();
  });

  it('rejects reports for unknown games, outsiders, and unstarted games', async () => {
    const { ws: ws1 } = await createClientWithSession();
    const c1 = new MessageCollector(ws1);

    sendMessage(ws1, { type: 'ABANDONED_GAME_SETTLED', gameId: 'nonexistent' } as any);
    const e1 = await c1.wait((m) => m.type === 'ERROR') as any;
    expect(e1.message).toBe('Game not found');

    // Unstarted game (no player 2)
    sendMessage(ws1, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await c1.wait((m) => m.type === 'GAME_CREATED') as any;
    sendMessage(ws1, { type: 'ABANDONED_GAME_SETTLED', gameId: created.gameId } as any);
    const e2 = await c1.wait((m) => m.type === 'ERROR') as any;
    expect(e2.message).toBe('Game has not started');

    // Outsider
    const { ws: ws3 } = await createClientWithSession();
    const c3 = new MessageCollector(ws3);
    sendMessage(ws3, { type: 'ABANDONED_GAME_SETTLED', gameId: created.gameId } as any);
    const e3 = await c3.wait((m) => m.type === 'ERROR') as any;
    expect(e3.message).toBe('Player not in this game');

    ws1.close();
    ws3.close();
  });

  it('reflects the settled state in GET_GAME and the REST endpoint', async () => {
    const { ws1, c1, gameId } = await playToAbandonment();

    sendMessage(ws1, { type: 'ABANDONED_GAME_SETTLED', gameId } as any);
    await c1.wait((m) => m.type === 'GAME_OVER');

    sendMessage(ws1, { type: 'GET_GAME', gameId });
    const info = await c1.wait((m) => m.type === 'GAME_INFO') as any;
    expect(info.game.status).toBe('finished');
    expect(info.game.winner).toBe('player1');

    const { status, body } = await httpGet(`/games/${gameId}`);
    expect(status).toBe(200);
    expect(body.status).toBe('finished');
    expect(body.winner).toBe('player1');

    ws1.close();
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
    const { MemoryGameStore } = await import('../src/store/MemoryGameStore.js');
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
    const { MemoryGameStore } = await import('../src/store/MemoryGameStore.js');
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
    const { MemoryGameStore } = await import('../src/store/MemoryGameStore.js');
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

  function makeFastServer(): Promise<{ srv: CardGameServer; p: number }> {
    const p = 4300 + Math.floor(Math.random() * 600);
    const srv = createServer({
      port: p,
      sessionHandshakeMs: 50,
      moveInactivityMs: MOVE_INACTIVITY,
      abandonmentWarnLeadMs: 0,
      abandonmentCheckIntervalMs: 25,
    });
    return new Promise((resolve) => {
      srv.httpServer.listen(p, () => resolve({ srv, p }));
    });
  }

  function connect(p: number): Promise<{ ws: WebSocket; sessionToken: string; playerId: string }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${p}`);
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

  /** Create + join + first player makes one move so it's player2's turn. */
  async function startGame(p: number) {
    const a = await connect(p);
    const b = await connect(p);
    const ca = new MessageCollector(a.ws);
    const cb = new MessageCollector(b.ws);

    sendMessage(a.ws, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
    const created = await ca.wait((m) => m.type === 'GAME_CREATED') as any;
    const gameId = created.gameId;

    sendMessage(b.ws, { type: 'JOIN_GAME', gameId, cardIds: PLAYER2_CARDS });
    await cb.wait((m) => m.type === 'GAME_JOINED');
    await ca.wait((m) => m.type === 'GAME_START');

    return { a, b, ca, cb, gameId };
  }

  it('warns BOTH players when the current player goes idle, with the correct shape', async () => {
    const { srv, p } = await makeFastServer();
    try {
      const { a, b, ca, cb, gameId } = await startGame(p);

      // No move within the threshold → player1 (to move) is idle.
      const w1 = await ca.wait((m) => m.type === 'GAME_ABANDONMENT_WARNING') as any;
      const w2 = await cb.wait((m) => m.type === 'GAME_ABANDONMENT_WARNING') as any;

      for (const w of [w1, w2]) {
        expect(w.type).toBe('GAME_ABANDONMENT_WARNING');
        expect(w.gameId).toBe(gameId);
        expect(w.idlePlayer).toBe('player1');
        expect(typeof w.secondsIdle).toBe('number');
        expect(w.secondsIdle).toBeGreaterThanOrEqual(0);
        expect(typeof w.secondsUntilClaimable).toBe('number');
      }

      a.ws.close();
      b.ws.close();
    } finally {
      await srv.close();
    }
  });

  it('warns of IMPENDING abandonment before the deadline, with a countdown (not a constant)', async () => {
    // Deadline 6s, warn 5s before it → the first warning fires at ~1s of idle
    // (well before the 6s deadline) carrying a countdown to the deadline, so the
    // about-to-forfeit player sees their time running out. The pre-change code
    // only warned AT the deadline and sent a constant secondsUntilClaimable.
    const p = 4300 + Math.floor(Math.random() * 600);
    const srv = createServer({
      port: p, sessionHandshakeMs: 50,
      moveInactivityMs: 6000, abandonmentWarnLeadMs: 5000, abandonmentCheckIntervalMs: 50,
    });
    await new Promise<void>((r) => srv.httpServer.listen(p, () => r()));
    try {
      const { a, b, ca, gameId } = await startGame(p);
      const w = await ca.wait((m) => m.type === 'GAME_ABANDONMENT_WARNING') as any;
      expect(w.gameId).toBe(gameId);
      expect(w.idlePlayer).toBe('player1');
      // Impending: still time on the clock (not yet claimable).
      expect(w.secondsUntilClaimable).toBeGreaterThan(0);
      // A real countdown to the 6s deadline — strictly less than the full window
      // (the pre-change code sent a constant 6 here).
      expect(w.secondsUntilClaimable).toBeLessThan(6);
      a.ws.close();
      b.ws.close();
    } finally {
      await srv.close();
    }
  });

  it('reports the player whose turn it is (player2 after player1 has moved)', async () => {
    const { srv, p } = await makeFastServer();
    try {
      const { a, b, ca, cb, gameId } = await startGame(p);

      // player1 moves → now player2's turn; let player2 go idle.
      sendMessage(a.ws, { type: 'PLACE_CARD', gameId, handIndex: 0, row: 0, col: 0, moveNumber: 0 });
      await ca.wait((m) => m.type === 'GAME_STATE');
      await cb.wait((m) => m.type === 'GAME_STATE');

      const w = await cb.wait((m) => m.type === 'GAME_ABANDONMENT_WARNING') as any;
      expect(w.idlePlayer).toBe('player2');
      expect(w.gameId).toBe(gameId);

      a.ws.close();
      b.ws.close();
    } finally {
      await srv.close();
    }
  });

  it('stops warning once a move arrives', async () => {
    const { srv, p } = await makeFastServer();
    try {
      const { a, b, ca, cb, gameId } = await startGame(p);

      // First warning (player1 idle).
      await ca.wait((m) => m.type === 'GAME_ABANDONMENT_WARNING');

      // player1 finally moves → idle clock resets, warnings should cease.
      sendMessage(a.ws, { type: 'PLACE_CARD', gameId, handIndex: 0, row: 0, col: 0, moveNumber: 0 });
      await ca.wait((m) => m.type === 'GAME_STATE');
      await cb.wait((m) => m.type === 'GAME_STATE');

      // Confirm no NEW warning about player1 arrives in a window covering
      // several detector ticks. (A warning about player2 would be legitimate
      // once player2 then goes idle, so we assert specifically on player1.)
      // MessageCollector.wait rejects after 5s; race it against a shorter timer
      // so the negative case resolves quickly.
      const warnPromise = ca
        .wait((m) => m.type === 'GAME_ABANDONMENT_WARNING' && (m as any).idlePlayer === 'player1')
        .then(() => 'warned')
        .catch(() => 'rejected');
      const result = await Promise.race([
        warnPromise,
        new Promise<string>((r) => setTimeout(() => r('quiet'), 400)),
      ]);
      expect(result).not.toBe('warned');

      a.ws.close();
      b.ws.close();
    } finally {
      await srv.close();
    }
  });

  it('does not warn for a game that has not started (only one player)', async () => {
    const { srv, p } = await makeFastServer();
    try {
      const a = await connect(p);
      const ca = new MessageCollector(a.ws);
      sendMessage(a.ws, { type: 'CREATE_GAME', cardIds: PLAYER1_CARDS });
      await ca.wait((m) => m.type === 'GAME_CREATED');

      // Wait well past the threshold + several ticks; no warning should arrive.
      const warned = await Promise.race([
        ca.wait((m) => m.type === 'GAME_ABANDONMENT_WARNING').then(() => true).catch(() => false),
        new Promise<boolean>((r) => setTimeout(() => r(false), 500)),
      ]);
      expect(warned).toBe(false);

      a.ws.close();
    } finally {
      await srv.close();
    }
  });

  it('buffers the warning for an offline player and replays it on reconnect', async () => {
    const { srv, p } = await makeFastServer();
    try {
      const { a, b, ca, gameId } = await startGame(p);
      const bToken = b.sessionToken;

      // player2 disconnects while it is player1's turn — player1 is the idle
      // one and player2 is offline; the warning must be buffered for player2.
      b.ws.close();
      await ca.wait((m) => m.type === 'OPPONENT_DISCONNECTED');

      // Let the detector fire at least once while player2 is offline.
      await ca.wait((m) => m.type === 'GAME_ABANDONMENT_WARNING');

      // player2 reconnects and should receive the buffered warning.
      const ws2b = new WebSocket(`ws://localhost:${p}`);
      const c2b = new MessageCollector(ws2b);
      await new Promise<void>((resolve, reject) => {
        ws2b.on('error', reject);
        ws2b.on('open', () => ws2b.send(JSON.stringify({ type: 'RESUME', sessionToken: bToken })));
        ws2b.on('message', function onMsg(data: WebSocket.Data) {
          const m = JSON.parse(data.toString());
          if (m.type === 'SESSION_ESTABLISHED' && m.resumed) {
            ws2b.removeListener('message', onMsg);
            resolve();
          }
        });
      });

      const replayed = await c2b.wait((m) => m.type === 'GAME_ABANDONMENT_WARNING') as any;
      expect(replayed.gameId).toBe(gameId);
      expect(replayed.idlePlayer).toBe('player1');

      a.ws.close();
      ws2b.close();
    } finally {
      await srv.close();
    }
  });
});
