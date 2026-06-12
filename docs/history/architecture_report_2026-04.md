 Aztec Triple Triad — Architectural Report

  1. Executive Summary

  Aztec Triple Triad is a privacy-preserving blockchain card game built on the Aztec Network. It
  implements the Triple Triad card game (from Final Fantasy VIII) where two players each commit 5 cards
   from a collection of 256, play a 3x3 board game with capture mechanics, and settle the result
  on-chain — with the winner taking one of the loser's cards as an NFT.

  The core architectural insight is a minimal on-chain footprint: only 2 Aztec transactions occur per
  game (create + settle), while the entire 9-move game plays out off-chain with zero-knowledge proofs
  exchanged peer-to-peer via a WebSocket relay. This gives the system the privacy guarantees of Aztec's
   private execution model while avoiding the latency and cost of 9 individual on-chain moves.

  Scale: ~31,700 lines across 149 source files (TypeScript + Noir), organized as an npm workspace
  monorepo with 5 packages plus a standalone circuits workspace.

  ---
  2. System Architecture

  ┌──────────────────────────────────────────────────────────────┐
  │                        BROWSER (per player)                   │
  │                                                               │
  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
  │  │ React UI    │  │ noir_js WASM │  │ Aztec EmbeddedWallet │ │
  │  │ (R3F + 2D)  │  │ (Barretenberg│  │ (PXE, account keys,  │ │
  │  │             │  │  UltraHonk)  │  │  contract instances)  │ │
  │  └──────┬──────┘  └──────┬───────┘  └──────────┬───────────┘ │
  │         │                │                      │             │
  │         └────────┬───────┴──────────────────────┘             │
  │                  │                                            │
  │          ┌───────▼────────┐                                   │
  │          │   useGame.ts   │  (1,664 lines — orchestration hub)│
  │          └───────┬────────┘                                   │
  └──────────────────┼────────────────────────────────────────────┘
                     │ WebSocket
            ┌────────▼─────────┐
            │  Backend Server   │  (ws, Node.js, in-memory state)
            │  GameManager      │  Validates moves, relays proofs
            └────────┬─────────┘
                     │ JSON-RPC
            ┌────────▼──────────────────────────────────┐
            │           Aztec Network                    │
            │  ┌────────────┐ ┌───────────┐ ┌─────────┐ │
            │  │TripleTriad │ │TripleTriad│ │  Arena  │ │
            │  │    NFT     │ │   Game    │ │  Token  │ │
            │  │ (1,263 loc)│ │ (910 loc) │ │ (84 loc)│ │
            │  └────────────┘ └───────────┘ └─────────┘ │
            └───────────────────────────────────────────┘

  Layer Breakdown

  ┌───────────┬─────────────────────┬─────────┬───────────────────────────────────────────────────┐
  │   Layer   │     Technology      │   LOC   │                  Responsibility                   │
  ├───────────┼─────────────────────┼─────────┼───────────────────────────────────────────────────┤
  │ Game      │ Pure TypeScript     │ ~1,200  │ Rules engine, capture mechanics, scoring          │
  │ Logic     │                     │         │                                                   │
  ├───────────┼─────────────────────┼─────────┼───────────────────────────────────────────────────┤
  │ Backend   │ Node.js + ws        │ ~1,100  │ WebSocket relay, matchmaking, move validation     │
  ├───────────┼─────────────────────┼─────────┼───────────────────────────────────────────────────┤
  │ Frontend  │ React 18 + R3F +    │ ~12,000 │ UI, wallet management, proof orchestration        │
  │           │ Vite                │         │                                                   │
  ├───────────┼─────────────────────┼─────────┼───────────────────────────────────────────────────┤
  │ Contracts │ Noir (Aztec)        │ ~2,260  │ On-chain game lifecycle, NFT ownership,           │
  │           │                     │         │ settlement                                        │
  ├───────────┼─────────────────────┼─────────┼───────────────────────────────────────────────────┤
  │ Circuits  │ Noir (standalone)   │ ~1,740  │ Off-chain ZK proofs for hand ownership + move     │
  │           │                     │         │ validity                                          │
  └───────────┴─────────────────────┴─────────┴───────────────────────────────────────────────────┘

  ---
  3. The Privacy Model

  The system's core value proposition is private gameplay with public settlement. Here's how privacy is
   layered:

  What's private

  - Card ownership: Cards are UTXO-style FieldNotes in a PrivateSet. Nobody can see what cards you own.
  - Hand selection: When committing to a game, 5 card notes are nullified and replaced with a Poseidon2
   commitment hash. The opponent cannot see which cards you chose.
  - Game moves: All 9 moves happen off-chain. The WebSocket relay sees game state, but the on-chain
  record contains only commitments and proofs.
  - Settlement randomness: Each player commits to 6 randomness values (as a Poseidon2 hash) at game
  creation. These constrain how notes are re-created during settlement, preventing the winner from
  manipulating note randomness.

  What's public

  - Game existence: The Game contract stores game status, player addresses, and commitment hashes in
  public state.
  - Game outcome: Settlement emits a GameSettled event with winner, loser, and transferred card ID.
  - Card existence: A public nft_exists map tracks which token IDs have been minted.

  Cryptographic chain

  nhk_app_secret + nonce_value
      │
      ├─→ game_id         = Poseidon2([secret, nonce, GAME_ID_IV])
      ├─→ blinding_factor  = Poseidon2([secret, contract_addr, game_id])
      ├─→ card_commit      = Poseidon2([card_ids[0..5], blinding_factor])
      ├─→ randomness[0..6] = Poseidon2([secret, nonce, RANDOMNESS_IV + i])
      └─→ player_state     = Poseidon2([randomness[0..6]])

  All derivations are deterministic from the Aztec app secret and a monotonic nonce. This means the
  contract can verify consistency without the player revealing their secret.

  ---
  4. Game Lifecycle in Detail

  Phase 1: Game Creation (1 Aztec tx)

  1. Player 1 selects 5 cards in the UI (CardSelector)
  2. useGame.handlePlay() → WebSocket QUEUE_MATCHMAKING
  3. Server matches two players → MATCH_FOUND
  4. P1's useGame effect fires createGameOnChain() via txManager:
    - Calls TripleTriadGame.create_game(card_ids) (private function)
    - Game contract calls TripleTriadNFT.commit_five_nfts_create() (cross-contract)
    - NFT contract: pops 5 card notes, derives game_id + randomness + blinding + commitment in-circuit
    - Returns [card_commit, player_state, game_id] to Game contract
    - Game contract stores these in public state, emits GameCreated
  5. P1 shares {accountAddress, onChainGameId, randomness[6]} with P2 via WebSocket
  6. P2 calls join_game(game_id, card_ids) — same flow but game_id is provided, not derived

  Key insight: The game_id is derived deterministically inside the NFT contract from the player's app
  secret. This avoids a round-trip where the frontend would need to pre-compute and pass it. The
  contract is the source of truth.

  Phase 2: Off-chain Gameplay (0 Aztec txs)

  7. Both players generate prove_hand proofs (Barretenberg UltraHonk in-browser WASM)
    - Proves: "I know 5 card IDs and a blinding factor that hash to my public commitment"
    - Also binds opponent's player_state_hash (constraining their settlement randomness)
  8. Hand proofs exchanged via WebSocket (SUBMIT_HAND_PROOF → HAND_PROOF)
  9. Players take turns placing cards. Each PLACE_CARD:
    - Server validates the move via @axolotl-arena/game-logic
    - Server broadcasts updated GAME_STATE to both players
    - Frontend generates a game_move proof for the placement:
        - Proves: valid card from committed hand, correct captures, consistent board state hashing
    - Move proof sent to opponent via WebSocket (SUBMIT_MOVE_PROOF → MOVE_PROVEN)
  10. After 9 moves, server sends GAME_OVER with winner determination

  Proof chaining: Each move proof's end_state_hash must equal the next move's start_state_hash, forming
   a verifiable chain from empty board to final state.

  Phase 3: Settlement (1 Aztec tx)

  11. Winner calls handleSettle(selectedCardId):
    - Collects all 11 proofs (2 hand + 9 move)
    - Calls TripleTriadGame.process_game() (private function)
    - Contract verifies all 11 proofs against stored VK hashes
    - Validates proof chaining, card commit consistency, and randomness preimages
    - Calls NFT contract to re-mint cards: winner gets 6 (original 5 + 1 taken), loser gets 4
    - Both players get 20 Arena Tokens
    - Emits GameSettled
  12. Note discovery: Both players import their new card notes into PXE via noteImporter

  Abandoned Game Flow

  If a player disappears mid-game, the other can:
  1. Call claim_abandoned_game() with partial proofs (N real move proofs + 9-N dummy proofs)
  2. Contract verifies it's the opponent's turn (proving they abandoned)
  3. A 5-block (~1 minute) dispute window opens
  4. After the window, claimant calls settle_abandoned_game() to reclaim cards + optionally take one
  from the abandoner

  ---
  5. Component Analysis

  5.1 Game Logic (packages/game-logic)

  Pure TypeScript with zero dependencies. Implements:
  - 3x3 board with card placement and ownership tracking
  - 4-directional capture: compare attacker's rank vs defender's opposing rank
  - Chain capture: newly captured cards trigger further capture checks (BFS)
  - Score calculation: cards on board + cards remaining in hand
  - Win condition: board full → highest score wins

  This is the single source of truth for game rules, shared between backend (server-side validation)
  and the Noir circuits (which re-implement the same logic in constraints). This duplication is a
  necessary architectural cost — the circuits must be self-contained.

  5.2 Backend (packages/backend)

  A lightweight WebSocket relay with two responsibilities:

  1. Game state management: GameManager maintains an in-memory Map<string, GameRoom> of active games.
  It validates moves using the game-logic package, manages turn alternation, and tracks a move nonce
  for replay protection.
  2. Message relay: The server is a dumb pipe for proof exchange, Aztec info sharing, and settlement
  coordination. It doesn't understand proofs — it just forwards them.

  Design choice: No database, no persistence. Games exist only in memory. A server restart loses all
  active games. This is acceptable for the current stage but would need addressing for production.

  Matchmaking: Simple FIFO queue. Two players in the queue get auto-matched and a game is created.
  Queue entries expire after 30 seconds without a ping.

  5.3 Frontend (packages/frontend)

  The largest and most complex layer. Key modules:

  useGame.ts (1,664 lines) — The orchestration hub. This single hook manages:
  - Screen routing (main-menu → card-selector → finding-opponent → game)
  - On-chain transaction lifecycle (create, join, settle) via txManager
  - Proof generation triggers and collection
  - Settlement info accumulation (own + opponent randomness)
  - Abandoned game claiming

  This is the most architecturally significant file. It merges what were previously separate hooks
  (useGameOrchestrator + useGameSession) into one. The consolidation reduces prop-drilling but creates
  a 1,664-line hook with many useRefs and useEffects tracking interleaved async state machines.

  connectToAztec.ts (394 lines) — Two-phase wallet initialization:
  1. prepareConnection(): Generate keys, compute address (no deployment, no network call)
  2. deployAndRegister(): Deploy account, register contracts, mint starter cards

  This split allows the UI to show the account address for funding before the deployment transaction
  fires.

  proofWorker.ts (344 lines) — In-browser proof generation using noir_js + Barretenberg WASM. Proofs
  are generated sequentially (promise queue) because the WASM backend can't handle concurrent proof
  generation.

  txManager.ts (271 lines) — A priority-ordered PXE transaction queue. Game lifecycle transactions
  (create, join) take priority over settlement. Provides a useSyncExternalStore-based React hook for
  live status updates.

  3D rendering: React Three Fiber v8 with a swamp-themed environment. FBX models loaded at runtime,
  board cells rendered as 3D crates with card meshes on top. Post-processing (bloom, vignette). The 3D
  layer is a drop-in replacement for a 2D alternative — both implement the same props interface.

  5.4 Contracts (packages/contracts)

  Three Aztec contracts forming a tight dependency graph:

  TripleTriadGame ──calls──→ TripleTriadNFT ──calls──→ ArenaToken
         │                                                  ▲
         └──────────────────calls───────────────────────────┘

  TripleTriadNFT (1,263 lines) — The most complex contract. Responsibilities:
  - Card ownership via private UTXO notes (FieldNote in PrivateSet)
  - Hand commitment with in-circuit derivation of game_id, randomness, and blinding factor
  - Card generation with deterministic PRNG (seeded from app secret + nonce)
  - Note tagging for PXE discovery (custom deterministic tags via CardCreated events)
  - Card re-minting during settlement with explicit randomness
  - Card escrow (prepare/reclaim) for game preparation
  - Starter card minting and card pack purchases

  TripleTriadGame (910 lines) — Game lifecycle management:
  - create_game / join_game: Store commitments, emit events
  - process_game: Verify 11 proofs, validate chaining, settle cards + tokens
  - claim_abandoned_game / settle_abandoned_game: Handle player desertion
  - All proof verification via bb_proof_verification::verify_honk_proof

  ArenaToken (84 lines) — Simple private fungible token. Minted as reward (20 per game), burned for
  card pack purchases (100 per pack). Uses Aztec's BalanceSet for UTXO-model balances.

  5.5 Circuits (circuits/)

  prove_hand (193 lines) — Proves hand ownership:
  - Public: card_commit_hash, opponent_player_state_hash
  - Private: 5 card IDs, blinding factor, opponent's 6 randomness values
  - Validates: IDs in range [1,256], unique, commitment matches, opponent state preimage valid

  game_move (1,283 lines) — Proves move validity with chain capture:
  - Public: both card commits, start/end state hashes, game_ended, winner_id
  - Private: current player, card placement, full board before/after, scores, hand + blinding
  - Validates: correct turn, valid position, card in hand, all captures computed correctly, state
  hashes match, score consistency, game-end detection
  - Chain capture: up to 8 BFS passes with hardcoded adjacency table

  dummy_move (13 lines) — Empty circuit with same public interface as game_move. Used as padding in
  abandoned game proofs.

  ---
  6. Data Flow and State Management

  State distribution

  ┌───────────────────────────┬──────────────────────────────────────────┬────────────────────────┐
  │           State           │                 Location                 │      Persistence       │
  ├───────────────────────────┼──────────────────────────────────────────┼────────────────────────┤
  │ Card ownership            │ PXE (private notes) + localStorage       │ Survives refresh       │
  ├───────────────────────────┼──────────────────────────────────────────┼────────────────────────┤
  │ Account keys              │ localStorage                             │ Survives refresh       │
  ├───────────────────────────┼──────────────────────────────────────────┼────────────────────────┤
  │ Game state (moves, board) │ Backend in-memory + frontend React state │ Lost on server restart │
  ├───────────────────────────┼──────────────────────────────────────────┼────────────────────────┤
  │ Proofs (hand + move)      │ Frontend React refs                      │ Lost on refresh        │
  ├───────────────────────────┼──────────────────────────────────────────┼────────────────────────┤
  │ Game commitments          │ Aztec public state                       │ Permanent (on-chain)   │
  ├───────────────────────────┼──────────────────────────────────────────┼────────────────────────┤
  │ Settlement outcome        │ Aztec public state + events              │ Permanent (on-chain)   │
  ├───────────────────────────┼──────────────────────────────────────────┼────────────────────────┤
  │ Matchmaking queue         │ Backend in-memory                        │ Lost on server restart │
  └───────────────────────────┴──────────────────────────────────────────┴────────────────────────┘

  The "ref problem"

  Critical game data (settlement info, on-chain phase, proof collections) is stored in useRefs inside
  useGame.ts rather than React state. This is intentional — these values need to survive React
  re-renders and screen transitions without triggering cascading re-renders. But it means:
  - The data is invisible to React DevTools
  - It can't be persisted across page refreshes
  - It creates implicit coupling between effects that read/write the same refs

  localStorage as a persistence layer

  The frontend uses localStorage extensively:
  - Account secret, salt, signing key
  - Owned card IDs with note metadata (randomness, txHash, noteHashes)
  - Game state snapshots for recovery

  This is pragmatic for a dev/demo app but creates a single point of failure — clearing browser data
  loses the account.

  ---
  7. Strengths

  Minimal on-chain footprint

  Only 2 transactions per game (create + settle) is a strong design choice. The off-chain proof
  exchange pattern keeps latency low and costs minimal while preserving the security guarantees of ZK
  verification.

  Deterministic in-circuit derivation

  Game IDs, randomness, and blinding factors are all derived inside the circuit from the Aztec app
  secret. This eliminates an entire class of bugs where the frontend could pass inconsistent values.
  The contract is the single source of truth for these derivations.

  Proof chaining

  The move proof chain (where each proof's end state feeds the next proof's start state) creates a
  tamper-evident log of the entire game. Combined with the hand commitment binding in each move proof,
  this makes it cryptographically impossible to replay moves from a different hand or alter the game
  sequence.

  Clean separation of game logic

  The pure TypeScript game-logic package has zero dependencies and 90% test coverage thresholds. It
  serves as a readable specification of the rules that both the server and circuits must implement.

  Abandoned game handling

  The claim + dispute window pattern is well thought out. A player can prove they didn't abandon (by
  showing it was the opponent's turn), and the opponent has a window to contest. This handles the
  real-world problem of players ghosting mid-game.

  ---
  8. Weaknesses and Risks

  useGame.ts is a monolith

  At 1,664 lines, this hook orchestrates screen routing, on-chain transactions, proof generation,
  WebSocket coordination, and settlement — all in one function. It contains ~15 useRefs and ~10
  useEffects with complex dependency arrays. This is the most likely source of bugs and the hardest
  code to reason about. A state machine library (XState, or even a manual reducer) would make the
  transitions explicit rather than implicit in effect dependency interactions.

  Duplicated game logic across TypeScript and Noir

  The capture mechanics, score calculation, and board state management are implemented independently in
   TypeScript (game-logic package) and Noir (game_move circuit). Any rule change must be synchronized
  across both. There's no automated check that they agree — only the integration tests catch
  divergence, and those tests use MockProofBackend by default, which doesn't actually run the circuits.

  No backend persistence

  The WebSocket server stores all state in memory. A server crash mid-game loses the game state, all
  accumulated proofs, and the matchmaking queue. The players' on-chain commitments remain, but without
  the proofs, settlement is impossible. The cards are effectively locked until an abandoned game claim
  can be made.

  Single-server relay

  The backend is a single WebSocket server. There's no horizontal scaling, no message queue, no
  pub/sub. Two players must connect to the same server instance. This is fine for development but would
   need rearchitecting for production (e.g., Redis pub/sub for cross-instance message relay).

  Proof generation is slow and sequential

  In-browser UltraHonk proof generation runs in WASM, sequentially (one proof at a time). For a 9-move
  game, that's 11 proofs. If each takes several seconds, the settlement flow has a noticeable delay.
  The current architecture doesn't support Web Workers for parallel proving.

  Note discovery complexity

  The custom create_and_push_note function skips Aztec's automatic note tagging. This requires the
  frontend to manually import notes after every transaction that creates cards. The noteImporter module
   handles this, but it's fragile — if note import fails or is skipped, the player's PXE won't see
  their cards. The custom CardCreated event with deterministic tagging is a workaround for this, but it
   adds significant complexity to the NFT contract.

  Cross-contract msg_sender() gotcha

  When the Game contract calls the NFT contract, msg_sender() inside the NFT contract returns the Game
  contract's address, not the player's. This has already caused bugs (documented in memory as "Could
  not find all 5 cards"). The fix — passing owner: AztecAddress explicitly — works but requires
  vigilance in every cross-contract call.

  Version pinning fragility

  All Aztec SDK packages are pinned to 4.2.0-aztecnr-rc.2. The Noir stdlib has breaking changes between
   versions (e.g., Poseidon2 being private in certain versions). An upgrade would likely require
  changes across all three contracts, both circuits, and the frontend integration layer.

  ---
  9. Architecture Diagram: Settlement Data Flow

  This is the most complex flow in the system and worth diagramming separately:

    Player 1 (Winner)                    Player 2 (Loser)
         │                                    │
         │◄──── 2 hand proofs ────────────────┤
         │◄──── 9 move proofs ───────────────►│
         │                                    │
         │  WS: SHARE_AZTEC_INFO             │
         │◄──── opponentAddress ──────────────┤
         │◄──── opponentRandomness[6] ────────┤
         │                                    │
         ▼                                    │
    process_game(                             │
      11 proofs,                              │
      opponent address,                       │
      selected card to take,                  │
      both players' card IDs,                 │
      both players' randomness[6]             │
    )                                         │
         │                                    │
         ▼                                    │
    TripleTriadGame (private)                 │
      ├─ verify 11 proofs                     │
      ├─ validate chaining                    │
      ├─ check randomness preimages           │
      ├─ call NFT.mint_for_game_winner(6)     │
      ├─ call NFT.mint_for_game_loser(4) ─────┤
      ├─ call Token.mint(winner, 20)          │
      ├─ call Token.mint(loser, 20) ──────────┤
      └─ enqueue settle_game (public)         │
         │                                    │
         ▼                                    ▼
    Both players: import_note() for new card notes

  ---
  10. Summary
                                                                                                       
  This is an ambitious and largely well-executed architecture for a privacy-preserving on-chain game.
  The 2-transaction design with off-chain proof exchange is the right approach for this use case. The  
  contract layer is solid, with careful attention to in-circuit derivation and settlement constraints.
  The biggest architectural risks are in the frontend orchestration layer (useGame.ts) and the lack of 
  backend persistence. The proof generation pipeline works but would benefit from parallelization for a
   smoother user experience.