// @ts-nocheck — Aztec SDK types require sandbox-specific resolution
/**
 * E2E Debug Mint Test — Reproduces the frontend import_note flow
 *
 * 1. debug_mint (uses create_and_push_note — no delivery/tagging)
 * 2. Fetch TxEffect to get note hashes + first nullifier
 * 3. Call import_note.simulate() to import the note into PXE
 * 4. Call get_private_cards — expect 1 card
 *
 * Prerequisites:
 *   - Aztec sandbox running: aztec start --local-network
 *   - Contracts compiled: cd packages/contracts && aztec compile
 *
 * Run:
 *   cd packages/integration
 *   npx vitest run tests/e2e-debug-mint.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { Fr } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Contract } from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { getContractInstanceFromInstantiationParams } from '@aztec/stdlib/contract';
import { NO_FROM } from '@aztec/aztec.js/account';

import { loadContractArtifact } from './e2e-helpers.js';

const PXE_URL = process.env.AZTEC_PXE_URL || 'http://localhost:8080';
const SEND_TIMEOUT = 300;

describe('E2E Debug Mint + import_note', () => {
  let wallet: any;
  let node: any;
  let fee: any;
  let playerAddr: any;
  let nftContract: any;

  const sendAs = (addr: any) => ({
    from: addr,
    fee: { paymentMethod: fee },
    wait: { timeout: SEND_TIMEOUT },
  });

  beforeAll(async () => {
    node = createAztecNodeClient(PXE_URL);
    console.log('Creating EmbeddedWallet...');
    wallet = await EmbeddedWallet.create(node, { ephemeral: true });
    await new Promise(r => setTimeout(r, 3000));

    // SponsoredFPC
    const fpcInstance = await getContractInstanceFromInstantiationParams(
      SponsoredFPCContractArtifact, { salt: new Fr(SPONSORED_FPC_SALT) },
    );
    await wallet.registerContract(fpcInstance, SponsoredFPCContractArtifact);
    fee = new SponsoredFeePaymentMethod(fpcInstance.address);

    // Deploy player account
    console.log('Deploying player account...');
    const playerAccount = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
    await (await playerAccount.getDeployMethod()).send({
      from: NO_FROM,
      fee: { paymentMethod: fee },
      skipClassPublication: true,
      skipInstancePublication: true,
      wait: { timeout: SEND_TIMEOUT },
    });
    playerAddr = playerAccount.address;
    await wallet.registerSender(playerAddr, 'player');
    console.log(`  Player: ${playerAddr}`);

    // Deploy NFT contract
    const nftArtifact = loadContractArtifact('triple_triad_nft-TripleTriadNFT');
    function encodeCompressedString(s: string): Fr {
      let hex = '';
      for (let i = 0; i < s.length && i < 31; i++) {
        hex += s.charCodeAt(i).toString(16).padStart(2, '0');
      }
      return new Fr(BigInt('0x' + hex));
    }

    console.log('Deploying TripleTriadNFT...');
    ({ contract: nftContract } = await Contract.deploy(wallet, nftArtifact, [
      playerAddr,
      encodeCompressedString('Test'),
      encodeCompressedString('T'),
    ]).send(sendAs(playerAddr)));
    console.log(`  NFT at: ${nftContract.address}`);
    await wallet.registerSender(nftContract.address, 'nft');
  }, 300_000);

  it('debug_mint + import_note makes card visible via get_private_cards', async () => {
    const TOKEN_ID = new Fr(42n);
    const RANDOMNESS = Fr.random();

    // 1. Confirm 0 cards before
    const { result: beforeResult } = await nftContract.methods
      .get_private_cards(playerAddr, 0)
      .simulate({ from: playerAddr });
    const before = beforeResult[0];
    expect(before.filter((v: any) => BigInt(v) !== 0n).length).toBe(0);
    console.log('  0 cards before mint ✓');

    // 2. debug_mint — uses create_and_push_note (no delivery/tagging)
    console.log('  Calling debug_mint...');
    const receipt = await nftContract.methods
      .debug_mint(TOKEN_ID, playerAddr, RANDOMNESS)
      .send(sendAs(playerAddr));
    const txHashStr = receipt.txHash?.toString();
    console.log(`  Tx mined: ${txHashStr}`);

    // Brief pause for PXE block sync
    await new Promise(r => setTimeout(r, 2000));

    // 3. Fetch TxEffect for import_note parameters
    const { TxHash } = await import('@aztec/stdlib/tx');
    const txHash = TxHash.fromString(txHashStr);
    const txResult = await node.getTxEffect(txHash);
    expect(txResult?.data).toBeTruthy();
    const txEffect = txResult.data;

    const rawNoteHashes: any[] = txEffect.noteHashes ?? [];
    const nonZeroHashes = rawNoteHashes.filter((h: any) => BigInt(h) !== 0n);
    const firstNullifier = txEffect.nullifiers?.[0];
    console.log(`  TxEffect: ${nonZeroHashes.length} non-zero note hashes`);

    // 4. Call import_note via .simulate() to import note into PXE
    const paddedHashes = new Array(64).fill(new Fr(0n));
    for (let i = 0; i < rawNoteHashes.length && i < 64; i++) {
      paddedHashes[i] = rawNoteHashes[i];
    }

    console.log('  Calling import_note...');
    await nftContract.methods
      .import_note(
        playerAddr,                        // owner
        TOKEN_ID,                          // value
        RANDOMNESS,                        // randomness
        new Fr(BigInt(txHashStr)),          // tx_hash
        paddedHashes,                      // unique_note_hashes [Field; 64]
        nonZeroHashes.length,              // num_note_hashes
        firstNullifier,                    // first_nullifier
        playerAddr,                        // recipient
      )
      .simulate({ from: playerAddr });
    console.log('  import_note completed ✓');

    // 5. Check cards via get_private_cards — should see the note
    const { result: afterImportResult } = await nftContract.methods
      .get_private_cards(playerAddr, 0)
      .simulate({ from: playerAddr });
    const afterImport = afterImportResult[0];
    const cards = afterImport
      .map((v: any) => Number(BigInt(v)))
      .filter((id: number) => id !== 0);
    console.log(`  Cards after import: [${cards}]`);

    expect(cards.length).toBe(1);
    expect(cards).toContain(42);
    console.log('  PASS ✓');
  }, 300_000);
});
