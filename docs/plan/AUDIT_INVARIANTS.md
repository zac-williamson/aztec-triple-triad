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

## A second gap: what is deployed

Every row reasoned about the functions the protocol uses. None asked what else
the contract exposes. The NFT shipped eight test-only entry points, written so
contract tests could set state up, and anyone could call them on the deployed
contract. Three minted cards of the caller's choosing: `test_mint_winner_cards`
and its `_with_nonce` twin were `mint_for_game_winner` without the
game-contract check, to any address, and `test_create_10_cards` minted ten to
the caller. Found on 22 November 2026 while removing dead code, and gone from
production with that day's redeploy; the NFT deployed on 20 November 2026 had
them. Z4 keeps anything unreviewed from shipping again. Three
of the "properties the register did not name" (N1, N2, N5) were the asserts of
dead or test-only code.

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

**This table measures the contracts as they were BEFORE the private-games
redesign.** The new contracts have not been swept yet.

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

**Rewritten for the private-games contracts (docs/plan/PRIVATE_GAMES.md,
November 2026).** The rows the previous contracts carried (S, T, A, L, Z, H, P)
described public game state, addresses and a settlement that minted the other
player's notes; that code is gone, and so are those rows (see git history).
New rows use new letters so the old mutation snapshot, which measured the old
code, cannot be mistaken for coverage of the new. Statuses below are TXE and
circuit tests that fail for the reason named (every negative contract test is
pinned to its failure message); no mutation sweep of the new contracts has run
yet, so nothing here is `MUTATION-COVERED`.

### Settlement releases what the players prepared

| # | Property | Status | Evidence |
|---|---|---|---|
| R1 | Settlement, cancel and unwinding release only notes the players' own commits prepared; a forged record cannot join, cancel or settle. | `VERIFIED` | `joining_needs_the_creators_real_record`, `a_cancel_cannot_name_other_cards`, `settlement_needs_the_joiners_real_record` — each fails "reading an unknown nullifier" |
| R2 | The prize is a card the LOSER placed, from the slot its move proof names; the loser keeps the other four. | `VERIFIED` | `prize_of` validator tests; `player_1_wins…`, `player_2_wins…`, `the_winner_cannot_take_their_own_card` |
| R3 | Each player imports exactly their own notes, from data they already hold. | `VERIFIED` | Every settlement/cancel/unwind test imports with the owner's own secrets only; `e2e-aztec-settlement.test.ts` does it with real proofs |
| R4 | A win and a draw release the same number of notes. | `VERIFIED` | Both settlement tests assert 12 |
| R5 | Who settles changes nothing: anyone with the records and transcript may, and the payout is the same. | `VERIFIED` | `anyone_holding_the_records_and_transcript_can_settle` |

### Transcript integrity

| # | Property | Status | Evidence |
|---|---|---|---|
| C1 | Every move is bound to both records' hand commitments. | `VERIFIED` | `a_move_bound_to_another_hand_fails`, `moves_must_be_bound_to_this_games_hands` |
| C2 | Moves chain, from the canonical empty board, and only the ninth ends the game with a valid winner. | `VERIFIED` | `assert_transcript` validator tests; `initial_state` tests |
| C3 | A move places only a committed card, from the slot it names. | `VERIFIED` | `game_move`: `test_fail_placed_slot_*`, `test_fail_card_not_in_hand` |
| C4 | The prover cannot forge the post-move board, scores, owners or result. | `VERIFIED` | 402 `game_move` tests (unchanged rules) |
| C5 | Move proofs verify against the stored move VK. | `PARTIAL` | Real proofs settle on a local network (`e2e-aztec-settlement.test.ts`); that a network rejects a bad proof is the recursion primitive's job (G3) |

### Lifecycle: each step happens once

| # | Property | Status | Evidence |
|---|---|---|---|
| E1 | A game resolves at most once — settle, finalize and cancel share one nullifier. | `VERIFIED` | `a_game_settles_once`, `a_settled_game_cannot_be_unwound`, `a_game_is_cancelled_once` — "duplicate nullifiers" |
| E2 | Seat 2 closes once: a game is joined once, and join and cancel exclude each other. | `VERIFIED` | `a_game_is_joined_once`, `a_joined_game_cannot_be_cancelled`, `a_cancelled_game_cannot_be_joined` |
| E3 | Joining needs the shared key and the creator's real record. | `VERIFIED` | `joining_needs_the_shared_key`, `joining_needs_the_creators_real_record` |
| E4 | A player cannot join their own game. | `VERIFIED` | `a_player_cannot_join_their_own_game` |
| E5 | Only the creator can cancel, and cancel returns exactly the creator's hand. **Closes the cancel_game arbitrary-card mint by construction.** | `VERIFIED` | `only_the_creator_can_cancel`, `cancelling_gives_the_creator_exactly_their_hand_back`, `a_cancel_cannot_name_other_cards` |

### Abandonment

| # | Property | Status | Evidence |
|---|---|---|---|
| D1 | Only a player can claim, and only from their own seat. | `VERIFIED` | `only_a_player_can_claim`, `a_player_cannot_claim_from_the_other_seat` |
| D2 | No claim before `MIN_ABANDON_SECONDS` since the join, or since the last contest. | `VERIFIED` | `a_claim_right_after_joining_is_too_soon`, `a_second_claim_too_soon_after_a_contest_is_refused`, validator edge tests |
| D3 | A contest is only inside the window, only by the other side, once per side. | `VERIFIED` | `a_contest_after_the_window_is_refused`, `a_claimant_cannot_contest_their_own_claim`, `each_side_contests_once` |
| D4 | Finalize only after the window; contest and finalize of one claim exclude each other. | `VERIFIED` | `a_claim_cannot_be_finalized_inside_its_window`, `a_contested_claim_cannot_be_finalized` |
| D5 | A full transcript outranks a standing claim; an unwound game cannot be settled, nor a settled one unwound. | `VERIFIED` | `a_full_transcript_outranks_a_standing_claim`, `a_settled_game_cannot_be_unwound` |
| D6 | A finalized claim that took nothing returns each player exactly their own hand, with no reward. | `VERIFIED` | `a_claim_that_takes_nothing_returns_both_hands` |
| D7 | Claim numbers are used once, and there are at most three. | `VERIFIED` | `a_claim_number_is_used_once`, `a_fourth_claim_is_refused` |
| D8 | A claim no longer proves whose turn it is. | `ACCEPTED` | The old parity rule was defeated by truncating the transcript anyway; the defences are D3 (contest), D5 (a full transcript wins) and F6 (a present client contests). A staller who claims again after the other side's one contest can take a card from a game they were stalling — as the old design allowed by truncation |

### The forfeit — walking away costs a card (Zac, 25 Nov 2026)

| # | Property | Status | Evidence |
|---|---|---|---|
| F1 | A finalized forfeit gives the claimant their five plus the named card and the other player their other four: no card is made or lost, and no reward is paid. | `VERIFIED` | `an_uncontested_claim_takes_one_of_the_leavers_open_cards`, `player_one_can_claim_a_card_from_player_two`, `a_claim_after_a_contest_carries_its_own_forfeit` (six and four, both sides); UI `abandonment.spec.ts` on a real chain |
| F2 | A claim can take only one of the OTHER player's three open cards, as their committed hand holds it; taking nothing proves the claimant's own hand. | `VERIFIED` | `a_claim_cannot_take_from_the_claimants_own_hand`, `a_claim_that_takes_nothing_proves_the_claimants_own_cards`, `open_cards_from_another_game_are_refused`, `a_claim_cannot_take_a_hidden_card`, validator tests; the open-cards proof is verified against `hand_vk_hash` (real proofs: UI spec) |
| F3 | Finalizing must name the claim's own terms: nobody — the leaver included — can finalize as if nothing was taken, or swap in another card. | `VERIFIED` | `the_leaver_cannot_finalize_as_if_nothing_was_taken`, `finalizing_cannot_swap_in_a_better_card` |
| F4 | Anyone may finalize without redirecting anything: every released note was prepared for its owner at commit. | `VERIFIED` | `the_leaver_can_finalize_but_still_pays_the_card` |
| F5 | A contest clears the claim and its forfeit. | `VERIFIED` | `a_contest_clears_the_forfeit` |
| F6 | A client in a live game contests a claim against it as it lands, and a creator who leaves before a join loses nothing (automatic cancel). | `VERIFIED` | `useGameSettlement.test.ts` "a claim against a player who is here", `useGame.facade.test.ts` automatic cancel/finalize; UI `abandonment.spec.ts` (P1's open game contests claim 1) |
| F7 | The hand VK is always real, even on a permissive deployment, and differs from the move VK. | `VERIFIED` | `the_dummy_vk_cannot_verify_open_cards_even_when_permissive`, `the_move_vk_cannot_verify_open_cards`, `an_unset_hand_vk_is_refused` |

### Authorization

| # | Property | Status | Evidence |
|---|---|---|---|
| U1 | Only the game contract may commit hands, release game cards or release rewards. | `VERIFIED` | `triple_triad_nft/src/test/mint_authorization.nr`, `a_player_cannot_commit_directly`, token `only_the_game_can_release_rewards` |
| U2 | A player's prepared payouts can be previewed only by the player or the game. | `VERIFIED` | `a_stranger_cannot_preview_someone_elses_payouts` |
| U3 | Every deployed entry point is reviewed; nothing test-only ships. | `VERIFIED` | `scripts/contractEntryPoints.test.ts` (both NFT and game lists) |
| U4 | Public card ownership can only be set from inside the NFT contract. | `VERIFIED` | `#[only_self]` |

### Hands and per-game secrets

| # | Property | Status | Evidence |
|---|---|---|---|
| K1 | A committed hand is five distinct real cards the player holds. | `VERIFIED` | `hand_rules.nr`; `a_hand_with_a_repeated_card_cannot_be_committed`, `a_card_the_player_does_not_hold_cannot_be_committed` |
| K2 | Prepared payouts are exactly what the owner can rebuild from their own secrets. | `VERIFIED` | `the_prepared_payouts_are_exactly_what_the_owner_can_rebuild` |
| K3 | No two games share a prepared value. | `VERIFIED` | `two_games_never_share_payouts`, `committing_takes_the_five_cards_and_advances_the_nonce` |
| K4 | The open-cards proof binds the three revealed cards to the committed hand's first three slots. | `VERIFIED` | `prove_hand` tests (off-chain only) |

### Supply and deployment

| # | Property | Status | Evidence |
|---|---|---|---|
| Q1 | Every resolution conserves supply: win 6 + 4, draw 5 + 5, unwind 5 + 5, cancel 5. | `VERIFIED` | Settlement, abandonment and cancel tests assert both collections |
| Q2 | Released notes are real and importable by their owner. | `VERIFIED` | TXE imports from the release tx's effects; the real-proof E2E |
| Q3 | Card notes cannot be double-spent across games. | `PARTIAL` | Constrained `pop_notes` nullifies; relies on the protocol rejecting duplicate nullifiers |
| Q4 | A sound deployment cannot register the dummy VK for moves. | `VERIFIED` | `assert_vk_configuration` validator tests |

### Privacy — what the redesign is for

| # | Property | Status | Evidence |
|---|---|---|---|
| V1 | No game function makes a public call or writes public state. | `VERIFIED` | The game's reviewed entry points are all private bar the constructor and one immutable view (`contractEntryPoints.test.ts`); its storage holds only immutables |
| V2 | No game nullifier can be computed without the game key. | `UNVERIFIED` | By construction: every one hashes `game_id = H(game_key, record_1)` |
| V3 | Settlement needs no player address, randomness, blinding factor or unplayed card. | `VERIFIED` | Every TXE settlement passes only records and transcript, including from a stranger |
| V4 | A relay that swaps keys in the exchange leaves the players on different game keys. | `VERIFIED` | `gameKeys.test.ts` |
| V5 | Each tx still shows its fee payer, gas, effect counts and time. | `ACCEPTED` | Fee payer is protocol-public; see PRIVATE_GAMES.md §3.7 |

### Card packs — F6 is CLOSED as irrelevant, do not reopen

There are no invariants here and there are not going to be. F6 said pack rarity
is grindable by generating accounts and keeping the one that rolls well. That is
true, and it does not matter: cards have no value, this is a proof of concept,
and the grind costs more than it returns.

It was once fixed by splitting buy and open into two transactions — the only
construction that works, since the roll must be fixed after the buyer commits
and a private function cannot read a value that does not exist yet. It doubled
the latency of a core user flow on a chain where every transaction is a
client-side proof, to partially mitigate a Low finding. It was reverted, and the
one-transaction design is the intended one.

Any future agent tempted to "fix" this: the trade has been made and the answer
is no. If packs ever carry real value, the fix is Aztec partial notes at ONE
transaction, never a second transaction.

### Properties the register did not name

Found by `reconcile.mjs` reporting surviving assertions that map to no row —
the same mechanism that surfaced the cancel path. All `UNVERIFIED`; all are NFT
ownership, minting and locking rules that this list omitted entirely.

| # | Property | Assertion |
|---|---|---|
| N1 | Only the owner may transfer their card. | "Not the owner", "Sender must be owner" |
| N2 | Removed in November 2026 with the escrow lock it described: nothing set a lock. | — |
| N3 | Public ownership transfers require the current public owner. | "Not the public owner" |
| N4 | A token id cannot be minted twice. | "Token already exists" |
| N5 | Committing a hand must find every card named. | "Could not find all 5 cards" (`pop_cards_by_id`). Its old assertions were in test-only helpers, now removed |
| N6 | Only the minter may set the game and token contracts. | "Only minter can set game contract", "...token contract" |
| N7 | Removed with public game state (private games): there are no stored commitments; records are authenticated by nullifier existence (R1). | — |
| N8 | Superseded by R2: the prize is read from the loser's move proof. | "Prize card must be a real card", "Prize slot out of range" |

Eighteen distinct unmapped assertions produced these eight rows. That the list
grew by a quarter under mechanical review is the strongest available argument
for reviewing it for COMPLETENESS rather than for correctness.

### Known gaps

| # | Property | Status | Note |
|---|---|---|---|
| G1 | NFT note lifecycle beyond Q2/Q3 — offchain delivery of minted cards, `import_note` beyond the release paths. | `UNVERIFIED` | `import_note` is `unconstrained utility`, so it cannot forge chain state |
| G2 | `arena_token` authorization. | `VERIFIED` | All mints gated (admin/NFT/game), `burn_from` NFT-only with the call site passing `msg_sender()`, all trusted addresses `PublicImmutable` |
| G3 | The recursive verification primitive is sound. | `UNVERIFIED` | Trusted. P4's empirical argument depends on it enforcing the VK hash |
| G4 | The board-state hash is collision-resistant for this preimage shape. | `UNVERIFIED` | Assumed from pedersen. "Positions cannot recur" is a game-logic argument, not a cryptographic one |
