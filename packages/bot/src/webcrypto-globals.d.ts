/**
 * WebCrypto type names the shared key exchange (frontend/src/aztec/gameKeys.ts)
 * uses that Node's types declare only inside `crypto.webcrypto`. The bot
 * compiles with lib ES2020 (no DOM), so they are named globally here. Types
 * only: at runtime the bot uses Node's own global `crypto.subtle`.
 */
import type { webcrypto } from 'crypto';

declare global {
  type JsonWebKey = webcrypto.JsonWebKey;
  type CryptoKeyPair = webcrypto.CryptoKeyPair;
}

export {};
