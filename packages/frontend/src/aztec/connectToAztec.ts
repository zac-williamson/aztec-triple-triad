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
import type { OffchainMessage } from '@aztec-labs/aztec.js/contracts';

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
 * The starter cards' last step, shared by both onboarding branches: persist
 * them to the card store — what restores them after a PXE wipe — then hand
 * their offchain messages to the PXE. Persist FIRST, so a receive that fails
 * still leaves the boot-time restore able to import them.
 */
export async function storeAndReceiveStarterCards(
  ops: PxeOps,
  node: unknown,
  accountAddress: string,
  txHash: string,
  messages: OffchainMessage[],
  log: LogFn,
): Promise<void> {
  try {
    const randomness = await ops.computeNoteRandomness(accountAddress, '0', STARTER_CARD_COUNT);
    const txEffectData = await fetchTxEffectData(node, txHash);
    if (txEffectData) {
      const storedCards: StoredCard[] = STARTER_CARD_IDS.map((id, i) => ({
        cardId: id,
        randomness: randomness[i],
        txHash,
        noteHashes: txEffectData.noteHashes,
        firstNullifier: txEffectData.firstNullifier,
      }));
      addCards(accountAddress, storedCards);
    } else {
      log('Starter cards: tx effect unavailable — not stored for restore');
    }
  } catch (e) { log(`Failed to store starter cards for restore: ${e}`); }
  // Separate step: the receive needs no tx effect, and these messages exist
  // only in memory — a failed store must not cost the cards themselves.
  try {
    const received = await ops.receiveCardMessages(accountAddress, txHash, messages);
    log(`Starter cards received (${received} messages)`);
  } catch (e) { log(`Failed to receive starter cards: ${e}`); }
}

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
    import('@aztec-labs/aztec.js/node'),
    import('./instrumentedWallet'),
    import('@aztec-labs/foundation/curves/grumpkin'),
    import('@aztec-labs/aztec.js/fields'),
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

  // Must run BEFORE any store is opened — see drainPendingStoreReset.
  await drainPendingStoreReset(log);

  log('Creating EmbeddedWallet...');
  // NOTE: we deliberately no longer append to `aztec_idb_names`. It existed so
  // "Clear All State" could name the SDK's IndexedDB databases on Safari, which
  // cannot enumerate them — but as of 5.2 the stores are SQLite-OPFS, which
  // `listStores()` enumerates on every browser. Recording IDB names here would
  // only add entries that can never match anything. Any pre-5.2 entries already
  // in localStorage are still read and cleaned up by clearAllState.

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
    import('@aztec-labs/aztec.js/addresses'),
    import('@aztec-labs/aztec.js/account'),
  ]);

  await wallet.registerSender(accountManager.address, 'player');

  // Register contracts (must happen before deploy+mint batch so NFT contract is available)
  const { loadContractArtifact } = await import('@aztec-labs/aztec.js/abi');

  // One registration path, shared with the arena bot (contractArtifacts.ts), so
  // browser and bot register the same contracts the same way.
  const { registerGameContracts } = await import('./contractArtifacts');
  await registerGameContracts(wallet, node, {
    nft: AZTEC_CONFIG.nftContractAddress,
    game: AZTEC_CONFIG.gameContractAddress,
    token: AZTEC_CONFIG.tokenContractAddress,
  }, log);
  const nftArtifact: any = AZTEC_CONFIG.nftContractAddress ? await getNftArtifact() : null;

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
    const { FeeJuicePaymentMethodWithClaim } = await import('@aztec-labs/aztec.js/fee');
    const { mergeExecutionPayloads } = await import('@aztec-labs/stdlib/tx');

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

    const { receipt, offchainMessages } = await deployMethod.send({
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

    if (txHashStr) {
      await storeAndReceiveStarterCards(ops, node, accountAddress, txHashStr, offchainMessages ?? [], log);
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
        const { FeeJuicePaymentMethodWithClaim } = await import('@aztec-labs/aztec.js/fee');
        sendOpts.fee.paymentMethod = new FeeJuicePaymentMethodWithClaim(accountManager.address, options.feeJuiceClaim);
      }
      await deployMethod.send(sendOpts);
      if (useStorage) localStorage.setItem(AZTEC_CONFIG.storageKeys.deploymentStatus, 'deployed');
      log(`Account deployed: ${accountAddress}`);
    }

    if (needsMint) {
    // Mint only (account already deployed)
    log('Minting starter cards...');
    const { txHash: txHashStr, offchainMessages } = await ops.sendMintStarterCards(accountAddress, { node, timeoutMs: AZTEC_TX_TIMEOUT });
    if (useStorage) localStorage.setItem(mintKey, 'true');
    log(`Starter cards minted: ${txHashStr}`);

    await storeAndReceiveStarterCards(ops, node, accountAddress, txHashStr, offchainMessages, log);
    }
  }

  // Load cards from localStorage and import into PXE
  const ownedCardIds = nftArtifact && AZTEC_CONFIG.nftContractAddress
    ? await restoreStoredCards(ops, accountAddress, log)
    : [];

  log(`Connected: ${accountAddress}`);
  return { wallet, node, accountAddress, ownedCardIds };
}

/**
 * Re-import every card this browser has stored for the account, then reconcile
 * the store against what the wallet actually holds. Returns the held card ids
 * when there was anything stored, else [] (the caller decides whether to read).
 *
 * The recovery path: re-derive every stored card and import_note it, so a
 * wiped PXE (Repair chain sync) gets its notes back. It runs on every connect,
 * so on the one that minted the starter cards it imports them a second time,
 * after their messages were received — harmless, because the PXE keys notes
 * by nullifier and stores the card once.
 */
export async function restoreStoredCards(ops: PxeOps, accountAddress: string, log: LogFn): Promise<number[]> {
  const storedCards = loadCards(accountAddress);
  if (storedCards.length === 0) return [];
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
  const ownedCardIds = await ops.readPrivateCards(accountAddress);

  // Reconcile: remove stale cards from localStorage
  const validSet = new Set(ownedCardIds);
  const reconciled = storedCards.filter((c) => validSet.has(c.cardId));
  if (reconciled.length !== storedCards.length) {
    log(`Reconciled: ${storedCards.length} stored → ${reconciled.length} valid`);
    saveCards(accountAddress, reconciled);
  }

  log(`Owned cards: ${JSON.stringify(ownedCardIds)}`);
  return ownedCardIds;
}

/**
 * Set up an account that lives in a wallet the player connected (Nulo).
 *
 * The wallet owns the account: there is nothing to create, fund or deploy
 * here. What the game needs is its contracts registered with the wallet, the
 * cards this browser knows about restored, and, for an account that has never
 * played, its starter cards claimed. The claim is a transaction the player
 * approves in the wallet; `onClaimingStarterCards` says when to ask them.
 *
 * How the claim pays is the wallet's choice, not ours: Nulo offers the
 * account's Fee Juice or its network's sponsor, so an empty Fee Juice balance
 * does not mean the account cannot transact.
 */
export async function setupConnectedWallet(
  wallet: any,
  node: any,
  accountAddress: string,
  ops: PxeOps,
  options: { log?: LogFn; onClaimingStarterCards?: () => void } = {},
): Promise<AztecConnectResult> {
  const log = options.log ?? ((msg: string) => console.log('[connectToAztec]', msg));
  const { registerGameContracts } = await import('./contractArtifacts');
  await registerGameContracts(wallet, node, {
    nft: AZTEC_CONFIG.nftContractAddress,
    game: AZTEC_CONFIG.gameContractAddress,
    token: AZTEC_CONFIG.tokenContractAddress,
  }, log);
  if (!AZTEC_CONFIG.nftContractAddress) return { wallet, node, accountAddress, ownedCardIds: [] };

  await restoreStoredCards(ops, accountAddress, log);
  // Read what the wallet holds whether or not this browser stored anything:
  // the account may have played in another browser, and its wallet keeps its notes.
  let ownedCardIds = await ops.readPrivateCards(accountAddress);

  const mintKey = AZTEC_CONFIG.storageKeys.cardsMintedPrefix + accountAddress + '_' + AZTEC_CONFIG.nftContractAddress;
  if (ownedCardIds.length === 0 && !localStorage.getItem(mintKey)) {
    log('Claiming starter cards...');
    options.onClaimingStarterCards?.();
    try {
      const { txHash, offchainMessages } = await ops.sendMintStarterCards(accountAddress, { node, timeoutMs: AZTEC_TX_TIMEOUT });
      localStorage.setItem(mintKey, 'true');
      log(`Starter cards minted: ${txHash}`);
      await storeAndReceiveStarterCards(ops, node, accountAddress, txHash, offchainMessages, log);
    } catch (e) {
      // The claim is once per account. An account that claimed and then lost
      // every card in games is simply out of cards, not broken.
      if (!/already|existing nullifier|duplicate nullifier/i.test(String(e))) throw e;
      log(`Starter cards were already claimed by this account: ${e}`);
      localStorage.setItem(mintKey, 'true');
    }
    ownedCardIds = await ops.readPrivateCards(accountAddress);
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

/**
 * Wedge recovery: rebuild the PXE's local chain state without touching the
 * account.
 *
 * When the PXE's synced anchor block gets pruned by the network, its own
 * chain-sync re-queries that dead block, silently aborts, and can never
 * advance again (the "[PXE_WEDGED]" error from pxe.withReorgRetry). There is
 * no SDK reset API, and recreating the wallet reopens the same wedged
 * IndexedDB store — the only real fix is deleting the PXE stores so the next
 * connect re-syncs from scratch.
 *
 * Deletes ONLY the pxe_data_* databases. The wallet_data_* stores, the
 * account secret/salt/signing key, the card store, and all other
 * localStorage survive — after the reload the existing restore path
 * (deployAndRegister -> importCardNotes -> readPrivateCards) rebuilds note
 * state. This is an explicit user/harness action, never an automatic
 * fallback.
 */
/**
 * localStorage flag naming what the next boot must delete: 'pxe' (chain-sync
 * repair, keeps the wallet stores) or 'all' (full wipe).
 */
const PENDING_STORE_RESET_KEY = 'aztec_pending_store_reset';

function queueStoreReset(scope: 'pxe' | 'all'): void {
  localStorage.setItem(PENDING_STORE_RESET_KEY, scope);
}

/**
 * Delete the OPFS-backed kv stores queued by repairChainSync / clearAllState.
 *
 * Deferred to the next boot on purpose. As of 5.2 the PXE keeps its state in a
 * SQLite-OPFS SAH pool (one OPFS directory per store, `.aztec-kv-<storeName>`),
 * and `deleteStore` takes that directory's Web Lock — an OPEN store rejects with
 * SqlitePoolBusyError. The wedged-PXE case is exactly when the store is open and
 * unresponsive, so deleting in-place cannot work; queue a flag, reload, and
 * delete here, before EmbeddedWallet.create reopens anything.
 *
 * Store names are enumerated rather than reconstructed: they carry a chain id,
 * rollup address and schema version (pxe_data_11155111-0x...-v13), so a
 * hand-built name silently misses after any re-genesis or schema bump — the bug
 * this replaces, which matched pre-5.2 IndexedDB names that no longer exist.
 */
async function drainPendingStoreReset(log: LogFn): Promise<void> {
  const scope = localStorage.getItem(PENDING_STORE_RESET_KEY);
  if (!scope) return;
  // Clear first: a store we cannot delete must not wedge every future boot.
  localStorage.removeItem(PENDING_STORE_RESET_KEY);
  try {
    const { listStores, deleteStore } = await import('@aztec-labs/kv-store/sqlite-opfs');
    const stores = await listStores();
    const targets = scope === 'all' ? stores : stores.filter(n => n.startsWith('pxe_data_'));
    if (targets.length === 0) {
      log(`Store reset (${scope}): nothing to delete`);
      return;
    }
    for (const name of targets) {
      try {
        await deleteStore(name);
        log(`Store reset: deleted ${name}`);
      } catch (err) {
        // Keep going: one locked store must not block the others.
        log(`Store reset: could not delete ${name} — ${String(err)}`);
      }
    }
  } catch (err) {
    log(`Store reset failed: ${String(err)}`);
  }
}

export function repairChainSync(): void {
  queueStoreReset('pxe');
  window.location.reload();
}

/**
 * Wipe every trace of local state: the queued OPFS store deletion, all
 * localStorage/sessionStorage, and any IndexedDB left over from before 5.2.
 * Unlike repairChainSync this drops the wallet stores too, so the account is
 * re-derived from scratch on the next boot.
 */
export function clearAllState(): void {
  // Read the legacy IDB names BEFORE clearing localStorage, then re-queue the
  // reset flag (localStorage.clear() would otherwise drop it).
  const idbNames = JSON.parse(localStorage.getItem('aztec_idb_names') ?? '[]') as string[];
  localStorage.clear();
  sessionStorage.clear();
  queueStoreReset('all');
  deleteLegacyIdb(idbNames);
  if (typeof indexedDB.databases === 'function') {
    void indexedDB
      .databases()
      .then(dbs => { for (const db of dbs) if (db.name) indexedDB.deleteDatabase(db.name); })
      .catch(() => { /* Safari lacks databases(); the named list above covers it */ })
      .finally(() => window.location.reload());
    return;
  }
  window.location.reload();
}

/** Pre-5.2 the stores were IndexedDB. Harmless no-op once nothing is left. */
function deleteLegacyIdb(names: string[]): void {
  for (const name of names) indexedDB.deleteDatabase(name);
}
