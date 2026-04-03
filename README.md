# Aztec Triple Triad

A fully on-chain Triple Triad card game built on the [Aztec Network](https://aztec.network). Players collect NFT cards, build decks, and battle in private 1v1 matches where game moves are proven with zero-knowledge proofs.

## What is Triple Triad?

Triple Triad is the card game from Final Fantasy VIII. Two players take turns placing cards on a 3x3 board. Each card has four rank values (top, right, bottom, left). When a placed card's rank is higher than an adjacent opponent card's touching rank, the opponent's card is captured. The player controlling the most cards when the board is full wins, and takes one card from the loser.

## Architecture

```
packages/
  game-logic/     Pure TypeScript game rules (capture, scoring, win detection)
  backend/        WebSocket relay server for real-time multiplayer
  frontend/       React + Three.js frontend with 3D swamp environment
  contracts/      Aztec Noir smart contracts (NFT + Game)
  integration/    End-to-end tests
circuits/         Standalone Noir circuits for client-side ZK proofs
scripts/          Dev tooling (deploy, card art generation, dev startup)
```

### Key Features

- **Private gameplay**: Game moves generate ZK proofs client-side — no game state is revealed on-chain during play
- **NFT cards**: Each card is a private NFT on Aztec, with hidden ownership until revealed
- **Card packs**: Hunt for cards across 5 locations (River, Forest, Beach, City, Dockyard) with cooldown timers
- **On-chain settlement**: Winner submits all move proofs in a single transaction; loser's card transfers automatically
- **3D environment**: Swamp-themed diorama with interactive props, built with React Three Fiber

## Prerequisites

- **Node.js** >= 22.0.0
- **Aztec CLI** v4.2.0-nightly.20260323 — install via:
  ```bash
  bash -i <(curl -s https://install.aztec.network) 4.2.0-nightly.20260323
  ```
- **Nargo** (installed with the Aztec CLI)

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

### 3. Copy contract artifacts to frontend

```bash
npm run copy-contracts
cp packages/contracts/target/arena_token-ArenaToken.json packages/frontend/public/contracts/
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

On testnet, the app will show a **"Needs Funding"** prompt with your account address. You need to send Fee Juice to this address before the account can be deployed. Use the [Aztec testnet faucet](https://docs.aztec.network) or bridge Fee Juice from L1 Sepolia.

Once funded, click **Confirm Funded** and the app will deploy your account and mint starter cards.

### Testnet contract addresses

The testnet contracts are pre-deployed and configured in `packages/frontend/.env.testnet`:

```
VITE_AZTEC_PXE_URL=https://rpc.testnet.aztec-labs.com
VITE_NFT_CONTRACT_ADDRESS=0x16e1dc9ea5b271ecc57c192df6ff2f1c271e0e2079b73bc5981d6d38a2c76112
VITE_GAME_CONTRACT_ADDRESS=0x01538e90c1da710c6716bd6fbf90b91aa72082a49bfdfea6f33f5413ea80cf13
VITE_TOKEN_CONTRACT_ADDRESS=0x1bd1df2b618e5e240ee0dc282c6639831299322701d93655f80d1758068f5e2a
```

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
