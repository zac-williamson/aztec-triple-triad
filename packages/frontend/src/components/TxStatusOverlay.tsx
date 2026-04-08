import { useTxStatus } from '../hooks/useTxStatus';
import txManager, { type TxPhase } from '../aztec/txManager';
import './TxStatusOverlay.css';

const PHASE_LABELS: Record<TxPhase, string> = {
  queued: 'Queued',
  simulating: 'Simulating...',
  proving: 'Generating proof...',
  sending: 'Sending transaction...',
  post_effects: 'Processing...',
  completed: 'Confirmed',
  error: 'Failed',
};

export function TxStatusOverlay() {
  const entries = useTxStatus();

  const visible = entries.filter((e) => {
    if (e.phase === 'completed') return Date.now() - e.updatedAt < 5000;
    if (e.phase === 'error') return true;
    return true;
  });

  if (visible.length === 0) return null;

  return (
    <div className="tx-overlay">
      {visible.map((entry) => (
        <div key={entry.id} className={`tx-toast tx-toast--${entry.phase}`}>
          <div className="tx-toast__icon">
            {entry.phase === 'completed'
              ? '\u2713'
              : entry.phase === 'error'
                ? '\u2717'
                : null}
          </div>
          <div className="tx-toast__body">
            <div className="tx-toast__label">{entry.label}</div>
            <div className="tx-toast__phase">{PHASE_LABELS[entry.phase]}</div>
            {entry.error && <div className="tx-toast__error">{entry.error}</div>}
          </div>
          {entry.phase === 'error' && (
            <button
              className="tx-toast__dismiss"
              onClick={() => txManager.dismissError(entry.id)}
            >
              \u00d7
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
