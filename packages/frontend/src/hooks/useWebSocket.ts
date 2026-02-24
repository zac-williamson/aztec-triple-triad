import { useState, useEffect, useRef, useCallback } from 'react';
import type { ClientMessage, ServerMessage, GameState, Player, GameListEntry } from '../types';

const DEFAULT_WS_URL = 'ws://localhost:3001';

export interface UseWebSocketReturn {
  connected: boolean;
  gameId: string | null;
  playerNumber: 1 | 2 | null;
  gameState: GameState | null;
  lastCaptures: { row: number; col: number }[];
  gameList: GameListEntry[];
  error: string | null;
  gameOver: { winner: Player | 'draw' } | null;
  opponentDisconnected: boolean;
  createGame: (cardIds: number[]) => void;
  joinGame: (gameId: string, cardIds: number[]) => void;
  placeCard: (handIndex: number, row: number, col: number) => void;
  refreshGameList: () => void;
  disconnect: () => void;
}

export function useWebSocket(wsUrl?: string): UseWebSocketReturn {
  const url = wsUrl ?? DEFAULT_WS_URL;
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [gameId, setGameId] = useState<string | null>(null);
  const [playerNumber, setPlayerNumber] = useState<1 | 2 | null>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [lastCaptures, setLastCaptures] = useState<{ row: number; col: number }[]>([]);
  const [gameList, setGameList] = useState<GameListEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [gameOver, setGameOver] = useState<{ winner: Player | 'draw' } | null>(null);
  const [opponentDisconnected, setOpponentDisconnected] = useState(false);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  useEffect(() => {
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setError(null);
    };

    ws.onclose = () => {
      setConnected(false);
    };

    ws.onerror = () => {
      setError('Connection failed');
      setConnected(false);
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as ServerMessage;
      switch (msg.type) {
        case 'GAME_CREATED':
          setGameId(msg.gameId);
          setPlayerNumber(msg.playerNumber);
          setError(null);
          break;
        case 'GAME_JOINED':
          setGameId(msg.gameId);
          setPlayerNumber(msg.playerNumber);
          setGameState(msg.gameState);
          setError(null);
          break;
        case 'GAME_START':
          setGameState(msg.gameState);
          break;
        case 'GAME_STATE':
          setGameState(msg.gameState);
          setLastCaptures(msg.captures);
          break;
        case 'GAME_OVER':
          setGameState(msg.gameState);
          setGameOver({ winner: msg.winner });
          break;
        case 'GAME_LIST':
          setGameList(msg.games);
          break;
        case 'OPPONENT_DISCONNECTED':
          setOpponentDisconnected(true);
          break;
        case 'ERROR':
          setError(msg.message);
          break;
      }
    };

    return () => {
      ws.close();
    };
  }, [url]);

  const createGame = useCallback((cardIds: number[]) => {
    setError(null);
    setGameOver(null);
    setOpponentDisconnected(false);
    send({ type: 'CREATE_GAME', cardIds });
  }, [send]);

  const joinGame = useCallback((id: string, cardIds: number[]) => {
    setError(null);
    setGameOver(null);
    setOpponentDisconnected(false);
    send({ type: 'JOIN_GAME', gameId: id, cardIds });
  }, [send]);

  const placeCard = useCallback((handIndex: number, row: number, col: number) => {
    if (!gameId) return;
    setError(null);
    send({ type: 'PLACE_CARD', gameId, handIndex, row, col });
  }, [send, gameId]);

  const refreshGameList = useCallback(() => {
    send({ type: 'LIST_GAMES' });
  }, [send]);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    setGameId(null);
    setPlayerNumber(null);
    setGameState(null);
    setGameOver(null);
    setOpponentDisconnected(false);
  }, []);

  return {
    connected,
    gameId,
    playerNumber,
    gameState,
    lastCaptures,
    gameList,
    error,
    gameOver,
    opponentDisconnected,
    createGame,
    joinGame,
    placeCard,
    refreshGameList,
    disconnect,
  };
}
