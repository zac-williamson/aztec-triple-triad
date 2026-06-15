/**
 * Onboarding progress screen shown while the combined deploy+mint tx runs
 * (status === 'deploying'). This covers both the new-account deploy + starter
 * mint and the returning-account restore (both land on 'deploying'). On
 * 'connected' the app auto-continues to the menu.
 */
interface FundingProgressProps {
  status: 'deploying';
}

const STEPS: { key: FundingProgressProps['status']; label: string }[] = [
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
          Preparing your Aztec account. This takes up to a minute on the first
          visit.
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
