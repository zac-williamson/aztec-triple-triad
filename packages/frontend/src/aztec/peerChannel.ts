/**
 * The players' private channel for one game (docs/plan/PRIVATE_GAMES.md 5.1).
 *
 * Built on the key exchange in gameKeys.ts: our key pair plus the opponent's
 * public key give the game key (on-chain nullifiers hang off it) and the
 * channel key that seals every PEER payload. The relay forwards and buffers
 * the sealed payloads without being able to read them.
 *
 * Payloads come from the other player, so they are validated here, before
 * anything acts on them.
 */
import {
  deriveGameChannel,
  openPeerPayload,
  sealPeerPayload,
  type GameChannel,
  type GameKeyPair,
} from './gameKeys';
import { parseRecord, type GameRecord } from './privateGame';
import { TOTAL_MOVES } from './gameConstants';
import type { SealedPeerMessage } from '../types';

/** Phase A payloads. */
export type PeerPayload =
  /** A player's committed record: the creator's once create_game mined, the joiner's once join_game did. */
  | { kind: 'RECORD'; record: GameRecord }
  /** The settler is about to send settle_game with this prize move (null: a draw). */
  | { kind: 'SETTLING'; prizeMove: number | null }
  /** settle_game mined: import your own notes from this tx. */
  | { kind: 'SETTLED'; txHash: string }
  /** The creator cancelled before anyone joined. */
  | { kind: 'CANCELLED' };

/** Validate an opened payload. Throws on anything malformed. */
export function parsePeerPayload(raw: unknown): PeerPayload {
  if (!raw || typeof raw !== 'object') throw new Error('peer payload is not an object');
  const p = raw as Record<string, unknown>;
  switch (p.kind) {
    case 'RECORD':
      return { kind: 'RECORD', record: parseRecord(p.record) };
    case 'SETTLING': {
      const m = p.prizeMove;
      if (m === null) return { kind: 'SETTLING', prizeMove: null };
      if (typeof m === 'number' && Number.isInteger(m) && m >= 0 && m < TOTAL_MOVES) {
        return { kind: 'SETTLING', prizeMove: m };
      }
      throw new Error(`SETTLING carries an invalid prize move: ${String(m)}`);
    }
    case 'SETTLED': {
      const h = p.txHash;
      if (typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h)) return { kind: 'SETTLED', txHash: h.toLowerCase() };
      throw new Error('SETTLED carries an invalid tx hash');
    }
    case 'CANCELLED':
      return { kind: 'CANCELLED' };
    default:
      throw new Error(`unknown peer payload kind: ${String(p.kind)}`);
  }
}

/**
 * One game's channel: our key pair, and — once their half arrives — the
 * opponent's public key, the game key and the channel key.
 *
 * The first opponent key wins. A different one later is refused: both sides
 * must derive from the same pair or the game key differs and the join fails.
 */
export class PeerChannel {
  private opponentKey: string | null = null;
  private derived: GameChannel | null = null;
  private deriving: Promise<GameChannel> | null = null;
  private resolveReady!: (c: GameChannel) => void;
  private readonly ready: Promise<GameChannel>;

  constructor(readonly roomId: string, readonly keyPair: GameKeyPair) {
    this.ready = new Promise<GameChannel>(resolve => { this.resolveReady = resolve; });
  }

  get opponentPublicKey(): string | null {
    return this.opponentKey;
  }

  /** The game's shared key, once derived. */
  get gameKey(): string | null {
    return this.derived?.gameKey ?? null;
  }

  get isReady(): boolean {
    return this.derived !== null;
  }

  /** Resolves when the channel is derived. */
  whenReady(): Promise<GameChannel> {
    return this.ready;
  }

  /** Take the opponent's public key and derive the channel. Idempotent for the same key. */
  setOpponentKey(publicKey: string): Promise<GameChannel> {
    if (this.opponentKey !== null) {
      if (this.opponentKey !== publicKey) {
        return Promise.reject(new Error('the opponent sent a different key for this game — refusing it'));
      }
      return this.deriving!;
    }
    this.opponentKey = publicKey;
    this.deriving = deriveGameChannel(this.keyPair, publicKey, this.roomId).then(channel => {
      this.derived = channel;
      this.resolveReady(channel);
      return channel;
    });
    return this.deriving;
  }

  async seal(payload: PeerPayload): Promise<SealedPeerMessage> {
    const channel = await this.whenReady();
    return sealPeerPayload(channel.channelKey, this.roomId, payload);
  }

  async open(sealed: SealedPeerMessage): Promise<PeerPayload> {
    const channel = await this.whenReady();
    return parsePeerPayload(await openPeerPayload(channel.channelKey, this.roomId, sealed));
  }
}
