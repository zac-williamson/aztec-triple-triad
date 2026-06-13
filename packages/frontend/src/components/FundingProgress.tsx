/**
 * Auto-onboarding progress screen (item I). Shown while the testnet faucet
 * funds the new account and the combined deploy+mint runs — replacing the
 * manual copy-address / bridge / "I've funded" round-trip with a zero-action
 * "Getting you set up…" screen. Driven purely by the connection status:
 *   'funding'   → requesting Fee Juice from the faucet
 *   'deploying' → deploy account + mint starter cards (one tx)
 * On 'connected' the app auto-continues to the menu; on faucet failure the
 * status flips to 'needs-funding' and FundingPrompt takes over (fallback).
 */
interface FundingProgressProps {
  status: 'funding' | 'deploying';
}

// Step 2 covers both the new-account mint and the returning-account restore
// (both land on 'deploying'), so the copy stays true for either.
const STEPS: { key: FundingProgressProps['status']; label: string }[] = [
  { key: 'funding', label: 'Requesting Fee Juice' },
  { key: 'deploying', label: 'Deploying account & loading your cards' },
];

export function FundingProgress({ status }: FundingProgressProps) {
  const activeIndex = STEPS.findIndex((s) => s.key === status);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(10, 18, 10, 0.95)',
      }}
    >
      <div className="parchment-dialog" style={{ maxWidth: 460, textAlign: 'center' }}>
        <div className="parchment-dialog__title" style={{ fontSize: 22 }}>
          Getting You Set Up
        </div>

        <p style={{ fontFamily: "'Cinzel', serif", fontSize: 14, color: '#5a4a34', margin: '16px 0 20px' }}>
          Preparing your Aztec account — no wallet, no gas, no copy-paste. This
          takes up to a minute on the first visit.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, textAlign: 'left', margin: '0 auto', maxWidth: 320 }}>
          {STEPS.map((step, i) => {
            const done = i < activeIndex;
            const active = i === activeIndex;
            return (
              <div key={step.key} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span
                  aria-hidden
                  style={{
                    flex: '0 0 auto',
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 13,
                    border: `1px solid ${done || active ? 'rgba(200, 168, 96, 0.8)' : 'rgba(120, 100, 70, 0.4)'}`,
                    background: done ? 'rgba(200, 168, 96, 0.25)' : 'transparent',
                    color: done || active ? '#c8a860' : '#8a7a64',
                  }}
                >
                  {done ? '✓' : active ? <span className="funding-progress__spinner" /> : i + 1}
                </span>
                <span
                  style={{
                    fontFamily: "'Cinzel', serif",
                    fontSize: 14,
                    color: active ? '#c8a860' : done ? '#5a4a34' : '#8a7a64',
                    fontWeight: active ? 700 : 400,
                  }}
                >
                  {step.label}
                  {active ? '…' : ''}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
