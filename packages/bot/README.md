# @axolotl-arena/bot — the arena bot

A backend opponent that plays like any other player: it watches the matchmaking
queue and, when somebody has waited past a threshold, queues itself and lets the
server's ordinary `tryMatch` pair them. In chain mode it commits real cards,
generates real proofs, and settles on-chain.

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
npx tsx scripts/provision-arena-bot.ts --index 0 --cards 40 --offset 0

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
| `ARENA_BOT_JOIN_THRESHOLD_MS` | `20000` | how long a player waits before the bot offers |
| `ARENA_BOT_DIFFICULTY` | `greedy` | `random` \| `greedy` \| `lookahead` |
| `ARENA_BOT_MOVE_DELAY_MS` | `1200` | pacing, so it does not feel inhumanly instant |
| `ARENA_BOT_QUEUE_TIMEOUT_MS` | `60000` | leave the queue if no match forms |
| `ARENA_BOT_GAME_TIMEOUT_MS` | `1800000` | abandon a stuck game and recover its cards |
| `ARENA_BOT_SETTLE_WAIT_MS` | `300000` | wait for the 11-proof transcript |
| `ARENA_BOT_HEALTH_PORT` | `5175` | `0` disables |
| `ARENA_BOT_MAX_CONCURRENT_GAMES` | `1` | see the pool note below |

`ARENA_BOT_DIFFICULTY=lookahead` is a poor choice here: it wants the opponent's
hand, and the server hides it. `greedy` is beatable but not random.

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
- **`token_id`s are globally unique.** The whole pool draws from ONE 257-card
  budget, so every identity needs a disjoint `--offset` slice.
- **The collection is a LOSS BUDGET.** Every player who beats the bot
  permanently takes a card. It does not re-mint on its own — deliberately: a
  silently-refilling bot is an unbounded card faucet and is hard to walk back.
  Watch `cardsRecovered` and the spendable count.
- **Committed cards vanish until the game settles.** So "spendable" is legitimately
  lower than "owned" while a game is in flight, and a game that never settles
  strands five cards until the watchdog cancels it (creator side) or the
  abandonment path is used (joiner side).
- **The bot is DISCLOSED**, via `opponentIsBot` on `MATCH_FOUND` and a badge in
  the HUD. `REGISTER_BOT` is token-gated precisely so a normal client cannot
  claim to be the bot and suppress that.

## Tests

```bash
npm test -w packages/bot          # 64: unit + a real backend/bot/human game
```

Proof tests generate REAL proofs against the compiled circuits — a mocked proof
asserts nothing about the thing that matters, which is that the bot's witness
encoding is accepted by the same circuits players use.

`tests/chain-e2e.manual.ts` runs a full chain game against a local sandbox. It
is excluded from `npm test` (needs a sandbox, contracts and two provisioned
identities); its header carries the recipe.
