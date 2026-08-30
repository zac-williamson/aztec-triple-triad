/**
 * Execute the Fee Juice swap leg against a REAL Uniswap V3 pool.
 *
 * On every network we can actually deploy to, the fee asset is a mock with a
 * free mint, so `swapForFeeAsset` — the only code path that spends a player's
 * own money — never runs. That is precisely the wrong thing to leave untested.
 *
 * Sepolia has no AZTEC pool, but it does have real Uniswap V3 contracts and
 * real pools, so this points the same production function at WETH -> UNI. The
 * pair is a stand-in; the router, the quoter, the calldata encoding, the ETH
 * value, the slippage floor and the balance-delta accounting are all the real
 * ones. If this passes, the mainnet leg is exercised apart from which token
 * address it names.
 *
 *   npx tsx packages/playtest/scripts/swap-leg-live.mts
 */
import {
  createPublicClient, createWalletClient, custom, http, formatEther, parseEther,
  type Address,
} from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { swapForFeeAsset } from '../../frontend/src/aztec/l1Funding.js';
import { quoteExactInput, quoterFor } from '../../frontend/src/aztec/uniswapQuote.js';
import { createFundedL1Account, refundTreasury, localSignerProvider, L1_RPC } from '../src/walletShim.js';

// Sepolia deployments (Uniswap docs) — not the mainnet table in fundingRoutes.
const ROUTER: Address = '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E';
const QUOTER: Address = '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3';
const WETH: Address = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
const TOKEN_OUT: Address = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984'; // UNI

const ETH_IN = parseEther('0.002');
const log = (m: string) => console.log(`  ${m}`);

async function main() {
  const pub = createPublicClient({ chain: sepolia, transport: http(L1_RPC) });

  log('quoting the live pool…');
  const { poolFee, amountOut } = await quoteExactInput({
    pub: pub as never, quoter: quoterFor(sepolia.id, QUOTER),
    tokenIn: WETH, tokenOut: TOKEN_OUT, amountIn: ETH_IN,
  });
  log(`tier ${poolFee}: ${formatEther(ETH_IN)} ETH -> ${formatEther(amountOut)} tokens`);

  // Enough for the swap plus gas.
  const wallet = await createFundedL1Account({ fundWei: parseEther('0.01'), log });
  // Production asks a WALLET to sign — eth_sendTransaction with an address, not
  // a local account — so drive it through the same signer the browser shim
  // installs, not a bare RPC transport that holds no keys.
  const account = privateKeyToAccount(wallet.privateKey);
  const transport = custom(localSignerProvider(wallet.privateKey));
  const walletClient = createWalletClient({ account: account.address, transport });

  let failures = 0;
  const check = (ok: boolean, what: string) => {
    console.log(`  ${ok ? '✓' : '✗'} ${what}`);
    if (!ok) failures++;
  };

  try {
    log('swapping through the production code path…');
    const gained = await swapForFeeAsset({
      pub: pub as never, wallet: walletClient as never, account: account.address,
      feeAsset: TOKEN_OUT,
      route: {
        kind: 'swap', router: ROUTER, weth: WETH, poolFee,
        ethIn: ETH_IN, quotedOut: amountOut, maxSlippage: 0.02,
      },
    });
    log(`received ${formatEther(gained)} tokens`);
    check(gained > 0n, 'the swap delivered tokens');
    // The floor is quoted-minus-slippage; landing under it means the floor was
    // not actually applied to the transaction.
    check(gained >= (amountOut * 9800n) / 10_000n, 'delivery is at or above the slippage floor');

    // The floor must be enforceable, not decorative: an impossible minimum has
    // to revert rather than fill at a worse price.
    log('checking the slippage floor actually binds…');
    let reverted = false;
    try {
      await swapForFeeAsset({
        pub: pub as never, wallet: walletClient as never, account: account.address,
        feeAsset: TOKEN_OUT,
        route: {
          kind: 'swap', router: ROUTER, weth: WETH, poolFee,
          ethIn: parseEther('0.0005'),
          quotedOut: amountOut * 1000n,   // demand far more than the pool can give
          maxSlippage: 0,
        },
      });
    } catch {
      reverted = true;
    }
    check(reverted, 'an unmeetable minimum reverts instead of filling');
  } finally {
    await refundTreasury(wallet.privateKey, log);
  }

  console.log(failures === 0
    ? '\n  ✓ SWAP LEG WORKS AGAINST A REAL UNISWAP V3 POOL'
    : `\n  ✗ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
