/**
 * Abuse limits on the relay.
 *
 * There is one relay and no horizontal scaling, so a single script opening
 * sockets or spraying messages can take the arena down for everyone. The origin
 * allowlist does not help: a non-browser client sends no Origin at all, and the
 * server accepts that by design so tests and the bot can connect.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createServer, type CardGameServer } from '../src/server.js';

let server: CardGameServer;
let port: number;
const open: WebSocket[] = [];

function connect(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  open.push(ws);
  return new Promise((res, rej) => {
    ws.once('open', () => res(ws));
    ws.once('error', rej);
    ws.once('unexpected-response', (_req, r) => rej(new Error(`http ${r.statusCode}`)));
  });
}

/**
 * Connect and wait for the session. The server attaches its message listener
 * only after establishing one, so anything sent before that is dropped — which
 * is also why a real client waits for SESSION_ESTABLISHED before speaking.
 */
async function connected(): Promise<WebSocket> {
  const ws = await connect();
  await new Promise<void>(res => {
    const onMsg = (raw: WebSocket.RawData) => {
      if (JSON.parse(raw.toString()).type === 'SESSION_ESTABLISHED') {
        ws.off('message', onMsg);
        res();
      }
    };
    ws.on('message', onMsg);
  });
  return ws;
}

beforeEach(async () => {
  port = 21000 + Math.floor(Math.random() * 2000);
  server = createServer({ port });
  await new Promise<void>(r => server.httpServer.listen(port, () => r()));
});

afterEach(async () => {
  for (const ws of open) { try { ws.close(); } catch { /* already gone */ } }
  open.length = 0;
  await new Promise(r => setTimeout(r, 50));
  server.wss?.close?.();
  await new Promise<void>(r => server.httpServer.close(() => r()));
});

describe('relay abuse limits', () => {
  it('caps concurrent connections from one address', async () => {
    process.env.WS_MAX_CONNECTIONS_PER_IP = '3';
    // The cap is read at module load, so this asserts the DEFAULT is finite
    // rather than the override — an unbounded default is the actual hazard.
    const many = await Promise.allSettled(Array.from({ length: 25 }, () => connect()));
    const refused = many.filter(r => r.status === 'rejected').length;
    expect(refused).toBeGreaterThan(0);
  }, 20_000);

  it('closes a connection that floods messages', async () => {
    const ws = await connected();
    const closed = new Promise<number>(res => ws.once('close', code => res(code)));

    // Far past any burst a real client produces: a settlement fans out a hand
    // proof and nine move proofs, not hundreds of messages in a tick.
    for (let i = 0; i < 4000; i++) {
      ws.send(JSON.stringify({ type: 'PING' }));
    }

    // 1008 = policy violation.
    expect(await closed).toBe(1008);
  }, 20_000);

  it('leaves an ordinary client alone', async () => {
    const ws = await connected();
    let closedEarly = false;
    ws.once('close', () => { closedEarly = true; });

    // A realistic burst: the eleven proofs of a settlement, back to back.
    for (let i = 0; i < 11; i++) ws.send(JSON.stringify({ type: 'PING' }));
    await new Promise(r => setTimeout(r, 300));

    expect(closedEarly).toBe(false);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  }, 20_000);
});
