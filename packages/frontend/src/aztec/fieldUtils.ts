/**
 * Shared Fr conversion utilities for the Aztec frontend.
 *
 * Aztec .simulate() results may return Fr objects, decimal strings, or hex strings.
 * These helpers handle all cases safely.
 */

let _Fr: any = null;

/** Lazily load and cache the Fr class from @aztec/aztec.js/fields */
export async function getFr(): Promise<any> {
  if (!_Fr) {
    const mod = await import('@aztec/aztec.js/fields');
    _Fr = mod.Fr;
  }
  return _Fr;
}

/**
 * Convert any value (Fr, hex string, decimal string, BigInt) to an Fr instance.
 * CRITICAL: Never use Fr.fromHexString on decimal strings — they'll be misinterpreted.
 */
export function toFr(Fr: any, v: any): any {
  if (v instanceof Fr) return v;
  const s = v.toString();
  if (s.startsWith('0x') || s.startsWith('0X')) return Fr.fromHexString(s);
  return new Fr(BigInt(s));
}

/**
 * Normalize a value to a hex string (0x-prefixed).
 * Handles decimal strings, hex strings, Fr objects, and BigInts.
 */
export function toHexString(v: any): string {
  const s = v.toString();
  if (s.startsWith('0x') || s.startsWith('0X')) return s;
  return '0x' + BigInt(s).toString(16);
}

/**
 * Convert raw bytes to Fr[] (32 bytes per field element).
 * Used for verification key and proof serialization.
 */
export function bytesToFrArray(Fr: any, bytes: Uint8Array): any[] {
  const fields: any[] = [];
  for (let i = 0; i < bytes.length; i += 32) {
    const chunk = bytes.slice(i, i + 32);
    const hex = '0x' + Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join('');
    fields.push(Fr.fromHexString(hex));
  }
  return fields;
}

/**
 * Convert a base64-encoded proof to Fr[].
 */
export function base64ToFrArray(Fr: any, b64: string): any[] {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytesToFrArray(Fr, bytes);
}

/**
 * Convert a hex string to Fr (auto-prefixes 0x if missing).
 */
export function hexToFr(Fr: any, hex: string): any {
  return Fr.fromHexString(hex.startsWith('0x') ? hex : '0x' + hex);
}
