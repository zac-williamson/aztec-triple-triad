# Item I — Funding / onboarding path (live testnet)

**Status:** SPIKE complete — go/no-go below. **Lane:** 2 (frontend) + a cross-lane
dependency. **Non-gating** for F3, but it IS the difference between "a stranger
plays in a minute" and "a stranger gives up at the bridge."

## The real gap

On the **local sandbox** onboarding already works one-click (C8): `useAztec.connect`
→ `fundAccountOnDevnet` bridges Fee Juice from Anvil's free faucet → combined
**deploy + `get_cards_for_new_player`** in one tx → menu shows 5 cards + 100 ARNA.
Target <60s. This is the experience we want on testnet.

On the **live testnet** there is no Anvil. The current path
(`useAztec.ts:92-95`) gives up to a manual round-trip: `status = 'needs-funding'`
→ `FundingPrompt` tells the user to copy their address, leave the app, visit an
**external bridge** (`bridge.gregojuice…` / `aztec-faucet.nethermind.io`), bridge
Fee Juice themselves, come back, and click "I've Funded My Account" → `confirmFunded`
deploys. That round-trip is the broken first minute.

Why the user can't just self-fund in-app (the hard constraint):

- **Fee Juice is non-transferable on L2** (`scripts/lib/feeJuiceBridge.ts:4-7`): an
  already-funded account cannot send Fee Juice to a new one. The only way in is to
  **bridge from L1 and have the new account claim the L1→L2 message** during a tx
  (`FeeJuicePaymentMethodWithClaim`).
- **Bridging needs an L1 (Sepolia) signer with ETH for gas.** The `FeeAssetHandler`
  (`node.getNodeInfo().l1ContractAddresses.feeAssetHandlerAddress`, present on
  testnet) mints the Fee Juice ERC20 *for free*, but `mint` + `approve` + portal
  `deposit` are all **L1 transactions** — gas is real Sepolia ETH.
- A brand-new browser user has **no L1 wallet and no Sepolia ETH**. So the
  L1-gas-paying step cannot happen client-side. **A hosted faucet must pay it.**

## What is already built (reuse, don't rebuild)

- `scripts/lib/feeJuiceBridge.ts` — `bridgeFeeJuice({ node, l1RpcUrl, funderKey,
  l2Address })`: FeeAssetHandler-mints (if needed), bridges, waits for the L1→L2
  message, returns a consumable `FeeJuiceClaim`. Treasury-keyed, network-agnostic,
  already used by `deploy-testnet.ts`/`fund-testnet.ts`, with a claim store + key
  handling. Its own header proposes a shared `packages/aztec-fee/` home.
- `connectToAztec.deployAndRegister(prepared, { feeJuiceClaim })` — the **combined
  deploy + mint in ONE tx via `FeeJuicePaymentMethodWithClaim`** (`connectToAztec.ts:212-273`).
  This is the proven devnet path; it mints 5 starter cards + 100 ARNA and imports
  the starter notes. Item I just needs to feed it a claim on testnet.

So the ONLY missing piece is: **obtain a consumable `FeeJuiceClaim` for the new
user's L2 address, in-app, without the user holding L1 ETH.** Everything downstream
(deploy → mint → import → menu) already exists and is tested.

## Proposed UX / flow

Replace the `needs-funding` → `FundingPrompt` → `confirmFunded` round-trip with a
single progress screen and zero user action:

1. User clicks **Play** (or a one-time "Enter the Arena"). App prepares the account
   (keys + address) as today.
2. App requests a claim: `requestFeeJuiceClaim(l2Address)` (new faucet abstraction).
3. App shows a **"Getting you set up…"** progress screen (funding → deploying →
   minting), driven by the existing `txProgress` events — no copy-paste, no tab switch.
4. `deployAndRegister(prepared, { feeJuiceClaim })` runs the proven combined tx.
5. On `connected`, auto-continue to the menu (5 cards, 100 ARNA). Record first-load→
   playable wall-clock (C8's <60s metric).
6. **Fallback** (faucet down / rate-limited): fall back to the current
   manual-bridge `FundingPrompt` with a clear message, so onboarding degrades
   instead of dead-ending.

New status flow: `connecting → funding → deploying → connected` (adds `funding`).

## Funding source — the decision (go/no-go)

The faucet abstraction has two viable backings; the choice is the go/no-go:

**Option B — project backend faucet (recommended primary).** A small backend
endpoint (Lane 4) `POST /faucet { l2Address } → { claim }` that runs the existing
`bridgeFeeJuice` with a server-held `TREASURY_L1_KEY` + Sepolia ETH, persists the
claim, and returns it. The frontend consumes it via the proven claim path.
- Pros: reuses our proven, tested bridge; full control; works regardless of any
  third-party faucet's API; one place to rate-limit.
- Cons/needs: **Zac funds a Sepolia treasury** (per-user L1 gas cost); **Lane 4**
  adds the endpoint + abuse mitigation (one claim per L2 address via the existing
  claim store; per-IP rate limit; cap mint amount). The treasury key NEVER reaches
  the browser.

**Option C — hosted public faucet API (frontend-only, IF it exists).** If
`aztec-faucet.nethermind.io` (or another hosted faucet) exposes a programmatic,
CORS-open endpoint that bridges to an L2 address **and returns a consumable claim**,
the app calls it directly — no backend, no treasury, ~1 day.
- Unknowns to verify before relying on it: (1) does it expose an HTTP API at all, or
  UI-only? (2) does it return the **claim secret** (required to consume), or only a
  tx hash / a balance top-up? (3) CORS from the Vercel origin? (4) rate limits?
  If it only tops up a balance (no claim secret), we'd use the native-payment deploy
  path instead of the claim path — workable but less proven here.

Recommendation: **build the faucet abstraction with a swappable backing**, target
**Option B** as the reliable default (it reuses code we already trust), and treat
Option C as a verify-then-maybe-simplify — if a hosted API checks out, the same
frontend abstraction points at it and we skip the backend + treasury entirely.

## Integration scope (after go)

- **Lane 2 (me, ~1d):** `aztec/requestFeeJuiceClaim.ts` (faucet abstraction, config-
  driven backing); `useAztec.connect` testnet branch → request claim →
  `deployAndRegister({ feeJuiceClaim })` → poll/auto-continue, new `funding` status;
  progress screen; keep `FundingPrompt` as the degraded fallback; config for faucet
  mode/URL. Tests: claim-request mocked, the testnet branch reaches `connected`,
  fallback on faucet error. **SponsoredFPC stays banned — Fee Juice only.**
- **Lane 4 (if Option B, ~0.5d): DONE 2026-06-13** (`lane/4-backend`). `POST /faucet
  { l2Address } → { claim, reused }` wraps `bridgeFeeJuice` with the three abuse
  caps (one/address via the existing claim store, per-IP/day, global/day). Logic
  is Aztec-free + unit-tested (`src/faucet/`, 35 tests); the SDK touch is
  quarantined to a runtime-only loader (`createTreasuryFaucet.ts`) so the relay
  build stays SDK-free. Off unless `FAUCET_ENABLED=true`. Wire contract + the
  `503 → manual fallback` path Lane 2 should consume are specced in
  `LANE_4_BACKEND.md` (item I); box wiring (compiled bridge module, systemd RW
  paths) is in `deploy/DEPLOY.md §2g` and finishes with F3.
- **Zac (if Option B):** fund a Sepolia treasury; decide acceptable per-user gas cost
  + rate limits.

## Go/no-go questions for the orchestrator / Zac

> **Update (orchestrator, 2026-06-13):** the Sepolia **treasury already exists and is
> funded (~0.4 ETH)**, and `bridgeFeeJuice` is proven (used by `deploy-testnet`), so
> **Option B is ~90% there** — what remains is the Lane-4 `/faucet` endpoint + abuse
> limits, and the one real tradeoff to weigh: **Option B puts `TREASURY_L1_KEY` on the
> backend** (mitigations: dedicated low-balance hot treasury, per-address/IP rate
> limits, capped mint amount). Go/no-go + launch priority are Zac's call; surfaced to
> him. Lane 2 is parked until the decision lands.

1. **Funding source:** Option B (backend treasury faucet — reliable, treasury already
   funded; remaining: Lane-4 endpoint + the backend-key security tradeoff) or first
   verify Option C (a hosted faucet API that returns a consumable claim — frontend-only
   if it exists)?
2. If B: acceptable abuse limits (one claim/address + per-IP/day) and hot-treasury
   balance cap?
3. Priority: item I is non-gating for F3 — slot it before launch for the demo's
   first-minute, or fast-follow after F3?
