import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import { GameManager } from './GameManager.js';
import type { ClientMessage, ServerMessage } from './types.js';

const DEFAULT_PORT = 3001;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface ServerOptions {
  port?: number;
  host?: string;
}

export interface TripleTriadServer {
  httpServer: http.Server;
  wss: WebSocketServer;
  gameManager: GameManager;
  close: () => Promise<void>;
}

export function createServer(options: ServerOptions = {}): TripleTriadServer {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? '0.0.0.0';
  const gameManager = new GameManager();
  const clients = new Map<string, WebSocket>();

  const httpServer = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', games: gameManager.gameCount }));
      return;
    }

    if (req.method === 'GET' && req.url === '/games') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(gameManager.listGames()));
      return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/games/')) {
      const gameId = req.url.slice('/games/'.length);
      const room = gameManager.getGame(gameId);
      if (room) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: room.id,
          status: room.state?.status ?? 'waiting',
          player1Connected: clients.has(room.player1Id),
          player2Connected: room.player2Id ? clients.has(room.player2Id) : false,
          currentTurn: room.state?.currentTurn,
          winner: room.state?.winner,
        }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Game not found' }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  const wss = new WebSocketServer({ server: httpServer });

  function send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function sendToPlayer(playerId: string, msg: ServerMessage): void {
    const ws = clients.get(playerId);
    if (ws) send(ws, msg);
  }

  function getOpponentId(gameId: string, playerId: string): string | null {
    const room = gameManager.getGame(gameId);
    if (!room) return null;
    if (room.player1Id === playerId) return room.player2Id;
    if (room.player2Id === playerId) return room.player1Id;
    return null;
  }

  wss.on('connection', (ws: WebSocket) => {
    const playerId = uuidv4();
    clients.set(playerId, ws);

    ws.on('message', (data: Buffer | string) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        send(ws, { type: 'ERROR', message: 'Invalid message format' });
        return;
      }

      handleMessage(playerId, ws, msg);
    });

    ws.on('close', () => {
      handleDisconnect(playerId);
      clients.delete(playerId);
    });

    ws.on('error', () => {
      handleDisconnect(playerId);
      clients.delete(playerId);
    });
  });

  function handleMessage(playerId: string, ws: WebSocket, msg: ClientMessage): void {
    switch (msg.type) {
      case 'CREATE_GAME': {
        try {
          const room = gameManager.createGame(playerId, msg.cardIds);
          send(ws, { type: 'GAME_CREATED', gameId: room.id, playerNumber: 1 });
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message });
        }
        break;
      }

      case 'JOIN_GAME': {
        try {
          const room = gameManager.joinGame(msg.gameId, playerId, msg.cardIds);
          send(ws, {
            type: 'GAME_JOINED',
            gameId: room.id,
            playerNumber: 2,
            gameState: room.state,
          });
          // Notify player 1 that the game has started
          sendToPlayer(room.player1Id, {
            type: 'GAME_START',
            gameId: room.id,
            gameState: room.state,
          });
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message });
        }
        break;
      }

      case 'PLACE_CARD': {
        try {
          const result = gameManager.placeCard(msg.gameId, playerId, msg.handIndex, msg.row, msg.col);
          const room = gameManager.getGame(msg.gameId)!;

          // Send updated state to both players
          const stateMsg: ServerMessage = {
            type: 'GAME_STATE',
            gameId: msg.gameId,
            gameState: result.newState,
            captures: result.captures,
          };
          send(ws, stateMsg);
          const opponentId = getOpponentId(msg.gameId, playerId);
          if (opponentId) sendToPlayer(opponentId, stateMsg);

          // Check if game is over
          if (result.newState.status === 'finished') {
            const overMsg: ServerMessage = {
              type: 'GAME_OVER',
              gameId: msg.gameId,
              gameState: result.newState,
              winner: result.newState.winner!,
            };
            send(ws, overMsg);
            if (opponentId) sendToPlayer(opponentId, overMsg);
          }
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message });
        }
        break;
      }

      case 'LIST_GAMES': {
        send(ws, { type: 'GAME_LIST', games: gameManager.listGames() });
        break;
      }

      case 'GET_GAME': {
        const room = gameManager.getGame(msg.gameId);
        if (room) {
          send(ws, {
            type: 'GAME_INFO',
            game: {
              id: room.id,
              status: room.state?.status ?? 'waiting',
              player1Connected: clients.has(room.player1Id),
              player2Connected: room.player2Id ? clients.has(room.player2Id) : false,
              currentTurn: room.state?.currentTurn,
              winner: room.state?.winner,
            },
          });
        } else {
          send(ws, { type: 'GAME_INFO', game: null });
        }
        break;
      }

      case 'SUBMIT_HAND_PROOF': {
        try {
          const room = gameManager.getGame(msg.gameId);
          if (!room) {
            send(ws, { type: 'ERROR', message: 'Game not found' });
            break;
          }
          const playerRole = gameManager.getPlayerRole(msg.gameId, playerId);
          if (!playerRole) {
            send(ws, { type: 'ERROR', message: 'Not in this game' });
            break;
          }
          const fromPlayer = playerRole === 'player1' ? 1 : 2;
          const opponentId = getOpponentId(msg.gameId, playerId);
          if (opponentId) {
            sendToPlayer(opponentId, {
              type: 'HAND_PROOF',
              gameId: msg.gameId,
              handProof: msg.handProof,
              fromPlayer: fromPlayer as 1 | 2,
            });
          }
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message });
        }
        break;
      }

      case 'SUBMIT_MOVE_PROOF': {
        try {
          // First apply the move on the server (same as PLACE_CARD)
          const result = gameManager.placeCard(msg.gameId, playerId, msg.handIndex, msg.row, msg.col);
          const room = gameManager.getGame(msg.gameId)!;

          // Send state update to the current player
          const stateMsg: ServerMessage = {
            type: 'GAME_STATE',
            gameId: msg.gameId,
            gameState: result.newState,
            captures: result.captures,
          };
          send(ws, stateMsg);

          // Send move proof + state to the opponent
          const opponentId = getOpponentId(msg.gameId, playerId);
          if (opponentId) {
            sendToPlayer(opponentId, {
              type: 'MOVE_PROVEN',
              gameId: msg.gameId,
              gameState: result.newState,
              captures: result.captures,
              moveProof: msg.moveProof,
              handIndex: msg.handIndex,
              row: msg.row,
              col: msg.col,
            });
          }

          // Check if game is over
          if (result.newState.status === 'finished') {
            const overMsg: ServerMessage = {
              type: 'GAME_OVER',
              gameId: msg.gameId,
              gameState: result.newState,
              winner: result.newState.winner!,
            };
            send(ws, overMsg);
            if (opponentId) sendToPlayer(opponentId, overMsg);
          }
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message });
        }
        break;
      }
    }
  }

  function handleDisconnect(playerId: string): void {
    const result = gameManager.removePlayer(playerId);
    if (result) {
      const { gameId, room } = result;
      const opponentId = room.player1Id === playerId ? room.player2Id : room.player1Id;
      if (opponentId) {
        sendToPlayer(opponentId, { type: 'OPPONENT_DISCONNECTED', gameId });
      }
    }
  }

  // Periodic cleanup of stale games
  const cleanupInterval = setInterval(() => {
    gameManager.cleanupStaleGames();
  }, CLEANUP_INTERVAL_MS);

  function close(): Promise<void> {
    return new Promise((resolve, reject) => {
      clearInterval(cleanupInterval);
      // Close all WebSocket connections
      for (const ws of clients.values()) {
        ws.close();
      }
      clients.clear();
      wss.close(() => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  return { httpServer, wss, gameManager, close };
}

// Start the server if run directly
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  const port = parseInt(process.env.WS_PORT ?? String(DEFAULT_PORT), 10);
  const server = createServer({ port });
  server.httpServer.listen(port, () => {
    console.log(`Triple Triad server running on port ${port}`);
  });
}
