# F3 Go-Live Runbook — www.aztec-arena.com + wss://ws.aztec-arena.com

Validated 2026-06-13. This is the exact sequence to take the 4.3.1 build live.
Everything here has been recon'd against the real accounts/box; only the two
gated actions remain.

## Preconditions (BOTH must be true before any step below)

1. **Playtest attempt-5 acceptance is GREEN** (lane/8-playtest STATUS: done — A1+A2
   gate passed on 4.3.1). Tracked by monitor + cron sweep.
2. **DNS: `ws.aztec-arena.com` A-record → `13.42.161.225`** (currently still
   `16.60.85.104`, the dead April box). **← Zac's one action.** Verify with:
   `dig +short ws.aztec-arena.com` → must return `13.42.161.225`.

Until BOTH hold, do not deploy the frontend — an interim deploy points the app at
a `wss://` endpoint with no cert and/or unvalidated game code.

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
