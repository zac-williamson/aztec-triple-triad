import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { createServer, type CardGameServer } from '../../src/server.js';
import type { FaucetResult, FaucetService } from '../../src/faucet/types.js';

const ADDR_A = '0x' + 'a1'.repeat(32);

/** Records every call and returns a scripted result. */
class FakeFaucet implements FaucetService {
  calls: { l2Address: string; ip: string }[] = [];
  next: FaucetResult = { ok: true, claim: sampleClaim(), reused: false };
  async requestClaim(l2Address: string, ip: string): Promise<FaucetResult> {
    this.calls.push({ l2Address, ip });
    return this.next;
  }
}

function sampleClaim() {
  return {
    l2Address: ADDR_A,
    claimAmount: '1000000000',
    claimSecret: '0x' + '11'.repeat(32),
    claimSecretHash: '0x' + '22'.repeat(32),
    messageHash: '0x' + '33'.repeat(32),
    messageLeafIndex: '7',
  };
}

let server: CardGameServer;
let faucet: FakeFaucet;
let port: number;

function listen(s: CardGameServer, p: number): Promise<void> {
  return new Promise((resolve) => s.httpServer.listen(p, resolve));
}

interface HttpResponse { status: number; body: any; headers: http.IncomingHttpHeaders }

function httpRequest(
  method: string,
  path: string,
  opts: { body?: string; headers?: Record<string, string> } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: 'localhost', port, path, method, headers: opts.headers },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed: any = undefined;
          try { parsed = data ? JSON.parse(data) : undefined; } catch { parsed = data; }
          resolve({ status: res.statusCode!, body: parsed, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function postFaucet(body: string, headers: Record<string, string> = {}): Promise<HttpResponse> {
  return httpRequest('POST', '/faucet', { body, headers: { 'Content-Type': 'application/json', ...headers } });
}

beforeEach(async () => {
  port = 4200 + Math.floor(Math.random() * 600);
  faucet = new FakeFaucet();
  server = createServer({ port, faucet });
  await listen(server, port);
});

afterEach(async () => {
  await server.close();
});

describe('POST /faucet', () => {
  it('returns 200 with the claim on success', async () => {
    const res = await postFaucet(JSON.stringify({ l2Address: ADDR_A }));
    expect(res.status).toBe(200);
    expect(res.body.claim.l2Address).toBe(ADDR_A);
    expect(res.body.reused).toBe(false);
    expect(faucet.calls).toHaveLength(1);
    expect(faucet.calls[0].l2Address).toBe(ADDR_A);
  });

  it('forwards the client IP from X-Forwarded-For (behind nginx)', async () => {
    await postFaucet(JSON.stringify({ l2Address: ADDR_A }), { 'X-Forwarded-For': '9.9.9.9, 10.0.0.1' });
    expect(faucet.calls[0].ip).toBe('9.9.9.9');
  });

  it('falls back to the socket address when X-Forwarded-For is absent', async () => {
    await postFaucet(JSON.stringify({ l2Address: ADDR_A }));
    expect(faucet.calls[0].ip).toBeTruthy();
  });

  it('maps a 400 result to HTTP 400', async () => {
    faucet.next = { ok: false, status: 400, error: 'invalid_address' };
    const res = await postFaucet(JSON.stringify({ l2Address: 'bad' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_address');
  });

  it('maps a 409 result to HTTP 409', async () => {
    faucet.next = { ok: false, status: 409, error: 'already_funded' };
    const res = await postFaucet(JSON.stringify({ l2Address: ADDR_A }));
    expect(res.status).toBe(409);
  });

  it('maps a 429 result to HTTP 429', async () => {
    faucet.next = { ok: false, status: 429, error: 'ip_rate_limited' };
    const res = await postFaucet(JSON.stringify({ l2Address: ADDR_A }));
    expect(res.status).toBe(429);
  });

  it('maps a 503 result to HTTP 503', async () => {
    faucet.next = { ok: false, status: 503, error: 'bridge_failed' };
    const res = await postFaucet(JSON.stringify({ l2Address: ADDR_A }));
    expect(res.status).toBe(503);
  });

  it('rejects a missing/non-string l2Address with 400 before calling the faucet', async () => {
    const res = await postFaucet(JSON.stringify({ notAddress: 1 }));
    expect(res.status).toBe(400);
    expect(faucet.calls).toHaveLength(0);
  });

  it('rejects invalid JSON with 400', async () => {
    const res = await postFaucet('{not json');
    expect(res.status).toBe(400);
    expect(faucet.calls).toHaveLength(0);
  });

  it('rejects an oversized body with 413', async () => {
    const huge = JSON.stringify({ l2Address: ADDR_A, pad: 'x'.repeat(100_000) });
    const res = await postFaucet(huge);
    expect(res.status).toBe(413);
    expect(faucet.calls).toHaveLength(0);
  });

  it('answers the CORS preflight with POST allowed', async () => {
    const res = await httpRequest('OPTIONS', '/faucet', { headers: { Origin: 'http://localhost:3000' } });
    expect(res.status).toBe(204);
    expect(String(res.headers['access-control-allow-methods'])).toContain('POST');
  });
});

describe('POST /faucet when no faucet is configured', () => {
  it('returns 404 (route absent)', async () => {
    const bare = createServer({ port: port + 1 });
    await listen(bare, port + 1);
    try {
      const res = await new Promise<HttpResponse>((resolve, reject) => {
        const req = http.request(
          { host: 'localhost', port: port + 1, path: '/faucet', method: 'POST', headers: { 'Content-Type': 'application/json' } },
          (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => resolve({ status: r.statusCode!, body: d ? JSON.parse(d) : undefined, headers: r.headers })); },
        );
        req.on('error', reject);
        req.write(JSON.stringify({ l2Address: ADDR_A }));
        req.end();
      });
      expect(res.status).toBe(404);
    } finally {
      await bare.close();
    }
  });
});
