import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';

// Mock WebSocket with controllable message dispatch
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

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
    // Auto-connect on next tick
    setTimeout(() => this.onopen?.(), 0);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.onclose?.();
  }

  // Helper to simulate receiving a message
  simulateMessage(data: string) {
    this.onmessage?.({ data });
  }
}

describe('useWebSocket', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    MockWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it('should handle malformed JSON messages without crashing', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useWebSocket('ws://localhost:3001'));

    // Wait for connection
    await act(async () => {
      await new Promise(r => setTimeout(r, 100));
    });

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();

    // Send malformed JSON — should not throw
    act(() => {
      ws.simulateMessage('this is not json{{{');
    });

    // App should still be functional (no crash)
    expect(result.current.error).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('malformed JSON'),
      expect.any(String),
    );

    consoleSpy.mockRestore();
  });

  it('should handle empty message data without crashing', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useWebSocket('ws://localhost:3001'));

    await act(async () => {
      await new Promise(r => setTimeout(r, 100));
    });

    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.simulateMessage('');
    });

    expect(result.current.error).toBeNull();
    consoleSpy.mockRestore();
  });

  it('should process valid GAME_CREATED messages correctly', async () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:3001'));

    await act(async () => {
      await new Promise(r => setTimeout(r, 100));
    });

    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.simulateMessage(JSON.stringify({
        type: 'GAME_CREATED',
        gameId: '0xabc123',
        playerNumber: 1,
      }));
    });

    expect(result.current.gameId).toBe('0xabc123');
    expect(result.current.playerNumber).toBe(1);
  });

  it('should process valid ERROR messages', async () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:3001'));

    await act(async () => {
      await new Promise(r => setTimeout(r, 100));
    });

    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.simulateMessage(JSON.stringify({
        type: 'ERROR',
        message: 'Game not found',
      }));
    });

    expect(result.current.error).toBe('Game not found');
  });

  it('should send CREATE_GAME message on createGame', async () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:3001'));

    await act(async () => {
      await new Promise(r => setTimeout(r, 100));
    });

    const ws = MockWebSocket.instances[0];

    act(() => {
      result.current.createGame([1, 2, 3, 4, 5]);
    });

    expect(ws.sentMessages).toHaveLength(1);
    const parsed = JSON.parse(ws.sentMessages[0]);
    expect(parsed.type).toBe('CREATE_GAME');
    expect(parsed.cardIds).toEqual([1, 2, 3, 4, 5]);
  });

  it('should reset all state on disconnect', async () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:3001'));

    await act(async () => {
      await new Promise(r => setTimeout(r, 100));
    });

    const ws = MockWebSocket.instances[0];

    // Set some state
    act(() => {
      ws.simulateMessage(JSON.stringify({
        type: 'GAME_CREATED',
        gameId: '0xabc123',
        playerNumber: 1,
      }));
    });

    expect(result.current.gameId).toBe('0xabc123');

    // Disconnect
    act(() => {
      result.current.disconnect();
    });

    expect(result.current.gameId).toBeNull();
    expect(result.current.playerNumber).toBeNull();
    expect(result.current.gameState).toBeNull();
  });
});
