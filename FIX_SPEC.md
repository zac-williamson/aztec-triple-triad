# Fix Specification: Aztec Triple Triad

> This document describes every gap between the current implementation and the original CLAUDE.md spec.
> Each issue has a severity, affected files, and specific instructions for resolution.
> **No shortcuts. No stubs. Every fix must be real, tested, working code.**

---

## CRITICAL: Circuit Fixes

### FIX-1: game_move circuit does not verify placed card is in player's card_commit

**Severity:** CRITICAL — completely breaks the security model
**File:** `circuits/game_move/src/main.nr`
**Lines:** 47-49

**Current (broken):**
```noir
let _cc1 = card_commit_1;
let _cc2 = card_commit_2;
```
These lines just bind the public inputs to unused variables. They do NOT verify that the `card_id` being placed exists within the player's committed hand.

**Required fix:**
The circuit must prove that the placed card_id was part of the current player's original committed hand. This requires additional private inputs:
- `player_secret: Field` — the player's secret used in prove_hand
- `player_address: Field` — the player's address
- `game_id: Field`
- `player_card_ids: [Field; 5]` — all 5 card IDs in the player's hand
- `player_nullifier_secrets: [Field; 5]` — the 5 nullifier secrets

The circuit must then:
1. Recompute the card_commit using the same formula as prove_hand: `hash(player_secret, player_address, game_id, card_ids[5], nullifier_secrets[5])`
2. Assert the recomputed commit matches card_commit_1 (if current_player==1) or card_commit_2 (if current_player==2)
3. Assert that `card_id` exists within `player_card_ids` (i.e., there exists some index i where `player_card_ids[i] == card_id`)

**Tests to add:**
- Test that a valid card from the committed hand passes
- Test that a card NOT in the committed hand fails (should_fail)
- Test that using the wrong player_secret fails (should_fail)

### FIX-2: game_move circuit does not validate capture logic

**Severity:** CRITICAL — a player could claim arbitrary captures without proof
**File:** `circuits/game_move/src/main.nr`

**Current state:** The circuit verifies that the placed card appears in board_after and that scores are consistent with board ownership counts. But it does NOT verify that ownership changes in board_after (captures) are valid according to Triple Triad rank comparison rules.

**Required fix:**
After verifying the card placement, the circuit must check every adjacent cell:
- For each adjacent cell that contains an opponent's card in board_before:
  - Compare the placed card's touching rank against the adjacent card's touching rank
  - If placed card rank > adjacent card rank: the adjacent card MUST be flipped to current_player's ownership in board_after
  - If placed card rank <= adjacent card rank: the adjacent card MUST retain its original owner in board_after
- All non-adjacent cells must retain their original card_id and owner from board_before

This requires the circuit to also receive the ranks of adjacent opponent cards as private inputs, OR maintain a card rank lookup. Since the card database is fixed (50 cards with known ranks), the simplest approach is to add private inputs for adjacent card ranks and verify them against a commitment or lookup.

**Recommended approach:**
Add private inputs:
- `adjacent_card_ranks: [[Field; 4]; 4]` — ranks for cards at [top, right, bottom, left] positions (zeros if empty/own card)
- `adjacent_card_ids: [Field; 4]` — card IDs at adjacent positions (0 if empty)

Then verify:
1. For each adjacent position (top/right/bottom/left):
   - If the adjacent cell in board_before has an opponent card, verify the adjacent_card_id matches board_before
   - Compare ranks: placed card's facing rank vs adjacent card's facing rank
   - Verify board_after ownership matches the expected capture result
2. All non-placed, non-captured cells must be identical between board_before and board_after

**Tests to add:**
- Test a move that captures one adjacent card
- Test a move that captures multiple adjacent cards
- Test a move where no captures occur (adjacent ranks are higher)
- Test that claiming a false capture fails (should_fail)
- Test that failing to capture when ranks require it fails (should_fail)

### FIX-3: prove_hand circuit should include ECDH public key

**Severity:** HIGH — needed for encrypted card communication per spec
**File:** `circuits/prove_hand/src/main.nr`

**Current state:** The circuit commits to card IDs and nullifier secrets, but does not establish a Grumpkin ECDH key pair for encrypted communication.

**Required fix per spec:**
Each player generates a temporary Grumpkin key pair for the game session. The prove_hand circuit should:
1. Accept a `grumpkin_private_key: Field` as private input
2. Compute the corresponding public key: `grumpkin_public_key = grumpkin_private_key * G` (Grumpkin generator)
3. Include `grumpkin_public_key` as a public output (or part of the commitment)

This allows the opponent to compute a shared secret for encrypting card nullifiers:
`shared_secret = x_coordinate(my_private_key * opponent_public_key)`

**Note:** If Noir's standard library does not have Grumpkin curve operations readily available, document this in BLOCKERS.md and implement a simplified version or use a different approach for card encryption.

---

## CRITICAL: Contract Fixes

### FIX-4: process_game must verify ALL 9 move proofs with chaining

**Severity:** CRITICAL — currently only verifies the final move proof
**File:** `packages/contracts/triple_triad_game/src/main.nr`

**Current state:** The `process_game` function takes a single `final_move_proof` and verifies only that one proof. The spec requires verifying the complete game transcript.

**Required fix:**
`process_game` must:
1. Accept 9 move proofs (or a recursively aggregated proof of all 9 moves)
2. Verify each move proof using `verify_honk_proof(vk, proof, public_inputs, vk_hash)`
3. Validate proof chaining: for each consecutive pair of proofs, assert that `proof[i].end_state_hash == proof[i+1].start_state_hash`
4. Validate that all proofs share the same `card_commit_1` and `card_commit_2`
5. Validate that proof[0].start_state_hash matches the initial empty board state
6. Validate that the final proof's `game_ended == 1` and extract the winner

**Implementation approach:**
Given the constraint that each UltraHonkZKProof is 508 fields and each VK is 115 fields, verifying 9 proofs in a single Aztec private function may be too expensive. Two approaches:

**Option A (Preferred): Recursive aggregation circuit**
Create a new standalone circuit `aggregate_game` that:
- Takes all 9 game_move proofs as private inputs
- Verifies each one and validates chaining
- Outputs a single aggregated proof
- `process_game` then only needs to verify this one aggregated proof

**Option B: Direct verification**
If the Aztec private function can handle the constraint count, verify all 9 directly.

Document which approach is used and why in BLOCKERS.md if there are issues.

### FIX-5: process_game should verify prove_hand proofs

**Severity:** HIGH
**File:** `packages/contracts/triple_triad_game/src/main.nr`

**Current state:** The contract verifies hand proofs but should ensure they match the game's card_commits used in move proofs.

**Required fix:** Ensure the contract:
1. Accepts both players' prove_hand proofs
2. Verifies them with `verify_honk_proof`
3. Extracts card_commit from each hand proof's public inputs
4. Asserts these card_commits match the card_commit_1 and card_commit_2 in the move proofs

---

## CRITICAL: Frontend Integration (Phase 5)

### FIX-6: Add Aztec SDK to frontend

**Severity:** CRITICAL — Phase 5 is entirely unstarted
**File:** `packages/frontend/package.json` and new files

**Current state:** Zero Aztec integration. Frontend only uses WebSocket for game communication. No wallet, no proof generation, no contract interaction, no @aztec/* dependencies.

**Required implementation:**

1. **Add Aztec SDK dependencies** to frontend package.json:
   ```
   @aztec/aztec.js, @aztec/accounts, @aztec/test-wallet, @aztec/stdlib,
   @aztec/constants, @aztec/noir-contracts.js, @aztec/wallet-sdk
   ```

2. **Create `useAztec` hook** (`packages/frontend/src/hooks/useAztec.ts`):
   - Connect to Aztec node via `createAztecNodeClient`
   - Create embedded PXE wallet via `TestWallet.create(node)`
   - Store account secrets in localStorage for persistence
   - Expose: wallet, account address, connection status, contract instances

3. **Create `useProofGeneration` hook** (`packages/frontend/src/hooks/useProofGeneration.ts`):
   - Load compiled circuit artifacts (prove_hand, game_move)
   - Generate prove_hand proof when game starts
   - Generate game_move proof for each turn
   - Queue proofs for background processing (don't block UI)

4. **Create `useGameContract` hook** (`packages/frontend/src/hooks/useGameContract.ts`):
   - Interact with TripleTriadGame and TripleTriadNFT contracts
   - Call `process_game` when game ends (winner only)
   - Query NFT ownership
   - Handle sponsored fee payment via `SponsoredFeePaymentMethod`

5. **Update Vite/webpack config** for Aztec compatibility:
   - Polyfill Node.js builtins (buffer, process, stream, assert, util)
   - Enable `asyncWebAssembly` for WASM
   - Set CORS headers for SharedArrayBuffer
   - Handle `node:*` import aliases

6. **Update game flow in App.tsx/GameScreen.tsx**:
   - On game join: generate prove_hand proof, send via WebSocket
   - On each move: generate game_move proof, send proof + move via WebSocket
   - On game end: if winner, collect all proofs, call process_game on-chain
   - Show transaction progress (proof generation status, tx confirmation)

7. **Add wallet connection UI**:
   - Connection status indicator
   - Account address display
   - NFT card inventory view

**Note:** If Aztec devnet is unreachable or SDK has compatibility issues, document in BLOCKERS.md but still implement the integration code with proper error handling and fallback to WebSocket-only mode.

### FIX-7: Configure bundler for Aztec SDK

**Severity:** CRITICAL — Aztec SDK will not work in browser without this
**File:** `packages/frontend/vite.config.ts` (or switch to webpack)

The Aztec SDK requires specific bundler configuration for browser usage. The current Vite setup likely needs significant changes or a switch to webpack (which the reference aztec-chess-app uses).

**Required configuration** (see CLAUDE.md "Webpack Configuration" section):
- Node.js polyfills
- WASM support
- CORS headers for SharedArrayBuffer
- ESM compatibility for Aztec packages

---

## HIGH: Card Art Generation

### FIX-8: Run card art generation script

**Severity:** HIGH — no card images exist, only gradient placeholders
**File:** `scripts/generate-card-art.ts`, output to `packages/frontend/public/cards/`

**Current state:** The script exists (222 lines, uses DALL-E API) but has never been executed. The `packages/frontend/public/cards/` directory contains only `.gitkeep`.

**Required fix:**
1. Run `npx tsx scripts/generate-card-art.ts` to generate card art for all 50 cards
2. The script reads the API key from `~/OPEN_API_KEY.txt` (on EC2)
3. Verify images are saved to `packages/frontend/public/cards/`
4. Update frontend card rendering to use generated images instead of gradient placeholders
5. Commit the generated images

**If the OpenAI API key is not available or API calls fail:**
- Document in BLOCKERS.md: "Card art generation failed: [reason]"
- Still ensure the frontend code is wired up to load images from the correct paths
- Consider generating placeholder images programmatically (canvas-drawn cards with ranks visible)

---

## MEDIUM: Additional Fixes

### FIX-9: Add card rank data to game_move circuit

**Severity:** MEDIUM — needed for capture validation (FIX-2)
**File:** `circuits/game_move/src/main.nr`

The circuit currently takes `card_ranks` as private input for the placed card, but has no way to verify these ranks are correct for the given `card_id`. A malicious prover could claim any ranks.

**Options:**
A. Include a committed card database hash and verify card_id -> ranks mapping
B. The card ranks are implicitly trusted because the card_id is verified against the card_commit (which was established in prove_hand). Since prove_hand doesn't commit to ranks, this needs a different approach.
C. Include card ranks in the prove_hand commitment (expand the hash to include ranks for each card)

**Recommended:** Option C — expand prove_hand's commitment to include card ranks. This means the circuit knows the correct ranks for each committed card.

### FIX-10: Circuit test coverage for edge cases

**Severity:** MEDIUM
**Files:** `circuits/game_move/src/main.nr`, `circuits/prove_hand/src/main.nr`

Add tests for:
- Capture scenarios in game_move (after FIX-2 is implemented)
- Card commitment verification (after FIX-1 is implemented)
- Edge cases: placing last card, all cards captured, etc.

### FIX-11: Frontend visual polish

**Severity:** LOW (but mentioned in spec)
**Files:** `packages/frontend/src/`

The spec says: "This should be a HIGH QUALITY game, not a tech demo." Verify:
- Card flip animations for captures
- Drag-and-drop card placement
- Aztec brand aesthetics (dark theme, geometric patterns)
- Card detail hover
- Responsive design
- Transaction progress indicators for blockchain operations

---

## Blocker Tracking

**The agent MUST create and maintain `BLOCKERS.md` in the repo root.** Every time the agent encounters an issue it cannot resolve, it must log it:

```markdown
# Blockers & Issues Log

## [Date] - [Issue Title]
**Status:** OPEN | RESOLVED | WORKAROUND
**Severity:** CRITICAL | HIGH | MEDIUM
**Description:** What happened
**Attempted solutions:** What was tried
**Resolution/Workaround:** How it was resolved or worked around
```

Examples of things to log:
- Aztec SDK version incompatibilities
- Noir compilation errors that require API changes
- OpenAI API key issues
- Network connectivity problems
- Grumpkin curve operations not available in Noir stdlib
- Circuit constraint count too high for Aztec private function

---

## Verification Criteria

Each fix must meet these criteria before being considered complete:

| Fix | Verification |
|-----|-------------|
| FIX-1 | `nargo test` passes in game_move; new tests verify card-commit binding |
| FIX-2 | `nargo test` passes with capture validation tests |
| FIX-3 | `nargo test` passes in prove_hand with ECDH key |
| FIX-4 | `aztec compile` succeeds for game contract; process_game verifies 9 proofs |
| FIX-5 | `aztec compile` succeeds; hand proof verification tests pass |
| FIX-6 | Frontend imports Aztec SDK; useAztec hook connects to node |
| FIX-7 | `npm run build` succeeds with Aztec SDK in frontend |
| FIX-8 | Card images exist in public/cards/ OR BLOCKERS.md documents why not |
| FIX-9 | Card ranks verified in circuit against commitment |
| FIX-10 | All circuit tests pass including new edge cases |
| FIX-11 | Frontend renders with proper styling and animations |

---

## Priority Order

1. **FIX-1** (card_commit verification) — most critical circuit bug
2. **FIX-2** (capture logic validation) — second most critical circuit bug
3. **FIX-9** (card rank data) — dependency of FIX-2
4. **FIX-4** (9-proof verification) — critical contract fix
5. **FIX-5** (hand proof verification) — contract completeness
6. **FIX-3** (ECDH keys) — needed for full spec compliance
7. **FIX-8** (card art) — run the script
8. **FIX-6** (Aztec SDK frontend) — Phase 5 integration
9. **FIX-7** (bundler config) — Phase 5 dependency
10. **FIX-10** (test coverage) — quality assurance
11. **FIX-11** (visual polish) — final quality pass
