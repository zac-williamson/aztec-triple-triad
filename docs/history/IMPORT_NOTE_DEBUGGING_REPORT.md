# import_note Debugging Report

**Duration**: ~2 hours 17 minutes across 2 sessions
**Date**: March 2026
**Aztec Version**: v4.0.0-devnet.2-patch.1

## Summary

The goal was to implement a custom note creation flow (`create_and_push_note`) that bypasses the Aztec tagging/delivery system, paired with an `import_note` utility function that allows recipients to manually import notes into their PXE. This avoids the tagging index throughput limit (20 unfinalized per epoch per sender/recipient/contract tuple).

Two bugs were found. Both related to **storage slot mismatches** between the custom note creation code and the PXE's oracle query path.

## Bug 1: `Owned<PrivateSet>` Does Not Derive Storage Slots Like `Map`

### What happened

The initial implementation of `create_and_push_note` used `derive_storage_slot_in_map(PRIVATE_NFTS_SLOT, owner)` to compute the storage slot for the note hash. This was based on the assumption that `Owned<PrivateSet>` works like `Map<AztecAddress, PrivateSet>` — deriving a per-owner slot from the base slot.

### Root cause

`Owned<PrivateSet>` and `Map<K, PrivateSet>` handle storage slots differently:

- **`Map.at(key)`**: Calls `derive_storage_slot_in_map(base_slot, key)` to produce a unique slot per key. The `PrivateSet` then uses this derived slot.
- **`Owned.at(owner)`**: Calls `PrivateSet::new(context, self.storage_slot, owner)` passing the **base slot directly**. The `owner` is stored as a separate field on `PrivateSet`, not embedded in the slot.

When `create_and_push_note` computed the note hash with the derived slot, but `view_notes` (called by `get_private_cards`) queried with the base slot, the note hashes didn't match and the note was invisible.

### Fix

Removed `derive_storage_slot_in_map` and used the base storage slot directly in both `create_and_push_note` and `import_note`.

### How this could have been found faster

The distinction between `Owned` and `Map` storage slot behavior is not documented. Reading the source code of `owned.nr` was the only way to discover this. The MCP plugin's code search was essential here.

## Bug 2: `PRIVATE_NFTS_SLOT = 5` Was Wrong — Actual Slot Is 9

### What happened

After fixing Bug 1, notes were stored at slot 5 (the hardcoded constant), but the PXE oracle queried slot 9. The `get_private_cards` function still returned empty.

### Root cause

The `#[storage]` macro assigns storage slots that don't correspond 1:1 to field position. Each `PublicImmutable` field consumes **2 slots** (one for the value, one for an initialization flag), not 1. The storage struct:

```noir
struct Storage {
    name: PublicImmutable<...>,           // slot 1 (uses 1, 2)
    symbol: PublicImmutable<...>,         // slot 3 (uses 3, 4)
    minter: PublicImmutable<...>,         // slot 5 (uses 5, 6)
    game_contract: PublicImmutable<...>,  // slot 7 (uses 7, 8)
    private_nfts: Owned<PrivateSet<...>>, // slot 9 ← NOT slot 5
    ...
}
```

So `private_nfts` is at slot **9**, not slot **5** as initially assumed.

### Fix

Replaced the hardcoded constant with the auto-generated storage layout accessor:
```noir
let storage_slot = TripleTriadNFT::storage_layout().private_nfts.slot;
```

Also updated the frontend TypeScript from `Fr(5n)` to `Fr(9n)`.

### How this could have been found faster

The `storage_layout()` function exists specifically for this purpose, but its existence and usage pattern are not prominently documented. The codegen output (`target/codegen/`) contained the correct slot values, but we only discovered this after extensive debugging.

## Debugging Timeline

### Session 1 (~1h 40m)

1. Implemented `create_and_push_note` and `import_note`
2. E2E test showed `import_note.simulate()` completed without error
3. But `get_private_cards` returned empty
4. Verified note WAS in `pxe.debug.getNotes()` — it was stored
5. Investigated PXE internals: `syncNoteNullifiers`, job queue staging, `NoteStatus` filtering
6. Added diagnostic instrumentation to the contract's `import_note` return value
7. Discovered slot mismatch via diagnostic output (derived slot vs base slot)
8. Fixed Bug 1 — still failing
9. Context window exhausted

### Session 2 (~37m)

1. Re-read state from session 1 summary
2. Monkey-patched `noteStore.getNotes` to log the exact query parameters
3. Discovered oracle was querying slot 9, note was at slot 5
4. Cross-referenced with codegen output to confirm correct slot
5. Fixed Bug 2 using `storage_layout()`
6. Test passes: `Cards after import: [42]`

## Key Diagnostic Techniques

1. **`pxe.debug.getNotes()`**: Confirmed notes were stored (ruled out the import failing silently)
2. **Status-aware queries**: Checked `ACTIVE` vs `ACTIVE_OR_NULLIFIED` to rule out nullification
3. **Diagnostic return values from contract**: Made `import_note` return computed values to compare against expectations
4. **Monkey-patching PXE internals**: Patching `noteStore.getNotes` to log query parameters revealed the exact slot mismatch
5. **Codegen inspection**: Reading `target/codegen/` showed the correct storage slot assignments

---

## Suggestions for Improving the Aztec MCP Plugin

### 1. Storage Slot Documentation and Examples

**Problem**: The relationship between `#[storage]` struct field positions and actual slot numbers is non-obvious. `PublicImmutable` consuming 2 slots is a critical detail buried in implementation.

**Suggestion**: Add a documentation section or searchable guide titled "Understanding Storage Slot Assignment" that explains:
- How the `#[storage]` macro assigns slots
- Which state variable types consume multiple slots (and how many)
- The existence and usage of `ContractName::storage_layout().field_name.slot`
- When to use `derive_storage_slot_in_map` vs direct slot access

### 2. `Owned` vs `Map` State Variable Comparison

**Problem**: `Owned<PrivateSet>` and `Map<AztecAddress, PrivateSet>` look similar but handle storage slots fundamentally differently. This distinction is only discoverable by reading source code.

**Suggestion**: Add a comparison guide or FAQ entry:
- "When should I use `Owned<PrivateSet>` vs `Map<AztecAddress, PrivateSet>`?"
- Document that `Owned` passes the base slot to `PrivateSet`, while `Map` derives a per-key slot
- Show how note hashes are computed differently in each case

### 3. Custom Note Creation Guide

**Problem**: Creating notes manually (bypassing `PrivateSet.insert()`) requires understanding the exact hash computation, including which storage slot value to use, the `DOM_SEP__NOTE_HASH` separator, and the `notify_created_note` oracle. There's no guide for this.

**Suggestion**: Add a "Custom Note Creation" tutorial or pattern guide covering:
- When you'd want to bypass `PrivateSet.insert()` (e.g., explicit randomness, no delivery)
- The exact hash computation: `poseidon2_hash_with_separator([value, owner, storage_slot, randomness], DOM_SEP__NOTE_HASH)`
- The `notify_created_note` oracle parameters
- How to import notes on the recipient side using `attempt_note_discovery` + `validate_and_store_enqueued_notes_and_events`

### 4. Note Import Pattern Guide

**Problem**: The `import_note` pattern (calling `attempt_note_discovery` + `validate_and_store_enqueued_notes_and_events` in an unconstrained utility function) is not documented anywhere. We had to reverse-engineer it from the auto-generated `process_message` function.

**Suggestion**: Document the "manual note import" pattern as a first-class use case:
- Show the `#[external("utility")] unconstrained fn import_note(...)` pattern
- Explain `attempt_note_discovery` parameters (especially `compute_note_hash_and_nullifier` callback)
- Explain `validate_and_store_enqueued_notes_and_events`
- Show the TypeScript side: calling `.simulate()` to trigger PXE-side import without an on-chain tx

### 5. PXE Oracle Debugging Tools

**Problem**: When a note is stored but invisible via `view_notes`, the debugging surface area is vast (nullification, slot mismatch, status filtering, note hash mismatch, job queue issues). We had to monkey-patch PXE internals.

**Suggestion**:
- Add a `pxe.debug.queryNotes(filter)` method that mirrors the oracle's exact query path but returns diagnostic information (e.g., "found 3 notes but 2 were filtered by status, 1 had wrong slot")
- Or add a `pxe.debug.explainNoteMismatch(noteHash, storageSlot)` that checks why a known note hash isn't returned for a given slot query

### 6. Searchable Code for Framework Internals

**Problem**: Many debugging sessions required reading Aztec framework source code (`state_vars/owned.nr`, `state_vars/private_set.nr`, `messages/discovery/private_notes.nr`, PXE TypeScript internals). The MCP search was helpful but results were sometimes too broad.

**Suggestion**:
- Index key framework files (state variables, note processing, oracle dispatch) with structured annotations
- Add a "Framework Internals" search scope that prioritizes `aztec-nr` source code
- Include type signatures and brief descriptions in search results for framework functions

### 7. `storage_layout()` Prominence

**Problem**: `storage_layout()` is the correct way to get storage slots, but it's not mentioned in any tutorial or guide we found. We only discovered it by reading codegen output after exhausting other approaches.

**Suggestion**:
- Mention `storage_layout()` in every documentation page that discusses storage slots
- Add it to the contract development quickstart
- Include a lint/compile warning when hardcoded slot numbers are used in manual note hash computations
