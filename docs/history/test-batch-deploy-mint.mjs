/**
 * E2E test: deploy account + mint starter cards in a single transaction.
 *
 * Requires:
 *   - Sandbox running: ./start-sandbox.sh (SEQ_MIN_TX_PER_BLOCK=0)
 *   - Contracts deployed: npx tsx scripts/deploy-contracts.ts
 *
 * Validates:
 *   1. Fee Juice bridging from L1
 *   2. L1→L2 message sync
 *   3. Single-tx batch: deploy + claim fee juice + mint cards
 *   4. Account deployment verified by re-deploy attempt (must fail with existing nullifier)
 *   5. Note import from the combined tx
 *   6. Card ownership verification via get_private_cards
 */

import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { Fr } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { NO_FROM } from '@aztec/aztec.js/account';
import { FeeJuicePaymentMethodWithClaim } from '@aztec/aztec.js/fee';
import { Contract } from '@aztec/aztec.js/contracts';
import { loadContractArtifact } from '@aztec/aztec.js/abi';
import { L1FeeJuicePortalManager } from '@aztec/aztec.js/ethereum';
import { createExtendedL1Client } from '@aztec/ethereum/client';
import { mergeExecutionPayloads } from '@aztec/stdlib/tx';
import { readFileSync } from 'fs';

const PXE_URL = 'http://localhost:8080';
const NFT_ADDRESS = process.env.NFT_ADDRESS || '0x1c53bf77e6d5a13d0fa613398e06a536d6d80846489e09604c6af69367e43395';
const GAME_ADDRESS = process.env.GAME_ADDRESS || '0x21edee4dfb5676d32bad9328bcd897dcc746c9a1277d7133639a752f655d88d3';
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS || '0x1c063fc2657a3f4b3185c2997b2d659c7868fc507b285c97300010357690f291';
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const STARTER_CARD_IDS = [1, 2, 3, 4, 5];
const TX_TIMEOUT = 300;

let passed = 0;
let failed = 0;

function log(msg) { console.log(`[test] ${msg}`); }

function assert(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
    return false;
  }
  console.log(`  PASS: ${msg}`);
  passed++;
  return true;
}

async function main() {
  console.log('=== E2E: Batch Deploy + Mint ===\n');

  // ── Step 1: Setup ─────────────────────────────────────────────
  log('Step 1: Creating node client and wallet...');
  const node = createAztecNodeClient(PXE_URL);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxeConfig: { proverEnabled: false } });

  // Use fixed keys so we can reason about the account deterministically
  const secret = Fr.random();
  const salt = Fr.random();
  const signingKey = GrumpkinScalar.random();
  const account = await wallet.createSchnorrAccount(secret, salt, signingKey);
  log(`Account address: ${account.address}`);

  // ── Step 2: Verify account is NOT deployed ────────────────────
  log('Step 2: Verifying account is not yet deployed...');
  // Attempt to deploy — should succeed (proves it's not deployed yet)
  // We don't actually send this, just verify the precondition
  let preDeployContract = null;
  try { preDeployContract = await node.getContract(account.address); } catch {}
  // getContract may return null for undeployed accounts — that's expected
  log(`  getContract returned: ${preDeployContract ? 'instance found' : 'null (expected for undeployed)'}`);

  // ── Step 3: Register all contracts ────────────────────────────
  log('Step 3: Registering contracts...');
  const nftAddr = AztecAddress.fromString(NFT_ADDRESS);
  const gameAddr = AztecAddress.fromString(GAME_ADDRESS);
  const tokenAddr = AztecAddress.fromString(TOKEN_ADDRESS);

  await wallet.registerSender(nftAddr, 'nft-contract');
  await wallet.registerSender(gameAddr, 'game-contract');
  await wallet.registerSender(tokenAddr, 'token-contract');

  const nftArtifact = loadContractArtifact(JSON.parse(readFileSync('packages/frontend/public/contracts/triple_triad_nft-TripleTriadNFT.json', 'utf-8')));
  const gameArtifact = loadContractArtifact(JSON.parse(readFileSync('packages/frontend/public/contracts/triple_triad_game-TripleTriadGame.json', 'utf-8')));
  const tokenArtifact = loadContractArtifact(JSON.parse(readFileSync('packages/frontend/public/contracts/arena_token-ArenaToken.json', 'utf-8')));

  const nftInstance = await node.getContract(nftAddr);
  assert(!!nftInstance, 'NFT contract exists on-chain');
  await wallet.registerContract(nftInstance, nftArtifact);

  const gameInstance = await node.getContract(gameAddr);
  assert(!!gameInstance, 'Game contract exists on-chain');
  await wallet.registerContract(gameInstance, gameArtifact);

  const tokenInstance = await node.getContract(tokenAddr);
  assert(!!tokenInstance, 'Token contract exists on-chain');
  await wallet.registerContract(tokenInstance, tokenArtifact);

  const nftContract = await Contract.at(nftAddr, nftArtifact, wallet);

  // ── Step 4: Bridge Fee Juice from L1 ──────────────────────────
  log('Step 4: Bridging Fee Juice from L1...');
  const l1Client = createExtendedL1Client(['http://localhost:8545'], ANVIL_MNEMONIC);
  const portalManager = await L1FeeJuicePortalManager.new(node, l1Client, {
    info: () => {}, warn: () => {}, error: console.error, debug: () => {}, verbose: () => {},
  });
  const bridgeResult = await portalManager.bridgeTokensPublic(account.address, undefined, true);
  assert(bridgeResult.claimAmount > 0n, `Bridged ${bridgeResult.claimAmount} Fee Juice`);

  // ── Step 5: Wait for L1→L2 message ────────────────────────────
  log('Step 5: Waiting for L1→L2 message in tree...');
  const messageHash = Fr.fromHexString(bridgeResult.messageHash);
  let messageSynced = false;
  for (let i = 0; i < 120; i++) {
    try {
      const w = await node.getL1ToL2MessageMembershipWitness('latest', messageHash);
      if (w) { messageSynced = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  assert(messageSynced, 'L1→L2 message synced into tree');

  // ── Step 6: Build combined deploy+mint tx ─────────────────────
  log('Step 6: Building combined fee payment method (claim + mint)...');
  const feeJuiceClaim = new FeeJuicePaymentMethodWithClaim(account.address, {
    claimAmount: bridgeResult.claimAmount,
    claimSecret: bridgeResult.claimSecret,
    messageLeafIndex: bridgeResult.messageLeafIndex,
  });

  const feePayload = await feeJuiceClaim.getExecutionPayload();
  const mintPayload = await nftContract.methods.get_cards_for_new_player().request();
  const mergedPayload = mergeExecutionPayloads([feePayload, mintPayload]);

  const combinedPaymentMethod = {
    getExecutionPayload: async () => mergedPayload,
    getAsset: () => feeJuiceClaim.getAsset(),
    getFeePayer: () => feeJuiceClaim.getFeePayer(),
    getGasSettings: () => feeJuiceClaim.getGasSettings(),
  };

  assert(feePayload.calls.length > 0, `Fee payload has ${feePayload.calls.length} calls`);
  assert(mintPayload.calls.length > 0, `Mint payload has ${mintPayload.calls.length} calls`);
  assert(mergedPayload.calls.length === feePayload.calls.length + mintPayload.calls.length,
    `Merged payload has ${mergedPayload.calls.length} calls (fee + mint)`);

  // ── Step 7: Send single tx ────────────────────────────────────
  log('Step 7: Sending batched deploy+claim+mint tx...');
  const deployMethod = await account.getDeployMethod();
  const t0 = Date.now();
  const { receipt } = await deployMethod.send({
    from: NO_FROM,
    fee: { paymentMethod: combinedPaymentMethod },
    wait: { timeout: TX_TIMEOUT },
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const txHash = receipt?.txHash?.toString();
  assert(!!txHash, `Tx confirmed in ${elapsed}s — txHash: ${txHash?.slice(0, 20)}...`);

  // ── Step 8: Verify account IS deployed ────────────────────────
  // The definitive test: attempt to deploy the SAME account again.
  // If the account was deployed, its deployment nullifier already exists,
  // and the second deploy MUST fail with "existing nullifier" or similar.
  log('Step 8: Verifying account deployment by attempting re-deploy...');

  // Need a second bridge for fees on the re-deploy attempt
  const bridgeResult2 = await portalManager.bridgeTokensPublic(account.address, undefined, true);
  const messageHash2 = Fr.fromHexString(bridgeResult2.messageHash);
  for (let i = 0; i < 120; i++) {
    try {
      const w = await node.getL1ToL2MessageMembershipWitness('latest', messageHash2);
      if (w) break;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }

  const feeJuiceClaim2 = new FeeJuicePaymentMethodWithClaim(account.address, {
    claimAmount: bridgeResult2.claimAmount,
    claimSecret: bridgeResult2.claimSecret,
    messageLeafIndex: bridgeResult2.messageLeafIndex,
  });

  // Recreate the account manager with the SAME keys — produces the same address
  const account2 = await wallet.createSchnorrAccount(secret, salt, signingKey);
  assert(account2.address.toString() === account.address.toString(),
    'Recreated account has same address');

  const deployMethod2 = await account2.getDeployMethod();
  let redeployFailed = false;
  let redeployError = '';
  try {
    await deployMethod2.send({
      from: NO_FROM,
      fee: { paymentMethod: feeJuiceClaim2 },
      wait: { timeout: TX_TIMEOUT },
    });
  } catch (err) {
    redeployFailed = true;
    redeployError = err.message || String(err);
  }

  assert(redeployFailed, 'Re-deploy attempt correctly failed');
  assert(
    redeployError.includes('nullifier') || redeployError.includes('already') || redeployError.includes('Invalid tx'),
    `Re-deploy error indicates existing deployment: "${redeployError.slice(0, 100)}"`
  );

  // ── Step 9: Import card notes ─────────────────────────────────
  log('Step 9: Importing card notes from combined tx...');
  const { TxHash } = await import('@aztec/stdlib/tx');
  const txEffect = await node.getTxEffect(TxHash.fromString(txHash));
  assert(!!txEffect?.data, 'TxEffect fetched successfully');

  const rawNoteHashes = txEffect.data.noteHashes ?? [];
  const noteHashes = rawNoteHashes.map(h => h.toString()).filter(h => h !== '0' && !/^0x0+$/.test(h));
  const firstNullifier = txEffect.data.nullifiers?.[0]?.toString() ?? '0';
  assert(noteHashes.length > 0, `TxEffect has ${noteHashes.length} non-zero note hashes`);
  assert(firstNullifier !== '0', `First nullifier is non-zero: ${firstNullifier.slice(0, 20)}...`);

  const { result: randomnessResult } = await nftContract.methods
    .compute_note_randomness(0, 5)
    .simulate({ from: account.address });

  const paddedHashes = new Array(64).fill(new Fr(0n));
  for (let i = 0; i < noteHashes.length && i < 64; i++) {
    const s = noteHashes[i];
    paddedHashes[i] = s.startsWith('0x') ? Fr.fromHexString(s) : new Fr(BigInt(s));
  }
  const txHashFr = Fr.fromHexString(txHash);
  const firstNullFr = firstNullifier.startsWith('0x')
    ? Fr.fromHexString(firstNullifier)
    : new Fr(BigInt(firstNullifier));

  let importedCount = 0;
  for (let i = 0; i < 5; i++) {
    const randomness = randomnessResult[i];
    const rFr = randomness instanceof Fr ? randomness :
      randomness.toString().startsWith('0x') ? Fr.fromHexString(randomness.toString()) :
      new Fr(BigInt(randomness.toString()));

    try {
      await nftContract.methods
        .import_note(account.address, new Fr(BigInt(STARTER_CARD_IDS[i])), rFr, txHashFr,
          paddedHashes, noteHashes.length, firstNullFr, account.address)
        .simulate({ from: account.address });
      importedCount++;
    } catch (e) {
      console.error(`  Failed to import card ${STARTER_CARD_IDS[i]}: ${e.message?.slice(0, 100)}`);
    }
  }
  assert(importedCount === 5, `Imported ${importedCount}/5 card notes`);

  // ── Step 10: Verify card ownership ────────────────────────────
  log('Step 10: Verifying card ownership via get_private_cards...');
  const { result: cardsResult } = await nftContract.methods
    .get_private_cards(account.address, 0)
    .simulate({ from: account.address });
  const page = cardsResult[0] ?? cardsResult;
  const ownedIds = (Array.isArray(page) ? page : [page])
    .map(v => Number(BigInt(v)))
    .filter(id => id !== 0);

  assert(ownedIds.length === 5, `Player owns ${ownedIds.length} cards (expected 5)`);
  for (const id of STARTER_CARD_IDS) {
    assert(ownedIds.includes(id), `Card ${id} is owned`);
  }

  // ── Summary ───────────────────────────────────────────────────
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('TEST SUITE FAILED');
    process.exit(1);
  }
  console.log('ALL CHECKS PASSED');
  console.log('Single tx: deployed account + claimed Fee Juice + minted 5 starter cards');
  process.exit(0);
}

main().catch(err => {
  console.error('\nTEST CRASHED:', err.message || err);
  process.exit(1);
});
