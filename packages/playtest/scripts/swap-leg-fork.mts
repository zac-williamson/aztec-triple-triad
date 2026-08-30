/**
 * Execute the Fee Juice swap against the REAL AZTEC pool, on a mainnet fork.
 *
 * This is the only honest way to test the leg that spends a player's money.
 * The mint route means no live deployment ever runs it, and mainnet itself
 * costs real ETH to probe. A fork gives the real Universal Router, the real
 * v4 PoolManager, the real AZTEC token and the real pool state, for nothing —
 * and it fails loudly if a single byte of the action encoding is wrong, which
 * is exactly the failure mode I cannot verify by reading.
 *
 *   anvil --fork-url <mainnet> --port 8555 &
 *   npx tsx packages/playtest/scripts/swap-leg-fork.mts
 */
import {
  createPublicClient, createWalletClient, http, parseAbi, parseEther, formatEther,
  type Address,
} from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { swapForFeeAsset } from '../../frontend/src/aztec/l1Funding.js';
import { quoteExactInput, quoteExactOutput, quoterFor, NATIVE } from '../../frontend/src/aztec/uniswapQuote.js';
import { resolveAcquireRoute } from '../../frontend/src/aztec/fundingRoutes.js';

const FORK = process.env.FORK_RPC_URL || 'http://127.0.0.1:8555';
/** Verified on mainnet: ERC-20, symbol AZTEC, 18 decimals, 10.35B supply. */
const AZTEC: Address = '0xA27EC0006e59f245217Ff08CD52A7E8b169E62D2';
const UNIVERSAL_ROUTER: Address = '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af';
/** anvil's first default account. */
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
]);

const log = (m: string) => console.log(`  ${m}`);
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failures++;
};

async function main() {
  const account = privateKeyToAccount(KEY);
  const pub = createPublicClient({ chain: mainnet, transport: http(FORK) });
  const wallet = createWalletClient({ account, chain: mainnet, transport: http(FORK) });

  const symbol = await pub.readContract({ address: AZTEC, abi: ERC20, functionName: 'symbol' });
  log(`forked mainnet at block ${await pub.getBlockNumber()}; token symbol = ${symbol}`);
  check(symbol === 'AZTEC', 'the fork is really mainnet and AZTEC is really there');

  // ---- 1. The quoter finds the pool without being told which one ----------
  const quoter = quoterFor(mainnet.id);
  const q = await quoteExactInput({
    pub: pub as never, quoter, tokenIn: NATIVE, tokenOut: AZTEC, amountIn: parseEther('0.05'),
  });
  log(`quote: 0.05 ETH -> ${formatEther(q.amount)} AZTEC ` +
      `(fee ${q.poolKey.fee}, tickSpacing ${q.poolKey.tickSpacing}, hooks ${q.poolKey.hooks})`);
  check(q.amount > 0n, 'the v4 quoter prices a real trade');
  check(q.poolKey.currency0 === NATIVE, 'native ETH sorts first as currency0');
  check(q.zeroForOne === true, 'direction derived correctly from the sorted key');

  const outQ = await quoteExactOutput({
    pub: pub as never, quoter, tokenIn: NATIVE, tokenOut: AZTEC, amountOut: parseEther('1000'),
  });
  log(`exact-out: 1000 AZTEC costs ${formatEther(outQ.amount)} ETH`);
  check(outQ.amount > 0n, 'exact-output quoting works, so a target can be priced');

  // ---- 2. The full route resolution a player actually goes through --------
  const route = await resolveAcquireRoute({
    chainId: mainnet.id,
    pub: pub as never,
    l1: { feeJuiceAddress: AZTEC, feeJuicePortalAddress: AZTEC },  // no handler => swap route
    target: parseEther('1000'),
  });
  if (route.kind !== 'swap') throw new Error('expected a swap route on a chain with no faucet');
  log(`route: spend ${formatEther(route.ethIn)} ETH, expect ${formatEther(route.quotedOut)} AZTEC`);
  check(route.router === UNIVERSAL_ROUTER, 'routes through the Universal Router');
  check(route.quotedOut >= parseEther('1000'), 'the buffer covers the target amount');

  // ---- 3. The swap itself, against the real router and the real pool ------
  const before = await pub.readContract({ address: AZTEC, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
  const gained = await swapForFeeAsset({
    pub: pub as never, wallet: wallet as never, account: account.address, feeAsset: AZTEC, route,
  });
  const after = await pub.readContract({ address: AZTEC, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
  log(`swapped: received ${formatEther(gained)} AZTEC`);
  check(gained > 0n, 'the v4 action encoding is accepted and the swap executes');
  check(after - before === gained, 'the reported amount is the balance actually delivered');
  check(gained >= (route.quotedOut * 98n) / 100n, 'delivery is at or above the slippage floor');

  // ---- 4. The floor must bind, not decorate ------------------------------
  let reverted = false;
  try {
    await swapForFeeAsset({
      pub: pub as never, wallet: wallet as never, account: account.address, feeAsset: AZTEC,
      route: { ...route, ethIn: parseEther('0.001'), quotedOut: route.quotedOut * 1000n, maxSlippage: 0 },
    });
  } catch { reverted = true; }
  check(reverted, 'an unmeetable minimum reverts instead of filling at any price');

  console.log(failures === 0
    ? '\n  ✓ THE v4 SWAP WORKS AGAINST THE REAL AZTEC POOL'
    : `\n  ✗ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
