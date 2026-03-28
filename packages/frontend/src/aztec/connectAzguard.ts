/**
 * Azguard Wallet connection — replaces EmbeddedWallet flow.
 *
 * The AztecWallet class implements the full Wallet interface from @aztec/aztec.js,
 * so all downstream code (Contract.at, .send, .simulate) works unchanged.
 *
 * Note: Azguard bundles its own @aztec/stdlib (4.1.0-rc.4) which may have slightly
 * different class instances than ours (4.1.0). We use `any` casts at boundaries
 * to bridge these — the wire format and runtime behavior are identical.
 */

import { AZTEC_CONFIG } from './config';
import { importNotesFromTx, getNftArtifact } from './noteImporter';
import { toFr } from './fieldUtils';
import { AZTEC_TX_TIMEOUT, STARTER_CARD_IDS, STARTER_CARD_COUNT } from './gameConstants';
import type { AztecConnectResult } from './connectToAztec';

export async function connectWithAzguard(options?: {
  log?: (msg: string) => void;
  skipLocalStorage?: boolean;
}): Promise<AztecConnectResult> {
  const log = options?.log ?? ((msg: string) => console.log('[connectAzguard]', msg));

  const { AztecWallet } = await import('@azguardwallet/aztec-wallet');

  // Determine Azguard chain based on PXE URL — sandbox if localhost, testnet otherwise
  const azguardChain: 'sandbox' | 'testnet' = AZTEC_CONFIG.pxeUrl.includes('localhost')
    ? 'sandbox'
    : 'testnet';
  log(`Connecting to Azguard Wallet (chain: ${azguardChain})...`);
  const wallet: any = await AztecWallet.connect(
    { name: 'Axolotl Arena', description: 'Triple Triad card game on Aztec' },
    azguardChain,
    5000,
  );
  log('Azguard connected');

  const accounts = await wallet.getAccounts();
  if (!accounts || accounts.length === 0) {
    throw new Error('No accounts found in Azguard wallet. Please create an account in the extension first.');
  }
  const playerAddress = accounts[0].item;
  const address = playerAddress.toString();
  log(`Player address: ${address}`);

  const { loadContractArtifact } = await import('@aztec/aztec.js/abi');
  const { AztecAddress } = await import('@aztec/aztec.js/addresses');

  // Helper: register a contract with Azguard's PXE.
  // getContractMetadata returns the full metadata including the instance.
  async function registerContract(contractAddress: string, artifactPath: string, label: string): Promise<any> {
    const addr = AztecAddress.fromString(contractAddress);
    await wallet.registerSender(addr as any, label);
    try {
      const metadata = await wallet.getContractMetadata(addr as any);
      // metadata may contain the contract instance directly or as a property
      const instance = metadata?.contractInstance ?? metadata;
      const resp = await fetch(artifactPath);
      const artifact = loadContractArtifact(await resp.json());
      await wallet.registerContract(instance as any, artifact as any);
      log(`${label} registered`);
      return artifact;
    } catch (e) {
      log(`Failed to register ${label}: ${e}`);
      return null;
    }
  }

  // Register contracts
  let nftArtifact: any = null;
  if (AZTEC_CONFIG.nftContractAddress) {
    nftArtifact = await registerContract(
      AZTEC_CONFIG.nftContractAddress,
      '/contracts/triple_triad_nft-TripleTriadNFT.json',
      'nft-contract',
    );
    if (!nftArtifact) {
      try { nftArtifact = await getNftArtifact(); } catch { /* ignore */ }
    }
  }

  if (AZTEC_CONFIG.gameContractAddress) {
    await registerContract(
      AZTEC_CONFIG.gameContractAddress,
      '/contracts/triple_triad_game-TripleTriadGame.json',
      'game-contract',
    );
  }

  if (AZTEC_CONFIG.tokenContractAddress) {
    await registerContract(
      AZTEC_CONFIG.tokenContractAddress,
      '/contracts/arena_token-ArenaToken.json',
      'token-contract',
    );
  }

  // Mint starter cards if not already minted
  const mintKey = AZTEC_CONFIG.storageKeys.cardsMintedPrefix + address + '_' + AZTEC_CONFIG.nftContractAddress;
  if (nftArtifact && AZTEC_CONFIG.nftContractAddress && !localStorage.getItem(mintKey)) {
    const { Contract } = await import('@aztec/aztec.js/contracts');
    const nftAddr = AztecAddress.fromString(AZTEC_CONFIG.nftContractAddress);
    const nftContract = await Contract.at(nftAddr, nftArtifact, wallet);

    log('Minting starter cards...');
    const { receipt } = await nftContract.methods
      .get_cards_for_new_player()
      .send({ from: playerAddress as any, wait: { timeout: AZTEC_TX_TIMEOUT } });
    localStorage.setItem(mintKey, 'true');
    const txHashStr = receipt?.txHash?.toString() || '';
    log(`Starter cards minted: ${txHashStr}`);

    // Import notes for create_and_push_note pattern
    if (txHashStr) {
      try {
        const { result: randomnessResult } = await nftContract.methods
          .compute_note_randomness(0, STARTER_CARD_COUNT)
          .simulate({ from: playerAddress as any });
        const { Fr } = await import('@aztec/aztec.js/fields');
        const notes = STARTER_CARD_IDS.map((id, i) => ({
          tokenId: id,
          randomness: toFr(Fr, randomnessResult[i]).toString(),
        }));
        // Create a lightweight node client for getTxEffect (needed by noteImporter)
        const { createAztecNodeClient } = await import('@aztec/aztec.js/node');
        const tempNode = createAztecNodeClient(AZTEC_CONFIG.pxeUrl);
        await importNotesFromTx(wallet, tempNode, address, txHashStr, notes, 'Starter cards');
        log('Notes imported');
      } catch (importErr) {
        log(`Failed to import starter card notes: ${importErr}`);
      }
    }
  }

  // Fetch owned cards
  let ownedCardIds: number[] = [];
  if (nftArtifact && AZTEC_CONFIG.nftContractAddress) {
    try {
      const { Contract } = await import('@aztec/aztec.js/contracts');
      const nftAddr = AztecAddress.fromString(AZTEC_CONFIG.nftContractAddress);
      const nftContract = await Contract.at(nftAddr, nftArtifact, wallet);

      let pageIndex = 0;
      let hasMore = true;
      while (hasMore) {
        const { result: flatResult } = await nftContract.methods
          .get_private_cards(playerAddress as any, pageIndex)
          .simulate({ from: playerAddress as any });
        const page = flatResult[0] ?? [];
        hasMore = flatResult[1] === true;
        for (const val of page) {
          const id = Number(BigInt(val));
          if (id !== 0) ownedCardIds.push(id);
        }
        pageIndex++;
      }
      log(`Owned cards: ${JSON.stringify(ownedCardIds)}`);
    } catch (e) {
      log(`Failed to fetch owned cards: ${e}`);
    }
  }

  localStorage.setItem(AZTEC_CONFIG.storageKeys.accountAddress, address);
  log(`Connected via Azguard: ${address}`);

  // Create a node client for downstream use (getTxEffect, etc.)
  let node: unknown = null;
  try {
    const { createAztecNodeClient } = await import('@aztec/aztec.js/node');
    node = createAztecNodeClient(AZTEC_CONFIG.pxeUrl);
  } catch { /* ignore */ }

  return { wallet, node, accountAddress: address, ownedCardIds };
}
