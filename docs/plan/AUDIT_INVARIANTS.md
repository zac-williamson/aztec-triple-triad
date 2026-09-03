# Audit invariants

The spine of the audit. One row per property the protocol must hold, each
pointing at the artifact that verifies it.

**This file is the thing to review, not the code.** Reviewing 5,000 lines of
Noir is not tractable for anyone; reviewing thirty statements for *completeness*
is. The question to ask of this list is never "is each row true" — the artifacts
answer that — it is **"what property is missing from this list."** A protocol
bug that is not a violation of any row here is a bug this audit cannot find, and
the only defence against that is a human reading the rows and noticing an
absence.

## Status vocabulary

| Status | Means |
|---|---|
| `VERIFIED` | An executable artifact fails if the property is broken, and it has been shown to fail for the intended reason. |
| `MUTATION-COVERED` | Additionally, the asserts enforcing it survive no mutation — nothing can be deleted with the suite still green. |
| `PARTIAL` | Verified for some inputs, not exhaustively. Says what is not covered. |
| `UNVERIFIED` | Believed true by reading. Reading is not verification. |
| `ACCEPTED` | Known to be violable; a deliberate trade-off with a stated bound. |

A row with no artifact is `UNVERIFIED` no matter how obvious it looks. Findings
1 and 4 both looked obvious and were both wrong.

## A gap this list had

There were no rows for `cancel_game` at all until the mutation survivors
(`:300`, `:303`) mapped to nothing. Cancel re-mints the creator's five committed
cards; it is a supply-affecting path with an authorization check, and the
register simply omitted it.

That is the failure this document is meant to catch and did not, and it is why
the instruction at the top is "ask what is MISSING" rather than "check each row".
A missing row is invisible to every tool here: mutation testing can tell you an
assertion is untested, but nothing can tell you a property was never written
down. Only a person re-reading the protocol against this list can.

## Rules

1. **A finding is an executable artifact or it does not exist.** Not a
   paragraph, not a code reading — a test that fails without the fix.
2. **Every negative test must be shown to fail for the intended reason.** Run it
   as a plain test once and read the assertion. A `should_fail` test that trips
   on your own fixture bug proves nothing and reads as coverage forever after.
3. **A test that merely encodes current behaviour is suspect.** `selectHand`'s
   duplicate fallback was pinned in place by a test asserting the dangerous
   behaviour was intended. Ask of every test: would this still pass if the code
   were wrong in the way I most fear?
4. **Comments are not evidence.** Two findings hid behind comments asserting the
   opposite of what the code did.
5. **Whoever wrote it does not bless it.** Verification runs in a context that
   has not seen the design intent — code and invariant only.

## Surface coverage

Every prover- or caller-supplied input that reaches state, and every assert
site, must map to at least one row below. Unmapped means unexamined.

```
node scripts/audit/mutate.mjs --list     # assert sites per target
```

| Target | Asserts | Survivors | Untested |
|---|---|---|---|
| `circuits/prove_hand` | 5 | **0** | 0% |
| `circuits/card_data` | 1 | **0** | 0% |
| `circuits/game_move` | 28 | **0** | 0% — was 16 of 24; differential tests closed the rest |
| `packages/contracts/triple_triad_game` | 78 | **70** | **90%** |
| `packages/contracts/triple_triad_nft` | 38 | **28** | **74%** |

**The circuits are fully covered and the contracts are barely covered at all.**
That is F5 measured. Of 116 contract assertions, 98 can be deleted with the
suite still green — including settlement binding, mint authorization and every
abandonment guard. No test can reach the proof-gated functions, so nothing in
them has ever been exercised.

Run `node scripts/audit/reconcile.mjs <log>` to re-derive the statuses below;
thirteen rows in this file were downgraded from VERIFIED by exactly that command
after being marked verified on the strength of reading.

**All three circuits are fully mutation-covered and no defect was found in any of
them.** The contract is the opposite: see F5.

### The first contract sweep measured nothing

It reported 14 survivors of 78 — 82% coverage from twelve tests that cannot reach
the code in question. Implausible, so the baseline was checked: the *unmutated*
suite was failing 3 passed / 9 failed, identically over three runs. TXE had
degraded mid-sweep, and a classifier cannot tell a mutation-induced failure from
an environment-induced one, so everything after that point scored as KILLED.

A clean restart returned it to 12 passed. The harness now proves the baseline is
green before mutating, aborts otherwise, and gives each contract mutant a fresh
TXE.

**Four defects were found in the harness itself during this audit, and every one
failed toward "covered":** compile failures scored as kills (18 of 78 contract
asserts are multi-line and were being truncated); assertions inside test bodies
mutated (`card_data` showed 6 survivors of 7, five of them its own tests); the
differential generator reporting 351 tests written while writing none; and the
degraded-baseline run above. A tool that fails toward confidence is worse than no
tool. Treat every number here as a claim about the tooling as much as the code.

**Read survivors as triage, not as defects.** A survivor means no test *uniquely*
depends on that assertion, which has two very different causes:

* **genuinely untested** — nothing exercises the property. A real hole.
* **redundantly enforced** — another constraint catches the same cases. Fine,
  though worth knowing the line is load-bearing nowhere.

Measured on `game_move`: of 16 survivors, four were genuinely untested — both
state-hash checks (`:271`, `:281`), the opponent's score (`:326`) and winner
correctness (`:296`) — and closing them needed new tests. Meanwhile a test aimed
squarely at the column-bounds check did **not** kill its mutant, because with the
bound removed the cell-not-empty assertion catches the same input. That one is
redundancy, not a hole.

The four genuine holes matter out of proportion to their number: the state-hash
pair anchors the whole chaining argument. Remove either and a proof may claim a
start state unrelated to the board it operated on. Nine hand-picked forgeries had
missed both, because each of them re-hashed its own tampered state so as not to
let the hash check mask the rule under test — good discipline that left the hash
binding itself untouched. **That is the case for a mechanical list over
intuition, in one example.**

## Invariants

### Settlement binding

| # | Property | Status | Artifact |
|---|---|---|---|
| S1 | A settlement can only mint card ids that hash to the commitment stored at create/join. | `UNVERIFIED` | `settle_game` / `settle_game_draw` asserts; historical bug's regression |
| S2 | The transferred card must be one the loser committed. | `UNVERIFIED` | `card_found` loop + S1 |
| S3 | A settlement pays out only to the two players of that game. | `VERIFIED` | Finding 1 fix; `is_player_pair` + 3 tests |
| S4 | The caller of a win/loss settlement is the player the transcript names as winner. | `UNVERIFIED` | `winner == player1/2` keyed off proof `winner_id` |
| S5 | Randomness used to re-mint matches what was committed. | `UNVERIFIED` | `player_state_hash` asserts |

### Transcript integrity

| # | Property | Status | Artifact |
|---|---|---|---|
| T1 | Moves chain: each move's end state is the next move's start state. | `VERIFIED` | `process_game` §5 |
| T2 | The first move starts from the canonical empty board. | `VERIFIED` | §6 + `initial_state` tests |
| T3 | Only the ninth move may end the game, and must name a valid winner. | `UNVERIFIED` | §7 + `forge_early_game_end` |
| T4 | A move proof cannot be reused in a different game. | `PARTIAL` | Holds via per-game blinding in `card_commit`; no test pins the derivation — F8 |
| T5 | A board position cannot recur, so a move cannot be replayed. | `UNVERIFIED` | Argued from game logic (each move adds a card), not from the hash construction |
| T6 | The prover cannot forge the post-move board, scores or owners. | `VERIFIED` | 16 forgery tests in `game_move` |
| T8 | The published start/end state hashes are the board actually operated on. | `VERIFIED` | `forge_start_state_hash_not_matching_board`, `forge_end_state_hash_not_matching_board` — found missing by mutation |
| T9 | A completed board must be declared finished, with the correct winner. | `PARTIAL` | `forge_wrong_winner_on_completed_board`, `forge_completed_board_declared_unfinished`; the p2-win and draw branches (`:298`, `:300`) remain unkilled |
| T7 | Cascading multi-captures propagate exactly as far as the rules allow. | `VERIFIED` | 270 differential cases from 30 engine-played games; 81 capture-mutations rejected |

### Abandonment and recovery

| # | Property | Status | Artifact |
|---|---|---|---|
| A1 | A claimant must be a player in the game. | `VERIFIED` | `claim_abandoned_game_public` |
| A2 | A claimant must not be the player who owes the next move (n < 9). | `UNVERIFIED` | Finding 2 fix; public-half check against stored addresses |
| A3 | A claim cannot be filed before `MIN_ABANDON_SECONDS`. | `UNVERIFIED` | chain-timestamp assert |
| A4 | Recovery returns only the caller's own committed stake. | `UNVERIFIED` | `settle_abandoned_game` binds to caller's own commitment |
| A5 | Each player recovers at most once. | `UNVERIFIED` | `game_recovered` keyed `[game_id, player]` |
| A6 | A contest and a recovery can never both apply to one claim. | `VERIFIED` | Windows are `<` and `>=` of the same bound — mutually exclusive |
| A7 | A contest restores the game and restarts the abandonment clock. | `UNVERIFIED` | Finding 3 fix |
| A8 | A player may contest at most once per game. | `ACCEPTED` | Bounded by A7; a determined opponent can still out-wait one contest |

### Idempotence and lifecycle

| # | Property | Status | Artifact |
|---|---|---|---|
| L1 | A game can be settled at most once, by any route. | `UNVERIFIED` | `status == 2` + `game_settled` on both settle paths |
| L2 | A `game_id` is never reusable. | `UNVERIFIED` | `create_game_public` requires status 0; no path writes 0 |
| L3 | A claimed game cannot also be settled normally. | `VERIFIED` | `status == 2` guard (the double-mint fix) |
| L5 | Only the creator can cancel a game. | `UNVERIFIED` | `player == player1` exists; `:303` survives mutation. **Cancel re-mints the creator's five cards, so this is an authorization check on a supply-affecting path.** |
| L6 | A game can only be cancelled before it is joined. | `UNVERIFIED` | `status == 1` exists; `:300` survives. Cancelling a JOINED game would re-mint the creator's cards while the opponent's stay committed — supply inflation on one side and permanent loss on the other. |
| L4 | A player cannot join their own game. | `UNVERIFIED` | `player2 != player1` exists but `:267` survives mutation — nothing tests it. **Downgraded: this row was wrongly marked VERIFIED on the strength of reading. See F7.** |

### Authorization

| # | Property | Status | Artifact |
|---|---|---|---|
| Z1 | Only the game contract can mint game cards. | `UNVERIFIED` | `msg_sender() == game_contract` on every `mint_for_game_*` |
| Z2 | Public ownership can only be set from inside the NFT contract. | `VERIFIED` | `#[only_self]` |
| Z3 | Card ranks cannot be supplied by a player. | `MUTATION-COVERED` | Fixed in-circuit table; `card_data` tests |

### Hand commitment

| # | Property | Status | Artifact |
|---|---|---|---|
| H1 | A hand proof binds five distinct card ids in 1..256. | `MUTATION-COVERED` | `prove_hand`, 0 mutation survivors of 4 |
| H2 | A hand a client can select is always one it can prove. | `VERIFIED` | Finding 4 fix; `selectHand` refuses duplicates |
| H3 | A move can only place a card in the committed hand. | `VERIFIED` | `forge_card_not_in_hand` |

### Supply and deployment

| # | Property | Status | Artifact |
|---|---|---|---|
| P1 | Every settlement path conserves card supply. | `PARTIAL` | By construction: 10 committed → winner 6 + loser 4, draw 5 + 5, recovery 5 per player behind a per-player flag. Counted, not tested. |
| P2 | A card note created by settlement is real and in the tree. | `PARTIAL` | `create_and_push_note` derives the macro-compatible hash and calls `push_note_hash`. Read, not tested. |
| P3 | Card notes cannot be double-spent across games. | `PARTIAL` | Constrained `pop_notes` emits nullifiers; duplicate nullifiers are dropped by the sequencer. Relies on protocol behaviour. |
| P4 | The deployed VK hashes are the real circuits', not the dummy's. | `VERIFIED` | Empirical: a genuine `game_move` proof only verifies against the real hash, and real settlements succeed on the live instance. |
| P5 | A deployment cannot register the dummy VK for real proofs. | `UNVERIFIED` | **It can — F10.** The constructor validates nothing; the only defences are in tooling. |

### Properties the register did not name

Found by `reconcile.mjs` reporting surviving assertions that map to no row —
the same mechanism that surfaced the cancel path. All `UNVERIFIED`; all are NFT
ownership, minting and locking rules that this list omitted entirely.

| # | Property | Assertion |
|---|---|---|
| N1 | Only the owner may transfer or nullify their card. | "Not the owner", "Sender must be owner", "Only owner can nullify" |
| N2 | A card locked to an active game cannot be reclaimed. | "Card is locked to an active game" |
| N3 | Public ownership transfers require the current public owner. | "Not the public owner" |
| N4 | A token id cannot be minted twice. | "Token already exists" |
| N5 | Nullifying a hand must find every card named. | "Could not find all 5 cards to nullify", "...10 cards..." |
| N6 | Only the minter may set the game and token contracts. | "Only minter can set game contract", "...token contract" |
| N7 | A settlement's stored commitments must exist before use. | "Game card_commit_1 not set", "...card_commit_2..." |
| N8 | A non-draw settlement must name a real transferred card and a valid winner. | "card_to_transfer must be nonzero for non-draw", "Invalid winner ID for non-draw" |

Eighteen distinct unmapped assertions produced these eight rows. That the list
grew by a quarter under mechanical review is the strongest available argument
for reviewing it for COMPLETENESS rather than for correctness.

### Known gaps

| # | Property | Status | Note |
|---|---|---|---|
| G1 | NFT note lifecycle beyond P2/P3 — discovery, tagging, `import_note`. | `UNVERIFIED` | `import_note` is `unconstrained utility`, so it cannot forge chain state; the rest is unexamined |
| G2 | `arena_token` authorization. | `VERIFIED` | All mints gated (admin/NFT/game), `burn_from` NFT-only with the call site passing `msg_sender()`, all trusted addresses `PublicImmutable` |
| G3 | The recursive verification primitive is sound. | `UNVERIFIED` | Trusted. P4's empirical argument depends on it enforcing the VK hash |
| G4 | The board-state hash is collision-resistant for this preimage shape. | `UNVERIFIED` | Assumed from pedersen. "Positions cannot recur" is a game-logic argument, not a cryptographic one |
