/**
 * The relay as a pure pipe (docs/plan/PRIVATE_GAMES.md §6): what it may be
 * told, what it may say, and the checks that it learned nothing more.
 *
 * Since Phase B the clients run the game. The relay pairs players, forwards
 * sealed payloads, buffers them for whoever is offline and times turns; the
 * one game fact it reads is the move NUMBER. A run shows it stayed blind
 * three ways:
 *   1. every frame a browser sent it (tapped in PlayerDriver) carries exactly
 *      the fields §6.1 allows — no card id, hand, board, record, key or result
 *      — and its sealed fields do not open as plaintext;
 *   2. what it tells anyone about a room (GET /games/{id}) is what a pipe knows;
 *   3. its own log of the traffic carries only allowlisted fields.
 *
 * The allowlists are the plan's, written out here — not imported from the
 * relay or the frontend, which would agree with any bug of theirs.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { expect } from '@playwright/test';
import { BACKEND_URL } from './env.js';

/** One frame on a player's relay socket, as the harness keeps it. */
export interface RelayFrame {
  dir: 'sent' | 'received';
  at: number;
  /** The frame's fields; an opaque field's value is replaced by its size. */
  fields: Record<string, unknown>;
  /** The sealed fields (iv, ciphertext), and whether each one opens as readable text. */
  sealed: { field: string; length: number; plaintext: boolean }[];
}

/** A sealed payload: AES-GCM output, which must look like noise. */
const SEALED_FIELDS = ['iv', 'ciphertext'];
/** Kept out of the harness's own logs, but not sealed: a public key, the session token. */
const REDACTED_FIELDS = ['publicKey', 'sessionToken'];

/**
 * Client → relay, Phase B (§6.1): every message a browser may send, and the
 * fields it carries besides `type`. Nothing names a card: QUEUE_MATCHMAKING
 * has no hand, and a MOVE is a number around a ciphertext.
 */
export const CLIENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  QUEUE_MATCHMAKING: [],
  CANCEL_MATCHMAKING: [],
  PING: [],
  RESUME: ['sessionToken'],
  KEY_EXCHANGE: ['gameId', 'publicKey'],
  PEER: ['gameId', 'iv', 'ciphertext'],
  MOVE: ['gameId', 'moveNumber', 'iv', 'ciphertext'],
  TX_CONFIRMED: ['gameId', 'txType'],
  TX_FAILED: ['gameId', 'txType', 'error'],
  LEAVE_GAME: ['gameId'],
};

/**
 * Relay → client. No board, hand, card or result: Phase A's GAME_STATE,
 * GAME_OVER and MOVE_PROVEN are gone, because the relay has none of them.
 */
export const SERVER_FIELDS: Readonly<Record<string, readonly string[]>> = {
  SESSION_ESTABLISHED: ['sessionToken', 'playerId', 'resumed', 'gameId'],
  MATCHMAKING_QUEUED: ['position'],
  MATCHMAKING_CANCELLED: [],
  MATCH_FOUND: ['gameId', 'playerNumber'],
  PONG: [],
  ERROR: ['message'],
  OPPONENT_KEY: ['gameId', 'publicKey'],
  PEER: ['gameId', 'iv', 'ciphertext'],
  MOVE: ['gameId', 'moveNumber', 'iv', 'ciphertext'],
  ROOM_STATE: ['gameId', 'playerNumber', 'movesMade', 'opponentConnected'],
  ON_CHAIN_STATUS: ['gameId', 'status'],
  GAME_ABANDONMENT_WARNING: ['gameId', 'idlePlayer', 'secondsIdle', 'secondsUntilClaimable'],
  OPPONENT_DISCONNECTED: ['gameId'],
  OPPONENT_RECONNECTED: ['gameId'],
};

/** GET /games/{id}: a room as a pipe sees it. */
export const ROOM_FIELDS = ['id', 'status', 'movesMade', 'player1Connected', 'player2Connected'];

/** The fields the relay's per-message log line may carry (backend server.ts `logMsg`). */
export const RELAY_LOG_FIELDS = ['type', 'gameId', 'moveNumber', 'playerNumber', 'movesMade', 'message', 'resumed'];

const RELAY = new URL(BACKEND_URL);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function portOf(u: URL): string {
  return u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? '443' : '80');
}

/** Whether a page's WebSocket goes to the relay (and not, say, vite's HMR socket). */
export function isRelaySocket(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (portOf(u) !== portOf(RELAY)) return false;
  return u.hostname === RELAY.hostname || (LOOPBACK.has(u.hostname) && LOOPBACK.has(RELAY.hostname));
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** What a MOVE, OPEN_CARDS or RECORD body would show if it travelled unsealed. */
const PLAINTEXT_MARKERS = /"(cardId|cards|slot|proof|publicInputs|record|txHash|prizeMove|kind)"/;

/**
 * Whether an opaque field gives anything away: not base64 at all, or base64
 * of a readable payload. AES-GCM output is noise; a forgotten seal is JSON.
 */
function readable(value: string): boolean {
  if (!BASE64.test(value)) return true;
  return PLAINTEXT_MARKERS.test(Buffer.from(value, 'base64').toString('latin1'));
}

/** Summarize one relay frame as it crosses the socket. */
export function summarizeFrame(dir: RelayFrame['dir'], payload: string | Buffer): RelayFrame {
  const at = Date.now();
  const text = typeof payload === 'string' ? payload : payload.toString('utf-8');
  let msg: unknown;
  try { msg = JSON.parse(text); } catch { msg = null; }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { dir, at, fields: { unparsed: text.slice(0, 200) }, sealed: [] };
  }
  const fields: Record<string, unknown> = {};
  const sealed: RelayFrame['sealed'] = [];
  for (const [key, value] of Object.entries(msg)) {
    const isSealed = SEALED_FIELDS.includes(key);
    if (!isSealed && !REDACTED_FIELDS.includes(key)) { fields[key] = value; continue; }
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    if (isSealed) sealed.push({ field: key, length: s.length, plaintext: readable(s) });
    fields[key] = `<${s.length} chars>`;
  }
  return { dir, at, fields, sealed };
}

/** A player's view of the relay: its frames since `mark`, and its seat in the game. */
export interface RelaySeat {
  driver: { name: string; relayFramesSince(mark: number): RelayFrame[] };
  seat: 1 | 2;
  mark: number;
}

/**
 * What the relay received from — and said to — these players since their
 * marks: only §6.1 messages with exactly their fields, no opaque field that
 * opens as text, no relay ERROR, and for `wsGameId` exactly the MOVEs
 * 0..moves-1, each once, each from the seat whose turn it was.
 */
export function expectRelayBlind(seats: RelaySeat[], wsGameId: string, moves: number, label: string): void {
  const moveNumbers: number[] = [];
  for (const { driver, seat, mark } of seats) {
    for (const frame of driver.relayFramesSince(mark)) {
      const where = `${label}: ${driver.name} ${frame.dir === 'sent' ? '→ relay' : '← relay'} ${JSON.stringify(frame.fields)}`;
      const allowed = frame.dir === 'sent' ? CLIENT_FIELDS : SERVER_FIELDS;
      const type = String(frame.fields.type);
      expect(Object.keys(allowed), `${where}: not a message of the Phase B relay protocol`).toContain(type);
      expect(Object.keys(frame.fields).sort(), `${where}: carries fields beyond §6.1's`)
        .toEqual(['type', ...allowed[type]].sort());
      for (const s of frame.sealed) {
        expect(s.plaintext, `${where}: '${s.field}' opens as plaintext — it was not sealed`).toBe(false);
      }
      expect(type, `${where}: the relay refused a message`).not.toBe('ERROR');
      if (frame.dir === 'sent' && type === 'MOVE' && frame.fields.gameId === wsGameId) {
        const n = Number(frame.fields.moveNumber);
        expect(n % 2 === 0 ? 1 : 2, `${where}: move ${n} is not seat ${seat}'s to send`).toBe(seat);
        moveNumbers.push(n);
      }
    }
  }
  expect(moveNumbers.sort((a, b) => a - b), `${label}: the relay got each move once, numbered 0..${moves - 1}`)
    .toEqual(Array.from({ length: moves }, (_, i) => i));
}

/** GET /games/{id}, or null once the relay has dropped the room. */
export async function relayRoom(wsGameId: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${BACKEND_URL}/games/${wsGameId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /games/${wsGameId}: HTTP ${res.status}`);
  return await res.json() as Record<string, unknown>;
}

/** The relay's room, as REST shows it: only what a pipe knows, and the move count it saw. */
export function expectRoomIsPipe(
  room: Record<string, unknown> | null,
  wsGameId: string,
  want: { status: 'waiting' | 'active' | 'moves-complete'; movesMade: number },
  label: string,
): void {
  expect(room, `${label}: the relay still holds room ${wsGameId}`).not.toBeNull();
  expect(Object.keys(room!).sort(), `${label}: GET /games/{id} says more than a pipe knows`)
    .toEqual([...ROOM_FIELDS].sort());
  expect({ id: room!.id, status: room!.status, movesMade: room!.movesMade }, `${label}: the relay's room`)
    .toEqual({ id: wsGameId, ...want });
}

interface RelayLogLine {
  dir: 'IN' | 'OUT';
  summary: Record<string, unknown>;
}

function relayLogLines(logsDir: string): RelayLogLine[] {
  const out: RelayLogLine[] = [];
  for (const line of readFileSync(resolve(logsDir, 'backend.log'), 'utf-8').split('\n')) {
    const m = line.match(/^\[WS (IN|OUT)\] player=\S+\s+(\{.*\})\s*$/);
    if (m) out.push({ dir: m[1] as 'IN' | 'OUT', summary: JSON.parse(m[2]) as Record<string, unknown> });
  }
  return out;
}

/**
 * The relay's own record of the traffic (backend.log): every line carries
 * only allowlisted fields of a Phase B message, and for `wsGameId` it logged
 * the MOVEs 0..moves-1 — numbers, and nothing about what was played.
 */
export function expectRelayLogBlind(logsDir: string, wsGameId: string, moves: number, label: string): void {
  const lines = relayLogLines(logsDir);
  const tag = `${wsGameId.slice(0, 12)}...`;
  expect(lines.some(l => l.summary.gameId === tag), `${label}: the relay log never mentions room ${tag}`).toBe(true);
  for (const { dir, summary } of lines) {
    const where = `${label}: relay log [WS ${dir}] ${JSON.stringify(summary)}`;
    expect(Object.keys(summary).filter(k => !RELAY_LOG_FIELDS.includes(k)), `${where}: fields beyond the log's allowlist`)
      .toEqual([]);
    expect(Object.keys(dir === 'IN' ? CLIENT_FIELDS : SERVER_FIELDS), `${where}: not a Phase B message`)
      .toContain(String(summary.type));
  }
  const logged = lines
    .filter(l => l.dir === 'IN' && l.summary.type === 'MOVE' && l.summary.gameId === tag)
    .map(l => Number(l.summary.moveNumber));
  expect(logged, `${label}: the relay logged the moves 0..${moves - 1}, in order`)
    .toEqual(Array.from({ length: moves }, (_, i) => i));
}
