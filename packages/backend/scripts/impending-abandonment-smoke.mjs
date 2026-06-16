/**
 * Impending-abandonment smoke — reliable, self-contained, no network/accounts.
 *
 * Spins up the REAL relay (createServer, in-memory store) over loopback with the
 * production abandonment code and tuned-fast timing, then drives the ws protocol
 * (CREATE -> JOIN -> PLACE -> idle) and asserts the IMPENDING-abandonment
 * behaviour end-to-end at the relay protocol level:
 *   - BOTH players are warned BEFORE the deadline (impending), with a live
 *     secondsUntilClaimable countdown that is > 0 (not yet claimable);
 *   - the countdown reaches 0 at the deadline (claimable);
 *   - idlePlayer is the player who owes the move, and idlePlayerCardIds carries
 *     the abandoner's hand to the claimant.
 *
 * This runs against a local in-process server (identical code to the deployed
 * box relay) so it never depends on remote networking — the remote ws connect is
 * what was flaky, not the relay or this logic. Run: `node scripts/impending-abandonment-smoke.mjs`
 * from packages/backend (after `npm run build`). Exit 0 = PASS, 1 = FAIL.
 */
import WebSocket from 'ws';
import { createServer } from '../dist/server.js';

const DEADLINE_MS = 12_000; // abandonment deadline
const LEAD_MS = 10_000;     // warn 10s before it -> first warning at ~2s idle
const PORT = 5599;
const P1 = [1, 2, 3, 4, 5];
const P2 = [6, 7, 8, 9, 10];

const send = (c, o) => c.ws.send(JSON.stringify(o));
function connect(name, t0) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const c = { name, ws, playerId: null, msgs: [], warnings: [], opened: false, openErr: null };
  // Record open/error at creation: 'open' is a one-shot event and may fire
  // before waitOpen() attaches its listener (both sockets are created upfront).
  ws.on('open', () => { c.opened = true; });
  ws.on('error', (e) => { c.openErr = c.openErr || e; });
  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    c.msgs.push(m);
    if (m.type === 'SESSION_ESTABLISHED') c.playerId = m.playerId;
    if (m.type === 'ERROR') console.log(`[${name}] ERROR: ${m.message}`);
    if (m.type === 'GAME_ABANDONMENT_WARNING') {
      const at = ((Date.now() - t0.v) / 1000).toFixed(1);
      c.warnings.push({ at, secondsIdle: m.secondsIdle, secondsUntilClaimable: m.secondsUntilClaimable, idlePlayer: m.idlePlayer, idlePlayerCardIds: m.idlePlayerCardIds });
      console.log(`[${name}] +${at}s  secondsIdle=${m.secondsIdle}  secondsUntilClaimable=${m.secondsUntilClaimable}  idlePlayer=${m.idlePlayer}  idleCards=${JSON.stringify(m.idlePlayerCardIds)}`);
    }
  });
  return c;
}
const waitOpen = (c) => new Promise((res, rej) => {
  if (c.opened) return res();            // already opened before we got here
  if (c.openErr) return rej(c.openErr);
  const to = setTimeout(() => rej(new Error(`${c.name}: connect timeout`)), 5000);
  c.ws.on('open', () => { clearTimeout(to); res(); });
  c.ws.on('error', (e) => { clearTimeout(to); rej(e); });
});
function waitFor(c, type, ms = 5000) {
  return new Promise((resolve, reject) => {
    const hit = () => c.msgs.find((m) => m.type === type);
    if (hit()) return resolve(hit());
    const t = setInterval(() => { const f = hit(); if (f) { clearInterval(t); clearTimeout(to); resolve(f); } }, 40);
    const to = setTimeout(() => { clearInterval(t); reject(new Error(`${c.name}: timeout waiting for ${type}`)); }, ms);
  });
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const srv = createServer({
  port: PORT, sessionHandshakeMs: 50,
  moveInactivityMs: DEADLINE_MS, abandonmentWarnLeadMs: LEAD_MS, abandonmentCheckIntervalMs: 250,
});
setTimeout(() => { console.error('HARD TIMEOUT — exiting'); process.exit(2); }, 30_000);

(async () => {
  await new Promise((r) => srv.httpServer.listen(PORT, r));
  const t0 = { v: Date.now() };
  const A = connect('A/p1', t0); const B = connect('B/p2', t0);
  await waitOpen(A); await waitFor(A, 'SESSION_ESTABLISHED');
  await waitOpen(B); await waitFor(B, 'SESSION_ESTABLISHED');

  send(A, { type: 'CREATE_GAME', cardIds: P1 });
  const gameId = (await waitFor(A, 'GAME_CREATED')).gameId;
  send(B, { type: 'JOIN_GAME', gameId, cardIds: P2 });
  await waitFor(B, 'GAME_JOINED'); await waitFor(A, 'GAME_START');
  send(A, { type: 'PLACE_CARD', gameId, handIndex: 0, row: 0, col: 0, moveNumber: 0 });
  await waitFor(A, 'GAME_STATE'); await waitFor(B, 'GAME_STATE');
  t0.v = Date.now(); // start the idle clock at the move
  console.log(`deadline=${DEADLINE_MS / 1000}s lead=${LEAD_MS / 1000}s -> warn at ~${(DEADLINE_MS - LEAD_MS) / 1000}s. A(p1) placed; B(p2) owes a move. Idling...\n`);

  await new Promise((resolve) => {
    const iv = setInterval(() => {
      const claimable = [...A.warnings, ...B.warnings].some(w => w.secondsUntilClaimable === 0);
      if (claimable || (Date.now() - t0.v) / 1000 > 20) { clearInterval(iv); resolve(); }
    }, 200);
  });

  const all = [...A.warnings, ...B.warnings].sort((x, y) => x.at - y.at);
  const first = all[0];
  const claimable = all.find(w => w.secondsUntilClaimable === 0);
  const bothWarned = A.warnings.length > 0 && B.warnings.length > 0;
  const impending = !!first && first.secondsUntilClaimable > 0 && first.secondsIdle < DEADLINE_MS / 1000;
  const correctIdle = !!first && first.idlePlayer === 'player2' && eq(first.idlePlayerCardIds, P2);

  console.log('\n=== RESULT ===');
  console.log(`both players warned:          ${bothWarned}`);
  console.log(`first warning IMPENDING:      ${impending}` + (first ? ` (secondsIdle=${first.secondsIdle}, secondsUntilClaimable=${first.secondsUntilClaimable})` : ' (NO warning)'));
  console.log(`countdown reached 0:          ${!!claimable}` + (claimable ? ` (at +${claimable.at}s)` : ''));
  console.log(`idlePlayer + hand relayed:    ${correctIdle}` + (first ? ` (idlePlayer=${first.idlePlayer}, idleCards=${JSON.stringify(first.idlePlayerCardIds)})` : ''));
  const pass = bothWarned && impending && !!claimable && correctIdle;
  console.log(pass ? '\nIMPENDING-ABANDONMENT SMOKE: PASS' : '\nIMPENDING-ABANDONMENT SMOKE: FAIL');

  A.ws.close(); B.ws.close();
  await srv.close();
  process.exit(pass ? 0 : 1);
})().catch(async (e) => { console.error('SMOKE ERROR:', e.message); try { await srv.close(); } catch {} process.exit(1); });
