import { useState, useEffect, useCallback, useRef } from 'react';
import { AZTEC_CONFIG } from '../aztec/config';

/**
 * Aztec wallet connection status
 */
export type AztecConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'unsupported';

/**
 * Return type for the useAztec hook
 */
export interface UseAztecReturn {
  /** Current connection status */
  status: AztecConnectionStatus;
  /** True while connect() is in progress */
  isConnecting: boolean;
  /** True once connect() has completed successfully */
  hasConnected: boolean;
  /** Account address (hex string) if connected */
  accountAddress: string | null;
  /** Whether Aztec features are available */
  isAvailable: boolean;
  /** Error message if connection failed */
  error: string | null;
  /** The wallet instance (opaque - used internally by other hooks) */
  wallet: unknown | null;
  /** The node client instance */
  nodeClient: unknown | null;
  /** Card IDs the player owns (from on-chain private notes) */
  ownedCardIds: number[];
  /** Attempt to connect to Aztec network */
  connect: () => Promise<void>;
  /** Disconnect from Aztec network */
  disconnect: () => void;
  /** Re-fetch owned cards from the NFT contract */
  refreshOwnedCards: () => Promise<void>;
  /** Directly update the owned card IDs (bypasses view_notes which may return stale notes) */
  updateOwnedCards: (updater: (prev: number[]) => number[]) => void;
}

/**
 * Hook for managing Aztec wallet connection.
 *
 * Connects to an Aztec node via PXE, creates an EmbeddedWallet,
 * and persists account secrets in localStorage for session continuity.
 *
 * Falls back gracefully if Aztec SDK is unavailable or the node is unreachable.
 */
export function useAztec(): UseAztecReturn {
  const [status, setStatus] = useState<AztecConnectionStatus>(
    AZTEC_CONFIG.enabled ? 'disconnected' : 'unsupported',
  );
  const [accountAddress, setAccountAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ownedCardIds, setOwnedCardIds] = useState<number[]>([]);
  const walletRef = useRef<unknown>(null);
  const nodeClientRef = useRef<unknown>(null);

  // Try to restore persisted account address on mount
  useEffect(() => {
    if (!AZTEC_CONFIG.enabled) return;
    const saved = localStorage.getItem(AZTEC_CONFIG.storageKeys.accountAddress);
    if (saved) {
      setAccountAddress(saved);
    }
  }, []);

  const connect = useCallback(async () => {
    if (!AZTEC_CONFIG.enabled) {
      setStatus('unsupported');
      setError('Aztec integration is disabled');
      return;
    }

    setStatus('connecting');
    setError(null);

    try {
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
      nodeClientRef.current = node;

      // Check if we have a saved secret, or generate a new one
      // Use Fr.random() to guarantee the value is within the BN254 field modulus
      let secret = localStorage.getItem(AZTEC_CONFIG.storageKeys.accountSecret);
      let secretFr: typeof Fr.prototype;
      try {
        secretFr = secret ? Fr.fromHexString(secret.startsWith('0x') ? secret : '0x' + secret) : Fr.random();
      } catch {
        // Stored value exceeds field modulus — regenerate
        secretFr = Fr.random();
      }
      const secretHex = secretFr.toString();
      if (secret !== secretHex) {
        localStorage.setItem(AZTEC_CONFIG.storageKeys.accountSecret, secretHex);
      }

      let salt = localStorage.getItem(AZTEC_CONFIG.storageKeys.accountSalt);
      let saltFr: typeof Fr.prototype;
      try {
        saltFr = salt ? Fr.fromHexString(salt.startsWith('0x') ? salt : '0x' + salt) : Fr.random();
      } catch {
        saltFr = Fr.random();
      }
      const saltHex = saltFr.toString();
      if (salt !== saltHex) {
        localStorage.setItem(AZTEC_CONFIG.storageKeys.accountSalt, saltHex);
      }

      // Create EmbeddedWallet — runs a full PXE in the browser tab
      const wallet = await EmbeddedWallet.create(node, { ephemeral: true });

      // Wait for PXE to sync so tx expiration timestamps are valid
      await new Promise(r => setTimeout(r, 5000));

      // Register SponsoredFPC for fee payments
      const [{ getContractInstanceFromInstantiationParams }, { SponsoredFPCContractArtifact }, { SPONSORED_FPC_SALT }, { SponsoredFeePaymentMethod }, { AztecAddress }] = await Promise.all([
        import('@aztec/stdlib/contract'),
        import('@aztec/noir-contracts.js/SponsoredFPC'),
        import('@aztec/constants'),
        import('@aztec/aztec.js/fee'),
        import('@aztec/aztec.js/addresses'),
      ]);

      const sponsoredFPC = await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, {
        salt: new Fr(SPONSORED_FPC_SALT),
      });
      await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);
      const paymentMethod = new SponsoredFeePaymentMethod(sponsoredFPC.address);

      // Create a Schnorr account within the wallet using persisted secret + salt
      const signingKey = GrumpkinScalar.random();
      const accountManager = await wallet.createSchnorrAccount(
        secretFr,
        saltFr,
        signingKey,
      );

      // Deploy the account on-chain
      const deployMethod = await accountManager.getDeployMethod();
      await deployMethod.send({
        from: AztecAddress.ZERO,
        fee: { paymentMethod },
        skipClassPublication: true,
        skipInstancePublication: true,
        wait: { timeout: 300 },
      });

      // Register this account as a sender for note discovery
      await wallet.registerSender(accountManager.address, 'player');

      // Register NFT and Game contracts with the PXE so we can call their methods
      const { loadContractArtifact } = await import('@aztec/aztec.js/abi');

      let nftArtifact: any = null;
      if (AZTEC_CONFIG.nftContractAddress) {
        const nftAddress = AztecAddress.fromString(AZTEC_CONFIG.nftContractAddress);
        await wallet.registerSender(nftAddress, 'nft-contract');
        try {
          const nftInstance = await node.getContract(nftAddress);
          if (nftInstance) {
            const resp = await fetch('/contracts/triple_triad_nft-TripleTriadNFT.json');
            const rawArtifact = await resp.json();
            nftArtifact = loadContractArtifact(rawArtifact);
            await wallet.registerContract(nftInstance, nftArtifact);
            console.log('[useAztec] NFT contract registered with PXE');
          }
        } catch (e) {
          console.warn('[useAztec] Failed to register NFT contract:', e);
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
            console.log('[useAztec] Game contract registered with PXE');
          }
        } catch (e) {
          console.warn('[useAztec] Failed to register Game contract:', e);
        }
      }

      // Mint starter cards if this account hasn't claimed them yet
      const address = accountManager.address.toString();
      const mintKey = AZTEC_CONFIG.storageKeys.cardsMintedPrefix + address + '_' + AZTEC_CONFIG.nftContractAddress;
      if (nftArtifact && AZTEC_CONFIG.nftContractAddress && !localStorage.getItem(mintKey)) {
        try {
          const { Contract } = await import('@aztec/aztec.js/contracts');
          const nftAddr = AztecAddress.fromString(AZTEC_CONFIG.nftContractAddress);
          const nftContract = await Contract.at(nftAddr, nftArtifact, wallet as never);
          console.log('[useAztec] Minting starter cards via get_cards_for_new_player...');
          const receipt = await nftContract.methods
            .get_cards_for_new_player()
            .send({ from: accountManager.address, fee: { paymentMethod }, wait: { timeout: 300 } });
          localStorage.setItem(mintKey, 'true');
          const txHashStr = (receipt as any).txHash?.toString() || '';
          console.log('[useAztec] Starter cards tx mined, txHash:', txHashStr);

          // Import the 5 starter card notes (create_and_push_note skips tagging)
          if (txHashStr) {
            try {
              // Get deterministic randomness values from the contract
              const randomnessResult = await nftContract.methods
                .compute_note_randomness(0, 5)
                .simulate({ from: accountManager.address });
              // Convert simulate results to Fr values. The result may be Fr objects,
              // BigInts, or decimal/hex strings — use toFr() helper to handle all cases.
              const toFr = (v: any): typeof Fr.prototype => {
                if (v instanceof Fr) return v;
                const s = v.toString();
                // If it starts with 0x, it's hex — use fromHexString
                if (s.startsWith('0x') || s.startsWith('0X')) return Fr.fromHexString(s);
                // Otherwise it's decimal — convert via BigInt
                return new Fr(BigInt(s));
              };
              const randomnessFrs: (typeof Fr.prototype)[] = [];
              for (let i = 0; i < 5; i++) {
                randomnessFrs.push(toFr(randomnessResult[i]));
              }
              console.log('[useAztec] Derived note randomness for starter cards:', randomnessFrs.map(r => r.toString().slice(0, 18) + '...'));

              // Get TxEffect for note hash data
              const { TxHash } = await import('@aztec/stdlib/tx');
              const hash = TxHash.fromString(txHashStr);
              let txEffect: any = null;
              for (let attempt = 0; attempt < 5; attempt++) {
                const txResult = await node.getTxEffect(hash);
                if (txResult?.data) { txEffect = txResult.data; break; }
                console.log(`[useAztec] TxEffect not ready (attempt ${attempt + 1}/5), waiting...`);
                await new Promise(r => setTimeout(r, 3000));
              }

              if (txEffect) {
                const rawNoteHashes: any[] = txEffect.noteHashes ?? [];
                const uniqueNoteHashes: string[] = rawNoteHashes
                  .map((h: any) => h.toString())
                  .filter((h: string) => h !== '0' && h !== '0x0' && !/^0x0+$/.test(h));
                const firstNullifier: string = txEffect.nullifiers?.[0]?.toString() ?? '0';

                console.log(`[useAztec] TxEffect: ${uniqueNoteHashes.length} note hashes, importing 5 starter cards...`);

                const STARTER_CARD_IDS = [1, 2, 3, 4, 5];
                const paddedHashes = new Array(64).fill(new Fr(0n));
                for (let i = 0; i < uniqueNoteHashes.length && i < 64; i++) {
                  paddedHashes[i] = Fr.fromHexString(uniqueNoteHashes[i]);
                }

                const txHashFr = toFr(txHashStr);
                const firstNullFr = toFr(firstNullifier);
                for (let i = 0; i < 5; i++) {
                  console.log(`[useAztec] Importing starter card ${STARTER_CARD_IDS[i]}...`);
                  await nftContract.methods
                    .import_note(
                      accountManager.address,
                      new Fr(BigInt(STARTER_CARD_IDS[i])),
                      randomnessFrs[i],
                      txHashFr,
                      paddedHashes,
                      uniqueNoteHashes.length,
                      firstNullFr,
                      accountManager.address,
                    )
                    .simulate({ from: accountManager.address });
                }
                console.log('[useAztec] All 5 starter card notes imported successfully');
              } else {
                console.warn('[useAztec] Could not fetch TxEffect for starter card note import');
              }
            } catch (importErr) {
              console.warn('[useAztec] Failed to import starter card notes:', importErr);
            }
          }
        } catch (e) {
          console.warn('[useAztec] Failed to mint starter cards:', e);
        }
      }

      // Fetch the player's owned cards from the NFT contract
      if (nftArtifact && AZTEC_CONFIG.nftContractAddress) {
        try {
          const { Contract } = await import('@aztec/aztec.js/contracts');
          const nftAddr = AztecAddress.fromString(AZTEC_CONFIG.nftContractAddress);
          const nftContract = await Contract.at(nftAddr, nftArtifact, wallet as never);

          const cardIds: number[] = [];
          let pageIndex = 0;
          let hasMore = true;
          while (hasMore) {
            const result = await nftContract.methods
              .get_private_cards(accountManager.address, pageIndex)
              .simulate({ from: accountManager.address });
            // result is [Field[MAX_NOTES_PER_PAGE], bool]
            const page = result[0] ?? result;
            hasMore = result[1] === true;
            for (const val of page) {
              const id = Number(BigInt(val));
              if (id !== 0) cardIds.push(id);
            }
            pageIndex++;
          }

          setOwnedCardIds(cardIds);
          console.log('[useAztec] Owned cards:', cardIds);
        } catch (e) {
          console.warn('[useAztec] Failed to fetch owned cards:', e);
        }
      }

      walletRef.current = wallet;

      // Get account address from the AccountManager
      setAccountAddress(address);
      localStorage.setItem(AZTEC_CONFIG.storageKeys.accountAddress, address);

      console.log('[useAztec] Connected, account deployed:', address);
      setStatus('connected');
    } catch (err) {
      console.error('[useAztec] Connection failed:', err);
      const message = err instanceof Error ? err.message : 'Unknown error connecting to Aztec';
      setError(message);
      setStatus('error');
      walletRef.current = null;
      nodeClientRef.current = null;
    }
  }, []);

  const disconnect = useCallback(() => {
    walletRef.current = null;
    nodeClientRef.current = null;
    setStatus('disconnected');
    setAccountAddress(null);
    setError(null);
    setOwnedCardIds([]);
  }, []);

  const refreshOwnedCards = useCallback(async () => {
    const w = walletRef.current;
    if (!w || !accountAddress || !AZTEC_CONFIG.nftContractAddress) return;

    try {
      const [{ AztecAddress }, { Contract }, { loadContractArtifact }] = await Promise.all([
        import('@aztec/aztec.js/addresses'),
        import('@aztec/aztec.js/contracts'),
        import('@aztec/aztec.js/abi'),
      ]);

      const nftAddr = AztecAddress.fromString(AZTEC_CONFIG.nftContractAddress);
      const resp = await fetch('/contracts/triple_triad_nft-TripleTriadNFT.json');
      const rawArtifact = await resp.json();
      const artifact = loadContractArtifact(rawArtifact);
      const nftContract = await Contract.at(nftAddr, artifact, w as never);

      const addr = AztecAddress.fromString(accountAddress);
      const cardIds: number[] = [];
      let pageIndex = 0;
      let hasMore = true;
      while (hasMore) {
        const result = await nftContract.methods
          .get_private_cards(addr, pageIndex)
          .simulate({ from: addr });
        const page = result[0] ?? result;
        hasMore = result[1] === true;
        for (const val of page) {
          const id = Number(BigInt(val));
          if (id !== 0) cardIds.push(id);
        }
        pageIndex++;
      }

      setOwnedCardIds(cardIds);
      console.log('[useAztec] Refreshed owned cards:', cardIds);
    } catch (e) {
      console.warn('[useAztec] Failed to refresh owned cards:', e);
    }
  }, [accountAddress]);

  return {
    status,
    isConnecting: status === 'connecting',
    hasConnected: status === 'connected',
    accountAddress,
    isAvailable: status === 'connected',
    error,
    wallet: walletRef.current,
    nodeClient: nodeClientRef.current,
    ownedCardIds,
    connect,
    disconnect,
    refreshOwnedCards,
    updateOwnedCards: setOwnedCardIds,
  };
}
