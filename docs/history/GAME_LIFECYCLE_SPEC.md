# Game Lifecycle Specification

## Overview

This document specifies how Triple Triad games connect off-chain gameplay (WebSocket + ZK proofs) to on-chain state (Aztec contracts). The design bridges card commitments in Noir proofs to actual NFT ownership, adds `create_game` and `join_game` contract functions, and implements an async proof flow so gameplay can proceed while transactions are being mined.

---

## 1. `create_game` Contract Function

**Location:** `packages/contracts/triple_triad_game/src/main.nr`

### Signature

```noir
#[external("private")]
fn create_game(
    game_id: Field,
    card_ids: [Field; 5],
    card_ranks: [[Field; 4]; 5],
    player_secret: Field,
    nullifier_secrets: [Field; 5],
)
```

### Behavior

1. **Validate card ownership**: Player 1 calls this with their 5 NFT token IDs. Since cards are already in the player's private note set, the contract verifies ownership by popping and re-inserting notes from the NFT contract's private set (or, more practically, the player calls `prepare_for_game` on the NFT contract first to escrow their cards to public state, then `create_game` verifies public ownership).

2. **Compute card_commit**: The contract computes `card_commit_1 = pedersen_hash([player_secret, player_address, game_id, card_ids[5], card_ranks[5*4], nullifier_secrets[5]])` — this MUST exactly match the `compute_card_commit` function in `circuits/prove_hand/src/main.nr` (33 fields, Pedersen hash).

3. **Store game record**: Enqueue a public function to store:
   - `game_id` → `{ player1: AztecAddress, card_commit_1: Field, status: 'created' }`
   - The game is in "waiting for player 2" state.

4. **Lock cards**: Cards are locked via `prepare_for_game` on the NFT contract (called separately or integrated). The `card_game_lock` storage prevents transfer/reclaim until settlement.

5. **Emit event**: Emits `GameCreated { game_id, player1, card_commit_1 }`.

### Why Private?

The `create_game` function is private because:
- `player_secret` and `nullifier_secrets` must remain hidden
- Card ownership verification happens in private context
- The public enqueued function only stores the commitment (not the secrets)

---

## 2. `join_game` Contract Function

### Signature

```noir
#[external("private")]
fn join_game(
    game_id: Field,
    card_ids: [Field; 5],
    card_ranks: [[Field; 4]; 5],
    player_secret: Field,
    nullifier_secrets: [Field; 5],
)
```

### Behavior

1. **Verify game exists and is joinable**: Read the public game record. Assert `status == 'created'` and `player2` is not yet set.

2. **Validate card ownership**: Same as `create_game` — player must own the 5 NFTs.

3. **Compute card_commit_2**: Same hash as `create_game` but for Player 2's hand.

4. **Store player 2 data**: Enqueue public update:
   - Set `player2`, `card_commit_2`
   - Set `status = 'active'`

5. **Lock cards**: Player 2's cards are locked via `prepare_for_game`.

6. **Emit event**: Emits `GameJoined { game_id, player2, card_commit_2 }`.

---

## 3. Card Locking Mechanism

### Existing Pattern (Already Implemented)

The NFT contract already has:
- `prepare_for_game(card_ids, game_id)`: Moves 5 cards from private to public and locks them to a `game_id`
- `card_game_lock` storage: Maps `token_id → game_id` (0 = unlocked)
- `reclaim_card(token_id)`: Moves card back to private, asserts `card_game_lock == 0`
- `unlock_cards(token_ids, game_id)`: Game contract clears locks after settlement
- `game_transfer(from, to, token_id)`: Game contract transfers a card + clears lock

### Integration with create_game/join_game

The flow becomes:
1. Player calls `NFT.prepare_for_game(card_ids, game_id)` — escrows cards to public
2. Player calls `Game.create_game(game_id, ...)` or `Game.join_game(game_id, ...)` — registers commitment
3. Game plays out off-chain via WebSocket + ZK proofs
4. Winner calls `Game.process_game(...)` — verifies proof, transfers card, unlocks rest
5. Both players call `NFT.reclaim_card(token_id)` for remaining cards

### Unlock Scenarios

| Scenario | Who Unlocks | How |
|---|---|---|
| Game settled (win/lose) | Game contract | `settle_game` calls `unlock_cards` + `game_transfer` |
| Game settled (draw) | Game contract | `settle_game_draw` calls `unlock_cards` |
| Opponent never joins | Player 1 (cancel) | New `cancel_game` function clears lock after timeout |
| Transaction failure | No lock created | `prepare_for_game` tx failed, no escrow happened |

---

## 4. `process_game` Updates

### Current Behavior

`process_game` already:
- Verifies aggregate proof
- Checks VK hashes match stored values
- Validates winner is caller
- Transfers card and unlocks remaining cards

### New Verification

After proof verification, add assertions that:
- `aggregate_inputs[0]` (card_commit_1) matches the `card_commit_1` stored during `create_game`
- `aggregate_inputs[1]` (card_commit_2) matches the `card_commit_2` stored during `join_game`

This prevents a player from using a valid proof from a different game session or with different card commitments.

### Storage Addition

```noir
// Add to Storage struct:
game_player1: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
game_player2: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
game_card_commit_1: Map<Field, PublicMutable<Field, Context>, Context>,
game_card_commit_2: Map<Field, PublicMutable<Field, Context>, Context>,
game_status: Map<Field, PublicMutable<Field, Context>, Context>,
// Status: 0=none, 1=created, 2=active, 3=settled
```

---

## 5. Async Proof Flow

### Problem

`create_game` and `join_game` are Aztec transactions that take 10-60 seconds to mine. The game should NOT block waiting for these.

### Solution: Dual-Track Architecture

Track two independent async states:
1. **WebSocket game state** (immediate): For real-time gameplay
2. **On-chain game state** (delayed): For settlement

### Flow

```
Player 1:
  1. Click "Create Game"
  2. Frontend sends CREATE_GAME via WebSocket (instant — game room created)
  3. Frontend sends create_game tx to Aztec (async — mining)
  4. Player 2 joins via WebSocket (instant — can start playing)
  5. Both players play the game via WebSocket + ZK proofs
  6. Game ends, winner determined

  [In parallel during steps 4-6:]
  7. create_game tx confirmed → backend notified via TX_CONFIRMED message
  8. Player 2 sends join_game tx
  9. join_game tx confirmed → backend notified

  Settlement:
  10. Winner can only call process_game once BOTH txs are confirmed
  11. Frontend shows "Waiting for on-chain confirmation..." if txs not yet mined
```

### Transaction Status Tracking

```typescript
type TxStatus = 'idle' | 'sending' | 'mining' | 'confirmed' | 'failed';

interface OnChainGameStatus {
  player1Tx: TxStatus;
  player2Tx: TxStatus;
  canSettle: boolean; // true only when both are 'confirmed'
}
```

### Frontend State Machine

```
idle → sending (user clicks create/join)
sending → mining (tx submitted to mempool)
mining → confirmed (tx included in block)
mining → failed (tx reverted or timed out)
failed → sending (retry)
```

### Backend Message Types

New message types:
```typescript
// Client → Server
| { type: 'TX_CONFIRMED'; gameId: string; txType: 'create_game' | 'join_game'; txHash: string }
| { type: 'TX_FAILED'; gameId: string; txType: 'create_game' | 'join_game'; error: string }
| { type: 'CANCEL_GAME'; gameId: string }

// Server → Client
| { type: 'ON_CHAIN_STATUS'; gameId: string; status: OnChainGameStatus }
| { type: 'GAME_CANCELLED'; gameId: string; reason: string }
```

---

## 6. Error Handling

### Scenario: `create_game` tx fails after gameplay started

- Game plays out normally via WebSocket (gameplay is not affected)
- Settlement is blocked — winner cannot call `process_game`
- Frontend shows: "On-chain game creation failed. Game result cannot be settled on-chain."
- Cards are NOT locked (since `prepare_for_game` failed with the tx)
- The game still has a valid result (for leaderboard/stats purposes) but no card transfer occurs

### Scenario: `join_game` tx fails

- Same as above — gameplay continues, settlement blocked
- Player 2's cards are not locked

### Scenario: One tx confirmed, other pending

- Settlement waits for both
- If one fails permanently, game cannot be settled on-chain
- Both players keep their cards

### Scenario: Timeout — opponent never calls `join_game`

- After N blocks (configurable, e.g., 100 blocks ≈ 30 minutes), Player 1 can call `cancel_game`
- `cancel_game` verifies the timeout has elapsed and that Player 2 never joined
- Cards are unlocked via `unlock_cards`

---

## 7. Implementation Plan

### Contract Changes

1. Add game lifecycle storage to `TripleTriadGame`:
   - `game_player1`, `game_player2`, `game_card_commit_1`, `game_card_commit_2`, `game_status`

2. Add `create_game` private function:
   - Compute `card_commit` (pedersen hash matching circuit)
   - Enqueue `register_game` public function

3. Add `join_game` private function:
   - Read game status (must be `created`)
   - Compute `card_commit`
   - Enqueue `activate_game` public function

4. Add `cancel_game` public function:
   - Verify game is in `created` status and timeout elapsed
   - Clear game record, unlock Player 1's cards

5. Update `process_game`:
   - Read stored `card_commit_1` and `card_commit_2`
   - Assert they match the aggregate proof's public inputs

### Backend Changes

1. Add `onChainStatus` field to `GameRoom`:
   ```typescript
   onChainStatus: {
     player1: 'pending' | 'confirmed' | 'failed';
     player2: 'pending' | 'confirmed' | 'failed';
   }
   ```

2. Handle `TX_CONFIRMED` and `TX_FAILED` messages
3. Broadcast `ON_CHAIN_STATUS` to both players when status changes
4. Add `canSettle` logic: both must be `confirmed`

### Frontend Changes

1. Add `useGameContract` hook for on-chain interactions:
   - `createGameOnChain(gameId, cardIds, ...)`
   - `joinGameOnChain(gameId, cardIds, ...)`
   - Track tx status per player

2. Update `App.tsx` to send `TX_CONFIRMED`/`TX_FAILED` when txs resolve
3. Block settlement UI until both txs confirmed
4. Show tx status indicator (small, non-blocking)

---

## 8. Card Commit Hash — Exact Match Requirement

The `compute_card_commit` in the contract MUST exactly match the circuit:

```noir
fn compute_card_commit(
    player_secret: Field,
    player_address: Field,
    game_id: Field,
    card_ids: [Field; 5],
    card_ranks: [[Field; 4]; 5],
    nullifier_secrets: [Field; 5],
) -> Field {
    let mut hash_inputs: [Field; 33] = [0; 33];
    hash_inputs[0] = player_secret;
    hash_inputs[1] = player_address;
    hash_inputs[2] = game_id;
    for i in 0..5 {
        hash_inputs[3 + i] = card_ids[i];
    }
    for i in 0..5 {
        for j in 0..4 {
            hash_inputs[8 + i * 4 + j] = card_ranks[i][j];
        }
    }
    for i in 0..5 {
        hash_inputs[28 + i] = nullifier_secrets[i];
    }
    std::hash::pedersen_hash(hash_inputs)
}
```

This is replicated identically in:
- `circuits/prove_hand/src/main.nr`
- `circuits/game_move/src/main.nr`
- `packages/contracts/triple_triad_game/src/main.nr` (new)
- `packages/frontend/src/aztec/proofWorker.ts` (TypeScript equivalent using bb.js)
