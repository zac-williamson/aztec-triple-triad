# @axolotl-arena/bot — the arena bot

A backend opponent that plays like any other player: it watches the matchmaking
queue and, when somebody has waited **more than 30 seconds**, queues itself and
lets the server's ordinary `tryMatch` pair them. In chain mode it commits real
cards, generates real proofs, and settles on-chain — as a private game
(`docs/plan/PRIVATE_GAMES.md`): nothing about the human but what the game itself
reveals ever reaches it, and nothing it does names the game to the relay.

**The bot only ever JOINS games. It never creates one.** That is enforced in two
places, because one is not enough: `tryMatch` orders every pair so a bot takes
the joiner slot, and the bot itself refuses a creator assignment (cancels and
returns to idle) if the server ever hands it one. Creating means wagering five
cards to open a game that may never be joined — a bot doing that unprompted is
an unbounded drain on its own collection, and the queue it is supposed to drain
would be full of its own empty games.

Design rationale, the comparison with how other games handle this, and what the
original ask was missing: **`docs/plan/BACKEND_OPPONENT.md`**. Read that first —
several decisions here look arbitrary without it.

## Two modes

**Off-chain** (relay only — plays, wagers nothing). Useful for exercising
matchmaking and the game loop:

```bash
ARENA_BOT_TOKEN=<same as the backend's> npm run dev -w packages/bot
```

**Chain mode** (commits real cards, proves, settles). Provision an identity
first:

```bash
npx tsx scripts/provision-arena-bot.ts --index 0 --cards 1000

set -a; . packages/frontend/.env; set +a          # NFT, game AND token addresses
ARENA_BOT_TOKEN=... ARENA_BOT_CHAIN=1 \
AZTEC_PXE_URL=http://localhost:8080 \
  npm run dev -w packages/bot
```

It refuses to start half-configured: a bot that matches players and then cannot
commit or recover its cards is worse than one that never starts.

## A chain game, from the bot's seat

The bot is always the joiner, player 2. Everything player-to-player travels as a
sealed `PEER` payload the relay forwards without reading.

1. **`MATCH_FOUND`** — a fresh ECDH key pair for this game; `KEY_EXCHANGE` sends
   the public half. On `OPPONENT_KEY` both sides derive the game key (every
   on-chain nullifier of the game hangs off it) and the channel key
   (`frontend/src/aztec/gameKeys.ts`).
2. **`PEER RECORD`** from the creator — wait for their `created` nullifier, read
   our note nonce (BEFORE committing: the commit advances it), derive our
   secrets, preview our record, journal the game, `join_game`, then
   `TX_CONFIRMED` (no tx hash) and our own `PEER RECORD`.
3. **Play** — every move proof binds both records' hand commitments and
   publishes the placed card and its slot in our committed hand.
4. **`GAME_OVER`** — a win: `PEER SETTLING {prizeMove}` (the human's placed card
   the bot values most: rarest, then strongest), `settle_game`, `PEER SETTLED`.
   A draw: player 1 settles by convention; the bot does it after
   `ARENA_BOT_DRAW_FALLBACK_MS` if they have not. A loss: the winner settles.
5. **Taking its cards back** — whoever settled, the bot finds the resolving tx
   from the game's own `done` nullifier (a `SETTLED` message is only a hint),
   reads off the tx which of its prepared notes were released, and imports
   exactly those: five returns (four on a loss — the missing one is the card the
   winner took), the prize on a win, and its 20-token reward.

## Configuration

| Env | Default | Notes |
|---|---|---|
| `ARENA_BOT_TOKEN` | — | **required**; must match the backend's |
| `ARENA_BOT_CHAIN` | off | `1` enables chain mode |
| `ARENA_BOT_INDEX` | `0` | which provisioned identity to run |
| `ARENA_BOT_JOIN_THRESHOLD_MS` | `30000` | a player must have waited LONGER than this before the bot offers |
| `ARENA_BOT_DIFFICULTY` | `greedy` | `random` \| `greedy` \| `lookahead` |
| `ARENA_BOT_MOVE_DELAY_MS` | `1200` | pacing, so it does not feel inhumanly instant |
| `ARENA_BOT_QUEUE_TIMEOUT_MS` | `60000` | leave the queue if no match forms |
| `ARENA_BOT_GAME_TIMEOUT_MS` | `1800000` | abandon a stuck game and recover its cards |
| `ARENA_BOT_SETTLE_WAIT_MS` | `300000` | wait for the nine-proof transcript |
| `ARENA_BOT_DRAW_FALLBACK_MS` | `120000` | give player 1 this long to settle a draw before the bot does |
| `ARENA_BOT_RECORD_WAIT_MS` | `600000` | leave a match whose creator never sends their record (nothing committed) |
| `ARENA_BOT_CREATED_WAIT_MS` | `300000` | wait this long for the creator's game to show on our node before declining to join |
| `ARENA_BOT_HEALTH_PORT` | `5175` | `0` disables |
| `ARENA_BOT_MAX_CONCURRENT_GAMES` | `1` | see the pool note below |
| `ARENA_BOT_SWEEP_INTERVAL_MS` | `900000` | how often to reclaim cards from wedged games |

`ARENA_BOT_DIFFICULTY=lookahead` is a poor choice here: it wants the opponent's
hand, and the server hides it. `greedy` is beatable but not random.

## Running a pool

```bash
npx tsx scripts/provision-arena-bot.ts --index 0 --cards 1000
npx tsx scripts/provision-arena-bot.ts --index 1 --cards 1000   # no offsets needed
ARENA_BOT_POOL_SIZE=2 ARENA_BOT_CHAIN=1 npm run pool -w packages/bot
```

**N processes, one identity each** — never one process with N identities.
`pxe.ts` binds its wallet in a module-level global, so a second identity in the
same process silently rebinds both to the last wallet connected; `BotChain`
throws rather than allow it. Each child gets its own manifest, PXE store and
health port (base + index). The supervisor restarts a dead child — a crashed bot
is holding five committed cards, and only a live process runs the sweep that
gets them back — but gives up on one that dies instantly and repeatedly, rather
than burying the real error under a scroll of restarts. Missing identities fail
before anything spawns.

Two rules keep a pool from being worse than a single bot, and both are enforced
by the **relay**, not here — only the server sees the queue at the moment of the
decision:

- **No bot-vs-bot.** Matchmaking picks the oldest HUMAN as creator and prefers a
  human joiner, and an all-bot queue matches nobody. Two bots playing each other
  would wager ten real cards and transfer one for nothing.
- **One bot per waiting human.** Bots decide to offer by polling `/queue`, so
  without this they all offer for the same person and the extras sit in the
  queue holding five committed cards until they time out. A redundant offer gets
  `QUEUE_DECLINED` (not `ERROR` — standing down is correct, and the error path
  would make a healthy pool look broken).

## Monitoring

Two endpoints, and they answer different questions:

- **backend `/metrics`** — what the relay can see: matches formed, how many
  involved the bot, outcomes, match-wait max/mean.
- **bot `/health`** (this package) — what only the bot process knows: proof and
  commit failures, card shortage, games the watchdog abandoned, cards recovered.
  `healthy` is the single field to page on. **An idle bot is not unhealthy** —
  idle with nobody queuing is normal, and alerting on it trains people to ignore
  the alert.

## Things that will bite you

- **One identity per PROCESS.** `pxe.ts` binds the wallet in a module-level
  global, so two identities in one process silently share the last-connected
  wallet. `BotChain` throws rather than let them merge. A pool is N processes.
- **The bot may hold DUPLICATE cards; players may not.** `mint_bot_cards` is the
  only mint that skips the one-NFT-per-`token_id` rule, and it is restricted to
  the addresses registered in the NFT's write-once arena-bot slots. So the bot's
  stock is not capped by the 256-card database and does not compete with players
  for ids. Provision as many as you like: `--cards 1000`.
- **The stock is WEAK on purpose.** It is drawn from the twelve lowest-ranked
  types, because every player who beats the bot permanently takes one of them —
  the collection is a payout schedule as much as a wager. It does not re-mint on
  its own: a silently-refilling bot is an unbounded card faucet.
- **Its notes are UNTAGGED, so the bot must import them.** Tagged delivery
  consumes a tagging index per note and caps at ~84 per finalisation window,
  which a deep stock blows straight through. The manifest therefore carries each
  note's plaintext and `BotChain` imports on connect — once, cached beside the
  manifest. On a rate-limited public node that first import is the burstiest
  thing the bot ever does; it retries 429s with backoff and resumes where it
  left off.
- **Committed cards vanish until the game resolves — and come back only if the
  bot imports them.** So "spendable" is legitimately lower than "owned" while a
  game is in flight. Settlement delivers nothing to anybody: each player rebuilds
  its own notes from its own secrets. Because the bot is always the joiner it
  cannot cancel a stuck game — cancel is creator-only — so its five cards stay
  locked until the game is settled or unwound.

## Recovering stranded cards

A game can wedge: the opponent closes their tab mid-move, a winner never
settles, this process dies. The bot cannot cancel, so those five cards stay put
until somebody resolves the game on-chain. Left alone the loss is monotonic and
**silent** — the bot goes idle when it runs out, which is correct behaviour and
therefore invisible.

Two pieces handle it, and both run automatically in chain mode:

- **`GameJournal`** (`.artifacts/games-<index>/`, one file per relay room)
  records each game from just BEFORE the join is sent — a crash while that tx is
  in flight is exactly when cards may be committed with nothing else recording
  where. It keeps what recovery needs and nothing more about the human: the room
  id, our key pair and their public key, the game key, our note nonce (our
  secrets re-derive from it), our hand, both records, the move transcript and
  the outcome. Records from the previous (public-state) contracts are left on
  disk untouched.
- **`AbandonmentSweep`** runs at startup and every `ARENA_BOT_SWEEP_INTERVAL_MS`.
  The CHAIN decides: each pass reads the game's nullifiers and takes the next
  step it is ready for — import from the resolving tx if the game is done;
  settle it on its merits if the bot holds the full transcript (contesting an
  opponent's standing claim first); otherwise claim it as abandoned once the
  chain is `MIN_ABANDON_SECONDS` past the join, and finalize the claim once it
  has stood `DISPUTE_SECONDS` — both hands back, nobody wins anything. Games
  younger than `ARENA_BOT_GAME_TIMEOUT_MS` are left alone: a finalize would take
  a slow winner's win away. No proofs are needed for any of it.

A record survives a failed step on purpose: deleting it would discard the only
evidence that five cards are locked. `sweep: … UNRECOVERABLE` means the journal
entry is missing what recovery needs.

To exercise the whole path against a sandbox:

```bash
E2E_ABANDON_AFTER_MOVES=2 ARENA_BOT_GAME_TIMEOUT_MS=120000 \
  npx tsx packages/bot/tests/chain-e2e.manual.ts
```
- **The bot is DISCLOSED**, via `opponentIsBot` on `MATCH_FOUND` and a badge in
  the HUD. `REGISTER_BOT` is token-gated precisely so a normal client cannot
  claim to be the bot and suppress that.

## Tests

```bash
npm test -w packages/bot          # unit + real backend/bot/human games
```

Proof tests generate REAL proofs against the compiled circuits — a mocked proof
asserts nothing about the thing that matters, which is that the bot's witness
encoding is accepted by the same circuits players use. The protocol's pure
decisions (prize choice, which notes to import, the sweep's next step) are in
`protocol.test.ts` and `settlement.test.ts`; the game flow against a fake chain,
including the real WebCrypto key exchange, in the two `ArenaBot` test files.

Two manual harnesses are excluded from `npm test` (each needs a sandbox,
deployed contracts and provisioned identities); their headers carry the recipes:

- `tests/chain-e2e.manual.ts` — a full chain game, key exchange through
  settlement and import, against a scripted creator.
  `E2E_ABANDON_AFTER_MOVES=2` makes the opponent walk out instead, exercising
  the journal and the recovery sweep (claim, dispute window, finalize).
- `tests/pool-e2e.manual.ts` — two chain bots and one human: asserts no
  bot-vs-bot game forms, the human is the creator, and no bot is left queued.
