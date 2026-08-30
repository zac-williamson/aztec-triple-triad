/**
 * The bot's own health/metrics endpoint.
 *
 * The backend's /metrics covers what the RELAY can see — matches formed, game
 * outcomes. It cannot see anything inside the bot process: whether proving is
 * failing, whether commits are reverting, whether the bot has run out of cards,
 * or whether the watchdog is quietly abandoning games. Those are exactly the
 * "has anything broken?" signals the feature was asked for, so the bot serves
 * them itself.
 *
 * Read-only and unauthenticated by design — it exposes counters and a state
 * name, no keys, no card ids, no game contents. Bind it to localhost in
 * production if that is not acceptable in your deployment.
 */
import http from 'http';
import type { ArenaBot } from './ArenaBot.js';

export interface HealthServer {
  server: http.Server;
  close(): Promise<void>;
}

/**
 * `healthy` is the single field an alert should page on. The bot being idle is
 * NOT unhealthy — an idle bot with nobody queuing is the normal state, and
 * alerting on it would train people to ignore the alert.
 */
export function startHealthServer(bot: ArenaBot, port: number, log: (m: string) => void = () => {}): HealthServer {
  const startedAt = Date.now();

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || (req.url !== '/health' && req.url !== '/metrics')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    const stats = bot.getStats();
    const failures = stats.joinFailures + stats.moveFailures + stats.commitFailures
      + stats.proofFailures + stats.settleFailures;
    // spendableCards rides along in ...stats below; deploy/check-arena-health.sh
    // alerts on it, because a bot running out of cards goes quietly idle.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      healthy: stats.lastError === null || failures === 0,
      uptimeMs: Date.now() - startedAt,
      ...stats,
      totalFailures: failures,
    }));
  });

  server.listen(port, () => log(`health endpoint on :${port}`));
  return {
    server,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}
