/**
 * The per-game key exchange (docs/plan/PRIVATE_GAMES.md section 5.1).
 *
 * At MATCH_FOUND each player makes a fresh P-256 key pair and sends only the
 * public half through the relay. From the shared secret both derive, with
 * HKDF-SHA256:
 *
 *   - `gameKey`: the field element every on-chain game nullifier hangs off.
 *     The relay never learns it, so it can neither find a game's transactions
 *     nor tell them from anyone else's.
 *   - a channel key (AES-256-GCM) that seals every PEER payload, so the relay
 *     forwards records and settlement notices it cannot read.
 *
 * The salt binds the room id and BOTH public keys, so the two sides agree only
 * if each received the other's real key.
 *
 * Plain WebCrypto, so the browser and the bot (Node) run the same code. Keep
 * the private key: a reload must still be able to open buffered payloads.
 */
import { Fr } from '@aztec-labs/aztec.js/fields';

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const GAME_KEY_INFO = 'axolotl-arena/game-key';
const CHANNEL_INFO = 'axolotl-arena/channel';

export interface GameKeyPair {
  /** Private key as JWK, so it can be persisted with the game. */
  privateJwk: JsonWebKey;
  /** Uncompressed public key (65 bytes), base64. */
  publicKey: string;
}

export interface GameChannel {
  /** The game's shared secret, as a field element (hex). */
  gameKey: string;
  /** AES-256-GCM key sealing PEER payloads. */
  channelKey: CryptoKey;
}

export interface SealedPayload {
  iv: string;
  ciphertext: string;
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto is unavailable: cannot run the game key exchange');
  return s;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/** A fresh key pair for one game. */
export async function generateGameKeyPair(): Promise<GameKeyPair> {
  const pair = (await subtle().generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  const privateJwk = await subtle().exportKey('jwk', pair.privateKey);
  return { privateJwk, publicKey: toBase64(raw) };
}

/**
 * Derive the game key and the channel key from our key pair and the
 * opponent's public key. Both players get the same result.
 */
export async function deriveGameChannel(own: GameKeyPair, theirPublicKey: string, roomId: string): Promise<GameChannel> {
  if (theirPublicKey === own.publicKey) throw new Error('The opponent sent back our own public key');
  const s = subtle();
  const privateKey = await s.importKey('jwk', own.privateJwk, ECDH, false, ['deriveBits']);
  const theirKey = await s.importKey('raw', fromBase64(theirPublicKey), ECDH, false, []);
  const shared = await s.deriveBits({ name: 'ECDH', public: theirKey }, privateKey, 256);

  const [a, b] = [own.publicKey, theirPublicKey].sort();
  const salt = await s.digest('SHA-256', enc.encode(`${roomId}|${a}|${b}`));
  const hkdfKey = await s.importKey('raw', shared, 'HKDF', false, ['deriveBits', 'deriveKey']);

  const gameKeyBits = await s.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(GAME_KEY_INFO) },
    hkdfKey,
    256,
  );
  const gameKey = new Fr(bytesToBigInt(new Uint8Array(gameKeyBits)) % Fr.MODULUS).toString();

  const channelKey = await s.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(CHANNEL_INFO) },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { gameKey, channelKey };
}

/** Seal a payload for the opponent. The room id is authenticated too. */
export async function sealPeerPayload(channelKey: CryptoKey, roomId: string, payload: unknown): Promise<SealedPayload> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(roomId) },
    channelKey,
    enc.encode(JSON.stringify(payload)),
  );
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

/** Open a payload from the opponent. Throws if it was tampered with. */
export async function openPeerPayload<T = unknown>(channelKey: CryptoKey, roomId: string, sealed: SealedPayload): Promise<T> {
  const plaintext = await subtle().decrypt(
    { name: 'AES-GCM', iv: fromBase64(sealed.iv), additionalData: enc.encode(roomId) },
    channelKey,
    fromBase64(sealed.ciphertext),
  );
  return JSON.parse(dec.decode(plaintext)) as T;
}
