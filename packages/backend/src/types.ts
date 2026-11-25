import type { GameState, Card } from '@axolotl-arena/game-logic';

// Serialized proof for transport
export interface SerializedProof {
  proof: string;       // base64
  publicInputs: string[];
}

// Move proof metadata
export interface MoveProofData extends SerializedProof {
  cardCommit1: string;
  cardCommit2: string;
  startStateHash: string;
  endStateHash: string;
  gameEnded: boolean;
  winnerId: number;
}

// On-chain transaction status
export type TxStatus = 'idle' | 'sending' | 'mining' | 'confirmed' | 'failed';

export interface OnChainGameStatus {
  player1Tx: TxStatus;
  player2Tx: TxStatus;
  canSettle: boolean;
}

// Client -> Server messages
export type ClientMessage =
  | { type: 'CREATE_GAME'; cardIds: number[] }
  | { type: 'JOIN_GAME'; gameId: string; cardIds: number[] }
  | { type: 'PLACE_CARD'; gameId: string; handIndex: number; row: number; col: number; moveNumber: number }
  | { type: 'LIST_GAMES' }
  | { type: 'GET_GAME'; gameId: string }
  // Proof-based messages
  | { type: 'SUBMIT_MOVE_PROOF'; gameId: string; handIndex: number; row: number; col: number; moveNumber: number; moveProof: MoveProofData }
  // On-chain lifecycle messages. Deliberately no tx hash: a hash names the
  // transaction on-chain, and the relay must not be able to tie a room to it.
  | { type: 'TX_CONFIRMED'; gameId: string; txType: 'create_game' | 'join_game' }
  | { type: 'TX_FAILED'; gameId: string; txType: 'create_game' | 'join_game'; error: string }
  | { type: 'CANCEL_GAME'; gameId: string }
  /** "I am done with this game" — releases only the sender's binding. */
  | { type: 'LEAVE_GAME'; gameId: string }
  /**
   * This player's ephemeral ECDH P-256 public key for the game (uncompressed,
   * base64). The two players derive the game key and the PEER channel key from
   * it (docs/plan/PRIVATE_GAMES.md §5.1); the relay only forwards it.
   */
  | { type: 'KEY_EXCHANGE'; gameId: string; publicKey: string }
  /**
   * A sealed player-to-player payload (AES-256-GCM, base64). The relay forwards
   * it to the other player without reading it.
   */
  | { type: 'PEER'; gameId: string; iv: string; ciphertext: string }
  // Sent by the claimant after settle_abandoned_game is mined on-chain.
  // The server marks the room finished (winner = sender) and unbinds both
  // players; it cannot verify the claim (Aztec-free relay) — the chain is
  // the source of truth for cards and rewards.
  | { type: 'ABANDONED_GAME_SETTLED'; gameId: string }
  // Matchmaking
  | { type: 'QUEUE_MATCHMAKING'; cardIds: number[] }
  /**
   * Identify this session as the arena bot. Token-gated (ARENA_BOT_TOKEN) so a
   * normal client cannot claim to be the bot and thereby suppress its own
   * "you are playing a bot" disclosure.
   */
  | { type: 'REGISTER_BOT'; token: string }
  | { type: 'CANCEL_MATCHMAKING' }
  | { type: 'PING' }
  // Session resumption
  | { type: 'RESUME'; sessionToken: string };

// Server -> Client messages
export type ServerMessage =
  | { type: 'GAME_CREATED'; gameId: string; playerNumber: 1 }
  | { type: 'GAME_JOINED'; gameId: string; playerNumber: 2; gameState: GameState }
  | { type: 'GAME_START'; gameId: string; gameState: GameState }
  | { type: 'GAME_STATE'; gameId: string; gameState: GameState; captures: { row: number; col: number }[] }
  // `gameState` is the recipient's own view: the opponent's unplayed cards stay
  // hidden after the game too. No card ids — nothing at settlement needs them.
  | { type: 'GAME_OVER'; gameId: string; gameState: GameState; winner: 'player1' | 'player2' | 'draw' }
  | { type: 'GAME_LIST'; games: GameListEntry[] }
  | { type: 'GAME_INFO'; game: GameListEntry | null }
  | { type: 'OPPONENT_DISCONNECTED'; gameId: string }
  // Present-but-idle abandonment warning. Broadcast to BOTH players once the
  // player whose turn it is (`idlePlayer`) has not moved for >= 60s while the
  // game is still 'playing'. Re-sent as the idle window grows; cleared (no
  // further sends) once a move arrives or the game ends. Buffered so an
  // offline player receives the latest warning on reconnect. It names no cards:
  // recovering an abandoned game needs nobody's hand.
  | { type: 'GAME_ABANDONMENT_WARNING'; gameId: string; idlePlayer: 'player1' | 'player2'; secondsIdle: number; secondsUntilClaimable: number }
  | { type: 'ERROR'; message: string }
  // Proof-based messages
  | { type: 'MOVE_PROVEN'; gameId: string; gameState: GameState; captures: { row: number; col: number }[]; moveProof: MoveProofData; handIndex: number; row: number; col: number }
  // On-chain lifecycle messages
  | { type: 'ON_CHAIN_STATUS'; gameId: string; status: OnChainGameStatus }
  | { type: 'GAME_CANCELLED'; gameId: string; reason: string }
  // The opponent's KEY_EXCHANGE, forwarded (buffered while this player is offline).
  | { type: 'OPPONENT_KEY'; gameId: string; publicKey: string }
  // The opponent's sealed PEER payload, forwarded as received (buffered while
  // this player is offline).
  | { type: 'PEER'; gameId: string; iv: string; ciphertext: string }
  // Matchmaking
  | { type: 'MATCHMAKING_QUEUED'; position: number }
  /**
   * A bot asked to queue while the waiting players are already covered by other
   * bots. Not an error — standing down is the correct outcome, and routing it
   * through ERROR would inflate the bot's failure counters.
   */
  | { type: 'QUEUE_DECLINED'; reason: 'already-covered' | 'nobody-waiting'; humansWaiting: number; botsQueued: number }
  | { type: 'MATCH_FOUND'; gameId: string; playerNumber: 1 | 2; gameState: GameState }
  | { type: 'BOT_REGISTERED' }
  | { type: 'MATCHMAKING_CANCELLED' }
  | { type: 'PONG' }
  // Session management
  | { type: 'SESSION_ESTABLISHED'; sessionToken: string; playerId: string; resumed: boolean; gameId: string | null }
  | { type: 'OPPONENT_RECONNECTED'; gameId: string };

export interface GameListEntry {
  id: string;
  status: 'waiting' | 'playing' | 'finished';
  player1Connected: boolean;
  player2Connected: boolean;
  currentTurn?: 'player1' | 'player2';
  winner?: 'player1' | 'player2' | 'draw' | null;
}

export interface GameRoom {
  id: string;
  state: GameState;
  player1Id: string;
  player2Id: string | null;
  player1CardIds: number[];
  player2CardIds: number[];
  createdAt: number;
  lastActivity: number;
  /** Timestamp of the last PLACE_CARD move; drives idle-abandonment detection. */
  lastMoveTimestamp: number;
  expectedMoveNumber: number;
  processing: boolean;
  onChainStatus: OnChainGameStatus;
}
