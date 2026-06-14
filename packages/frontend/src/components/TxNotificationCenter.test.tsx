/**
 * TxNotificationCenter — two regressions lane-8 hit on the multi-game post-pack
 * flow:
 *  (bug 1) the bottom-anchored toast (z-index 1400) swallowed clicks on the
 *          CardSelector "Play!" / settlement buttons beneath it, because the
 *          whole toast card was `pointer-events: auto`. The card must be
 *          pass-through; only its own controls capture clicks.
 *  (bug 2) a COMPLETED pack notification permanently showed the active-sounding
 *          "Preparing: X" summary chip (it only renders once the tx is done),
 *          so it read as stuck mid-prep forever. A finished tx must not say
 *          "Preparing".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TxNotificationCenter } from './TxNotificationCenter';
import { txProgress, type TxProgressEvent } from '../aztec/txProgress';

// ── bug 1: pointer-events policy (the toast must not intercept game clicks) ──

/** Map every selector → its declared `pointer-events` value (comments stripped,
 *  grouped selectors expanded, last declaration wins). */
function pointerEventsBySelector(css: string): Record<string, string> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const map: Record<string, string> = {};
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(stripped))) {
    const pe = m[2].match(/pointer-events\s*:\s*([a-z-]+)/);
    if (!pe) continue;
    for (const sel of m[1].split(',')) map[sel.trim()] = pe[1];
  }
  return map;
}

describe('TxNotificationCenter pointer-events policy (bug 1)', () => {
  // vitest runs with cwd = packages/frontend.
  const css = readFileSync(join(process.cwd(), 'src/components/TxNotificationCenter.css'), 'utf8');
  const pe = pointerEventsBySelector(css);

  it('the container and the toast CARD are pass-through (do not intercept clicks)', () => {
    expect(pe['.txnc-root']).toBe('none');
    expect(pe['.txnc-toast']).toBe('none');
  });

  it('only the toast controls capture pointer events', () => {
    expect(pe['.txnc-btn']).toBe('auto');
    expect(pe['.txnc-bar__seg']).toBe('auto');
    expect(pe['.txnc-collapse-btn']).toBe('auto');
  });

  it('does NOT blanket-enable pointer-events on every root child (the bug)', () => {
    // `.txnc-root > * { pointer-events: auto }` re-armed the whole card and
    // re-blocked the Play!/settlement clicks beneath it.
    expect(pe['.txnc-root > *']).toBeUndefined();
  });
});

// ── bug 2: a completed notification must leave "Preparing" ──

const completePackTx: TxProgressEvent = {
  txId: 'pack-tx-1',
  label: 'Purchase Card Pack',
  phase: 'complete',
  startTime: 1000,
  phaseStartTime: 2000,
  // A done tx has a recorded (non-live) Mining phase — this is exactly the
  // shape that used to render the persistent "Preparing: X" chip.
  phases: [
    { name: 'Simulation', duration: 8200, color: '#ce93d8' },
    { name: 'Mining', duration: 3100, color: '#4caf50' },
  ],
};

describe('TxNotificationCenter completion display (bug 2)', () => {
  beforeEach(() => localStorage.clear());

  it('a completed pack tx reads as Complete and does NOT stick showing "Preparing"', () => {
    render(<TxNotificationCenter account="0xTEST" />);
    act(() => { txProgress.emit(completePackTx); });

    // Header reflects the terminal state (getByText throws if absent).
    expect(screen.getByText('Complete')).toBeTruthy();
    // The client/chain breakdown still shows...
    expect(screen.getByText(/Client:/)).toBeTruthy();
    expect(screen.getByText(/Mining:/)).toBeTruthy();
    // ...but the completed notification no longer says "Preparing".
    expect(screen.queryByText(/Preparing/)).toBeNull();
  });
});
