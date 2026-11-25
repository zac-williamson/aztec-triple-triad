# Private games: a contract architecture that leaks nothing it doesn't have to

Status: **spec, being implemented on `feat/private-games`** (November 2026).
Supersedes the game-lifecycle parts of `docs/ARCHITECTURE.md` once it lands.

## 1. Why

A privacy review (25 Nov 2026) found that the ZK proofs hide a game from the
public chain but not from the relay or the opponent. The root cause is the
contract design, not the relay. It forces players to hand each other — through
the relay — everything the settler needs to mint the OTHER player's notes, and
it records the rest publicly.

| Forced today by | What leaks | To whom |
|---|---|---|
| Settlement mints the other player's notes | Aztec address, 6 per-game random values | relay, opponent |
| `prove_hand` requires `opponent_randomness` | the same random values, before the game starts | relay, opponent |
| Settlement recomputes both hand commitments; the prize may be the unplayed card | both full hands, both blinding factors | relay, opponent |
| The winner's tx creates the loser's notes | plaintext note preimages (`RELAY_NOTE_DATA`) | relay |
| Public game state and events | creator and joiner addresses, winner, loser, prize card, abandonment claims with times | everyone |

With those data the relay can recognise every card note a settlement creates.
It can also tie each player's IP to their Aztec address and to the game on-chain.

**Goal.** No party learns anything the game itself doesn't reveal:

- No address, random value, blinding factor or note preimage leaves its
  owner's device.
- The chain holds no game state. Game transactions can't be linked to each
  other or to the game contract, and no result is published.
- The relay forwards messages it can't read, and can't link a room to anything
  on-chain.
- No new parties. Same relay, same three transactions per game.

## 2. The idea in one paragraph

Each player **prepares their own payouts** in the transaction that commits
their cards:
- five fully formed return notes, one per hand slot;
- a partial note for a possible prize card;
- a fully formed reward note.

Only hashes leave that transaction, inside a per-game **record**.

Settlement verifies the 9 move proofs, then just *releases* prepared notes. It
needs no address, random value, blinding factor or unplayed card, so anyone
holding the two records and the transcript can settle.

Game state lives in **nullifiers** derived from a secret only the two players
share. There is no public storage, no public call and no event.

## 3. Contracts

### 3.1 `CardNote`: a card note that can be completed without its owner

Card notes become a custom note with the two-step hash `UintNote` uses:

```
partial   = poseidon2_sep([owner, randomness], DOM_SEP__PARTIAL_NOTE_COMMITMENT)
note_hash = compute_note_hash(storage_slot, [partial, card_id])      // aztec-nr note utils
nullifier = standard: H(note_hash_for_nullification, nhk_app(owner))
```

**Why two steps.** A note can then be created either the normal way (owner and
randomness known) or by completing a `partial` someone else prepared (owner
hidden). Either way the hash is the same, so prize cards and ordinary cards are
interchangeable.

**What carries over.**
- Packing is `[card_id]` only, so `import_note`, `get_nfts_for_user` and
  `pop_cards_by_id` work as before.
- Every mint path moves to `CardNote`: starter, packs, bot stock, admin mint,
  transfers, reclaim.
- `FieldNote` stays for the per-player `note_nonce`.

**Difference from aztec-nr's partial notes.** We never emit a completion log.
The owner always knows the value: their own card, or the prize card they saw
on the board. So publishing it would leak the card id for nothing.

### 3.2 Per-game secrets

`commit_hand` derives everything from the player's NFT-siloed `nhk_app` and
their `note_nonce`. It reuses `derive_note_randomness(nhk, nonce, i)`:

| index | value | used for |
|---|---|---|
| 0..4 | `r_i` | randomness of return note `i` (hand slot `i`) |
| 5 | `w` | randomness of the prize partial note |
| 6 | `u` | randomness of the reward note |
| 7 | `b` | hand blinding factor |

The nonce advances by **8**. Nothing derived here leaves the device; the
client reads its own values with `NFT.compute_game_secrets(nonce)` (simulate).

The **player secret** is derived in the *Game* contract, with the Game-siloed
`nhk_app`:
```
player_secret = poseidon2_sep([nhk_app_game, game_key], DOM_SEP__PLAYER)
seat          = poseidon2_sep([player_secret], DOM_SEP__SEAT)
```
`seat` is public within the game. It authorises cancel, claim and contest
(proven by recomputing it), and it blocks self-joins: the same account
recomputes the same seat.

### 3.3 Records and game identity

Each player's commit produces a **record** of 9 opaque fields:

```
record = [seat, hand_commit, ret_0, ret_1, ret_2, ret_3, ret_4, prize_partial, reward_note_hash]
  hand_commit      = Poseidon2::hash([card_ids[0..5], b], 6)                     // unchanged formula
  ret_i            = CardNote{card_ids[i]}.compute_note_hash(owner, slot, r_i)   // inner hash
  prize_partial    = poseidon2_sep([owner, w], DOM_SEP__PARTIAL_NOTE_COMMITMENT)
  reward_note_hash = UintNote{REWARD}.compute_note_hash(owner, token_balances_slot, u)
record_hash = poseidon2_sep(record, DOM_SEP__RECORD)
```

**The game key.** `game_key` is a secret only the two players share. It comes
from a key exchange at match time (§5.1), so the relay never learns it.

```
game_id = poseidon2_sep([game_key, record_hash_1], DOM_SEP__GAME_ID)   // secret
```

**Game state is a set of nullifiers.** All are siloed by the Game contract. The
`DOM_SEP__N_*` constants are app-level separators.

| Nullifier | Preimage | Pushed by | Meaning |
|---|---|---|---|
| `N_created` | `game_id` | create | creator's record is committed |
| `N_seat2` | `game_id` | join **and** cancel | seat 2 closed; join and cancel exclude each other |
| `N_joined` | `game_id, record_hash_2` | join | this joiner's record is committed |
| `N_done` | `game_id` | settle, finalize, cancel | game resolved; at most one resolution |
| `N_claim_slot` | `game_id, c` | claim `c` | claim `c` (1..3) is taken |
| `N_claim` | `game_id, c, side` | claim `c` | who filed claim `c` |
| `N_contested_by` | `game_id, side` | contest | each side contests at most once |
| `N_contest` | `game_id, c` | contest of claim `c` | restarts the abandonment clock |
| `N_resolved` | `game_id, c` | contest **and** finalize of claim `c` | contest and finalize exclude each other |

A client checks a game's state by asking the node whether these siloed
nullifiers exist. `Game.game_nullifiers(...)` (utility) computes them so
TypeScript never reimplements the hashes.

### 3.4 Game contract

**Storage:** immutables only (`admin`, `nft_contract`, `token_contract`,
`move_vk_hash`, `dummy_vk_hash`, `permissive_vks`). **No public functions**
except the constructor and the `has_permissive_vks` view. **No events.**

**`create_game(game_key, card_ids) -> record`**
1. `NFT.commit_hand(owner = caller, card_ids)` pops the nonce and the 5 cards,
   checks the hand (distinct ids, each in 1..256), and returns the
   `hand_commit`, return-note, prize-partial and reward-note fields of the
   record.
2. Compute `seat`, assemble the record, compute `game_id`.
3. Push `N_created`.

**`join_game(game_key, record_1, card_ids) -> record`**
1. Recompute `game_id` from `record_1` and assert `N_created` exists (settled).
   That makes `record_1` authentic.
2. `commit_hand` for the joiner, then build the record and assert
   `seat_2 != seat_1` (no self-play).
3. Push `N_seat2` and `N_joined`.

Only someone holding both `game_key` and `record_1` can join. Today anyone who
reads `game_id` off-chain or on-chain could front-run the join.

**`cancel_game(game_key, record_1)`**
1. Assert `N_created` exists.
2. Prove seat 1.
3. Push `N_seat2` (fails if anyone joined) and `N_done`.
4. `NFT.release_game_cards(record_1 returns)`.

The creator gets back exactly the five prepared notes, which fixes the
cancel_game free-mint bug by construction.

**`settle_game(game_key, record_1, record_2, move_vk, 9 × (proof, inputs[8]), prize_move)`**
1. Assert `N_created` and `N_joined` exist.
2. Verify 9 move proofs and the transcript: commits equal both
   `hand_commit`s, the chain is linked and anchored to the empty board, and
   only move 9 ends the game.
3. Push `N_done`.
4. **Win.** `loser_side` comes from `winner_id`. `prize_move` must have the
   loser's parity (P1 moves at even indices). Read `prize_card` and
   `prize_slot` from its proof, then release:
   - the winner's 5 returns;
   - the loser's 4 returns (every slot but `prize_slot`);
   - the prize, as `compute_note_hash(slot, [winner.prize_partial, prize_card])`;
   - both reward notes.

   That is 12 note hashes.
5. **Draw.** Release all 10 returns and both rewards (also 12 note hashes, so
   the result isn't visible in the count).

Anyone can call `settle_game`; nothing is checked against the caller.

**Abandonment (no proofs, no transcript).** `MIN_ABANDON_SECONDS` (480) and
`DISPUTE_SECONDS` (600) are unchanged.

- **`claim_abandoned_game(game_key, r1, r2, side, c, clock_block)`**
  1. Prove `seat_side`.
  2. `c ∈ 1..3`.
  3. Get `h = get_block_header_at(clock_block)` and check the clock nullifier
     existed by `h`. The clock nullifier is `N_joined` if `c == 1`, else
     `N_contest(c-1)`.
  4. Assert `h.timestamp + MIN_ABANDON_SECONDS <= anchor.timestamp`, and that
     `N_done` did not exist at the anchor.
  5. Push `N_claim_slot(c)` and `N_claim(c, side)`.
- **`contest_abandonment(game_key, r1, r2, side, c, claim_side, before_block)`**
  1. Prove `seat_side` and assert `side != claim_side`.
  2. Assert `N_claim(c, claim_side)` exists at the anchor.
  3. Get `h0 = header_at(before_block)` and assert `N_claim(c, claim_side)` did
     **not** exist by `h0`.
  4. Assert `anchor.timestamp < h0.timestamp + DISPUTE_SECONDS`, so the
     contest is inside the window.
  5. Push `N_contested_by(side)`, `N_resolved(c)` and `N_contest(c)`.
- **`finalize_abandoned_game(game_key, r1, r2, c, claim_side, claim_block)`**
  1. Get `h1 = header_at(claim_block)` and assert `N_claim(c, claim_side)`
     existed by `h1`.
  2. Assert `h1.timestamp + DISPUTE_SECONDS <= anchor.timestamp`.
  3. Push `N_resolved(c)` and `N_done`.
  4. Release all 10 returns, with no reward.

  Anyone can call it.

**The same guarantees as today, with fewer moving parts:**
- **Settle beats a claim.** A full transcript outranks a standing claim:
  settlement only needs `N_done` to be free.
- **Contest and finalize exclude each other** through `N_resolved(c)`. No
  expiry timestamp is needed; one would be a public fingerprint.
- **A contest restarts the clock.** Each side contests once, so there are at
  most 3 claims.
- **Unwinding returns both hands together.** Today recovery is per player.
  Here one transaction returns both hands, because nothing secret is needed to
  release the other player's prepared notes.

**Utilities (simulate only):**
- `preview_record(game_key, card_ids, nonce) -> record` builds exactly what
  create/join will commit, with no side effects.
- `game_nullifiers(game_key, record_hash_1, record_hash_2) -> [Field; N]`
  returns the siloed nullifiers of §3.3.

### 3.5 NFT contract

New, all callable by the Game contract only:
- `commit_hand(owner, card_ids, reward) -> [hand_commit, ret_0..4, prize_partial, reward_note_hash]`
- `release_game_cards(note_hashes: [Field; 10], count, prize_partial, prize_card)`.
  It pushes `count` prepared note hashes and, if `prize_card != 0`, the
  completed prize note. It emits no log and no message; owners import (§5.4).

Removed:
- `commit_five_nfts_create`, `commit_five_nfts_join`
- `mint_for_game_winner`, `mint_for_game_loser`, `mint_for_game_draw`,
  `mint_for_game_draw_offchain`
- `preview_game_data`, `compute_blinding_factor`, `derive_game_id`

`compute_game_secrets(nonce) -> [b, r_0..r_4, w, u]` is added (simulate only).

### 3.6 Arena token

- `mint_reward` and `compute_reward_randomness` are removed.
- `release_reward_notes(note_hashes: [Field; 2])` is added, Game only. It
  pushes prepared `UintNote` hashes.
- `import_note` is unchanged.

The owner imports with `(owner, REWARD, u)`.

### 3.7 What an observer still sees

Per game transaction:
- the fee payer (the player's account, unless a wallet pays privately);
- the gas used;
- the counts of nullifiers, note hashes and private logs;
- the timing.

There are no public calls, so nothing names the game contract, and no
nullifier can be computed without `game_key`. Create, join and settle
transactions can't be linked to each other.

## 4. Circuits

**`game_move` public inputs become 8:**
```
[card_commit_1, card_commit_2, start_state_hash, end_state_hash, game_ended,
 winner_id, placed_card_id, placed_slot]
```
`placed_card_id` replaces the private `card_id`. `placed_slot` is new, and the
circuit asserts `player_card_ids[placed_slot] == placed_card_id`. Both are
face-up information. They're only ever private inputs of the settle
transaction, and they're what lets settlement know which return note to hold
back.

**`dummy_move`:** the same 8-input shape, with no constraints.

**`prove_hand`:**
- **Phase A:** dropped from the protocol. `commit_hand` checks hand validity
  on-chain, and the move proofs bind both commitments, so it added nothing
  except the forced sharing of random values.
- **Phase B:** reused as the *open cards* proof (§6). Its public inputs become
  `[hand_commit, open_0, open_1, open_2]`; it is verified by the opponent and
  never on-chain.

`dummy_hand` is removed.

The Game constructor drops `hand_vk_hash`.

## 5. Client protocol (Phase A)

### 5.1 Key exchange

At `MATCH_FOUND` each client generates an ephemeral ECDH P-256 key pair
(WebCrypto, Node's in the bot). It sends `KEY_EXCHANGE {gameId, publicKey}`
and derives the following from the shared secret with HKDF-SHA256:

- `game_key` (info `axolotl-arena/game-key`, reduced into the field);
- an AES-256-GCM channel key (info `axolotl-arena/channel`).

The private key is persisted with the game so a reload can still decrypt.

**Limit: the exchange is unauthenticated.** A relay that actively swaps in its
own keys ends up sharing a different game key with each player. The join then
fails, because the joiner's game id doesn't exist. But by then the relay has
read the creator's sealed `RECORD`, so it can find the creator's create tx and
its fee payer. This is detectable but not prevented. Preventing it needs an
authenticated exchange: a short code both players compare, or keys bound to
long-term identities. The design assumes an honest-but-curious relay.

`PEER {gameId, iv, ciphertext}` carries every player-to-player payload. The
relay forwards and buffers it without reading it. Payload kinds in Phase A:

- `RECORD {record}`
- `SETTLING {prizeMove}`
- `SETTLED {txHash}`

### 5.2 Create and join

1. **Creator.**
   - Read the nonce, `preview_record`, then send `create_game(game_key, card_ids)`.
   - Once it is mined, send `RECORD`.
   - Store the nonce, both records and `game_key`.
2. **Joiner.**
   - On `RECORD`, wait until `N_created` exists.
   - Send `join_game(game_key, record_1, card_ids)`, then reply with its own
     `RECORD`.

### 5.3 Play

Unchanged, except that move proofs carry the new public inputs and no hand
proof is exchanged. Blinding and randomness come from `compute_game_secrets`.

### 5.4 Settle and import

1. **The winner settles**, choosing `prize_move` (default: the loser's
   strongest placed card). On a draw player 1 settles. Either player may
   settle if the other doesn't.
2. **The settler sends `SETTLED {txHash}`.**
3. **Anyone can find the settle transaction without the relay.** Look up
   `N_done` with the node's nullifier-index lookup, then find the block and the
   tx containing it.
4. **Each player imports their own notes from that transaction's effects**
   (existing `import_note` paths):
   - return notes: `(owner, own card id of slot i, r_i)`;
   - the prize: `(owner, prize card, w)`;
   - the reward: `(owner, 20, u)`.

   No `NOTE_DATA` is involved. The loser's import is the same code as the
   winner's.

### 5.5 Status and abandonment

The status that public storage used to hold is now read from §3.3 nullifiers:
joined, settled, claims, contests.

Block numbers for the clock checks come from the node's nullifier lookups:
- the block in which `N_joined` / `N_contest` / `N_claim` landed;
- the block before it, for a contest.

## 6. Phase B: the relay stops running the game

Phase A removes everything identifying, but the relay still sees hands and
moves, because it enforces the rules. Phase B makes it a pure pipe.

The relay keeps:
- matchmaking (`QUEUE_MATCHMAKING` with **no** card ids);
- room membership;
- an inbox for offline players;
- turn timing for abandonment warnings.

It no longer has a rules engine, a `GAME_STATE`, a `GAME_OVER` or any card id.

### 6.1 Messages

| Direction | Message | Relay sees |
|---|---|---|
| client → relay | `QUEUE_MATCHMAKING {}` | nothing about the hand |
| relay → client | `MATCH_FOUND {gameId, playerNumber}` | — |
| client → relay | `KEY_EXCHANGE` / `PEER` | as in Phase A |
| client → relay | `MOVE {gameId, moveNumber, iv, ciphertext}` | the move NUMBER only |
| relay → client | `MOVE {gameId, moveNumber, iv, ciphertext}` | forwarded and buffered |
| relay → client | `ROOM_STATE {gameId, playerNumber, movesMade, opponentConnected}` | on RESUME |
| relay → client | `GAME_ABANDONMENT_WARNING {gameId, idlePlayer, secondsIdle, secondsUntilClaimable}` | timing only |

**Turn tracking.** The relay accepts a `MOVE` only from the player whose turn
it is: player 1 at even move numbers, player 2 at odd. It accepts move numbers
strictly in order, 0..8. That is all it needs to time turns and to know when
all nine moves are in. It can't tell a winning move from a losing one.

**Removed:** `PLACE_CARD`, `SUBMIT_MOVE_PROOF`/`MOVE_PROVEN`, `GAME_STATE`,
`GAME_OVER`, `CREATE_GAME`/`JOIN_GAME`/`LIST_GAMES`/`GET_GAME` (the unused
lobby), and the bot win/loss counters. The bot reports its own results.

Sealed payloads, all with `sealPeerPayload`:

- **`MOVE` ciphertext:** `{cardId, slot, row, col, proof, publicInputs}`.
- **PEER `OPEN_CARDS`:** `{cards: [c0, c1, c2], proof, publicInputs}`, sent
  once both records are on-chain.
- **PEER kinds carried over from Phase A:** `RECORD`, `SETTLING`, `SETTLED`,
  `CANCELLED`.

### 6.2 Client state

Each client runs the game itself with `packages/game-logic`:

- **Hands.** Its own hand is the five committed cards, in committed order. The
  opponent's hand is the three proven open cards plus two placeholders, which
  become real when they are played. A move names its slot, so the client
  replaces that slot's placeholder before applying the move.
- **Scores.** A score is board cells owned plus cards left in hand. The hand
  count is known even when the cards aren't.
- **Board.** The board, turn and original owners are public to both players,
  as today.

### 6.3 Checking the opponent's moves

On each `MOVE` the receiver:

1. **Bounds-checks the move:** the card is the opponent's open card at that
   slot (or a hidden slot not yet played), and the cell is empty.
2. **Applies the move locally** and computes the state hashes before and after
   (pedersen over the 30-field preimage, `computeBoardStateHash`).
3. **Checks the proof's public inputs:** the commitments equal the two records'
   `hand_commit`s; start and end equal its own hashes; `placed_card_id` and
   `placed_slot` equal the move; `game_ended` and `winner_id` agree with its
   own board.
4. **Verifies the proof** with the `game_move` VK (bb.js).

A move that fails any check is rejected. The UI reports it, and the honest
player's remedy is the abandonment path, since such a game can never settle.
The same checks apply to `OPEN_CARDS`, against the `prove_hand` (open-cards)
VK.

### 6.4 Reconnects

The client persists the transcript (moves, proofs, open cards, both records,
its key pair). On RESUME the relay replays the inbox and sends `ROOM_STATE`;
the client rebuilds the board from its stored moves plus the replayed ones.

### 6.5 Outcome

The relay sees IPs, room pairing, message kinds and sizes, the move count and
its timing. It sees no cards, moves, results, records or keys.

## 7. Bot, relay, tooling

- **Bot.**
  - Same flow as a human joiner: key exchange, `RECORD`, join, play.
  - It settles when it wins, and imports from the settle transaction otherwise.
  - Its journal keeps records, the transcript and its own secrets, and no
    opponent data.
  - The abandonment sweep works from nullifiers.
- **Relay (Phase A).**
  - Add `KEY_EXCHANGE` and `PEER`.
  - Remove `SHARE_AZTEC_INFO`, `SHARE_BLINDING`, `RELAY_NOTE_DATA`,
    `SETTLE_STARTED`, `SUBMIT_HAND_PROOF` and `HAND_PROOF`.
  - `GAME_OVER` and the abandonment warning no longer carry card ids.
  - `TX_CONFIRMED` no longer carries a tx hash.
- **Scripts and harness.**
  - Deploy drops the hand VK.
  - `check-testnet-state` reads the immutables and the VK flag.
  - The playtest chain validator checks nullifiers instead of public status.
  - The provisioning and bot-stock scripts move to `CardNote`.

## 8. Rule changes

| Rule | Before | After |
|---|---|---|
| Prize | any of the loser's 5 cards | one of the loser's **placed** cards. Player 1 places all 5; player 2's unplayed card stays secret |
| Claim turn rule | a claim needed a transcript prefix whose parity showed the opponent owed the move | no transcript. The parity rule was defeated by truncating the prefix anyway; settlement and contests are the real defences |
| Abandonment recovery | per player, one transaction each | both hands back in one transaction, by anyone |
| Who can join | anyone who knew the public `game_id` | only whoever holds `game_key` and the creator's record |
| Who can settle | the winner (draw: either), with the opponent's address and secrets | anyone with the records and transcript |
| Cancel | re-minted caller-chosen ids (bug) | releases the creator's own prepared notes |

## 9. Migration

New contracts mean a fresh deployment. Existing cards stay on the old NFT
contract, as with every earlier redeploy. The deploy itself needs Zac's
explicit OK.

## 10. Testing

**TXE contract tests:**
- create, join, cancel, double join and join after cancel;
- self-join rejected;
- settle (win and draw) and double settle, through a permissive (dummy-VK)
  deployment;
- claim, contest and finalize, including timing via block headers;
- `release_*` callable only by the Game contract;
- hand validation.

**Other tests:**
- circuit tests for the new public inputs;
- frontend, bot and relay unit tests for every changed flow;
- the local sandbox E2E (playtest harness) playing full games through settlement;
- import checks for both sides.
