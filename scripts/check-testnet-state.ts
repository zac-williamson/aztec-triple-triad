#!/usr/bin/env npx tsx
/**
 * Testnet stranding tripwire — detects a re-genesis/upgrade in seconds
 * instead of via confused users.
 *
 * The rc testnet has re-genesis'd twice (2026-06-17 v4→v5-rc.1, 2026-06-30
 * rc.1→rc.2), each time silently orphaning the deployed contracts: the site
 * stays up, the node answers, but every game interaction dies. This script
 * asserts the three facts a healthy deployment rests on:
 *
 *   1. the node is reachable and the chain is advancing;
 *   2. the deployed NFT/Game/Token instances EXIST on the current chain;
 *   3. (informational) nodeVersion / rollupVersion, so a drift is loggable.
 *
 * Usage:
 *   npx tsx scripts/check-testnet-state.ts                # reads .env.testnet
 *   npx tsx scripts/check-testnet-state.ts --env-file=... # other dotenv
 *
 * Exit codes: 0 healthy, 1 contracts missing (re-deploy needed), 2 node/chain
 * problem. Run it before a playtest campaign, after any testnet announcement,
 * or from cron.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT_DIR = resolve(import.meta.dirname || __dirname, '..');
const envFileArg = process.argv.find(a => a.startsWith('--env-file='))?.slice('--env-file='.length);
const ENV_FILE = envFileArg ? resolve(envFileArg) : resolve(ROOT_DIR, 'packages/frontend/.env.testnet');

function parseDotenv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

async function main(): Promise<number> {
  const env = parseDotenv(ENV_FILE);
  const rpcUrl = env.VITE_AZTEC_PXE_URL;
  const contracts = {
    NFT: env.VITE_NFT_CONTRACT_ADDRESS,
    Game: env.VITE_GAME_CONTRACT_ADDRESS,
    Token: env.VITE_TOKEN_CONTRACT_ADDRESS,
  };
  if (!rpcUrl || Object.values(contracts).some(v => !v)) {
    console.error(`Missing RPC URL or contract addresses in ${ENV_FILE}`);
    return 2;
  }

  const { createAztecNodeClient } = await import('@aztec/aztec.js/node');
  const { AztecAddress } = await import('@aztec/aztec.js/addresses');
  const node = createAztecNodeClient(rpcUrl);

  // 1. Node reachable + identity
  let info;
  try {
    info = await node.getNodeInfo();
  } catch (e) {
    console.error(`✗ node unreachable at ${rpcUrl}: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
  console.log(`node: ${rpcUrl}`);
  console.log(`  nodeVersion=${info.nodeVersion} rollupVersion=${info.rollupVersion} l1ChainId=${info.l1ChainId}`);

  // 2. Chain advancing (testnet blocks average ~70s, so sample ~2 block times)
  const b1 = await node.getBlockNumber();
  await new Promise(r => setTimeout(r, 150_000));
  const b2 = await node.getBlockNumber();
  if (b2 > b1) {
    console.log(`✓ chain advancing (block ${b1} → ${b2})`);
  } else {
    console.warn(`⚠ chain not advancing in 150s (block ${b1}) — slow blocks or a stalled sequencer`);
  }

  // 3. Contract instances exist on the CURRENT chain
  let missing = 0;
  for (const [name, addr] of Object.entries(contracts)) {
    const instance = await node.getContract(AztecAddress.fromStringUnsafe(addr!)).catch(() => undefined);
    if (instance) {
      console.log(`✓ ${name} ${addr} exists`);
    } else {
      console.error(`✗ ${name} ${addr} NOT FOUND on this chain — testnet re-genesis? Redeploy with deploy-testnet.ts`);
      missing++;
    }
  }
  return missing > 0 ? 1 : 0;
}

main().then(code => process.exit(code)).catch(err => {
  console.error(err.stack || err.message || err);
  process.exit(2);
});
