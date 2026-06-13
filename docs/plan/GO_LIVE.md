# F3 Go-Live Runbook — www.aztec-arena.com + wss://ws.aztec-arena.com

Validated 2026-06-13. This is the exact sequence to take the 4.3.1 build live.
Everything here has been recon'd against the real accounts/box; only the two
gated actions remain.

## Preconditions

1. **Playtest acceptance is GREEN** (lane/8-playtest STATUS: done — full A1+A2 gate on
   4.3.1). As of 06-13 this is **attempt 6+**, after the C2 replay fix (BUG_C2_REPLAY.md).
2. ✅ **DONE — DNS + TLS.** `ws.aztec-arena.com → 13.42.161.225` (Vercel-managed, updated
   via token) and certbot issued the cert. Backend live at `wss://ws.aztec-arena.com`
   (verified). Step 1 below is already complete.
3. **Testnet contract update (NEW).** The C2 fix changed `triple_triad_game`, so the deployed
   instance (`0x2d86…`) is stale and must be updated to the new class (address-preserving,
   admin `update_to` — contracts are updatable) before the frontend goes live, or settlement
   reverts. Only the game contract changed this round (NFT + token unchanged). Confirm the exact
   update invocation against the deploy script at go-live time; verify the exact mechanism then.

Until the frontend is validated AND the contract is updated, do not publish — an interim
deploy would point the app at an unvalidated build / stale contract.

## Current state (already done)

- Backend is LIVE on HTTP on `13.42.161.225`: systemd `triad-backend` active,
  `/health` OK both directly (:5174) and via nginx (:80). Port 80 reachable from
  the internet (certbot HTTP-01 will pass). Port 443 closed (no cert yet).
- nginx is HTTP-only (deploy fix 122568d); certbot will inject the TLS block.
- Vercel project `aztec-arena` (owner zac-williamson) → www.aztec-arena.com,
  git-connected. Token at `~/.aztec-triad-private/vercel-token.txt` validated.
- `vercel.json` runs plain `vite build` and `.env` is gitignored, so the
  production build reads **only Vercel dashboard env vars** — those still hold
  April's defunct contract addresses and a localhost WS URL.

## Step 1 — TLS on the backend (after DNS propagates)

SSH to the box and re-run just the certbot step (the whole provision script is
idempotent, but this is faster):

```bash
ssh -i ~/.ssh/aztec_deploy ubuntu@13.42.161.225 \
  'sudo certbot --nginx -d ws.aztec-arena.com --non-interactive --agree-tos \
     -m zac@aztec.foundation --redirect && \
   curl -fsS https://ws.aztec-arena.com/health'
```

Expect `{"status":"ok","games":0}` over HTTPS. certbot auto-adds the 443 server
block + 80→443 redirect and installs a renewal timer. (Keep the security-group
HTTP :80 rule open — Let's Encrypt renews over HTTP-01.)

## Step 2 — Vercel production env vars (overwrite all 6)

The build is entirely driven by these. Set them on the `aztec-arena` project,
`production` target. Idempotent via the API with `upsert=true`:

```bash
TOK=$(cat ~/.aztec-triad-private/vercel-token.txt | tr -d '[:space:]')
set_env () { # name value
  curl -fsS -X POST "https://api.vercel.com/v10/projects/aztec-arena/env?upsert=true" \
    -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
    -d "{\"key\":\"$1\",\"value\":\"$2\",\"type\":\"plain\",\"target\":[\"production\"]}" \
    >/dev/null && echo "set $1"
}
set_env VITE_AZTEC_PXE_URL       https://rpc.testnet.aztec-labs.com
set_env VITE_NFT_CONTRACT_ADDRESS   0x03c4a439df5a6b44a645037050b9de4af201f4327240c09b2c0a77fba5d59a9c
set_env VITE_GAME_CONTRACT_ADDRESS  0x2d8675fc746e38ff6606cae2836c0cd0fa1693b12edb56396f83a530109b75f4
set_env VITE_TOKEN_CONTRACT_ADDRESS 0x0ed08cbbb2eac1213186c99787736e0ee768dfa9ffa9dfc1a4b9c1d741e870fb
set_env VITE_AZTEC_ENABLED       true
set_env VITE_WS_URL              wss://ws.aztec-arena.com
```

(If the team scope rejects the bare project path, append `&teamId=<id>` from
`GET https://api.vercel.com/v2/teams`. The CLI fallback per var is
`vercel env rm NAME production --yes && printf '%s' VALUE | vercel env add NAME production`.)

## Step 3 — Trigger a production deploy

The project is git-connected to www.aztec-arena.com. Either push the production
branch Vercel tracks, or from the repo root:

```bash
npx vercel deploy --prod --token "$TOK" --yes
```

Env-var changes only take effect on a NEW build — Step 3 is what actually ships
the new addresses + wss URL.

## Step 4 — Smoke test

```bash
curl -fsS https://ws.aztec-arena.com/health         # backend over TLS
# Browser: open https://www.aztec-arena.com — connect wallet, confirm it talks
# to the testnet node + the live ws relay (no localhost in network tab),
# create a game, verify the WS connection is wss:// and contracts resolve.
```

Then update `docs/plan/TRIAL_LOG.md` and the README live-URL line (lane-7 has
that doc staged).
