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
3. **Testnet contract deploy (FRESH REDEPLOY model — see UPDATE_MODEL.md).** Updates are a complete
   fresh `deploy-testnet.ts` of all 3 contracts (immediate, new addresses) — NOT the Aztec upgrade
   pattern (that path is clamped to a 24h delay on this rollup; the `update_to`/`set_update_delay`
   slop is being removed). Fresh deploy is all-3-together (NFT stores the game addr as
   PublicImmutable). `deploy-testnet.ts` writes the new addresses to `packages/frontend/.env.testnet`;
   then update the Vercel prod env to those **new** addresses + redeploy.

Until the frontend is validated AND the contract is updated, do not publish — an interim
deploy would point the app at an unvalidated build / stale contract.

4. **Item I faucet (ONLY if Item I ships with launch — non-gating; complete as of fbed226+1f02092).**
   To enable `POST /faucet` on the box: (a) put `TREASURY_L1_KEY` (the funded Sepolia wallet
   `0xDA74…DEAa2`; currently only in `~/.aztec-triad-private/treasury-l1-key.txt`) + `FAUCET_ENABLED=true`
   in `/etc/triad-backend.env` — server-only, never to the browser; (b) uncomment
   `ReadWritePaths=/home/ubuntu/.aztec-triad-private` in `triad-backend.service` (ProtectHome=read-only
   otherwise blocks the key read + claim-store write), then `systemctl daemon-reload`; (c)
   `systemctl restart triad-backend`. Skip all of this if Item I is fast-follow.

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
