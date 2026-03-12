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
- **Aztec CLI** v4.1.0-nightly.20260312.2 — install via:
  ```bash
  bash -i <(curl -s https://install.aztec.network) 4.1.0-nightly.20260312.2
  ```
- **Nargo** (installed with the Aztec CLI)

## Getting Started

### 1. Install dependencies

```bash
npm install --legacy-peer-deps
```

> `--legacy-peer-deps` is needed due to React 18 + React Three Fiber v9 peer dependency conflicts.

### 2. Start the Aztec sandbox

In a **separate terminal**:

```bash
aztec start --local-network
```

Wait until you see `Aztec Node started` before continuing.

### 3. Run the dev startup script

```bash
./scripts/start-dev.sh
```

This script will:

1. Check that the Aztec sandbox is running
2. Compile contracts and circuits
3. Copy artifacts to the frontend
4. Deploy contracts (or reuse existing deployment)
5. Start the backend WebSocket server (ws://localhost:5174)
6. Start the Vite frontend dev server (http://localhost:5173)

### 4. Play

1. Open **http://localhost:5173** in two browser tabs
2. In each tab, open **Card Packs** and hunt for cards (you need at least 5)
3. Click **Play**, select 5 cards, and start the game
4. The second tab does the same — matchmaking pairs you automatically
5. Take turns placing cards on the 3x3 board
6. Winner takes a card from the loser!

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
