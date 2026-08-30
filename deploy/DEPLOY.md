# Deploying Axolotl Arena to testnet

End-to-end guide to get the app running on a real domain, pointed at the
Aztec testnet.

**Architecture:**

```
  play.YOURDOMAIN.com          ws.YOURDOMAIN.com
  ─────────────────            ─────────────────
       Vercel                  AWS Lightsail
         │                     ┌──────────────┐
   (static Vite)                │    Nginx     │  :443 TLS
         │                     │      │       │
         │                     │      │       │  :5174 internal
         │ ◄──── wss:// ─────► │     Node     │
         │                     │      │       │
         │                     │   Redis      │  :6379 localhost
         │                     └──────────────┘
         │
         └────── https ────►  rpc.testnet.aztec-labs.com  (PXE / Aztec node)
```

Two domains, two hosts, one Redis, zero horizontal scaling. Matches the
architectural decisions made in the re-architecture work.

---

## Prerequisites

- A domain you control (any registrar).
- An AWS account with billing enabled.
- A Vercel account.
- The repo pushed to GitHub (Vercel and the Lightsail box both pull from it).
- Your Aztec signer credentials for contract deployment (kept on your laptop,
  never on the Lightsail box).

---

## Step 1 — Deploy the contracts to testnet

Run this from your laptop, NOT from the Lightsail box. Contract deployment
credentials stay off the server.

```bash
# Create a new deployer account on testnet (one-time).
AZTEC_PXE_URL=https://rpc.testnet.aztec-labs.com \
  npx tsx scripts/deploy-testnet.ts --create-account
# Prints DEPLOYER_SECRET / SALT / SIGNING_KEY — save these in a password manager.

# Fund the deployer account with testnet fee juice (see Aztec testnet docs).

# Deploy the three contracts.
DEPLOYER_SECRET=0x... \
DEPLOYER_SALT=0x... \
DEPLOYER_SIGNING_KEY=0x... \
AZTEC_PXE_URL=https://rpc.testnet.aztec-labs.com \
  npx tsx scripts/deploy-testnet.ts
```

This writes `packages/frontend/.env` with the three contract addresses.
Copy those three addresses — you'll paste them into Vercel in step 3.

---

## Step 2 — Provision the Lightsail instance for the backend

### 2a. Create the instance

1. AWS console → **Lightsail** → **Create instance**.
2. Platform **Linux/Unix**, blueprint **OS Only → Ubuntu 22.04 LTS**.
3. Instance plan: **$5/month** (512 MB RAM, 1 vCPU, 20 GB SSD) is enough.
   Bump to $10 if you run into OOM during proof relay bursts.
4. Instance name: `triad-backend`.
5. Create.
6. Once it's up: **Networking** tab → **Create static IP** and attach it.
   Note the IPv4 address.
7. **Networking** → **IPv4 Firewall** → add rules for `HTTP 80` and
   `HTTPS 443` (SSH 22 is there by default). Do **not** open 5174 — it stays
   behind Nginx on localhost.
8. Download the default SSH key from **Account → SSH keys** (or upload your
   own before creating the instance).

### 2b. SSH in and run the provision script

```bash
ssh -i ~/.ssh/lightsail-default.pem ubuntu@<STATIC_IP>

# Inside the box:
curl -sL https://raw.githubusercontent.com/zac-williamson/aztec-triple-triad/testnet/deploy/provision-lightsail.sh \
  | bash

# Override defaults if needed:
#   REPO_URL=...  REPO_BRANCH=main  REPO_DIR=/home/ubuntu/custom-dir  bash
```

The script installs Node 22, Redis, Nginx, certbot, clones the repo, runs
`npm install`, and stages (but doesn't start) the systemd unit and Nginx
config. Read the script before running — it prints the manual steps that
follow.

### 2c. Point DNS at the box

At your registrar (or wherever you manage DNS):

```
A    ws.YOURDOMAIN.com    <LIGHTSAIL_STATIC_IP>    TTL 300
```

Wait for propagation (`dig ws.YOURDOMAIN.com` from your laptop should return
the Lightsail IP) before the next step, otherwise certbot will fail.

### 2d. Configure the backend environment

Still SSHed into the box:

```bash
sudo cp ~/axolotl-arena-server/deploy/triad-backend.env.example /etc/triad-backend.env
sudo nano /etc/triad-backend.env
# Set ALLOWED_ORIGINS=https://play.YOURDOMAIN.com
sudo chmod 600 /etc/triad-backend.env
sudo chown root:root /etc/triad-backend.env
```

### 2e. Enable Nginx and get a TLS cert

```bash
# Edit the config to replace ws.YOURDOMAIN.com with your actual subdomain
sudo nano /etc/nginx/sites-available/triad

# Enable the site
sudo ln -sf /etc/nginx/sites-available/triad /etc/nginx/sites-enabled/triad
sudo rm -f /etc/nginx/sites-enabled/default   # drop the welcome page
sudo nginx -t
sudo systemctl reload nginx

# Issue the cert. Certbot will edit the server block to use the new cert.
sudo certbot --nginx -d ws.YOURDOMAIN.com
# When prompted, choose 'redirect HTTP→HTTPS'.
```

### 2f. Start the backend

```bash
sudo systemctl enable --now triad-backend
sudo systemctl status triad-backend --no-pager
sudo journalctl -u triad-backend -f
# Expect: "Axolotl Arena server running on port 5174 (Redis)"
```

Verify from your laptop:

```bash
curl https://ws.YOURDOMAIN.com/health
# Expect: {"status":"ok","games":0}
```

If you see the JSON, the backend is live.

---

## Step 3 — Deploy the frontend to Vercel

### 3a. Create the project

1. Vercel dashboard → **Add New → Project**.
2. Import your GitHub repo.
3. Framework preset: **Other** (we override everything via `vercel.json`
   which is already committed).
4. Root Directory: leave as repo root — `vercel.json` handles the subpath.
5. Deploy. The first build will fail if env vars are missing — that's fine,
   set them next.

### 3b. Environment variables

**Settings → Environment Variables**, add all of the following for the
**Production** environment:

| Name | Value |
|---|---|
| `VITE_AZTEC_PXE_URL` | `https://rpc.testnet.aztec-labs.com` |
| `VITE_NFT_CONTRACT_ADDRESS` | (from step 1) |
| `VITE_GAME_CONTRACT_ADDRESS` | (from step 1) |
| `VITE_TOKEN_CONTRACT_ADDRESS` | (from step 1) |
| `VITE_AZTEC_ENABLED` | `true` |
| `VITE_WS_URL` | `wss://ws.YOURDOMAIN.com` |

Then **Deployments → latest → Redeploy** to pick up the new env.

### 3c. Point your domain at Vercel

**Settings → Domains** → add `play.YOURDOMAIN.com`. Vercel will give you
either an A record or a CNAME depending on your apex configuration. Add it
at your registrar, wait for propagation, and Vercel provisions the TLS
cert automatically.

---

## Step 3b — Run the arena bot (optional, but the arena is empty without it)

The bot is a backend opponent: it watches the matchmaking queue and, when a
player has waited more than 30 seconds, joins their game and plays it for real —
committing cards, proving moves, settling on-chain. Without it a lone player
waits forever.

Provision an identity first. This mints its stock and, crucially, writes the
note plaintexts to a manifest:

```bash
# On a machine with the deployer key (NOT the box — the minter key never goes there).
export AZTEC_PXE_URL=https://v5.testnet.rpc.aztec-labs.com
export DEPLOYER_SECRET=... DEPLOYER_SALT=... DEPLOYER_SIGNING_KEY=...
set -a; . packages/frontend/.env.testnet; set +a

npx tsx scripts/provision-arena-bot.ts --index 0 --cards 1000
```

**The manifest and its `.imported.json` marker are the only record of the bot's
note plaintexts.** Its cards are minted untagged (the tagged path caps at ~84
notes per finalisation window), so a note whose randomness is lost is a card
nobody can ever import or spend. Copy `packages/bot/.artifacts/` to the box and
back it up; do not let a sandbox and a testnet set share a directory — use
`ARENA_BOT_ARTIFACTS_DIR` to keep them apart.

Then on the box:

```bash
sudo cp deploy/triad-bot.service /etc/systemd/system/
sudo sed -i "s|__REPO_DIR__|$HOME/axolotl-arena-server|" /etc/systemd/system/triad-bot.service
sudo cp deploy/triad-bot.env.example /etc/triad-bot.env
sudo chmod 600 /etc/triad-bot.env && sudo chown root:root /etc/triad-bot.env
sudo nano /etc/triad-bot.env      # ARENA_BOT_TOKEN must match the relay's

sudo systemctl daemon-reload
sudo systemctl enable --now triad-bot
journalctl -u triad-bot -f
```

The first start imports the whole stock, which is the burstiest thing the bot
ever does against a rate-limited node — expect several minutes and some
`rate-limited, retrying` lines. It resumes where it left off if interrupted.

**A pool is N units, not one process with N identities.** The PXE binds one
wallet per process. Copy the unit per index, giving each its own
`ARENA_BOT_INDEX` and `ARENA_BOT_HEALTH_PORT`, and provision an identity for
each. The relay refuses to pair two bots and sends only one to each waiting
player, so the pool needs no coordination of its own.

### Monitoring

```bash
curl -s localhost:5175/health | jq   # bot: failures, cardsStranded, spendableCards
curl -s localhost:5174/metrics | jq  # relay: matches formed, bot matches, wait times

# Wire this into cron or an uptime probe — it exits non-zero with a reason.
deploy/check-arena-health.sh
```

Alert on `healthy: false` and on `spendableCards` falling toward zero. The
second is the one that bites: the bot's collection is a loss budget, every
player who beats it takes a card, and a bot that runs out goes **idle** — which
is correct behaviour and indistinguishable from a quiet night until someone
notices the arena has no opponent.

## Step 4 — Smoke test

1. Open `https://play.YOURDOMAIN.com` in two browsers.
2. In the DevTools console check for SharedArrayBuffer errors — if you see
   "SharedArrayBuffer is not defined", the COOP/COEP headers aren't set.
   Re-check `vercel.json` and force a redeploy.
3. Both players hit **Play** → select 5 cards. They should match, play a
   9-move game, and settlement should complete on testnet.
4. On the Lightsail box, watch the logs while they play:

   ```bash
   ssh ubuntu@ws.YOURDOMAIN.com
   sudo journalctl -u triad-backend -f
   ```

---

## Operational runbook

### Ship a backend change

```bash
# On your laptop: push to main
git push

# SSH to Lightsail and run the update script
ssh ubuntu@ws.YOURDOMAIN.com
bash ~/axolotl-arena-server/deploy/update-backend.sh
```

### Poke around Redis

```bash
ssh ubuntu@ws.YOURDOMAIN.com
redis-cli
> KEYS 'game:*'
> LRANGE queue 0 -1
> GET session:<token>
> FLUSHDB       # wipe everything — use `start-dev.sh --fresh` semantics
```

### Tail logs

```bash
sudo journalctl -u triad-backend -f             # follow
sudo journalctl -u triad-backend --since "1h ago"
sudo journalctl -u triad-backend -p err          # errors only
```

### Restart backend (without code changes)

```bash
sudo systemctl restart triad-backend
```

### Run an ad-hoc script on the box

```bash
cd ~/axolotl-arena-server
REDIS_URL=redis://localhost:6379 npx tsx scripts/your-script.ts
```

### Redeploy contracts and roll the frontend

1. Run `deploy-testnet.ts` from your laptop (step 1).
2. Update the three `VITE_*_CONTRACT_ADDRESS` values in Vercel.
3. Vercel redeploys automatically.
4. Tell Redis on Lightsail to forget its state:
   `redis-cli -h localhost FLUSHDB` (games are tied to old contract addresses).

---

## Gotchas that will bite you

- **Frontend shows "SharedArrayBuffer is not defined"** → COOP/COEP headers
  missing. Check `vercel.json`, redeploy. Hard refresh (`Cmd+Shift+R`).
- **WebSocket connection fails with 403** → `ALLOWED_ORIGINS` on the backend
  doesn't include the Vercel domain. Edit `/etc/triad-backend.env` and
  `sudo systemctl restart triad-backend`.
- **"Mixed content: HTTPS page blocked WS connection"** → You're using
  `ws://` instead of `wss://` in `VITE_WS_URL`. Must be `wss://`.
- **Certbot fails** → DNS hasn't propagated yet, or port 80 is closed in the
  Lightsail firewall. `dig ws.YOURDOMAIN.com` and check firewall rules.
- **Backend OOMs during a game** → `$5/month` Lightsail tier is tight for
  proof handling. Upgrade to $10 (1 GB RAM) or add 2 GB of swap:
  ```bash
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  ```
- **Redis lost all data after reboot** → You haven't enabled persistence.
  By default Ubuntu's Redis uses RDB snapshots every 5 min which is fine for
  dev but not game state. Either (a) accept ephemeral state — after reboot,
  all in-flight games are gone, which is usually acceptable — or (b) enable
  AOF in `/etc/redis/redis.conf` (`appendonly yes`) and restart redis.
- **`ws.YOURDOMAIN.com/health` returns 502** → backend process is dead.
  `sudo systemctl status triad-backend` and check `journalctl` for the stack
  trace.

---

## File reference

All deployment artifacts live under `deploy/`:

- `deploy/nginx-triad.conf` — Nginx reverse proxy with WSS upgrade headers.
- `deploy/triad-backend.service` — systemd unit for the Node backend.
- `deploy/triad-backend.env.example` — env var template.
- `deploy/provision-lightsail.sh` — one-shot box setup (run once).
- `deploy/update-backend.sh` — pull + restart (run on every backend ship).
- `vercel.json` (repo root) — Vercel build config + COOP/COEP headers.
