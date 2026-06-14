/**
 * Probe that the leaked-browser reaper actually works. The campaign launches one
 * detached Chromium per player (own process group) for GPU isolation; Playwright
 * only kills those on a graceful worker exit, so a SIGKILLed worker orphans them
 * and they leaked across runs (the repeatable-acceptance cleanup gap).
 *
 * This reproduces the leak and proves the fix end-to-end: launch a browser,
 * register its group-leader pid, then — WITHOUT disposing it (the leak) — run
 * killRegisteredBrowsers and assert the process group is gone and the registry
 * cleared. Run manually: `npx tsx scripts/probe-browser-cleanup.ts`.
 */
import { launchIsolatedBrowser } from '../src/browser.js';
import { playwrightChromiumLeaders, registerBrowser, killRegisteredBrowsers } from '../src/stack.js';

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const before = playwrightChromiumLeaders();
const { browser } = await launchIsolatedBrowser();
void browser; // intentionally never closed — this IS the leak the reaper must catch
const newPids = [...playwrightChromiumLeaders()].filter(pid => !before.has(pid));
console.log(`new chromium group-leader pid(s): ${JSON.stringify(newPids)}`);
if (newPids.length !== 1) {
  console.error(`FAIL: expected exactly 1 new leader across the launch, got ${newPids.length}`);
  process.exit(1);
}
for (const pid of newPids) registerBrowser(pid, 'probe');
console.log(`alive before reap: ${JSON.stringify(newPids.map(alive))}`);

const killed = await killRegisteredBrowsers();
await new Promise(r => setTimeout(r, 1500));
const survivors = newPids.filter(alive);
console.log(`reaped=${killed} survivors=${JSON.stringify(survivors)}`);

const ok = killed === newPids.length && survivors.length === 0;
console.log(ok ? 'PASS: leaked browser process group reaped, registry cleared' : 'FAIL: a leaked browser survived');
process.exit(ok ? 0 : 1);
