import { useState, useRef, useCallback, useEffect } from 'react';
import { AZTEC_CONFIG } from '../aztec/AztecContext';
import { prepareConnection, deployAndRegister, type PreparedConnection } from '../aztec/connectToAztec';
import type { FeeJuiceClaim } from '../aztec/fundDevnet';
import txManager from '../aztec/txManager';
import { pxe, setPxeWallet } from '../aztec/pxe';
type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'funding' // testnet: requesting Fee Juice from the backend faucet (item I)
  | 'needs-funding' // faucet unavailable/failed → manual funding fallback
  | 'deploying'
  | 'connected'
  | 'error'
  | 'unsupported';

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
  const tokenBalanceRef = useRef<number>(0);
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

      // Phase 2 — deploy (+ mint starter cards) and mark connected. Shared by
      // every funding path so fees/labels/post-deploy wiring can't drift.
      const runDeploy = async (label: string, feeJuiceClaim?: FeeJuiceClaim) => {
        setStatus('deploying');
        const result = await txManager.runTx({
          type: 'deploy_account',
          label,
          execute: async (setPhase) => {
            setPhase('sending');
            return deployAndRegister(prepared, { log, feeJuiceClaim });
          },
        });
        walletRef.current = result.wallet;
        setPxeWallet(result.wallet); // bind the PXE module's contracts to this wallet
        nodeClientRef.current = result.node;
        setOwnedCardIds(result.ownedCardIds);
        setStatus('connected');
      };

      if (prepared.alreadyDeployed) {
        // Account already deployed — restore, no funding needed.
        await runDeploy('Restoring account...');
      } else {
        const isLocalDevnet = AZTEC_CONFIG.pxeUrl.includes('localhost') || AZTEC_CONFIG.pxeUrl.includes('127.0.0.1');
        if (isLocalDevnet) {
          // Local devnet — auto-fund via Anvil's free L1 Fee Juice bridge.
          log('Auto-funding account on local devnet...');
          const { fundAccountOnDevnet } = await import('../aztec/fundDevnet');
          const claim = await fundAccountOnDevnet(prepared.node, prepared.accountAddress, log);
          await runDeploy('Deploying account & minting starter cards...', claim);
        } else if (AZTEC_CONFIG.faucetUrl) {
          // Testnet — auto-fund via the backend treasury faucet (item I,
          // Option B), then deploy+mint in one tx. A faucet *request* failure
          // degrades to the manual FundingPrompt so onboarding never dead-ends;
          // a deploy failure after a good claim is a real error (outer catch).
          let claim: FeeJuiceClaim | null = null;
          try {
            setStatus('funding');
            log('Requesting Fee Juice from the faucet...');
            const { requestFeeJuiceClaim } = await import('../aztec/requestFeeJuiceClaim');
            claim = await requestFeeJuiceClaim(AZTEC_CONFIG.faucetUrl, prepared.accountAddress);
          } catch (faucetErr) {
            console.warn('[useAztec] Faucet funding failed; falling back to manual funding:', faucetErr);
            setStatus('needs-funding');
          }
          if (claim) {
            await runDeploy('Deploying account & minting starter cards...', claim);
          }
        } else {
          // No faucet configured — manual funding prompt.
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
      const result = await txManager.runTx({
        type: 'deploy_account',
        label: 'Deploying account & minting starter cards...',
        execute: async (setPhase) => {
          setPhase('sending');
          return deployAndRegister(prepared, { log });
        },
      });
      walletRef.current = result.wallet;
      setPxeWallet(result.wallet); // bind the PXE module's contracts to this wallet
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
    setPxeWallet(null);
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
    if (!walletRef.current || !accountAddress || !AZTEC_CONFIG.tokenContractAddress) return;
    try {
      // Serialized through the PXE queue inside pxe.readTokenBalance (ground
      // rule #6), which also waits for contract warmup. This read fires on a
      // 15× connect poll and after every settlement; an UNqueued simulate races
      // queued ops → IndexedDB TransactionInactiveError (the flake the playtest
      // harness was masking).
      const balance = Number(await pxe.readTokenBalance(accountAddress));
      tokenBalanceRef.current = balance;
      setTokenBalance(balance);
    } catch (e) {
      console.warn('[useAztec] Failed to fetch token balance:', e);
    }
  }, [accountAddress]);

  // Auto-fetch token balance when connected.
  // Settlement mints tokens to the *opponent* (loser) on-chain and the note
  // is tagged for their PXE to discover via block scanning. If the page is
  // refreshed before/while PXE finishes syncing the block containing the
  // mint, get_balance will transiently read a stale value. Poll for ~30s
  // on each connect and stop once the balance stabilizes.
  useEffect(() => {
    if (status !== 'connected') return;
    let cancelled = false;
    let previousBalance: number | null = null;
    let unchangedReads = 0;
    (async () => {
      for (let i = 0; i < 15; i++) {
        if (cancelled) return;
        await refreshTokenBalance();
        if (cancelled) return;
        const now = tokenBalanceRef.current;
        if (previousBalance !== null && now === previousBalance) {
          unchangedReads++;
          if (unchangedReads >= 2) return; // two consecutive identical reads — assume synced
        } else {
          unchangedReads = 0;
        }
        previousBalance = now;
        await new Promise(r => setTimeout(r, 2000));
      }
    })();
    return () => { cancelled = true; };
  }, [status, refreshTokenBalance]);

  return {
    status,
    isConnecting: status === 'connecting' || status === 'funding' || status === 'deploying',
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
