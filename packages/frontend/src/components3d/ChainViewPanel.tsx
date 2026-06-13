import { useEffect, useState } from 'react';
import type { Card, HandProofData, MoveProofData } from '../types';
import { txProgress, type TxProgressEvent } from '../aztec/txProgress';
import { TOTAL_MOVES } from '../aztec/gameConstants';
import './ChainViewPanel.css';

/** Everything the panel shows that comes from the game hooks. */
export interface ChainViewData {
  onChainGameId: string | null;
  myHandProof: HandProofData | null;
  opponentHandProof: HandProofData | null;
  moveProofs: MoveProofData[];
  settleTxHash: string | null;
}

interface ChainViewPanelProps {
  data: ChainViewData;
  /** Cards currently in the player's hand (what only they can see). */
  myHand: Card[];
  /** How many cards the opponent still holds (all the player can see of them). */
  opponentHandCount: number;
  onClose: () => void;
}

export function truncateHash(hash: string, head = 10, tail = 6): string {
  if (hash.length <= head + tail + 1) return hash;
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  return `${(ms / 1000).toFixed(1)}s`;
}

function HashValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="chain-view__hash"
      title={`${label}: ${value} (click to copy)`}
      onClick={() => {
        navigator.clipboard?.writeText(value).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? 'copied' : truncateHash(value)}
    </button>
  );
}

function ProofRow({ label, done, duration, detail }: {
  label: string;
  done: boolean;
  duration?: number;
  detail?: string;
}) {
  return (
    <div className={`chain-view__proof-row ${done ? 'chain-view__proof-row--done' : ''}`}>
      <span className="chain-view__proof-dot">{done ? '◆' : '◇'}</span>
      <span className="chain-view__proof-label">{label}</span>
      {detail && <span className="chain-view__proof-detail">{detail}</span>}
      <span className="chain-view__proof-time">{done ? formatDuration(duration) : 'pending'}</span>
    </div>
  );
}

/**
 * "You see / chain sees" — the privacy demo panel. Left: the full hand only
 * this client knows. Right: the only things that ever reach the chain —
 * commitment hashes, a proof transcript, and one settlement transaction.
 */
export function ChainViewPanel({ data, myHand, opponentHandCount, onClose }: ChainViewPanelProps) {
  const { onChainGameId, myHandProof, opponentHandProof, moveProofs, settleTxHash } = data;

  // Live tx activity (create/join/settle) from the instrumented wallet.
  const [txEvents, setTxEvents] = useState<Map<string, TxProgressEvent>>(new Map());
  useEffect(() => {
    return txProgress.subscribe((event) => {
      setTxEvents(prev => {
        const next = new Map(prev);
        next.set(event.txId, event);
        return next;
      });
    });
  }, []);

  const proofsDone = (myHandProof ? 1 : 0) + (opponentHandProof ? 1 : 0) + Math.min(moveProofs.length, TOTAL_MOVES);
  const totalProofs = TOTAL_MOVES + 2;

  const liveTxs = [...txEvents.values()]
    .sort((a, b) => b.startTime - a.startTime)
    .slice(0, 3);

  return (
    <div className="chain-view" data-testid="chain-view-panel">
      <div className="chain-view__header">
        <div>
          <div className="chain-view__title">Chain View</div>
          <div className="chain-view__subtitle">what the blockchain can — and cannot — see</div>
        </div>
        <button className="chain-view__close" onClick={onClose} aria-label="Close chain view">✕</button>
      </div>

      <div className="chain-view__columns">
        <section className="chain-view__col chain-view__col--you">
          <h3 className="chain-view__col-title">You see</h3>
          <div className="chain-view__col-caption">full card data — never leaves this device</div>
          <ul className="chain-view__hand">
            {myHand.map(card => (
              <li key={card.id} className="chain-view__card">
                <span className="chain-view__card-id">#{card.id}</span> {card.name}
              </li>
            ))}
            {myHand.length === 0 && <li className="chain-view__card chain-view__card--empty">all cards played</li>}
          </ul>
          <div className="chain-view__opp-hand">
            Opponent&rsquo;s hand: {'▮'.repeat(Math.max(opponentHandCount, 0))}
            <span className="chain-view__muted"> {opponentHandCount} hidden card{opponentHandCount === 1 ? '' : 's'}</span>
          </div>
        </section>

        <section className="chain-view__col chain-view__col--chain">
          <h3 className="chain-view__col-title">Chain sees</h3>
          <div className="chain-view__col-caption">commitments only — hands stay private</div>
          <dl className="chain-view__facts">
            <dt>game id</dt>
            <dd>{onChainGameId ? <HashValue value={onChainGameId} label="On-chain game id" /> : <span className="chain-view__muted">not created yet</span>}</dd>
            <dt>your hand commitment</dt>
            <dd>{myHandProof ? <HashValue value={myHandProof.cardCommit} label="Your card_commit" /> : <span className="chain-view__muted">proving…</span>}</dd>
            <dt>their hand commitment</dt>
            <dd>{opponentHandProof ? <HashValue value={opponentHandProof.cardCommit} label="Opponent card_commit" /> : <span className="chain-view__muted">waiting…</span>}</dd>
          </dl>
        </section>
      </div>

      <section className="chain-view__section">
        <h3 className="chain-view__section-title">
          Proof transcript
          <span className="chain-view__counter">{proofsDone}/{totalProofs}</span>
        </h3>
        <div className="chain-view__proofs">
          <ProofRow label="Hand proof — you" done={!!myHandProof} duration={myHandProof?.durationMs} />
          <ProofRow label="Hand proof — opponent" done={!!opponentHandProof} duration={opponentHandProof?.durationMs} />
          {Array.from({ length: TOTAL_MOVES }, (_, i) => {
            const proof = moveProofs[i];
            return (
              <ProofRow
                key={i}
                label={`Move proof ${i + 1}`}
                done={!!proof}
                duration={proof?.durationMs}
                detail={proof ? `→ ${truncateHash(proof.endStateHash, 6, 4)}` : undefined}
              />
            );
          })}
        </div>
      </section>

      <section className="chain-view__section">
        <h3 className="chain-view__section-title">Settlement</h3>
        <p className="chain-view__explainer">
          All {totalProofs} proofs are verified <em>recursively inside one private
          function</em> — the chain learns who won and which card changed hands,
          never the moves or the hands themselves.
        </p>
        {liveTxs.map(tx => (
          <div key={tx.txId} className="chain-view__tx" data-testid="chain-view-tx">
            <span className="chain-view__tx-label">{tx.label}</span>
            <span className={`chain-view__tx-phase chain-view__tx-phase--${tx.phase}`}>{tx.phase}</span>
            <span className="chain-view__tx-timing">
              {tx.phases.map(p => `${p.name} ${formatDuration(p.duration)}`).join(' · ')}
            </span>
          </div>
        ))}
        {settleTxHash && (
          <div className="chain-view__settle-hash">
            settled in tx <HashValue value={settleTxHash} label="Settlement tx hash" />
          </div>
        )}
      </section>
    </div>
  );
}
