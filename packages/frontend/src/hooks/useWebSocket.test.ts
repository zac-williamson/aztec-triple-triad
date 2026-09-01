import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';

const SESSION_TOKEN_KEY = 'aztec_tt_ws_session_token';

// --- Mock WebSocket with full session protocol support ---
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sentMessages: string[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    // Auto-connect on next tick
    setTimeout(() => this.onopen?.(), 0);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  simulateMessage(data: any) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }

  simulateSessionEstablished(opts: Partial<{ sessionToken: string; playerId: string; resumed: boolean; gameId: string | null }> = {}) {
    this.simulateMessage({
      type: 'SESSION_ESTABLISHED',
      sessionToken: opts.sessionToken ?? 'tok_abc',
      playerId: opts.playerId ?? 'player-1',
      resumed: opts.resumed ?? false,
      gameId: opts.gameId ?? null,
    });
  }
}

/** Wait for hook to connect (50ms StrictMode delay + next tick for onopen). */
async function waitForConnect() {
  await new Promise(r => setTimeout(r, 100));
}

/** Get the latest MockWebSocket instance. */
function latestWs(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

describe('useWebSocket', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    MockWebSocket.instances = [];
    localStorage.clear();
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
  });

  // --- Session flow ---

  describe('session management', () => {
    it('sends RESUME if session token exists in localStorage', async () => {
      localStorage.setItem(SESSION_TOKEN_KEY, 'old_token');
      const { result } = renderHook(() => useWebSocket('ws://test'));

      await act(async () => { await waitForConnect(); });
      const ws = latestWs();
      const resumeMsg = ws.sentMessages.find(m => JSON.parse(m).type === 'RESUME');
      expect(resumeMsg).toBeDefined();
      expect(JSON.parse(resumeMsg!).sessionToken).toBe('old_token');
    });

    it('does not send RESUME when no token exists', async () => {
      const { result } = renderHook(() => useWebSocket('ws://test'));

      await act(async () => { await waitForConnect(); });
      const ws = latestWs();
      expect(ws.sentMessages.length).toBe(0);
    });

    it('stores session token from SESSION_ESTABLISHED', async () => {
      const { result } = renderHook(() => useWebSocket('ws://test'));

      await act(async () => { await waitForConnect(); });
      const ws = latestWs();

      act(() => {
        ws.simulateSessionEstablished({ sessionToken: 'new_tok_123' });
      });

      expect(localStorage.getItem(SESSION_TOKEN_KEY)).toBe('new_tok_123');
      expect(result.current.connected).toBe(true);
    });

    it('restores gameId on resumed session', async () => {
      const { result } = renderHook(() => useWebSocket('ws://test'));

      await act(async () => { await waitForConnect(); });
      const ws = latestWs();

      act(() => {
        ws.simulateSessionEstablished({ resumed: true, gameId: 'game-xyz' });
      });

      expect(result.current.gameId).toBe('game-xyz');
    });

    it('new session (not resumed) does not set gameId', async () => {
      const { result } = renderHook(() => useWebSocket('ws://test'));

      await act(async () => { await waitForConnect(); });
      const ws = latestWs();

      act(() => {
        ws.simulateSessionEstablished({ resumed: false, gameId: null });
      });

      expect(result.current.gameId).toBeNull();
    });
  });

  // --- Reconnect ---

  describe('auto-reconnect', () => {
    it('reconnects with exponential backoff on unexpected close', async () => {
      const { result } = renderHook(() => useWebSocket('ws://test'));

      await act(async () => { await waitForConnect(); });
      const ws1 = latestWs();
      act(() => { ws1.simulateSessionEstablished(); });
      expect(result.current.connected).toBe(true);

      // Simulate unexpected close
      act(() => { ws1.close(); });
      expect(result.current.connected).toBe(false);
      const instancesBeforeReconnect = MockWebSocket.instances.length;

      // Advance 1s — first reconnect
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(MockWebSocket.instances.length).toBe(instancesBeforeReconnect + 1);

      // Close again
      const ws2 = latestWs();
      act(() => { ws2.close(); });

      // Next reconnect at 2s
      await act(async () => { vi.advanceTimersByTime(1500); });
      expect(MockWebSocket.instances.length).toBe(instancesBeforeReconnect + 1); // not yet
      await act(async () => { vi.advanceTimersByTime(600); });
      expect(MockWebSocket.instances.length).toBe(instancesBeforeReconnect + 2);
    });

    it('does not reconnect after intentional disconnect', async () => {
      const { result } = renderHook(() => useWebSocket('ws://test'));

      await act(async () => { await waitForConnect(); });
      const ws = latestWs();
      act(() => { ws.simulateSessionEstablished(); });

      const instancesBefore = MockWebSocket.instances.length;

      // Intentional disconnect
      act(() => { result.current.disconnect(); });

      // Advance time — no reconnect
      await act(async () => { vi.advanceTimersByTime(5000); });
      expect(MockWebSocket.instances.length).toBe(instancesBefore);
    });

    it('disconnect clears session token', async () => {
      const { result } = renderHook(() => useWebSocket('ws://test'));

      await act(async () => { await waitForConnect(); });
      const ws = latestWs();
      act(() => { ws.simulateSessionEstablished({ sessionToken: 'my_token' }); });
      expect(localStorage.getItem(SESSION_TOKEN_KEY)).toBe('my_token');

      act(() => { result.current.disconnect(); });
      expect(localStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    });

    it('resets backoff after successful session', async () => {
      const { result } = renderHook(() => useWebSocket('ws://test'));

      await act(async () => { await waitForConnect(); });
      const ws1 = latestWs();

      // Close and reconnect twice to increase backoff
      act(() => { ws1.close(); });
      await act(async () => { vi.advanceTimersByTime(1000); }); // 1st reconnect at 1s
      act(() => { latestWs().close(); });
      await act(async () => { vi.advanceTimersByTime(2000); }); // 2nd reconnect at 2s

      // Establish session — resets backoff
      const ws3 = latestWs();
      act(() => { ws3.simulateSessionEstablished(); });

      // Close and check next reconnect is at 1s (not 4s)
      act(() => { ws3.close(); });
      const beforeReconnect = MockWebSocket.instances.length;
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(MockWebSocket.instances.length).toBe(beforeReconnect + 1);
    });
  });

  describe('leaving a game', () => {
    it('tells the relay, so the player is not left bound to it', async () => {
      // The relay releases both players at GAME OVER. A game left before that
      // keeps its binding until the stale-game sweep, and until then every
      // queue attempt is refused with "You are already in an active game" —
      // the bot spent 22 minutes and 578 attempts in exactly that state.
      const { result } = renderHook(() => useWebSocket('ws://test'));
      await act(async () => { await waitForConnect(); });
      const ws = latestWs();
      act(() => { ws.simulateSessionEstablished(); });
      // GAME_CREATED is what sets gameId; GAME_START only carries the board.
      act(() => { ws.simulateMessage({ type: 'GAME_CREATED', gameId: 'g1', playerNumber: 1 }); });
      expect(result.current.gameId).toBe('g1');

      act(() => { result.current.leaveGame(); });
      const sent = ws.sentMessages.map((m: string) => JSON.parse(m));
      expect(sent.some((m: any) => m.type === 'LEAVE_GAME' && m.gameId === 'g1')).toBe(true);
      expect(result.current.gameId).toBeNull();
    });

    it('sends nothing when there is no game to leave', async () => {
      const { result } = renderHook(() => useWebSocket('ws://test'));
      await act(async () => { await waitForConnect(); });
      const ws = latestWs();
      act(() => { ws.simulateSessionEstablished(); });

      act(() => { result.current.leaveGame(); });
      const sent = ws.sentMessages.map((m: string) => JSON.parse(m));
      expect(sent.some((m: any) => m.type === 'LEAVE_GAME')).toBe(false);
    });
  });

  // --- OPPONENT_RECONNECTED ---

  describe('opponent reconnection', () => {
    it('clears opponentDisconnected on OPPONENT_RECONNECTED', async () => {
      const { result } = renderHook(() => useWebSocket('ws://test'));

      await act(async () => { await waitForConnect(); });
      const ws = latestWs();
      act(() => { ws.simulateSessionEstablished(); });

      // Opponent disconnects
      act(() => { ws.simulateMessage({ type: 'OPPONENT_DISCONNECTED' }); });
      expect(result.current.opponentDisconnected).toBe(true);

      // Opponent reconnects
      act(() => { ws.simulateMessage({ type: 'OPPONENT_RECONNECTED', gameId: 'g1' }); });
      expect(result.current.opponentDisconnected).toBe(false);
    });
  });

  // --- All message types ---

  describe('message handling', () => {
    async function setupConnectedHook() {
      const hook = renderHook(() => useWebSocket('ws://test'));
      await act(async () => { await waitForConnect(); });
      const ws = latestWs();
      act(() => { ws.simulateSessionEstablished(); });
      return { result: hook.result, ws };
    }

    it('GAME_CREATED sets gameId and playerNumber', async () => {
      const { result, ws } = await setupConnectedHook();
      act(() => { ws.simulateMessage({ type: 'GAME_CREATED', gameId: 'g1', playerNumber: 1 }); });
      expect(result.current.gameId).toBe('g1');
      expect(result.current.playerNumber).toBe(1);
    });

    it('GAME_JOINED sets gameId, playerNumber, and gameState', async () => {
      const { result, ws } = await setupConnectedHook();
      const state = { board: [], player1Hand: [], player2Hand: [], currentTurn: 'player1', player1Score: 5, player2Score: 5, status: 'playing', winner: null };
      act(() => { ws.simulateMessage({ type: 'GAME_JOINED', gameId: 'g1', playerNumber: 2, gameState: state }); });
      expect(result.current.gameId).toBe('g1');
      expect(result.current.playerNumber).toBe(2);
      expect(result.current.gameState).toEqual(state);
    });

    it('GAME_START sets gameState', async () => {
      const { result, ws } = await setupConnectedHook();
      const state = { board: [], player1Hand: [], player2Hand: [], currentTurn: 'player1', player1Score: 5, player2Score: 5, status: 'playing', winner: null };
      act(() => { ws.simulateMessage({ type: 'GAME_START', gameState: state }); });
      expect(result.current.gameState).toEqual(state);
    });

    it('GAME_STATE sets gameState and captures', async () => {
      const { result, ws } = await setupConnectedHook();
      const state = { board: [], player1Hand: [], player2Hand: [], currentTurn: 'player2', player1Score: 6, player2Score: 4, status: 'playing', winner: null };
      const captures = [{ row: 0, col: 1 }];
      act(() => { ws.simulateMessage({ type: 'GAME_STATE', gameState: state, captures }); });
      expect(result.current.gameState).toEqual(state);
      expect(result.current.lastCaptures).toEqual(captures);
    });

    it('GAME_OVER sets gameOver, gameState, and opponentCardIds', async () => {
      const { result, ws } = await setupConnectedHook();
      // Set player number first
      act(() => { ws.simulateMessage({ type: 'GAME_CREATED', gameId: 'g1', playerNumber: 1 }); });
      const state = { board: [], player1Hand: [], player2Hand: [], currentTurn: 'player1', player1Score: 6, player2Score: 4, status: 'finished', winner: 'player1' };
      act(() => {
        ws.simulateMessage({
          type: 'GAME_OVER', gameState: state, winner: 'player1',
          player1CardIds: [1, 2, 3, 4, 5], player2CardIds: [6, 7, 8, 9, 10],
        });
      });
      expect(result.current.gameOver).toEqual({ winner: 'player1' });
      expect(result.current.opponentCardIds).toEqual([6, 7, 8, 9, 10]);
    });

    it('HAND_PROOF sets opponentHandProof', async () => {
      const { result, ws } = await setupConnectedHook();
      const handProof = { proof: 'abc', cardCommit: '0x1' };
      act(() => { ws.simulateMessage({ type: 'HAND_PROOF', handProof }); });
      expect(result.current.opponentHandProof).toEqual(handProof);
    });

    it('MOVE_PROVEN sets gameState, captures, and lastMoveProof', async () => {
      const { result, ws } = await setupConnectedHook();
      const state = { board: [], player1Hand: [], player2Hand: [], currentTurn: 'player2', player1Score: 6, player2Score: 4, status: 'playing', winner: null };
      const moveProof = { proof: 'xyz' };
      act(() => {
        ws.simulateMessage({
          type: 'MOVE_PROVEN', gameState: state, captures: [{ row: 1, col: 1 }],
          moveProof, handIndex: 0, row: 0, col: 0,
        });
      });
      expect(result.current.gameState).toEqual(state);
      expect(result.current.lastMoveProof).toEqual({ moveProof, handIndex: 0, row: 0, col: 0 });
    });

    it('OPPONENT_AZTEC_INFO sets address, onChainGameId, and randomness', async () => {
      const { result, ws } = await setupConnectedHook();
      act(() => {
        ws.simulateMessage({
          type: 'OPPONENT_AZTEC_INFO',
          aztecAddress: '0xABC', onChainGameId: '0xGAME',
          gameRandomness: ['0x1', '0x2', '0x3', '0x4', '0x5', '0x6'],
        });
      });
      expect(result.current.opponentAztecAddress).toBe('0xABC');
      expect(result.current.opponentOnChainGameId).toBe('0xGAME');
      expect(result.current.opponentGameRandomness).toEqual(['0x1', '0x2', '0x3', '0x4', '0x5', '0x6']);
    });

    it('NOTE_DATA sets incomingNoteData', async () => {
      const { result, ws } = await setupConnectedHook();
      const notes = [{ noteHash: '0x1', tokenId: 1, randomness: '0xr' }];
      act(() => { ws.simulateMessage({ type: 'NOTE_DATA', txHash: '0xTX', notes }); });
      expect(result.current.incomingNoteData).toEqual({ txHash: '0xTX', notes });
    });

    it('OPPONENT_SETTLING sets opponentSettling', async () => {
      const { result, ws } = await setupConnectedHook();
      act(() => { ws.simulateMessage({ type: 'OPPONENT_SETTLING', selectedCardId: 42 }); });
      expect(result.current.opponentSettling).toEqual({ selectedCardId: 42 });
    });

    it('ON_CHAIN_STATUS sets opponentTxConfirmed for P2 when P1 confirmed', async () => {
      const { result, ws } = await setupConnectedHook();
      // Set as player 2
      act(() => { ws.simulateMessage({ type: 'GAME_JOINED', gameId: 'g1', playerNumber: 2, gameState: null }); });
      act(() => {
        ws.simulateMessage({
          type: 'ON_CHAIN_STATUS',
          status: { player1Tx: 'confirmed', player2Tx: 'pending' },
        });
      });
      expect(result.current.opponentTxConfirmed).toBe(true);
    });

    it('MATCHMAKING_QUEUED sets status and position', async () => {
      const { result, ws } = await setupConnectedHook();
      act(() => { ws.simulateMessage({ type: 'MATCHMAKING_QUEUED', position: 3 }); });
      expect(result.current.matchmakingStatus).toBe('queued');
      expect(result.current.queuePosition).toBe(3);
    });

    it('MATCH_FOUND sets game state', async () => {
      const { result, ws } = await setupConnectedHook();
      const state = { board: [], player1Hand: [], player2Hand: [], currentTurn: 'player1', player1Score: 5, player2Score: 5, status: 'playing', winner: null };
      act(() => {
        ws.simulateMessage({ type: 'MATCH_FOUND', gameId: 'match-1', playerNumber: 1, gameState: state });
      });
      expect(result.current.matchmakingStatus).toBe('matched');
      expect(result.current.gameId).toBe('match-1');
      expect(result.current.playerNumber).toBe(1);
    });

    it('never exposes who the opponent is, even if a server sends the old flag', async () => {
      // The bot is a fallback for when nobody else is queuing, and a player
      // should not be able to tell they got one. An older relay may still put
      // opponentIsBot on the wire; the client must not surface it anywhere.
      const { result, ws } = await setupConnectedHook();
      const state = { board: [], player1Hand: [], player2Hand: [], currentTurn: 'player1', player1Score: 5, player2Score: 5, status: 'playing', winner: null };
      act(() => {
        ws.simulateMessage({ type: 'MATCH_FOUND', gameId: 'm', playerNumber: 1, gameState: state, opponentIsBot: true });
      });
      expect(result.current.matchmakingStatus).toBe('matched');
      expect('opponentIsBot' in result.current).toBe(false);
    });

    it('MATCHMAKING_CANCELLED resets matchmaking state', async () => {
      const { result, ws } = await setupConnectedHook();
      act(() => { ws.simulateMessage({ type: 'MATCHMAKING_QUEUED', position: 1 }); });
      act(() => { ws.simulateMessage({ type: 'MATCHMAKING_CANCELLED' }); });
      expect(result.current.matchmakingStatus).toBe('idle');
      expect(result.current.queuePosition).toBeNull();
    });

    it('PONG is handled without error', async () => {
      const { ws } = await setupConnectedHook();
      act(() => { ws.simulateMessage({ type: 'PONG' }); });
      // No crash = success
    });

    it('ERROR sets error message', async () => {
      const { result, ws } = await setupConnectedHook();
      act(() => { ws.simulateMessage({ type: 'ERROR', message: 'Something broke' }); });
      expect(result.current.error).toBe('Something broke');
    });
  });

  // --- addMessageListener ---

  describe('addMessageListener', () => {
    it('fires synchronously in the same tick as onmessage', async () => {
      const { result } = renderHook(() => useWebSocket('ws://test'));
      await act(async () => { await waitForConnect(); });
      const ws = latestWs();
      act(() => { ws.simulateSessionEstablished(); });

      const received: any[] = [];
      act(() => {
        result.current.addMessageListener((msg) => received.push(msg));
      });

      act(() => {
        ws.simulateMessage({ type: 'PONG' });
      });
      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('PONG');
    });

    it('returns cleanup function that removes listener', async () => {
      const { result } = renderHook(() => useWebSocket('ws://test'));
      await act(async () => { await waitForConnect(); });
      const ws = latestWs();
      act(() => { ws.simulateSessionEstablished(); });

      const received: any[] = [];
      let cleanup: () => void;
      act(() => {
        cleanup = result.current.addMessageListener((msg) => received.push(msg));
      });

      act(() => { ws.simulateMessage({ type: 'PONG' }); });
      expect(received).toHaveLength(1);

      act(() => { cleanup(); });
      act(() => { ws.simulateMessage({ type: 'PONG' }); });
      expect(received).toHaveLength(1); // No new messages
    });
  });

  // --- placeCard ---

  describe('placeCard', () => {
    it('derives moveNumber from occupied board cells', async () => {
      const { result } = renderHook(() => useWebSocket('ws://test'));
      await act(async () => { await waitForConnect(); });
      const ws = latestWs();
      act(() => { ws.simulateSessionEstablished(); });

      // Set up game with 2 cards on board
      const board = [
        [{ card: { id: 1 }, owner: 'player1' }, { card: null, owner: null }, { card: null, owner: null }],
        [{ card: null, owner: null }, { card: { id: 2 }, owner: 'player2' }, { card: null, owner: null }],
        [{ card: null, owner: null }, { card: null, owner: null }, { card: null, owner: null }],
      ];
      act(() => {
        ws.simulateMessage({ type: 'GAME_CREATED', gameId: 'g1', playerNumber: 1 });
      });
      act(() => {
        ws.simulateMessage({ type: 'GAME_STATE', gameState: { board, player1Hand: [], player2Hand: [], currentTurn: 'player1', player1Score: 1, player2Score: 1, status: 'playing', winner: null }, captures: [] });
      });

      act(() => { result.current.placeCard(0, 0, 1); });

      const sent = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(sent.type).toBe('PLACE_CARD');
      expect(sent.moveNumber).toBe(2); // 2 cells occupied
    });
  });

  // --- GAME_ABANDONMENT_WARNING (present-but-idle) ---

  describe('abandonment warning', () => {
    async function setupConnectedHook() {
      const hook = renderHook(() => useWebSocket('ws://test'));
      await act(async () => { await waitForConnect(); });
      const ws = latestWs();
      act(() => { ws.simulateSessionEstablished(); });
      return { result: hook.result, ws };
    }

    it('starts with no abandonmentWarning', async () => {
      const { result } = await setupConnectedHook();
      expect(result.current.abandonmentWarning).toBeNull();
    });

    it('GAME_ABANDONMENT_WARNING sets abandonmentWarning (idlePlayer, secondsIdle, secondsUntilClaimable)', async () => {
      const { result, ws } = await setupConnectedHook();
      act(() => {
        ws.simulateMessage({
          type: 'GAME_ABANDONMENT_WARNING', gameId: 'g1',
          idlePlayer: 'player1', secondsIdle: 60, secondsUntilClaimable: 5,
        });
      });
      expect(result.current.abandonmentWarning).toEqual({
        idlePlayer: 'player1', secondsIdle: 60, secondsUntilClaimable: 5,
      });
    });

    it('updates the warning on a re-sent message (countdown progresses)', async () => {
      const { result, ws } = await setupConnectedHook();
      act(() => {
        ws.simulateMessage({
          type: 'GAME_ABANDONMENT_WARNING', gameId: 'g1',
          idlePlayer: 'player2', secondsIdle: 60, secondsUntilClaimable: 5,
        });
      });
      act(() => {
        ws.simulateMessage({
          type: 'GAME_ABANDONMENT_WARNING', gameId: 'g1',
          idlePlayer: 'player2', secondsIdle: 63, secondsUntilClaimable: 2,
        });
      });
      expect(result.current.abandonmentWarning).toEqual({
        idlePlayer: 'player2', secondsIdle: 63, secondsUntilClaimable: 2,
      });
    });

    it('clears the warning when a GAME_STATE (board update / move) arrives', async () => {
      const { result, ws } = await setupConnectedHook();
      act(() => {
        ws.simulateMessage({
          type: 'GAME_ABANDONMENT_WARNING', gameId: 'g1',
          idlePlayer: 'player1', secondsIdle: 60, secondsUntilClaimable: 5,
        });
      });
      expect(result.current.abandonmentWarning).not.toBeNull();

      const state = { board: [], player1Hand: [], player2Hand: [], currentTurn: 'player2', player1Score: 5, player2Score: 5, status: 'playing', winner: null };
      act(() => { ws.simulateMessage({ type: 'GAME_STATE', gameState: state, captures: [] }); });
      expect(result.current.abandonmentWarning).toBeNull();
    });

    it('clears the warning when the opponent proves a move (MOVE_PROVEN)', async () => {
      const { result, ws } = await setupConnectedHook();
      act(() => {
        ws.simulateMessage({
          type: 'GAME_ABANDONMENT_WARNING', gameId: 'g1',
          idlePlayer: 'player1', secondsIdle: 60, secondsUntilClaimable: 5,
        });
      });
      const state = { board: [], player1Hand: [], player2Hand: [], currentTurn: 'player2', player1Score: 5, player2Score: 5, status: 'playing', winner: null };
      act(() => {
        ws.simulateMessage({
          type: 'MOVE_PROVEN', gameState: state, captures: [],
          moveProof: { proof: 'x' }, handIndex: 0, row: 0, col: 0,
        });
      });
      expect(result.current.abandonmentWarning).toBeNull();
    });

    it('clears the warning when the game ends (GAME_OVER)', async () => {
      const { result, ws } = await setupConnectedHook();
      act(() => { ws.simulateMessage({ type: 'GAME_CREATED', gameId: 'g1', playerNumber: 1 }); });
      act(() => {
        ws.simulateMessage({
          type: 'GAME_ABANDONMENT_WARNING', gameId: 'g1',
          idlePlayer: 'player2', secondsIdle: 60, secondsUntilClaimable: 0,
        });
      });
      expect(result.current.abandonmentWarning).not.toBeNull();

      const state = { board: [], player1Hand: [], player2Hand: [], currentTurn: 'player1', player1Score: 6, player2Score: 4, status: 'finished', winner: 'player1' };
      act(() => {
        ws.simulateMessage({
          type: 'GAME_OVER', gameState: state, winner: 'player1',
          player1CardIds: [1, 2, 3, 4, 5], player2CardIds: [6, 7, 8, 9, 10],
        });
      });
      expect(result.current.abandonmentWarning).toBeNull();
    });

    it('leaveGame clears the warning', async () => {
      const { result, ws } = await setupConnectedHook();
      act(() => {
        ws.simulateMessage({
          type: 'GAME_ABANDONMENT_WARNING', gameId: 'g1',
          idlePlayer: 'player1', secondsIdle: 60, secondsUntilClaimable: 5,
        });
      });
      act(() => { result.current.leaveGame(); });
      expect(result.current.abandonmentWarning).toBeNull();
    });

    // The claimant needs the abandoner's hand to claim a card on-chain. Card ids
    // are otherwise exchanged only at GAME_OVER, which an abandonment never
    // reaches, so the relay rides them on the warning and the NON-idle player
    // adopts them — without this the claim falls back to a no-card recovery.
    it('the NON-idle (claimant) player adopts the abandoner\'s hand as opponentCardIds', async () => {
      const { result, ws } = await setupConnectedHook();
      // I am player2; player1 is idle (the abandoner).
      act(() => { ws.simulateMessage({ type: 'GAME_JOINED', gameId: 'g1', playerNumber: 2,
        gameState: { board: [], player1Hand: [], player2Hand: [], currentTurn: 'player1', player1Score: 5, player2Score: 5, status: 'playing', winner: null } }); });
      expect(result.current.opponentCardIds).toEqual([]);
      act(() => {
        ws.simulateMessage({
          type: 'GAME_ABANDONMENT_WARNING', gameId: 'g1',
          idlePlayer: 'player1', secondsIdle: 60, secondsUntilClaimable: 0,
          idlePlayerCardIds: [1, 2, 3, 4, 5],
        });
      });
      expect(result.current.opponentCardIds).toEqual([1, 2, 3, 4, 5]);
    });

    it('the IDLE player does NOT overwrite opponentCardIds with its own hand', async () => {
      const { result, ws } = await setupConnectedHook();
      // I am player1 — the idle/abandoning player. The warning is ABOUT me, so
      // idlePlayerCardIds is my OWN hand; it must not become my opponentCardIds.
      act(() => { ws.simulateMessage({ type: 'GAME_CREATED', gameId: 'g1', playerNumber: 1 }); });
      act(() => {
        ws.simulateMessage({
          type: 'GAME_ABANDONMENT_WARNING', gameId: 'g1',
          idlePlayer: 'player1', secondsIdle: 60, secondsUntilClaimable: 0,
          idlePlayerCardIds: [1, 2, 3, 4, 5],
        });
      });
      expect(result.current.opponentCardIds).toEqual([]);
    });
  });

  describe('notifyAbandonedGameSettled', () => {
    it('sends ABANDONED_GAME_SETTLED with the gameId (QA-F3)', async () => {
      const { result } = renderHook(() => useWebSocket('ws://test'));
      await act(async () => { await waitForConnect(); });
      const ws = latestWs();
      act(() => { ws.simulateSessionEstablished(); });

      act(() => { result.current.notifyAbandonedGameSettled('game-42'); });

      const sent = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(sent).toEqual({ type: 'ABANDONED_GAME_SETTLED', gameId: 'game-42' });
    });
  });

  // --- Malformed JSON ---

  describe('error resilience', () => {
    it('handles malformed JSON without crashing', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result } = renderHook(() => useWebSocket('ws://test'));

      await act(async () => { await waitForConnect(); });
      const ws = latestWs();

      act(() => { ws.simulateMessage('this is not json{{{'); });
      expect(result.current.error).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('malformed JSON'),
        expect.any(String),
      );
      consoleSpy.mockRestore();
    });

    it('handles empty message data without crashing', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result } = renderHook(() => useWebSocket('ws://test'));

      await act(async () => { await waitForConnect(); });
      const ws = latestWs();

      act(() => { ws.simulateMessage(''); });
      expect(result.current.error).toBeNull();
      consoleSpy.mockRestore();
    });

    it('send while disconnected does not crash', async () => {
      const { result } = renderHook(() => useWebSocket('ws://test'));

      await act(async () => { await waitForConnect(); });
      const ws = latestWs();
      act(() => { ws.simulateSessionEstablished(); });
      act(() => { result.current.disconnect(); });

      // These should not throw
      act(() => {
        result.current.createGame([1, 2, 3, 4, 5]);
        result.current.ping();
        result.current.refreshGameList();
      });
    });
  });

  // --- disconnect ---

  describe('disconnect', () => {
    it('resets all game state', async () => {
      const { result } = renderHook(() => useWebSocket('ws://test'));

      await act(async () => { await waitForConnect(); });
      const ws = latestWs();
      act(() => { ws.simulateSessionEstablished(); });

      act(() => {
        ws.simulateMessage({ type: 'GAME_CREATED', gameId: 'g1', playerNumber: 1 });
      });
      expect(result.current.gameId).toBe('g1');

      act(() => { result.current.disconnect(); });

      expect(result.current.gameId).toBeNull();
      expect(result.current.playerNumber).toBeNull();
      expect(result.current.gameState).toBeNull();
      expect(result.current.connected).toBe(false);
    });
  });
});
