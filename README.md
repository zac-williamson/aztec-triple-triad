# Axolotl Arena

A fully on-chain Triple Triad card game built on the [Aztec Network](https://aztec.network). Players collect NFT cards, build decks, and battle in private 1v1 matches where every game move is proven with a client-side zero-knowledge proof — only three transactions touch the chain per game, and none of them reveals your hand.

> Repo name is `aztec-triple-triad`; the game is **Axolotl Arena**.

## Play in 60 seconds

Want to try it without a wallet, funding, or even a backend? **Practice vs Bot** runs entirely in your browser against a local AI opponent — no chain, no setup beyond starting the dev server:

```bash
npm install --legacy-peer-deps
cd packages/frontend && npm run dev        # http://localhost:3000
```

Click **Practice vs Bot** on the main menu and pick a difficulty (Novice / Skilled / Master). The on-chain multiplayer experience (NFT cards, ZK-proven moves, on-chain settlement) is below.

> A hosted version you can play without any local setup is coming with the public launch. Until then, run it locally as described here.

## What is Triple Triad?

Triple Triad is the card game from Final Fantasy VIII. Two players take turns placing cards on a 3x3 board. Each card has four rank values (top, right, bottom, left). When a placed card's rank is higher than an adjacent opponent card's touching rank, the opponent's card is captured. The player controlling the most cards when the board is full wins, and takes one card from the loser.

## Architecture

```
packages/
  game-logic/     Pure TypeScript game rules (capture, scoring, win detection) + practice bot
  backend/        WebSocket relay server for real-time multiplayer
  frontend/       React + Three.js frontend with 3D swamp environment
  contracts/      Aztec Noir contracts: triple_triad_nft, triple_triad_game, arena_token
  integration/    End-to-end tests
circuits/         Standalone Noir circuits: prove_hand, game_move, dummy_move, dummy_hand
scripts/          Dev tooling (deploy, card art generation, dev startup)
```

For how it all fits together — the three-transaction game lifecycle, the 11-proof recursive settlement, the note lifecycle, and an **Aztec concept → `file:line` index** for learners — see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

### Key Features

- **Private gameplay**: Game moves generate ZK proofs client-side — no game state is revealed on-chain during play
- **NFT cards**: Each card is a private NFT on Aztec, with hidden ownership until revealed
- **Card packs**: Hunt for cards across 5 locations (River, Forest, Beach, City, Dockyard) with cooldown timers
- **On-chain settlement**: Winner submits all move proofs in a single transaction; loser's card transfers automatically
- **Practice mode**: Play a local, chainless game against an AI bot — no wallet or funding required
- **3D environment**: Swamp-themed diorama with interactive props, built with React Three Fiber

## Prerequisites

- **Node.js** >= 22.0.0
- **Aztec CLI** 5.2.0-nightly.20260815 — install via:
  ```bash
  aztec-up install 5.2.0-nightly.20260815
  aztec-up use 5.2.0-nightly.20260815
  ```
  The toolchain version is pinned per-checkout by the committed `.aztecrc`. On
  the 5.2 line `aztec-up install` can exit 0 while installing nothing, and
  re-running does not fix it — CLAUDE.md has the workaround and how to spot it.
- **Nargo** (installed with the Aztec CLI; this repo uses `1.0.0-beta.25`)

> Everything is pinned to **Aztec 5.2.0-nightly.20260815** — the npm `@aztec/*`
> packages, the aztec-nr git tags in every `Nargo.toml`, and the CLI. The pin
> matches the live testnet node's `nodeVersion` exactly, because protocol
> compatibility is what matters; do not follow npm `latest`. Never mix versions
> across packages. See [CLAUDE.md](CLAUDE.md#versions--matched-sets-never-bumped-piecemeal)
> for the full pin table.

## Getting Started

### 1. Install dependencies

```bash
npm install --legacy-peer-deps
```

> `--legacy-peer-deps` is needed due to React 18 + React Three Fiber v9 peer dependency conflicts.

## Running on Local Devnet

### 1. Start the Aztec sandbox

In a **separate terminal**:

```bash
./start-sandbox.sh
```

This starts the sandbox with `SEQ_MIN_TX_PER_BLOCK=0` so the sequencer produces empty blocks (needed for L1-to-L2 Fee Juice bridging). Wait until you see `Aztec Server listening on port 8080`.

### 2. Deploy contracts

```bash
npx tsx scripts/deploy-contracts.ts
```

This deploys all three contracts (NFT, Game, Token), wires them together, and writes the addresses to `packages/frontend/.env`. Copy the generated `.env` to `.env.devnet`:

```bash
cp packages/frontend/.env packages/frontend/.env.devnet
```

### 3. Copy contract + circuit artifacts to frontend

```bash
npm run copy-contracts   # all three contract artifacts → public/contracts/
npm run copy-circuits    # prove_hand, game_move, dummy_move, dummy_hand → public/circuits/
```

### 4. Start the backend and frontend

```bash
# Backend (from repo root)
npx tsx packages/backend/src/server.ts &

# Frontend (from packages/frontend/)
cd packages/frontend
npm run dev:devnet
```

- Backend: `ws://localhost:5174`
- Frontend: `http://localhost:3000`

### How devnet funding works

On the local devnet, accounts are automatically funded with Fee Juice via L1 bridging. The app:

1. Mints Fee Juice on L1 using the default Anvil test mnemonic
2. Bridges it to the player's L2 address via the Fee Juice Portal
3. Uses `FeeJuicePaymentMethodWithClaim` to atomically claim the Fee Juice and pay for the account deployment in a single transaction

No manual funding is needed.

## Running on Testnet

### 1. Start the backend and frontend

```bash
# Backend (from repo root)
npx tsx packages/backend/src/server.ts &

# Frontend (from packages/frontend/)
cd packages/frontend
npm run dev:testnet
```

- Backend: `ws://localhost:5174`
- Frontend: `http://localhost:3000`

### 2. Fund your account

Click **Fund with My Wallet**. The app buys the fee asset with your own ETH,
bridges it through the Fee Juice portal, and then deploys your account claiming
it — all from your wallet, with no faucet involved. On a testnet the asset is a
mock with a free mint, so the only thing that differs from mainnet is that leg;
on mainnet the same flow buys it on Uniswap v4 and shows you the price first.

Bridging is the slow part (three L1 transactions plus L1→L2 inclusion), so
expect a few minutes. If you would rather fund the address yourself, the prompt
still offers a manual path.

### Testnet contract addresses

Live addresses are in `packages/frontend/.env.testnet`, which is the single
source of truth — read them from there rather than from here. This section used
to copy them, and the copy was three re-genesises out of date.

```bash
grep VITE_ packages/frontend/.env.testnet
npx tsx scripts/check-testnet-state.ts   # and confirm they are still alive
```

The testnet re-genesises on protocol upgrades and silently orphans deployed
contracts; it has happened three times. If anything on-chain looks dead, run the
check above before debugging anything else.

All three contracts are **updatable** (admin-guarded): each exposes an `update_to(new_class_id)` function that swaps the contract class while preserving the address, gated to the deployer (`minter` for the NFT, `admin` for the game and token contracts) and subject to an on-chain update delay. Future bug fixes ship as address-preserving class updates — these addresses are stable, so deployments no longer churn `.env.testnet`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the contract details.

## Development

### Compile contracts only

```bash
cd packages/contracts
aztec compile
aztec codegen target/ -o target/codegen
```

### Compile circuits only

```bash
cd circuits
nargo compile
```

### Run game logic tests

```bash
cd packages/game-logic
npm test
```

### Run frontend tests

```bash
cd packages/frontend
npm test
```

## Tech Stack

- **Contracts**: [Noir](https://noir-lang.org/) + [Aztec.nr](https://github.com/AztecProtocol/aztec-nr)
- **Frontend**: React, TypeScript, [React Three Fiber](https://docs.pmnd.rs/react-three-fiber), Vite
- **Backend**: Node.js WebSocket relay (`ws`)
- **Proofs**: Client-side ZK proof generation with `@aztec/bb.js`
- **Assets**: Synty polygon swamp models (FBX), DALL-E generated card art

## License

MIT
