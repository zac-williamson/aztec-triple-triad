/**
 * Core Aztec connection logic — two-phase flow for testnet:
 *
 * Phase 1 (prepareConnection):
 *   Create EmbeddedWallet, generate/restore keys, compute account address.
 *   Returns the address so the user can fund it with Fee Juice.
 *
 * Phase 2 (deployAndRegister):
 *   Deploy the account on-chain, register contracts, mint starter cards.
 *   Called after the user confirms they've funded the address.
 */

import { AZTEC_CONFIG } from './config';
import { getNftArtifact, fetchTxEffectData } from './noteImporter';
import { pxe, setPxeWallet, type PxeOps } from './pxe';
import { addCards, loadCards, saveCards, type StoredCard } from './cardStore';
import { AZTEC_TX_TIMEOUT, STARTER_CARD_IDS, STARTER_CARD_COUNT } from './gameConstants';
import { gasSettingsWithHeadroom, type BaseFeeNode } from './feeSettings';
import type { FeeJuiceClaim } from './fundDevnet';

export interface AztecConnectResult {
  wallet: unknown;
  node: unknown;
  accountAddress: string;
  ownedCardIds: number[];
}

export interface PreparedConnection {
  wallet: any;
  node: any;
  accountManager: any;
  accountAddress: string;
  alreadyDeployed: boolean;
}

type LogFn = (msg: string) => void;

/**
 * Phase 1: Create wallet, generate keys, compute address.
 * Does NOT deploy or send any transactions.
 */
export async function prepareConnection(options?: {
  skipLocalStorage?: boolean;
  log?: LogFn;
}): Promise<PreparedConnection> {
  const log = options?.log ?? ((msg: string) => console.log('[connectToAztec]', msg));
  const useStorage = !options?.skipLocalStorage;

  const [nodeModule, instrumentedModule, foundationModule, fieldsModule] = await Promise.all([
    import('@aztec/aztec.js/node'),
    import('./instrumentedWallet'),
    import('@aztec/foundation/curves/grumpkin'),
    import('@aztec/aztec.js/fields'),
  ]);

  const { createAztecNodeClient } = nodeModule;
  const { InstrumentedWallet: EmbeddedWallet } = instrumentedModule;
  const { GrumpkinScalar } = foundationModule;
  const { Fr } = fieldsModule;

  // Vanilla node client — exactly what a single real player and V4 used. Measured
  // uncapped rate is ~190/min combined (2 browsers on 1 IP), well under the node's
  // 300/min/IP cap, so the client-side rate-limiter was unnecessary AND harmful:
  // capping below the PXE's natural ~170/min delayed its critical sync/receipt/send
  // requests and starved it. Request batching is removed too (it risked the PXE
  // misreading a coalesced chain view). If the cap is ever truly approached, cut
  // real request volume — do not re-add a governor.
  const node = createAztecNodeClient(AZTEC_CONFIG.pxeUrl);

  // Secret + salt (persisted or random)
  let secretFr: InstanceType<typeof Fr>;
  let saltFr: InstanceType<typeof Fr>;

  if (useStorage) {
    const secret = localStorage.getItem(AZTEC_CONFIG.storageKeys.accountSecret);
    try { secretFr = secret ? Fr.fromHexString(secret.startsWith('0x') ? secret : '0x' + secret) : Fr.random(); }
    catch { secretFr = Fr.random(); }
    localStorage.setItem(AZTEC_CONFIG.storageKeys.accountSecret, secretFr.toString());

    const salt = localStorage.getItem(AZTEC_CONFIG.storageKeys.accountSalt);
    try { saltFr = salt ? Fr.fromHexString(salt.startsWith('0x') ? salt : '0x' + salt) : Fr.random(); }
    catch { saltFr = Fr.random(); }
    localStorage.setItem(AZTEC_CONFIG.storageKeys.accountSalt, saltFr.toString());
  } else {
    secretFr = Fr.random();
    saltFr = Fr.random();
  }

  log('Creating EmbeddedWallet...');
  // Store the rollup address so the "Clear All State" button can
  // delete the correct IndexedDB databases (Safari can't enumerate them).
  try {
    const l1Contracts = await node.getL1ContractAddresses();
    const rollupAddr = l1Contracts.rollupAddress?.toString();
    if (rollupAddr) {
      const prev = JSON.parse(localStorage.getItem('aztec_idb_names') ?? '[]') as string[];
      // The SDK creates IDB databases with directory-style names:
      // "pxe_data_0x.../pxe_data" and "wallet_data_0x.../wallet_data"
      const pxeBase = `pxe_data_${rollupAddr}`;
      const walletBase = `wallet_data_${rollupAddr}`;
      const names = [pxeBase, walletBase, `${pxeBase}/pxe_data`, `${walletBase}/wallet_data`];
      const merged = [...new Set([...prev, ...names])];
      localStorage.setItem('aztec_idb_names', JSON.stringify(merged));
    }
  } catch { /* best effort */ }

  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: false,
    pxeConfig: { proverEnabled: true },
  });

  // Signing key
  let signingKey: InstanceType<typeof GrumpkinScalar>;
  if (useStorage) {
    const storedSk = localStorage.getItem(AZTEC_CONFIG.storageKeys.signingKey);
    try { signingKey = storedSk ? GrumpkinScalar.fromHexString(storedSk.startsWith('0x') ? storedSk : '0x' + storedSk) : GrumpkinScalar.random(); }
    catch { signingKey = GrumpkinScalar.random(); }
    localStorage.setItem(AZTEC_CONFIG.storageKeys.signingKey, signingKey.toString());
  } else {
    signingKey = GrumpkinScalar.random();
  }

  const accountManager = await wallet.createSchnorrAccount(secretFr, saltFr, signingKey);
  const accountAddress = accountManager.address.toString();
  const alreadyDeployed = useStorage && localStorage.getItem(AZTEC_CONFIG.storageKeys.deploymentStatus) === 'deployed';

  log(`Account address: ${accountAddress} (deployed: ${alreadyDeployed})`);
  if (useStorage) localStorage.setItem(AZTEC_CONFIG.storageKeys.accountAddress, accountAddress);

  return { wallet, node, accountManager, accountAddress, alreadyDeployed };
}

/**
 * Phase 2: Deploy account, register contracts, mint starter cards.
 * Call this after the user has funded their address with Fee Juice.
 */
export async function deployAndRegister(
  prepared: PreparedConnection,
  ops: PxeOps,
  options?: { skipLocalStorage?: boolean; log?: LogFn; feeJuiceClaim?: FeeJuiceClaim },
): Promise<AztecConnectResult> {
  const log = options?.log ?? ((msg: string) => console.log('[connectToAztec]', msg));
  const useStorage = !options?.skipLocalStorage;
  const { wallet, node, accountManager, accountAddress, alreadyDeployed } = prepared;

  const [{ AztecAddress }, { NO_FROM }] = await Promise.all([
    import('@aztec/aztec.js/addresses'),
    import('@aztec/aztec.js/account'),
  ]);

  await wallet.registerSender(accountManager.address, 'player');

  // Register contracts (must happen before deploy+mint batch so NFT contract is available)
  const { loadContractArtifact } = await import('@aztec/aztec.js/abi');

  let nftArtifact: any = null;
  if (AZTEC_CONFIG.nftContractAddress) {
    const nftAddress = AztecAddress.fromStringUnsafe(AZTEC_CONFIG.nftContractAddress);
    await wallet.registerSender(nftAddress, 'nft-contract');
    try {
      const nftInstance = await node.getContract(nftAddress);
      if (nftInstance) {
        nftArtifact = await getNftArtifact();
        await wallet.registerContract(nftInstance, nftArtifact);
        log('NFT contract registered');
      }
    } catch (e) { log(`Failed to register NFT: ${e}`); }
  }

  if (AZTEC_CONFIG.gameContractAddress) {
    const gameAddress = AztecAddress.fromStringUnsafe(AZTEC_CONFIG.gameContractAddress);
    await wallet.registerSender(gameAddress, 'game-contract');
    try {
      const gameInstance = await node.getContract(gameAddress);
      if (gameInstance) {
        const resp = await fetch('/contracts/triple_triad_game-TripleTriadGame.json');
        await wallet.registerContract(gameInstance, loadContractArtifact(await resp.json()));
        log('Game contract registered');
      }
    } catch (e) { log(`Failed to register Game: ${e}`); }
  }

  if (AZTEC_CONFIG.tokenContractAddress) {
    const tokenAddress = AztecAddress.fromStringUnsafe(AZTEC_CONFIG.tokenContractAddress);
    await wallet.registerSender(tokenAddress, 'token-contract');
    try {
      const tokenInstance = await node.getContract(tokenAddress);
      if (tokenInstance) {
        const resp = await fetch('/contracts/arena_token-ArenaToken.json');
        await wallet.registerContract(tokenInstance, loadContractArtifact(await resp.json()));
        log('Token contract registered');
      }
    } catch (e) { log(`Failed to register Token: ${e}`); }
  }

  // Check deployment status — on-chain first (localStorage flag may be stale)
  let deployed = alreadyDeployed;
  if (!deployed) {
    try {
      const onChain = await node.getContract(accountManager.address);
      if (onChain) {
        deployed = true;
        log(`Account already deployed on-chain: ${accountAddress}`);
      }
    } catch { /* not deployed */ }
  }

  const mintKey = AZTEC_CONFIG.storageKeys.cardsMintedPrefix + accountAddress + '_' + AZTEC_CONFIG.nftContractAddress;
  const needsMint = nftArtifact && AZTEC_CONFIG.nftContractAddress && (!useStorage || !localStorage.getItem(mintKey));

  if (deployed) {
    log(`Account already deployed: ${accountAddress}`);
    if (useStorage) localStorage.setItem(AZTEC_CONFIG.storageKeys.deploymentStatus, 'deployed');
  }

  // Deploy + mint in a single tx when both are needed (one proof, one block).
  // The mint call is injected into the fee payment method's payload so it gets
  // wrapped through the account's entrypoint alongside the fee claim by
  // DeployAccountMethod's internal multicall entrypoint wrapping.
  if (!deployed && needsMint && options?.feeJuiceClaim) {
    const { FeeJuicePaymentMethodWithClaim } = await import('@aztec/aztec.js/fee');
    const { mergeExecutionPayloads } = await import('@aztec/stdlib/tx');

    log('Deploying account + minting starter cards (single tx)...');
    const deployMethod = await accountManager.getDeployMethod();

    // Build a combined fee payment method: fee claim + mint call merged into one payload.
    // DeployAccountMethod wraps this through the account entrypoint + multicall entrypoint,
    // producing: MultiCall([deploy, accountEntrypoint([claimFeeJuice, mintCards])])
    const feeJuiceClaim = new FeeJuicePaymentMethodWithClaim(accountManager.address, options.feeJuiceClaim);
    const feePayload = await feeJuiceClaim.getExecutionPayload();
    const mintPayload = await ops.buildMintStarterCardsRequest();
    const mergedPayload = mergeExecutionPayloads([feePayload, mintPayload]);

    const combinedPaymentMethod = {
      getExecutionPayload: async () => mergedPayload,
      getAsset: () => feeJuiceClaim.getAsset(),
      getFeePayer: () => feeJuiceClaim.getFeePayer(),
      getGasSettings: () => feeJuiceClaim.getGasSettings(),
    };

    const { receipt } = await deployMethod.send({
      from: NO_FROM,
      fee: { paymentMethod: combinedPaymentMethod, gasSettings: await gasSettingsWithHeadroom(node as BaseFeeNode) },
      wait: { timeout: AZTEC_TX_TIMEOUT },
    });
    if (useStorage) {
      localStorage.setItem(AZTEC_CONFIG.storageKeys.deploymentStatus, 'deployed');
      localStorage.setItem(mintKey, 'true');
    }
    const txHashStr = receipt?.txHash?.toString() || '';
    log(`Account deployed + cards minted: ${txHashStr}`);

    // Import minted card notes
    if (txHashStr) {
      try {
        const randomness = await ops.computeNoteRandomness(accountAddress, '0', STARTER_CARD_COUNT);
        const txEffectData = await fetchTxEffectData(node, txHashStr);

        if (txEffectData) {
          const storedCards: StoredCard[] = STARTER_CARD_IDS.map((id, i) => ({
            cardId: id,
            randomness: randomness[i],
            txHash: txHashStr,
            noteHashes: txEffectData.noteHashes,
            firstNullifier: txEffectData.firstNullifier,
          }));
          addCards(accountAddress, storedCards);

          const notes = storedCards.map((c) => ({ tokenId: c.cardId, randomness: c.randomness }));
          await ops.importCardNotes(accountAddress, txHashStr, notes, 'Starter cards', txEffectData);
          log('Starter cards stored and imported');
        }
      } catch (e) { log(`Failed to import starter cards: ${e}`); }
    }
  } else {
    // Deploy first (if needed), then fall through to mint (if needed).
    // The combined-tx branch above only runs when we have a feeJuiceClaim;
    // on testnet the user funds via the bridge and we get no claim, so
    // deploy + mint must run as separate txs.
    if (!deployed) {
      log('Deploying account...');
      const deployMethod = await accountManager.getDeployMethod();
      const sendOpts: any = { from: NO_FROM, wait: { timeout: AZTEC_TX_TIMEOUT } };
      sendOpts.fee = { gasSettings: await gasSettingsWithHeadroom(node as BaseFeeNode) };
      if (options?.feeJuiceClaim) {
        const { FeeJuicePaymentMethodWithClaim } = await import('@aztec/aztec.js/fee');
        sendOpts.fee.paymentMethod = new FeeJuicePaymentMethodWithClaim(accountManager.address, options.feeJuiceClaim);
      }
      await deployMethod.send(sendOpts);
      if (useStorage) localStorage.setItem(AZTEC_CONFIG.storageKeys.deploymentStatus, 'deployed');
      log(`Account deployed: ${accountAddress}`);
    }

    if (needsMint) {
    // Mint only (account already deployed)
    log('Minting starter cards...');
    const txHashStr = await ops.sendMintStarterCards(accountAddress, { node, timeoutMs: AZTEC_TX_TIMEOUT });
    if (useStorage) localStorage.setItem(mintKey, 'true');
    log(`Starter cards minted: ${txHashStr}`);

    if (txHashStr) {
      try {
        const randomness = await ops.computeNoteRandomness(accountAddress, '0', STARTER_CARD_COUNT);
        const txEffectData = await fetchTxEffectData(node, txHashStr);

        if (txEffectData) {
          const storedCards: StoredCard[] = STARTER_CARD_IDS.map((id, i) => ({
            cardId: id,
            randomness: randomness[i],
            txHash: txHashStr,
            noteHashes: txEffectData.noteHashes,
            firstNullifier: txEffectData.firstNullifier,
          }));
          addCards(accountAddress, storedCards);

          const notes = storedCards.map((c) => ({ tokenId: c.cardId, randomness: c.randomness }));
          await ops.importCardNotes(accountAddress, txHashStr, notes, 'Starter cards', txEffectData);
          log('Starter cards stored and imported');
        }
      } catch (e) { log(`Failed to import starter cards: ${e}`); }
    }
    }
  }

  // Load cards from localStorage and import into PXE
  let ownedCardIds: number[] = [];
  if (nftArtifact && AZTEC_CONFIG.nftContractAddress) {
    const storedCards = loadCards(accountAddress);
    if (storedCards.length > 0) {
      log(`Importing ${storedCards.length} cards from localStorage...`);

      // Group cards by txHash to batch imports
      const byTx = new Map<string, StoredCard[]>();
      for (const card of storedCards) {
        if (!byTx.has(card.txHash)) byTx.set(card.txHash, []);
        byTx.get(card.txHash)!.push(card);
      }

      for (const [txHash, cards] of byTx) {
        const notes = cards.map((c) => ({ tokenId: c.cardId, randomness: c.randomness }));
        const txEffectData = { noteHashes: cards[0].noteHashes, firstNullifier: cards[0].firstNullifier };
        try {
          await ops.importCardNotes(accountAddress, txHash, notes, 'Restore', txEffectData);
        } catch (e) { log(`Failed to import cards from tx ${txHash.slice(0, 16)}...: ${e}`); }
      }

      // Verify: which cards the PXE actually holds (exist AND not nullified)
      ownedCardIds = await ops.readPrivateCards(accountAddress);

      // Reconcile: remove stale cards from localStorage
      const validSet = new Set(ownedCardIds);
      const reconciled = storedCards.filter((c) => validSet.has(c.cardId));
      if (reconciled.length !== storedCards.length) {
        log(`Reconciled: ${storedCards.length} stored → ${reconciled.length} valid`);
        saveCards(accountAddress, reconciled);
      }

      log(`Owned cards: ${JSON.stringify(ownedCardIds)}`);
    }
  }

  log(`Connected: ${accountAddress}`);
  return { wallet, node, accountAddress, ownedCardIds };
}

/**
 * Legacy single-call API — calls both phases sequentially.
 * Used by tests and non-interactive flows.
 */
export async function connectToAztec(options?: {
  skipLocalStorage?: boolean;
  log?: LogFn;
}): Promise<AztecConnectResult> {
  const prepared = await prepareConnection(options);
  setPxeWallet(prepared.wallet); // bind the PXE door so the ops can resolve contracts
  // No surrounding tx queue item here (one-shot legacy path) — enqueue via `pxe`.
  return deployAndRegister(prepared, pxe, options);
}
