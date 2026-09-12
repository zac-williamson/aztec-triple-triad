/**
 * The artifacts the browser fetches must match the ones we compile.
 *
 * `packages/frontend/public/contracts/` is TRACKED, and the deployed site serves
 * whatever is COMMITTED there — not whatever a local `aztec compile` or
 * `deploy-testnet.ts` most recently wrote to disk. When the two drift, the
 * browser registers a contract class that does not match the deployed contract
 * and every new player is blocked at their first transaction with
 *
 *   No artifact registered for contract class 0x… : register it by calling
 *   wallet.registerContract(...)
 *
 * That reached production on 2026-09-12: the card-pack revert changed the NFT,
 * the deploy refreshed these files locally, the source and `target/` artifacts
 * were committed and these were not, and Vercel built with the previous
 * deployment's ABI.
 *
 * It is invisible from the JS bundle. The bundle carries the CALLING code —
 * `purchase_card_pack`, `previewCardPack` — while the ABI is a separate fetched
 * JSON, so a bundle that greps correctly proves nothing about the artifact. This
 * test is the check that actually looks.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname ?? __dirname, '..');
const NAMES = [
  'arena_token-ArenaToken',
  'triple_triad_nft-TripleTriadNFT',
  'triple_triad_game-TripleTriadGame',
];

const compiled = (n: string) => join(ROOT, 'packages/contracts/target', `${n}.json`);
const shipped = (n: string) => join(ROOT, 'packages/frontend/public/contracts', `${n}.json`);

describe('the artifacts the browser fetches', () => {
  it('has a compiled artifact for every shipped one', () => {
    for (const n of NAMES) {
      expect(existsSync(compiled(n)), `missing ${compiled(n)} — run \`aztec compile\``).toBe(true);
      expect(existsSync(shipped(n)), `missing ${shipped(n)} — run \`npm run copy-contracts\``).toBe(true);
    }
  });

  it('ships exactly what was compiled', () => {
    const drifted: string[] = [];
    for (const n of NAMES) {
      if (!existsSync(compiled(n)) || !existsSync(shipped(n))) continue;
      // Compare the FUNCTION SURFACE rather than raw bytes: the debug/file_map
      // sections carry absolute paths and timestamps that differ between
      // machines without changing what the browser registers.
      const fns = (p: string) =>
        JSON.stringify(
          (JSON.parse(readFileSync(p, 'utf8')).functions ?? [])
            .map((f: any) => [f.name, f.is_unconstrained, JSON.stringify(f.abi?.parameters ?? [])])
            .sort(),
        );
      if (fns(compiled(n)) !== fns(shipped(n))) drifted.push(n);
    }
    expect(
      drifted,
      'packages/frontend/public/contracts is stale. Run `npm run copy-contracts` and COMMIT it — '
        + 'the deployed site serves what is committed, and a mismatch blocks every new player '
        + 'at their first transaction.',
    ).toEqual([]);
  });
});
