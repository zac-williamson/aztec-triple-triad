# Fix Specification V5: In-Browser Proof Generation & On-Chain Settlement

> Replace placeholder proofs with real Noir circuit proofs generated in the browser.
> Wire up full game flow: hand proofs, move proofs, aggregate proof, on-chain settlement.
> **No shortcuts. No stubs. Every proof must be real, verified, working.**
> Run `nargo compile` after any circuit change. Run `npm run build` after frontend changes.
> Commit and push after each phase.

---

## Phase 1: Circuit Compilation & Frontend Artifact Loading

**Goal:** Compile all 3 circuits and make their JSON artifacts available to the frontend. Install required packages.

### Step 1.1: Install browser proving dependencies

Add to `packages/frontend/package.json` dependencies:

```json
"@aztec/bb.js": "^4.0.0-devnet.2-patch.0",
"@aztec/noir-noir_js": "^4.0.0-devnet.2-patch.0"
```

Run `npm install` from the monorepo root.

### Step 1.2: Compile all 3 circuits

```bash
cd circuits/prove_hand && nargo compile
cd circuits/game_move && nargo compile
cd circuits/aggregate_game && nargo compile
```

This produces:
- `circuits/prove_hand/target/prove_hand.json`
- `circuits/game_move/target/game_move.json`
- `circuits/aggregate_game/target/aggregate_game.json`

### Step 1.3: Make artifacts accessible to frontend

Copy the compiled JSON artifacts into the frontend public directory so they can be fetched at runtime:

```bash
mkdir -p packages/frontend/public/circuits
cp circuits/prove_hand/target/prove_hand.json packages/frontend/public/circuits/
cp circuits/game_move/target/game_move.json packages/frontend/public/circuits/
cp circuits/aggregate_game/target/aggregate_game.json packages/frontend/public/circuits/
```

Add a build script to `package.json` root that automates this copy step.

### Step 1.4: Create circuit artifact loader

Create `packages/frontend/src/aztec/circuitLoader.ts`:

```typescript
export interface CircuitArtifact {
  bytecode: string;
  abi: unknown;
}

let proveHandArtifact: CircuitArtifact | null = null;
let gameMoveArtifact: CircuitArtifact | null = null;
let aggregateGameArtifact: CircuitArtifact | null = null;

export async function loadProveHandCircuit(): Promise<CircuitArtifact> {
  if (!proveHandArtifact) {
    const resp = await fetch('/circuits/prove_hand.json');
    proveHandArtifact = await resp.json();
  }
  return proveHandArtifact!;
}

export async function loadGameMoveCircuit(): Promise<CircuitArtifact> {
  if (!gameMoveArtifact) {
    const resp = await fetch('/circuits/game_move.json');
    gameMoveArtifact = await resp.json();
  }
  return gameMoveArtifact!;
}

export async function loadAggregateGameCircuit(): Promise<CircuitArtifact> {
  if (!aggregateGameArtifact) {
    const resp = await fetch('/circuits/aggregate_game.json');
    aggregateGameArtifact = await resp.json();
  }
  return aggregateGameArtifact!;
}
```

### Step 1.5: Update Vite config for WASM support

Ensure `packages/frontend/vite.config.ts` has:
- `optimizeDeps.exclude: ['@aztec/bb.js']` (already present)
- `worker.format: 'es'` (already present)
- COOP/COEP headers (already present)

If `@aztec/noir-noir_js` needs WASM initialization, add it to the exclude list too.

### Verification

```bash
ls circuits/prove_hand/target/prove_hand.json && \
ls circuits/game_move/target/game_move.json && \
ls circuits/aggregate_game/target/aggregate_game.json && \
ls packages/frontend/public/circuits/prove_hand.json && \
cd packages/frontend && npm run build 2>&1 | tail -10
```

---

## Phase 2: Implement prove_hand Proof Generation

**Goal:** Replace the prove_hand stub in `proofWorker.ts` with real Barretenberg proof generation.

### Step 2.1: Rewrite `generateProveHandProof` in `packages/frontend/src/aztec/proofWorker.ts`

The function must:

1. Load the compiled `prove_hand` circuit artifact via `loadProveHandCircuit()`
2. Initialize Barretenberg: `const api = await Barretenberg.new({ threads: navigator.hardwareConcurrency || 4 })`
3. Create Noir instance: `const noir = new Noir(artifact as any)`
4. Create backend: `const backend = new UltraHonkBackend(artifact.bytecode, api)`
5. Prepare witness inputs matching the circuit's `main()` signature:
   - `player_secret`: Field (hex string)
   - `player_address`: Field (hex string)
   - `game_id`: Field (hex string)
   - `card_ids`: `[Field; 5]` — array of 5 card IDs as hex strings
   - `card_ranks`: `[[Field; 4]; 5]` — 5 arrays of 4 rank values
   - `card_nullifier_secrets`: `[Field; 5]` — 5 nullifier secrets
   - `grumpkin_private_key`: Field — player's Grumpkin private key
6. Execute: `const { witness } = await noir.execute(inputs)`
7. Generate proof: `const proofData = await backend.generateProof(witness, { verifierTarget: 'noir-recursive' })`
8. Extract public inputs from `proofData.publicInputs` (5 fields):
   - `[0]` = card_commit
   - `[1]` = player_address
   - `[2]` = game_id
   - `[3]` = grumpkin_public_key_x
   - `[4]` = grumpkin_public_key_y
9. Serialize proof: Convert `proofData.proof` (Uint8Array) to base64 string
10. Return `HandProofData` with all fields populated

```typescript
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import { Noir } from '@aztec/noir-noir_js';
import { loadProveHandCircuit } from './circuitLoader';

export async function generateProveHandProof(
  cardIds: number[],
  cardRanks: Array<{ top: number; right: number; bottom: number; left: number }>,
  playerAddress: string,
  gameId: string,
  playerSecret: string,
  nullifierSecrets: string[],
  grumpkinPrivateKey?: string,
): Promise<HandProofData> {
  const artifact = await loadProveHandCircuit();
  const api = await Barretenberg.new({ threads: navigator.hardwareConcurrency || 4 });

  try {
    const noir = new Noir(artifact as any);
    const backend = new UltraHonkBackend(artifact.bytecode, api);

    const inputs = {
      player_secret: playerSecret,
      player_address: playerAddress,
      game_id: gameId,
      card_ids: cardIds.map(id => '0x' + id.toString(16)),
      card_ranks: cardRanks.map(r => [
        '0x' + r.top.toString(16),
        '0x' + r.right.toString(16),
        '0x' + r.bottom.toString(16),
        '0x' + r.left.toString(16),
      ]),
      card_nullifier_secrets: nullifierSecrets,
      grumpkin_private_key: grumpkinPrivateKey || '0x01',
    };

    const { witness } = await noir.execute(inputs);
    const proofData = await backend.generateProof(witness, { verifierTarget: 'noir-recursive' });

    // Base64-encode the proof bytes
    const proofBase64 = btoa(String.fromCharCode(...proofData.proof));

    return {
      proof: proofBase64,
      publicInputs: proofData.publicInputs,
      cardCommit: proofData.publicInputs[0],
      playerAddress: proofData.publicInputs[1],
      gameId: proofData.publicInputs[2],
      grumpkinPublicKeyX: proofData.publicInputs[3],
      grumpkinPublicKeyY: proofData.publicInputs[4],
    };
  } finally {
    await api.destroy();
  }
}
```

**Important notes for the implementer:**
- The exact input field names MUST match the circuit's `main()` parameter names. Read `circuits/prove_hand/src/main.nr` to verify.
- Card IDs and ranks may need to be Field-encoded (hex strings with `0x` prefix, or decimal strings). Check what `noir.execute()` expects. Some versions accept numbers directly, others require hex strings.
- If `Barretenberg.new()` is too slow to call per-proof, consider using `Barretenberg.initSingleton()` once at app startup and `Barretenberg.getSingleton()` thereafter.
- If `@aztec/noir-noir_js` is not available at the target Aztec version, fall back to `@noir-lang/noir_js`. Check npm to see which package exists for `4.0.0-devnet.2-patch.0`.

### Step 2.2: Handle initialization lifecycle

Create `packages/frontend/src/aztec/proofBackend.ts` to manage Barretenberg singleton:

```typescript
let bbInstance: Barretenberg | null = null;

export async function getBarretenberg(): Promise<Barretenberg> {
  if (!bbInstance) {
    bbInstance = await Barretenberg.new({ threads: navigator.hardwareConcurrency || 4 });
  }
  return bbInstance;
}

export async function destroyBarretenberg(): Promise<void> {
  if (bbInstance) {
    await bbInstance.destroy();
    bbInstance = null;
  }
}
```

Update `generateProveHandProof` and `generateGameMoveProof` to use `getBarretenberg()` instead of creating a new instance each time.

### Verification

```bash
cd packages/frontend && npm run build 2>&1 | tail -10
```

The build must succeed with no import errors. Real runtime testing happens in Phase 4.

---

## Phase 3: Implement game_move Proof Generation

**Goal:** Replace the game_move stub with real proof generation.

### Step 3.1: Rewrite `generateGameMoveProof` in `proofWorker.ts`

The function must:

1. Load the `game_move` circuit artifact via `loadGameMoveCircuit()`
2. Get Barretenberg via `getBarretenberg()`
3. Create Noir instance and UltraHonkBackend
4. Prepare witness inputs matching the circuit's `main()` signature. Read `circuits/game_move/src/main.nr` carefully for exact parameter names and types. The circuit takes many parameters including:
   - `card_commit_1`, `card_commit_2`: pub Field — the card commitments from hand proofs
   - `start_state_hash`, `end_state_hash`: pub Field — Pedersen hashes of board states
   - `game_ended`: pub Field — 0 or 1
   - `winner_id`: pub Field — 0, 1, 2, or 3
   - `encrypted_card_nullifier`: pub Field — ECDH-encrypted nullifier
   - Private inputs: `current_player`, `card_id`, `row`, `col`, `board_before` (18 fields), `board_after` (18 fields), `scores_before` (2 fields), `scores_after` (2 fields), `current_turn_before`, various player data, ECDH keys
5. Execute witness: `const { witness } = await noir.execute(inputs)`
6. Generate proof: `const proofData = await backend.generateProof(witness, { verifierTarget: 'noir-recursive' })`
7. Extract 7 public inputs and serialize

### Step 3.2: Implement Pedersen state hash computation

The circuit computes state hashes using Pedersen hash over 21 fields:
```
[board_cell_0_card_id, board_cell_0_owner, ..., board_cell_8_card_id, board_cell_8_owner, p1_score, p2_score, current_turn]
```

The frontend `computeStateHash` in `useProofGeneration.ts` currently uses a placeholder (string join). Replace it with the actual Pedersen hash computation. You can use `@aztec/bb.js` or `@aztec/noir-noir_js` to compute the Pedersen hash, OR pass the raw board state and let the circuit compute the hash (the circuit already does this — check which values are public vs private inputs).

**Critical:** The state hash computation in the frontend MUST match the circuit's `std::hash::pedersen_hash()` exactly. If the circuit computes state hashes internally from the raw board arrays (which it does), then the frontend only needs to pass the raw board arrays as private inputs and the circuit outputs the correct state hashes as public inputs. In this case, `startStateHash` and `endStateHash` in `MoveProofData` should be read from `proofData.publicInputs[2]` and `proofData.publicInputs[3]` respectively, not computed separately.

### Step 3.3: Implement ECDH nullifier encryption

The circuit encrypts the placed card's nullifier secret using ECDH:
1. Shared secret = `(grumpkin_private_key * opponent_pubkey).x`
2. Expanded key = `pedersen_hash([shared_secret, 0])`
3. Encrypted = `plaintext + expanded_key`

The frontend needs to pass `grumpkin_private_key`, `opponent_pubkey_x`, `opponent_pubkey_y` as private inputs. The circuit handles the encryption and outputs the result as `encrypted_card_nullifier` (public input [6]).

The Grumpkin keys are exchanged during hand proof phase — each player's `grumpkinPublicKeyX` and `grumpkinPublicKeyY` are public outputs of their hand proof.

### Verification

```bash
cd packages/frontend && npm run build 2>&1 | tail -10
```

---

## Phase 4: Wire Real Proofs Through Game Flow

**Goal:** Remove placeholder proof fallback. Exchange real proofs via WebSocket. Play a full game with real ZK proofs.

### Step 4.1: Update `useProofGeneration.ts` to remove placeholder fallback

In `packages/frontend/src/hooks/useProofGeneration.ts`:

1. Remove all `placeholder_hand_proof` and `placeholder_move_proof` code paths
2. Remove `computeCardCommitPlaceholder()` function
3. The `generateHandProof()` method should call `generateProveHandProof()` from `proofWorker.ts` directly
4. The `generateMoveProof()` method should call `generateGameMoveProof()` from `proofWorker.ts` directly
5. Keep the sequential proof queue (`proofQueueRef`) to prevent overlapping proof generation
6. Update error handling — if proof generation fails, set status to `'error'` and show the error message in the UI

### Step 4.2: Update proof serialization for WebSocket

Proofs contain a `Uint8Array` (`proofData.proof`) that must be serialized for WebSocket transmission. The current `HandProofData` and `MoveProofData` types use `proof: string` (base64).

In `proofWorker.ts`, the proof is already base64-encoded before returning. On the receiving end (when the opponent receives a proof via WebSocket), the proof string is used as-is since it only needs to be stored and later passed to the aggregate circuit.

Ensure:
- `SUBMIT_HAND_PROOF` message sends the `HandProofData` with base64 proof string
- `HAND_PROOF` message relay preserves the full proof data
- `SUBMIT_MOVE_PROOF` message sends `MoveProofData` with base64 proof string
- `MOVE_PROVEN` message relay preserves the full proof data
- Frontend stores received opponent proofs in state for later aggregation

### Step 4.3: Store all proofs for aggregation

Update `useGameFlow.ts` to:
1. Store both players' `HandProofData` (own + opponent's)
2. Store all 9 `MoveProofData` objects in order
3. Track which proofs belong to which player
4. When `canSettle` becomes true (game ended, player is winner, all 11 proofs collected), enable the "Settle on-chain" button

### Step 4.4: Add proof generation status UI

In the game screen, show:
- "Generating hand proof..." spinner when hand proof is being generated
- "Generating move proof..." spinner during each move proof
- "Proof ready" indicator when proof generation completes
- Error state if proof generation fails (with retry button)
- Proof count: "Proofs collected: X/11"

### Step 4.5: Add Grumpkin key exchange flow

When a player receives the opponent's hand proof via WebSocket:
1. Extract `grumpkinPublicKeyX` and `grumpkinPublicKeyY` from the opponent's `HandProofData`
2. Store these in state
3. Pass them to `generateGameMoveProof()` for each subsequent move proof (needed for ECDH nullifier encryption)

### Step 4.6: Generate Grumpkin key pair at game start

When a game starts, each player needs a Grumpkin key pair:
1. Generate a random 32-byte private key
2. Store it in localStorage (per-game, like playerSecret)
3. Pass it to `generateProveHandProof()` as `grumpkinPrivateKey`
4. The circuit derives the public key and outputs it as public inputs [3] and [4]

### Verification

```bash
cd packages/frontend && npm run build 2>&1 | tail -10
```

Manual test: Open two browser tabs, create a game, play through all 9 moves. Both players should generate real proofs. Check browser console for proof generation logs. No "placeholder" proofs should appear.

---

## Phase 5: Aggregate Proof Generation

**Goal:** After game ends, the winner generates an aggregate proof that recursively verifies all 11 inner proofs.

### Step 5.1: Implement aggregate proof generation

Create `packages/frontend/src/aztec/aggregateProof.ts`:

1. Load the `aggregate_game` circuit artifact
2. Collect all 11 proofs: 2 hand proofs + 9 move proofs
3. For each inner proof, extract:
   - `proof` as field array (500 fields for ZK variant)
   - `publicInputs` as field array
   - Verification key as field array (115 fields)
   - VK hash (1 field)
4. Prepare aggregate circuit inputs — read `circuits/aggregate_game/src/main.nr` to understand exactly what the aggregate circuit expects:
   - `hand_proof_1_vk`, `hand_proof_1`, `hand_proof_1_inputs` (5 public inputs)
   - `hand_proof_2_vk`, `hand_proof_2`, `hand_proof_2_inputs` (5 public inputs)
   - `move_proof_1_vk` through `move_proof_9_vk`, proofs, inputs (7 each)
   - `hand_vk_hash`, `move_vk_hash`
5. Execute aggregate circuit to generate witness
6. Generate aggregate proof

### Step 5.2: Extract VK and proof field representations

After generating each inner proof (hand or move), also extract the recursive proof artifacts:

```typescript
const artifacts = await backend.generateRecursiveProofArtifacts(
  proofData.proof,
  proofData.publicInputs.length
);
// artifacts.vkAsFields: string[] — 115 field elements
// artifacts.vkHash: string — single field

// Convert proof bytes to fields
import { deflattenFields } from '@aztec/bb.js';
const proofAsFields = deflattenFields(proofData.proof);
// proofAsFields: string[] — 500 fields (for ZK proofs with verifierTarget 'noir-recursive')
```

Store `vkAsFields`, `vkHash`, and `proofAsFields` alongside each proof for aggregation.

**Important:** All hand proofs share the same VK (prove_hand circuit), and all move proofs share the same VK (game_move circuit). Extract the VK once per circuit type.

### Step 5.3: Serialize aggregate proof for contract

The aggregate proof output (15 public inputs) is what gets passed to the `process_game` contract:

```typescript
interface AggregateProofData {
  proof: string;  // base64-encoded aggregate proof bytes
  publicInputs: string[];  // 15 field elements
  vkAsFields: string[];  // 115 fields — aggregate circuit VK
  vkHash: string;  // aggregate circuit VK hash
}
```

### Verification

```bash
cd packages/frontend && npm run build 2>&1 | tail -10
```

---

## Phase 6: Contract Deployment & On-Chain Settlement

**Goal:** Deploy contracts to local Aztec sandbox, register VK hashes, and implement full on-chain settlement.

### Step 6.1: Create deployment script

Create `scripts/deploy-contracts.ts`:

1. Connect to local Aztec node at `http://localhost:8080`
2. Create a TestWallet
3. Deploy `TripleTriadNFT` contract (minter = deployer)
4. Deploy `TripleTriadGame` contract (NFT address passed in constructor or via setter)
5. Call `set_game_contract` on NFT to register the game contract
6. Register VK hashes on the game contract:
   - `hand_vk_hash`: hash of the prove_hand circuit verification key
   - `move_vk_hash`: hash of the game_move circuit verification key
   - `aggregate_vk_hash`: hash of the aggregate_game circuit verification key
7. Output deployed contract addresses for frontend config
8. Save addresses to `packages/frontend/.env` or a config file

To compute VK hashes, compile each circuit and use bb.js:
```typescript
const backend = new UltraHonkBackend(circuit.bytecode, api);
const dummyWitness = await noir.execute(dummyInputs);
const dummyProof = await backend.generateProof(dummyWitness, { verifierTarget: 'noir-recursive' });
const artifacts = await backend.generateRecursiveProofArtifacts(dummyProof.proof, dummyProof.publicInputs.length);
const vkHash = artifacts.vkHash;
```

Note: If generating a dummy proof is impractical, use `backend.getVerificationKey()` and hash it with Pedersen. Check the exact hashing mechanism used by `verify_honk_proof` in the contract.

### Step 6.2: Add VK hash registration to game contract

Check if the game contract (`packages/contracts/triple_triad_game/src/main.nr`) already has a function to set VK hashes. It should store:
- `hand_vk_hash: PublicImmutable<Field>`
- `move_vk_hash: PublicImmutable<Field>`
- `aggregate_vk_hash: PublicImmutable<Field>`

If not present, add a `set_vk_hashes(hand_vk_hash: Field, move_vk_hash: Field, aggregate_vk_hash: Field)` function callable only by admin, using `PublicImmutable.initialize()` (one-shot, like `set_game_contract`).

Compile: `cd packages/contracts && aztec compile`

### Step 6.3: Implement settlement in `useGameContract.ts`

Update `packages/frontend/src/hooks/useGameContract.ts` `settleGame()`:

1. Decode the aggregate proof from base64 back to field array
2. Call `process_game` on the game contract:
   ```typescript
   const receipt = await gameContract.methods.process_game(
     aggregateVk,          // [Field; 115]
     aggregateProof,       // [Field; 500]
     aggregateInputs,      // [Field; 15]
     loserAddress,         // AztecAddress
     cardToTransfer,       // Field (token_id)
   ).send({
     fee: new SponsoredFeePaymentMethod(sponsoredFPC),
   }).wait();
   ```
3. Handle the card selection UI — winner picks one of loser's board cards
4. Show transaction progress (sent, mined, confirmed)

### Step 6.4: Mint initial cards for testing

Add to the deployment script:
- Mint 10 cards (IDs 1-10) to test account 1
- Mint 10 cards (IDs 11-20) to test account 2
- Use `mint_to_private` on the NFT contract

### Step 6.5: Update frontend to show on-chain state

- Display owned cards from on-chain NFT queries
- Show settlement transaction status
- After settlement, update card ownership display

### Verification

```bash
cd packages/contracts && aztec compile 2>&1 | tail -20
cd packages/frontend && npm run build 2>&1 | tail -10
```

Full end-to-end test:
1. Start Aztec sandbox: `aztec start --local-network`
2. Deploy contracts: `npx ts-node scripts/deploy-contracts.ts`
3. Start backend: `npm run dev --workspace=packages/backend`
4. Start frontend: `npm run dev --workspace=packages/frontend`
5. Open two browser tabs
6. Create game, play through all 9 moves
7. Winner clicks "Settle on-chain"
8. Verify card transfer on-chain

---

## Summary Table

| Phase | Description | Key Files | Verification |
|-------|-------------|-----------|-------------|
| 1 | Circuit compilation + artifact loading | `circuitLoader.ts`, `package.json`, `public/circuits/*.json` | `nargo compile` + `npm run build` |
| 2 | prove_hand real proof generation | `proofWorker.ts`, `proofBackend.ts` | `npm run build` |
| 3 | game_move real proof generation | `proofWorker.ts` | `npm run build` |
| 4 | Wire real proofs through game flow | `useProofGeneration.ts`, `useGameFlow.ts` | `npm run build` + manual 2-player test |
| 5 | Aggregate proof generation | `aggregateProof.ts` | `npm run build` |
| 6 | Contract deployment + settlement | `deploy-contracts.ts`, `useGameContract.ts`, game contract | `aztec compile` + `npm run build` + e2e test |

## Important Notes for the Agent

1. **Package availability:** If `@aztec/noir-noir_js` does not exist at version `4.0.0-devnet.2-patch.0`, try `@noir-lang/noir_js` instead. Check npm registry. The import path in code may be `@noir-lang/noir_js` even if the package is `@aztec/noir-noir_js`.

2. **Witness input format:** The exact format that `noir.execute()` accepts may vary. Some versions accept `{ x: 5 }` (plain numbers), others require `{ x: "0x05" }` (hex strings). Test with a simple execution and adjust.

3. **Circuit parameter names:** The witness input object keys MUST exactly match the circuit `main()` function parameter names. Read each circuit's source carefully.

4. **Proof size:** UltraHonkZKProof = 500 fields (used with `verifierTarget: 'noir-recursive'`). UltraHonkProof (non-ZK) = 449 fields. The aggregate circuit expects ZK proofs since it uses `UltraHonkZKProof` type.

5. **Barretenberg threads:** Use `navigator.hardwareConcurrency` for thread count. Requires `SharedArrayBuffer` which requires COOP/COEP headers (already configured in Vite).

6. **Proof generation time:** Each proof may take 10-60 seconds in the browser. Show progress UI and don't block the main thread.

7. **Memory:** Barretenberg uses significant WASM memory. Initialize once and reuse. Call `destroy()` only when the user leaves the game.

8. **nargo version:** Check installed nargo version with `nargo --version`. Circuits have pinned `compiler_version` in their `Nargo.toml`. If there's a version mismatch, update the Nargo.toml files to match the installed version.

9. **Aggregate circuit complexity:** The aggregate circuit does recursive verification of 11 proofs. Generating an aggregate proof will be the slowest operation (potentially minutes). This is expected — show appropriate UI feedback.

10. **If proof generation fails at runtime:** The most common issues are:
    - Wrong witness input format (numbers vs hex strings vs field strings)
    - Missing or misnamed witness fields
    - WASM initialization failure (check COOP/COEP headers)
    - Circuit artifact not found (check file paths)
    - Out of memory (reduce threads)
    Debug by checking browser console for the exact error from bb.js/noir_js.
