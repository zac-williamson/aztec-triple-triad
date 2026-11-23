/**
 * Connect the app to the REAL Nulo wallet extension and play the arena bot as
 * that Nulo player, headless — the Nulo counterpart of prod-play.mts.
 *
 * Real throughout: Nulo's release build (src/nulo.ts downloads and checks it),
 * a Nulo wallet on the Aztec testnet, the app, the live relay and the bot. The
 * only stand-in is the player's hand on the mouse: Nulo's approval windows are
 * answered by clicking their buttons, the emoji grid is confirmed only if it
 * matches the app's, and transactions pay with the account's own Fee Juice
 * (never Nulo's sponsor). The wallet is funded from the treasury when it runs
 * low: bridged, then claimed for it by the deployer (scripts/claim-fee-juice.ts).
 *
 * Usage — serve the app where the relay accepts it, then run:
 *   cd packages/frontend && npx vite --mode testnet --port 3000 --strictPort
 *   cd packages/playtest && npx tsx scripts/nulo-play.mts [--connect-only]
 *
 * Env: APP_URL (default http://localhost:3000/?e2e=1), NULO_FEE (public |
 * private; default public), NULO_VERSION, NULO_DIR (default .artifacts/nulo:
 * a fresh dir means a brand-new Nulo player), SHOT_DIR.
 *
 * Prints one line `RESULT: pass|fail …` at the end.
 */
import type { Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { ARTIFACTS_DIR, ROOT } from '../src/env.js';
import { ensureNuloExtension, launchWithNulo, nuloPaths, openNulo, startNuloApprover, NULO_DIR } from '../src/nulo.js';

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000/?e2e=1';
const FEE = (process.env.NULO_FEE ?? 'public') as 'public' | 'private';
const CONNECT_ONLY = process.argv.includes('--connect-only');
const SHOT_DIR = process.env.SHOT_DIR ?? resolve(ARTIFACTS_DIR, `nulo-play-${new Date().toISOString().replace(/[:.]/g, '-')}`);
/** Below this the wallet is topped up first: a game costs a few FJ in fees. */
const MIN_FEE_JUICE = 20n * 10n ** 18n;
const NODE_URL = process.env.AZTEC_PXE_URL ?? 'https://aztec-testnet.drpc.org';

mkdirSync(SHOT_DIR, { recursive: true });
const t0 = Date.now();
const log = (m: string) => {
  const line = `[+${Math.round((Date.now() - t0) / 1000)}s] ${m}`;
  console.log(line);
  appendFileSync(resolve(SHOT_DIR, 'run.log'), `${line}\n`);
};
let shotN = 0;
const shot = async (p: Page, label: string) => {
  await p.screenshot({ path: resolve(SHOT_DIR, `${String(++shotN).padStart(2, '0')}-${label}.png`) }).catch(() => {});
};

async function feeJuiceOf(address: string): Promise<bigint> {
  const [{ createAztecNodeClient }, { getFeeJuiceBalance }, { AztecAddress }] = await Promise.all([
    import('@aztec-labs/aztec.js/node'),
    import('@aztec-labs/aztec.js/utils'),
    import('@aztec-labs/aztec.js/addresses'),
  ]);
  return getFeeJuiceBalance(AztecAddress.fromStringUnsafe(address), createAztecNodeClient(NODE_URL));
}

/** Bridge from the treasury, then have the deployer claim it for the Nulo account. */
function topUp(address: string): void {
  const keyFile = resolve(homedir(), '.aztec-triad-private', 'deployer-testnet-key.txt');
  const deployer = Object.fromEntries(
    readFileSync(keyFile, 'utf-8').split('\n')
      .map((l) => l.match(/^(DEPLOYER_[A-Z_]+)=(\S+)/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => [m[1], m[2]]),
  );
  const run = (script: string, env: NodeJS.ProcessEnv) =>
    execFileSync('npx', ['tsx', script, address], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
  log('bridging Fee Juice from the treasury (a few minutes)…');
  run('scripts/fund-fee-juice.ts', process.env);
  log('claiming it for the Nulo account, paid by the deployer…');
  run('scripts/claim-fee-juice.ts', { ...process.env, ...deployer });
}

const bodyText = (app: Page) => app.evaluate(() => document.body.innerText).catch(() => '');
const phase = (app: Page) => app.evaluate(() => (window as any).__triadTest?.phase());
const cardsShown = async (app: Page) => Number((await bodyText(app)).match(/Cards:\s*(\d+)/)?.[1] ?? -1);

const paths = nuloPaths();
await ensureNuloExtension(paths);
const { ctx, extensionId } = await launchWithNulo(paths);
let result = 'fail';
let detail = '';
try {
  const { address } = await openNulo(ctx, extensionId, paths, log);
  log(`Nulo account ${address} (wallet in ${NULO_DIR})`);
  const balance = await feeJuiceOf(address);
  if (balance < MIN_FEE_JUICE) {
    log(`it holds ${Number(balance) / 1e18} FJ; topping up`);
    topUp(address);
    log(`now ${Number(await feeJuiceOf(address)) / 1e18} FJ`);
  }

  // ── Connect ───────────────────────────────────────────────────────────────
  const app = await ctx.newPage();
  app.on('console', (m) => appendFileSync(resolve(SHOT_DIR, 'app-console.log'), `[${m.type()}] ${m.text()}\n`));
  app.on('pageerror', (e) => appendFileSync(resolve(SHOT_DIR, 'app-console.log'), `[pageerror] ${e.message}\n`));
  const approver = startNuloApprover(ctx, extensionId, app, { fee: FEE, log, shot });
  try {
    await app.goto(APP_URL);
    // A player who connected with Nulo before goes straight back to it.
    if (await app.getByTestId('choose-nulo').waitFor({ state: 'visible', timeout: 60_000 }).then(() => true, () => false)) {
      await app.getByTestId('choose-nulo').click();
      log('chose Nulo in the app');
    } else {
      log('the app remembered Nulo and is reconnecting');
    }
    let lastStep = '';
    const connectBy = Date.now() + 20 * 60_000;
    let cards = -1;
    while (Date.now() < connectBy) {
      const step = (await app.getByTestId('nulo-connect').textContent({ timeout: 1000 }).catch(() => null))?.replace(/\s+/g, ' ').slice(0, 120) ?? '';
      if (step !== lastStep) { if (step) log(`app: ${step}`); lastStep = step; }
      const err = await app.getByTestId('nulo-error').textContent({ timeout: 500 }).catch(() => null);
      if (err) throw new Error(`the app could not connect: ${err}`);
      if (approver.emojisConfirmed() && (await app.getByTestId('nulo-emojis-match').isVisible().catch(() => false))) {
        await app.getByTestId('nulo-emojis-match').click();
        log('app: told it the emojis match');
      }
      if (!step && (await app.getByTestId('switch-wallet').isVisible().catch(() => false))) {
        cards = await cardsShown(app);
        if (cards >= 5) break;
      }
      await app.waitForTimeout(1000);
    }
    await shot(app, 'connected');
    if (cards < 5) throw new Error(`connected without five cards to play (shows ${cards})`);
    log(`connected as a Nulo player, holding ${cards} cards`);
    if (CONNECT_ONLY) {
      result = 'pass';
      detail = `connected cards=${cards} nuloApprovals=${approver.approvals.length}`;
    } else {
      const game = await playTheBot(app, approver.approvals);
      result = game.ok ? 'pass' : 'fail';
      detail = game.summary;
    }
  } finally {
    // Leave a game rather than just closing it: an abandoned game holds the
    // bot until its watchdog fires, and nobody else can get an opponent.
    const leave = app.getByRole('button', { name: /Leave/i }).first();
    if (await leave.isVisible({ timeout: 3000 }).catch(() => false)) {
      await leave.click().catch(() => {});
      log('left the game so the bot is free');
      await app.waitForTimeout(3000);
    }
    await approver.stop();
  }
} catch (e) {
  detail = `stopped: ${String((e as Error).message ?? e).split('\n')[0].slice(0, 300)}`;
  log(detail);
} finally {
  await ctx.close();
}
console.log(`RESULT: ${result} ${detail} (screens and logs in ${SHOT_DIR})`);
process.exit(result === 'pass' ? 0 : 1);

/** One game against the arena bot, driven like prod-play.mts: clicks through the DOM, reads through the testkit. */
async function playTheBot(app: Page, approvals: string[]): Promise<{ ok: boolean; summary: string }> {
  const before = await phase(app);
  const startCards: number = before?.ownedCardIds.length ?? 0;
  const startTokens: number = before?.tokenBalance ?? 0;
  if (await app.getByTestId('tutorial-skip').isVisible().catch(() => false)) await app.getByTestId('tutorial-skip').click();
  await app.getByTestId('menu-play').click();
  await app.waitForTimeout(3000);
  for (const pick of (await app.locator('[data-testid^="card-select-"]').all()).slice(0, 5)) await pick.click().catch(() => {});
  await app.waitForTimeout(1000);
  const queue = app.getByRole('button', { name: /queue|play|confirm|find/i }).first();
  if (await queue.isVisible().catch(() => false)) await queue.click();
  await shot(app, 'queued');
  log('queued — the bot joins after ~30s with nobody else');

  const matchBy = Date.now() + 35 * 60_000;
  while (Date.now() < matchBy && !/Your Turn|Opponent's Turn/i.test(await bodyText(app))) await app.waitForTimeout(3000);
  if (!/Your Turn|Opponent's Turn/i.test(await bodyText(app))) return { ok: false, summary: 'never matched' };
  await shot(app, 'in-game');
  log('matched — playing');

  let moves = 0;
  for (let move = 0; move < 9; move++) {
    const ready = await app.waitForFunction(() => {
      const p = (window as any).__triadTest?.phase();
      return !!p && (p.ws.gameOver !== null || (
        p.game?.status === 'playing' && p.game.isMyTurn && p.interaction !== null &&
        !p.interaction.flying && !p.interaction.cascading && p.interaction.selectedCardIndex === null));
    }, undefined, { timeout: 15 * 60_000, polling: 1000 }).then(() => true, () => false);
    if (!ready) { log('never became ready to move'); break; }
    const now = await phase(app);
    if (now?.ws.gameOver || now?.game?.status !== 'playing') break;
    const board = now.game.board as { cardId: number | null }[][];
    const empty = board.flatMap((row, r) => row.map((c, col) => ({ r, col, free: c.cardId === null }))).find((c) => c.free);
    if (!empty) break;
    const hand = await app.evaluate(() => (window as any).__triadTest.getScreenXY({ type: 'hand', index: 0 }));
    const cell = await app.evaluate((t) => (window as any).__triadTest.getScreenXY({ type: 'cell', row: t.r, col: t.col }), empty);
    if (!hand || !cell) { log('the board is not projectable'); break; }
    await app.mouse.click(hand.x, hand.y);
    await app.waitForTimeout(600);
    await app.mouse.click(cell.x, cell.y);
    const wanted = board.flat().filter((c) => c.cardId !== null).length + 1;
    const landed = await app.waitForFunction((n) => {
      const p = (window as any).__triadTest?.phase();
      return !!p && (p.ws.gameOver || (p.game?.board.flat().filter((c: any) => c.cardId !== null).length ?? 0) >= n);
    }, wanted, { timeout: 5 * 60_000, polling: 1000 }).then(() => true, () => false);
    if (!landed) { log(`move ${move + 1} did not land`); break; }
    log(`move ${++moves}: [${empty.r},${empty.col}]`);
  }

  const overBy = Date.now() + 20 * 60_000;
  while (Date.now() < overBy && !/Game Over/i.test(await bodyText(app))) await app.waitForTimeout(3000);
  await shot(app, 'game-over');
  const winner: string = (await phase(app))?.ws.gameOver?.winner ?? 'unknown';
  log(`game over: ${winner}`);

  // The winner settles (in Nulo); a loser waits for the bot to settle and hand its cards back.
  let settled = false;
  if (winner === 'player1') {
    const claimable = await app.locator('[data-testid^="settle-card-"]').all();
    if (claimable.length) {
      log(`claiming ${await claimable[0].getAttribute('data-testid')} and settling — Nulo approves the tx`);
      await claimable[0].click();
      settled = await app.waitForFunction(() => (window as any).__triadTest?.phase()?.chain.settleTxStatus === 'confirmed',
        undefined, { timeout: 25 * 60_000, polling: 2000 }).then(() => true, () => false);
    } else log('no claimable card offered');
  } else {
    settled = await app.waitForFunction((draw) => {
      const p = (window as any).__triadTest?.phase();
      if (!p) return false;
      const theirs = p.chain.opponentSettled === true && p.chain.takenCardId !== null;
      return draw ? (theirs || p.chain.settleTxStatus === 'confirmed') : theirs;
    }, winner === 'draw', { timeout: 25 * 60_000, polling: 2000 }).then(() => true, () => false);
  }
  log(settled ? 'settlement confirmed' : 'settlement NOT seen');
  await shot(app, 'settled');

  const wantCards = startCards + (winner === 'player1' ? 1 : winner === 'draw' ? 0 : -1);
  const wantTokens = startTokens + 20;
  const cardsOk = await app.waitForFunction((n) => ((window as any).__triadTest?.phase()?.ownedCardIds.length ?? -1) === n,
    wantCards, { timeout: 10 * 60_000, polling: 2000 }).then(() => true, () => false);
  const tokensOk = await app.waitForFunction((n) => ((window as any).__triadTest?.phase()?.tokenBalance ?? 0) >= n,
    wantTokens, { timeout: 6 * 60_000, polling: 2000 }).then(() => true, () => false);
  const end = await phase(app);
  const ok = settled && cardsOk && tokensOk;
  return {
    ok,
    summary: `winner=${winner} moves=${moves} cards=${end?.ownedCardIds.length}/${wantCards} ` +
      `tokens=${end?.tokenBalance}/${wantTokens} settled=${settled} nuloApprovals=${approvals.length}`,
  };
}
