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
