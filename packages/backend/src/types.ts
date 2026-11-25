/**
 * The relay's wire protocol (docs/plan/PRIVATE_GAMES.md §6, Phase B).
 *
 * The relay is a pipe. It pairs players, forwards sealed payloads between the
 * two members of a room, buffers them for whoever is offline, and times turns.
 * It holds no hand, board, score or result and reads no payload: the only game
 * fact it sees is how many MOVEs have gone through.
 */

// On-chain transaction status
export type TxStatus = 'idle' | 'sending' | 'mining' | 'confirmed' | 'failed';

export interface OnChainGameStatus {
  player1Tx: TxStatus;
  player2Tx: TxStatus;
  /** Both commits confirmed AND all nine moves relayed. */
  canSettle: boolean;
}

/** Player 1 moves at even move numbers, player 2 at odd. */
export type PlayerNumber = 1 | 2;

/**
 * Where a room stands, as far as a pipe can tell:
 *   waiting         matched, but nobody has moved and the game is not on-chain
 *                   yet (both commits are not confirmed), so no turn is running;
 *   active          the game is being played and the turn clock is running;
 *   moves-complete  all nine MOVEs have been relayed. How the game ended is not
 *                   something the relay can know.
 */
export type RoomStatus = 'waiting' | 'active' | 'moves-complete';

/** Everything the relay says about a room to anyone who asks (GET /games/{id}). */
export interface RoomInfo {
  id: string;
  status: RoomStatus;
  movesMade: number;
  player1Connected: boolean;
  player2Connected: boolean;
}

// Client -> Server messages
export type ClientMessage =
  // On-chain lifecycle messages. Deliberately no tx hash: a hash names the
  // transaction on-chain, and the relay must not be able to tie a room to it.
  | { type: 'TX_CONFIRMED'; gameId: string; txType: 'create_game' | 'join_game' }
  | { type: 'TX_FAILED'; gameId: string; txType: 'create_game' | 'join_game'; error: string }
  /** "I am done with this game" — releases only the sender's binding. */
  | { type: 'LEAVE_GAME'; gameId: string }
  /**
   * This player's ephemeral ECDH P-256 public key for the game (uncompressed,
   * base64). The two players derive the game key and the channel key from it
   * (docs/plan/PRIVATE_GAMES.md §5.1); the relay only forwards it.
   */
  | { type: 'KEY_EXCHANGE'; gameId: string; publicKey: string }
  /**
   * A sealed player-to-player payload (AES-256-GCM, base64). The relay forwards
   * it to the other player without reading it.
   */
  | { type: 'PEER'; gameId: string; iv: string; ciphertext: string }
  /**
   * One sealed move: the card, its slot, the cell and the move proof, all
   * inside the ciphertext. The relay reads `moveNumber` and nothing else. It
   * accepts move numbers strictly in order, 0..8, each from the player whose
   * turn it is, and forwards the move to the other player unread.
   */
  | { type: 'MOVE'; gameId: string; moveNumber: number; iv: string; ciphertext: string }
  // Matchmaking. Carries no hand: whatever else an older client attaches (it
  // used to send its five cards) is ignored, never stored.
  | { type: 'QUEUE_MATCHMAKING' }
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
  | { type: 'OPPONENT_DISCONNECTED'; gameId: string }
  | { type: 'OPPONENT_RECONNECTED'; gameId: string }
  // Present-but-idle abandonment warning. Broadcast to BOTH players once the
  // player whose turn it is (`idlePlayer`, by the relay's move count) has not
  // moved for long enough. Re-sent as the idle window grows; stops once a move
  // arrives or all nine are in. Buffered so an offline player receives the
  // latest warning on reconnect. It names no cards: recovering an abandoned
  // game needs nobody's hand.
  | { type: 'GAME_ABANDONMENT_WARNING'; gameId: string; idlePlayer: 'player1' | 'player2'; secondsIdle: number; secondsUntilClaimable: number }
  | { type: 'ERROR'; message: string }
  // On-chain lifecycle messages
  | { type: 'ON_CHAIN_STATUS'; gameId: string; status: OnChainGameStatus }
  // The opponent's KEY_EXCHANGE, forwarded (buffered while this player is offline).
  | { type: 'OPPONENT_KEY'; gameId: string; publicKey: string }
  // The opponent's sealed PEER payload, forwarded as received (buffered while
  // this player is offline).
  | { type: 'PEER'; gameId: string; iv: string; ciphertext: string }
  // The opponent's sealed MOVE, forwarded as received (buffered while this
  // player is offline).
  | { type: 'MOVE'; gameId: string; moveNumber: number; iv: string; ciphertext: string }
  /**
   * Where the room stands, sent after a RESUME has replayed the inbox: the
   * client rebuilds its board from its own transcript plus the replayed moves,
   * and `movesMade` says how many there should be.
   */
  | { type: 'ROOM_STATE'; gameId: string; playerNumber: PlayerNumber; movesMade: number; opponentConnected: boolean }
  // Matchmaking
  | { type: 'MATCHMAKING_QUEUED'; position: number }
  /**
   * A bot asked to queue while the waiting players are already covered by other
   * bots. Not an error — standing down is the correct outcome, and routing it
   * through ERROR would inflate the bot's failure counters.
   */
  | { type: 'QUEUE_DECLINED'; reason: 'already-covered' | 'nobody-waiting'; humansWaiting: number; botsQueued: number }
  | { type: 'MATCH_FOUND'; gameId: string; playerNumber: PlayerNumber }
  | { type: 'BOT_REGISTERED' }
  | { type: 'MATCHMAKING_CANCELLED' }
  | { type: 'PONG' }
  // Session management
  | { type: 'SESSION_ESTABLISHED'; sessionToken: string; playerId: string; resumed: boolean; gameId: string | null };
