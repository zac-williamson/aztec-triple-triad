/**
 * claim-fee-juice.ts — claim an account's bridged Fee Juice on its behalf.
 *
 * fund-fee-juice.ts leaves a CLAIM (an L1->L2 message) for an address. An
 * account in one of our own PXEs consumes it in its next transaction
 * (FeeJuicePaymentMethodWithClaim). An account that lives in a wallet we do not
 * drive — a Nulo player's — cannot be made to. It does not have to: the Fee
 * Juice contract's `claim(to, amount, secret, leaf)` credits `to` whoever sends
 * it (the message commits to `to` and the amount, and the secret authorizes
 * consuming it). So the deployer sends it here, paying the fee from its own Fee
 * Juice, and the balance lands on the account.
 *
 * Usage:
 *   set -a; . <(grep ^DEPLOYER_ ~/.aztec-triad-private/deployer-testnet-key.txt); set +a
 *   npx tsx scripts/claim-fee-juice.ts <0x-aztec-address> [more addresses...]
 *
 * Env:
 *   AZTEC_PXE_URL   Aztec node URL. Default: https://aztec-testnet.drpc.org
 *   DEPLOYER_SECRET / DEPLOYER_SALT / DEPLOYER_SIGNING_KEY   the paying account.
 *
 * Reads the pending claim for each address from the claim store
 * (~/.aztec-triad-private/fee-juice-claims.json) and marks it consumed.
 */
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { FeeJuiceContract } from '@aztec-labs/aztec.js/protocol';
import { getFeeJuiceBalance } from '@aztec-labs/aztec.js/utils';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { GrumpkinScalar } from '@aztec-labs/foundation/curves/grumpkin';
import {
  claimStorePath,
  deserializeClaim,
  getStoredClaim,
  loadClaimStore,
  markClaimConsumed,
  parseL2Addresses,
} from './lib/feeJuiceBridge.js';
import { headroomMaxFeesPerGas } from './lib/feeSettings';

const PXE_URL = process.env.AZTEC_PXE_URL || 'https://aztec-testnet.drpc.org';
const TX_TIMEOUT = 600;
const FJ = (v: bigint) => `${(Number(v) / 1e18).toFixed(2)} FJ`;

async function main(): Promise<void> {
  const addrs = parseL2Addresses(process.argv.slice(2));
  if (addrs.length === 0) {
    console.error('Usage: npx tsx scripts/claim-fee-juice.ts <0x-aztec-address> [more...]');
    process.exit(2);
  }
  const { DEPLOYER_SECRET, DEPLOYER_SALT, DEPLOYER_SIGNING_KEY } = process.env;
  if (!DEPLOYER_SECRET || !DEPLOYER_SALT || !DEPLOYER_SIGNING_KEY) {
    throw new Error('DEPLOYER_SECRET/SALT/SIGNING_KEY are required: the deployer pays for the claim');
  }

  const node = createAztecNodeClient(PXE_URL);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxeConfig: { proverEnabled: true } });
  const deployer = await wallet.createSchnorrAccount(
    Fr.fromHexString(DEPLOYER_SECRET),
    Fr.fromHexString(DEPLOYER_SALT),
    GrumpkinScalar.fromHexString(DEPLOYER_SIGNING_KEY),
  );
  console.log(`node:     ${PXE_URL}`);
  console.log(`payer:    ${deployer.address.toString()} (${FJ(await getFeeJuiceBalance(deployer.address, node))})`);
  const feeJuice = FeeJuiceContract.withWallet(wallet);
  const storePath = claimStorePath();

  let failed = 0;
  for (const addr of addrs) {
    const to = AztecAddress.fromStringUnsafe(addr);
    const record = getStoredClaim(loadClaimStore(storePath), addr);
    if (!record || record.status !== 'pending') {
      console.log(`\n${addr}: no pending claim in ${storePath}; bridge one with fund-fee-juice.ts first`);
      failed++;
      continue;
    }
    const claim = deserializeClaim(record, Fr);
    const before = await getFeeJuiceBalance(to, node);
    console.log(`\n${addr}: claiming ${FJ(claim.claimAmount)} (balance ${FJ(before)})...`);
    try {
      await feeJuice.methods
        .claim(to, claim.claimAmount, claim.claimSecret, claim.messageLeafIndex)
        .send({
          from: deployer.address,
          fee: { gasSettings: { maxFeesPerGas: await headroomMaxFeesPerGas(node) } },
          wait: { timeout: TX_TIMEOUT },
        });
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (!/Existing nullifier|Nullifier conflict|duplicate nullifier/i.test(msg)) {
        console.log(`  ✗ ${msg.split('\n')[0]}`);
        failed++;
        continue;
      }
      console.log('  the claim was already consumed');
    }
    markClaimConsumed(storePath, addr);
    console.log(`  ✓ balance now ${FJ(await getFeeJuiceBalance(to, node))}`);
  }
  console.log(`\npayer left with ${FJ(await getFeeJuiceBalance(deployer.address, node))}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
