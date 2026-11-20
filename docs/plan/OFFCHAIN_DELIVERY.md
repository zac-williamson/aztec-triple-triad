# Card notes on v6: `offchain_receive` instead of `import_note`

**Status:** proposal (20 November 2026). Step 1, a spike, is done; see
[Steps](#steps). It changes the NFT
contract, and our contracts are not upgradeable, so it ships only with a
redeploy. Bundle it with the next network move
([NETWORK_MOVE.md](../NETWORK_MOVE.md)).

## How card notes work today

Every card note is made by `create_and_push_note`
(`packages/contracts/triple_triad_nft/src/main.nr:578`). It computes the note
hash from randomness we choose, derived from the owner's `nhk_app` secret and a
nonce. It then notifies the local PXE and pushes the hash. It sends no message.
Eleven functions use it: starter cards, packs, the settlement and abandonment
mints, the bot's stock, and four test helpers.

With no message, the PXE cannot find these notes. So every recipient imports
each note by hand (ground rule 9):

1. Fetch the tx effect from the node, polling 5 × 3 s.
2. Pad its note hashes to 64.
3. Recompute the card ids and randomness.
4. Call our `import_note` utility once per note.

`import_note` (`:1207`, with a twin in `arena_token`) re-encodes the note as a
private-note message. It then calls aztec-nr's `process_private_note_msg` and
`validate_and_store_enqueued_notes_and_events` directly. In effect it runs the
framework's message pipeline from outside the framework. The earlier version of
this approach broke when `attempt_note_discovery` went private in 4.3.1.

Ten client call sites depend on it:
- frontend: `connectToAztec.ts` ×3, `useCardPacks.ts`, `useGameSettlement.ts` ×2;
- bot: `ArenaBot.ts` ×2, `BotChain.ts`, `AbandonmentSweep.ts`.

The deterministic randomness is the part worth keeping. A player can always
re-derive their own notes and import them, needing nothing from anyone else.
The settlement and abandonment recovery paths depend on that.

### Dead code found along the way

Ten mint sites also emit a `CardCreated { note_tag, note_payload }` event next
to each note, delivered with `MessageDelivery::offchain()`. Nothing receives
these events:
- No TypeScript reads `offchainMessages`. `instrumentedWallet.sendTx` returns
  them and every caller drops them.
- Importers recompute ids and randomness themselves (`previewCardPack` and
  `computeNoteRandomness` in `useCardPacks.ts`).

ARCHITECTURE.md §7 used to describe recipients tag-scanning these events; no
code ever did. The events still cost proving time: `derive_note_tag` and
`encrypt_card_payload` run in constrained code for every card minted. That cost
has not been measured.

## What v6 provides

- **Sender side.** `NoteMessage::deliver(MessageDelivery::offchain())`
  encrypts the standard note message to the recipient. The encryption runs in
  unconstrained code, so it adds no gates. The message comes out as an offchain
  effect:
  - no fee and no log;
  - no tagging index, so bulk mints are not capped by the 84-index tagging
    window that `mint_bot_cards` works around today.
- **Transport.** `send()` returns those messages as `offchainMessages`
  (`recipient`, `payload`, `contractAddress`, `anchorBlockTimestamp`). Our
  `instrumentedWallet.sendTx` already passes them through on both paths
  (`:314`, `:328`).
- **Receiver side.** The recipient hands the messages to `offchain_receive`, a
  utility that `#[aztec]` injects into every contract; all three of ours have
  it.
  - Each call takes up to 16 messages. Each message is
    `{ ciphertext, recipient, tx_hash: Option<Field>, anchor_block_timestamp }`.
  - The PXE keeps the messages in a persistent inbox. At the next sync it
    processes each one whose tx is found on-chain, through the same pipeline as
    on-chain messages.
  - After a reorg, a processed message goes back to be processed again. It
    leaves the inbox only once its block finalizes.
  - If its tx is never found, a message is dropped after
    `MAX_TX_LIFETIME + 2 h`. A message that arrives late for a tx already mined
    is still processed (`aztec/src/messages/processing/offchain/reception.nr`,
    `step`).

That is the job `import_note` does, done by the framework, and with reorg
handling we don't have.

## Keeping our randomness

`create_note` chooses random randomness, which would lose the recovery
property. We don't need `create_note`, though. `NewNote`
(`aztec::note::lifecycle`) has all-public fields and `NoteMessage::new` is
public. So `create_and_push_note` can keep its own hash computation and return
the message instead of the hash:

```noir
// end of create_and_push_note, after push_note_hash
NoteMessage::new(
    NewNote { note, owner, storage_slot, randomness, note_hash_counter },
    context,
)

// call site
create_and_push_note(self.context, owner, card_id, note_randomness)
    .deliver(MessageDelivery::offchain());
```

Notes stay derivable, so recovery still needs nothing from the sender.

## Proposal

| Flow | Sender → owner | Normal path afterwards | Recovery |
|---|---|---|---|
| Starter cards, packs | player → self | `offchain_receive` with the send's own messages | re-derive + `import_note` (unchanged) |
| Settlement, draw, abandonment mints | settler → both players | settler receives their own; the other player's messages forwarded over the relay (step 3) | each player re-derives their own (unchanged) |
| Bot stock (`mint_bot_cards`) | deployer → bot | provisioner writes the messages into the manifest; the bot receives them 16 per call (63 calls for 1000 cards instead of 1000 `import_note` calls) | manifest randomness + `import_note` |

Also remove `CardCreated`, `derive_note_tag`, `encrypt_card_payload` and their
IVs.

Keep `import_note`, but only for recovery: a tab closed between send and
receive, a restore, or a counterparty who never forwards. It still drives
aztec-nr internals, but only on that rare path.

### Steps

1. **Spike: done 20 November 2026**, on branch `spike/offchain-delivery`
   (not for deployment). `get_cards_for_new_player` and `purchase_card_pack`
   build their notes with a `create_note_with_randomness` helper and deliver
   them offchain. Results:
   - A `NewNote` struct literal compiles from our crate, with no warnings.
   - In TXE (`triple_triad_nft/src/test/offchain_delivery.nr`), the cards
     are invisible after the tx and appear after `offchain_receive` with no
     `import_note` and no explicit sync. Receiving the same messages twice
     does not duplicate them. The full NFT suite passes, 30/30.
   - A received note proves the randomness survived. The inbox stores a
     note only if its hash matches one the tx committed, and that hash was
     computed in-circuit from our derivable randomness.
   - TypeScript encoding, checked against the deployed NFT ABI: each message
     is `{ ciphertext: msg.payload, recipient, tx_hash, anchor_block_timestamp }`.
     A bare `tx_hash` encodes as `Some` and `null` as `None`; plain arrays
     encode as `BoundedVec`s.
   - Gates: `get_cards_for_new_player` 30,096 → 29,439 and
     `purchase_card_pack` 36,161 → 34,679. That is 2–4% of each function's
     own circuit. The kernels dominate the full proof, so players won't
     notice the difference.
   - Not covered: the browser. TXE runs the same aztec-nr inbox code, but
     against TXE's oracles instead of the browser PXE's IndexedDB store.
2. **At the next redeploy.**
   - Change every mint site and drop `CardCreated`.
   - Switch the frontend's starter, pack and settlement paths, and the bot
     provisioner.
   - Prove it in the browser: `full-game.spec.ts` asserts that the pack's
     cards appear without `import_note`.
3. **Later, optional.** Forward the counterparty's settlement messages over
   the relay, so the player who didn't settle needs nothing either.

### What it does not change

- Fees: `CardCreated` was already offchain.
- The transaction count: packs stay one transaction (ground rule 12).
- The settlement proof.
- Who can recover what.
