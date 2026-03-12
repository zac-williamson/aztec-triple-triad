// @ts-nocheck — Aztec SDK types require sandbox-specific resolution
/**
 * Minimal test to log cooldown partial note storage slots from get_cards_for_new_player.
 *
 * Run:
 *   cd packages/integration
 *   npx vitest run tests/e2e-cooldown-slots.test.ts
 */

import { describe, it, beforeAll } from 'vitest';

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

import { loadContractArtifact } from './e2e-helpers.js';

const PXE_URL = process.env.AZTEC_PXE_URL || 'http://localhost:8080';
const SEND_TIMEOUT = 300;

function encodeCompressedString(s: string): Fr {
  let hex = '';
  for (let i = 0; i < s.length && i < 31; i++) {
    hex += s.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return new Fr(BigInt('0x' + hex));
}

describe('Cooldown slot logging', () => {
  let wallet: any;
  let fee: any;
  let playerAddr: any;
  let nftContract: any;

  const sendAs = (addr: any) => ({
    from: addr,
    fee: { paymentMethod: fee },
    wait: { timeout: SEND_TIMEOUT },
  });

  beforeAll(async () => {
    const node = createAztecNodeClient(PXE_URL);
    wallet = await EmbeddedWallet.create(node, { ephemeral: true });
    await new Promise(r => setTimeout(r, 3000));

    const fpcInstance = await getContractInstanceFromInstantiationParams(
      SponsoredFPCContractArtifact, { salt: new Fr(SPONSORED_FPC_SALT) },
    );
    await wallet.registerContract(fpcInstance, SponsoredFPCContractArtifact);
    fee = new SponsoredFeePaymentMethod(fpcInstance.address);

    const playerAccount = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
    await (await playerAccount.getDeployMethod()).send({
      from: AztecAddress.ZERO,
      fee: { paymentMethod: fee },
      skipClassPublication: true,
      skipInstancePublication: true,
      wait: { timeout: SEND_TIMEOUT },
    });
    playerAddr = playerAccount.address;
    await wallet.registerSender(playerAddr, 'player');
    console.log(`  Player: ${playerAddr}`);

    const nftArtifact = loadContractArtifact('triple_triad_nft-TripleTriadNFT');
    ({ contract: nftContract } = await Contract.deploy(wallet, nftArtifact, [
      playerAddr,
      encodeCompressedString('Test'),
      encodeCompressedString('T'),
    ]).send(sendAs(playerAddr)));
    console.log(`  NFT at: ${nftContract.address}`);
    await wallet.registerSender(nftContract.address, 'nft');
  }, 300_000);

  it('should log cooldown partial note storage slots', async () => {
    console.log('\n--- Calling get_cards_for_new_player (check DEBUG logs for PARTIAL NOTE STORAGE SLOT) ---');
    const { receipt } = await nftContract.methods
      .get_cards_for_new_player()
      .send(sendAs(playerAddr));
    console.log(`  tx: ${receipt.txHash?.toString()}`);
    console.log('  Done — check DEBUG output for "PARTIAL NOTE STORAGE SLOT" lines');
  }, 300_000);
});
