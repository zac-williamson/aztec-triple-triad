/**
 * PlayerDriver — drives one browser context through the real UI: DOM screens
 * via selectors, the 3D board via real pointer events at testkit-projected
 * coordinates, and waits on app state (never wall-clock sleeps).
 */
import type { Page, Browser } from '@playwright/test';
import { createWriteStream, readFileSync, writeFileSync, type WriteStream } from 'fs';
import { cpus } from 'os';
import { resolve } from 'path';
import type { PhaseSnapshot, ClickTarget } from '../../frontend/src/testkit/contract.js';
import { FRONTEND_URL, TESTNET, PLAYTEST_ACCOUNTS_PATH, readContractAddresses } from './env.js';
import { launchIsolatedBrowser } from './browser.js';
import { registerBrowser, deregisterBrowser, playwrightChromiumLeaders } from './stack.js';

declare global {
  interface Window {
    __triadTest?: import('../../frontend/src/testkit/contract.js').TriadTestApi;
  }
}

const POLL_MS = 250;

// clickCell settle/confirm tuning (testnet move-flake fix). Board cells are
// STATIC meshes (BoardCell3D never moves them), so once no fly/capture
// animation is running the cell projects to a stable pixel to sub-pixel; a
// jitter larger than SETTLE_EPS_PX between samples means the scene is still
// moving and a click could land off-cell. Require a few consecutive stable
// samples before trusting the projected pixel as a click point.
const SETTLE_EPS_PX = 2;
const SETTLE_STABLE_SAMPLES = 3;
// A successful cell click clears selectedCardIndex and starts our fly animation
// synchronously (GameScreen3D.handleCellClick). If the card stays SELECTED with
// the scene idle for this many consecutive polls after the click, the click was
// DROPPED (handleCellClick early-returned mid-animation) — fail loud rather than
// silently wait out the full boardUpdate timeout. ~16 * POLL_MS/2 ≈ 2s, safely
// longer than the click→handler latency so a healthy placement never trips it.
const PLACEMENT_DROP_SAMPLES = 16;

/** Live-context snapshot the in-page WebGL probe maintains (diagnostics only). */
export interface WebglStats {
  created: number;   // total WebGL contexts ever created in this tab
  lost: number;      // total contextlost events
  restored: number;  // total contextrestored events
  live: number;      // created − lost + restored (best-effort live count)
}

/**
 * Injected before any app JS. Patches getContext to COUNT WebGL contexts, so
 * logWebgl can show whether a session leaks contexts (created climbs, live
 * climbs) vs churns benignly (created climbs, live stays ~1 — e.g. StrictMode
 * dev double-mounts that orphan one context per `<Canvas>` mount). PURELY
 * diagnostic — it does NOT drive the liveness watchdog (which keys on
 * unresponsiveness, not WebGL state). Plain JS — Playwright serializes it via
 * .toString() into the page.
 */
function installWebglProbe(): void {
  const stats = { created: 0, lost: 0, restored: 0, live: 0 };
  (window as unknown as { __webglStats: typeof stats }).__webglStats = stats;
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: (type: string, ...rest: unknown[]) => unknown;
  };
  const orig = proto.getContext;
  proto.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
    const ctx = orig.call(this, type, ...rest);
    if (ctx && typeof type === 'string' && type.indexOf('webgl') !== -1) {
      stats.created++; stats.live++;
      console.log('[webgl] CREATED #' + stats.created + ' live=' + stats.live);
      this.addEventListener('webglcontextlost', function () {
        stats.lost++; stats.live = Math.max(0, stats.live - 1);
        console.log('[webgl] LOST total=' + stats.lost + ' live=' + stats.live);
      });
      this.addEventListener('webglcontextrestored', function () {
        stats.restored++; stats.live++;
        console.log('[webgl] RESTORED total=' + stats.restored + ' live=' + stats.live);
      });
    }
    return ctx;
  };
}

// Testnet has real ~36s slots + real proving + L1 bridge waits, so the chain-
// bound phases need far more headroom than the instant-block local sandbox. The
// per-phase withDeadline + backend-liveness guards still fail a true hang fast;
// these only stop a HEALTHY-but-slow testnet op from tripping a local-tuned
// timeout. Frontend-local waits (install/selection) are barely changed.
export const TIMEOUTS = TESTNET ? {
  install: 180_000,
  wsConnect: 60_000,
  onboarding: 1_800_000,    // faucet L1→L2 bridge + deploy+mint proof + real block inclusion (30 min)
  match: 300_000,
  selection: 15_000,
  boardUpdate: 240_000,     // off-chain move proofs are real; machine under load
  interactionIdle: 240_000,
  canSettle: 1_800_000,     // all 9 move + 2 hand proofs, real proving (30 min)
  settleTx: 2_400_000,      // process_game: 11 recursive verifs + on-chain inclusion/finality (40 min)
  packTx: 1_200_000,        // purchase tx + 10-note import + block inclusion (20 min)
  pxeRead: 300_000,         // testnet PXE reads sync across real blocks
  evaluate: 60_000,
  placementConfirm: 120_000, // confirm a cell click registered; fail loud on a miss, not a 240s board-update timeout
  abandonWarn: 180_000,     // backend present-but-idle warning: fires at >=60s idle, checked every 5s (3 min headroom)
  eventually: 420_000,      // private-note discovery by block scanning, ~36s slots (7 min)
} : {
  install: 120_000,      // first boot after an SDK bump cold-optimizes the @aztec deps in-browser
  wsConnect: 30_000,
  onboarding: 420_000,      // L1 bridge wait + deploy+mint tx + note import
  match: 60_000,
  selection: 10_000,
  boardUpdate: 30_000,
  interactionIdle: 60_000,  // capture cascades run ~1s per flip
  canSettle: 1_200_000,     // all 9 move proofs + 2 hand proofs (real proving)
  settleTx: 1_800_000,      // process_game: 11 recursive verifications, client-proved
  packTx: 600_000,          // purchase_card_pack: tx proving + 10-note import
  pxeRead: 180_000,         // hard backstop for a single PXE read; a true hang fails fatally, never masked
  evaluate: 30_000,         // a bare page.evaluate (phase snapshot) must not hang the run
  placementConfirm: 30_000, // confirm a cell click registered; fail loud on a miss, not a board-update timeout
  abandonWarn: 120_000,     // backend present-but-idle warning (>=60s idle, checked every 5s)
  eventually: 180_000,      // private-state eventual consistency (PXE note discovery) after a tx
};

/** One account in the provisioned pool manifest (provision-playtest-accounts.ts). */
interface PlaytestPoolEntry {
  index: number;
  address: string;
  secret: string;
  salt: string;
  signingKey: string;
  /** Full StoredCard[] — seeded verbatim into the browser cardStore. */
  starterCards: unknown[];
  used: boolean;
}

/**
 * Claim the next unused account from the provisioned pool (SINGLE-USE), mark it
 * used in the manifest, and build the localStorage seed that makes the app
 * restore it as an already-deployed account with its 5 starter cards — no app
 * faucet, no funding step (docs/plan/PLAYTEST_SELFFUND.md). Serial single-worker
 * launches make the manifest read-modify-write race-free.
 *
 * The seed keys mirror config.ts storageKeys (scoped by the game contract addr)
 * and cardStore.ts exactly, so prepareConnection restores the keys, sees
 * `deployed`, skips minting, and re-imports the cards from the seeded cardStore.
 */
function claimPlaytestAccount(): Record<string, string> {
  let manifest: PlaytestPoolEntry[];
  try {
    manifest = JSON.parse(readFileSync(PLAYTEST_ACCOUNTS_PATH, 'utf-8')) as PlaytestPoolEntry[];
  } catch {
    throw new Error(
      `PLAYTEST_TESTNET needs a provisioned account pool at ${PLAYTEST_ACCOUNTS_PATH}.\n` +
        `Run: npx tsx scripts/provision-playtest-accounts.ts --count <N>`,
    );
  }
  const entry = manifest.find((e) => !e.used);
  if (!entry) {
    throw new Error(
      `Playtest account pool exhausted (all ${manifest.length} used — single-use). Provision more:\n` +
        `  npx tsx scripts/provision-playtest-accounts.ts --start ${manifest.length} --count <N>`,
    );
  }

  // Well-formedness guard (no mask): a corrupt/partial manifest entry must fail
  // loud here, not silently seed garbage and fall through to the removed funding
  // path. The keys come from the shared deterministic deriver
  // (scripts/lib/playtestAccounts.ts) and the provision script already verified
  // each recorded account holds cards [1..5] + 100 ARNA on-chain.
  const HEX66 = /^0x[0-9a-fA-F]{64}$/;
  if (!HEX66.test(entry.secret) || !HEX66.test(entry.salt) || !HEX66.test(entry.signingKey)) {
    throw new Error(`Manifest entry #${entry.index} has malformed keys — re-provision the pool.`);
  }
  if (!HEX66.test(entry.address) || !Array.isArray(entry.starterCards) || entry.starterCards.length !== 5) {
    throw new Error(`Manifest entry #${entry.index} missing its address or 5 starter cards — re-provision.`);
  }

  entry.used = true;
  writeFileSync(PLAYTEST_ACCOUNTS_PATH, JSON.stringify(manifest, null, 2));

  const { nft, game } = readContractAddresses();
  return {
    [`aztec_tt_account_secret_${game}`]: entry.secret,
    [`aztec_tt_account_salt_${game}`]: entry.salt,
    [`aztec_tt_signing_key_${game}`]: entry.signingKey,
    [`aztec_tt_deployed_${game}`]: 'deployed',
    [`aztec_tt_cards_minted_${entry.address}_${nft}`]: 'true',
    [`aztec_tt_card_inventory_${entry.address}_${game}`]: JSON.stringify(entry.starterCards),
  };
}

/** Per-player launch overrides. Defaults preserve the campaign's behaviour. */
export interface LaunchOptions {
  /** localStorage seed; `null` means "a new player", bypassing the account pool. */
  seed?: Record<string, string> | null;
  /** Runs after init scripts, before navigation. */
  beforeNavigate?: (page: Page) => Promise<void>;
  /** Dismiss the tutorial during boot (default true). */
  skipTutorial?: boolean;
}

export class PlayerDriver {
  private consoleLog: WriteStream | null = null;

  /**
   * Rejects the instant the page is declared dead (renderer crash, or a WebGL
   * context lost-and-not-restored past the grace window). Long waits race
   * against it so a dead page fails in ~2 min instead of stalling the full
   * 25-min proof budget. `.catch` keeps it from ever being an unhandled
   * rejection if nothing happens to be racing it at reject time.
   */
  readonly dead: Promise<never>;
  private rejectDead!: (err: Error) => void;
  private deadReason: string | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  /** Main Chromium pid(s) of this player's browser, for leak-registry cleanup. */
  private browserPids: number[] = [];

  constructor(readonly name: string, readonly page: Page, readonly browser?: Browser) {
    this.dead = new Promise<never>((_, reject) => { this.rejectDead = reject; });
    this.dead.catch(() => {});
  }

  /** Launch an ISOLATED Chromium process for this player and boot it. */
  static async launch(name: string, logsDir: string, opts?: LaunchOptions): Promise<PlayerDriver> {
    // Diff the Chromium group-leaders across the launch to learn the new
    // browser's pid (the client Browser exposes none). Serial single-worker
    // launches make the diff unambiguous. Register it so a SIGKILLed worker
    // can't leak the detached browser past teardown — Playwright's own cleanup
    // only fires on a graceful exit (exit/SIGINT/SIGTERM hooks).
    const before = playwrightChromiumLeaders();
    const { browser, context } = await launchIsolatedBrowser();
    const newPids = [...playwrightChromiumLeaders()].filter(pid => !before.has(pid));
    for (const pid of newPids) registerBrowser(pid, name);
    const page = await context.newPage();
    const driver = new PlayerDriver(name, page, browser);
    driver.browserPids = newPids;
    // TESTNET: claim a pre-funded, pre-deployed account from the provisioned pool
    // and seed it into localStorage so onboarding restores it (no app faucet).
    // Local sandbox keeps the auto-fund path (seed stays undefined).
    // `seed: null` is how a caller says "a genuinely new player" — the pool
    // exists to SKIP onboarding, which is exactly what an onboarding test must
    // not do. `undefined` keeps the default (pool on testnet, faucet locally).
    const seed = opts?.seed !== undefined
      ? (opts.seed ?? undefined)
      : (TESTNET ? claimPlaytestAccount() : undefined);
    await driver.boot(logsDir, seed, opts);
    return driver;
  }

  /** Navigate, capture console/page errors to the artifacts dir, skip the tutorial. */
  async boot(
    logsDir: string,
    localStorageSeed?: Record<string, string>,
    opts?: LaunchOptions,
  ): Promise<void> {
    this.consoleLog = createWriteStream(resolve(logsDir, `browser-${this.name}.log`));
    this.page.on('console', msg =>
      this.consoleLog!.write(`[${new Date().toISOString()}] [${msg.type()}] ${msg.text()}\n`));
    this.page.on('pageerror', err =>
      this.consoleLog!.write(`[${new Date().toISOString()}] [pageerror] ${err.stack ?? err.message}\n`));
    // A renderer crash is an immediate, unambiguous death — fail the run now,
    // don't wait out any budget.
    this.page.on('crash', () => this.declareDead('renderer process crashed (page.on("crash"))'));

    // Opt-in rpc-probe: tally every JSON-RPC POST to the node (timestamp +
    // method) into rpc-<name>.csv, to attribute request-rate bursts against the
    // testnet 300/min/IP cap (this is how the client-side rate-limiter detour
    // was diagnosed and killed — keep it available).
    if (process.env.PLAYTEST_RPC_PROBE === '1') {
      const rpcLog = createWriteStream(resolve(logsDir, `rpc-${this.name}.csv`));
      this.page.on('request', req => {
        if (req.method() !== 'POST') return;
        const u = req.url();
        if (!/:8080|testnet\.rpc\.aztec/.test(u)) return;
        // v5 JSON-RPC batches calls → body is an array; capture every method.
        let m = 'nonjson';
        try {
          const b = JSON.parse(req.postData() || '{}');
          m = Array.isArray(b) ? b.map((x: { method?: string }) => x?.method ?? '?').join('|') : (b.method ?? '?');
        } catch { /* keep nonjson */ }
        rpcLog.write(`${Date.now()},${m}\n`);
      });
    }

    // Count WebGL contexts before app JS runs, so leak-vs-crash is observable.
    await this.page.addInitScript(installWebglProbe);
    // Two headless browsers prove on ONE machine: at full hardwareConcurrency
    // each, whichever proves first starves the other's timers and PXE sync
    // (an aggravator of the stale-anchor wedge). Cap each at half the cores.
    // PLAYTEST_PROOF_THREADS overrides the cap. Each thread carries its own
    // barretenberg WASM heap, so 2 browsers x cores/2 is the peak-memory driver:
    // on a 12-core machine that is 12 heaps, which exhausted swap and got the
    // run SIGKILLed mid-campaign (twice) with no error in the log. Lower it on
    // a memory-constrained box; proving is slower but the run survives.
    const threadsOverride = Number(process.env.PLAYTEST_PROOF_THREADS);
    const proofThreads =
      Number.isFinite(threadsOverride) && threadsOverride > 0
        ? Math.floor(threadsOverride)
        : Math.max(2, Math.floor(cpus().length / 2));
    await this.page.addInitScript((threads: number) => {
      localStorage.setItem('triad_proof_threads', String(threads));
    }, proofThreads);
    // Seed the pre-provisioned account into localStorage BEFORE any app JS, so
    // prepareConnection restores an already-deployed account (alreadyDeployed →
    // no funding step) with its starter cards re-imported from the seeded
    // cardStore. Runs before goto; only set in TESTNET mode.
    if (localStorageSeed) {
      await this.page.addInitScript((entries: Record<string, string>) => {
        for (const k in entries) localStorage.setItem(k, entries[k]);
      }, localStorageSeed);
    }
    // Last chance to install anything that must exist before app JS — the
    // injected wallet provider, for one: the app reads window.ethereum on the
    // click, and a provider added after navigation would race it.
    if (opts?.beforeNavigate) await opts.beforeNavigate(this.page);
    await this.page.goto(FRONTEND_URL);
    await this.page.waitForFunction(() => !!window.__triadTest, undefined, {
      timeout: TIMEOUTS.install, polling: POLL_MS,
    });
    // A new player (the restore seed deliberately omits `tutorial_seen`) is
    // offered the Xochitl tutorial. Since 2f11ede the prompt appears DURING
    // 'deploying': the restored, already-deployed account still transits
    // 'deploying' (see FundingProgress.tsx) and the prompt now rides that phase
    // instead of waiting for the post-funding menu. Wait for the skip button
    // explicitly — robust to it surfacing during 'deploying' OR later on the
    // menu (Playwright re-checks actionability across the deploying→menu
    // transition) — then skip to reach the menu. Keeping the click (rather than
    // seeding tutorial_seen=true) also exercises and asserts the new
    // parallel-onboarding path: if the prompt never appears, boot fails loud.
    // A player who starts at 'needs-funding' is not offered the tutorial yet
    // (App.tsx suppresses it for that status), so a boot-time wait would hang
    // until the funding it is blocking on completes. Those flows skip it
    // themselves once funded, via skipTutorial().
    if (opts?.skipTutorial !== false) await this.skipTutorial();
    this.startWatchdog();
  }

  /** Dismiss the Xochitl tutorial prompt. Fails loud if it never appears. */
  async skipTutorial(): Promise<void> {
    const tutorialSkip = this.page.getByTestId('tutorial-skip');
    await tutorialSkip.waitFor({ state: 'visible', timeout: TIMEOUTS.wsConnect });
    await tutorialSkip.click();
  }

  /** Read the in-page WebGL context counters (bounded; null if unreadable). */
  async webglStats(): Promise<WebglStats | null> {
    return this.withTimeout(
      this.page.evaluate(() => (window as unknown as { __webglStats?: WebglStats }).__webglStats ?? null),
      TIMEOUTS.evaluate, 'webglStats',
    ).catch(() => null);
  }

  /**
   * Liveness watchdog. Every 15s it pings the page with a trivial bounded
   * `evaluate`; ~4 consecutive unanswerable pings (~60s) → the page's event loop
   * is wedged → declare it dead (plus `page.on('crash')`, immediate). A wedged
   * page can't answer the ping, so the Node-side timeout on the ping is what
   * fires. We do NOT key death on WebGL state: under React StrictMode every R3F
   * `<Canvas>` dev-double-mounts, so the orphaned mount's `webglcontextlost`
   * fires while the live canvas renders fine — and in testkit the menu has NO
   * canvas at all (MenuScene gated off), so live==0 is the NORMAL menu state.
   * Either would false-positive a WebGL-based death (it killed a healthy game
   * mid-proof once). The WebGL probe stays purely for diagnostics (logWebgl);
   * any real wedge is caught here (ping) or by the bounded per-op timeouts.
   */
  startWatchdog(opts: {
    pingEvery?: number; pingTimeout?: number; maxPingFails?: number;
  } = {}): void {
    const PING_EVERY = opts.pingEvery ?? 15_000;
    const PING_TIMEOUT = opts.pingTimeout ?? 20_000;
    const MAX_PING_FAILS = opts.maxPingFails ?? 4;
    let pingFails = 0;
    const tick = async (): Promise<void> => {
      if (this.deadReason) return;
      try {
        await this.withTimeout(this.page.evaluate(() => 1), PING_TIMEOUT, 'liveness ping');
        pingFails = 0; // page answered
      } catch {
        pingFails++;
        if (pingFails >= MAX_PING_FAILS) {
          this.declareDead(`unresponsive — ${pingFails} consecutive liveness pings failed ` +
            `(~${Math.round((pingFails * PING_EVERY) / 1000)}s, page event loop is blocked)`);
          return;
        }
      }
      this.watchdogTimer = setTimeout(() => { void tick(); }, PING_EVERY);
    };
    this.watchdogTimer = setTimeout(() => { void tick(); }, PING_EVERY);
  }

  private declareDead(reason: string): void {
    if (this.deadReason) return;
    this.deadReason = reason;
    this.stopWatchdog();
    this.rejectDead(new Error(`${this.name}: PAGE DEAD — ${reason}`));
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) { clearTimeout(this.watchdogTimer); this.watchdogTimer = null; }
  }

  /** Stop the watchdog and close the owned browser process. Safe to call twice. */
  async dispose(): Promise<void> {
    this.stopWatchdog();
    await this.page.context().close().catch(() => {});
    await this.browser?.close().catch(() => {});
    // Clean close → drop from the leak registry so teardown never targets a
    // since-recycled pid.
    for (const pid of this.browserPids) deregisterBrowser(pid);
    this.browserPids = [];
  }

  async phase(): Promise<PhaseSnapshot> {
    // Even the synchronous snapshot is a page.evaluate; if the page's JS event
    // loop is blocked, the evaluate never returns. Bound it so a stall fails
    // fast rather than zombie-hanging.
    const snapshot = await this.withTimeout(
      this.page.evaluate(() => window.__triadTest!.phase()), TIMEOUTS.evaluate, 'phase()');
    if (!snapshot) throw new Error(`${this.name}: testkit bridge has not published yet`);
    return snapshot;
  }

  /**
   * Wait until a phase-snapshot predicate holds; on timeout, rethrow with the
   * live snapshot. The predicate is serialized into the page, so it MUST NOT
   * close over outer variables — pass them via `args` instead.
   */
  async waitPhase<A>(
    label: string,
    predicate: (p: PhaseSnapshot, args: A) => boolean,
    timeout: number,
    args?: A,
  ): Promise<PhaseSnapshot> {
    try {
      await Promise.race([
        this.page.waitForFunction(
          (input: { src: string; args: unknown }) => {
            const t = window.__triadTest;
            if (!t) return false;
            const p = t.phase();
            if (!p) return false;
            // eslint-disable-next-line no-new-func
            return (new Function('p', 'args', `return (${input.src})(p, args)`))(p, input.args);
          },
          { src: predicate.toString(), args: args as unknown },
          { timeout, polling: POLL_MS },
        ),
        this.dead, // watchdog declared the page dead → abandon the wait now
      ]);
    } catch (err) {
      // A dead page is the root failure; surface it plainly, not as a "timed out".
      if (this.deadReason) throw err;
      const snapshot = await this.phase().catch(() => null);
      throw new Error(
        `${this.name}: timed out waiting for "${label}" after ${timeout / 1000}s\n` +
        `last phase: ${JSON.stringify(snapshot, null, 2)}\n${err}`,
      );
    }
    return this.phase();
  }

  /**
   * Onboarding end state: wallet connected and the 5 starter cards imported.
   * Polls so it can FAIL FAST on a terminal funding state the headless harness
   * can't escape — `needs-funding` (the faucet returned no claim → the app would
   * wait for a manual fund click) or `error` — instead of burning the full
   * onboarding timeout. On testnet that names the Node-side treasury-bridge
   * fallback. Still abandons on page death (watchdog) and on the hard timeout.
   */
  async waitConnected(): Promise<PhaseSnapshot> {
    const deadline = Date.now() + TIMEOUTS.onboarding;
    let last: PhaseSnapshot | null = null;
    while (Date.now() < deadline) {
      if (this.deadReason) throw new Error(`${this.name}: PAGE DEAD during onboarding — ${this.deadReason}`);
      last = await this.phase().catch(() => null);
      if (last) {
        if (last.aztecStatus === 'needs-funding') {
          throw new Error(`${this.name}: onboarding stuck at 'needs-funding' — the faucet returned no ` +
            `Fee Juice claim. ${TESTNET ? 'Fall back to the Node-side treasury-key bridge (key Node-side only).' : 'Check the local devnet bridge.'}`);
        }
        if (last.aztecStatus === 'error') {
          throw new Error(`${this.name}: onboarding status='error'\nlast phase: ${JSON.stringify(last, null, 2)}`);
        }
        if (last.aztecStatus === 'connected' && last.ownedCardIds.length >= 5 && last.ws.connected) return last;
      }
      await this.page.waitForTimeout(POLL_MS).catch(() => {});
    }
    throw new Error(
      `${this.name}: timed out waiting for "aztec connected with starter cards" after ${TIMEOUTS.onboarding / 1000}s\n` +
      `last phase: ${JSON.stringify(last, null, 2)}`,
    );
  }

  /**
   * The new-player path: pay for Fee Juice from the injected wallet, then wait
   * out onboarding.
   *
   * Distinct from waitConnected, which treats 'needs-funding' as terminal —
   * here it is the STARTING state, and the account stays in it for the whole
   * bridge (three L1 transactions plus the L1->L2 message). What must not
   * happen is sitting in it with nothing in flight, so a null fundingProgress
   * while still unfunded is the failure this watches for.
   */
  async fundFromWallet(opts: { timeout?: number; log?: (m: string) => void } = {}): Promise<PhaseSnapshot> {
    const log = opts.log ?? (() => {});
    const timeout = opts.timeout ?? TIMEOUTS.onboarding;
    await this.page.getByTestId('fund-with-wallet').click();

    const deadline = Date.now() + timeout;
    let lastProgress: string | null = null;
    let idleSince: number | null = null;
    while (Date.now() < deadline) {
      if (this.deadReason) throw new Error(`${this.name}: PAGE DEAD during funding — ${this.deadReason}`);
      const p = await this.phase().catch(() => null);
      if (p) {
        if (p.fundingProgress && p.fundingProgress !== lastProgress) {
          lastProgress = p.fundingProgress;
          log(`funding: ${p.fundingProgress}`);
        }
        // Funding errors leave the status at 'needs-funding' on purpose (the
        // player keeps their retry), so the error field is the only signal.
        if (p.aztecError) {
          throw new Error(`${this.name}: funding failed — ${p.aztecError}`);
        }
        if (p.aztecStatus === 'error') {
          throw new Error(`${this.name}: funding failed — ${await this.errorText()}`);
        }
        if (p.aztecStatus === 'connected' && p.ownedCardIds.length >= 5 && p.ws.connected) return p;
        // Nothing in flight and still not funded: the click was swallowed.
        if (p.aztecStatus === 'needs-funding' && !p.fundingProgress) {
          idleSince ??= Date.now();
          if (Date.now() - idleSince > 60_000) {
            throw new Error(`${this.name}: still at 'needs-funding' with no funding in flight 60s after ` +
              `clicking Fund with My Wallet — the click did not start anything.`);
          }
        } else {
          idleSince = null;
        }
      }
      await this.page.waitForTimeout(POLL_MS).catch(() => {});
    }
    throw new Error(`${this.name}: wallet funding did not complete within ${timeout / 1000}s ` +
      `(last step: ${lastProgress ?? 'none'})`);
  }

  /** Whatever the app is currently showing as an error, for failure messages. */
  private async errorText(): Promise<string> {
    return this.page.evaluate(() => {
      const el = document.querySelector('[role="alert"], .parchment-dialog__error');
      return el?.textContent?.trim() || 'no error text on screen';
    }).catch(() => 'unreadable');
  }

  /**
   * Click a testid; on failure augment the error with the player's current
   * screen. A wedged page now fails at the context's default action timeout
   * (src/browser.ts) instead of hanging — and the screen tells us WHY a click
   * couldn't land (e.g. the player wasn't on the screen we expected).
   */
  private async clickTestId(testId: string): Promise<void> {
    try {
      await this.page.getByTestId(testId).click();
    } catch (err) {
      const snap = await this.phase().catch(() => null);
      const ctx = snap
        ? `screen=${snap.screen} aztec=${snap.aztecStatus} ws.connected=${snap.ws.connected} ` +
          `matchmaking=${snap.ws.matchmakingStatus} cards=${snap.ownedCardIds.length}`
        : 'phase unavailable (page unresponsive)';
      throw new Error(`${this.name}: click '${testId}' did not land [${ctx}]: ${(err as Error).message.split('\n')[0]}`);
    }
  }

  /** Main menu → card selector → pick the 5 cards → queue for matchmaking. */
  async startMatchmaking(cardIds: number[]): Promise<void> {
    await this.clickTestId('menu-play');
    for (const id of [...new Set(cardIds)]) {
      const copies = cardIds.filter(c => c === id).length;
      for (let i = 0; i < copies; i++) {
        await this.clickTestId(`card-select-${id}`);
      }
    }
    await this.clickTestId('hand-confirm');
  }

  async waitInGame(): Promise<PhaseSnapshot> {
    return this.waitPhase(
      'matched into game screen',
      p => p.screen === 'game' && p.game !== null && p.ws.playerNumber !== null,
      TIMEOUTS.match,
    );
  }

  /**
   * Interaction gate: my turn, game playing, no selection, and no fly/capture
   * animation — held over several consecutive polls so the click cannot land
   * in the gap between an incoming board update and its animation kickoff.
   */
  async waitReadyToMove(): Promise<void> {
    const deadline = Date.now() + TIMEOUTS.interactionIdle;
    let stable = 0;
    while (Date.now() < deadline) {
      const p = await this.phase();
      const idle = p.game !== null
        && p.game.status === 'playing'
        && p.game.isMyTurn
        && p.interaction !== null
        && !p.interaction.flying
        && !p.interaction.cascading
        && p.interaction.selectedCardIndex === null;
      stable = idle ? stable + 1 : 0;
      if (stable >= 3) return;
      await this.page.waitForTimeout(POLL_MS / 2);
    }
    const snapshot = await this.phase().catch(() => null);
    throw new Error(
      `${this.name}: never became ready to move within ${TIMEOUTS.interactionIdle / 1000}s\n` +
      `last phase: ${JSON.stringify(snapshot, null, 2)}`,
    );
  }

  /** Project a click target to viewport px via the live camera (bounded read). */
  private async projectTarget(target: ClickTarget): Promise<{ x: number; y: number }> {
    return this.withTimeout(
      this.page.evaluate(t => window.__triadTest!.getScreenXY(t as any), target as any),
      TIMEOUTS.evaluate, 'getScreenXY',
    );
  }

  private async clickProjected(target: ClickTarget): Promise<void> {
    const { x, y } = await this.projectTarget(target);
    await this.page.mouse.click(x, y);
  }

  /** Click a hand-fan strip and confirm the app registered that selection. */
  async selectHandCard(index: number): Promise<void> {
    await this.clickProjected({ type: 'hand', index });
    await this.waitPhase(
      `hand card ${index} selected`,
      (p, args) => p.interaction?.selectedCardIndex === args.index,
      TIMEOUTS.selection,
      { index },
    );
  }

  /**
   * Place the selected card on board cell [row,col] via a projected canvas click.
   *
   * Root-cause fix for the testnet move-flake (a game stalled at move ~6: board
   * frozen, the mover's card stuck selected). The app SILENTLY drops a cell
   * click in two ways: GameScreen3D.handleCellClick early-returns while a
   * fly/capture animation is running, and R3F's onPointerMissed DESELECTS the
   * card if the projected pixel lands off-cell. On the local sandbox the scene
   * settles between moves before the harness clicks; on testnet's slower cadence
   * the previous move's incoming fly/capture can still be animating when we fire.
   * So: (1) wait for a SETTLED scene before projecting+clicking — no fly/cascade
   * AND a stable projection of THIS cell — then (2) CONFIRM the placement
   * registered, failing loud on a miss instead of burning the 240s board-update
   * timeout. This is NOT a retry: the settle-wait is the fix; one missed click
   * fails loud (root-cause, never mask).
   */
  async clickCell(row: number, col: number): Promise<void> {
    const target = { type: 'cell' as const, row, col };
    await this.waitCellSettled(target);
    await this.clickProjected(target);
    await this.confirmPlacement(row, col);
  }

  /**
   * Hold until cell [target] is safe to click: my turn, a card still selected,
   * NO fly/capture animation in flight, and the cell's projected pixel stable
   * across consecutive samples (so the click can't land off-cell against a
   * moving scene). Reuses the testkit interaction snapshot + the live
   * getScreenXY projection — no new app signal needed (the cells are static, so
   * "no animation + stable projection" fully characterizes a settled target).
   * Fails loud on timeout — never fires a click into an unsettled scene.
   */
  private async waitCellSettled(target: { type: 'cell'; row: number; col: number }): Promise<void> {
    const deadline = Date.now() + TIMEOUTS.interactionIdle;
    let prev: { x: number; y: number } | null = null;
    let stable = 0;
    let last: PhaseSnapshot | null = null;
    let projErr = '';
    while (Date.now() < deadline) {
      if (this.deadReason) throw new Error(`${this.name}: PAGE DEAD before cell click — ${this.deadReason}`);
      last = await this.phase().catch(() => null);
      const idle = last?.game?.status === 'playing'
        && last.game.isMyTurn
        && last.interaction !== null
        && !last.interaction.flying
        && !last.interaction.cascading
        && last.interaction.selectedCardIndex !== null;
      if (idle) {
        const xy = await this.projectTarget(target).then(p => p, (e) => { projErr = String(e); return null; });
        if (xy && prev && Math.abs(xy.x - prev.x) <= SETTLE_EPS_PX && Math.abs(xy.y - prev.y) <= SETTLE_EPS_PX) {
          if (++stable >= SETTLE_STABLE_SAMPLES) return;
        } else {
          stable = 0;
        }
        prev = xy;
      } else {
        stable = 0;
        prev = null;
      }
      await this.page.waitForTimeout(POLL_MS / 2).catch(() => {});
    }
    throw new Error(
      `${this.name}: cell [${target.row},${target.col}] never became clickable within ` +
      `${TIMEOUTS.interactionIdle / 1000}s (scene/selection never settled${projErr ? `; last projection error: ${projErr}` : ''})\n` +
      `last phase: ${JSON.stringify(last, null, 2)}`,
    );
  }

  /**
   * Confirm the cell click registered a placement. handleCellClick's success
   * path fills the cell and starts our fly animation; a click dropped
   * mid-animation leaves the card selected and the cell empty, and an off-cell
   * click deselects it — neither fills the cell. Return the instant the cell is
   * filled (or our fly starts); fail loud once the scene is idle with the card
   * still selected and the cell empty (a dropped click), or at the deadline
   * (any other miss). No re-click — a confirmed miss is surfaced, not retried.
   */
  private async confirmPlacement(row: number, col: number): Promise<void> {
    const deadline = Date.now() + TIMEOUTS.placementConfirm;
    let dropStreak = 0;
    let last: PhaseSnapshot | null = null;
    while (Date.now() < deadline) {
      if (this.deadReason) throw new Error(`${this.name}: PAGE DEAD after cell click — ${this.deadReason}`);
      last = await this.phase().catch(() => null);
      if (last?.game?.board[row]?.[col]?.cardId != null) return; // card landed — registered
      if (last?.interaction?.flying) return;                     // our fly started — accepted
      const droppedNow = last?.interaction != null
        && last.interaction.selectedCardIndex !== null
        && !last.interaction.flying
        && !last.interaction.cascading;
      dropStreak = droppedNow ? dropStreak + 1 : 0;
      if (dropStreak >= PLACEMENT_DROP_SAMPLES) {
        throw new Error(
          `${this.name}: cell [${row},${col}] click did NOT place — card still selected ` +
          `(index ${last!.interaction!.selectedCardIndex}), scene idle, cell empty. The projected click was ` +
          `dropped (handleCellClick early-return) or missed the cell; the settle-wait should prevent this.\n` +
          `last phase: ${JSON.stringify(last, null, 2)}`,
        );
      }
      await this.page.waitForTimeout(POLL_MS / 2).catch(() => {});
    }
    throw new Error(
      `${this.name}: cell [${row},${col}] placement not confirmed within ${TIMEOUTS.placementConfirm / 1000}s ` +
      `(cell empty, no fly started — likely an off-cell click that deselected the card)\n` +
      `last phase: ${JSON.stringify(last, null, 2)}`,
    );
  }

  async waitBoardCount(occupied: number): Promise<PhaseSnapshot> {
    return this.waitPhase(
      `board has ${occupied} cards`,
      (p, args) => p.game !== null
        && p.game.board.flat().filter(c => c.cardId !== null).length === args.occupied,
      TIMEOUTS.boardUpdate,
      { occupied },
    );
  }

  async waitGameOver(): Promise<PhaseSnapshot> {
    return this.waitPhase(
      'game over',
      p => p.ws.gameOver !== null,
      TIMEOUTS.boardUpdate,
    );
  }

  /** All 9 move proofs + both hand proofs collected — settlement unlocked. */
  async waitCanSettle(): Promise<void> {
    await this.waitPhase('canSettle (hand + 9 move proofs)', p => p.chain.canSettle, TIMEOUTS.canSettle);
  }

  /** Winner: pick the loser card in the settlement dialog. */
  async pickSettleCard(cardId: number): Promise<void> {
    await this.page.getByTestId(`settle-card-${cardId}`).click();
  }

  async waitSettleConfirmed(): Promise<void> {
    await this.waitPhase(
      'settlement tx confirmed',
      p => p.chain.settleTxStatus === 'confirmed',
      TIMEOUTS.settleTx,
    );
  }

  /** Loser: opponent settled and the taken card is known. */
  async waitOpponentSettled(): Promise<PhaseSnapshot> {
    return this.waitPhase(
      'opponent settlement received',
      p => p.chain.opponentSettled && p.chain.takenCardId !== null,
      TIMEOUTS.settleTx,
    );
  }

  // ── Present-but-idle abandonment (docs/plan/ABANDONED_GAMES.md) ──────────

  /**
   * Wait until the relay's GAME_ABANDONMENT_WARNING reaches this tab with the
   * given idle player. Returns the live phase so the caller can assert
   * secondsIdle etc. Fires once the player-whose-turn-it-is has been idle >=60s
   * (backend checks every 5s), so this needs the long abandonWarn budget.
   */
  async waitAbandonmentWarning(idlePlayer: 'player1' | 'player2'): Promise<PhaseSnapshot> {
    return this.waitPhase(
      `abandonment warning (idle=${idlePlayer})`,
      (p, want) => p.abandonment?.warning != null && p.abandonment.warning.idlePlayer === want,
      TIMEOUTS.abandonWarn,
      idlePlayer,
    );
  }

  /**
   * Wait until the on-chain claim is actually AVAILABLE to this (non-idle) tab —
   * the impending-abandonment countdown has reached the deadline
   * (secondsUntilClaimable <= 0, ~60s idle). Distinct from waitAbandonmentWarning,
   * which fires earlier while abandonment is only IMPENDING (the runway during
   * which the idle player can still move). Mirrors the claim button's enabled state.
   */
  async waitClaimAvailable(): Promise<PhaseSnapshot> {
    return this.waitPhase(
      'abandoned-claim available (deadline reached)',
      p => p.abandonment?.claimAvailable === true,
      TIMEOUTS.abandonWarn,
    );
  }

  /**
   * Trigger the abandoned-game claim (claim_abandoned_game → on-chain dispute
   * window → settle_abandoned_game) — the testkit equivalent of clicking
   * "Claim abandoned game". Fire-and-forget; observe progress via
   * phase().abandonment.{isClaimingAbandoned,disputeCountdown} and the on-chain
   * status (ChainClient.gameStatus → 5 abandoned_claimed → 3 settled).
   */
  async claimAbandonedGame(): Promise<void> {
    await this.withTimeout(
      this.page.evaluate(() => window.__triadTest!.claimAbandonedGame()),
      TIMEOUTS.evaluate, 'claimAbandonedGame',
    );
  }

  /** Wait until this tab has entered the abandoned-claim flow (claim started). */
  async waitClaimingAbandoned(): Promise<PhaseSnapshot> {
    return this.waitPhase(
      'abandoned-claim started',
      p => p.abandonment?.isClaimingAbandoned === true,
      TIMEOUTS.settleTx,
    );
  }

  /** Reject if a promise outruns `ms` — a hung PXE read must fail loudly, not stall the run. */
  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${this.name}: ${label} did not return within ${ms / 1000}s`)), ms)),
    ]);
  }

  /** Private NFT reads from THIS tab's PXE (serialized via the app's queue). */
  async privateCards(): Promise<number[]> {
    const cards = await this.withTimeout(
      this.page.evaluate(() => window.__triadTest!.getPrivateCards()),
      TIMEOUTS.pxeRead, 'getPrivateCards');
    return [...cards].sort((a, b) => a - b);
  }

  /** Token balance via THIS tab's PXE (a fresh get_balance simulate, queued). */
  async tokenBalance(): Promise<number> {
    return this.withTimeout(
      this.page.evaluate(() => window.__triadTest!.getTokenBalance()),
      TIMEOUTS.pxeRead, 'getTokenBalance');
  }

  /**
   * Poll an async read until it equals `expected` — for private state that is
   * eventually consistent by design (PXE discovers notes by block scanning).
   * A read that THROWS is FATAL and propagates: it means the read itself is
   * broken (e.g. a PXE/IndexedDB conflict), not "value not yet". Polling is
   * ONLY for a legitimately not-yet-equal value. Never swallow a thrown read.
   */
  async expectEventually<T>(
    label: string,
    read: () => Promise<T>,
    expected: T,
    timeout = TIMEOUTS.eventually,
  ): Promise<void> {
    const deadline = Date.now() + timeout;
    let last: T | undefined;
    while (Date.now() < deadline) {
      last = await read();
      if (JSON.stringify(last) === JSON.stringify(expected)) return;
      await this.page.waitForTimeout(2000);
    }
    throw new Error(
      `${this.name}: "${label}" never reached expected value within ${timeout / 1000}s\n` +
      `expected: ${JSON.stringify(expected)}\nlast:     ${JSON.stringify(last)}`,
    );
  }

  /** Current app screen ('main-menu' | 'card-packs' | 'pack-opening' | 'game' | ...). */
  async screen(): Promise<string> {
    return (await this.phase()).screen;
  }

  async waitScreen(screen: string, timeout = TIMEOUTS.match): Promise<void> {
    await this.waitPhase(`screen=${screen}`, (p, s) => p.screen === s, timeout, screen);
  }

  /** From the game-over dialog: click Back to Lobby and land on the main menu. */
  async returnToMenu(): Promise<void> {
    await this.page.getByTestId('back-to-lobby').click();
    await this.waitScreen('main-menu', TIMEOUTS.boardUpdate);
  }

  /**
   * Open ONE card pack via the real UI: menu → Card Packs → Purchase → drive
   * the reveal (flip all 10, continue) → back to menu. Returns the 10 new card
   * ids. The purchase is a real tx (proving), so it can take a while.
   */
  async openPack(): Promise<number[]> {
    const before = (await this.phase()).ownedCardIds.length;
    await this.page.getByTestId('menu-packs').click();
    await this.waitScreen('card-packs', TIMEOUTS.match);
    await this.page.getByTestId('purchase-pack').click();
    // Wait through the purchase tx + note import until the reveal screen.
    await this.waitScreen('pack-opening', TIMEOUTS.packTx);
    // Reveal phase auto-starts after ~4.5s of intro animation; flip all 10.
    for (let i = 0; i < 10; i++) {
      await this.page.getByTestId(`pack-card-${i}`).click({ timeout: TIMEOUTS.boardUpdate });
    }
    await this.page.getByTestId('pack-all-flipped').waitFor({ state: 'attached', timeout: TIMEOUTS.selection });
    await this.page.locator('[data-testid="pack-opening"]').click(); // "click anywhere to continue"
    await this.waitScreen('card-packs', TIMEOUTS.boardUpdate);
    // Cards land in ownedCardIds via handlePackOpenComplete.
    const after = await this.waitPhase(
      'pack cards added to collection',
      (p, b) => p.ownedCardIds.length >= b + 10, TIMEOUTS.boardUpdate, before);
    await this.page.getByTestId('packs-back').click();
    await this.waitScreen('main-menu', TIMEOUTS.match);
    // The 10 new ids = ownedCardIds delta (multiset).
    return after.ownedCardIds.slice(before);
  }
}
