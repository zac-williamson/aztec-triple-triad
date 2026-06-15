/**
 * Harness configuration — single source for ports, paths, and stack layout.
 * Everything matches the app's own defaults (vite.config.ts port 3000,
 * backend DEFAULT_PORT 5174, sandbox node 8080, anvil 8545).
 */
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Live-testnet mode (F3): point the harness at the deployed testnet + live ws
 * relay instead of a local sandbox. The only local process is the vite dev
 * server (VITE_TESTKIT) serving the real app against testnet contracts.
 */
export const TESTNET = process.env.PLAYTEST_TESTNET === '1';

// PXE the harness-side ChainClient reads public game state from. Testnet points
// it at the public RPC; local defaults to the sandbox node.
export const PXE_URL = process.env.PLAYTEST_PXE_URL || 'http://localhost:8080';
export const ANVIL_PORT = 8545;
export const NODE_PORT = 8080;
export const BACKEND_PORT = 5174;
export const FRONTEND_PORT = 3000;
// WS relay base for liveness probes + /games checks. Testnet = the live relay.
export const BACKEND_URL = process.env.PLAYTEST_BACKEND_URL || `http://localhost:${BACKEND_PORT}`;
export const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;

/**
 * Reuse mode (explicit opt-in for the inner dev loop): attach to an already
 * running sandbox+deploy+backend+frontend instead of booting a fresh stack.
 * Campaign determinism guarantees only hold on a fresh stack.
 */
export const REUSE_STACK = process.env.PLAYTEST_REUSE_STACK === '1';

export const PLAYTEST_DIR = resolve(ROOT, 'packages/playtest');
export const ARTIFACTS_DIR = resolve(PLAYTEST_DIR, '.artifacts');
/** Per-test-run handoff (globalSetup → tests → globalTeardown). */
export const STACK_INFO_PATH = resolve(ARTIFACTS_DIR, 'stack.json');
/**
 * Pre-provisioned playtest account pool (scripts/provision-playtest-accounts.ts).
 * In TESTNET mode the harness claims the next unused account from here and seeds
 * its keys + minted starter cards into localStorage, so onboarding restores an
 * already-deployed account with no app faucet. See docs/plan/PLAYTEST_SELFFUND.md.
 */
export const PLAYTEST_ACCOUNTS_PATH = resolve(ARTIFACTS_DIR, 'playtest-accounts.json');
/** Registry for a long-lived stack from scripts/boot-stack.ts (stop-stack.ts kills it). */
export const STANDALONE_INFO_PATH = resolve(ARTIFACTS_DIR, 'standalone-stack.json');
/**
 * Registry of per-player Chromium PIDs launched by the campaign. The campaign
 * launches one detached Chromium per player (own process group) for GPU
 * isolation; Playwright only kills those on a graceful worker exit
 * (exit/SIGINT/SIGTERM hooks). If the worker is SIGKILLed, the detached
 * browsers ORPHAN and leak across runs. We record their pids here so
 * globalTeardown/stop-stack can kill the leaked process groups as a backstop.
 */
export const BROWSER_REGISTRY_PATH = resolve(ARTIFACTS_DIR, 'browser-pids.json');
// Testnet reads the deployed addresses from .env.testnet (deploy-testnet.ts
// output, verified to match the live Vercel prod env); local reads .env.
export const FRONTEND_ENV_PATH = resolve(ROOT, 'packages/frontend', TESTNET ? '.env.testnet' : '.env');
/** CJS bundle of game-logic's source, rebuilt by globalSetup (see expected.ts). */
export const GAME_LOGIC_BUNDLE_PATH = resolve(ARTIFACTS_DIR, 'game-logic.bundle.cjs');

export interface ContractAddresses {
  nft: string;
  game: string;
  token: string;
}

/** Contract addresses from the deploy script's output file (frontend/.env). */
export function readContractAddresses(): ContractAddresses {
  const env = readFileSync(FRONTEND_ENV_PATH, 'utf-8');
  const get = (key: string): string => {
    const m = env.match(new RegExp(`^${key}=(.+)$`, 'm'));
    if (!m) throw new Error(`${key} missing from ${FRONTEND_ENV_PATH} — did deploy-contracts.ts run?`);
    return m[1].trim();
  };
  return {
    nft: get('VITE_NFT_CONTRACT_ADDRESS'),
    game: get('VITE_GAME_CONTRACT_ADDRESS'),
    token: get('VITE_TOKEN_CONTRACT_ADDRESS'),
  };
}

/**
 * Stack ownership:
 *  - 'run':        booted by this test run's globalSetup — globalTeardown kills it
 *  - 'standalone': booted by scripts/boot-stack.ts — only scripts/stop-stack.ts kills it
 *  - 'attached':   reuse mode — nobody in this run kills anything
 */
export type StackMode = 'run' | 'standalone' | 'attached' | 'testnet';

export interface StackInfo {
  mode: StackMode;
  pids: { sandbox?: number; backend?: number; frontend?: number };
  addresses: ContractAddresses | null;
  logsDir: string;
}

export function readStackInfo(path: string = STACK_INFO_PATH): StackInfo {
  return JSON.parse(readFileSync(path, 'utf-8'));
}
