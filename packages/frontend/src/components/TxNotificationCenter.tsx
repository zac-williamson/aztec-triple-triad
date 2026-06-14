/**
 * TxNotificationCenter
 * Bottom-right toast panel showing live transaction progress from
 * InstrumentedWallet. Faithful port of gregojuice's component,
 * rewritten in plain React + CSS (no Material UI).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { txProgress, type TxProgressEvent, type PhaseTiming } from '../aztec/txProgress';
import './TxNotificationCenter.css';

interface LivePhaseTiming extends PhaseTiming {
  isLive?: boolean;
}

const ACTIVE_PHASE_COLORS: Record<string, string> = {
  simulating: '#ce93d8',
  proving: '#f48fb1',
  sending: '#2196f3',
  mining: '#4caf50',
};

const PHASE_LABELS: Record<string, string> = {
  simulating: 'Simulating',
  proving: 'Proving',
  sending: 'Sending',
  mining: 'Waiting for confirmation',
  complete: 'Complete',
  error: 'Failed',
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
};

const formatDurationLong = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)} milliseconds`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} seconds`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
};

// ─── PhaseTimelineBar ────────────────────────────────────────────────────────

function PhaseTimelineBar({ phases }: { phases: LivePhaseTiming[] }) {
  const { completedPhases, livePhase } = useMemo(() => ({
    completedPhases: phases.filter(p => !p.isLive),
    livePhase: phases.find(p => p.isLive),
  }), [phases]);

  const completedDuration = useMemo(
    () => completedPhases.reduce((sum, p) => sum + p.duration, 0),
    [completedPhases],
  );
  const liveDuration = livePhase?.duration ?? 0;
  const totalDuration = completedDuration + liveDuration;
  const miningDuration = useMemo(
    () => completedPhases.filter(p => p.name === 'Mining').reduce((s, p) => s + p.duration, 0),
    [completedPhases],
  );

  if (phases.length === 0 || totalDuration === 0) return null;

  // Client-side work (simulate + prove + send) vs on-chain Mining. This summary
  // only renders once a completed Mining phase exists — i.e. the tx is DONE — so
  // it must read as a finished breakdown, not the present-continuous "Preparing"
  // (which made a completed pack notification look stuck mid-prep forever).
  const clientDuration = totalDuration - miningDuration;
  const hasMining = miningDuration > 0;
  const hasLive = !!livePhase;

  return (
    <div>
      {/* Summary chips */}
      <div className="txnc-chips">
        {hasMining ? (
          <>
            <span className="txnc-chip txnc-chip--client">Client: {formatDuration(clientDuration)}</span>
            <span className="txnc-chip txnc-chip--mining">Mining: {formatDuration(miningDuration)}</span>
            <span className="txnc-chip">Total: {formatDuration(totalDuration)}</span>
          </>
        ) : (
          <span className="txnc-chip">
            {hasLive ? `Elapsed: ${formatDuration(totalDuration)}` : `Total: ${formatDuration(totalDuration)}`}
          </span>
        )}
      </div>

      {/* Timeline bar */}
      <div className="txnc-bar">
        {completedPhases.map((phase) => {
          const percentage = (phase.duration / totalDuration) * 100;
          return (
            <TimelineSegment key={phase.name} phase={phase} percentage={percentage} />
          );
        })}
        {livePhase && (
          <LiveSegment phase={livePhase} />
        )}
      </div>

      {/* Legend */}
      <div className="txnc-legend">
        {phases.map((phase) => (
          <div className="txnc-legend__item" key={phase.name}>
            <span
              className={`txnc-legend__dot${phase.isLive ? ' txnc-legend__dot--live' : ''}`}
              style={{ background: phase.color }}
            />
            <span>{phase.name}{phase.isLive ? ' ●' : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TimelineSegment({ phase, percentage }: { phase: LivePhaseTiming; percentage: number }) {
  const [show, setShow] = useState(false);
  return (
    <div
      className="txnc-bar__seg"
      style={{
        width: `${percentage}%`,
        minWidth: percentage > 0 ? 2 : 0,
        background: phase.color,
      }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {show && (
        <div className="txnc-tooltip">
          <div className="txnc-tooltip__title">{phase.name}</div>
          <div className="txnc-tooltip__duration">
            {formatDurationLong(phase.duration)} ({percentage.toFixed(1)}%)
          </div>
          {phase.breakdown?.map((item, idx) => {
            const isChild = item.label.startsWith('  ');
            return (
              <span
                key={idx}
                className={`txnc-tooltip__row ${isChild ? 'txnc-tooltip__row--child' : 'txnc-tooltip__row--parent'}`}
              >
                {item.label.trimStart()}: {formatDuration(item.duration)}
              </span>
            );
          })}
          {phase.details?.map((line, idx) => (
            <span key={`d-${idx}`} className="txnc-tooltip__detail">{line}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function LiveSegment({ phase }: { phase: LivePhaseTiming }) {
  const [show, setShow] = useState(false);
  return (
    <div
      className="txnc-bar__seg txnc-bar__seg--live"
      style={{
        background: `linear-gradient(90deg, ${phase.color}88 0%, ${phase.color} 50%, ${phase.color}88 100%)`,
      }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {show && (
        <div className="txnc-tooltip">
          <div className="txnc-tooltip__title">{phase.name}</div>
          <div className="txnc-tooltip__duration">
            {formatDurationLong(phase.duration)} (in progress)
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Single Toast ────────────────────────────────────────────────────────────

function TxToast({ event, onDismiss }: { event: TxProgressEvent; onDismiss: () => void }) {
  const isActive = event.phase !== 'complete' && event.phase !== 'error';

  const computeFinalElapsed = () => {
    const fromPhases = event.phases.reduce((sum, p) => sum + p.duration, 0);
    return fromPhases > 0 ? fromPhases : Date.now() - event.startTime;
  };

  const [elapsed, setElapsed] = useState(() =>
    isActive ? Date.now() - event.startTime : computeFinalElapsed(),
  );
  const [phaseElapsed, setPhaseElapsed] = useState(() =>
    isActive ? Date.now() - event.phaseStartTime : 0,
  );
  const [expanded, setExpanded] = useState(true);
  const frozen = useRef(!isActive);

  useEffect(() => {
    if (!isActive) {
      if (!frozen.current) {
        frozen.current = true;
        setElapsed(computeFinalElapsed());
        setPhaseElapsed(0);
      }
      return;
    }
    frozen.current = false;
    const interval = setInterval(() => {
      setElapsed(Date.now() - event.startTime);
      setPhaseElapsed(Date.now() - event.phaseStartTime);
    }, 200);
    return () => clearInterval(interval);
  }, [isActive, event.startTime, event.phaseStartTime]);

  const prevTxIdRef = useRef(event.txId);
  useEffect(() => {
    if (event.txId !== prevTxIdRef.current) {
      prevTxIdRef.current = event.txId;
      setElapsed(isActive ? Date.now() - event.startTime : computeFinalElapsed());
      setPhaseElapsed(isActive ? Date.now() - event.phaseStartTime : 0);
      frozen.current = !isActive;
    }
  }, [event.txId]);

  const isComplete = event.phase === 'complete';
  const isError = event.phase === 'error';

  const displayPhases: LivePhaseTiming[] = useMemo(() => {
    if (!isActive) return event.phases;
    if (phaseElapsed <= 0 && event.phases.length === 0) return [];
    const liveColor = ACTIVE_PHASE_COLORS[event.phase] ?? '#90caf9';
    const liveName = PHASE_LABELS[event.phase] ?? event.phase;
    return [
      ...event.phases,
      { name: liveName, duration: phaseElapsed > 0 ? phaseElapsed : 100, color: liveColor, isLive: true },
    ];
  }, [isActive, event.phases, event.phase, phaseElapsed]);

  const toastClass =
    'txnc-toast' + (isError ? ' txnc-toast--error' : isComplete ? ' txnc-toast--complete' : '');

  return (
    <div className={toastClass}>
      <div className="txnc-header">
        {isComplete ? (
          <span className="txnc-status-icon txnc-status-icon--complete">✓</span>
        ) : isError ? (
          <span className="txnc-status-icon txnc-status-icon--error">✕</span>
        ) : (
          <span className="txnc-spinner" />
        )}

        <div className="txnc-label-col">
          <div className="txnc-label">{event.label}</div>
          <div className="txnc-phase-row">
            <span>{PHASE_LABELS[event.phase] ?? event.phase}</span>
            {isActive && (
              <span className="txnc-dots"><span /><span /><span /></span>
            )}
          </div>
        </div>

        <span className="txnc-elapsed">{formatDuration(elapsed)}</span>

        {displayPhases.length > 0 && (
          <button className="txnc-btn" onClick={() => setExpanded(p => !p)} aria-label={expanded ? 'Collapse' : 'Expand'}>
            <svg viewBox="0 0 24 24" fill="currentColor"><path d={expanded ? 'M7 14l5-5 5 5H7z' : 'M7 10l5 5 5-5H7z'} /></svg>
          </button>
        )}

        <button className="txnc-btn" onClick={onDismiss} aria-label="Dismiss">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
        </button>
      </div>

      {expanded && displayPhases.length > 0 && (
        <div className="txnc-body">
          <PhaseTimelineBar phases={displayPhases} />
          {isError && event.error && (
            <div className="txnc-error">
              {event.error.length > 200 ? event.error.slice(0, 200) + '...' : event.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Container ───────────────────────────────────────────────────────────────

export function TxNotificationCenter({ account }: { account?: string | null }) {
  const [toasts, setToasts] = useState<Map<string, TxProgressEvent>>(new Map());
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!account) return;
    txProgress.setAccount(account);
    const history = txProgress.loadHistory();
    if (history.length > 0) {
      setToasts(prev => {
        const next = new Map(prev);
        for (const e of history) {
          if (!next.has(e.txId)) next.set(e.txId, e);
        }
        return next;
      });
    }
  }, [account]);

  useEffect(() => {
    return txProgress.subscribe((event) => {
      setToasts(prev => {
        const next = new Map(prev);
        next.set(event.txId, event);
        return next;
      });
    });
  }, []);

  const dismiss = (txId: string) => {
    txProgress.dismissPersisted(txId);
    setToasts(prev => {
      const next = new Map(prev);
      next.delete(txId);
      return next;
    });
  };

  const toastList = Array.from(toasts.entries());
  if (toastList.length === 0) return null;

  const activeCount = toastList.filter(([, e]) => e.phase !== 'complete' && e.phase !== 'error').length;

  return (
    <div className="txnc-root">
      {!collapsed && toastList.map(([txId, event]) => (
        <TxToast key={txId} event={event} onDismiss={() => dismiss(txId)} />
      ))}
      <button
        className={`txnc-collapse-btn${activeCount > 0 ? ' txnc-collapse-btn--active' : ''}`}
        onClick={() => setCollapsed(p => !p)}
        title={collapsed ? 'Show notifications' : 'Hide notifications'}
      >
        {collapsed && (
          <span>{toastList.length} tx{toastList.length !== 1 ? 's' : ''}</span>
        )}
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d={collapsed ? 'M12 5.83 15.17 9l1.41-1.41L12 3 7.41 7.59 8.83 9zm0 12.34L8.83 15l-1.42 1.41L12 21l4.59-4.59L15.17 15z' : 'M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z'} />
        </svg>
      </button>
    </div>
  );
}
