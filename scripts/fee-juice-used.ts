/**
 * What an account has actually spent in Fee Juice.
 *
 * `DEFAULT_FEE_JUICE_TARGET` is how much the app bridges for a new player, and
 * it was chosen as a plausible round number rather than measured. Too low
 * strands someone mid-game with no way to buy more without leaving the app, so
 * the number wants evidence behind it.
 *
 * Reads the FeeJuice balances map straight out of node public storage — the
 * same slot derivation the SDK's own getFeeJuiceBalance uses — so it needs
 * nothing but an address. No keys, no PXE, and it works on any account,
 * including the throwaway ones a production run leaves behind.
 *
 *   npx tsx scripts/fee-juice-used.ts 0x<aztec-address> [more addresses…]
 *
 * The "used" column is against the 1e18 target, so it is only meaningful for
 * accounts the app funded. For the bot, which was funded separately, read the
 * balance and ignore the percentage.
 */
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { Fr } from '@aztec/foundation/curves/bn254';
import { ProtocolContractAddress } from '@aztec/protocol-contracts';
import { deriveStorageSlotInMap } from '@aztec/stdlib/hash';
import { AztecAddress } from '@aztec/aztec.js/addresses';

const NODE = process.env.AZTEC_NODE_URL ?? 'https://v5.testnet.rpc.aztec-labs.com';
/**
 * What each account started with. On testnet the fee asset has a free faucet
 * and the app bridges whatever its `mintAmount()` returns — currently 1e21,
 * read off the handler at 0x5602c39a…. NOT DEFAULT_FEE_JUICE_TARGET, which
 * only governs the mainnet swap route.
 */
const FUNDED = BigInt(process.env.FEE_JUICE_FUNDED ?? (10n ** 21n).toString());

// One client for the whole run: a fresh one per address hammers the public RPC
// hard enough that it stops answering after the first read.
let shared: ReturnType<typeof createAztecNodeClient> | null = null;

export async function feeJuiceOf(address: string, nodeUrl = NODE): Promise<bigint> {
  shared ??= createAztecNodeClient(nodeUrl);
  // Slot 1 is FeeJuice's balances map.
  const slot = await deriveStorageSlotInMap(new Fr(1), AztecAddress.fromStringUnsafe(address));
  const raw = await shared.getPublicStorageAt('latest', ProtocolContractAddress.FeeJuice, slot);
  return raw.toBigInt();
}

async function main(): Promise<void> {
  const addresses = process.argv.slice(2);
  if (addresses.length === 0) {
    console.error('usage: npx tsx scripts/fee-juice-used.ts 0x<aztec-address> [...]');
    process.exit(1);
  }
  const used: bigint[] = [];
  for (const a of addresses) {
    // fromStringUnsafe lives up to its name: hand it "0xaaa… 0xbbb…" and it
    // parses the first and ignores the rest, so a shell that did not split its
    // arguments (zsh does not word-split unquoted variables) reads as one
    // account instead of nine, with no error anywhere.
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(a)) {
      console.error(`not an address: ${JSON.stringify(a.slice(0, 40))}…  ` +
        `(zsh? use \${=VAR} or xargs — an unsplit list is silently truncated)`);
      process.exitCode = 1;
      continue;
    }
    try {
      const left = await feeJuiceOf(a);
      // An account that never deployed reads as zero, which is not consumption.
      if (left === 0n) { console.log(`${a.slice(0, 16)}…  left=0  (never funded or never deployed)`); continue; }
      const spent = FUNDED - left;
      used.push(spent);
      console.log(`${a.slice(0, 16)}…  left=${fmt(left)}  used=${fmt(spent)}`);
    } catch (err) {
      console.log(`${a.slice(0, 16)}…  unreadable: ${(err as Error).message.slice(0, 60)}`);
    }
    await new Promise(r => setTimeout(r, 300));   // be kind to the public RPC
  }
  if (used.length > 1) {
    const sorted = [...used].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    console.log(`\n${used.length} accounts — min ${fmt(sorted[0])}, ` +
      `median ${fmt(sorted[Math.floor(sorted.length / 2)])}, max ${fmt(sorted[sorted.length - 1])}`);
  }
}

/** Fee Juice in whole units, which is the scale everything else is quoted in. */
function fmt(v: bigint): string {
  const whole = v / 10n ** 18n;
  const frac = ((v % 10n ** 18n) * 1000n) / 10n ** 18n;
  return `${whole}.${frac.toString().padStart(3, '0')}e18`;
}

// Importable for tests; only runs when invoked directly. Not top-level await:
// scripts/ transpiles to CJS here, which does not support it.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
