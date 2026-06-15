# Live-testnet verification (F3 smoke) — point the harness at testnet

**Goal (Zac):** prove the deployed app actually plays end-to-end on the LIVE testnet, not just the
local sandbox. Local C-multi is GREEN; this closes the real gap (`games:0` on the live backend).

## Key constraint — you CANNOT drive www.aztec-arena.com directly
The testkit (`window.__triadTest`) is `VITE_TESTKIT`-gated and **dead-code-eliminated in the Vercel
prod build**, so the live site has no test hooks. So run a **local vite with `VITE_TESTKIT=1` pointed
at the live testnet** — same app code, real testnet contracts + real backend:
- `VITE_AZTEC_PXE_URL = https://rpc.testnet.aztec-labs.com`
- `VITE_*_CONTRACT_ADDRESS` = the **deployed testnet addresses** (read them from the live Vercel env or
  the last `deploy-testnet.ts` output / frontend `.env.testnet` — confirm they match what the live site uses)
- `VITE_WS_URL = wss://ws.aztec-arena.com`, `VITE_AZTEC_ENABLED = true`, `VITE_TESTKIT = 1`
- Do NOT spawn the local sandbox/anvil/backend in this mode — the stack is the live testnet + live ws relay.
  (Keep the reaper, serial PXE, node keepalive, fail-fast liveness.)

## Funding
Real accounts need Fee Juice. Use the live faucet (Item I, `POST https://ws.aztec-arena.com/faucet` or
the in-app path) to fund each player's L1 → bridge → claim at deploy. Two isolated wallets, serial
onboarding (shared funding key races). Zac has authorized the Fee Juice spend.

## Timeouts — testnet is MUCH slower than the local sandbox
The local sandbox runs `SEQ_MIN_TX_PER_BLOCK=0` (instant empty blocks). Testnet has real ~36s slots +
real proving + L1 bridge waits. Onboarding (bridge+claim+deploy+mint) can be many minutes; each chain tx
waits real block inclusion. Scale `onboarding`/`match`/`settleTx`/`packTx` timeouts up accordingly, and
keep the per-phase `withDeadline` + backend-liveness guards (so a real failure still fails fast with a
clear reason, not a zombie).

## Sequence (don't burn fees until the plan is sound)
1. STATUS your live-target config plan first (URLs, where you read the deployed addresses, funding, timeouts).
2. **One full game first** (onboard 2 wallets → create → 9 moves → settle on testnet) — prove the live
   create/move/settle path works at all. Verify via artifacts (on-chain settle tx, taken card) + the
   testnet explorer / `get_game_status`.
3. Only then the multi-game campaign (packs → consecutive games) if Zac wants the full thing on testnet.
4. Report: did the live testnet flow work end-to-end? Per-game evidence. No mask — if onboarding/settle
   fails on testnet, root-cause it (it may surface real testnet-only issues the local sandbox hid).

This is F3 smoke = the last substantive item. After a GREEN live game, lane-7 writes the live-URL doc and
the demo is genuinely "works on www.aztec-arena.com".
