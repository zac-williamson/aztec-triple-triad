# @axolotl-arena/bot — the arena bot

A backend opponent that plays like any other player: it watches the matchmaking
queue and, when somebody has waited **more than 30 seconds**, queues itself and
lets the server's ordinary `tryMatch` pair them. In chain mode it commits real
cards, generates real proofs, and settles on-chain.

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

set -a; . packages/frontend/.env; set +a          # contract addresses
ARENA_BOT_TOKEN=... ARENA_BOT_CHAIN=1 \
AZTEC_PXE_URL=http://localhost:8080 \
  npm run dev -w packages/bot
```

It refuses to start half-configured: a bot that matches players and then cannot
commit its cards is worse than one that never starts.

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
| `ARENA_BOT_SETTLE_WAIT_MS` | `300000` | wait for the 11-proof transcript |
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
- **Committed cards vanish until the game settles.** So "spendable" is legitimately
  lower than "owned" while a game is in flight. Because the bot is always the
  joiner it cannot cancel a stuck game — cancel is creator-only — so its five
  cards stay locked until the abandonment claim resolves it.

## Recovering stranded cards

A game can wedge: the opponent closes their tab mid-move, a proof never arrives,
this process dies. The bot cannot cancel, so those five cards are locked until
somebody claims the game as abandoned. Left alone the loss is monotonic and
**silent** — the bot goes idle when it runs out, which is correct behaviour and
therefore invisible. Measured on the sandbox: 25 cards per identity across five
aborted runs.

Two pieces handle it, and both run automatically in chain mode:

- **`GameJournal`** (`.artifacts/games-<index>/`) persists each committed game's
  transcript **as it grows**. Recovery needs the hand proofs and partial move
  chain, which otherwise exist only in memory — and the crashes this protects
  against happen mid-game by definition, so writing once at the end would
  protect nothing.
- **`AbandonmentSweep`** runs at startup and every `ARENA_BOT_SWEEP_INTERVAL_MS`:
  claim → dispute window (5 blocks) → settle → import the re-minted notes. The
  chain decides, never the journal; games younger than `ARENA_BOT_GAME_TIMEOUT_MS`
  are left alone, since claiming a live game reverts. It takes an opponent card
  only if the opponent actually played — getting our stake back is the point.

A record survives a failed pass on purpose: deleting it would discard the only
evidence that five cards are locked. `sweep: … UNRECOVERABLE` means the journal
never captured enough transcript (needs both hand proofs and 1–8 move proofs) —
those cards are gone.

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
npm test -w packages/bot          # 107: unit + real backend/bot/human games
```

Proof tests generate REAL proofs against the compiled circuits — a mocked proof
asserts nothing about the thing that matters, which is that the bot's witness
encoding is accepted by the same circuits players use.

Two manual harnesses are excluded from `npm test` (each needs a sandbox,
deployed contracts and provisioned identities); their headers carry the recipes:

- `tests/chain-e2e.manual.ts` — a full chain game, commit through settlement.
  `E2E_ABANDON_AFTER_MOVES=2` makes the opponent walk out instead, exercising
  the journal and the recovery sweep.
- `tests/pool-e2e.manual.ts` — two chain bots and one human: asserts no
  bot-vs-bot game forms, the human is the creator, and no bot is left queued.
