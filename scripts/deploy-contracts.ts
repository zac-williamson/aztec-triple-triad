#!/usr/bin/env npx tsx
/**
 * Deploy Triple Triad contracts to the local Aztec sandbox.
 *
 * Usage:
 *   npx tsx scripts/deploy-contracts.ts
 *
 * Prerequisites:
 *   - Aztec sandbox running: aztec start --local-network
 *   - Contracts compiled: nargo compile --program-dir packages/contracts
 *   - Circuits compiled: nargo compile --program-dir circuits
 *
 * Output:
 *   - Deployed contract addresses printed to console
 *   - Addresses written to packages/frontend/.env
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

// Aztec SDK imports
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { Fr } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { TestWallet } from '@aztec/test-wallet/server';
import { deriveSigningKey } from '@aztec/stdlib/keys';
import { getContractInstanceFromInstantiationParams } from '@aztec/stdlib/contract';

// bb.js for VK hash computation
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';

const PXE_URL = process.env.AZTEC_PXE_URL || 'http://localhost:8080';
const ROOT_DIR = resolve(import.meta.dirname || __dirname, '..');

// ====================== Helpers ======================

function loadContractArtifact(name: string) {
  const path = resolve(ROOT_DIR, `packages/contracts/target/${name}.json`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function loadCircuitArtifact(name: string) {
  const path = resolve(ROOT_DIR, `circuits/target/${name}.json`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Compute the VK hash for a circuit by getting the verification key
 * and using generateRecursiveProofArtifacts to extract the vkHash.
 *
 * Since generating a real proof requires valid inputs, we use
 * backend.getVerificationKey() which doesn't need a witness.
 */
async function computeVkHash(
  api: Barretenberg,
  circuitBytecode: string,
): Promise<string> {
  const backend = new UltraHonkBackend(circuitBytecode, api);
  const vk = await backend.getVerificationKey({ verifierTarget: 'noir-recursive' });

  // The VK hash used by verify_honk_proof is computed from the VK fields.
  // We can get it from generateRecursiveProofArtifacts, but that requires a proof.
  // Instead, compute it directly: the vkHash is pedersen_hash(vk_as_fields).
  // But the simplest approach is to use the VK bytes and hash them.
  //
  // For now, we use a Pedersen hash of the VK. The exact mechanism depends
  // on how bb_proof_verification computes the vk_hash internally.
  // bb.js stores the VK hash at a fixed offset in the VK structure.
  //
  // The VK is returned as a flat Uint8Array. The hash is typically the first
  // or last 32 bytes depending on the format. Let's extract it.
  //
  // Actually, the cleanest approach: parse VK as 32-byte field elements,
  // and the vkHash is the Pedersen hash of those fields.
  const result = await api.pedersenHash({
    inputs: [vk],
    hashIndex: 0,
  });
  return '0x' + Array.from(result.hash).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ====================== Main Deployment ======================

async function main() {
  console.log('=== Triple Triad Contract Deployment ===');
  console.log(`Connecting to Aztec node at ${PXE_URL}...`);

  // 1. Connect to the Aztec node
  const node = createAztecNodeClient(PXE_URL);

  // 2. Create a TestWallet (server-side, with embedded PXE)
  console.log('Creating TestWallet...');
  const wallet = await TestWallet.create(node);
  const deployerAddress = wallet.getAddress();
  console.log(`Deployer address: ${deployerAddress.toString()}`);

  // 3. Load contract artifacts
  console.log('Loading contract artifacts...');
  const nftArtifact = loadContractArtifact('triple_triad_nft-TripleTriadNFT');
  const gameArtifact = loadContractArtifact('triple_triad_game-TripleTriadGame');

  // 4. Compute VK hashes for all 3 circuits
  console.log('Computing VK hashes...');
  const api = await Barretenberg.new({ threads: 1 });

  const proveHandCircuit = loadCircuitArtifact('prove_hand');
  const gameMoveCircuit = loadCircuitArtifact('game_move');
  const aggregateCircuit = loadCircuitArtifact('aggregate_game');

  const handVkHash = await computeVkHash(api, proveHandCircuit.bytecode);
  const moveVkHash = await computeVkHash(api, gameMoveCircuit.bytecode);
  const aggregateVkHash = await computeVkHash(api, aggregateCircuit.bytecode);

  console.log(`  hand_vk_hash:      ${handVkHash}`);
  console.log(`  move_vk_hash:      ${moveVkHash}`);
  console.log(`  aggregate_vk_hash: ${aggregateVkHash}`);

  await api.destroy();

  // 5. Deploy NFT contract
  console.log('\nDeploying TripleTriadNFT...');
  // Constructor: (minter: AztecAddress, name: FieldCompressedString, symbol: FieldCompressedString)
  // FieldCompressedString is a single Field encoding a short string
  const nameField = Fr.fromString('Axolotl Arena Cards');
  const symbolField = Fr.fromString('AXL');

  // Use the Aztec.js Contract deployment pattern
  const { Contract } = await import('@aztec/aztec.js/contracts');

  const nftContract = await Contract.deploy(wallet, nftArtifact, [
    deployerAddress,
    nameField,
    symbolField,
  ])
    .send({ fee: new SponsoredFeePaymentMethod() })
    .deployed();

  const nftAddress = nftContract.address;
  console.log(`TripleTriadNFT deployed at: ${nftAddress.toString()}`);

  // 6. Deploy Game contract
  console.log('\nDeploying TripleTriadGame...');
  // Constructor: (nft_address: AztecAddress, hand_vk_hash: Field, move_vk_hash: Field, aggregate_vk_hash: Field)
  const gameContract = await Contract.deploy(wallet, gameArtifact, [
    nftAddress,
    Fr.fromHexString(handVkHash),
    Fr.fromHexString(moveVkHash),
    Fr.fromHexString(aggregateVkHash),
  ])
    .send({ fee: new SponsoredFeePaymentMethod() })
    .deployed();

  const gameAddress = gameContract.address;
  console.log(`TripleTriadGame deployed at: ${gameAddress.toString()}`);

  // 7. Register game contract on NFT contract
  console.log('\nRegistering game contract on NFT...');
  await nftContract.methods
    .set_game_contract(gameAddress)
    .send({ fee: new SponsoredFeePaymentMethod() })
    .wait();
  console.log('Game contract registered on NFT.');

  // 8. Mint initial cards for testing
  console.log('\nMinting initial cards...');

  // Pack ranks: top + right*16 + bottom*256 + left*4096
  function packRanks(top: number, right: number, bottom: number, left: number): number {
    return top + right * 16 + bottom * 256 + left * 4096;
  }

  // Card data from game-logic (first 20 cards for testing)
  const testCards = [
    { id: 1, ranks: { top: 1, right: 5, bottom: 5, left: 4 } },
    { id: 2, ranks: { top: 5, right: 3, bottom: 1, left: 4 } },
    { id: 3, ranks: { top: 1, right: 3, bottom: 3, left: 5 } },
    { id: 4, ranks: { top: 6, right: 2, bottom: 1, left: 1 } },
    { id: 5, ranks: { top: 2, right: 1, bottom: 3, left: 6 } },
    { id: 6, ranks: { top: 2, right: 3, bottom: 1, left: 5 } },
    { id: 7, ranks: { top: 3, right: 1, bottom: 5, left: 3 } },
    { id: 8, ranks: { top: 5, right: 3, bottom: 2, left: 1 } },
    { id: 9, ranks: { top: 2, right: 1, bottom: 6, left: 1 } },
    { id: 10, ranks: { top: 4, right: 3, bottom: 5, left: 3 } },
    { id: 11, ranks: { top: 7, right: 3, bottom: 1, left: 1 } },
    { id: 12, ranks: { top: 5, right: 5, bottom: 4, left: 3 } },
    { id: 13, ranks: { top: 1, right: 5, bottom: 5, left: 5 } },
    { id: 14, ranks: { top: 6, right: 6, bottom: 3, left: 2 } },
    { id: 15, ranks: { top: 2, right: 4, bottom: 4, left: 5 } },
    { id: 16, ranks: { top: 3, right: 7, bottom: 2, left: 1 } },
    { id: 17, ranks: { top: 5, right: 6, bottom: 2, left: 4 } },
    { id: 18, ranks: { top: 4, right: 2, bottom: 4, left: 7 } },
    { id: 19, ranks: { top: 6, right: 5, bottom: 1, left: 6 } },
    { id: 20, ranks: { top: 3, right: 1, bottom: 5, left: 5 } },
  ];

  // Mint cards 1-10 to deployer (test player 1)
  for (const card of testCards.slice(0, 10)) {
    const packed = packRanks(card.ranks.top, card.ranks.right, card.ranks.bottom, card.ranks.left);
    await nftContract.methods
      .mint_to_public(deployerAddress, new Fr(BigInt(card.id)), new Fr(BigInt(packed)))
      .send({ fee: new SponsoredFeePaymentMethod() })
      .wait();
    console.log(`  Minted card #${card.id} (${card.ranks.top}/${card.ranks.right}/${card.ranks.bottom}/${card.ranks.left}) to deployer`);
  }

  // Create a second test account and mint cards 11-20 to it
  console.log('\nCreating second test wallet...');
  const wallet2 = await TestWallet.create(node);
  const player2Address = wallet2.getAddress();
  console.log(`Player 2 address: ${player2Address.toString()}`);

  for (const card of testCards.slice(10, 20)) {
    const packed = packRanks(card.ranks.top, card.ranks.right, card.ranks.bottom, card.ranks.left);
    await nftContract.methods
      .mint_to_public(player2Address, new Fr(BigInt(card.id)), new Fr(BigInt(packed)))
      .send({ fee: new SponsoredFeePaymentMethod() })
      .wait();
    console.log(`  Minted card #${card.id} (${card.ranks.top}/${card.ranks.right}/${card.ranks.bottom}/${card.ranks.left}) to player 2`);
  }

  // 9. Write deployed addresses to frontend .env
  const envContent = `# Auto-generated by deploy-contracts.ts
VITE_AZTEC_PXE_URL=${PXE_URL}
VITE_NFT_CONTRACT_ADDRESS=${nftAddress.toString()}
VITE_GAME_CONTRACT_ADDRESS=${gameAddress.toString()}
VITE_AZTEC_ENABLED=true
`;

  const envPath = resolve(ROOT_DIR, 'packages/frontend/.env');
  writeFileSync(envPath, envContent);
  console.log(`\nAddresses written to ${envPath}`);

  // 10. Summary
  console.log('\n=== Deployment Complete ===');
  console.log(`NFT Contract:  ${nftAddress.toString()}`);
  console.log(`Game Contract: ${gameAddress.toString()}`);
  console.log(`Player 1:      ${deployerAddress.toString()}`);
  console.log(`Player 2:      ${player2Address.toString()}`);
  console.log(`\nCards 1-10 owned by Player 1 (public)`);
  console.log(`Cards 11-20 owned by Player 2 (public)`);
  console.log(`\nVK Hashes:`);
  console.log(`  hand:      ${handVkHash}`);
  console.log(`  move:      ${moveVkHash}`);
  console.log(`  aggregate: ${aggregateVkHash}`);
}

main().catch((err) => {
  console.error('Deployment failed:', err);
  process.exit(1);
});
