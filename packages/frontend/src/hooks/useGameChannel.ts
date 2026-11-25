import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseWebSocketReturn } from './useWebSocket';
import type { PersistedGameState, UseGameStorageReturn } from './useGameStorage';
import { generateGameKeyPair } from '../aztec/gameKeys';
import { PeerChannel, type PeerPayload } from '../aztec/peerChannel';
import type { MovePayload } from '../aztec/localGame';
import type { SealedPeerMessage, ServerMessage } from '../types';

/** No channel for the room yet (the key exchange has not completed, or its keys are not stored). */
export class ChannelNotReadyError extends Error {
  constructor(roomId: string) {
    super(`no game channel for room ${roomId} yet`);
  }
}

export interface UseGameChannelParams {
  ws: Pick<UseWebSocketReturn, 'addMessageListener' | 'sendKeyExchange' | 'sendPeer'>;
  storage: Pick<UseGameStorageReturn, 'mergeGame' | 'readGame'>;
}

export type PeerListener = (payload: PeerPayload, roomId: string) => void;

export interface UseGameChannelReturn {
  /** The live game's shared key, once the exchange completed. */
  gameKey: string | null;
  /** The relay room the live channel belongs to. */
  roomId: string | null;
  /** Identity-stable read of the same key, for async callbacks. */
  getGameKey: () => string | null;
  /** Seal a payload for the opponent and send it; waits for the channel. */
  sendPeer: (payload: PeerPayload) => Promise<void>;
  /**
   * Seal and send for a game that is not the live one (the menu's recovery),
   * from its stored keys. Best effort: false when the keys are not stored.
   */
  sendPeerFor: (roomId: string, payload: PeerPayload) => Promise<boolean>;
  /** Opened, validated payloads from the opponent, in arrival order. */
  addPeerListener: (cb: PeerListener) => () => void;
  /**
   * Seal / open a MOVE body for `roomId` — the live channel, or one rebuilt
   * from the stored keys. Throw ChannelNotReadyError when there is no
   * channel; `openMove` throws anything else for a payload that does not open.
   */
  sealMove: (roomId: string, move: MovePayload) => Promise<SealedPeerMessage>;
  openMove: (roomId: string, sealed: SealedPeerMessage) => Promise<MovePayload>;
  /** Re-attach to a saved game's channel (resume after a reload). */
  restoreFromSave: (saved: PersistedGameState) => void;
  resetForMenu: () => void;
}

/**
 * The per-game key exchange and the sealed channel on top of it
 * (docs/plan/PRIVATE_GAMES.md section 5.1).
 *
 * At MATCH_FOUND each side makes a key pair, STORES it, then sends the public
 * half (KEY_EXCHANGE). On OPPONENT_KEY both derive the same game key and
 * channel key. Every PEER payload is opened here and handed to the listeners
 * — the session (records, cancel) and settlement (settling, settled).
 *
 * Reload-safe: the key pair is stored before it is ever sent, and a payload
 * or key that arrives before the channel exists (the relay replays its buffer
 * on reconnect, possibly before the player resumes) is held until it does,
 * or rebuilt from storage.
 */
export function useGameChannel({ ws, storage }: UseGameChannelParams): UseGameChannelReturn {
  const [gameKey, setGameKey] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);

  const channelRef = useRef<PeerChannel | null>(null);
  const startingRef = useRef<string | null>(null);
  const pendingKeysRef = useRef(new Map<string, string>());
  const inboundRef = useRef<{ roomId: string; sealed: SealedPeerMessage }[]>([]);
  const listenersRef = useRef(new Set<PeerListener>());
  const serialRef = useRef<Promise<void>>(Promise.resolve());
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const storageRef = useRef(storage);
  storageRef.current = storage;

  /** Run inbound work one item at a time, so payloads are handled in order. */
  const serially = useCallback((fn: () => Promise<void>) => {
    serialRef.current = serialRef.current.then(fn).catch(err => {
      console.warn('[useGameChannel] inbound handling failed:', err);
    });
  }, []);

  const dispatch = useCallback((payload: PeerPayload, room: string) => {
    for (const cb of listenersRef.current) {
      try {
        cb(payload, room);
      } catch (err) {
        console.error('[useGameChannel] a peer listener threw:', err);
      }
    }
  }, []);

  /** Open every held payload for the live channel's room, in arrival order. */
  const drain = useCallback(async () => {
    const ch = channelRef.current;
    if (!ch?.isReady) return;
    const mine = inboundRef.current.filter(m => m.roomId === ch.roomId);
    inboundRef.current = inboundRef.current.filter(m => m.roomId !== ch.roomId);
    for (const m of mine) {
      let payload: PeerPayload;
      try {
        payload = await ch.open(m.sealed);
      } catch (err) {
        // Tampered, for another key, or malformed: never act on it.
        console.warn('[useGameChannel] dropped a peer payload that did not open:', err);
        continue;
      }
      dispatch(payload, ch.roomId);
    }
  }, [dispatch]);

  const adopt = useCallback((ch: PeerChannel) => {
    channelRef.current = ch;
    setRoomId(ch.roomId);
    setGameKey(ch.gameKey);
  }, []);

  const acceptOpponentKey = useCallback(async (ch: PeerChannel, publicKey: string) => {
    try {
      const derived = await ch.setOpponentKey(publicKey);
      storageRef.current.mergeGame(ch.roomId, { opponentPublicKey: publicKey, gameKey: derived.gameKey });
      if (channelRef.current === ch) setGameKey(derived.gameKey);
      serially(drain);
    } catch (err) {
      console.warn(`[useGameChannel] refused the opponent's key for ${ch.roomId}:`, err);
    }
  }, [drain, serially]);

  /**
   * The channel for `room`: the live one, or — when there is no live channel
   * — one rebuilt from storage. Never displaces a live channel for another
   * room: a replayed message for an old game must not hijack the current one.
   */
  const channelFor = useCallback((room: string): PeerChannel | null => {
    const live = channelRef.current;
    if (live?.roomId === room) return live;
    if (live) return null;
    const saved = storageRef.current.readGame(room);
    if (!saved?.keyPair) return null;
    const ch = new PeerChannel(room, saved.keyPair);
    adopt(ch);
    if (saved.opponentPublicKey) void acceptOpponentKey(ch, saved.opponentPublicKey);
    return ch;
  }, [adopt, acceptOpponentKey]);

  /** MATCH_FOUND: make (or recover) our key pair for the room and send its public half. */
  const startChannel = useCallback(async (room: string) => {
    if (channelRef.current?.roomId === room || startingRef.current === room) return;
    const saved = storageRef.current.readGame(room);
    if (saved?.keyPair) {
      // The pair was made and stored before a reload; reuse it, never replace
      // it — the opponent may already have derived with it.
      const ch = new PeerChannel(room, saved.keyPair);
      adopt(ch);
      if (saved.opponentPublicKey) await acceptOpponentKey(ch, saved.opponentPublicKey);
      else wsRef.current.sendKeyExchange(room, saved.keyPair.publicKey);
      return;
    }
    startingRef.current = room;
    try {
      const keyPair = await generateGameKeyPair();
      // Stored BEFORE it is sent: a reload must come back to the key the
      // opponent will derive with, not a fresh one.
      storageRef.current.mergeGame(room, { keyPair });
      const ch = new PeerChannel(room, keyPair);
      adopt(ch);
      wsRef.current.sendKeyExchange(room, keyPair.publicKey);
      const early = pendingKeysRef.current.get(room);
      if (early) {
        pendingKeysRef.current.delete(room);
        await acceptOpponentKey(ch, early);
      }
    } catch (err) {
      console.error('[useGameChannel] could not start the key exchange:', err);
    } finally {
      startingRef.current = null;
    }
  }, [adopt, acceptOpponentKey]);

  useEffect(() => {
    return ws.addMessageListener((msg: ServerMessage) => {
      switch (msg.type) {
        case 'MATCH_FOUND':
          void startChannel(msg.gameId);
          break;
        case 'OPPONENT_KEY': {
          const ch = channelFor(msg.gameId);
          if (ch) void acceptOpponentKey(ch, msg.publicKey);
          // Our own pair is still being generated: hold theirs until it is.
          else pendingKeysRef.current.set(msg.gameId, msg.publicKey);
          break;
        }
        case 'PEER': {
          channelFor(msg.gameId);
          inboundRef.current.push({ roomId: msg.gameId, sealed: { iv: msg.iv, ciphertext: msg.ciphertext } });
          serially(drain);
          break;
        }
      }
    });
  }, [ws.addMessageListener, startChannel, channelFor, acceptOpponentKey, serially, drain]);

  const getGameKey = useCallback((): string | null => channelRef.current?.gameKey ?? null, []);

  const sendPeer = useCallback(async (payload: PeerPayload): Promise<void> => {
    const ch = channelRef.current;
    if (!ch) throw new Error('no game channel to send on');
    const sealed = await ch.seal(payload);
    wsRef.current.sendPeer(ch.roomId, sealed);
  }, []);

  const sendPeerFor = useCallback(async (room: string, payload: PeerPayload): Promise<boolean> => {
    const live = channelRef.current;
    if (live?.roomId === room && live.isReady) {
      wsRef.current.sendPeer(room, await live.seal(payload));
      return true;
    }
    const saved = storageRef.current.readGame(room);
    if (!saved?.keyPair || !saved.opponentPublicKey) return false;
    const ch = new PeerChannel(room, saved.keyPair);
    await ch.setOpponentKey(saved.opponentPublicKey);
    wsRef.current.sendPeer(room, await ch.seal(payload));
    return true;
  }, []);

  /** A derived channel for `room`: the live one, or one rebuilt from storage; null if neither. */
  const readyChannelFor = useCallback(async (room: string): Promise<PeerChannel | null> => {
    const live = channelRef.current;
    if (live?.roomId === room) {
      if (live.isReady) return live;
      // Their key is in and being derived with (a restore): wait for that
      // derivation (whenReady would hang forever on one that failed). A
      // channel that cannot be derived is no channel: nothing is held against
      // a payload it cannot open.
      if (!live.opponentPublicKey) return null;
      try {
        await live.setOpponentKey(live.opponentPublicKey);
        return live;
      } catch {
        return null;
      }
    }
    const saved = storageRef.current.readGame(room);
    if (!saved?.keyPair || !saved.opponentPublicKey) return null;
    const ch = new PeerChannel(room, saved.keyPair);
    try {
      await ch.setOpponentKey(saved.opponentPublicKey);
    } catch {
      return null;
    }
    return ch;
  }, []);

  const sealMove = useCallback(async (room: string, move: MovePayload): Promise<SealedPeerMessage> => {
    const ch = await readyChannelFor(room);
    if (!ch) throw new ChannelNotReadyError(room);
    return ch.sealMove(move);
  }, [readyChannelFor]);

  const openMove = useCallback(async (room: string, sealed: SealedPeerMessage): Promise<MovePayload> => {
    const ch = await readyChannelFor(room);
    if (!ch) throw new ChannelNotReadyError(room);
    return ch.openMove(sealed);
  }, [readyChannelFor]);

  const addPeerListener = useCallback((cb: PeerListener) => {
    listenersRef.current.add(cb);
    return () => { listenersRef.current.delete(cb); };
  }, []);

  const restoreFromSave = useCallback((saved: PersistedGameState) => {
    if (!saved.keyPair) return;
    if (channelRef.current?.roomId === saved.gameId) return;
    const ch = new PeerChannel(saved.gameId, saved.keyPair);
    adopt(ch);
    if (saved.opponentPublicKey) void acceptOpponentKey(ch, saved.opponentPublicKey);
    else wsRef.current.sendKeyExchange(saved.gameId, saved.keyPair.publicKey);
  }, [adopt, acceptOpponentKey]);

  const resetForMenu = useCallback(() => {
    channelRef.current = null;
    startingRef.current = null;
    pendingKeysRef.current.clear();
    inboundRef.current = [];
    setGameKey(null);
    setRoomId(null);
  }, []);

  return { gameKey, roomId, getGameKey, sendPeer, sendPeerFor, addPeerListener, sealMove, openMove, restoreFromSave, resetForMenu };
}
