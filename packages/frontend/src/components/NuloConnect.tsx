import type { NuloUiStep } from '../hooks/useAztec';

const NULO_URL = 'https://nulo.sh';

interface NuloConnectProps {
  step: NuloUiStep | null;
  /** Set when the connection failed. */
  error: string | null;
  onAnswerEmojis: (match: boolean) => void;
  onCancel: () => void;
  onRetry: () => void;
  onUseInBrowser: () => void;
}

const text = { fontFamily: "'Cinzel', serif", fontSize: 14, color: '#5a4a34', margin: '12px 0' } as const;
const note = { ...text, fontSize: 12, opacity: 0.85 } as const;

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      data-testid="nulo-connect"
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(10, 18, 10, 0.95)', padding: 16,
      }}
    >
      <div className="parchment-dialog" style={{ maxWidth: 520, width: '100%', textAlign: 'center' }}>
        <div className="parchment-dialog__title" style={{ fontSize: 22 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

/** Walks the player through connecting Nulo: allow, compare emojis, grant, claim. */
export function NuloConnect({ step, error, onAnswerEmojis, onCancel, onRetry, onUseInBrowser }: NuloConnectProps) {
  if (error) {
    return (
      <Frame title="Nulo Did Not Connect">
        <p style={text} data-testid="nulo-error">{error}</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', margin: '16px 0 8px' }}>
          <button className="parchment-dialog__btn" data-testid="nulo-retry" onClick={onRetry}>Try again</button>
          <button className="parchment-dialog__btn" data-testid="nulo-use-in-browser" onClick={onUseInBrowser}>
            Use the in-browser wallet
          </button>
        </div>
        <p style={note}>No Nulo yet? Get it from <a href={NULO_URL} target="_blank" rel="noreferrer">nulo.sh</a>.</p>
      </Frame>
    );
  }

  switch (step?.step) {
    case 'verifying':
      return (
        <Frame title="Check the Emojis">
          <p style={text}>Nulo is showing a grid of emojis. Do they match these, in the same order?</p>
          <div
            data-testid="nulo-emojis"
            aria-label="Verification emojis"
            style={{
              display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8,
              maxWidth: 220, margin: '16px auto', fontSize: 34, lineHeight: 1.2,
            }}
          >
            {step.emojis.map((emoji, i) => <span key={i}>{emoji}</span>)}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', margin: '16px 0 8px' }}>
            <button className="parchment-dialog__btn" data-testid="nulo-emojis-match" onClick={() => onAnswerEmojis(true)}>
              They match
            </button>
            <button className="parchment-dialog__btn" data-testid="nulo-emojis-differ" onClick={() => onAnswerEmojis(false)}>
              They don't match
            </button>
          </div>
          <p style={note}>
            If they differ, something may be sitting between this page and Nulo, so the connection is refused.
          </p>
        </Frame>
      );

    case 'permissions':
      return (
        <Frame title="Approve in Nulo">
          <p style={text}>
            Nulo is asking whether Axolotl Arena may use an account and the game's contracts. Allow it, and pick the
            account you want to play with.
          </p>
          <CancelButton onCancel={onCancel} />
        </Frame>
      );

    case 'setting-up':
      return (
        <Frame title="Setting Up">
          <p style={text}>Getting your account ready: registering the game's contracts with Nulo and loading your cards.</p>
        </Frame>
      );

    case 'claiming':
      return (
        <Frame title="Approve in Nulo">
          <p style={text}>
            This account has no cards yet. Approve the starter-card claim in Nulo: it gives the account its first five
            cards and 100 Arena Tokens.
          </p>
        </Frame>
      );

    default:
      return (
        <Frame title="Connect Nulo">
          <p style={text}>
            Open Nulo and allow Axolotl Arena to connect. If Nulo is locked, unlock it first.
          </p>
          <CancelButton onCancel={onCancel} />
          <p style={note}>No Nulo yet? Get it from <a href={NULO_URL} target="_blank" rel="noreferrer">nulo.sh</a>.</p>
        </Frame>
      );
  }
}

function CancelButton({ onCancel }: { onCancel: () => void }) {
  return (
    <div style={{ margin: '16px 0 8px' }}>
      <button className="parchment-dialog__btn" data-testid="nulo-cancel" onClick={onCancel}>Cancel</button>
    </div>
  );
}
