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
      act(() => { ws.simulateMessage({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1 }); });
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

    it('MATCH_FOUND names the room and our side — and carries no game state', async () => {
      const { result, ws } = await setupConnectedHook();
      act(() => { ws.simulateMessage({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2 }); });
      expect(result.current.gameId).toBe('g1');
      expect(result.current.playerNumber).toBe(2);
      expect(result.current.matchmakingStatus).toBe('matched');
      // The relay runs no game: nothing here holds a board, a hand or a result.
      for (const gone of ['gameState', 'lastCaptures', 'gameOver', 'lastMoveProof', 'gameList']) {
        expect(gone in result.current, gone).toBe(false);
      }
    });

    it('ROOM_STATE (after a resume) restores the room, our side, and whether the opponent is here', async () => {
      const { result, ws } = await setupConnectedHook();
      act(() => {
        ws.simulateMessage({ type: 'ROOM_STATE', gameId: 'g1', playerNumber: 1, movesMade: 4, opponentConnected: false });
      });
      expect(result.current.gameId).toBe('g1');
      expect(result.current.playerNumber).toBe(1);
      expect(result.current.roomState).toEqual({ gameId: 'g1', playerNumber: 1, movesMade: 4, opponentConnected: false });
      expect(result.current.opponentDisconnected).toBe(true);
      // Each ROOM_STATE is a new object, so a consumer acts once per message.
      const first = result.current.roomState;
      act(() => {
        ws.simulateMessage({ type: 'ROOM_STATE', gameId: 'g1', playerNumber: 1, movesMade: 4, opponentConnected: true });
      });
      expect(result.current.roomState).not.toBe(first);
      expect(result.current.opponentDisconnected).toBe(false);
    });

    it('ON_CHAIN_STATUS sets opponentTxConfirmed for P2 when P1 confirmed', async () => {
      const { result, ws } = await setupConnectedHook();
      // Set as player 2
      act(() => { ws.simulateMessage({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2 }); });
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

    it('never exposes who the opponent is, even if a server sends the old flag', async () => {
      // The bot is a fallback for when nobody else is queuing, and a player
      // should not be able to tell they got one. An older relay may still put
      // opponentIsBot on the wire; the client must not surface it anywhere.
      const { result, ws } = await setupConnectedHook();
      act(() => {
        ws.simulateMessage({ type: 'MATCH_FOUND', gameId: 'm', playerNumber: 1, opponentIsBot: true });
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

  // --- Moves and matchmaking (docs/plan/PRIVATE_GAMES.md section 6.1) ---

  describe('moves and matchmaking', () => {
    async function connected() {
      const { result } = renderHook(() => useWebSocket('ws://test'));
      await act(async () => { await waitForConnect(); });
      const ws = latestWs();
      act(() => { ws.simulateSessionEstablished(); });
      return { result, ws, last: () => JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]) };
    }

    it('a MOVE goes out sealed: the relay reads its number and nothing else', async () => {
      const { result, last } = await connected();
      act(() => { result.current.sendMove('room-1', 3, { iv: 'IV', ciphertext: 'CT' }); });
      expect(last()).toEqual({ type: 'MOVE', gameId: 'room-1', moveNumber: 3, iv: 'IV', ciphertext: 'CT' });
    });

    it('an incoming MOVE reaches the listeners only — no React state holds it', async () => {
      const { result, ws } = await connected();
      const seen: unknown[] = [];
      act(() => { result.current.addMessageListener(m => seen.push(m)); });
      act(() => { ws.simulateMessage({ type: 'MOVE', gameId: 'room-1', moveNumber: 0, iv: 'IV', ciphertext: 'CT' }); });
      expect(seen).toEqual([{ type: 'MOVE', gameId: 'room-1', moveNumber: 0, iv: 'IV', ciphertext: 'CT' }]);
      expect(result.current.error).toBeNull();
    });

    it('queueing tells the relay nothing about the hand', async () => {
      const { result, last } = await connected();
      act(() => { result.current.queueMatchmaking(); });
      expect(last()).toEqual({ type: 'QUEUE_MATCHMAKING' });
    });

    it('offers none of the relay-run game\'s actions any more', async () => {
      const { result } = await connected();
      for (const gone of ['placeCard', 'submitMoveProof', 'createGame', 'joinGame', 'refreshGameList', 'notifyAbandonedGameSettled']) {
        expect(gone in result.current, gone).toBe(false);
      }
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

    it('clears the warning when the opponent\'s MOVE arrives', async () => {
      const { result, ws } = await setupConnectedHook();
      act(() => {
        ws.simulateMessage({
          type: 'GAME_ABANDONMENT_WARNING', gameId: 'g1',
          idlePlayer: 'player2', secondsIdle: 60, secondsUntilClaimable: 5,
        });
      });
      expect(result.current.abandonmentWarning).not.toBeNull();
      act(() => { ws.simulateMessage({ type: 'MOVE', gameId: 'g1', moveNumber: 1, iv: 'IV', ciphertext: 'CT' }); });
      expect(result.current.abandonmentWarning).toBeNull();
    });

    it('clears the warning when we send our MOVE', async () => {
      const { result, ws } = await setupConnectedHook();
      act(() => {
        ws.simulateMessage({
          type: 'GAME_ABANDONMENT_WARNING', gameId: 'g1',
          idlePlayer: 'player1', secondsIdle: 60, secondsUntilClaimable: 5,
        });
      });
      act(() => { result.current.sendMove('g1', 2, { iv: 'IV', ciphertext: 'CT' }); });
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

  });

  describe('the private-games relay protocol (Phase A)', () => {
    async function connected() {
      const { result } = renderHook(() => useWebSocket('ws://test'));
      await act(async () => { await waitForConnect(); });
      const ws = latestWs();
      act(() => { ws.simulateSessionEstablished(); });
      return { result, ws, last: () => JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]) };
    }

    it('sends only the public half of the key exchange', async () => {
      const { result, last } = await connected();
      act(() => { result.current.sendKeyExchange('room-1', 'BASE64PUB'); });
      expect(last()).toEqual({ type: 'KEY_EXCHANGE', gameId: 'room-1', publicKey: 'BASE64PUB' });
    });

    it('sends sealed peer payloads as they are', async () => {
      const { result, last } = await connected();
      act(() => { result.current.sendPeer('room-1', { iv: 'IV', ciphertext: 'CT' }); });
      expect(last()).toEqual({ type: 'PEER', gameId: 'room-1', iv: 'IV', ciphertext: 'CT' });
    });

    it('TX_CONFIRMED carries no tx hash: the relay must not find the game\'s txs', async () => {
      const { result, last } = await connected();
      act(() => { result.current.notifyTxConfirmed('room-1', 'create_game'); });
      expect(last()).toEqual({ type: 'TX_CONFIRMED', gameId: 'room-1', txType: 'create_game' });
    });

    it('hands OPPONENT_KEY and PEER to the listeners only — no React state holds them', async () => {
      const { result, ws } = await connected();
      const seen: string[] = [];
      act(() => { result.current.addMessageListener(m => seen.push(m.type)); });
      act(() => {
        ws.simulateMessage({ type: 'OPPONENT_KEY', gameId: 'room-1', publicKey: 'PK' });
        ws.simulateMessage({ type: 'PEER', gameId: 'room-1', iv: 'IV', ciphertext: 'CT' });
      });
      expect(seen).toEqual(['OPPONENT_KEY', 'PEER']);
      expect(result.current.error).toBeNull();
    });

    it('no longer exposes anything about the opponent\'s notes, address or secrets', async () => {
      const { result } = await connected();
      for (const gone of ['opponentAztecAddress', 'opponentGameRandomness', 'opponentBlinding', 'incomingNoteData',
        'opponentSettling', 'opponentHandProof', 'shareAztecInfo', 'shareBlinding', 'relayNoteData', 'submitHandProof']) {
        expect(gone in result.current, gone).toBe(false);
      }
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
        result.current.queueMatchmaking();
        result.current.ping();
        result.current.sendMove('g1', 0, { iv: 'IV', ciphertext: 'CT' });
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
        ws.simulateMessage({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1 });
        ws.simulateMessage({ type: 'ROOM_STATE', gameId: 'g1', playerNumber: 1, movesMade: 2, opponentConnected: true });
      });
      expect(result.current.gameId).toBe('g1');

      act(() => { result.current.disconnect(); });

      expect(result.current.gameId).toBeNull();
      expect(result.current.playerNumber).toBeNull();
      expect(result.current.roomState).toBeNull();
      expect(result.current.connected).toBe(false);
    });
  });
});
