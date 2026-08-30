/**
 * Prompt shown when a new account needs Fee Juice before deployment.
 * Displays the account address and a link to the Fee Juice bridge. The app
 * never auto-funds from a treasury — the user bridges Fee Juice manually here,
 * then clicks "I've Funded My Account" to deploy.
 */

/** Mirrors useAztec's SwapQuote; kept structural so this stays presentational. */
export interface SwapQuote {
  ethIn: bigint;
  quotedOut: bigint;
  minimumOut: bigint;
  poolFee: number;
}

/** 18-decimal fixed point, trimmed. Intl can't take a bigint of this scale. */
function formatUnits18(v: bigint, places = 5): string {
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, '0').slice(0, places).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

interface FundingPromptProps {
  accountAddress: string;
  /** The manual escape hatch: the player says they funded it elsewhere. */
  onConfirm: () => void;
  /**
   * Fund from the player's own wallet. This is the path that works on mainnet,
   * where nobody hands out fee juice — the player pays with their own ETH.
   */
  onFundWithWallet: () => void;
  /**
   * A priced swap awaiting agreement. While set, nothing has been signed and
   * nothing will be until `onAcceptQuote` fires.
   */
  quote?: SwapQuote | null;
  onAcceptQuote?: () => void;
  onCancelQuote?: () => void;
  /** Human-readable step while funding is in flight. */
  progress?: string | null;
  error?: string | null;
}

const BRIDGE_URL = 'https://bridge.aztec-kit.anothercoffeefor.me/';

export function FundingPrompt({
  accountAddress, onConfirm, onFundWithWallet, progress, error,
  quote, onAcceptQuote, onCancelQuote,
}: FundingPromptProps) {
  const busy = Boolean(progress);
  const copyAddress = () => {
    navigator.clipboard.writeText(accountAddress);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(10, 18, 10, 0.95)',
    }}>
      <div className="parchment-dialog" style={{ maxWidth: 520, textAlign: 'center' }}>
        <div className="parchment-dialog__title" style={{ fontSize: 22 }}>
          Fund Your Account
        </div>

        <p style={{ fontFamily: "'Cinzel', serif", fontSize: 14, color: '#5a4a34', margin: '16px 0 8px' }}>
          Your Aztec account needs Fee Juice to pay for transactions on the testnet.
        </p>

        <div style={{
          background: 'rgba(30, 20, 10, 0.6)',
          border: '1px solid rgba(180, 140, 60, 0.3)',
          borderRadius: 8,
          padding: '12px 16px',
          margin: '16px 0',
          wordBreak: 'break-all',
          fontFamily: 'monospace',
          fontSize: 13,
          color: '#c8a860',
          cursor: 'pointer',
          position: 'relative',
        }} onClick={copyAddress} title="Click to copy">
          {accountAddress}
          <div style={{ fontSize: 10, color: '#8a7a64', marginTop: 4 }}>
            Click to copy
          </div>
        </div>

        <p style={{ fontFamily: "'Cinzel', serif", fontSize: 13, color: '#5a4a34', margin: '12px 0' }}>
          Fund it from your Ethereum wallet and you'll be playing in a moment.
          We'll ask you to approve a few transactions.
        </p>

        {quote && (
          <div
            data-testid="swap-quote"
            style={{
              margin: '16px 0', padding: '12px 14px', textAlign: 'left',
              border: '1px solid #b9a67f', borderRadius: 6, background: 'rgba(255,252,244,0.6)',
              fontFamily: "'Cinzel', serif", fontSize: 13, color: '#5a4a34',
            }}
          >
            <strong style={{ display: 'block', marginBottom: 6 }}>Confirm your purchase</strong>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>You pay</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatUnits18(quote.ethIn)} ETH</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>You receive</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>~{formatUnits18(quote.quotedOut)} Fee Juice</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.8 }}>
              <span>At worst</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatUnits18(quote.minimumOut)} Fee Juice</span>
            </div>
            <p style={{ margin: '8px 0 0', fontSize: 12, opacity: 0.8 }}>
              Prices move. If the trade would return less than the worst case above,
              it is cancelled and your ETH stays with you.
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                className="parchment-dialog__btn"
                data-testid="accept-quote"
                onClick={onAcceptQuote}
                disabled={busy}
              >
                {busy ? 'Buying…' : 'Buy Fee Juice'}
              </button>
              <button className="parchment-dialog__btn" onClick={onCancelQuote} disabled={busy}>
                Back
              </button>
            </div>
          </div>
        )}

        <div style={{ margin: '16px 0 8px', display: quote ? 'none' : undefined }}>
          <button
            className="parchment-dialog__btn"
            data-testid="fund-with-wallet"
            onClick={onFundWithWallet}
            disabled={busy}
            style={busy ? { opacity: 0.6, cursor: 'wait' } : undefined}
          >
            {busy ? 'Funding…' : 'Fund with My Wallet'}
          </button>
        </div>

        {progress && (
          <p
            role="status"
            style={{ fontFamily: "'Cinzel', serif", fontSize: 13, color: '#5a4a34', margin: '4px 0 12px' }}
          >
            {progress}
          </p>
        )}

        {error && (
          <p
            role="alert"
            style={{ fontFamily: "'Cinzel', serif", fontSize: 13, color: '#8a2f24', margin: '4px 0 12px' }}
          >
            {error}
          </p>
        )}

        <p style={{ fontFamily: "'Cinzel', serif", fontSize: 12, color: '#7a6a54', margin: '16px 0 4px' }}>
          No wallet? You can bridge Fee Juice yourself instead.
        </p>

        <a
          href={BRIDGE_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-block',
            fontFamily: "'Cinzel', serif",
            fontSize: 14,
            color: '#c8a860',
            textDecoration: 'underline',
            margin: '8px 0 20px',
          }}
        >
          Open Fee Juice Bridge
        </a>

        <div>
          <button
            className="parchment-dialog__btn"
            onClick={onConfirm}
            disabled={busy}
            style={{ opacity: busy ? 0.6 : 0.85, fontSize: 13 }}
          >
            I've Funded It Myself
          </button>
        </div>
      </div>
    </div>
  );
}
