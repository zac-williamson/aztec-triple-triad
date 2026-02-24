# Aztec Triple Triad - Autonomous Agent Instructions

## Orchestrator Protocol (READ EVERY SESSION)

You are managed by an orchestration loop (`orchestrate.sh`) that invokes you in bounded increments.

**Every session, you MUST:**
1. Read `PROGRESS.json` to understand your current phase, task, and milestone status
2. Work on the current phase's incomplete milestones
3. Update `PROGRESS.json` milestone statuses as you complete them (set `"status": "completed"`)
4. Commit and push after completing milestones
5. Follow TDD: write tests first, confirm they fail, implement, confirm they pass

**PROGRESS.json updates** — Use this pattern to mark milestones done:
```bash
# Example: mark Phase 1 milestone 0 as completed
jq '.phases["1"].milestones[0].status = "completed"' PROGRESS.json > tmp.json && mv tmp.json PROGRESS.json
```

**If you are stuck**, read `.claude/rules/stuck-recovery.md` for recovery strategies.

**Context preservation** — When context is compacted, these survive via CLAUDE.md and PROGRESS.json:
- Current phase and task
- Milestone completion status
- Project structure and conventions
- Aztec version: v4.0.0-devnet.2-patch.0

## Workflow Rules

- **TDD cycle**: Test first → run (confirm fail) → implement → run (confirm pass) → commit
- **Commit after milestones**: Each milestone = commit + push
- **Update PROGRESS.json**: Mark milestones as you go so the orchestrator tracks your progress
- **If blocked**: Write analysis to STUCK_ANALYSIS.md, try a different approach, don't loop on the same error

---

You are building a fully functional, visually appealing Triple Triad card game (from Final Fantasy VIII) that runs on the Aztec Network blockchain. This is a complex multi-week project. Build it incrementally, committing and pushing working code at each milestone.

**Repository**: git@github.com:zac-williamson/aztec-triple-triad.git
**Push regularly** - commit and push after completing each major milestone.
**Aztec version**: v4.0.0-devnet.2-patch.0

## Critical Resources

- OpenAI API key for card art generation: read from `~/OPEN_API_KEY.txt`
- Aztec brand assets: `./assets/` directory
- Reference project (fog-of-war chess on Aztec): https://github.com/zac-williamson/aztec-chess (contracts) and https://github.com/zac-williamson/aztec-chess-app (frontend/backend)
- Aztec developer docs: https://docs.aztec.network/developers/overview
- NFT standard: https://github.com/defi-wonderland/aztec-standards/blob/dev/src/nft_contract/README.md
- Recursive verification: https://docs.aztec.network/developers/docs/tutorials/contract_tutorials/recursive_verification
- Triple Triad rules: https://finalfantasy.fandom.com/wiki/Triple_Triad_(Final_Fantasy_VIII)#Physical_Triple_Triad
- Aztec media kit for visual design: https://aztec.network/media#media-kit

## Project Structure

```
aztec-triple-triad/
├── packages/
│   ├── game-logic/          # Pure TypeScript game rules (Step 1)
│   ├── backend/             # WebSocket server (Step 2)
│   ├── frontend/            # React/Next.js frontend (Step 3)
│   └── contracts/           # Aztec Noir smart contracts (Step 4)
│       ├── triple_triad_nft/
│       └── triple_triad_game/
├── circuits/                # Standalone Noir circuits for game move proofs
├── assets/                  # Aztec brand assets
├── CLAUDE.md
└── package.json             # Monorepo root
```

Use a monorepo with npm workspaces. Use TypeScript throughout for non-contract code. Use React (Next.js or Vite) for the frontend.

## Implementation Plan

### Phase 1: Game Logic (TypeScript) -- MILESTONE 1

Build `packages/game-logic/` with pure TypeScript implementing Triple Triad rules:

Triple Triad Rules Summary:
- 3x3 board, each player has 5 cards
- Each card has 4 ranks (top, bottom, left, right), values 1-10 (A=10)
- Players alternate placing one card per turn on an empty cell
- Capture: When placed card is adjacent to opponent's card, if the placed card's touching rank is HIGHER than the opponent card's touching rank, the opponent's card flips to the placer's color
- Win condition: Player controlling more cards (on board + remaining in hand) when board is full wins
- We use the "One" trade rule only: winner picks one card from the loser

Do NOT implement the advanced rules (Same, Plus, Combo, Elemental, Same Wall, Sudden Death, Random, Open). Keep it to basic capture rules only.

Card data structure:
```typescript
interface Card {
  id: number;
  name: string;
  ranks: { top: number; right: number; bottom: number; left: number }; // 1-10
  element?: string; // Not used in our simplified rules but keep for future
  imageUrl?: string;
}

interface BoardCell {
  card: Card | null;
  owner: 'player1' | 'player2' | null;
}

type Board = BoardCell[][]; // 3x3

interface GameState {
  board: Board;
  player1Hand: Card[];
  player2Hand: Card[];
  currentTurn: 'player1' | 'player2';
  player1Score: number;
  player2Score: number;
  status: 'waiting' | 'playing' | 'finished';
  winner: 'player1' | 'player2' | 'draw' | null;
}
```

Deliverables:
- Game state management (create game, place card, capture logic, scoring, win detection)
- Card database (define ~30-50 cards with different rank distributions)
- Unit tests with >90% coverage
- Export all types and functions for use by other packages

Commit and push when tests pass.

### Phase 2: Backend Server -- MILESTONE 2

Build `packages/backend/` with a WebSocket server:

- Use Node.js with `ws` or `socket.io` library
- Game lobby: create/join games
- Game rooms: two players per game
- Relay game moves between players via WebSocket
- Server validates moves using game-logic package
- Handle disconnections and game timeouts
- REST endpoints for game listing, status

Commit and push when server runs and handles basic game flow.

### Phase 3: Frontend -- MILESTONE 3

Build `packages/frontend/` with a polished, playable UI:

Visual Design:
- Use Aztec brand aesthetics (dark theme, geometric patterns)
- Reference Aztec media kit colors and style
- The game should look like a high-quality game, not a tech demo
- Generate card art using OpenAI API (DALL-E) -- read key from `~/OPEN_API_KEY.txt`
- Cards should have a consistent art style (fantasy/Final Fantasy inspired)
- Card layout: show ranks on each edge, card art in center, card name at bottom

Screens:
1. Lobby: Create/join games, see active games
2. Game: 3x3 board in center, player hands on each side, score display, turn indicator
3. Result: Winner announcement, card selection (winner picks one card from loser's board cards)

Game UX:
- Drag-and-drop or click-to-select-then-click-to-place for card placement
- Visual feedback for captures (card flip animation)
- Highlight valid placement positions
- Show card details on hover
- Responsive design

Connect to backend via WebSocket for multiplayer.

Commit and push when the game is playable in browser with two players.

### Phase 4: Aztec Smart Contracts -- MILESTONE 4

Build Noir contracts in `packages/contracts/` and standalone circuits in `circuits/`.

#### Aztec Technical Context

Key Aztec Concepts:
- Smart contracts written in Noir (ZK DSL)
- Client interaction via aztec.js (TypeScript)
- Private functions: execute client-side in PXE, produce ZK proofs, use UTXO/notes model
- Public functions: execute on AVM (like EVM), use key-value storage
- CRITICAL: Private functions can enqueue public calls, but public CANNOT call private
- Every account is a smart contract (account abstraction)
- Three key pairs per account: nullifier keys, incoming viewing keys, outgoing viewing keys

NFT Contract Pattern (from aztec-standards):
- `private_nfts`: `Map<AztecAddress, PrivateSet>` for private ownership via notes
- `public_owners`: `Map<Field, AztecAddress>` for public ownership
- `nft_exists`: `Map<Field, bool>` for existence tracking
- Key functions: `mint_to_private`, `transfer_private_to_private`, `burn_private`, etc.
- Authwit authorization with `_nonce` parameter for delegated execution

Recursive Proof Verification:
```noir
use bb_proof_verification::{UltraHonkVerificationKey, UltraHonkZKProof, verify_honk_proof};

verify_honk_proof(
    verification_key: UltraHonkVerificationKey,  // 115 field elements
    proof: UltraHonkZKProof,                     // 508 field elements
    public_inputs: [Field; N],
    vk_hash: Field
)
```
- Store VK hash (1 field) as `PublicImmutable<Field>`, prover supplies full VK at call time
- Verification happens in private functions (proof inside a proof)
- `PublicImmutable` is readable from private context; `PublicMutable` is NOT

#### Contract 1: TripleTriadNFT

Based on the aztec-standards NFT contract. Each card is an NFT with:
- `token_id`: unique card identifier
- Card data (ranks, name) stored in a mapping or derived from token_id
- Private ownership for hidden hand information
- Function to prove ownership of 5 cards without revealing which ones (for game start)
- Function to nullify an NFT and re-mint it to a new owner (for card transfer after game)

#### Contract 2: TripleTriadGame

Manages game state on-chain:
- `processGame` private function that:
  1. Takes a set of game move proofs
  2. Verifies all proofs using recursive verification
  3. Validates all proofs share the same `card_commit` values
  4. Validates proof chain (proof i+1 start state == proof i end state)
  5. Confirms the caller is the game winner
  6. Allows winner to select one of loser's board cards
  7. Calls TripleTriadNFT to transfer the card (nullify + re-mint)

#### Standalone Noir Circuits (in `circuits/`)

These are compiled to generate proofs client-side (NOT Aztec contract functions):

Circuit 1: `prove_hand`
- Public inputs: `card_commit` hash, player AztecAddress
- Private inputs: player's private key, 5 card token_ids, 5 card nullifier secrets
- Proves: player owns 5 NFTs from TripleTriadNFT
- Computes: `card_commit = hash(player_privatekey, card1, card2, card3, card4, card5, nullifier1, ..., nullifier5)`

Circuit 2: `game_move`
- Public inputs: both card_commits, starting board state, ending board state, game_ended flag, winner_id
- Private inputs: the card being placed, player's private key, opponent's public key
- Proves: valid game move (one card placed from correct player, board state correctly updated)
- Computes: AES-encrypted card nullifier using shared secret (ECDH on Grumpkin curve)
  - Shared secret = x-coordinate of (player_privatekey * opponent_pubkey)

#### Grumpkin Curve Keys
- Each player generates a temporary Grumpkin key pair for the game session
- These are used for ECDH shared secret computation
- The shared secret encrypts card nullifiers sent to the opponent

Commit and push when contracts compile and basic tests pass.

### Phase 5: Integration -- MILESTONE 5

Connect everything:
- Frontend generates Noir proofs for game moves (using circuits)
- Proofs are exchanged via WebSocket between players
- When game ends, winning player calls `processGame` with all move proofs
- Card transfer executes on-chain
- Update UI to show on-chain state, transaction progress

Game Flow (2 Aztec transactions total):
1. Start: Each player proves hand ownership (proof shared via WebSocket)
2. Play: Each turn generates a `game_move` proof, shared via WebSocket (NO on-chain tx)
3. End: Winner collects all proofs, calls `processGame` on-chain (1 Aztec tx)
   - This verifies the full game transcript and executes card transfer

Commit and push when full integration works.

## Development Guidelines

### Git Workflow
- Commit frequently with descriptive messages
- Push to `main` branch after each milestone
- Use conventional commit messages: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`

### Testing
- Write unit tests for game logic
- Write integration tests for backend
- Test contracts with Aztec sandbox

### Code Quality
- Use TypeScript strict mode
- Use ESLint and Prettier
- Keep functions small and focused
- Document complex algorithms

### Aztec Development Setup
- Install Aztec sandbox: follow https://docs.aztec.network/developers/getting_started
- Use version v4.0.0-devnet.2-patch.0 specifically
- The sandbox includes PXE, sequencer, and prover

### Environment Variables
Store in `.env` files (already in .gitignore):
```
OPENAI_API_KEY=<from OPEN_API_KEY.txt>
AZTEC_PXE_URL=http://localhost:8080
WS_PORT=3001
```

## Card Art Generation

Use the OpenAI API to generate card art. Create a script `scripts/generate-card-art.ts`:
- Read API key from `~/OPEN_API_KEY.txt`
- Generate unique art for each card
- Use consistent prompts for style cohesion (e.g., "Fantasy trading card art, dark mystical theme, Aztec-inspired borders, [card-specific description]")
- Save images to `packages/frontend/public/cards/`
- Generate a reasonable number of card images (at least 30)

## Deployment Notes (for later)
- Frontend: Vercel
- Backend: Fly.io
- Contracts: Deploy to Aztec devnet

## Priority Order
1. Get game logic working and tested first
2. Get multiplayer working (backend + frontend)
3. Make it look great (UI polish, card art)
4. Add blockchain (contracts + integration)
5. Polish and deploy

## Important Reminders
- This should be a HIGH QUALITY game, not a tech demo
- Visual polish matters -- use animations, good typography, consistent design language
- The Aztec brand uses dark backgrounds, geometric/angular design elements, and a sophisticated color palette
- Test everything as you go
- If Aztec tooling is problematic at a specific version, document the issue and work around it
- The reference aztec-chess project uses `mpclib` -- do NOT use that library. Our approach uses standalone Noir circuits + recursive verification instead

## Reference: Aztec Chess Contract Pattern

The aztec-chess reference project demonstrates key patterns for on-chain games:

Contract structure (`main.nr`):
- Uses `#[aztec]` macro on the contract module
- Storage struct with `PublicMutable` and `Map` state variables
- Private functions for game actions (create_game, make_move, join_game)
- Public `#[only_self]` functions for state updates (called via `self.enqueue_self`)
- `#[external("utility")] unconstrained` functions for client-side helpers
- Events (`#[event]` structs) for tracking game state changes client-side

Key pattern for private->public state updates:
```noir
#[external("private")]
fn do_action_private(/* private inputs */) {
    // Private computation, proof generation
    let result = compute_something();
    // Enqueue public state update
    self.enqueue_self.do_action_public(result);
}

#[external("public")]
#[only_self]
fn do_action_public(result: SomeType) {
    // Read/write public storage
    self.storage.some_state.write(result);
    self.emit(SomeEvent { data: result });
}
```

Frontend pattern (from aztec-chess-app):
- React app with custom hooks: `useAztec` (wallet/PXE connection), `useChessGame` (game logic), `useRelay` (WebSocket communication)
- Components: App, LobbyScreen, GameScreen, TxProgress
- WebSocket relay between players for move communication

## Reference: Aztec Chess App Architecture (IMPORTANT)

The aztec-chess-app is the closest reference for how to build this project's frontend and backend. Study it carefully.

### Aztec SDK Import Paths (for v4.0.0-devnet)
```typescript
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { Fr } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { TestWallet } from "@aztec/test-wallet/client/lazy";  // browser
import { TestWallet } from "@aztec/test-wallet/server";        // Node.js scripts
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { SPONSORED_FPC_SALT } from "@aztec/constants";
import { getContractInstanceFromInstantiationParams } from "@aztec/stdlib/contract";
import { SponsoredFPCContractArtifact } from "@aztec/noir-contracts.js/SponsoredFPC";
import { getDecodedPublicEvents } from "@aztec/aztec.js/events";
```

### Aztec SDK Packages (use versions matching v4.0.0-devnet.2-patch.0)
```
@aztec/accounts         - Account management (Schnorr accounts)
@aztec/aztec.js         - Core SDK (node client, fee payment, fields, addresses, events, wallet)
@aztec/constants        - Protocol constants (e.g., SPONSORED_FPC_SALT)
@aztec/entrypoints      - Entry point utilities
@aztec/noir-contracts.js - Pre-built contract artifacts (SponsoredFPC)
@aztec/pxe              - Private execution environment
@aztec/stdlib           - Standard library (keys, contract utilities)
@aztec/test-wallet      - Client-side embedded wallet (PXE)
@aztec/wallet-sdk       - Wallet SDK
```

### Webpack Configuration (CRITICAL for Aztec in browser)
When bundling Aztec SDK for the browser, you MUST:
- Polyfill Node.js builtins: `buffer`, `process`, `stream`, `assert`, `util`
- Alias `node:*` prefixed imports (crypto, fs, path, os set to `false`)
- Enable `experiments.asyncWebAssembly = true` for WASM (Aztec proofs)
- Set CORS headers for SharedArrayBuffer support:
  ```
  "Cross-Origin-Opener-Policy": "same-origin"
  "Cross-Origin-Embedder-Policy": "require-corp"
  ```
- Use `ts-loader` for TypeScript, `style-loader`/`css-loader` for CSS
- Set `fullySpecified: false` for `.mjs` modules (Aztec SDK ESM compatibility)

### Frontend Architecture Pattern
1. Hook-based architecture: Separate hooks for wallet (`useAztec`), game logic, relay (`useRelay`)
2. Embedded PXE wallet: Each browser tab runs its own PXE via `TestWallet.create(node)` -- no external wallet extension needed
3. LocalStorage for persistence: Account secrets, deployment status, saved games
4. Contract artifacts: Compiled Noir contract JSON artifacts + generated TypeScript wrappers
5. Config-driven: Network URLs, contract addresses, relay URLs all in JSON config files
6. Background proof processing: Queue proofs and process sequentially to avoid blocking UI
7. Dual communication: Real-time WebSocket relay for fast UX + on-chain event polling as fallback
8. Sponsored fees: Use `SponsoredFeePaymentMethod` with `SponsoredFPC` contract so players pay no gas

### Backend Relay Server Pattern
- Lightweight WebSocket server (only depends on `ws` package)
- Manages game rooms (player slots per game ID)
- Forwards messages between peers (MOVE, MOVE_PROVEN, MOVE_FAILED types)
- Deploy separately on Fly.io with Dockerfile
- Falls back to on-chain event polling if relay unavailable

### TypeScript Configuration for Aztec Projects
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"]
  }
}
```

### Nargo Workspace Pattern (for contracts)
Root `Nargo.toml`:
```toml
[workspace]
members = ["packages/contracts/triple_triad_nft", "packages/contracts/triple_triad_game"]
```

Each contract `Nargo.toml`:
```toml
[package]
name = "triple_triad_nft"
type = "contract"

[dependencies]
aztec = { git="https://github.com/AztecProtocol/aztec-nr", tag="<matching-aztec-version>", directory="aztec" }
```

### Node.js Requirement
- Minimum Node.js >= 22.0.0 for Aztec SDK compatibility
