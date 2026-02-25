// Types
export type {
  FieldValue,
  CircuitBoard,
  ProveHandInput,
  GameMoveInput,
  Proof,
  SerializedProof,
  HandProof,
  MoveProof,
  GameProofBundle,
  PlayerSession,
} from './types.js';

// State serialization
export {
  playerToField,
  fieldToPlayer,
  winnerToField,
  boardToCircuitFormat,
  scoresToCircuitFormat,
  gameStateToHashInput,
  buildGameMoveInput,
  buildProveHandInput,
} from './state.js';

// Proof utilities
export {
  serializeProof,
  deserializeProof,
  createHandProof,
  createMoveProof,
  uint8ArrayToBase64,
  base64ToUint8Array,
} from './proof-utils.js';

// Proof service
export { ProofService, MockProofBackend } from './prover.js';
export type { ProofBackend } from './prover.js';

// Noir backend (lazy-loaded)
export { NoirProofBackend } from './noir-backend.js';

// Game session
export { GameSession } from './game-session.js';
