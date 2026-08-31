# Production readiness — open items

Working list, kept in priority order. Each item states what is wrong, how we
know, and what "done" looks like — because several things on this list were
previously believed done on the strength of a check that could not fail.

Status: `OPEN` · `IN PROGRESS` · `DONE` · `ACCEPTED` (a decision, not a defect)

Context: as of 31 Aug 2026 the full flow is verified on the deployed app —
onboarding from an ETH-only wallet, a nine-move game against the bot, and all
three settlement paths (winner, loser, draw) with the wagered card actually
changing hands. `packages/playtest/scripts/prod-play.mts` is what proves it.

---

## P1 — Correctness, unexplained

### 1. Winner's +20 ArenaToken did not appear · `DONE` (31 Aug)
Was the harness sampling early, not a lost reward — but only provably so after
the harness was made to wait for it.

The token note uses ONCHAIN_CONSTRAINED delivery and needs a PXE block sync, so
the app refreshes the balance ~5s AFTER the cards land. Reading both together
caught 100. With an explicit wait the run reports
`6 cards [1,2,3,4,5,5], 120 tokens`.

prod-play.mts now fails if the reward does not arrive, so this cannot be
assumed away again.

### 2. Cards stranded by abandoned games · `DONE` (31 Aug) — cause fixed
The bot no longer commits cards it could not recover.

Recovery requires BOTH hand proofs, and the bot used to commit as soon as
player 1's create_game confirmed — before the opponent had proved anything. A
player who left in that window stranded five cards permanently.

It now shares its randomness (which is what unblocks THEIR hand proof, so this
cannot deadlock), waits for that proof, and only then commits. If it never
arrives, nothing was ever at stake and the watchdog tidies up.

The five already stranded in `0x162a5204…` and `0x16db8bf8…` remain
unrecoverable — the claim needs a proof that was never made. Bounded, visible
as `cardsStranded`, and can no longer grow from this cause.

### 2b. Original text, for the record · `CLOSED`
Five cards are locked in games the bot can never claim (its journal is missing
the opponent's hand proof), and two such games are known:
`0x162a5204…`, `0x16db8bf8…`. Health reports `cardsStranded: 5`.

Mostly self-inflicted during this session's runs, but a player who closes their
tab produces the same thing.

**Done when:** the sweep can recover a game whose opponent never proved, or we
can state precisely why it cannot and the loss is bounded and monitored.

---

## P2 — Confidence in the result

### 3. Nothing runs the production check on a schedule · `OPEN`
`prod-play.mts` works on demand. One green run is an anecdote; the bugs found
this session were mostly things that only appear under repetition or load.

**Done when:** it runs on a schedule (or a documented pre-release ritual) and a
failure reaches a human. Note it costs a real Sepolia-funded account and ~25
minutes per run, so cadence is a judgement call.

### 4. The uptime probe runs on the box it monitors · `DONE` (31 Aug)
`.github/workflows/uptime.yml` runs every ten minutes on GitHub's
infrastructure, so it survives anything that takes the box with it. It checks
only what an outsider can see — the relay answers, the site serves an app
bundle, and the testnet has not re-genesised (a pinned `rollupVersion`, since
that failure looks like a perfectly healthy site with a game that can never
start). The bot's internals stay with the on-box probe, whose /health is bound
to localhost on purpose.

**One thing to know:** scheduled workflows only run from the DEFAULT branch,
which is `main` — 507 commits behind `testnet`. The file therefore has to be
on `main` to fire at all. It needs no checkout, so a stale `main` costs it
nothing.

### 5. Player-vs-player never exercised on production · `OPEN`
Every production run has been human-vs-bot. Two humans is the intended primary
path and has only ever been tested on a local sandbox.

**Done when:** two browsers complete a game against each other on the deployed
app, settlement included.

---

### 13. Sweep retries a claim that cannot succeed · `DONE` (31 Aug)
The abandonment sweep repeatedly attempts a game with 7/9 moves and fails:

    sweep: 0x141176f6… abandoned (242min, 7/9 moves) — claiming
    sweep: 0x141176f6… FAILED — Assertion failed:
      It must be opponent's turn to claim abandonment

Every fifteen minutes, indefinitely, each attempt spending a proof and a
transaction on something the contract will always reject. The claim is only
valid when it is the ABSENT player's turn; the sweep does not check the move
parity before trying.

**Fixed.** The bot is always player 2, and the contract accepts an
abandonment claim only when it is the OTHER side's turn — an even move count.
An odd count means the next move is ours: we stalled, nobody abandoned, and
the assertion can never pass. The sweep now checks parity, reports the game as
not claimable by us once, and counts the locked cards instead of retrying.

The test fixture had encoded the same misunderstanding — a three-move record
for a player-2 claimant describes a game the chain would always refuse.

---

## P3 — Operability

### 6. An abandoned game locks the bot for 30 minutes · `OPEN`
The watchdog is correct but coarse: while it waits, the arena has no opponent
for anyone. Repeatedly hit during this session.

**Done when:** a disconnect the relay already knows about ends the bot's game
promptly, rather than waiting out a timer meant for silence.

### 7. `readPrivateCards` is O(collection) · `OPEN`
It pages ten cards at a time — 46 seconds at 1,382 cards. Cached for the bot,
so the queue no longer floods, but the cost is still paid on a cold read and a
player with a large collection pays it in the UI.

**Done when:** the read is bounded, or paged lazily, or we accept it with a
stated collection ceiling.

### 8. `[pxe-queue]` diagnostics log to player consoles · `OPEN`
Deliberate and useful for support, but new noise in every player's devtools.

**Done when:** gated behind a debug flag, or consciously kept.

---

## P4 — Cosmetic, on the deployed site

### 9. Four assets 404 · `OPEN`
`aztec-symbol.png` and three model textures
(`PolygonNatureBiomes_Texture_01_Justin.psd`, `..._Tom.png`,
`Bake_02_baseTexBaked.png`). No functional impact; they make the network log
noisy enough to hide a real 404 — which is exactly how the OPFS worker hid.

### 10. Overlapping controls, bottom right · `OPEN`
"Repair Chain Sync" and "Clear All State" render on top of each other.

---

## Mainnet — beyond testnet-ready

### 11. No contract audit · `OPEN`
The card-commitment binding bug found earlier in this project — where nothing
tied claimed card ids to the commitment — is precisely what an audit exists to
catch, and it was found by chance.

### 12. `DEFAULT_FEE_JUICE_TARGET` uncalibrated · `OPEN`
1e18, chosen as a plausible number rather than measured. Too low strands a
player mid-game with no way to buy more without leaving the app. Now
measurable: the bot's real consumption is on `/health`.

---

## Decided, not defects

- **Single box** · `ACCEPTED` — no failover for relay or bot. Fine at launch;
  see item 4, which is the part that still needs doing.
- **Bot capacity** · `ACCEPTED` — one concurrent game. With real traffic players
  match each other and the bot is a cold-start amenity.
- **Card supply / minting** · `ACCEPTED` — the bot wagers weak duplicate starter
  cards with no intrinsic value, so refilling by minting dilutes nothing.
  Runbook in `deploy/DEPLOY.md`.
- **Offsite manifest backup** · `ACCEPTED` — the cards are worthless test
  assets, so losing the manifest costs a re-provision, not value. Revisit for
  mainnet. Note the file also holds the bot's account keys, so any copy is
  encrypted.
