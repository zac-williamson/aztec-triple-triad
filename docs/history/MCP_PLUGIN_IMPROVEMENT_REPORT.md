# Aztec MCP Plugin Improvement Report

**Project**: Triple Triad on Aztec Network
**Sessions Analyzed**: 5 conversations (13,889 JSONL lines, 113MB total)
**Context Exhaustions**: 11 (indicating extremely long debugging sessions)
**Date**: February 26-28, 2026

---

## Executive Summary

Across 5 development sessions spanning ~20+ hours of active development, the AI repeatedly struggled with the same categories of Aztec-specific problems. The MCP plugin was called only **68 times** while the AI resorted to reading raw SDK source code from `node_modules` **99 times** -- a 1.46:1 ratio that signals the plugin is missing the information developers actually need.

The three most damaging knowledge gaps were:

1. **Cross-contract `msg_sender()` semantics** (~6 hours wasted across 4 sessions, 15+ test runs)
2. **Wallet pattern confusion: TestWallet vs EmbeddedWallet** (~3 hours, 100+ edits, user had to intervene with "HUGE MISTAKE")
3. **Poseidon2 hash import paths** (~30 minutes, 15+ MCP searches returning wrong results)

Each of these would have been preventable with a single well-placed paragraph in the plugin's documentation.

---

## Issue Catalog

### P0: CRITICAL -- Must Have

---

#### 1. Cross-Contract Call Semantics & `msg_sender()` Behavior

**Time wasted**: ~6 hours across 4 sessions
**Test runs burned**: 15+
**Wrong hypotheses tried**: 12 (timing delays, registerSender, self-minting, PXE debug logging, reading 20+ PXE source files, researching third-party projects)

**What happened**: The NFT contract's `commit_five_nfts` function uses `self.msg_sender()` to look up which notes to pop. When the Game contract calls `commit_five_nfts` via `.call(self.context)`, `msg_sender()` returns the **Game contract's address**, not the player's address. Notes were stored under the player's address but queried under the game contract's address, so `pop_notes` always returned empty.

The AI spent 4 full sessions trying everything *except* examining what `msg_sender()` returns in a cross-contract context. It added retry loops, timing delays, PXE sync checks, and even researched how third-party Aztec projects handle note discovery -- all because it didn't know this fundamental behavior.

**What the plugin should document**:
```markdown
## Cross-Contract Calls: msg_sender() Behavior

When Contract A calls Contract B via `.call(self.context)`:
- Inside Contract B, `self.msg_sender()` returns **Contract A's address**, NOT the
  original transaction sender
- This is critical for note access: if Contract B looks up notes using
  `self.storage.notes.at(self.msg_sender())`, it will look under Contract A's
  address, not the user's address
- **Fix**: Pass the owner address explicitly as a function parameter and validate
  the caller is authorized

### Common Pitfall
```noir
// WRONG: Will look up notes under the calling contract's address
#[external("private")]
fn process_notes() {
    let owner = self.msg_sender(); // Returns calling contract, not user!
    self.storage.notes.at(owner).pop_notes(options);
}

// CORRECT: Accept owner explicitly, validate caller
#[external("private")]
fn process_notes(owner: AztecAddress) {
    let caller = self.msg_sender();
    let authorized = self.storage.authorized_contract.read();
    assert((caller == authorized) | (caller == owner));
    self.storage.notes.at(owner).pop_notes(options);
}
```
```

---

#### 2. Note Discovery & PXE Sync Troubleshooting Guide

**Time wasted**: ~4 hours (overlaps with issue #1 but also standalone confusion)
**Root misconception**: The AI used `compute_blinding_factor().simulate()` as a "sync check" -- but this function doesn't access notes at all, so it always succeeded immediately, giving false confidence that notes were synced.

**What the plugin should document**:
```markdown
## Note Discovery: How It Works & How to Debug

### When are notes visible?
- Notes minted in the same PXE are immediately discoverable (no delay needed)
- Notes minted in a different PXE require block confirmation + tagging sync
- `registerSender` is a NO-OP for accounts on the same PXE instance

### How to check if notes are synced
Use an unconstrained utility function that calls `view_notes`:

```noir
#[external("utility")]
unconstrained fn get_my_notes(owner: AztecAddress) -> [Field; MAX_NOTES_PER_PAGE] {
    let options = NoteViewerOptions::new();
    let notes = storage.private_notes.at(owner).view_notes(options);
    // ... return note data
}
```

Then call via `.simulate()`:
```typescript
const [notes] = await contract.methods.get_my_notes(playerAddr).simulate({ from: playerAddr });
```

### Common "notes not found" causes (in order of likelihood)
1. **Cross-contract msg_sender()**: See "Cross-Contract Calls" section
2. **Wrong owner address**: Double-check the address used in `.at(owner)`
3. **NoteGetterOptions.set_limit()**: Limits notes BEFORE filtering (see below)
4. **Notes not yet on-chain**: Only relevant for cross-PXE scenarios

### What NOT to use as a sync check
- Don't call a function that doesn't access notes (e.g., a hash computation)
- Don't use `.simulate()` on a private function that has no note access
- DO use an unconstrained utility function that calls `view_notes`
```

---

#### 3. EmbeddedWallet Setup: Complete Working Recipe

**Time wasted**: ~3 hours across 2 sessions
**User intervention**: Direct correction with "this is a HUGE MISTAKE. REMOVE."
**Root cause**: The MCP plugin's code search returned `aztec-pay`'s custom `EmbeddedWallet` wrapper (which internally uses the deprecated `TestWallet`) before the official SDK's `EmbeddedWallet`. The AI adopted the wrong pattern.

**What the plugin should document**:
```markdown
## Wallet Setup (v4.0.0-devnet.2-patch.1)

### CRITICAL: Never use TestWallet
`@aztec/test-wallet` and `TestWallet` only exist in `patch.0` and are REMOVED
in `patch.1`. Using them silently downgrades all Aztec dependencies.

### Complete EmbeddedWallet Recipe

```typescript
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { Fr, GrumpkinScalar } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC';
import { getContractInstanceFromInstantiationParams } from '@aztec/stdlib/contract';

// 1. Create wallet
const node = createAztecNodeClient('http://localhost:8080');
const wallet = await EmbeddedWallet.create(node, { ephemeral: true });

// 2. Set up sponsored fees
const sponsoredFPC = await getContractInstanceFromInstantiationParams(
  SponsoredFPCContractArtifact,
  { salt: new Fr(SPONSORED_FPC_SALT) }
);
await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);
const paymentMethod = new SponsoredFeePaymentMethod(sponsoredFPC.address);

// 3. Create accounts (one per player)
const account1 = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
const account2 = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());

// 4. Deploy accounts
await (await account1.getDeployMethod()).send({
  from: AztecAddress.ZERO,
  fee: { paymentMethod },
}).wait({ timeout: 300 });

// 5. Register for note discovery (required for cross-account interactions)
await wallet.registerSender(account1.address, 'player1');

// 6. Send transactions -- ALWAYS include `from:` and `fee:`
const sendAs = (addr: AztecAddress) => ({ from: addr, fee: { paymentMethod } });

await contract.methods.my_method(args).send(sendAs(account1.address)).wait({ timeout: 120 });

// 7. Simulate/read public state -- also needs `from:`
const result = await contract.methods.get_value().simulate({ from: account1.address });
```

### Common Errors
- `"Cannot read properties of undefined (reading 'fee')"` -- Missing `{ from: addr }` in `.simulate()` options
- `"Cannot read properties of undefined (reading 'toField')"` -- `SponsoredFeePaymentMethod` constructed without address arg; need to register SponsoredFPC first
- `"Invalid expiration timestamp"` -- PXE not yet synced after wallet creation; wait for `getBlockNumber() > 0`
```

---

#### 4. SponsoredFPC Setup Pattern

**Time wasted**: ~1 hour
**Root cause**: `SponsoredFeePaymentMethod()` was called without arguments but requires a `paymentContract` address. The AI had to trace through SDK source to discover the correct initialization.

This is documented in the wallet recipe above but deserves its own callout because the error message (`Cannot read properties of undefined`) is completely unhelpful.

---

### P1: HIGH -- Should Have

---

#### 5. Build Pipeline: `aztec compile` vs `nargo compile`

**Time wasted**: ~1.5 hours across 2 sessions
**Wrong commands tried**: `nargo compile` (no transpilation), `aztec codegen` (wrong tool), manual `bb aztec_process` (fragile)

**What the plugin should document**:
```markdown
## Compilation Guide

| What you're building | Command | Notes |
|---------------------|---------|-------|
| Aztec contracts | `aztec compile` | Runs nargo + AVM transpilation + VK generation |
| Standalone Noir circuits | `nargo compile` | No transpilation needed |
| TypeScript wrappers | `aztec codegen target/ -o target/codegen` | Run after `aztec compile` |
| Contract tests (TXE) | Start TXE first, then `nargo test --oracle-resolver` | See below |

### NEVER use `nargo compile` for Aztec contracts
`nargo compile` only produces ACIR bytecode. Without AVM transpilation, you get:
`"Contract's public bytecode has not been transpiled"`

### TXE Test Setup
```bash
TXE_PORT=8081 txe &  # Start TXE server (binary at ~/.aztec/current/node_modules/.bin/txe)
nargo test --oracle-resolver http://127.0.0.1:8081
```
Without TXE running: `"0 output values were provided as a foreign call result for 13 destination slots"`
```

---

#### 6. Hashing Functions Reference

**Time wasted**: ~1.5 hours across 3 sessions, 22+ MCP searches
**Core confusion**: Three different poseidon2 import paths depending on context (contract, standalone circuit, TypeScript), none clearly documented.

**What the plugin should document**:
```markdown
## Hashing Functions Quick Reference

### In Aztec Contracts (Noir)
```noir
use aztec::protocol::hash::poseidon2_hash;
let h = poseidon2_hash([a, b, c]);  // Variable-length array
```

### In Standalone Noir Circuits
`std::hash::poseidon2::Poseidon2` is PRIVATE in Noir 1.0.0-beta.18.
Use the external library:
```toml
# Nargo.toml
[dependencies]
poseidon = { tag = "v0.2.6", git = "https://github.com/noir-lang/poseidon" }
```
```noir
use poseidon::poseidon2::Poseidon2;
let h = Poseidon2::hash(data_array, data_array.len());
```

### In TypeScript (@aztec/bb.js)
```typescript
import { poseidon2Hash } from '@aztec/bb.js';
// API expects { inputs: Buffer[] }, NOT raw bigints
const hash = await poseidon2Hash({ inputs: fields.map(f => f.toBuffer()) });
```

### Pedersen Hash
- Contracts: `std::hash::pedersen_hash([fields])`
- TypeScript: `await pedersenHash({ inputs: buffers })`
```

---

#### 7. NoteGetterOptions API Reference

**Time wasted**: ~2 hours, 27+ MCP searches
**Core confusions**: (a) Generic parameter `N` is the note's packed field count, not the number of notes to retrieve. (b) `set_limit()` limits notes at the oracle level BEFORE custom filtering. (c) Filter functions must be in separate `.nr` files.

**What the plugin should document**:
```markdown
## NoteGetterOptions

### Generic Parameters
`NoteGetterOptions<Note, N, FILTER_ARGS, PREPROCESSOR_ARGS>`
- `Note`: The note type (e.g., `FieldNote`)
- `N`: The note's `Packable::N` -- number of fields when serialized.
  **NOT the number of notes to retrieve.**
  - `FieldNote`: N = 1
  - `ValueNote`: N = 3
  - Custom notes: count your serialized fields

### set_limit() Behavior
`set_limit(n)` limits notes returned by the PXE oracle BEFORE your filter runs.
If you have 6 notes and set_limit(5), the oracle returns 5 arbitrary notes.
Your filter then runs on only those 5 -- it may miss notes it needs.
**Recommendation**: Don't use set_limit() with custom filters.

### Filter Function Placement
Filter functions MUST be defined OUTSIDE the `#[aztec]` contract block,
typically in a separate `.nr` file:

```noir
// filters.nr
use aztec::note::note_interface::HintedNote;

pub fn filter_by_ids<let N: u32>(
    notes: [HintedNote<FieldNote, N>; MAX_NOTE_HASH_READ_REQUESTS_PER_CALL],
    target_ids: [Field; 5],
) -> [HintedNote<FieldNote, N>; MAX_NOTE_HASH_READ_REQUESTS_PER_CALL] {
    // ... filter logic
}
```

```noir
// main.nr (inside #[aztec] contract)
use crate::filters::filter_by_ids;

let options = NoteGetterOptions::with_filter(filter_by_ids, target_ids);
let notes = storage.notes.at(owner).pop_notes(options);
```

### Why Filters Can't Go Inside the Contract Block
The `#[aztec]` macro requires all functions in the contract block to have
annotations (#[external("private")], #[external("public")], etc.).
Plain helper functions cause macro errors.
```

---

#### 8. Transaction Sending Patterns

**Time wasted**: ~1 hour
**Edits required**: 32 fee-related edits across one session alone

**What the plugin should document**:
```markdown
## Sending Transactions

### Basic Pattern (EmbeddedWallet with multiple accounts)
```typescript
// Helper to avoid repeating fee/from on every call
const sendAs = (addr: AztecAddress) => ({
  from: addr,
  fee: { paymentMethod },
});

// Send a transaction
await contract.methods.my_method(args)
  .send(sendAs(playerAddress))
  .wait({ timeout: 120 });

// Deploy a contract
const deployed = await MyContract.deploy(wallet, ...constructorArgs)
  .send(sendAs(deployerAddress))
  .deployed();

// Simulate (read) a public view function -- ALSO needs { from: }
const value = await contract.methods.get_value()
  .simulate({ from: anyAddress });
```

### Common Mistakes
- Forgetting `from:` on `.send()` -- required with EmbeddedWallet
- Forgetting `from:` on `.simulate()` -- causes "Cannot read properties of undefined"
- Chaining `.send().wait()` without `await` -- both are async
```

---

#### 9. Contract Artifact Loading

**Time wasted**: ~1 hour
**Root cause**: Raw Nargo JSON output has a different structure than what the SDK expects. The `parameters` field is nested under `abi` in raw JSON but the SDK expects it at the top level of `FunctionAbi`.

**What the plugin should document**:
```markdown
## Loading Contract Artifacts

### From compiled JSON (after `aztec compile`)
```typescript
import { loadContractArtifact } from '@aztec/aztec.js/abi';

// Load the raw JSON
const artifactJson = JSON.parse(fs.readFileSync('path/to/contract.json', 'utf8'));

// Transform to SDK format
const artifact = loadContractArtifact(artifactJson);

// Deploy
const contract = await MyContract.deploy(wallet, artifact, ...args)
  .send({ from: deployer, fee: { paymentMethod } })
  .deployed();
```

### Contract method names
TypeScript method names match Noir function names exactly -- no prefixes,
no `__aztec_nr_internals__` mangling. If you see mangled names, the artifact
wasn't properly post-processed by `aztec compile`.
```

---

### P2: MEDIUM -- Nice to Have

---

#### 10. `#[aztec]` Macro Behavior Guide

**Time wasted**: ~30 minutes
**Issue**: The macro transforms the module structure. Import paths behave differently inside vs. outside the contract block. Plain functions can't exist inside the block.

```markdown
## The #[aztec] Macro

The `#[aztec]` attribute on a contract module:
- Requires ALL functions in the block to have annotations
  (`#[external("private")]`, `#[external("public")]`, `#[external("utility")]`)
- Changes how imports resolve (e.g., `aztec::` namespace)
- Helper functions, filter functions, and utilities should go in separate
  `.nr` files and be imported via `use crate::module::function`
```

---

#### 11. Noir Language Gotchas

**Time wasted**: ~20 minutes per instance, recurring

```markdown
## Noir Compilation Gotchas

- **ASCII only**: No Unicode in comments or strings. Em dashes, arrows,
  checkmarks in comments will cause compilation errors.
- **`FieldCompressedString`**: Must be exactly 31 bytes. Pad or truncate.
- **`pub` on return types**: Entry-point functions need `pub` on return types.
```

---

#### 12. Common Error Messages Database

A searchable mapping from error messages to root causes would have saved hours:

| Error Message | Root Cause | Fix |
|--------------|------------|-----|
| `"Could not find all 5 cards"` / `pop_notes` returns empty | `msg_sender()` in cross-contract call returns caller contract, not user | Pass owner address explicitly |
| `"Contract's public bytecode has not been transpiled"` | Used `nargo compile` instead of `aztec compile` | Use `aztec compile` |
| `"0 output values were provided as a foreign call result for 13 destination slots"` | TXE server not running | Start TXE: `TXE_PORT=8081 txe &` |
| `"Cannot read properties of undefined (reading 'fee')"` | Missing `{ from: addr }` in `.simulate()` options | Add `{ from: someAddress }` |
| `"Cannot read properties of undefined (reading 'toField')"` | `SponsoredFeePaymentMethod` has no address | Register SponsoredFPC contract first |
| `"Invalid expiration timestamp"` | PXE not synced after wallet creation | Wait for `getBlockNumber() > 0` |
| `"No matching impl found for FieldNote: Packable<N = 5>"` | Wrong generic parameter for NoteGetterOptions | Use `N = 1` for FieldNote (its packed field count) |
| `"poseidon2 is private and not visible from the current module"` | `std::hash::poseidon2` is private in Noir beta.18 | Use external `poseidon` lib for circuits, `aztec::protocol::hash` for contracts |

---

#### 13. Version-Aware Search Results

**Problem**: The MCP plugin's code search returned results from `aztec-pay` (which wraps `TestWallet` internally) before the official SDK, misleading the AI into using deprecated patterns.

**Suggestion**:
- Annotate search results with source type: `[SDK]`, `[Example App]`, `[Test Code]`
- Prioritize official SDK source over application code
- Flag deprecated APIs (like `TestWallet`) in results
- When the target version is known, filter out patterns incompatible with that version

---

#### 14. `.simulate()` Patterns for Private State Testing

**Time wasted**: ~30 minutes

```markdown
## Using .simulate() for Testing

### Reading private state (without a transaction)
Private functions can be called via `.simulate()` to execute in PXE
without sending a transaction:

```typescript
// Get a value computed inside a private function
const blindingFactor = await contract.methods
  .compute_blinding_factor()
  .simulate({ from: playerAddress });
```

This runs the private function locally with full oracle access but
produces no on-chain transaction. Useful for:
- Deriving values that depend on private keys (blinding factors, nullifiers)
- Checking note state without modifying it
- Testing private logic without gas costs
```

---

## Structural Recommendations

### 1. Rebalance Documentation Toward Operational Patterns

The current plugin has 43 markdown files heavily weighted toward contract *structure* (storage types, note definitions, events). What's missing is *operational* documentation -- how things actually work at runtime:
- What happens when you call a function cross-contract?
- What happens to `msg_sender()`?
- When do notes become visible?
- What does PXE sync actually do?
- What order should setup steps happen in?

### 2. Add a "Common Pitfalls" Top-Level Section

The AI's most expensive mistakes were all common pitfalls that experienced Aztec developers would know but aren't documented anywhere searchable. A single "pitfalls" document would have saved ~10 hours across these sessions.

### 3. Add an Error Message Lookup Tool

A dedicated MCP function `aztec_lookup_error(message)` that maps error strings to root causes and fixes would dramatically reduce debugging time. The AI spent hours reading SDK source code to understand what errors meant.

### 4. Prioritize SDK Sources Over Example Apps in Search

When `aztec_search_code` returns results, official SDK packages should rank above example applications. The `aztec-pay` results were actively harmful because they used internal/deprecated patterns.

### 5. Add Integration Test Recipe as a First-Class Skill

The e2e testing skill provides basic structure but misses the critical patterns that consumed the most time: multi-account setup, fee payment initialization, note sync verification, and cross-contract interaction testing. A complete, copy-paste-ready integration test template would be the single highest-value addition.

---

## Statistics

| Metric | Value |
|--------|-------|
| Total sessions | 5 |
| Context exhaustions | 11 |
| MCP plugin calls | 68 |
| SDK source reads from node_modules | 99 |
| Test execution attempts (E2E) | 23 |
| User corrections (explicit) | 8 major |
| Estimated hours wasted on preventable issues | 12-15 |
| Estimated hours on cross-contract msg_sender alone | 6+ |
| Fee pattern edits in single session | 32 |
| Poseidon2 MCP searches before correct answer | 15+ |
