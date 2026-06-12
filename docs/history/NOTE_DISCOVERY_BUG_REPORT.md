# Triple Triad: Note Discovery & Nullification Bug Report

**Aztec version**: `v4.0.0-devnet.2-patch.1`
**Repo**: `github.com/zac-williamson/aztec-triple-triad`
**Date**: 2026-03-09

---

## 1. What the App Does

Triple Triad is a 1v1 card game (from Final Fantasy VIII) built on Aztec. Each card is a private NFT. Players stake 5 cards per game; the winner captures one of the loser's cards. Game moves are proven client-side with standalone Noir circuits and exchanged peer-to-peer over WebSocket. Only 2 on-chain transactions occur per game:

1. **Game setup** — each player commits their 5 cards (nullifies 5 card notes + 1 nonce note, creates 1 new nonce note)
2. **Settlement** — the winner submits all 11 proofs (2 hand + 9 move), the contract verifies them recursively, and re-mints cards to the winner (6 notes) and loser (4 notes)

Between games, players can also "hunt" for card packs (10 new card notes per hunt).

## 2. Contract Architecture

Two contracts:

- **TripleTriadNFT** — NFT contract managing card ownership as `FieldNote` values in an `Owned<PrivateSet>`. Also manages a per-player `note_nonce` (a single `FieldNote` tracking how many notes have been created, used as an index for deterministic randomness derivation).
- **TripleTriadGame** — Game lifecycle contract. Calls into TripleTriadNFT for card commits (nullification) and re-minting (settlement).

### Storage (NFT contract)

```
private_nfts: Owned<PrivateSet<FieldNote>>   — card ownership (all players, single set per owner)
note_nonce:   Owned<PrivateSet<FieldNote>>   — per-player nonce counter (1 note per player)
location_unlocked: Map<Field, PublicImmutable<Field>>  — admin flags for hunt locations
```

## 3. Note Lifecycle Per Game Round

### Round 1 — New Player Setup

**`get_cards_for_new_player()`** creates:
| # | Note Type | Delivery Method |
|---|-----------|----------------|
| 5 | Card `FieldNote` (IDs 1-5) | `create_and_push_note` (manual) + OFFCHAIN `CardCreated` event |
| 1 | Nonce `FieldNote` (value=5) | `insert().deliver(ONCHAIN_CONSTRAINED)` |

**Total**: 6 notes created, 1 uses `ONCHAIN_CONSTRAINED` tagging.

### Game Commit — `commit_five_nfts_create()` / `commit_five_nfts_join()`

**Nullifies**:
| # | Note Type | Method |
|---|-----------|--------|
| 5 | Card `FieldNote` | `pop_notes()` with filter |
| 1 | Nonce `FieldNote` | `pop_notes()` via `pop_note_nonce()` |

**Creates**:
| # | Note Type | Delivery Method |
|---|-----------|----------------|
| 1 | Nonce `FieldNote` (value += 6) | `insert().deliver(ONCHAIN_CONSTRAINED)` |

**Total per player**: 6 nullifiers emitted, 1 new note via `ONCHAIN_CONSTRAINED`.

### Settlement — `process_game()` calls NFT mint functions

**Winner** (`mint_for_game_winner`):
| # | Note Type | Delivery Method |
|---|-----------|----------------|
| 6 | Card `FieldNote` (5 original + 1 captured) | `create_and_push_note` (manual) + OFFCHAIN event |

**Loser** (`mint_for_game_loser`):
| # | Note Type | Delivery Method |
|---|-----------|----------------|
| 4 | Card `FieldNote` (5 original - 1 lost) | `create_and_push_note` (manual) + OFFCHAIN event |

**Draw** (`mint_for_game_draw_offchain`):
| # | Note Type | Delivery Method |
|---|-----------|----------------|
| 5 + 5 | Card `FieldNote` per player | `create_and_push_note` (manual) + OFFCHAIN event |

Settlement does NOT create nonce notes — the nonce was already advanced during commit.

### Card Pack Hunt — `get_cards_from_location()`

| # | Note Type | Delivery Method |
|---|-----------|----------------|
| 10 | Card `FieldNote` | `create_and_push_note` (manual) + OFFCHAIN event |
| 1 | Nonce `FieldNote` (value += 10) | `insert().deliver(ONCHAIN_CONSTRAINED)` (via `push_note_nonce`) |

**Plus nullifies**: 1 old nonce note.

## 4. The Two Note Delivery Methods

### Method A: `ONCHAIN_CONSTRAINED` (framework-managed)

```noir
storage.note_nonce.at(owner).insert(note).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
```

- Framework handles tagging, note hash, and PXE discovery automatically
- PXE discovers notes during block sync via note tags
- **Used for**: nonce notes, `mint_for_game_draw` (cancel path), `transfer_private`, `reclaim_card`

### Method B: `create_and_push_note` (manual)

```noir
fn create_and_push_note(context, owner, value, randomness) -> Field {
    let note = FieldNote { value };
    let note_hash = poseidon2_hash_with_separator(
        [value, owner, storage_slot, randomness],
        DOM_SEP__NOTE_HASH,
    );
    notify_created_note(owner, storage_slot, randomness, ...);
    context.push_note_hash(note_hash);
}
```

- Randomness is **deterministic** — derived from `nhk_app_secret` + `nonce_value` + index
- `notify_created_note` tells the PXE oracle about the note during simulation
- An OFFCHAIN `CardCreated` event is also emitted with an encrypted payload
- **Frontend MUST call `import_note()` after the tx mines** to persist the note in the PXE DB
- **Used for**: all card creation (starter cards, card packs, settlement mints)

### Why manual delivery?

Settlement re-mints cards to both players. The winner's PXE executes the settlement tx, but the **loser's PXE never runs this simulation** — it only learns about the new notes after the fact. Deterministic randomness lets the loser's frontend reconstruct `import_note()` parameters from the game nonce.

## 5. The `import_note()` Utility

```noir
#[external("utility")]
unconstrained fn import_note(owner, value, randomness, tx_hash,
                              unique_note_hashes, num_note_hashes,
                              first_nullifier, recipient) {
    attempt_note_discovery(...);
    validate_and_store_enqueued_notes_and_events(address);
}
```

Called via `.simulate()` (no on-chain tx). Takes the tx hash, the note hashes from the TxEffect, and the note parameters. Runs `attempt_note_discovery` to find the note's nonce in the note hash tree, then `validate_and_store_enqueued_notes_and_events` to persist it in the PXE's local DB.

**Frontend pattern** (from E2E tests):
```typescript
const txEffect = await node.getTxEffect(txHash);
const noteHashes = txEffect.noteHashes.filter(h => BigInt(h) !== 0n);
const firstNullifier = txEffect.nullifiers[0];
const randomness = await nft.methods.compute_note_randomness(nonce, count).simulate({ from: player });

for (let i = 0; i < count; i++) {
    await nft.methods.import_note(
        player, cardIds[i], randomness[i], txHash,
        paddedNoteHashes, noteHashes.length, firstNullifier, player
    ).simulate({ from: player });
}
```

## 6. The Bug

### Symptom

After playing N consecutive games (N=3 with partial notes, N=4 without), `commit_five_nfts_create` fails with **"Invalid tx: Existing nullifier"**.

The PXE's `syncNoteNullifiers` function fails to recognize that card notes from the previous round were nullified. It still considers them "active", so when those same card IDs are re-minted and then committed again, the PXE computes a nullifier that **already exists on-chain** from the previous round's commit.

### What we've confirmed

1. **The nullifier values themselves are correct** — each round uses different randomness, so each round's notes have unique note hashes and unique nullifiers. We verified this by logging nullifiers across rounds; there are zero collisions.

2. **The on-chain nullifiers are correct** — the nullify tx succeeds and the nullifiers appear in TxEffect data.

3. **`syncNoteNullifiers` doesn't match** — after round N's nullify tx, we call `get_private_cards` and find cards that should have been nullified still showing as active. The PXE queries all active notes, reads their pre-computed `siloedNullifier`, checks against the on-chain nullifier tree, and finds 0 matches — even though the nullifiers ARE on-chain.

4. **Timing is not the issue** — we tested with 5s and 15s sync waits between rounds. Identical failure.

5. **The issue did not occur when using `get_cards_for_new_player_test`** (which is identical to the real function but skipped cooldown partial notes). After removing cooldown/partial notes entirely, the problem shifted from game 3 to game 4.

### Root cause hypothesis

Note from Zac: I think the AI is confused and none of these are root causes. It is telling that if we use `get_cards_for_new_player_test` the problem move from game 3 to game 4. The difference between that method and `get_cards_for_new_player` is ~5 partial notes are not created+completed. This indicates perhaps once the number of notes crosses a limit the PXE is not correctly marking nullified notes as deleted...for some reason?

The interaction between `notify_created_note` (called during simulation) and `import_note` (called manually after tx mines) creates conflicting entries in the PXE's note database. Specifically:

- When the PXE simulates a transaction containing `create_and_push_note`, `notify_created_note` creates a **pending** note entry
- When block sync processes the mined tx, the framework may create another entry (or update the pending one)
- When the frontend then calls `import_note` → `attempt_note_discovery` → `validate_and_store_enqueued_notes_and_events`, a **third** discovery path runs

The `siloedNullifier` stored with a note depends on where in the block the note was confirmed (specifically the `nonce` derived from the note's position among `unique_note_hashes` in the tx). If the PXE stores a note entry with a **stale or incorrect `siloedNullifier`**, then `syncNoteNullifiers` will never find a match on-chain — even though the correct nullifier IS on the nullifier tree.

### The tag limit problem

We cannot simply switch everything to `ONCHAIN_CONSTRAINED` delivery because **there is a limit of 20 tags per (contract_address, sender, recipient) per epoch**. A single game round can create:

- 5 card notes (starter or settlement) + 1 nonce note = 6 tagged notes per `get_cards_for_new_player`
- 6 card notes (winner) + 4 card notes (loser) = 10 tagged notes per settlement
- 10 card notes + 1 nonce note = 11 tagged notes per card pack hunt

A player who claims starter cards, plays one game, and hunts once would need **6 + 1 (commit nonce) + 10 (settlement) + 11 (hunt) = 28 tags** in a short window — exceeding the 20-tag limit.

## 7. What We Need

We need a reliable way to create notes with explicit/deterministic randomness that the PXE can discover and correctly nullify across multiple rounds, **without relying on `ONCHAIN_CONSTRAINED` note tags** (due to the 20-tag-per-epoch limit).

Specifically:

1. **A single canonical discovery path** — `notify_created_note` + `import_note` + framework block sync should not create conflicting note DB entries. The `siloedNullifier` must be computed identically regardless of which path discovers the note first.

2. **Or**: a way to use `create_and_push_note` (manual note hash push) where the PXE correctly computes and stores the `siloedNullifier` such that `syncNoteNullifiers` can match it against the on-chain nullifier tree after the note is consumed.

3. **Or**: guidance on the correct pattern for apps that create many private notes per tx with deterministic randomness, where the creating PXE and a non-simulating PXE both need to discover and later nullify those notes.

## 8. Reproduction

The simplest reproduction is the E2E test in `packages/integration/tests/e2e-one-player-nullifier.test.ts`:

```bash
cd packages/integration
npx vitest run tests/e2e-one-player-nullifier.test.ts
```

This test:
1. Deploys the NFT contract
2. Calls `get_cards_for_new_player` → `import_note` × 5
3. Calls `test_nullify_cards` (pops all 5 cards)
4. Calls `test_mint_winner_cards` → `import_note` × 6 (simulates settlement re-mint)
5. Repeats steps 3-4 for rounds 2, 3, 4
6. Fails at round 4 with "Existing nullifier"

The test uses a **single PXE** and a **single player** — no cross-PXE discovery complexity. The issue is purely within one PXE's note store.

## 9. Key Files

| File | Description |
|------|-------------|
| `packages/contracts/triple_triad_nft/src/main.nr` | NFT contract — all note creation, `create_and_push_note`, `import_note` |
| `packages/contracts/triple_triad_game/src/main.nr` | Game contract — `process_game` settlement calling NFT mints |
| `packages/integration/tests/e2e-one-player-nullifier.test.ts` | Simplest reproduction test |
| `packages/integration/tests/e2e-real-3round-diagnostic.test.ts` | Diagnostic test with sync wait tuning |
| `packages/integration/tests/e2e-helpers.ts` | Test helper utilities |
