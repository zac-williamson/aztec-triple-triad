/**
 * The key exchange and the sealed channel, end to end between two players:
 * MATCH_FOUND → each stores its key pair BEFORE sending it → OPPONENT_KEY →
 * both derive the same game key → PEER payloads open on the other side, in
 * order, even when they arrive before the channel exists.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { ChannelNotReadyError, useGameChannel } from '../useGameChannel';
import type { PeerPayload } from '../../aztec/peerChannel';
import type { ServerMessage } from '../../types';
import { record } from '../../aztec/__tests__/privateGameFixtures';
import { normalizeField } from '../../aztec/privateGame';

beforeAll(() => {
  // jsdom's crypto has no `subtle`; the browser's and Node's both do.
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
});

/** One player's socket: what it sent, and a way to deliver what the relay forwards. */
function fakeSocket() {
  const listeners = new Set<(m: ServerMessage) => void>();
  const sent: { type: string; [k: string]: unknown }[] = [];
  return {
    sent,
    deliver: (m: ServerMessage) => listeners.forEach(cb => cb(m)),
    ws: {
      addMessageListener: (cb: (m: ServerMessage) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
      sendKeyExchange: (gameId: string, publicKey: string) => sent.push({ type: 'KEY_EXCHANGE', gameId, publicKey }),
      sendPeer: (gameId: string, sealed: { iv: string; ciphertext: string }) => sent.push({ type: 'PEER', gameId, ...sealed }),
    },
  };
}

function fakeStorage() {
  const games: Record<string, Record<string, unknown>> = {};
  return {
    games,
    mergeGame: vi.fn((id: string, fields: Record<string, unknown>) => { games[id] = { ...(games[id] ?? { gameId: id }), ...fields }; }),
    readGame: vi.fn((id: string) => (games[id] ?? null) as never),
  };
}

/** The relay: forward each side's KEY_EXCHANGE / PEER to the other as OPPONENT_KEY / PEER. */
function relay(from: ReturnType<typeof fakeSocket>, to: ReturnType<typeof fakeSocket>, sentBefore = 0) {
  for (const m of from.sent.slice(sentBefore)) {
    if (m.type === 'KEY_EXCHANGE') to.deliver({ type: 'OPPONENT_KEY', gameId: m.gameId as string, publicKey: m.publicKey as string });
    if (m.type === 'PEER') to.deliver({ type: 'PEER', gameId: m.gameId as string, iv: m.iv as string, ciphertext: m.ciphertext as string });
  }
  return from.sent.length;
}

const matchFound = (n: 1 | 2): ServerMessage =>
  ({ type: 'MATCH_FOUND', gameId: 'room-1', playerNumber: n });

describe('useGameChannel', () => {
  it('two players derive the same game key, and the relay sees only public keys and ciphertext', async () => {
    const a = fakeSocket(); const b = fakeSocket();
    const sa = fakeStorage(); const sb = fakeStorage();
    const alice = renderHook(() => useGameChannel({ ws: a.ws, storage: sa }));
    const bob = renderHook(() => useGameChannel({ ws: b.ws, storage: sb }));

    await act(async () => { a.deliver(matchFound(1)); b.deliver(matchFound(2)); });
    await waitFor(() => expect(a.sent.length + b.sent.length).toBe(2));
    // Stored before it was sent: a reload must come back to this key.
    expect(sa.games['room-1'].keyPair).toBeDefined();
    expect(a.sent[0]).toEqual({ type: 'KEY_EXCHANGE', gameId: 'room-1', publicKey: (sa.games['room-1'].keyPair as { publicKey: string }).publicKey });

    await act(async () => { relay(a, b); relay(b, a); });
    await waitFor(() => expect(alice.result.current.gameKey).not.toBeNull());
    await waitFor(() => expect(bob.result.current.gameKey).not.toBeNull());
    expect(alice.result.current.gameKey).toBe(bob.result.current.gameKey);
    expect(alice.result.current.roomId).toBe('room-1');
    expect(sa.games['room-1'].gameKey).toBe(alice.result.current.gameKey);

    // A payload crosses sealed and opens on the other side.
    const got: PeerPayload[] = [];
    bob.result.current.addPeerListener(p => got.push(p));
    const before = a.sent.length;
    await act(async () => { await alice.result.current.sendPeer({ kind: 'RECORD', record: record(1) }); });
    const wire = JSON.stringify(a.sent.slice(before));
    expect(wire).not.toContain('RECORD');
    expect(wire).not.toContain(record(1)[1].slice(2));
    await act(async () => { relay(a, b, before); });
    await waitFor(() => expect(got).toEqual([{ kind: 'RECORD', record: record(1) }]));
  });

  it('holds payloads that arrive before the channel exists, then opens them in order', async () => {
    const a = fakeSocket(); const b = fakeSocket();
    const alice = renderHook(() => useGameChannel({ ws: a.ws, storage: fakeStorage() }));
    const bob = renderHook(() => useGameChannel({ ws: b.ws, storage: fakeStorage() }));
    await act(async () => { a.deliver(matchFound(1)); b.deliver(matchFound(2)); });
    await waitFor(() => expect(a.sent.length + b.sent.length).toBe(2));
    // Only Bob has the other key: he can seal, Alice cannot open yet.
    await act(async () => { relay(a, b); });
    await waitFor(() => expect(bob.result.current.gameKey).not.toBeNull());

    const got: PeerPayload[] = [];
    alice.result.current.addPeerListener(p => got.push(p));
    const sent = b.sent.length;
    await act(async () => {
      await bob.result.current.sendPeer({ kind: 'SETTLING', prizeMove: 3 });
      await bob.result.current.sendPeer({ kind: 'SETTLED', txHash: '0x' + 'cd'.repeat(32) });
    });
    // The payloads reach Alice BEFORE Bob's key does (the relay replays its
    // buffer in whatever order it holds it).
    await act(async () => { relay(b, a, sent); });
    await new Promise(r => setTimeout(r, 20));
    expect(got, 'nothing opens without the channel').toEqual([]);
    expect(alice.result.current.gameKey).toBeNull();

    await act(async () => { relay(b, a, 0); }); // now the key (and the payloads again)
    await waitFor(() => expect(alice.result.current.gameKey).not.toBeNull());
    await waitFor(() => expect(got.slice(0, 2)).toEqual([
      { kind: 'SETTLING', prizeMove: 3 },
      { kind: 'SETTLED', txHash: '0x' + 'cd'.repeat(32) },
    ]));
  });

  it('rebuilds the channel from storage when the relay replays before the player resumes', async () => {
    const a = fakeSocket(); const b = fakeSocket();
    const sa = fakeStorage();
    const alice = renderHook(() => useGameChannel({ ws: a.ws, storage: sa }));
    const bob = renderHook(() => useGameChannel({ ws: b.ws, storage: fakeStorage() }));
    await act(async () => { a.deliver(matchFound(1)); b.deliver(matchFound(2)); });
    await waitFor(() => expect(a.sent.length + b.sent.length).toBe(2));
    await act(async () => { relay(a, b); relay(b, a); });
    await waitFor(() => expect(alice.result.current.gameKey).not.toBeNull());
    const key = alice.result.current.gameKey;
    alice.unmount();

    // Alice reloads: a new hook, the same storage, no MATCH_FOUND.
    const a2 = fakeSocket();
    const reloaded = renderHook(() => useGameChannel({ ws: a2.ws, storage: sa }));
    const got: PeerPayload[] = [];
    reloaded.result.current.addPeerListener(p => got.push(p));
    const sent = b.sent.length;
    await act(async () => { await bob.result.current.sendPeer({ kind: 'CANCELLED' }); });
    await act(async () => { relay(b, a2, sent); });
    await waitFor(() => expect(got).toEqual([{ kind: 'CANCELLED' }]));
    expect(reloaded.result.current.gameKey).toBe(key);
    expect(a2.sent.filter(m => m.type === 'KEY_EXCHANGE'), 'no fresh key pair after a reload').toHaveLength(0);
  });

  it('drops a payload that does not open — tampered, or sealed for someone else', async () => {
    const a = fakeSocket(); const b = fakeSocket();
    const alice = renderHook(() => useGameChannel({ ws: a.ws, storage: fakeStorage() }));
    renderHook(() => useGameChannel({ ws: b.ws, storage: fakeStorage() }));
    await act(async () => { a.deliver(matchFound(1)); b.deliver(matchFound(2)); });
    await waitFor(() => expect(a.sent.length + b.sent.length).toBe(2));
    await act(async () => { relay(a, b); relay(b, a); });
    await waitFor(() => expect(alice.result.current.gameKey).not.toBeNull());

    const got: PeerPayload[] = [];
    alice.result.current.addPeerListener(p => got.push(p));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await act(async () => { a.deliver({ type: 'PEER', gameId: 'room-1', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==' }); });
    await new Promise(r => setTimeout(r, 20));
    expect(got).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('seals a MOVE so only the other player can open it — also from a game rebuilt from storage', async () => {
    const a = fakeSocket(); const b = fakeSocket();
    const sb = fakeStorage();
    const alice = renderHook(() => useGameChannel({ ws: a.ws, storage: fakeStorage() }));
    const bob = renderHook(() => useGameChannel({ ws: b.ws, storage: sb }));
    const move = { cardId: 21, slot: 3, row: 1, col: 2, proof: btoa('proof'), publicInputs: Array.from({ length: 8 }, (_, i) => normalizeField(i + 1)) };

    // Before the exchange there is nothing to seal with.
    await expect(alice.result.current.sealMove('room-1', move)).rejects.toBeInstanceOf(ChannelNotReadyError);

    await act(async () => { a.deliver(matchFound(1)); b.deliver(matchFound(2)); });
    await waitFor(() => expect(a.sent.length + b.sent.length).toBe(2));
    await act(async () => { relay(a, b); relay(b, a); });
    await waitFor(() => expect(alice.result.current.gameKey).not.toBeNull());
    await waitFor(() => expect(bob.result.current.gameKey).not.toBeNull());

    const sealed = await alice.result.current.sealMove('room-1', move);
    expect(JSON.stringify(sealed)).not.toContain('"cardId"');
    expect(await bob.result.current.openMove('room-1', sealed)).toEqual(move);
    // Tampered: refused.
    await expect(bob.result.current.openMove('room-1', { ...sealed, ciphertext: btoa('x'.repeat(40)) })).rejects.toThrow();

    // Bob reloads and sits on the menu: no live channel, but his keys are stored.
    bob.unmount();
    const bob2 = renderHook(() => useGameChannel({ ws: fakeSocket().ws, storage: sb }));
    expect(await bob2.result.current.openMove('room-1', sealed)).toEqual(move);
  });
});
