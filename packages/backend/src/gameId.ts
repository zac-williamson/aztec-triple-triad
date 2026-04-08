import crypto from 'crypto';

/**
 * Generate a game ID that is a valid BN254 field element.
 * Uses 31 random bytes (248 bits of entropy) which is always < BN254 modulus (~254 bits).
 * Returns a 0x-prefixed hex string.
 */
export function generateGameId(): string {
  return '0x' + crypto.randomBytes(31).toString('hex');
}
