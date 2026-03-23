// @ts-nocheck
/**
 * E2E Test: Reproduce TransactionInactiveError with IndexedDB backend
 *
 * The bug: complex private functions (6+ nullifiers, 6+ notes) fail with
 * TransactionInactiveError in the PXE's IndexedDB kv-store backend.
 *
 * This ONLY affects browsers (IndexedDB). Node.js tests use LMDB and pass.
 *
 * This test polyfills IndexedDB via fake-indexeddb, then creates a PXE with
 * the IndexedDB store. NOTE: fake-indexeddb does NOT reproduce the browser's
 * aggressive IDB transaction auto-commit behavior, so this test passes even
 * though the same code path fails in real browsers. The test is still useful
 * as documentation and to verify the IndexedDB code path works at all.
 *
 * To actually reproduce the bug, run the app in a browser (Safari or Chrome).
 *
 * Prerequisites:
 *   - Aztec sandbox running: aztec start --local-network
 *   - Contracts compiled: aztec compile
 *
 * Run:
 *   npx vitest run tests/e2e-indexeddb-create-game.test.ts --config vitest.idb.config.ts
 */

// Polyfill IndexedDB BEFORE any Aztec imports
import 'fake-indexeddb/auto';

import { describe, it, expect, beforeAll } from 'vitest';

import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { Fr } from '@aztec/aztec.js/fields';
import { Contract } from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { getContractInstanceFromInstantiationParams } from '@aztec/stdlib/contract';
import { NO_FROM } from '@aztec/aztec.js/account';
import { createLogger } from '@aztec/foundation/log';

// IndexedDB store — normally only used in browsers, polyfilled here via fake-indexeddb
import { openTmpStore as openIdbTmpStore } from '@aztec/kv-store/indexeddb';

// PXE — use the server entrypoint but inject an IndexedDB store
import { createPXE } from '@aztec/pxe/server';
import { getPXEConfig } from '@aztec/pxe/config';

// EmbeddedWallet — use the normal Node entrypoint for account management
import { EmbeddedWallet, WalletDB } from '@aztec/wallets/embedded';

import { loadContractArtifact } from './e2e-helpers.js';

const PXE_URL = process.env.AZTEC_PXE_URL || 'http://localhost:8080';
const SEND_TIMEOUT = 300;

function toFr(s: string | any): any {
  if (s instanceof Fr) return s;
  const str = s.toString();
  if (str.startsWith('0x') || str.startsWith('0X')) return Fr.fromHexString(str);
  return new Fr(BigInt(str));
}

function toHex(v: any): string {
  const s = v.toString();
  if (s.startsWith('0x') || s.startsWith('0X')) return s;
  return '0x' + BigInt(s).toString(16);
}

async function importNotes(
  nftContract: any, node: any, txHash: any, owner: any,
  cardIds: number[], randomnessFrs: any[],
) {
  let txEffect: any = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const txResult = await node.getTxEffect(txHash);
      if (txResult?.data) { txEffect = txResult.data; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!txEffect) { console.warn('  No TxEffect'); return; }

  const uniqueNoteHashes: string[] = (txEffect.noteHashes ?? [])
    .map((h: any) => h.toString())
    .filter((h: string) => h !== '0' && h !== '0x0' && !/^0x0+$/.test(h));
  const firstNullifier = txEffect.nullifiers?.[0]?.toString() ?? '0';
  const paddedHashes = new Array(64).fill(new Fr(0n));
  for (let i = 0; i < uniqueNoteHashes.length && i < 64; i++) paddedHashes[i] = toFr(uniqueNoteHashes[i]);

  for (let i = 0; i < cardIds.length; i++) {
    try {
      await nftContract.methods.import_note(
        owner, new Fr(BigInt(cardIds[i])), randomnessFrs[i],
        toFr(txHash.toString()), paddedHashes, uniqueNoteHashes.length,
        toFr(firstNullifier), owner,
      ).simulate({ from: owner });
    } catch (e: any) {
      console.warn(`  import card ${cardIds[i]} failed:`, e?.message?.slice(0, 100));
    }
  }
}

describe('E2E: create_game with IndexedDB PXE backend', () => {
  let wallet: any;
  let node: any;
  let fee: any;
  let p1Addr: any;
  let nftContract: any;
  let gameContract: any;

  const p1CardIds = [1, 2, 3, 4, 5];
  const sendAs = (addr: any) => ({ from: addr, fee: { paymentMethod: fee }, wait: { timeout: SEND_TIMEOUT } });

  beforeAll(async () => {
    console.log('=== IndexedDB PXE Reproduction Test ===');
    console.log('Tests use fake-indexeddb to reproduce browser IndexedDB behavior in Node.');
    console.log('');

    node = createAztecNodeClient(PXE_URL);

    // Wait for node
    for (let i = 0; i < 120; i++) {
      try { if (await node.getBlockNumber() > 0) break; } catch {}
      if (i === 119) throw new Error('Node not ready');
      await new Promise(r => setTimeout(r, 1000));
    }

    // Create PXE with IndexedDB store (the key difference from normal tests)
    console.log('Creating PXE with IndexedDB store (via fake-indexeddb)...');
    const idbPxeStore = await openIdbTmpStore(true);

    const { l1ChainId, l1ContractAddresses: l1Contracts, rollupVersion } = await node.getNodeInfo();
    const pxeConfig = Object.assign(getPXEConfig(), {
      proverEnabled: false,
      l1Contracts,
      l1ChainId,
      rollupVersion,
      l2BlockBatchSize: 50,
    });

    const pxe = await createPXE(node, pxeConfig, { store: idbPxeStore });
    console.log('  PXE created with IndexedDB backend');

    // Create wallet DB on IndexedDB too
    const walletDbStore = await openIdbTmpStore(true);
    const walletDB = WalletDB.init(walletDbStore, createLogger('wallet:db').info);

    // Construct EmbeddedWallet with our IndexedDB-backed PXE
    // EmbeddedWallet constructor: (pxe, aztecNode, walletDB, accountContracts, logger)
    // Import the account contracts provider via absolute path (bypassing package exports map)
    const path = await import('path');
    const providerPath = path.resolve(
      process.cwd(), 'node_modules/@aztec/wallets/dest/embedded/account-contract-providers/bundle.js',
    );
    const { BundleAccountContractsProvider } = await import(/* @vite-ignore */ providerPath);
    wallet = new EmbeddedWallet(pxe, node, walletDB, new BundleAccountContractsProvider(), createLogger('wallet'));

    await new Promise(r => setTimeout(r, 5000));

    // SponsoredFPC
    const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, { salt: new Fr(SPONSORED_FPC_SALT) });
    await wallet.registerContract(fpc, SponsoredFPCContractArtifact);
    fee = new SponsoredFeePaymentMethod(fpc.address);

    // Deploy account
    console.log('Deploying account...');
    const acct = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
    await (await acct.getDeployMethod()).send({
      from: NO_FROM, fee: { paymentMethod: fee },
      skipClassPublication: true, skipInstancePublication: true,
      wait: { timeout: SEND_TIMEOUT },
    });
    p1Addr = acct.address;
    await wallet.registerSender(p1Addr, 'p1');
    console.log(`  Player: ${p1Addr}`);

    // Deploy contracts
    const nftArt = loadContractArtifact('triple_triad_nft-TripleTriadNFT');
    const gameArt = loadContractArtifact('triple_triad_game-TripleTriadGame');
    const enc = (s: string) => { let h=''; for(let i=0;i<s.length&&i<31;i++) h+=s.charCodeAt(i).toString(16).padStart(2,'0'); return new Fr(BigInt('0x'+h)); };

    console.log('Deploying contracts...');
    ({ contract: nftContract } = await Contract.deploy(wallet, nftArt, [p1Addr, enc('TC'), enc('TC')]).send(sendAs(p1Addr)));
    await wallet.registerSender(nftContract.address, 'nft');
    ({ contract: gameContract } = await Contract.deploy(wallet, gameArt, [nftContract.address, Fr.ZERO, Fr.ZERO]).send(sendAs(p1Addr)));
    await wallet.registerSender(gameContract.address, 'game');
    await nftContract.methods.set_game_contract(gameContract.address).send(sendAs(p1Addr));

    // Mint cards
    console.log('Minting starter cards...');
    const { receipt } = await nftContract.methods.get_cards_for_new_player().send(sendAs(p1Addr));
    const { result: rnd } = await nftContract.methods.compute_note_randomness(0, 5).simulate({ from: p1Addr });
    await importNotes(nftContract, node, receipt.txHash, p1Addr, p1CardIds, Array.from({length:5}, (_,i) => toFr(rnd[i])));

    const { result: cards } = await nftContract.methods.get_private_cards(p1Addr, 0).simulate({ from: p1Addr });
    const cnt = cards[0].filter((v: any) => BigInt(v) !== 0n).length;
    console.log(`  ${cnt}/5 cards visible`);
    expect(cnt).toBeGreaterThanOrEqual(5);
    console.log('Setup complete.\n');
  }, 600_000);

  it('create_game should succeed (or fail with TransactionInactiveError to confirm the bug)', async () => {
    const { result: nonce } = await nftContract.methods.get_note_nonce(p1Addr).simulate({ from: p1Addr });
    const { result: preview } = await nftContract.methods.preview_game_data(toFr(nonce)).simulate({ from: p1Addr });
    const gameIdHex = toHex(preview[0]);

    const { result: s0 } = await gameContract.methods.get_game_status(toFr(gameIdHex)).simulate({ from: p1Addr });
    expect(BigInt(s0)).toBe(0n);

    console.log(`Calling create_game (game_id=${gameIdHex.slice(0,18)}...)...`);
    console.log('This generates 6 nullifiers + 6 notes in a single tx.');
    console.log('In the browser, this fails with TransactionInactiveError.');
    const t0 = Date.now();

    await gameContract.methods
      .create_game(p1CardIds.map(id => new Fr(BigInt(id))))
      .send(sendAs(p1Addr));

    console.log(`create_game completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const { result: s1 } = await gameContract.methods.get_game_status(toFr(gameIdHex)).simulate({ from: p1Addr });
    expect(BigInt(s1)).toBe(1n);
    console.log('Test PASSED — create_game succeeded with IndexedDB backend.');
    console.log('NOTE: fake-indexeddb may not reproduce the exact browser IDB transaction timing.');
    console.log('If this passes but the browser still fails, the issue is browser-specific IDB auto-commit behavior.');
  }, 300_000);
});
