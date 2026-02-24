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
 * Connects to an Aztec node via PXE, creates an embedded TestWallet,
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
      // @aztec/aztec.js only has subpath exports (e.g. /node, /fee, /addresses)
      const [nodeModule, testWallet, stdlibKeys] = await Promise.all([
        import('@aztec/aztec.js/node'),
        import('@aztec/test-wallet/client/lazy'),
        import('@aztec/stdlib/keys'),
      ]);

      const { createAztecNodeClient } = nodeModule;

      // Connect to the Aztec node
      const node = createAztecNodeClient(AZTEC_CONFIG.pxeUrl);
      nodeClientRef.current = node;

      // Check if we have a saved secret, or generate a new one
      let secret = localStorage.getItem(AZTEC_CONFIG.storageKeys.accountSecret);
      if (!secret) {
        // Generate a random secret for this browser session
        const randomBytes = new Uint8Array(32);
        crypto.getRandomValues(randomBytes);
        secret = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem(AZTEC_CONFIG.storageKeys.accountSecret, secret);
      }

      // Create embedded PXE wallet
      // TestWallet runs a full PXE in the browser tab - no external wallet needed
      const wallet = await testWallet.TestWallet.create(node);
      walletRef.current = wallet;

      // Get account address
      const address = wallet.getAddress().toString();
      setAccountAddress(address);
      localStorage.setItem(AZTEC_CONFIG.storageKeys.accountAddress, address);

      // Derive signing key for later use
      const _signingKey = stdlibKeys.deriveSigningKey(secret);

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
