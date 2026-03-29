/**
 * Core Aztec connection logic — extracted from useAztec so it can be called
 * from both the React hook and standalone test runners (Playwright, etc.).
 *
 * Performs the full connection flow:
 * 1. Create EmbeddedWallet (browser → IndexedDB)
 * 2. Register SponsoredFPC
 * 3. Deploy Schnorr account
 * 4. Register NFT + Game contracts with PXE
 * 5. Mint starter cards via get_cards_for_new_player().send()
 * 6. Import notes (5x import_note().simulate())
 * 7. Fetch owned cards
 */

import { AZTEC_CONFIG } from './config';
import { importNotesFromTx, getNftArtifact } from './noteImporter';
import { toFr } from './fieldUtils';
import { AZTEC_TX_TIMEOUT, PXE_INITIAL_SYNC_DELAY, STARTER_CARD_IDS, STARTER_CARD_COUNT } from './gameConstants';

export interface AztecConnectResult {
  wallet: unknown;
  node: unknown;
  accountAddress: string;
  ownedCardIds: number[];
}

export async function connectToAztec(options?: {
  /** Skip localStorage persistence (for tests) */
  skipLocalStorage?: boolean;
  /** Log function (defaults to console.log) */
  log?: (msg: string) => void;
}): Promise<AztecConnectResult> {
  const log = options?.log ?? ((msg: string) => console.log('[connectToAztec]', msg));
  const useStorage = !options?.skipLocalStorage;

  // Dynamically import Aztec SDK subpath modules
  const [nodeModule, walletsModule, foundationModule, fieldsModule] = await Promise.all([
    import('@aztec/aztec.js/node'),
    import('@aztec/wallets/embedded'),
    import('@aztec/foundation/curves/grumpkin'),
    import('@aztec/aztec.js/fields'),
  ]);

  const { createAztecNodeClient } = nodeModule;
  const { EmbeddedWallet } = walletsModule;
  const { GrumpkinScalar } = foundationModule;
  const { Fr } = fieldsModule;

  // Connect to the Aztec node
  const node = createAztecNodeClient(AZTEC_CONFIG.pxeUrl);

  // Secret + salt (persisted or random)
  let secretFr: typeof Fr.prototype;
  let saltFr: typeof Fr.prototype;

  if (useStorage) {
    let secret = localStorage.getItem(AZTEC_CONFIG.storageKeys.accountSecret);
    try {
      secretFr = secret ? Fr.fromHexString(secret.startsWith('0x') ? secret : '0x' + secret) : Fr.random();
    } catch {
      secretFr = Fr.random();
    }
    const secretHex = secretFr.toString();
    if (secret !== secretHex) localStorage.setItem(AZTEC_CONFIG.storageKeys.accountSecret, secretHex);

    let salt = localStorage.getItem(AZTEC_CONFIG.storageKeys.accountSalt);
    try {
      saltFr = salt ? Fr.fromHexString(salt.startsWith('0x') ? salt : '0x' + salt) : Fr.random();
    } catch {
      saltFr = Fr.random();
    }
    const saltHex = saltFr.toString();
    if (salt !== saltHex) localStorage.setItem(AZTEC_CONFIG.storageKeys.accountSalt, saltHex);
  } else {
    secretFr = Fr.random();
    saltFr = Fr.random();
  }

  // Create EmbeddedWallet — runs a full PXE in the browser tab
  log('Creating EmbeddedWallet...');
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true });

  // Wait for PXE to sync so tx expiration timestamps are valid
  // await new Promise(r => setTimeout(r, PXE_INITIAL_SYNC_DELAY));

  // Register SponsoredFPC for fee payments
  const [{ getContractInstanceFromInstantiationParams }, { SponsoredFPCContractArtifact }, { SPONSORED_FPC_SALT }, { SponsoredFeePaymentMethod }, { AztecAddress }, { NO_FROM }] = await Promise.all([
    import('@aztec/stdlib/contract'),
    import('@aztec/noir-contracts.js/SponsoredFPC'),
    import('@aztec/constants'),
    import('@aztec/aztec.js/fee'),
    import('@aztec/aztec.js/addresses'),
    import('@aztec/aztec.js/account'),
  ]);

  const sponsoredFPC = await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  });
  log(`Registering SponsoredFPC at ${sponsoredFPC.address}...`);
  await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);
  const paymentMethod = new SponsoredFeePaymentMethod(sponsoredFPC.address);

  // Create a Schnorr account — persist signing key for wallet recovery
  let signingKey: typeof GrumpkinScalar.prototype;
  if (useStorage) {
    const storedSk = localStorage.getItem(AZTEC_CONFIG.storageKeys.signingKey);
    if (storedSk) {
      try {
        signingKey = GrumpkinScalar.fromHexString(storedSk.startsWith('0x') ? storedSk : '0x' + storedSk);
      } catch {
        signingKey = GrumpkinScalar.random();
      }
    } else {
      signingKey = GrumpkinScalar.random();
    }
    localStorage.setItem(AZTEC_CONFIG.storageKeys.signingKey, signingKey.toString());
  } else {
    signingKey = GrumpkinScalar.random();
  }

  const accountManager = await wallet.createSchnorrAccount(secretFr, saltFr, signingKey);

  // Deploy the account on-chain (skip if already deployed)
  const alreadyDeployed = useStorage && localStorage.getItem(AZTEC_CONFIG.storageKeys.deploymentStatus) === 'deployed';
  if (alreadyDeployed) {
    log(`Account recovered: ${accountManager.address}`);
  } else {
    log('Deploying account...');
    const deployMethod = await accountManager.getDeployMethod();
    await deployMethod.send({
      from: AztecAddress.ZERO,
      fee: { paymentMethod },
      skipClassPublication: true,
      skipInstancePublication: true,
      wait: { timeout: AZTEC_TX_TIMEOUT },
    });
    if (useStorage) localStorage.setItem(AZTEC_CONFIG.storageKeys.deploymentStatus, 'deployed');
    log(`Account deployed: ${accountManager.address}`);
  }

  // Persist account address and register for note discovery
  if (useStorage) localStorage.setItem(AZTEC_CONFIG.storageKeys.accountAddress, accountManager.address.toString());
  await wallet.registerSender(accountManager.address, 'player');

  // Register NFT and Game contracts with the PXE
  const { loadContractArtifact } = await import('@aztec/aztec.js/abi');

  let nftArtifact: any = null;
  if (AZTEC_CONFIG.nftContractAddress) {
    const nftAddress = AztecAddress.fromString(AZTEC_CONFIG.nftContractAddress);
    await wallet.registerSender(nftAddress, 'nft-contract');
    try {
      const nftInstance = await node.getContract(nftAddress);
      if (nftInstance) {
        nftArtifact = await getNftArtifact();
        await wallet.registerContract(nftInstance, nftArtifact);
        log('NFT contract registered');
      }
    } catch (e) {
      log(`Failed to register NFT contract: ${e}`);
    }
  }

  if (AZTEC_CONFIG.gameContractAddress) {
    const gameAddress = AztecAddress.fromString(AZTEC_CONFIG.gameContractAddress);
    await wallet.registerSender(gameAddress, 'game-contract');
    try {
      const gameInstance = await node.getContract(gameAddress);
      if (gameInstance) {
        const resp = await fetch('/contracts/triple_triad_game-TripleTriadGame.json');
        const rawArtifact = await resp.json();
        const gameArtifact = loadContractArtifact(rawArtifact);
        await wallet.registerContract(gameInstance, gameArtifact);
        log('Game contract registered');
      }
    } catch (e) {
      log(`Failed to register Game contract: ${e}`);
    }
  }

  if (AZTEC_CONFIG.tokenContractAddress) {
    const tokenAddress = AztecAddress.fromString(AZTEC_CONFIG.tokenContractAddress);
    await wallet.registerSender(tokenAddress, 'token-contract');
    try {
      const tokenInstance = await node.getContract(tokenAddress);
      if (tokenInstance) {
        const resp = await fetch('/contracts/arena_token-ArenaToken.json');
        const rawArtifact = await resp.json();
        const tokenArtifact = loadContractArtifact(rawArtifact);
        await wallet.registerContract(tokenInstance, tokenArtifact);
        log('Token contract registered');
      }
    } catch (e) {
      log(`Failed to register Token contract: ${e}`);
    }
  }

  // Mint starter cards if this account hasn't claimed them yet
  const address = accountManager.address.toString();
  const mintKey = AZTEC_CONFIG.storageKeys.cardsMintedPrefix + address + '_' + AZTEC_CONFIG.nftContractAddress;
  if (nftArtifact && AZTEC_CONFIG.nftContractAddress && (!useStorage || !localStorage.getItem(mintKey))) {
    const { Contract } = await import('@aztec/aztec.js/contracts');
    const nftAddr = AztecAddress.fromString(AZTEC_CONFIG.nftContractAddress);
    const nftContract = await Contract.at(nftAddr, nftArtifact, wallet as never);

    log('Minting starter cards...');
    const { receipt } = await nftContract.methods
      .get_cards_for_new_player()
      .send({ from: accountManager.address, fee: { paymentMethod }, wait: { timeout: AZTEC_TX_TIMEOUT } });
    if (useStorage) localStorage.setItem(mintKey, 'true');
    const txHashStr = receipt?.txHash?.toString() || '';
    log(`Starter cards minted: ${txHashStr}`);

    // Import the starter card notes
    if (txHashStr) {
      try {
        const { result: randomnessResult } = await nftContract.methods
          .compute_note_randomness(0, STARTER_CARD_COUNT)
          .simulate({ from: accountManager.address });
        const notes = STARTER_CARD_IDS.map((id, i) => ({
          tokenId: id,
          randomness: toFr(Fr, randomnessResult[i]).toString(),
        }));
        await importNotesFromTx(wallet, node, address, txHashStr, notes, 'Starter cards');
        log('Notes imported');
      } catch (importErr) {
        log(`Failed to import starter card notes: ${importErr}`);
      }
    }
  }

  // Fetch the player's owned cards
  let ownedCardIds: number[] = [];
  if (nftArtifact && AZTEC_CONFIG.nftContractAddress) {
    try {
      const { Contract } = await import('@aztec/aztec.js/contracts');
      const nftAddr = AztecAddress.fromString(AZTEC_CONFIG.nftContractAddress);
      const nftContract = await Contract.at(nftAddr, nftArtifact, wallet as never);

      let pageIndex = 0;
      let hasMore = true;
      while (hasMore) {
        const { result: flatResult } = await nftContract.methods
          .get_private_cards(accountManager.address, pageIndex)
          .simulate({ from: accountManager.address });
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

  if (useStorage) {
    localStorage.setItem(AZTEC_CONFIG.storageKeys.accountAddress, address);
  }

  log(`Connected: ${address}`);
  return { wallet, node, accountAddress: address, ownedCardIds };
}
