# Architecture — Axolotl Arena on Aztec

How a hidden-information card game runs on Aztec with three on-chain transactions
per game. This document covers the **contract and protocol layer**: the Noir
contracts, the standalone proof circuits, and the note lifecycle that moves cards
between players. Every claim carries a `file:line` anchor into the source.

> **Scope note:** frontend architecture (hooks, proof workers, relay protocol) is
> documented after the `useGame` decomposition lands (revival work item B); see
> [§12](#12-frontend-layer). The contract/protocol layer below is stable.

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
  card_data/           Shared 256-card rank table (get_card_ranks)
```

The two contracts are wired at deploy time: the game contract address is stored
in the NFT contract (`triple_triad_nft/src/main.nr:153,176-181`) and gates every
game-flow mint (e.g. `:671-672`); the NFT and token addresses are
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
(`commit_five_nfts_create`, `triple_triad_nft/src/main.nr:542-599`):

1. Fetches the player's app-siloed nullifier secret `nhk_app_secret` from the
   PXE via `request_nhk_app` (`:550-552`). This secret never leaves the private
   execution context.
2. Pops the player's single **nonce note** — a one-note counter in
   `note_nonce: Owned<PrivateSet<FieldNote>>` (`:156`, pop/push helpers
   `:345-377`) — and derives, deterministically:
   - `game_id = poseidon2([nhk_app_secret, nonce_value, iv_GameId])`
     (`derive_game_id`, `:244-249`);
   - 6 randomness values `poseidon2([nhk_app_secret, nonce+i, iv_SecretIV])`
     (`derive_game_randomness` → `derive_note_randomness`, `:236-260`).
   The nonce note is re-inserted as `nonce+6` (`:592`), reserving the 6
   randomness slots: 5 for the player's own cards, 1 spare for a captured card.
3. Pops the 5 card notes by token id (`:577-580`) — the cards are *burned*, not
   escrowed. They only exist again when settlement re-mints them.
4. Publishes `card_commit_hash = poseidon2([id1..id5, blinding])` where
   `blinding = poseidon2([nhk_app_secret, nft_address, game_id])` (`:582-588`;
   the frontend can recover the blinding via the simulate-only helper
   `compute_blinding_factor`, `:1008-1015`).
5. Publishes `player_state_hash = poseidon2(randomness[0..6])` (`:590`) — this
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
(`circuits/game_move/src/main.nr:63-268`). Public inputs (`:63-70`):

```
[card_commit_1, card_commit_2, start_state_hash, end_state_hash, game_ended, winner_id]
```

State hashes are `pedersen([board[18], score1, score2, current_turn])`
(`hash_board_state`, `:27-36`); the board is 9 cells × `(card_id, owner)`
(`:20,77`). The circuit constrains, in order:

1. **Turn legality** — the mover matches `current_turn_before` (`:86-91`).
2. **Hand binding** — recompute the mover's commitment from private
   `player_card_ids + blinding_factor`; it must equal `card_commit_1` or `_2`
   per the mover's seat (`:99-113`), and the placed card must be one of the 5
   committed ids (`:115-122`). You cannot play a card you didn't commit.
3. **Placement** — target cell empty before (`:124-127`), card+owner written
   after (`:129-134`).
4. **Capture rules** — full Triple Triad chain capture, in-circuit: rank lookup
   for all 9 cells via the shared table (`card_data`'s `get_card_ranks`,
   `circuits/card_data/src/lib.nr:5`; precomputed at `:142-148`), then 8
   fixed passes of BFS-style flipping using the adjacency table `NEIGHBORS`
   (`:42-52`) and facing-rank table `DIR_RANKS` (`:59`), seeded from the placed
   cell (`:150-189`).
5. **Frame rule** — every non-placed cell keeps its card id; owner changes iff
   captured (`:191-213`).
6. **State hashing** — `start_state_hash` matches `board_before` (`:215-217`);
   `end_state_hash` matches `board_after` with the turn flipped (`:219-222`).
7. **Game end** — `game_ended/winner_id` are forced by the board: 9 cells filled
   ⇒ ended, winner by score comparison, `3` = draw (`:224-246`).
8. **Score integrity** — scores are *recomputed* from board ownership plus
   remaining hand counts (P1 moves on odd turns ⇒ ceil/floor split, `:248-267`),
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
  `triple_triad_nft/src/main.nr:383-412`): 5 fixed starter cards
  (`STARTER_CARD_IDS`, `:52`), a nonce note initialized to 5 (`:407`), and 100
  ArenaTokens (`:410-411`).
- **Card packs** (`purchase_card_pack`, `:415-442`): burn 100 tokens
  (`CARD_PACK_COST`, `:55`; `burn_from`, `arena_token/src/main.nr:72-79`),
  generate 10 random cards in-circuit from `pedersen([nhk_app_secret, nonce+i])`
  with a 5-tier rarity roll over pools `[10,166,50,20,10]`
  (`generate_card`, `triple_triad_nft/src/main.nr:8,17-49`), advance the nonce
  by 10 (`:441`). `preview_card_ids` (`:447-460`) lets the frontend show the
  pack contents via `.simulate()` before buying — same derivation, no tx.
- **Settlement mints** use `create_and_push_note` (`:467-507`): a manual note
  build that computes the note hash itself
  (`poseidon2([slot, value, owner, randomness])` with the note-hash domain
  separator, `:486-489`), calls `notify_created_note` so the local PXE learns
  it (`:491-499`), and pushes the hash to the tx (`:505`). Crucially it reads
  the slot from `TripleTriadNFT::storage_layout().private_nfts.slot` (`:482`) —
  **ground rule #7**: the `#[storage]` macro assigns slots including hidden
  fields, so a hardcoded slot is a silent corruption bug.
- **Why manual notes?** Protocol-level note delivery
  (`MessageDelivery.ONCHAIN_CONSTRAINED`, e.g. the admin mint `:511-520`)
  costs ~maximum-size encrypted logs per note. The settlement tx creates up to
  10 notes for *two different recipients*; the manual path instead emits one
  compact `CardCreated` event per note (`:134-138`) carrying
  `note_tag = poseidon2([randomness, iv_NoteTag])` (`:262-268`) and a 2-field
  symmetric encryption of the card id under the note's randomness
  (`encrypt_card_payload`, `:270-276`; cipher `:194-214`), delivered
  `OFFCHAIN` (`:683-686`).
- **Discovery** is the flip side — **ground rule #9**: notes created this way
  are NOT auto-discovered. The recipient re-derives their expected randomness
  (their own from the nonce; the captured card's from the winner's spare slot —
  whose value they know because *they* hold the preimage exchanged in §4),
  recognizes their tags, decrypts the payload, and calls the unconstrained
  utility `import_note` (`:1024-1070`), which runs `attempt_note_discovery` +
  `validate_and_store_enqueued_notes_and_events` against the real tx data —
  a `.simulate()` call, no transaction. The frontend driver for this lives in
  `packages/frontend/src/aztec/noteImporter.ts` (anchors after work item B).
- **Inspection**: `get_nfts_for_user` pages through the private set
  (`:1074-1087`); `get_note_nonce` reads the counter (`:1091-1100`).

A small public-ownership surface exists alongside the private set:
`public_owners` map + `transfer_public`/`transfer_private_to_public`
(`:150,805-813,845-856`), used by the abandoned-game path to return cards to a
player who isn't present (§8). The escrow-style functions
`prepare_for_game`/`reclaim_card`/`unlock_cards`/`game_transfer`
(`:860-886,815-841`) belong to a superseded design — **no current game flow
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
   (`mint_to_public_batch_4/5`, `triple_triad_nft/src/main.nr:764-784`) — they
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
| Private state via notes (`Owned<PrivateSet<N>>`) | `triple_triad_nft/src/main.nr:148,156` |
| Note pop with custom filter (spend by token id) | `triple_triad_nft/src/main.nr:577-580` + `src/filters.nr` |
| Single-note counter ("nonce note") pattern | `triple_triad_nft/src/main.nr:345-377` |
| Manual note creation (hash + `notify_created_note`) | `triple_triad_nft/src/main.nr:467-507` |
| Note discovery / `import_note` utility | `triple_triad_nft/src/main.nr:1024-1070` |
| Deterministic note tagging + encrypted payloads | `triple_triad_nft/src/main.nr:61-66,262-276` |
| App-siloed key material (`request_nhk_app`) as KDF seed | `triple_triad_nft/src/main.nr:550-561` |
| In-circuit id/randomness derivation (anti-grinding) | `triple_triad_nft/src/main.nr:244-260` |
| `storage_layout()` instead of hardcoded slots | `triple_triad_nft/src/main.nr:482,1038` |
| Private→public bridge (`enqueue_self` + `#[only_self]`) | `triple_triad_game/src/main.nr:138,141-154` |
| Cross-contract private calls | `triple_triad_game/src/main.nr:130-132,679-681` |
| Recursive UltraHonk verification in a private fn | `triple_triad_game/src/main.nr:578-590` |
| VK pinning via `PublicImmutable` (readable from private) | `triple_triad_game/src/main.nr:87-88,105-119` |
| Proof chaining (hash-linked state transcript) | `triple_triad_game/src/main.nr:613-632` |
| Dummy-proof padding (variable-length proof sets) | `triple_triad_game/src/main.nr:283-316` + `circuits/dummy_move/src/main.nr` |
| Block-number dispute window | `triple_triad_game/src/main.nr:491-494` |
| Replay protection on settlement | `triple_triad_game/src/main.nr:761-770` |
| `#[event]` + `deliver_to(…, OFFCHAIN)` | `triple_triad_nft/src/main.nr:134-138,683-686` |
| Unconstrained utility fns (`.simulate()`-only API) | `triple_triad_nft/src/main.nr:961-1000,1074-1100` |
| Private fungible balances (`BalanceSet`) | `arena_token/src/main.nr:30,55-79` |
| Contract-to-contract authorization (msg_sender gating) | `triple_triad_nft/src/main.nr:546-547` ; `arena_token/src/main.nr:61-64` |
| Pure-Noir game rules in a circuit | `circuits/game_move/src/main.nr:136-189` |

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
(`circuits/game_move/src/main.nr:136-189`, what actually counts). A rule change
must land in both plus their tests in the same change — the TS engine's test
suite and the circuit's `#[test]` cases (`game_move/src/main.nr:304+`) both
encode the rules. The settlement contract only checks the proof *chain*, so
rule changes that keep the public-input shape don't touch the contracts —
but they DO change the move circuit's VK: redeploy with the new `move_vk_hash`
(`triple_triad_game/src/main.nr:110,116`).

**Fork it for another hidden-information game.** The reusable skeleton is:
commit hands in-circuit (§4) → hash-chained move proofs (§5) → recursive
verification + commitment/randomness binding at settlement (§6) → tagged
re-mint + import (§7) → dummy-padding for early termination (§8). Swap the
move circuit's rule block (`game_move/src/main.nr:136-267`) and the state
encoding (`:27-36`), keep everything else. The note-lifecycle machinery is
game-agnostic.

## 12. Frontend layer

*Pending. Written after revival work item B (the `useGame` decomposition)
merges, so file:line anchors land on the post-refactor layout. Until then, the
entry points are `packages/frontend/src/aztec/connectToAztec.ts` (wallet,
two-phase onboarding) and `packages/frontend/src/aztec/noteImporter.ts`
(post-settlement note import).*
