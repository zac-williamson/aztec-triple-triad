/**
 * Refund every throwaway account a killed run left behind.
 *
 * The production drivers refund on the way out, including from a signal
 * handler, but a SIGTERM followed promptly by SIGKILL — how a supervisor stops
 * a background job — kills the refund with its RPC call still in flight. So
 * each funded key is written to a ledger when it is created and struck off
 * when its refund lands, and this collects the remainder.
 *
 *   npx tsx packages/playtest/scripts/sweep-throwaways.mts
 *   npx tsx packages/playtest/scripts/sweep-throwaways.mts --dry-run
 *
 * Safe to run at any time: an account with nothing in it is simply struck off.
 * Do NOT run it while a game is in progress — refunding an account mid-run
 * takes the gas its next transaction needs.
 */
import { createPublicClient, http, formatEther } from 'viem';
import { sepolia } from 'viem/chains';
import { pendingThrowaways, refundTreasury, KEY_LEDGER, L1_RPC } from '../src/walletShim.js';

const dryRun = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  const pending = pendingThrowaways();
  if (pending.length === 0) {
    console.log(`nothing pending in ${KEY_LEDGER}`);
    return;
  }
  console.log(`${pending.length} account(s) recorded as unrefunded in ${KEY_LEDGER}`);
  const pub = createPublicClient({ chain: sepolia, transport: http(L1_RPC) });

  let recovered = 0n;
  for (const { address, privateKey, at } of pending) {
    const balance = await pub.getBalance({ address });
    console.log(`  ${address}  ${formatEther(balance)} ETH  (funded ${at})`);
    if (dryRun) continue;
    const before = balance;
    await refundTreasury(privateKey, m => console.log(`    ${m}`));
    if (before > 0n) recovered += before;
  }
  if (!dryRun) console.log(`\nswept up to ~${formatEther(recovered)} ETH back to the treasury`);
}

main().catch(err => { console.error(err); process.exit(1); });
