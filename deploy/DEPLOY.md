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
         │ ◄──── wss:// ─────► │  Node (tsx)  │
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
curl -sL https://raw.githubusercontent.com/YOURUSER/aztec-triple-triad/main/deploy/provision-lightsail.sh \
  | REPO_URL=https://github.com/YOURUSER/aztec-triple-triad.git bash
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
sudo cp ~/aztec-triple-triad/deploy/triad-backend.env.example /etc/triad-backend.env
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
bash ~/aztec-triple-triad/deploy/update-backend.sh
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
cd ~/aztec-triple-triad
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
