import { useState, useEffect, useRef, useCallback } from 'react';
import type { ClientMessage, ServerMessage, GameState, Player, GameListEntry, HandProofData, MoveProofData } from '../types';

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
  opponentHandProof: HandProofData | null;
  lastMoveProof: { moveProof: MoveProofData; handIndex: number; row: number; col: number } | null;
  createGame: (cardIds: number[]) => void;
  joinGame: (gameId: string, cardIds: number[]) => void;
  placeCard: (handIndex: number, row: number, col: number) => void;
  submitHandProof: (gameId: string, handProof: HandProofData) => void;
  submitMoveProof: (gameId: string, handIndex: number, row: number, col: number, moveProof: MoveProofData) => void;
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
  const [opponentHandProof, setOpponentHandProof] = useState<HandProofData | null>(null);
  const [lastMoveProof, setLastMoveProof] = useState<{ moveProof: MoveProofData; handIndex: number; row: number; col: number } | null>(null);

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
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data) as ServerMessage;
      } catch {
        console.warn('[useWebSocket] Received malformed JSON, ignoring:', event.data);
        return;
      }
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
        case 'HAND_PROOF':
          setOpponentHandProof(msg.handProof);
          break;
        case 'MOVE_PROVEN':
          setGameState(msg.gameState);
          setLastCaptures(msg.captures);
          setLastMoveProof({
            moveProof: msg.moveProof,
            handIndex: msg.handIndex,
            row: msg.row,
            col: msg.col,
          });
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

  const moveNumberRef = useRef(0);

  const placeCard = useCallback((handIndex: number, row: number, col: number) => {
    if (!gameId) return;
    setError(null);
    const moveNumber = moveNumberRef.current;
    send({ type: 'PLACE_CARD', gameId, handIndex, row, col, moveNumber });
    moveNumberRef.current++;
  }, [send, gameId]);

  const refreshGameList = useCallback(() => {
    send({ type: 'LIST_GAMES' });
  }, [send]);

  const submitHandProof = useCallback((gId: string, handProof: HandProofData) => {
    setError(null);
    send({ type: 'SUBMIT_HAND_PROOF', gameId: gId, handProof });
  }, [send]);

  const submitMoveProof = useCallback((gId: string, handIndex: number, row: number, col: number, moveProof: MoveProofData) => {
    if (!gId) return;
    setError(null);
    const moveNumber = moveNumberRef.current;
    send({ type: 'SUBMIT_MOVE_PROOF', gameId: gId, handIndex, row, col, moveNumber, moveProof });
    moveNumberRef.current++;
  }, [send]);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    setGameId(null);
    setPlayerNumber(null);
    setGameState(null);
    setGameOver(null);
    setOpponentDisconnected(false);
    setOpponentHandProof(null);
    moveNumberRef.current = 0;
    setLastMoveProof(null);
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
    opponentHandProof,
    lastMoveProof,
    createGame,
    joinGame,
    placeCard,
    submitHandProof,
    submitMoveProof,
    refreshGameList,
    disconnect,
  };
}
