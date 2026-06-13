# Architecture — Axolotl Arena on Aztec

How a hidden-information card game runs on Aztec with three on-chain transactions
per game. This document covers the **contract and protocol layer**: the Noir
contracts, the standalone proof circuits, and the note lifecycle that moves cards
between players. Every claim carries a `file:line` anchor into the source.

> **Scope note:** [§12](#12-frontend-layer) documents the frontend against the
> post-decomposition hook structure (revival work item B). Sections 1–11 cover
> the contract/protocol layer.

## 1. Design at a glance

A full game costs exactly three transactions, regardless of how the match goes:

| Tx | Who | What |
|----|-----|------|
| 1 | Player 1 | `create_game` — burn 5 card notes, publish a hand commitment |
| 2 | Player 2 | `join_game` — same, against player 1's `game_id` |
| 3 | Winner (either player on draw) | `process_game` — verify the whole match, re-mint cards |

The nine moves in between never touch the chain. Each move is a client-side ZK
proof (`circuits/game_move/`) exchanged peer-to-peer over a WebSocket relay
(`packages/backend/`). Settlement verifies all eleven proofs — 2 hand proofs +
9 move proofs — *inside* the private `process_game` function
(`packages/contracts/triple_triad_game/src/main.nr:578-590`), so the chain
learns the result without ever seeing a hand or a move order's private inputs.

Why this shape: Aztec private functions execute client-side and can recursively
verify UltraHonk proofs (`verify_honk_proof`,
`triple_triad_game/src/main.nr:34`). That turns "9 on-chain moves + dispute
games" into "1 proof-of-the-whole-game", with latency and fees paid once.

## 2. System pieces

```
packages/contracts/
  triple_triad_nft/    Card NFTs: private notes, deterministic randomness/tagging,
                       commit-and-burn for game entry, re-mint at settlement
  triple_triad_game/   Game lifecycle + 11-proof recursive settlement
  arena_token/         Private fungible reward token (BalanceSet)
circuits/
  prove_hand/          "I own these 5 committed cards" (and bind opponent randomness)
  game_move/           "This move is legal" (full capture rules in-circuit)
  dummy_move/          Zero-constraint padding for abandoned games
  dummy_hand/          Zero-constraint prove_hand stand-in for playtest fast mode —
                       its VK is accepted only by --permissive-vks TEST deployments
                       (circuits/dummy_hand/src/main.nr:1-8)
  card_data/           Shared 256-card rank table (CARD_RANKS / get_card_ranks)
```

The two contracts are wired at deploy time: the game contract address is stored
in the NFT contract (`triple_triad_nft/src/main.nr:155,178-183`) and gates every
game-flow mint (e.g. `:673-674`); the NFT and token addresses are
`PublicImmutable` in the game contract (`triple_triad_game/src/main.nr:86,97`).

## 3. Game lifecycle

```
P1 browser                On-chain                    P2 browser
──────────                ────────                    ──────────
create_game([5 ids]) ───► status 1 (created)
  └─ NFT pops 5 notes,        │
     derives game_id     GameCreated event
        game_id ──────────────┼─── via relay ───────► join_game(game_id, [5 ids])
                         status 2 (active) ◄──────────── └─ NFT pops 5 notes
                              │
   ◄════ exchange hand proofs + 9 alternating game_move proofs (no txs) ════►
                              │
winner: process_game(11 proofs, …) ───► status 3 (settled)
  └─ all cards re-minted as fresh notes; loser's chosen card switches owners
```

Status machine (values documented at `triple_triad_game/src/main.nr:82`):
`0 none → 1 created → 2 active → 3 settled`, with two exits:
`1 → 4 cancelled` (creator only, `:208-220`) and
`2 → 5 abandoned_claimed → 3 settled` (see [§8](#8-abandoned-games)).

- `create_game` (`triple_triad_game/src/main.nr:126-139`) takes **only** the 5
  card ids. It calls `commit_five_nfts_create` on the NFT contract (`:130-132`),
  which returns `[card_commit_hash, player_state_hash, game_id]` — the game id is
  *derived in-circuit*, never supplied by the client (see §4). The public half
  `create_game_public` (`:141-154`) asserts the id is unused (`:145-146`) and
  stores player, commitment, and state hash.
- `join_game` (`:160-172`, public half `:174-189`) is symmetric, takes the
  creator's `game_id`, and rejects self-joins (`:181`).
- Both private halves bridge to public storage via `enqueue_self` +
  `#[only_self]` (`:138`, `:141-142`) — the standard Aztec pattern for
  private-to-public state updates (public functions cannot call private ones).

## 4. Hiding a hand: commitments

When a player enters a game, the NFT contract
(`commit_five_nfts_create`, `triple_triad_nft/src/main.nr:544-601`):

1. Fetches the player's app-siloed nullifier secret `nhk_app_secret` from the
   PXE via `request_nhk_app` (`:552-554`). This secret never leaves the private
   execution context.
2. Pops the player's single **nonce note** — a one-note counter in
   `note_nonce: Owned<PrivateSet<FieldNote>>` (`:158`, pop/push helpers
   `:347-379`) — and derives, deterministically:
   - `game_id = poseidon2([nhk_app_secret, nonce_value, iv_GameId])`
     (`derive_game_id`, `:246-251`);
   - 6 randomness values `poseidon2([nhk_app_secret, nonce+i, iv_SecretIV])`
     (`derive_game_randomness` → `derive_note_randomness`, `:238-262`).
   The nonce note is re-inserted as `nonce+6` (`:594`), reserving the 6
   randomness slots: 5 for the player's own cards, 1 spare for a captured card.
3. Pops the 5 card notes by token id (`:579-582`) — the cards are *burned*, not
   escrowed. They only exist again when settlement re-mints them.
4. Publishes `card_commit_hash = poseidon2([id1..id5, blinding])` where
   `blinding = poseidon2([nhk_app_secret, nft_address, game_id])` (`:584-590`;
   the frontend can recover the blinding via the simulate-only helper
   `compute_blinding_factor`, `:1010-1017`).
5. Publishes `player_state_hash = poseidon2(randomness[0..6])` (`:592`) — this
   pins, on-chain, exactly which randomness the settlement mints may use.

This is why **ground rule #10** exists (`game_id`/randomness derived in-circuit,
never passed from the frontend): a client-supplied value would let a malicious
player grind ids or reuse randomness across games. The derivation also makes
everything recoverable — wipe the browser, re-derive from the account keys.

The `prove_hand` circuit (`circuits/prove_hand/src/main.nr:21-59`) then proves,
off-chain, to the *opponent*:

| Public inputs | Constraint |
|---------------|-----------|
| `card_commit_hash` | recomputed from private `card_ids` + `blinding_factor` (`:42-49`) |
| `opponent_player_state_hash` | recomputed from the opponent's 6 randomness values (`:51-58`) |

with card ids range-checked 1–256 and pairwise distinct (`:31-40`). The second
input is the protocol's quiet trick: before play begins, players exchange their
randomness values over the relay, and each hand proof demonstrates *knowledge of
the opponent's randomness preimage*. Settlement later requires those exact
values to re-mint the opponent's notes (§6), so by move 1 either player is
guaranteed able to settle — whoever wins, and whoever disappears.

## 5. Playing in zero knowledge: the move circuit

Every move produces one `game_move` proof
(`circuits/game_move/src/main.nr:63-274`). Public inputs (`:63-70`):

```
[card_commit_1, card_commit_2, start_state_hash, end_state_hash, game_ended, winner_id]
```

State hashes are
`pedersen([board[18], score1, score2, current_turn, original_owners[9]])`
(`hash_board_state`, `:32-49`, 30 fields); the board is 9 cells ×
`(card_id, owner)` (`:20,77`). `original_owners[i]` is the player who FIRST
placed the card on cell `i` (0 if empty) — set at placement, never changed by
capture. It is publicly agreed (both peers derive it identically from the shared
move sequence), so it is safe as chained hash state, and it is part of the hash
but not a separate public input. The circuit constrains, in order:

1. **Turn legality** — the mover matches `current_turn_before` (`:86-91`).
2. **Hand binding** — recompute the mover's commitment from private
   `player_card_ids + blinding_factor`; it must equal `card_commit_1` or `_2`
   per the mover's seat (`:99-113`), and the placed card must be one of the 5
   committed ids (`:115-122`). You cannot play a card you didn't commit.
3. **Replay prevention** — a player may not place a card they already placed.
   Reject if any cell holds `card_id` AND has `original_owner == current_player`
   (`:141-159`). `original_owner` is fixed at placement and never changes on
   capture, so this is sound under shared `STARTER_CARD_IDS=[1..5]`: a captured
   opponent card whose id collides with a card still in the mover's hand has
   `original_owner = opponent` and so does NOT false-reject (the finding-19
   capture trap that a *current*-owner check hits). It replaced an owner-blind
   board scan (premise "card ids are globally unique NFTs" was false) and, before
   that, a chained per-player placed-slot mask — abandoned because the masks were
   privately derived and could not agree across async peers, breaking proof-chain
   assembly at the P1→P2 boundary (BUG_C2_REPLAY, BUG_C2_REPLAY_2). Unlike the
   masks, `original_owner` is self-contained and publicly agreed.
4. **Placement** — target cell empty before (`:131-134`), card+owner written
   after (`:136-141`).
5. **Capture rules** — full Triple Triad chain capture, in-circuit: rank lookup
   for all 9 cells via the shared table (`CARD_RANKS`/`get_card_ranks`,
   `circuits/card_data/src/lib.nr:10,269-272`; precomputed at `:149-155`),
   then 8 fixed passes of BFS-style flipping using the adjacency table
   `NEIGHBORS` (`:42-52`) and facing-rank table `DIR_RANKS` (`:59`), seeded
   from the placed cell (`:157-196`).
6. **Frame rule** — every non-placed cell keeps its card id; owner changes iff
   captured (`:198-220`).
7. **State hashing** — `start_state_hash` matches `board_before` (`:222-224`);
   `end_state_hash` matches `board_after` with the turn flipped (`:226-229`).
8. **Game end** — `game_ended/winner_id` are forced by the board: 9 cells filled
   ⇒ ended, winner by score comparison, `3` = draw (`:231-253`).
9. **Score integrity** — scores are *recomputed* from board ownership plus
   remaining hand counts (P1 moves on odd turns ⇒ ceil/floor split, `:255-274`),
   not trusted.

Because each proof's `end_state_hash` is the next proof's `start_state_hash`
(checked at settlement, §6), the 9 proofs form a hash-linked chain from the
canonical empty board to the final position — a verifiable game transcript in
which the only public values are 21-field-hash digests.

## 6. Settlement: process_game

`process_game` (`triple_triad_game/src/main.nr:533-741`) runs entirely in
private context on the winner's machine (either player on a draw). The supplied
verification keys are validated against VK hashes pinned at deploy time in
`PublicImmutable` storage (`:87-88,98`, initialized `:105-119`) — immutable
public values are readable from private context, which is what makes the
pattern work. Steps:

1. **Verify 11 proofs** against the pinned VK hashes (`:578-590`).
2. **Extract** the two card commitments and the two cross-bound opponent state
   hashes from the hand-proof public inputs (`:592-598`).
3. **Consistency** — all 9 move proofs carry the same two commitments
   (`:607-611`).
4. **Chaining** — `end_state[i] == start_state[i+1]` for all 8 links
   (`:613-619`).
5. **Genesis** — move 1 starts from the canonical empty board: 18 zeros,
   scores `5,5`, turn `1`, pedersen-hashed (`:621-632`) — the same formula as
   the circuit's `hash_board_state`.
6. **Termination** — moves 1–8 must not end the game (`:634-638`); move 9 must,
   with `winner_id ∈ {1,2,3}` (`:640-647`).
7. **Randomness binding** — hash the caller's and opponent's supplied
   randomness (`:649-654`); the public halves `settle_game`/`settle_game_draw`
   assert these equal the `player_state_hash` values stored at create/join
   (`:772-793`, draw `:833-842`), AND that each hand proof bound the *other*
   player's stored hash (`:795-799`, draw `:844-846`). Nobody can settle with
   randomness the opponent can't re-derive.
8. **Re-mint** — winner path (`:660-713`): winner gets 6 notes (their 5 + the
   chosen `card_to_transfer`, validated to be in the loser's committed hand
   `:662-670`) via `mint_for_game_winner` (`:679-681`); loser gets 4 notes
   (duplicate-aware removal of the lost card, `:683-697`) via
   `mint_for_game_loser` (`:699-701`). Draw path (`:714-740`): both players'
   5 cards re-mint via `mint_for_game_draw_offchain`. Both paths mint 20
   ArenaTokens to each player (`:703-706`, `:730-733`).
9. **Replay protection** — the public half flips `game_settled` exactly once
   (`:761-762,801-802`) and re-checks the stored commitments match the proof's
   (`:764-770`), so a proof bundle can't settle a different game or settle
   twice.

## 7. The note lifecycle

The full journey of a card, and the Aztec mechanics at each step:

```
mint (onboarding/pack) ──► private note ──► commit_five_nfts_* POPS it (burn)
                                              │ play happens off-chain
        settlement re-mint (create_and_push_note + CardCreated event)
                                              │
        recipient's PXE: tag-scan event ──► import_note ──► private note again
```

- **Onboarding** (`get_cards_for_new_player`,
  `triple_triad_nft/src/main.nr:385-414`): 5 fixed starter cards
  (`STARTER_CARD_IDS`, `:52`), a nonce note initialized to 5 (`:409`), and 100
  ArenaTokens (`:412-413`).
- **Card packs** (`purchase_card_pack`, `:417-444`): burn 100 tokens
  (`CARD_PACK_COST`, `:55`; `burn_from`, `arena_token/src/main.nr:72-79`),
  generate 10 random cards in-circuit from `pedersen([nhk_app_secret, nonce+i])`
  with a 5-tier rarity roll over pools `[10,166,50,20,10]`
  (`generate_card`, `triple_triad_nft/src/main.nr:8,17-49`), advance the nonce
  by 10 (`:443`). `preview_card_ids` (`:449-462`) lets the frontend show the
  pack contents via `.simulate()` before buying — same derivation, no tx.
- **Settlement mints** use `create_and_push_note` (`:469-509`): a manual note
  build that computes the note hash itself
  (`poseidon2([slot, value, owner, randomness])` with the note-hash domain
  separator, `:488-491`), calls `notify_created_note` so the local PXE learns
  it (`:493-501`), and pushes the hash to the tx (`:507`). Crucially it reads
  the slot from `TripleTriadNFT::storage_layout().private_nfts.slot` (`:484`) —
  **ground rule #7**: the `#[storage]` macro assigns slots including hidden
  fields, so a hardcoded slot is a silent corruption bug.
- **Why manual notes?** Protocol-level note delivery
  (`MessageDelivery.ONCHAIN_CONSTRAINED`, e.g. the admin mint `:513-522`)
  costs ~maximum-size encrypted logs per note. The settlement tx creates up to
  10 notes for *two different recipients*; the manual path instead emits one
  compact `CardCreated` event per note (`:136-140`) carrying
  `note_tag = poseidon2([randomness, iv_NoteTag])` (`:264-270`) and a 2-field
  symmetric encryption of the card id under the note's randomness
  (`encrypt_card_payload`, `:272-278`; cipher `:196-216`), delivered
  `OFFCHAIN` (`:685-688`).
- **Discovery** is the flip side — **ground rule #9**: notes created this way
  are NOT auto-discovered. The recipient re-derives their expected randomness
  (their own from the nonce; the captured card's from the winner's spare slot —
  whose value they know because *they* hold the preimage exchanged in §4),
  recognizes their tags, decrypts the payload, and calls the unconstrained
  utility `import_note` (`:1026-1072`), which re-encodes the note as a standard
  private-note message and runs it through `process_private_note_msg` +
  `validate_and_store_enqueued_notes_and_events` against the real tx data
  (the 4.2-era `attempt_note_discovery` API went private upstream in 4.3.1) —
  a `.simulate()` call, no transaction. The frontend driver is
  `importNotesFromTx` (`packages/frontend/src/aztec/noteImporter.ts:93-159`;
  see §12.6).
- **Inspection**: `get_nfts_for_user` pages through the private set
  (`:1076-1089`); `get_note_nonce` reads the counter (`:1093-1102`).

A small public-ownership surface exists alongside the private set:
`public_owners` map + `transfer_public`/`transfer_private_to_public`
(`:152,807-815,847-858`), used by the abandoned-game path to return cards to a
player who isn't present (§8). The escrow-style functions
`prepare_for_game`/`reclaim_card`/`unlock_cards`/`game_transfer`
(`:862-888,817-843`) belong to a superseded design — **no current game flow
calls them** (verified: `triple_triad_game/src/main.nr` never references them);
the design-era spec describing that flow is archived at
`docs/history/GAME_LIFECYCLE_SPEC.md`.

## 8. Abandoned games

If your opponent walks away mid-game, their cards are burned (committed) and
they're unreachable for a cooperative settle. The recovery path:

1. **Claim** — `claim_abandoned_game`
   (`triple_triad_game/src/main.nr:232-380`). You submit the 2 hand proofs plus
   all moves played so far (1–8, `:272-274`), padded to 9 slots with
   **dummy proofs**: the `dummy_move` circuit has the same public-input shape
   and zero constraints (`circuits/dummy_move/src/main.nr:6-13`). The contract
   verifies slot *i* against the real move VK if `i < num_valid_moves`, else
   against the dummy VK (`:283-316`) — three VKs total, all pinned at deploy.
   The real prefix must chain from the canonical start (`:336-355`), and the
   parity of `num_valid_moves` must prove it was the *opponent's* turn when
   play stopped (`:365-375`) — you can't claim a game you abandoned yourself.
   The public half records claimant and block number (`:382-397`).
2. **Dispute window** — settlement requires ≥ 5 blocks after the claim
   (`:491-494`, ~1 minute). What the window actually protects: a false claim
   against a *finished* game. `process_game`'s settlement gates only on the
   `game_settled` flag, not on game status (`:761-762`), so the genuine result
   can still land during the window — after which the abandonment settle fails
   its own `!settled` assert (`:496-497`). For a false claim *mid-game* there
   is no on-chain counter-claim yet: a second `claim_abandoned_game` is
   impossible because the status is no longer `active` (`:385-386`). See
   `FUTURE_IMPROVEMENTS.md` ("Abandoned-game counter-claim").
3. **Settle** — `settle_abandoned_game` (`:407-474`): claimant's 5 cards
   re-mint privately; optionally one opponent card is claimed
   (`mint_single_card_private`, validated in-hand `:427-440`); the opponent's
   remaining cards go to **public** ownership
   (`mint_to_public_batch_4/5`, `triple_triad_nft/src/main.nr:766-786`) — they
   weren't online to receive tagged notes, but can later pull the cards private
   themselves. Only the claimant is rewarded tokens (`:460-462`).

## 9. ArenaToken

A minimal private fungible token (`packages/contracts/arena_token/src/main.nr`):
`Owned<BalanceSet>` storage (`:30`), `mint_private` gated to admin/NFT/game
contracts (`:55-67`), `burn_from` gated to the NFT contract (`:72-79`),
unconstrained `get_balance` (`:82-85`). Economy: +100 at onboarding, +20 per
settled game per player, −100 per card pack — sized so ~5 games buy a pack.

## 10. Aztec concept → code index

The fastest way to use this repo as a learning resource: pick a concept, read
its anchor.

| Aztec concept | Where to read it |
|---------------|------------------|
| Private state via notes (`Owned<PrivateSet<N>>`) | `triple_triad_nft/src/main.nr:150,158` |
| Note pop with custom filter (spend by token id) | `triple_triad_nft/src/main.nr:579-582` + `src/filters.nr` |
| Single-note counter ("nonce note") pattern | `triple_triad_nft/src/main.nr:347-379` |
| Manual note creation (hash + `notify_created_note`) | `triple_triad_nft/src/main.nr:469-509` |
| Note discovery / `import_note` utility | `triple_triad_nft/src/main.nr:1026-1072` |
| Deterministic note tagging + encrypted payloads | `triple_triad_nft/src/main.nr:61-66,264-278` |
| App-siloed key material (`request_nhk_app`) as KDF seed | `triple_triad_nft/src/main.nr:552-563` |
| In-circuit id/randomness derivation (anti-grinding) | `triple_triad_nft/src/main.nr:246-262` |
| `storage_layout()` instead of hardcoded slots | `triple_triad_nft/src/main.nr:484,1040` |
| Private→public bridge (`enqueue_self` + `#[only_self]`) | `triple_triad_game/src/main.nr:138,141-154` |
| Cross-contract private calls | `triple_triad_game/src/main.nr:130-132,679-681` |
| Recursive UltraHonk verification in a private fn | `triple_triad_game/src/main.nr:578-590` |
| VK pinning via `PublicImmutable` (readable from private) | `triple_triad_game/src/main.nr:87-88,105-119` |
| Proof chaining (hash-linked state transcript) | `triple_triad_game/src/main.nr:613-632` |
| Dummy-proof padding (variable-length proof sets) | `triple_triad_game/src/main.nr:283-316` + `circuits/dummy_move/src/main.nr` |
| Block-number dispute window | `triple_triad_game/src/main.nr:491-494` |
| Replay protection on settlement | `triple_triad_game/src/main.nr:761-770` |
| `#[event]` + `deliver_to(…, OFFCHAIN)` | `triple_triad_nft/src/main.nr:136-140,685-688` |
| Unconstrained utility fns (`.simulate()`-only API) | `triple_triad_nft/src/main.nr:963-1002,1076-1102` |
| Private fungible balances (`BalanceSet`) | `arena_token/src/main.nr:30,55-79` |
| Contract-to-contract authorization (msg_sender gating) | `triple_triad_nft/src/main.nr:548-549` ; `arena_token/src/main.nr:61-64` |
| Pure-Noir game rules in a circuit | `circuits/game_move/src/main.nr:143-196` |

## 11. Extending it

**Add or rebalance a card.** Ranks live in four places that must agree:
`scripts/card-database-256.json` (generator source of truth),
`circuits/card_data/src/lib.nr` (what proofs enforce),
`packages/frontend/src/cards.ts:17` (what players see), and
`packages/game-logic/src/cards.ts` (what the engine and backend simulate and
validate — regenerate with `npm run generate:cards` in `packages/game-logic`;
its tests pin the file against the JSON). The contract's pool
constants (`CARDS_PER_POOL`, `triple_triad_nft/src/main.nr:8`) and the
`prove_hand` range check (1–256, `circuits/prove_hand/src/main.nr:31-40`) bound
the id space — growing past 256 touches both. If the UI database disagrees with
the circuit table, moves *render* one way and *prove* another: the proof fails
at the next state hash. Regenerate, don't hand-edit.

**Change a game rule.** The capture logic exists twice by design: TypeScript
(`packages/game-logic/`, drives the UI optimistically) and Noir
(`circuits/game_move/src/main.nr:143-196`, what actually counts). A rule change
must land in both plus their tests in the same change — the TS engine's test
suite and the circuit's `#[test]` cases (`game_move/src/main.nr:309+`) both
encode the rules. The settlement contract only checks the proof *chain*, so
rule changes that keep the public-input shape don't touch the contracts —
but they DO change the move circuit's VK: redeploy with the new `move_vk_hash`
(`triple_triad_game/src/main.nr:110,116`).

**Fork it for another hidden-information game.** The reusable skeleton is:
commit hands in-circuit (§4) → hash-chained move proofs (§5) → recursive
verification + commitment/randomness binding at settlement (§6) → tagged
re-mint + import (§7) → dummy-padding for early termination (§8). Swap the
move circuit's rule block (`game_move/src/main.nr:143-274`) and the state
encoding (`:27-36`), keep everything else. The note-lifecycle machinery is
game-agnostic.

## 12. Frontend layer

How a browser drives all of the above. Anchors target the post-decomposition
layout (revival work item B). All paths in this section are under
`packages/frontend/src/`.

### 12.1 Layering: React hooks over module-level infrastructure

The Aztec machinery deliberately lives **outside React**: `txManager`
(`aztec/txManager.ts:1-13`) and the contract cache (`aztec/contracts.ts:28-49`)
are module-level singletons, so in-flight transactions and PXE state survive
component unmounts and screen navigation. React hooks subscribe to them
(`useSyncExternalStore` snapshots, `aztec/txManager.ts:91-97`) and translate
them into render state. One provider (`aztec/AztecContext.tsx:11`) exposes the
wallet layer to every hook via `useAztecContext` (`:33`).

The game logic itself is a facade plus three hooks, composed once
(`hooks/useGame.ts:93-118`) and consumed only through the facade:

```
useGame (hooks/useGame.ts:100)         facade: screens, matchmaking, persistence
 ├─ useGameSession                     on-chain lifecycle (create/join pipeline)
 ├─ useGamePlay                        proof orchestration (hand + 9 moves)
 └─ useGameSettlement                  process_game + abandoned-game flows
       consumes session/play ONLY through identity-stable accessor functions
       (SettlementSessionDeps/SettlementPlayDeps, hooks/useGameSettlement.ts:20-39)
```

Two design rules carry the whole layer (stated in the architecture comment at
`hooks/useGame.ts:62-91`): values the UI renders are React state; values read
by async closures are refs; and **cross-hook access goes only through
identity-stable functions** (`getPhase`, `getSettlementInfo`, `getMoveProofs`,
`waitFor*`) — never raw refs — so callbacks stay memoized while always reading
current values. Where an effect must read live WebSocket state without
re-firing on every message, the hook mirrors that state into render-updated
refs (`hooks/useGameSession.ts:126-138`).

### 12.2 The on-chain pipeline (useGameSession)

The lifecycle is an explicit state machine: `OnChainPhase`
(`hooks/useGameSession.ts:15-24`) with a legal-transition table enforced by
`transitionPhase` (`:26-36,140-156`). One consolidated effect drives the
pipeline (`:417-545`): player 1 runs `create_game` (`:426-469`), player 2 runs
a read-only prepare step (`:472-511`) and then `join_game` once P1's tx is
confirmed (`:514-540`) — each step wrapped in `txManager.runTx` with
`postEffects` that share data with the opponent and advance the phase.

`createGameOnChain` (`:202-299`) shows the simulate-then-send shape: four
**serial** `.simulate()` calls (`get_note_nonce` → `preview_game_data` →
`get_game_status` → `compute_blinding_factor`, `:215-231`) recover the
in-circuit-derived `game_id`, randomness, and blinding factor *before* the tx,
including a stale-nonce guard (`:233-235`); then `create_game` is sent
(`:263-265`). The preview values are shared with the opponent over the relay
the moment React state updates — a deliberate effect *outside* the PXE
execution context (`:359-375`).

Settlement's inputs accumulate in `settlementInfoRef`
(`SettlementInfo`, `:43-50`): seeded by pipeline postEffects (`:453-461`),
merged synchronously when `OPPONENT_AZTEC_INFO`/`GAME_OVER` arrive (a raw
message listener, not an effect — `:381-407`), and backfilled on demand from
the ws-mirror refs for any field a race left empty (`:173-194`). It is
deliberately **not** cleared on navigation (`:557-563` explains the spurious
`create_game` race that motivates this).

### 12.3 Proof orchestration (useGamePlay)

The hand proof auto-generates the moment its preconditions are met
(`hooks/useGamePlay.ts:246-278`): a 5-card hand, the session's blinding
factor, and the **opponent's 6 randomness values** received over the relay —
§4's randomness exchange, consumed here. Commitment and state hashes are
recomputed client-side to match the circuits exactly
(`aztec/proofWorker.ts:146-159,161-178,185-192` — poseidon2/pedersen via the
shared bb.js API).

Placement is optimistic: `handlePlaceCard` (`:357-407`) sends the move to the
relay immediately (`:374`), applies the rules locally via the game-logic
engine, and then either proves the move now (both hand proofs ready, `:387-394`)
or queues it (`:396-402`). Queued moves replay later against board snapshots
recorded per move number (`gameStateHistoryRef`, `:209-225`, drained at
`:289-345`) — proofs are deferred, never skipped. Both players accumulate all
nine move proofs (own + opponent's via relay, deduped by state-hash pair,
`:127-135`), so **either** player holds a full transcript at game end
(`canSettle`, `:91`).

Proof generation itself (`aztec/proofWorker.ts`) is `Noir.execute` (witness) +
`UltraHonkBackend.generateProof` per circuit, with backends cached per circuit
(`:16-27`) over one Barretenberg instance (`aztec/proofBackend.ts`). Circuit
artifacts are fetched from `/circuits/*.json` (`aztec/circuitLoader.ts:19,30,42`
— the compiled outputs `npm run copy-circuits` publishes). Note: despite the
filename, this runs on the **main thread** — there is no Web Worker, so proving
blocks the tab. The cost mostly overlaps the opponent's thinking time by
construction: the move is relayed before proving starts
(`hooks/useGamePlay.ts:374` vs `:387-394`).

### 12.4 Settlement (useGameSettlement)

`handleSettle` (`hooks/useGameSettlement.ts:228-465`) is one `txManager.runTx`
whose `execute` is a wait-ladder: wait for the on-chain phase to reach
`active` (`:259-268`), for both hand proofs (`:270-281`), for the settlement
info (`:283-285`), for all nine move proofs (`:291-292`), then backfill any
race-emptied fields (`:294-298`). Only then does it prove: load both circuits,
derive the two VKs in-browser, order the move proofs into the hash chain
(`sortProofChain`, `:746-763`, seeded from the canonical initial hash
`:765-770`), and call `process_game` with all 31 arguments (`:382-399`).

`postEffects` (`:406-451`) then mirrors the contract's settlement math in
TypeScript: the winner's 6 note randomness pairs and the loser's 4 (same
duplicate-aware removal as `triple_triad_game/src/main.nr:683-697`), relays
the loser's plaintext note data over the WebSocket (`:439`), imports the
winner's own notes (§12.6), and releases the phase machine.

The abandoned-game flow (`:468-689`) auto-triggers when the opponent
disconnects mid-game with moves on the table (`:691-699`). The claimant
generates the **dummy padding proofs in-browser** — `Noir.execute` over the
zero-constraint circuit, one per missing move (`:539-555`) — sends
`claim_abandoned_game` (`:587-603`), counts down the dispute window in the UI
(65 s for 5 blocks, `:611-618`), then sends `settle_abandoned_game`
(`:620-679`).

The loser's side is event-driven: `OPPONENT_SETTLING` parks a synthetic
txManager entry so the navigation guard holds (`:179-216`), and `NOTE_DATA`
delivers the plaintext notes for import (`:145-172`), including detecting
which card was taken (`:151-154`).

### 12.5 PXE serialization (txManager)

Ground rule #6 — all PXE operations serial per wallet — is enforced
structurally, not by convention: every simulate/prove/send funnels through one
queue that processes a single item at a time (`aztec/txManager.ts:200-221`).
Two policies matter:

- **Priority within a game, FIFO across games** (`:170-198`): lifecycle txs
  (`deploy_account` 0, `create_game`/`join_game` 1) jump ahead of settlement
  (3–4) *only* among items of the same game (`TX_PRIORITY`, `:22-30`) —
  preventing the deadlock where a queued settlement waits forever on a
  `join_game` stuck behind it.
- **`execute` and `postEffects` run as one queue item** (`:244-258`), so a
  queued settlement can never start between `create_game`'s tx and the
  postEffect that records its result.

### 12.6 Note import and persistence

After settlement, each player must import their re-minted notes (§7;
ground rule #9). `importNotesFromTx` (`aztec/noteImporter.ts:93-159`) fetches
the `TxEffect` (with retries — the tx may have just mined, `:48-59`), pads the
note-hash list to the fixed 64-slot circuit input (`:129-133`), and calls the
NFT contract's `import_note` utility once per note via `.simulate()`
(`:138-155`). The settlement hook persists each note's `(tokenId, randomness,
txHash, noteHashes, firstNullifier)` to localStorage *before* importing
(`hooks/useGameSettlement.ts:103-142`) — enough to replay the import into a
fresh PXE after the browser's IndexedDB is wiped.

ArenaToken rewards need no import (they use protocol-level
`ONCHAIN_CONSTRAINED` delivery) but do need the PXE to sync the settlement
block, hence the deliberate balance-refresh polling (`:159-167,442-445`).

### 12.7 The relay (useWebSocket) and wallet layer

The WebSocket hook (`hooks/useWebSocket.ts:9-54` is the full surface) carries
four traffic families: matchmaking, game moves, **proof exchange**
(`submitHandProof`/`submitMoveProof` and their opponent-side mirrors), and
**settlement coordination** (`shareAztecInfo` for address+randomness,
`notifyTxConfirmed` for the create/join handshake, `notifySettleStarted`, and
`relayNoteData` for the loser's plaintext notes). Sessions survive reconnects:
a stored session token is replayed via `RESUME` (`:99-106`) with exponential
backoff (`:108-121`), and `connected` only turns true on
`SESSION_ESTABLISHED`. For async code that cannot wait on React's render
cycle, `addMessageListener` (`:50-53`) delivers messages synchronously in the
`onmessage` tick — the bridge that keeps `settlementInfoRef` current
(§12.2).

The wallet layer is the two-phase onboarding documented at
`aztec/connectToAztec.ts:1-11` — prepare (derive keys, show address) → user
funds it → `deployAndRegister` (deploy account, register contracts, mint
starter cards), driven by `hooks/useAztec.ts` and wrapped in
`InstrumentedWallet`, an `EmbeddedWallet` subclass that emits per-phase timing
events for the tx-progress UI (`aztec/instrumentedWallet.ts:1-8`). Field
decoding throughout uses the prefix-checking helpers
(`toFr`/`safeToField`, `aztec/fieldUtils.ts:23`,
`aztec/proofWorker.ts:93-107`) — ground rule #8, because `.simulate()`
results stringify as decimal.

> **Known divergence (work item I):** game transactions currently pay fees via
> `SponsoredFeePaymentMethod` built in `aztec/contracts.ts:9-26` — the method
> the ground rules ban. The Fee Juice onboarding path already exists
> (`FeeJuicePaymentMethodWithClaim`, `aztec/connectToAztec.ts`); migrating the
> in-game fee path to it is revival work item I. Do not copy the SponsoredFPC
> pattern into new code.

### 12.8 Ground rules → frontend code

| Ground rule | Where it's enforced |
|-------------|---------------------|
| #6 serial PXE ops | the txManager queue (`aztec/txManager.ts:200-221`) — nothing touches PXE outside it |
| #8 decimal `.simulate()` results | `toFr` (`aztec/fieldUtils.ts:23`), `safeToField` (`aztec/proofWorker.ts:97-107`) |
| #9 `import_note` after manual mints | `importNotesFromTx` (`aztec/noteImporter.ts:93-159`) + localStorage replay (§12.6) |
| #10 in-circuit `game_id`/randomness | frontend only *previews* them via `.simulate()` (`hooks/useGameSession.ts:215-231`), never supplies them to a tx |
