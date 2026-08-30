import { useState, useRef, useCallback, useEffect } from 'react';
import { AZTEC_CONFIG } from '../aztec/AztecContext';
import { prepareConnection, deployAndRegister, type PreparedConnection } from '../aztec/connectToAztec';
import type { FeeJuiceClaim } from '../aztec/fundDevnet';
import type { AcquireRoute } from '../aztec/l1Funding';
import { pxe, setPxeWallet, runPxeTx } from '../aztec/pxe';
import { startPxeKeepSynced } from '../aztec/pxeKeepSynced';
type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'needs-funding' // non-local network → manual Fee Juice funding via the official Aztec faucet
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
  /**
   * Fund the account from the player's own wallet and deploy in one go.
   *
   * This is the path that works on mainnet: the player buys the fee asset with
   * their own ETH rather than us handing it out. On a network whose fee asset is
   * a mock the same code mints it instead — the swap is the only leg that
   * differs, so testing here exercises the real thing.
   */
  fundWithWallet: (opts?: { acceptQuote?: boolean }) => Promise<void>;
  fundingProgress: string | null;
  /**
   * A priced swap waiting for the player to agree to it.
   *
   * Set when funding needs real money: `fundWithWallet` stops here and spends
   * nothing until it is called again with `acceptQuote`. Showing someone the
   * price before their ETH moves is the whole point.
   */
  pendingQuote: SwapQuote | null;
  cancelQuote: () => void;
  disconnect: () => void;
  refreshOwnedCards: () => Promise<void>;
  updateOwnedCards: (updater: (prev: number[]) => number[]) => void;
  tokenBalance: number;
  refreshTokenBalance: () => Promise<void>;
}

/** A swap the player has been shown but not yet agreed to. */
export interface SwapQuote {
  /** ETH that will leave their wallet. */
  ethIn: bigint;
  /** Fee Juice expected back. */
  quotedOut: bigint;
  /** Worst case they will accept, after slippage. */
  minimumOut: bigint;
  /** Pool fee in hundredths of a bip, e.g. 10000 = 1%. */
  poolFee: number;
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
        // Bind the PXE door BEFORE the deploy so deployAndRegister's inline ops
        // (mint, note import, card read) resolve contracts for this wallet.
        setPxeWallet(prepared.wallet);
        const result = await runPxeTx({
          type: 'deploy_account',
          label,
          execute: async (ops, setPhase) => {
            setPhase('sending');
            return deployAndRegister(prepared, ops, { log, feeJuiceClaim });
          },
        });
        walletRef.current = result.wallet;
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
        } else {
          // Testnet (or any non-local network) — the app NEVER auto-funds from a
          // treasury faucet. Drop straight to the manual FundingPrompt, which
          // points the user at the official Aztec Fee Juice faucet. After they
          // confirm funding, `confirmFunded` runs the deploy+mint.
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
  const confirmFundedWith = useCallback(async (feeJuiceClaim?: unknown) => {
    const prepared = preparedRef.current;
    if (!prepared) {
      setError('No prepared connection');
      setStatus('error');
      return;
    }

    setStatus('deploying');
    setError(null);

    try {
      // Bind the PXE door BEFORE the deploy so deployAndRegister's inline ops
      // resolve contracts for this wallet.
      setPxeWallet(prepared.wallet);
      const result = await runPxeTx({
        type: 'deploy_account',
        label: 'Deploying account & minting starter cards...',
        execute: async (ops, setPhase) => {
          setPhase('sending');
          // The claim, when present, is spent in this very transaction —
          // FeeJuicePaymentMethodWithClaim claims and pays in one go.
          return deployAndRegister(prepared, ops, { log, feeJuiceClaim: feeJuiceClaim as never });
        },
      });
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

  const [fundingProgress, setFundingProgress] = useState<string | null>(null);
  const [pendingQuote, setPendingQuote] = useState<SwapQuote | null>(null);
  // Held out of state so accepting a quote spends the exact route that was
  // priced and shown, not one re-quoted at a moved price behind their back.
  const quotedRouteRef = useRef<unknown>(null);

  const fundWithWallet = useCallback(async (opts?: { acceptQuote?: boolean }) => {
    const prepared = preparedRef.current;
    if (!prepared) {
      setError('No prepared connection');
      setStatus('error');
      return;
    }
    setError(null);
    setFundingProgress('Connecting your wallet…');
    try {
      const { fundAccountFromWallet } = await import('../aztec/l1Funding');
      const { resolveAcquireRoute } = await import('../aztec/fundingRoutes');
      const info = await prepared.node.getNodeInfo();
      const l1 = {
        feeJuiceAddress: String(info.l1ContractAddresses.feeJuiceAddress) as `0x${string}`,
        feeJuicePortalAddress: String(info.l1ContractAddresses.feeJuicePortalAddress) as `0x${string}`,
        feeAssetHandlerAddress: info.l1ContractAddresses.feeAssetHandlerAddress
          ? String(info.l1ContractAddresses.feeAssetHandlerAddress) as `0x${string}`
          : undefined,
      };
      const chainId = Number(info.l1ChainId);

      // Reuse the route the player already agreed to; otherwise price it now.
      let route: AcquireRoute | null =
        opts?.acceptQuote ? (quotedRouteRef.current as AcquireRoute | null) : null;
      if (!route) {
        setFundingProgress('Checking the price of Fee Juice…');
        const { createPublicClient, custom } = await import('viem');
        const eth = (globalThis as { ethereum?: unknown }).ethereum;
        if (!eth) throw new Error('No Ethereum wallet found. Install MetaMask, or fund the account another way.');
        const pub = createPublicClient({ transport: custom(eth as never) });
        route = await resolveAcquireRoute({ chainId, l1, pub: pub as never });
      }

      const { routeCostsRealMoney } = await import('../aztec/fundingRoutes');
      if (!route) throw new Error('Could not determine how to fund this account');
      if (routeCostsRealMoney(route) && !opts?.acceptQuote) {
        // Stop. Nothing has been signed yet, and nothing will be until they
        // have seen what it costs.
        const swap = route as unknown as {
          ethIn: bigint; quotedOut: bigint; maxSlippage: number;
          poolKey: { fee: number };
        };
        quotedRouteRef.current = route;
        setPendingQuote({
          ethIn: swap.ethIn,
          quotedOut: swap.quotedOut,
          minimumOut: (swap.quotedOut * BigInt(Math.round((1 - swap.maxSlippage) * 10_000))) / 10_000n,
          poolFee: swap.poolKey.fee,
        });
        setFundingProgress(null);
        return;
      }

      setPendingQuote(null);
      const claim = await fundAccountFromWallet({
        aztecAddress: prepared.accountAddress,
        l1, chainId, node: prepared.node as never, route,
        onProgress: p => setFundingProgress(p.detail),
      });

      setFundingProgress(null);
      await confirmFundedWith(claim as never);
    } catch (err) {
      setFundingProgress(null);
      setPendingQuote(null);
      // Keep the player on the funding screen: the account is not deployed, and
      // dropping them into an error state loses the retry.
      setError(err instanceof Error ? err.message : 'Funding failed');
    }
  }, []);

  const cancelQuote = useCallback(() => {
    quotedRouteRef.current = null;
    setPendingQuote(null);
  }, []);

  /** The manual path: the player says they funded it themselves. */
  const confirmFunded = useCallback(() => confirmFundedWith(undefined), [confirmFundedWith]);

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
    if (!walletRef.current || !accountAddress) return;
    try {
      // Serialized through the PXE queue inside pxe.readPrivateCards (ground
      // rule #6) — the same reader the rest of the app uses, so this cannot
      // disagree with what a game sees when it commits a hand.
      const { pxe } = await import('../aztec/pxe');
      setOwnedCardIds(await pxe.readPrivateCards(accountAddress));
    } catch (err) {
      // A failed refresh must not clear the list: showing zero cards to someone
      // who owns cards is worse than showing a slightly stale count.
      console.warn('[useAztec] refreshOwnedCards failed; keeping the previous list:', err);
    }
  }, [accountAddress]);

  const refreshTokenBalance = useCallback(async () => {
    if (!walletRef.current || !accountAddress || !AZTEC_CONFIG.tokenContractAddress) return;
    // Serialized through the PXE queue inside pxe.readTokenBalance (ground rule
    // #6), which also waits for contract warmup. The read no longer races queued
    // ops, so it no longer throws IndexedDB TransactionInactiveError — the
    // race-era catch→warn that swallowed it is gone, and real errors surface.
    const balance = Number(await pxe.readTokenBalance(accountAddress));
    tokenBalanceRef.current = balance;
    setTokenBalance(balance);
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

  // Keep the PXE's proof anchor fresh for the whole connected lifetime.
  // Without it, any idle window (joiner waiting on the opponent's create_game,
  // lobby time) ages the anchor past the testnet's prune horizon and the next
  // proof is rejected — the idle-joiner wedge.
  useEffect(() => {
    if (status !== 'connected') return;
    return startPxeKeepSynced();
  }, [status]);

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
    fundWithWallet,
    fundingProgress,
    pendingQuote,
    cancelQuote,
    disconnect,
    refreshOwnedCards,
    updateOwnedCards: setOwnedCardIds,
    tokenBalance,
    refreshTokenBalance,
  };
}
