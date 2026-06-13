/**
 * Harness configuration — single source for ports, paths, and stack layout.
 * Everything matches the app's own defaults (vite.config.ts port 3000,
 * backend DEFAULT_PORT 5174, sandbox node 8080, anvil 8545).
 */
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const PXE_URL = 'http://localhost:8080';
export const ANVIL_PORT = 8545;
export const NODE_PORT = 8080;
export const BACKEND_PORT = 5174;
export const FRONTEND_PORT = 3000;
export const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
export const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;

/**
 * Reuse mode (explicit opt-in for the inner dev loop): attach to an already
 * running sandbox+deploy+backend+frontend instead of booting a fresh stack.
 * Campaign determinism guarantees only hold on a fresh stack.
 */
export const REUSE_STACK = process.env.PLAYTEST_REUSE_STACK === '1';

export const PLAYTEST_DIR = resolve(ROOT, 'packages/playtest');
export const ARTIFACTS_DIR = resolve(PLAYTEST_DIR, '.artifacts');
export const STACK_INFO_PATH = resolve(ARTIFACTS_DIR, 'stack.json');
export const FRONTEND_ENV_PATH = resolve(ROOT, 'packages/frontend/.env');

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

export interface StackInfo {
  pids: { sandbox?: number; backend?: number; frontend?: number };
  addresses: ContractAddresses;
  logsDir: string;
  reused: boolean;
}

export function readStackInfo(): StackInfo {
  return JSON.parse(readFileSync(STACK_INFO_PATH, 'utf-8'));
}
