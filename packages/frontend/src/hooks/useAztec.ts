import { useState, useEffect, useCallback, useRef } from 'react';
import { AZTEC_CONFIG } from '../aztec/config';
import { getNftArtifact } from '../aztec/noteImporter';
import { connectToAztec } from '../aztec/connectToAztec';
import { connectWithAzguard } from '../aztec/connectAzguard';

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
  /** Player's Arena Token balance */
  tokenBalance: number;
  /** Refresh the Arena Token balance */
  refreshTokenBalance: () => Promise<void>;
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
  const [tokenBalance, setTokenBalance] = useState<number>(0);
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
      const connectFn = AZTEC_CONFIG.walletMode === 'azguard' ? connectWithAzguard : connectToAztec;
      const result = await connectFn({
        log: (msg) => console.log('[useAztec]', msg),
      });

      walletRef.current = result.wallet;
      nodeClientRef.current = result.node;
      setAccountAddress(result.accountAddress);
      setOwnedCardIds(result.ownedCardIds);

      console.log('[useAztec] Connected, account deployed:', result.accountAddress);
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

  /**
   * Re-fetch owned cards from the PXE's note store.
   * WARNING: Only reliable for initial load (before any settlement). After settlement,
   * the PXE's view_notes may return stale notes. Use updateOwnedCards for post-game updates.
   */
  const refreshOwnedCards = useCallback(async () => {
    const w = walletRef.current;
    if (!w || !accountAddress || !AZTEC_CONFIG.nftContractAddress) return;

    try {
      const { AztecAddress } = await import('@aztec/aztec.js/addresses');
      const { Contract } = await import('@aztec/aztec.js/contracts');

      const nftAddr = AztecAddress.fromString(AZTEC_CONFIG.nftContractAddress);
      const artifact = await getNftArtifact();
      const nftContract = await Contract.at(nftAddr, artifact, w as never);

      const addr = AztecAddress.fromString(accountAddress);
      const cardIds: number[] = [];
      let pageIndex = 0;
      let hasMore = true;
      while (hasMore) {
        const { result } = await nftContract.methods
          .get_private_cards(addr, pageIndex)
          .simulate({ from: addr });
        // v4.2.0: result is [fieldArray, bool]
        const page = result[0] ?? [];
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

  // Token balance is a stub until the ArenaToken contract is deployed.
  // Once deployed, this will call tokenContract.methods.get_balance(addr).simulate().
  const refreshTokenBalance = useCallback(async () => {
    // TODO: Query ArenaToken contract when deployed
    // For now, token balance is tracked client-side based on known game events
    console.log('[useAztec] refreshTokenBalance (stub)');
  }, []);

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
    tokenBalance,
    refreshTokenBalance,
  };
}
