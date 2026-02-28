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
  /** Attempt to connect to Aztec network */
  connect: () => Promise<void>;
  /** Disconnect from Aztec network */
  disconnect: () => void;
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
      let secret = localStorage.getItem(AZTEC_CONFIG.storageKeys.accountSecret);
      if (!secret) {
        const randomBytes = new Uint8Array(32);
        crypto.getRandomValues(randomBytes);
        secret = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem(AZTEC_CONFIG.storageKeys.accountSecret, secret);
      }

      // Load or generate a salt for deterministic account recreation
      let salt = localStorage.getItem(AZTEC_CONFIG.storageKeys.accountSalt);
      if (!salt) {
        const randomBytes = new Uint8Array(32);
        crypto.getRandomValues(randomBytes);
        salt = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem(AZTEC_CONFIG.storageKeys.accountSalt, salt);
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
        Fr.fromHexString('0x' + secret),
        Fr.fromHexString('0x' + salt),
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

      // Register the NFT contract if configured (for note discovery)
      if (AZTEC_CONFIG.nftContractAddress) {
        await wallet.registerSender(
          AztecAddress.fromString(AZTEC_CONFIG.nftContractAddress),
          'nft-contract',
        );
      }

      walletRef.current = wallet;

      // Get account address from the AccountManager
      const address = accountManager.address.toString();
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
  }, []);

  return {
    status,
    accountAddress,
    isAvailable: status === 'connected',
    error,
    wallet: walletRef.current,
    nodeClient: nodeClientRef.current,
    connect,
    disconnect,
  };
}
