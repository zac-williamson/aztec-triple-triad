import { useState, useRef, useCallback, useEffect } from 'react';
import { AZTEC_CONFIG } from '../aztec/AztecContext';
import { prepareConnection, deployAndRegister, type PreparedConnection } from '../aztec/connectToAztec';

type ConnectionStatus = 'disconnected' | 'connecting' | 'needs-funding' | 'deploying' | 'connected' | 'error' | 'unsupported';

export interface UseAztecReturn {
  status: ConnectionStatus;
  isConnecting: boolean;
  hasConnected: boolean;
  accountAddress: string | null;
  isAvailable: boolean;
  error: string | null;
  wallet: unknown;
  nodeClient: unknown;
  ownedCardIds: number[];
  connect: () => Promise<void>;
  confirmFunded: () => Promise<void>;
  disconnect: () => void;
  refreshOwnedCards: () => Promise<void>;
  updateOwnedCards: (updater: (prev: number[]) => number[]) => void;
  tokenBalance: number;
  refreshTokenBalance: () => Promise<void>;
}

export function useAztec(): UseAztecReturn {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [accountAddress, setAccountAddress] = useState<string | null>(
    () => localStorage.getItem(AZTEC_CONFIG.storageKeys.accountAddress) || null,
  );
  const [ownedCardIds, setOwnedCardIds] = useState<number[]>([]);
  const [tokenBalance, setTokenBalance] = useState<number>(0);
  const walletRef = useRef<unknown>(null);
  const nodeClientRef = useRef<unknown>(null);
  const preparedRef = useRef<PreparedConnection | null>(null);

  const log = (msg: string) => console.log('[useAztec]', msg);

  const connect = useCallback(async () => {
    if (!AZTEC_CONFIG.enabled) {
      setStatus('unsupported');
      setError('Aztec integration is disabled');
      return;
    }

    setStatus('connecting');
    setError(null);

    try {
      // Phase 1 — generate keys + address (no deployment)
      const prepared = await prepareConnection({ log });
      preparedRef.current = prepared;
      setAccountAddress(prepared.accountAddress);

      if (prepared.alreadyDeployed) {
        // Account already deployed — go straight to Phase 2
        setStatus('deploying');
        const result = await deployAndRegister(prepared, { log });
        walletRef.current = result.wallet;
        nodeClientRef.current = result.node;
        setOwnedCardIds(result.ownedCardIds);
        setStatus('connected');
      } else {
        const isLocalDevnet = AZTEC_CONFIG.pxeUrl.includes('localhost') || AZTEC_CONFIG.pxeUrl.includes('127.0.0.1');
        if (isLocalDevnet) {
          // Local devnet — auto-fund via L1 Fee Juice bridge, then deploy
          log('Auto-funding account on local devnet...');
          const { fundAccountOnDevnet } = await import('../aztec/fundDevnet');
          const claim = await fundAccountOnDevnet(prepared.node, prepared.accountAddress, log);
          setStatus('deploying');
          const result = await deployAndRegister(prepared, { log, feeJuiceClaim: claim });
          walletRef.current = result.wallet;
          nodeClientRef.current = result.node;
          setOwnedCardIds(result.ownedCardIds);
          setStatus('connected');
        } else {
          // Testnet — show funding prompt, user funds manually
          setStatus('needs-funding');
        }
      }
    } catch (err) {
      console.error('[useAztec] Connection failed:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStatus('error');
    }
  }, []);

  /** Called when the user confirms they've funded their address */
  const confirmFunded = useCallback(async () => {
    const prepared = preparedRef.current;
    if (!prepared) {
      setError('No prepared connection');
      setStatus('error');
      return;
    }

    setStatus('deploying');
    setError(null);

    try {
      const result = await deployAndRegister(prepared, { log });
      walletRef.current = result.wallet;
      nodeClientRef.current = result.node;
      setAccountAddress(result.accountAddress);
      setOwnedCardIds(result.ownedCardIds);
      setStatus('connected');
    } catch (err) {
      console.error('[useAztec] Deploy failed:', err);
      setError(err instanceof Error ? err.message : 'Deployment failed');
      setStatus('error');
    }
  }, []);

  const disconnect = useCallback(() => {
    walletRef.current = null;
    nodeClientRef.current = null;
    preparedRef.current = null;
    setStatus('disconnected');
    setAccountAddress(null);
    setError(null);
    setOwnedCardIds([]);
  }, []);

  const refreshOwnedCards = useCallback(async () => {
    // TODO: implement refresh via contract call
  }, [accountAddress]);

  const refreshTokenBalance = useCallback(async () => {
    // TODO: implement via ArenaToken.get_balance()
  }, []);

  return {
    status,
    isConnecting: status === 'connecting' || status === 'deploying',
    hasConnected: status === 'connected',
    accountAddress,
    isAvailable: status === 'connected',
    error,
    wallet: walletRef.current,
    nodeClient: nodeClientRef.current,
    ownedCardIds,
    connect,
    confirmFunded,
    disconnect,
    refreshOwnedCards,
    updateOwnedCards: setOwnedCardIds,
    tokenBalance,
    refreshTokenBalance,
  };
}
