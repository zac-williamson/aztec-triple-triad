/**
 * Prompt shown when a new account needs Fee Juice before deployment.
 * Displays the account address and a link to the official Aztec Fee Juice
 * faucet. The app never auto-funds from a treasury — the user funds manually
 * here, then clicks "I've Funded My Account" to deploy.
 */

interface FundingPromptProps {
  accountAddress: string;
  onConfirm: () => void;
}

const BRIDGE_URL = 'https://aztec-faucet.nethermind.io';

export function FundingPrompt({ accountAddress, onConfirm }: FundingPromptProps) {
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
          Get Fee Juice from the official Aztec faucet below — paste your address
          there to fund your account. Once it's funded, click "I've Funded My
          Account" to continue.
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
          Open Aztec Fee Juice Faucet
        </a>

        <div>
          <button className="parchment-dialog__btn" onClick={onConfirm}>
            I've Funded My Account
          </button>
        </div>
      </div>
    </div>
  );
}
