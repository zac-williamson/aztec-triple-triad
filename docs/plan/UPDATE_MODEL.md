# Update model: FRESH REDEPLOY (no Aztec contract-upgrade pattern)

**Directive (Zac — reverses the earlier "make contracts updatable" decision):** during
active development, a contract "update" = a **completely new redeployment** of the
contract set, applied **IMMEDIATELY**. Do NOT use Aztec's protocol upgrade pattern
(`update_to` / `set_update_delay` / `ContractInstanceRegistry`). On this rollup that path
carries an **enforced 24h update delay** (the registry clamps `set_update_delay(600)` up
to 86400s) — unacceptable for active dev. Address churn is fine; `deploy-testnet.ts`
writes the new addresses to the frontend `.env` automatically.

## Validated context
- Fresh deploy = immediate (no delay). The 24h delay comes ONLY from the `update_to` path.
- The 3 contracts are interdependent: `triple_triad_nft` stores the game address as
  `PublicImmutable` (`set_game_contract`; authorizes the game at main.nr:600/670/735/756).
  A new game address therefore REQUIRES redeploying the NFT too → fresh redeploy is **all
  three together** (`deploy-testnet.ts` wires the cross-refs + writes `.env`).

## Task (Lane 1) — do now, this is the priority
1. **Strip the upgrade pattern from ALL THREE contracts** (`triple_triad_game`,
   `triple_triad_nft`, `arena_token`): remove `update_to`, `set_update_delay`, and the
   `ContractInstanceRegistry` import/use. Keep everything else — especially the C2 round-2
   original-owner fix + `compute_initial_state_hash`.
2. `aztec compile` all three.
3. **Fresh-deploy all three to testnet** via `deploy-testnet.ts` — immediate, new
   addresses, wires `NFT.set_game_contract → new game`, writes
   `packages/frontend/.env.testnet`. (Ensure the deployer has Fee Juice; fund from the
   treasury if needed.)
4. **Delete the slop scripts**: `scripts/update-game-class-testnet.ts`,
   `scripts/verify-game-update-testnet.ts`.
5. STATUS with the **3 NEW addresses** (NFT, game, token). I'll update Vercel env + redeploy
   so the live game works immediately (no 24h wait).

This is the standing update model going forward: code fix → `aztec compile` → fresh
`deploy-testnet.ts` → new addresses to `.env` → frontend redeploy. Immediate, every time.
