/**
 * fund-fee-juice.ts — bridge Fee Juice from the L1 treasury to an Aztec account.
 *
 * A headless CLI replacement for the Fee Juice bridge website: it signs the
 * L1->L2 deposit with the treasury key directly (no MetaMask), waits for the
 * message to land in the L2 tree, and persists + prints the resulting CLAIM.
 *
 * Fee Juice is NON-TRANSFERABLE on L2 (see scripts/lib/feeJuiceBridge.ts): this
 * bridges and produces a claim; the destination account turns it into spendable
 * balance by CONSUMING the claim in its next transaction
 * (`FeeJuicePaymentMethodWithClaim`) — e.g. at account deployment, or a standalone
 * claim tx for an already-deployed account.
 *
 * Usage:
 *   npx tsx scripts/fund-fee-juice.ts <0x-aztec-address> [more addresses...]
 *
 * Env:
 *   TESTNET_L1_RPC_URL    L1 (Sepolia) RPC. Default: public publicnode endpoint.
 *   AZTEC_PXE_URL         Aztec node URL. Default: https://rpc.testnet.aztec-labs.com
 *   TREASURY_L1_KEY       Treasury L1 private key (0x). Else read from
 *                         TREASURY_L1_KEY_FILE or ~/.aztec-triad-private/treasury-l1-key.txt.
 *   MESSAGE_WAIT_SECONDS  How long to wait for L1->L2 inclusion (default 600).
 *
 * The claim (secret + leaf index) is saved to the claim store
 * (~/.aztec-triad-private/fee-juice-claims.json, 0600) and printed to stdout.
 */
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import {
  bridgeFeeJuice,
  parseL2Addresses,
  readFunderKey,
  claimStorePath,
  loadClaimStore,
  getStoredClaim,
  putStoredClaim,
  serializeClaim,
} from './lib/feeJuiceBridge.js';

const PXE_URL = process.env.AZTEC_PXE_URL || 'https://rpc.testnet.aztec-labs.com';
const L1_RPC = process.env.TESTNET_L1_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const WAIT = process.env.MESSAGE_WAIT_SECONDS ? Number(process.env.MESSAGE_WAIT_SECONDS) : 600;
const log = (m: string) => console.log(m);

async function main(): Promise<void> {
  const addrs = parseL2Addresses(process.argv.slice(2));
  if (addrs.length === 0) {
    console.error('Usage: npx tsx scripts/fund-fee-juice.ts <0x-aztec-address> [more...]');
    process.exit(2);
  }

  const funderKey = readFunderKey(); // treasury key — Node-side only, never logged
  const node = createAztecNodeClient(PXE_URL);
  const storePath = claimStorePath();
  log(`PXE node:  ${PXE_URL}`);
  log(`L1 RPC:    ${L1_RPC}`);
  log(`claims:    ${storePath}`);
  log(`funding ${addrs.length} account(s): ${addrs.map((a) => a.slice(0, 12) + '…').join(', ')}`);

  const results: { addr: string; ok: boolean; amount?: bigint; error?: string }[] = [];
  for (const addr of addrs) {
    log(`\n=== ${addr} ===`);
    const prior = getStoredClaim(loadClaimStore(storePath), addr);
    if (prior && prior.status === 'pending') {
      log(`note: a PENDING claim already exists (amount ${prior.claimAmount}); bridging again adds a second claim.`);
    }
    try {
      const claim = await bridgeFeeJuice({
        node,
        l1RpcUrl: L1_RPC,
        funderKey,
        l2Address: addr,
        log,
        messageWaitSeconds: WAIT,
      });
      putStoredClaim(storePath, addr, serializeClaim(addr, claim, new Date().toISOString(), 'pending'));
      log(`\n  ✓ bridged ${claim.claimAmount} Fee Juice`);
      log(`    claimSecret:      ${claim.claimSecret.toString()}`);
      log(`    claimSecretHash:  ${claim.claimSecretHash.toString()}`);
      log(`    messageLeafIndex: ${claim.messageLeafIndex}`);
      log(`    messageHash:      ${claim.messageHash}`);
      log(`    claim persisted to ${storePath}`);
      results.push({ addr, ok: true, amount: claim.claimAmount });
    } catch (e: any) {
      const error = e?.message || String(e);
      log(`  ✗ FAILED: ${error}`);
      results.push({ addr, ok: false, error });
    }
  }

  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  log(`\n=== summary: ${ok.length} funded, ${bad.length} failed ===`);
  for (const r of results) log(`  ${r.ok ? '✓' : '✗'} ${r.addr}${r.ok ? ` (${r.amount})` : ` — ${r.error}`}`);
  if (ok.length) {
    log(
      `\nNext: the account consumes its claim in its next tx via FeeJuicePaymentMethodWithClaim ` +
        `(e.g. at deploy). The claim is in the claim store above.`,
    );
  }
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => {
  console.error('FUND FAILED:', e?.message || e);
  process.exit(1);
});
