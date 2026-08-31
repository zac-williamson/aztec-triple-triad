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

### 3. Nothing runs the production check on a schedule · `DONE` (31 Aug)
`RUNS=n ./scripts/prod-smoke.sh` plays real games against the deployed app and
fails loudly, and running it is now part of the release runbook
(`deploy/DEPLOY.md`, "Before announcing a release: play a real game").

It earned its place immediately. On its second run it caught a real production
bug — `MOVE_PROOF_WAIT_TIMEOUT` was 30s, but the ninth move proof is generated
AFTER the relay declares the game over, so the winner timed out at 8/9, went
idle, and since a win has exactly one settler the game stranded five cards a
side. Now 180s, with tests pinning it to the hand-proof budget.

It also cried wolf once, which was worse than useless: it decided pass/fail by
grepping for settlement wording that the losing path never prints, and reported
a perfect game as a failure. prod-play now prints one fixed-shape verdict line
and the script reads that.

**Not scheduled, deliberately.** Scheduling means a funding key in CI and ~25
minutes of runner time per run. The ten-minute uptime probe (item 4) answers
"is it up"; this answers "does it still work", on a human's decision to ship.
Worth revisiting if releases become frequent.

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

### 6. An abandoned game locks the bot for 30 minutes · `DONE` (31 Aug)
The relay had been sending `OPPONENT_DISCONNECTED` the whole time and the bot
ignored the message, then sat in `playing` until a thirty-minute watchdog meant
for SILENCE — which cannot tell a slow player from a departed one, and so has
to be generous. A disconnect is not silence: the relay watched it happen.

The bot now starts a 90s countdown on it and cancels on `OPPONENT_RECONNECTED`
(also already sent). 90s because the relay's own reconnection window is 60s, so
a wifi blip is not a forfeit.

Two things it deliberately does not do. It does not abandon a game it is
settling — the loser closing their tab the moment the result appears is
ordinary, and arrives while the winner is still assembling an 11-proof
transcript. And it does not change what abandoning means: committed cards stay
locked pending the abandonment claim and are still counted on `/health`. The
gain is the twenty-eight minutes, not the cards.

Six tests, each failing without the part of the fix it covers, and verified on
production by matching a real game and closing the tab:

    22:00:57  matched into 0x80e1f059… as player2
    22:01:02  opponent disconnected — giving them 90s to come back
    22:02:34  opponent disconnected and did not come back — abandoning
    22:02:39  state=idle

Ninety-seven seconds, against thirty minutes before. `cardsStranded: 0`, since
nothing had been committed — item 2's fix and this one meeting as intended.

### 7. `readPrivateCards` is O(collection) · `ACCEPTED` (31 Aug) — with a ceiling
It is worse than O(collection): it is **quadratic**, and the reason matters,
because it rules out the obvious fixes.

The contract asks for ten notes at an offset, but the PXE never pushes that
offset down to storage. `NoteService.getNotes` passes no limit or offset to the
note store — it loads EVERY note for the slot — and `pickNotes` then does
`.slice(offset, offset + limit)` on the resulting array in memory. Every page
costs a full collection scan, so reading N cards costs about N²/10 note loads.
(aztec-packages `pxe/src/notes/note_service.ts` and
`pxe/src/contract_function_simulator/pick_notes.ts`.) A larger page size would
not help; the per-page cost is the scan, not the ten.

**The ceiling:** comfortable into the low hundreds of cards, unpleasant past
roughly five hundred, 46s at 1,382. A player's collection is five starter cards
plus ten per pack plus one per win, so reaching that means buying about fifty
packs. The only holder anywhere near it is the bot, which caches.

**Why not fixed:** a bigger page needs a contract change, and a redeploy
orphans every player's cards. Refreshing by delta instead of re-reading avoids
the scan but introduces a local idea of the collection that can drift from the
PXE's — which is exactly the failure this codebase has already paid for
("Could not find all 5 cards").

A read over five seconds now records a diagnostic line, so a player who does
reach the slow end is visible to support instead of just finding the app
sluggish.

### 8. `[pxe-queue]` diagnostics log to player consoles · `DONE` (31 Aug)
Recording and printing are now separate concerns. Every line goes into a
200-entry ring buffer always; it is printed only when `triad_debug` is set or
the page is under the harness. Support can ask a player to run
`__triadDiagnostics()` and paste the result.

A flag alone would have been the wrong fix: whoever hits the problem has the
flag off, and turning it on means asking them to reproduce a bug that took an
hour to hit once. The buffer also survives a localStorage that throws (private
mode, sandboxed frame, storage disabled), which is where support is hardest.

---

## P4 — Cosmetic, on the deployed site

### 9. Four assets 404 · `DONE` (31 Aug)
Two unrelated causes.

`aztec-symbol.png` was a favicon reference to a file that was never in the
repo — and the wrong brand anyway, since the game is Axolotl Arena. Replaced
with an actual `favicon.svg` in the app's own palette.

The three textures are named inside the FBX models, from the artist's original
project (one is a `.psd`), and the pack never shipped them. The app assigns its
own materials from `/textures`, so the references are dead weight — but the
loader still fetched each one. The FBX loader now runs through a
`LoadingManager` that answers any texture request under `/models` with a
transparent pixel, which is structural rather than a list of filenames:
`/models` holds `.fbx` and nothing else, so every texture asked for there is
one we do not have. That covers the other thirteen names in those files too.

### 10. Overlapping controls, bottom right · `DONE` (31 Aug)
Both buttons were `position: fixed; bottom: 16px; right: 16px`, so each claimed
the same corner. They now sit in one flex row that owns the corner.

While there: one of them repairs and the other is irreversible, and they looked
identical. "Clear All State" now gets a distinguishing hover and the title text
the repair button already had.

---

## Mainnet — beyond testnet-ready

### 11. No contract audit · `OPEN`
The card-commitment binding bug found earlier in this project — where nothing
tied claimed card ids to the commitment — is precisely what an audit exists to
catch, and it was found by chance.

### 12. `DEFAULT_FEE_JUICE_TARGET` uncalibrated · `DONE` (31 Aug)
Measured, and the old number was not merely unproven — it was wrong by about
7x, in the dangerous direction.

Fee Juice balances live in public storage, so any account can be read with
nothing but its address (`scripts/fee-juice-used.ts`, no keys, no PXE). Eight
throwaway accounts from real production runs come out cleanly bimodal:

    deploy + create_game + play, no settlement   4.217 – 4.343e18   (4 accounts)
    the same, plus settling the game             6.676 – 6.751e18   (4 accounts)

So onboarding plus one game is ~4.3e18 and settlement adds ~2.4e18. At 1e18 a
mainnet player would have run dry before their first move — the exact failure
the constant exists to prevent, since they cannot buy more without leaving the
app.

Now 50e18: onboarding plus roughly five settled games with ~75% headroom.
Erring high is the cheap direction — too much means Fee Juice bought early,
too little means a game that cannot be finished. Three tests hold it against
the measurements.

**No effect on testnet**, where the fee asset has a faucet: `resolveAcquireRoute`
returns the mint route before it ever reads the target, and the faucet mints
1e21 regardless. This is the mainnet swap path only, and should be re-measured
against mainnet's fee market before launch.

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
