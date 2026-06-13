#!/usr/bin/env npx tsx
/**
 * Fund one or more Aztec testnet accounts with Fee Juice from a single L1
 * treasury, by bridging L1 -> L2 and persisting each claim for later use.
 *
 * Fee Juice is non-transferable on L2, so "distribution" = one L1->L2 bridge per
 * destination account (mint via the FeeAssetHandler, so the treasury only needs
 * Sepolia ETH for gas). Each claim is persisted; the account consumes it later
 * (e.g. deploy-testnet.ts uses FeeJuicePaymentMethodWithClaim for its deployer).
 *
 * Env (NOTHING is hardcoded — keys/RPCs come from the environment):
 *   TESTNET_L1_RPC_URL   (required)  Sepolia RPC URL.
 *   TREASURY_L1_KEY      0x L1 private key of the funder. If unset, read from
 *                        TREASURY_L1_KEY_FILE.
 *   TREASURY_L1_KEY_FILE path to the key file (default
 *                        ~/.aztec-triad-private/treasury-l1-key.txt, chmod 600).
 *   AZTEC_PXE_URL        Aztec node/RPC URL (default the public testnet RPC).
 *   FEE_JUICE_CLAIMS_FILE  claim-store path (default
 *                        ~/.aztec-triad-private/fee-juice-claims.json).
 *   MESSAGE_WAIT_SECONDS L1->L2 inclusion wait budget (default 600).
 *
 * Usage:
 *   TESTNET_L1_RPC_URL=https://sepolia... \
 *   TREASURY_L1_KEY=$(cat ~/.aztec-triad-private/treasury-l1-key.txt) \
 *   npx tsx scripts/fund-testnet.ts 0x<l2addr> [0x<l2addr> ...]
 *
 * Flags:
 *   --force   re-bridge even if an unconsumed claim already exists for an address.
 */

import { createAztecNodeClient } from '@aztec/aztec.js/node';

import {
  parseL2Addresses,
  bridgeFeeJuice,
  serializeClaim,
  putStoredClaim,
  loadClaimStore,
  getStoredClaim,
  claimStorePath,
  readFunderKey,
} from './lib/feeJuiceBridge';

const DEFAULT_NODE_URL = 'https://rpc.testnet.aztec-labs.com';

async function main() {
  const force = process.argv.includes('--force');
  const l2Addresses = parseL2Addresses(process.argv.slice(2));

  if (l2Addresses.length === 0) {
    console.error('Usage: npx tsx scripts/fund-testnet.ts <l2-address> [<l2-address> ...] [--force]');
    process.exit(2);
  }

  const l1RpcUrl = process.env.TESTNET_L1_RPC_URL;
  if (!l1RpcUrl) {
    throw new Error('TESTNET_L1_RPC_URL is required (a Sepolia RPC URL).');
  }
  const funderKey = readFunderKey();

  const nodeUrl = process.env.AZTEC_PXE_URL || DEFAULT_NODE_URL;
  const storePath = claimStorePath();
  const messageWaitSeconds = process.env.MESSAGE_WAIT_SECONDS
    ? Number(process.env.MESSAGE_WAIT_SECONDS)
    : 600;

  console.log('=== Fund Testnet (Fee Juice L1->L2) ===');
  console.log(`Aztec node:   ${nodeUrl}`);
  console.log(`L1 RPC:       ${l1RpcUrl}`);
  console.log(`Claim store:  ${storePath}`);
  console.log(`Recipients:   ${l2Addresses.length}`);

  const node = createAztecNodeClient(nodeUrl);

  const results: { address: string; status: string }[] = [];
  for (const l2Address of l2Addresses) {
    const existing = getStoredClaim(loadClaimStore(storePath), l2Address);
    if (existing && existing.status === 'pending' && !force) {
      console.log(`\n[skip] ${l2Address.slice(0, 18)}... already has an unconsumed claim (use --force to re-bridge).`);
      results.push({ address: l2Address, status: 'skipped (existing pending claim)' });
      continue;
    }

    console.log(`\n[fund] ${l2Address}`);
    const claim = await bridgeFeeJuice({
      node,
      l1RpcUrl,
      funderKey,
      l2Address,
      log: (m) => console.log(`  ${m}`),
      messageWaitSeconds,
    });

    const record = serializeClaim(l2Address, claim, new Date().toISOString());
    putStoredClaim(storePath, l2Address, record);
    console.log(`  persisted claim (amount ${claim.claimAmount}).`);
    results.push({ address: l2Address, status: `bridged (${claim.claimAmount})` });
  }

  console.log('\n=== Summary ===');
  for (const r of results) console.log(`  ${r.address}  ->  ${r.status}`);
  console.log(`\nClaims persisted to ${storePath}. deploy-testnet.ts will consume the deployer's claim.`);
}

main().catch((err) => {
  console.error('Funding failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
