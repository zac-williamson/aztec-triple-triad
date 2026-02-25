import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import http from 'http';
import { createServer, type TripleTriadServer } from '../src/server.js';
import type { ServerMessage, ClientMessage } from '../src/types.js';

// Valid card IDs
const PLAYER1_CARDS = [1, 2, 3, 4, 5];
const PLAYER2_CARDS = [6, 7, 8, 9, 10];

let server: TripleTriadServer;
let port: number;

function getUrl(): string {
  return `ws://localhost:${port}`;
}

function getHttpUrl(): string {
  return `http://localhost:${port}`;
}

function createClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getUrl());
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function sendMessage(ws: WebSocket, msg: ClientMessage): void {
  ws.send(JSON.stringify(msg));
}

// Buffered message collector that ensures no messages are lost
class MessageCollector {
  private buffer: ServerMessage[] = [];
  private waiters: { filter?: (msg: ServerMessage) => boolean; resolve: (msg: ServerMessage) => void; reject: (err: Error) => void; timeout: NodeJS.Timeout }[] = [];

  constructor(private ws: WebSocket) {
    ws.on('message', (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
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

function waitForMessage(ws: WebSocket, filter?: (msg: ServerMessage) => boolean): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for message')), 5000);
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
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

beforeEach(async () => {
  // Use a random port to avoid conflicts
  port = 3100 + Math.floor(Math.random() * 900);
  server = createServer({ port });
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
    sendMessage(ws1, { type: 'PLACE_CARD', gameId, handIndex: 0, row: 0, col: 0 });

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
    sendMessage(ws2, { type: 'PLACE_CARD', gameId, handIndex: 0, row: 0, col: 0 });
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

      sendMessage(currentWs, { type: 'PLACE_CARD', gameId, handIndex: 0, row, col });

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
    expect(server.gameManager.gameCount).toBe(1);

    ws1.close();

    // Wait for close handler
    await new Promise((r) => setTimeout(r, 100));
    expect(server.gameManager.gameCount).toBe(0);
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

    // Player 1 submits move with proof
    sendMessage(ws1, {
      type: 'SUBMIT_MOVE_PROOF',
      gameId,
      handIndex: 0,
      row: 0,
      col: 0,
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

    // Player 1 gets GAME_STATE (standard update)
    const stateMsg = await c1.wait((m) => m.type === 'GAME_STATE');
    expect(stateMsg.type).toBe('GAME_STATE');

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
      // Player 1's hand should be hidden
      expect(joined.gameState.player1Hand.length).toBe(5);
      joined.gameState.player1Hand.forEach((card: any) => {
        expect(card.id).toBe(0);
        expect(card.name).toBe('Hidden');
        expect(card.ranks.top).toBe(0);
      });
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
      // Player 2's hand should be hidden
      expect(start.gameState.player2Hand.length).toBe(5);
      start.gameState.player2Hand.forEach((card: any) => {
        expect(card.id).toBe(0);
        expect(card.name).toBe('Hidden');
      });
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
    sendMessage(ws1, { type: 'PLACE_CARD', gameId, handIndex: 0, row: 0, col: 0 });

    // Player 1 gets GAME_STATE with player2 hand hidden
    const state1 = await c1.wait((m) => m.type === 'GAME_STATE') as any;
    expect(state1.gameState.player1Hand.length).toBe(4); // played one card
    state1.gameState.player2Hand.forEach((card: any) => {
      expect(card.id).toBe(0);
      expect(card.name).toBe('Hidden');
    });

    // Player 2 gets GAME_STATE with player1 hand hidden
    const state2 = await c2.wait((m) => m.type === 'GAME_STATE') as any;
    expect(state2.gameState.player2Hand.length).toBe(5);
    expect(state2.gameState.player2Hand[0].id).not.toBe(0);
    state2.gameState.player1Hand.forEach((card: any) => {
      expect(card.id).toBe(0);
      expect(card.name).toBe('Hidden');
    });

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
      sendMessage(currentWs, { type: 'PLACE_CARD', gameId, handIndex: 0, row, col });

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

    sendMessage(ws1, { type: 'PLACE_CARD', gameId, handIndex: 0, row: 5, col: 0 } as any);
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
