import type { WalletKind } from '../aztec/walletChoice';

const NULO_URL = 'https://nulo.sh';

interface WalletChooserProps {
  onChoose: (kind: WalletKind) => void;
}

const text = { fontFamily: "'Cinzel', serif", fontSize: 14, color: '#5a4a34', margin: '12px 0' } as const;

const option = {
  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4,
  width: '100%', padding: '14px 16px', textAlign: 'left',
} as const;

const optionDetail = { fontSize: 12, fontWeight: 400, lineHeight: 1.4, opacity: 0.85, textTransform: 'none' } as const;

/**
 * Asked once, before anything connects: play with the Nulo wallet extension,
 * or with the wallet this site keeps in the browser.
 */
export function WalletChooser({ onChoose }: WalletChooserProps) {
  return (
    <div
      data-testid="wallet-chooser"
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(10, 18, 10, 0.95)', padding: 16,
      }}
    >
      <div className="parchment-dialog" style={{ maxWidth: 520, width: '100%', textAlign: 'center' }}>
        <div className="parchment-dialog__title" style={{ fontSize: 22 }}>Choose a Wallet</div>

        <p style={text}>Your cards belong to an Aztec account. Which wallet should hold it?</p>

        <div style={{ display: 'grid', gap: 12, margin: '18px 0 8px' }}>
          <button className="parchment-dialog__btn" data-testid="choose-nulo" style={option} onClick={() => onChoose('nulo')}>
            <span>Nulo</span>
            <span style={optionDetail}>
              The Nulo wallet extension. Your keys stay in Nulo, and you approve every transaction there.
            </span>
          </button>
          <button className="parchment-dialog__btn" data-testid="choose-embedded" style={option} onClick={() => onChoose('embedded')}>
            <span>In-browser wallet</span>
            <span style={optionDetail}>
              A wallet this site keeps in your browser. Nothing to install; you fund it from an Ethereum wallet.
            </span>
          </button>
        </div>

        <p style={{ ...text, fontSize: 12, opacity: 0.85 }}>
          No Nulo yet? Get it from <a href={NULO_URL} target="_blank" rel="noreferrer">nulo.sh</a>.
        </p>
      </div>
    </div>
  );
}
