import type { SerializedProof, HandProof, MoveProof, Proof } from './types.js';

/**
 * Convert a raw proof to serialized format for WebSocket transport.
 */
export function serializeProof(proof: Proof): SerializedProof {
  return {
    proof: uint8ArrayToBase64(proof.proof),
    publicInputs: proof.publicInputs,
  };
}

/**
 * Deserialize a proof received via WebSocket.
 */
export function deserializeProof(serialized: SerializedProof): Proof {
  return {
    proof: base64ToUint8Array(serialized.proof),
    publicInputs: serialized.publicInputs,
  };
}

/**
 * Create a HandProof from raw proof data.
 */
export function createHandProof(
  proof: Proof,
  cardCommit: string,
): HandProof {
  const serialized = serializeProof(proof);
  return {
    type: 'hand',
    ...serialized,
    cardCommit,
  };
}

/**
 * Create a MoveProof from raw proof data.
 */
export function createMoveProof(
  proof: Proof,
  cardCommit1: string,
  cardCommit2: string,
  startStateHash: string,
  endStateHash: string,
  gameEnded: boolean,
  winnerId: number,
): MoveProof {
  const serialized = serializeProof(proof);
  return {
    type: 'move',
    ...serialized,
    cardCommit1,
    cardCommit2,
    startStateHash,
    endStateHash,
    gameEnded,
    winnerId,
  };
}

/**
 * Convert Uint8Array to base64 string.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert base64 string to Uint8Array.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
