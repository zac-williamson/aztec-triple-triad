// @ts-nocheck — Aztec SDK types require sandbox-specific resolution
/**
 * E2E Mint Test — Mints a card via mint_to_private and checks visibility
 *
 * 1. Deploy NFT contract with player as minter
 * 2. mint_to_private (uses standard note delivery — PXE auto-discovers)
 * 3. Call get_private_cards — expect 1 card
 *
 * Prerequisites:
 *   - Aztec sandbox running: aztec start --local-network
 *   - Contracts compiled: cd packages/contracts && aztec compile
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

describe('E2E Mint + get_private_cards', () => {
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

    // Deploy NFT contract (player is minter)
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

  it('mint_to_private makes card visible via get_private_cards', async () => {
    const TOKEN_ID = new Fr(42n);
    const PACKED_RANKS = new Fr(0n); // ranks not needed for this test

    // 1. Confirm 0 cards before
    const { result: beforeResult } = await nftContract.methods
      .get_private_cards(playerAddr, 0)
      .simulate({ from: playerAddr });
    const before = beforeResult[0];
    expect(before.filter((v: any) => BigInt(v) !== 0n).length).toBe(0);
    console.log('  0 cards before mint ✓');

    // 2. mint_to_private — uses standard note delivery (PXE auto-discovers)
    console.log('  Calling mint_to_private...');
    const { receipt } = await nftContract.methods
      .mint_to_private(playerAddr, TOKEN_ID, PACKED_RANKS)
      .send(sendAs(playerAddr));
    console.log(`  Tx mined: ${receipt.txHash?.toString()}`);

    // Brief pause for PXE note sync
    await new Promise(r => setTimeout(r, 2000));

    // 3. Check cards via get_private_cards — should see the minted card
    const { result: afterResult } = await nftContract.methods
      .get_private_cards(playerAddr, 0)
      .simulate({ from: playerAddr });
    const afterMint = afterResult[0];
    const cards = afterMint
      .map((v: any) => Number(BigInt(v)))
      .filter((id: number) => id !== 0);
    console.log(`  Cards after mint: [${cards}]`);

    expect(cards.length).toBe(1);
    expect(cards).toContain(42);
    console.log('  PASS ✓');
  }, 300_000);
});
