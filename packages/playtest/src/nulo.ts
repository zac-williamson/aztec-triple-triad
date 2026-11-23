/**
 * Driving the real Nulo wallet extension (github.com/nulo-sh/nulo) the way a
 * player would, for scripts/nulo-play.mts.
 *
 * Nothing about Nulo is simulated: its release build is downloaded and checked
 * against the release's own SHASUMS256, loaded into Chromium, onboarded with a
 * throwaway wallet, and every approval window it opens is answered by clicking
 * its buttons. The selectors are Nulo's data-testids.
 *
 * Everything lives under .artifacts/nulo (gitignored): the unpacked build, the
 * browser profile holding the wallet, and that wallet's password and recovery
 * phrase (0600). The wallet only ever holds test Fee Juice.
 */
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { ARTIFACTS_DIR } from './env.js';

export const NULO_VERSION = process.env.NULO_VERSION ?? '1.3.0';
export const NULO_DIR = process.env.NULO_DIR ?? resolve(ARTIFACTS_DIR, 'nulo');

export interface NuloPaths {
  /** The unpacked Chrome build. */
  extension: string;
  /** The Chromium profile that holds the wallet. */
  profile: string;
  /** The wallet's password (generated on first use). */
  password: string;
  /** The wallet's recovery phrase. */
  phrase: string;
}

export function nuloPaths(version = NULO_VERSION, dir = NULO_DIR): NuloPaths {
  return {
    extension: resolve(dir, `nulo-${version}`, 'chrome'),
    profile: resolve(dir, 'profile'),
    password: resolve(dir, 'password.txt'),
    phrase: resolve(dir, 'recovery-phrase.txt'),
  };
}

/** Download Nulo's Chrome release and check it against the release's SHASUMS256, once. */
export async function ensureNuloExtension(paths: NuloPaths, version = NULO_VERSION): Promise<void> {
  if (existsSync(resolve(paths.extension, 'manifest.json'))) return;
  const base = `https://github.com/nulo-sh/nulo/releases/download/v${version}`;
  const zipName = `nulo-chrome-${version}.zip`;
  const [zip, sums] = await Promise.all([
    fetch(`${base}/${zipName}`).then(async (r) => {
      if (!r.ok) throw new Error(`${zipName}: HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    }),
    fetch(`${base}/SHASUMS256.txt`).then(async (r) => {
      if (!r.ok) throw new Error(`SHASUMS256.txt: HTTP ${r.status}`);
      return r.text();
    }),
  ]);
  const want = sums.split('\n').find((l) => l.trim().endsWith(zipName))?.trim().split(/\s+/)[0];
  const got = createHash('sha256').update(zip).digest('hex');
  if (!want || want !== got) throw new Error(`${zipName}: checksum ${got} does not match the release's (${want ?? 'none listed'})`);
  mkdirSync(paths.extension, { recursive: true });
  const zipPath = resolve(paths.extension, '..', zipName);
  writeFileSync(zipPath, zip);
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', paths.extension]);
  if (!existsSync(resolve(paths.extension, 'manifest.json'))) throw new Error(`${zipName} has no manifest.json at its root`);
}

/** A headless Chromium with Nulo loaded into the wallet's profile. */
export async function launchWithNulo(paths: NuloPaths): Promise<{ ctx: BrowserContext; extensionId: string }> {
  const ctx = await chromium.launchPersistentContext(paths.profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${paths.extension}`, `--load-extension=${paths.extension}`],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 30_000 }));
  return { ctx, extensionId: new URL(sw.url()).host };
}

const popupUrl = (id: string, route: string) => `chrome-extension://${id}/src/popup/index.html#${route}`;

function readOrCreatePassword(path: string): string {
  if (existsSync(path)) return readFileSync(path, 'utf-8').trim();
  // Nulo wants a strong password: mixed case, digits and a symbol.
  const password = `Nulo-${randomBytes(12).toString('base64url')}-7a!`;
  writeFileSync(path, `${password}\n`, { mode: 0o600 });
  return password;
}

/**
 * Open Nulo's popup ready to use: onboard a new wallet if the profile has none,
 * unlock it if it is locked, and put it on the Aztec testnet. Returns the
 * popup and the account's address.
 */
export async function openNulo(
  ctx: BrowserContext,
  id: string,
  paths: NuloPaths,
  log: (m: string) => void,
): Promise<{ popup: Page; address: string }> {
  const password = readOrCreatePassword(paths.password);
  const popup = await ctx.newPage();
  await popup.goto(popupUrl(id, '/popup/general'));
  await popup.waitForSelector('[data-testid="start-pending"]', { state: 'detached', timeout: 120_000 }).catch(() => {});
  await popup.waitForTimeout(1500);

  const onboarding = ctx.pages().find((p) => p.url().includes(`${id}/src/onboarding`));
  if (onboarding || !(await hasWallet(popup))) {
    log('Nulo has no wallet in this profile: creating one');
    await onboard(onboarding ?? (await ctx.newPage()), id, password, paths.phrase);
    await popup.goto(popupUrl(id, '/popup/general'));
    await popup.waitForTimeout(1500);
  }
  if (popup.url().includes('/popup/auth')) {
    const box = popup.getByTestId('auth-form').locator('input').first();
    await box.waitFor({ state: 'visible', timeout: 60_000 });
    await box.fill(password);
    await popup.getByTestId('auth-submit').click();
  }
  await popup.waitForSelector('[data-testid="account-address-copy"]', { timeout: 120_000 });

  const network = (await popup.getByTestId('network-button').textContent())?.trim() ?? '';
  if (!network.includes('Testnet')) {
    await popup.getByTestId('network-button').click();
    await popup.waitForSelector('[data-testid="network-row"][data-network-name="Testnet"]', { timeout: 10_000 });
    // The row's own click handler ignores synthetic pointer events; a DOM click works.
    await popup.evaluate(() => document.querySelector('[data-testid="network-row"][data-network-name="Testnet"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    await popup.getByTestId('network-set-active').click();
    await popup.waitForFunction(() => (document.querySelector('[data-testid="network-button"]')?.textContent ?? '').includes('Testnet'),
      undefined, { timeout: 30_000 });
    await popup.goto(popupUrl(id, '/popup/general'));
    await popup.waitForSelector('[data-testid="account-address-copy"]', { timeout: 60_000 });
  }

  // The header shows a shortened address; the copy button has the whole one.
  await popup.evaluate(() => {
    (window as any).__copied = null;
    navigator.clipboard.writeText = async (t: string) => { (window as any).__copied = t; };
  });
  await popup.getByTestId('account-address-copy').click();
  const address = await popup.waitForFunction(() => (window as any).__copied as string | null, undefined, { timeout: 10_000 })
    .then((h) => h.jsonValue() as Promise<string>);
  return { popup, address };
}

async function hasWallet(popup: Page): Promise<boolean> {
  return popup.url().includes('/popup/auth') || (await popup.getByTestId('account-address-copy').isVisible().catch(() => false));
}

/** Nulo's first-run flow: a password wallet, its phrase saved (0600) and checked back. */
async function onboard(page: Page, id: string, password: string, phrasePath: string): Promise<void> {
  if (!page.url().includes('/onboarding')) await page.goto(`chrome-extension://${id}/src/onboarding/index.html#/onboarding/welcome`);
  await page.getByTestId('onboarding-welcome-create').click();
  await page.getByTestId('legal-consent-checkbox').click();
  await page.getByTestId('legal-continue').click();
  const pw = page.getByPlaceholder('Strong password');
  // A passkey is the default; ask for a password instead.
  if (!(await pw.isVisible({ timeout: 5000 }).catch(() => false))) await page.getByTestId('onboarding-method-password').click();
  await pw.fill(password);
  const repeat = page.getByPlaceholder(/repeat/i);
  if (await repeat.isVisible().catch(() => false)) await repeat.fill(password);
  await page.getByTestId('onboarding-submit-create').click();
  await page.getByTestId('onboarding-phrase-word').first().waitFor({ timeout: 60_000 });
  const words = (await page.getByTestId('onboarding-phrase-word').allTextContents()).map((w) => w.trim().split(/\s+/).pop()!);
  writeFileSync(phrasePath, `${words.join(' ')}\n`, { mode: 0o600 });
  await page.getByTestId('onboarding-phrase-saved').click();
  const question = '[data-testid="onboarding-phrase-check-question"]';
  await page.waitForSelector(question, { timeout: 30_000 });
  const positions = await page.$$eval(question, (all) => all.map((q) => Number(q.getAttribute('data-position'))));
  for (const position of positions) {
    const picked = await page.$$eval(
      `${question}[data-position="${position}"] [data-testid="onboarding-phrase-check-choice"]`,
      (choices, word) => {
        const choice = (choices as HTMLInputElement[]).find((c) => c.value === word);
        choice?.click();
        return choice?.checked === true;
      },
      words[position - 1],
    );
    if (!picked) throw new Error(`Nulo onboarding: no choice for word ${position}`);
  }
  await page.getByTestId('onboarding-phrase-check-confirm').click();
  await page.getByTestId('onboarding-done-open').waitFor({ timeout: 60_000 });
  await page.close();
}

const textOf = (p: Page, testid: string) =>
  p.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.textContent ?? null, testid).catch(() => null);
const visible = (p: Page, testid: string) => p.getByTestId(testid).first().isVisible().catch(() => false);
const describeWindow = (p: Page) => p.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 400)).catch(() => '');

export interface NuloApprover {
  /** What each approved transaction window said, in order. */
  approvals: string[];
  /** True once Nulo's emoji grid has been checked against the app's and confirmed. */
  emojisConfirmed(): boolean;
  stop(): Promise<void>;
}

/**
 * Answer Nulo's windows for as long as it runs, as a player who approves what
 * the game asks: allow discovery, confirm the emoji grid ONLY if it matches the
 * app's, grant the permissions, and approve each transaction paying with
 * `fee` (`public` or `private` Fee Juice; never the sponsor).
 */
export function startNuloApprover(
  ctx: BrowserContext,
  id: string,
  app: Page,
  opts: { fee: 'public' | 'private'; log: (m: string) => void; shot?: (p: Page, label: string) => Promise<void> },
): NuloApprover {
  const { fee, log } = opts;
  const approvals: string[] = [];
  let confirmed = false;
  let stopped = false;
  const seen = new Map<Page, string>();
  const reported = new Set<string>();
  const loop = (async () => {
    while (!stopped) {
      for (const p of ctx.pages()) {
        if (!p.url().startsWith(`chrome-extension://${id}/`) || !p.url().includes('/windows/')) continue;
        if (seen.get(p) !== p.url()) {
          seen.set(p, p.url());
          log(`Nulo opened ${(p.url().split('#')[1] ?? '').split('?')[0]}`);
        }
        try {
          if (await visible(p, 'discover-allow-btn')) {
            await p.getByTestId('discover-allow-btn').click();
            log('Nulo: allowed the app to find it');
          } else if (await visible(p, 'verify-confirm-btn')) {
            const theirs = (await textOf(p, 'verify-emoji-grid'))?.replace(/\s+/g, '') ?? null;
            const ours = (await textOf(app, 'nulo-emojis'))?.replace(/\s+/g, '') ?? null;
            if (theirs && ours && theirs === ours) {
              await p.getByTestId('verify-confirm-btn').click();
              confirmed = true;
              log(`Nulo: the emojis match (${theirs})`);
            } else if (theirs && ours) {
              log(`EMOJI MISMATCH: Nulo ${theirs}, app ${ours} — not confirming`);
            }
          } else if (await visible(p, 'cap-approve-btn')) {
            await opts.shot?.(p, 'nulo-permissions');
            await p.getByTestId('cap-approve-btn').click();
            log('Nulo: granted the permissions');
          } else if (await visible(p, 'execute-confirm-btn')) {
            const trigger = p.getByTestId('send-fee-method-trigger');
            if (await trigger.isVisible().catch(() => false)) {
              const method = await trigger.getAttribute('data-fee-method');
              if (method !== fee) {
                // The menu can be slow to fill; once open it covers the
                // trigger, so a retry picks from the open menu instead.
                const option = p.getByTestId(`send-fee-method-${fee}`);
                if (!(await option.isVisible().catch(() => false))) await trigger.click({ timeout: 10_000 });
                await option.click({ timeout: 30_000 });
                log(`Nulo: paying with ${fee} Fee Juice (was ${method})`);
                await p.waitForTimeout(1000);
              }
            }
            const confirm = p.getByTestId('execute-confirm-btn');
            if (await confirm.isEnabled().catch(() => false)) {
              const what = await describeWindow(p);
              await opts.shot?.(p, 'nulo-approve');
              await confirm.click();
              approvals.push(what);
              log(`Nulo: approved #${approvals.length} — ${what.slice(0, 200)}`);
            }
          }
        } catch (e) {
          // A window that closed under us; the next pass sees the current set.
          if (/closed|Target/.test(String(e))) continue;
          log(`Nulo approver: ${String(e).split('\n')[0]}`);
          const key = `${p.url()} ${String(e).split('\n')[0]}`;
          if (!reported.has(key)) {
            reported.add(key);
            await opts.shot?.(p, 'nulo-stuck');
            const ids = await p.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid]')]
              .map((el) => el.getAttribute('data-testid')))].join(' ')).catch(() => '');
            log(`  window says: ${await describeWindow(p)}`);
            log(`  test ids: ${ids.slice(0, 900)}`);
          }
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
  return {
    approvals,
    emojisConfirmed: () => confirmed,
    stop: async () => { stopped = true; await loop; },
  };
}
