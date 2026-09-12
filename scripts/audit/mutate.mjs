/**
 * Mutation testing for the Noir contracts and circuits.
 *
 * The question an audit cannot answer by introspection is "is my test suite
 * actually load-bearing?". This answers it mechanically: weaken one assertion,
 * run the suite, and see whether anything notices. An assertion you can delete
 * with the tests still green is a hole — and unlike a code review finding, it
 * comes with a file and a line number.
 *
 * A SURVIVING mutant is a TRIAGE ITEM, not automatically a defect. It means the
 * assertion is not UNIQUELY load-bearing: removing it changed no test outcome.
 * There are two reasons for that and they differ enormously:
 *
 *   (a) genuinely untested — nothing exercises the property. A real hole.
 *   (b) redundantly enforced — another constraint catches the same cases.
 *       Defence in depth, and fine, though worth knowing it is load-bearing
 *       nowhere.
 *
 * Telling them apart needs a human look. Measured here: of 16 survivors in
 * game_move, four were type (a) — both state-hash checks, the opponent's score,
 * and winner correctness — and closing them took targeted tests. A test aimed
 * squarely at the column bounds check did NOT kill its mutant, because with the
 * bound gone the cell-not-empty assert catches the same input: type (b).
 *
 * So read the count as "assertions no test uniquely depends on", never as a
 * defect count. Overstating it is the fastest way to make the report ignorable.
 *
 *   node scripts/audit/mutate.mjs circuits/game_move          # one target
 *   node scripts/audit/mutate.mjs --list                      # what it would try
 *   LIMIT=10 node scripts/audit/mutate.mjs circuits/prove_hand
 *
 * Deliberately not parallel: nargo and the TXE are stateful enough that
 * concurrent runs produce flaky verdicts, and a flaky mutation report is worse
 * than none — it invites you to dismiss a real survivor as noise.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { join, basename } from 'path';

const NARGO = `${process.env.HOME}/.aztec/current/internal-bin/nargo`;

/**
 * Recovery from a kill this process cannot catch.
 *
 * The signal handlers below cover SIGINT/SIGTERM/SIGHUP. Nothing covers
 * SIGKILL, an OOM, or the power going out — and this tool holds a
 * security-critical source file in a deliberately broken state for minutes at
 * a time. So the mutated state is recorded on disk before the first edit and
 * cleared on clean exit; the next run finds the marker and puts the file back.
 *
 * Restoring from the BACKUP, never from git. The file being mutated usually has
 * uncommitted work in it, and `git checkout -- <file>` to undo a mutation
 * destroys that work along with it. (It did, here, to the whole validator
 * extraction — the mutation was one line, the revert took 400.)
 */
const MARKER = '/tmp/mutate-in-progress.json';

function recoverFromPreviousRun() {
  if (!existsSync(MARKER)) return;
  let m;
  try { m = JSON.parse(readFileSync(MARKER, 'utf8')); } catch { unlinkSync(MARKER); return; }
  if (m.backup && m.src && existsSync(m.backup)) {
    copyFileSync(m.backup, m.src);
    console.error(`  recovered: a previous run (pid ${m.pid}, ${m.startedAt}) was killed`);
    console.error(`  mid-mutation. Restored ${m.src} from ${m.backup}.`);
  } else {
    console.error(`  WARNING: a previous run left ${m.src} mutated and its backup is gone.`);
    console.error('  Check that file by hand before trusting anything built from it.');
  }
  unlinkSync(MARKER);
}

/** The nargo child, so a signal can take it down with us. */
let CHILD = null;

/**
 * Every (src, backup) pair this process has put into a mutated state.
 *
 * A registry, and the handlers below are registered ONCE, because the obvious
 * shape — register a handler per target inside the loop, closing over that
 * target — is broken in a way that is invisible until it matters. With `--all`
 * the handlers ACCUMULATE, a signal fires all of them, and the first one to run
 * calls process.exit(): the process dies inside the handler belonging to a
 * target that finished ten minutes ago, before the handler owning the file that
 * is mutated RIGHT NOW ever runs. Observed exactly that — SIGTERM during the
 * contracts/game sweep restored circuits/game_move, cleared the marker, and
 * left the contract mutated with its crash-recovery net gone.
 */
const DIRTY = new Map();

function restoreAll(why) {
  for (const [src, backup] of DIRTY) {
    try { copyFileSync(backup, src); console.error(`  ${why}: restored ${src}`); }
    catch (e) { console.error(`  ${why}: COULD NOT restore ${src}: ${e.message}`); }
  }
  DIRTY.clear();
  try { unlinkSync(MARKER); } catch { /* already gone */ }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (CHILD) { try { CHILD.kill('SIGKILL'); } catch { /* already gone */ } }
    restoreAll(sig);
    process.exit(130);
  });
}
process.on('uncaughtException', (e) => {
  restoreAll('crashed');
  console.error(`\n  ${e.message}`);
  process.exit(1);
});

/** Targets: a Noir package, the file to mutate, and how to run its tests. */
const TARGETS = {
  'circuits/game_move':   { src: 'circuits/game_move/src/main.nr',   cwd: 'circuits',          pkg: 'game_move' },
  'circuits/prove_hand':  { src: 'circuits/prove_hand/src/main.nr',  cwd: 'circuits',          pkg: 'prove_hand' },
  'circuits/card_data':   { src: 'circuits/card_data/src/lib.nr',    cwd: 'circuits',          pkg: 'card_data' },
  'contracts/game':       { src: 'packages/contracts/triple_triad_game/src/main.nr',
                            cwd: 'packages/contracts', pkg: 'triple_triad_game', txe: true },
  'contracts/nft':        { src: 'packages/contracts/triple_triad_nft/src/main.nr',
                            cwd: 'packages/contracts', pkg: 'triple_triad_nft', txe: true },
};

/**
 * One mutation per assert: replace its condition with `true`.
 *
 * Neutering rather than deleting keeps the line count and any side effects in
 * the arguments, so a survivor means "nothing checks this condition" rather
 * than "the file no longer parses".
 */
function mutationsFor(src) {
  const lines = readFileSync(src, 'utf8').split('\n');
  const out = [];
  // #[test] applies to the NEXT fn. Setting the flag on the attribute alone
  // was wrong: the test's own `fn test_x()` line then matched the "a new
  // function ends the test body" rule and cleared it immediately, so every
  // assertion inside every test was mutated. card_data reported 6 survivors of
  // 7 that way, and all but one were assertions in its own tests.
  let inTest = false, pendingTest = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#\[test/.test(line)) { pendingTest = true; continue; }
    if (/^\s*(pub )?(unconstrained )?fn /.test(line)) {
      inTest = pendingTest;
      pendingTest = false;
    }
    if (inTest) continue;
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;

    const m = line.match(/^(\s*)assert\(/);
    if (!m) continue;

    // An assert may span several lines. Consume until the parens balance, or
    // the mutation leaves dangling continuation lines and the file stops
    // compiling — which the classifier used to score as a KILL. That inflated
    // the kill rate, which is the dangerous direction for an audit tool: it
    // makes coverage look better than it is. 18 of 78 asserts in the game
    // contract are multi-line.
    let depth = 0, end = i;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
      if (depth <= 0) { end = j; break; }
    }
    // Carry the assertion MESSAGE, scanning the whole span. A multi-line
    // assert puts its message on a later line, and logging only the first left
    // 16 survivors unattributable to any invariant — which defeats
    // scripts/audit/reconcile.mjs, whose entire job is mapping message -> row.
    const span = lines.slice(i, end + 1).join(' ');
    const msg = span.match(/"([^"]+)"/);
    out.push({
      line: i, endLine: end, indent: m[1],
      original: msg ? `${line.trim()} ... "${msg[1]}"` : line.trim(),
    });
    i = end;
  }
  return out;
}

/**
 * TXE degrades over a long run. Measured: after ~116 mutants the unmutated
 * contract suite went from 12 passed to 3 passed / 9 failed, consistently, and
 * a restart fixed it. Every mutant scored after that point read as KILLED,
 * because the classifier cannot tell a mutation-induced failure from an
 * environment-induced one — so the run reported 14 survivors of 78 when the
 * true number was unknown. False kills overstate coverage, which is the
 * direction that gets an audit trusted when it should not be.
 *
 * A fresh TXE per mutant costs about 8 seconds and removes the failure mode.
 */
const TXE_PORT = 8081;

/** PIDs actually LISTENING on the TXE port. */
function txePids() {
  try {
    return execSync(`lsof -t -iTCP:${TXE_PORT} -sTCP:LISTEN`, { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return [];   // lsof exits non-zero when nothing matches
  }
}

async function restartTxe() {
  // Kill by PORT, not by command line.
  //
  // This used to be `pkill -f "aztec start --txe"`, which matches NOTHING: the
  // process that ends up listening is
  // `node --no-warnings .../aztec/dest/bin/index.js start --txe --port 8081`,
  // spawned via the `aztec` shell wrapper, and the wrapper is gone by the time
  // it is serving. So the pkill killed nothing, the freshly spawned TXE could
  // not bind the port and died immediately, and curl answered from the OLD
  // long-lived TXE — which made restartTxe report success while doing nothing
  // at all.
  //
  // That silently undid the one fix protecting this harness's most dangerous
  // failure mode. A degraded TXE fails the suite for environmental reasons, the
  // classifier cannot tell that from a mutation-induced failure, and every
  // later mutant scores as KILLED. It fails toward "covered", which is the
  // direction that gets an audit believed when it should not be. Measured
  // once: a sweep ran 66 mutants against a TXE that had been up for an hour.
  const before = txePids();
  for (const pid of before) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  for (let i = 0; i < 40 && txePids().length; i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (txePids().length) return false;   // port still held; nothing good follows

  spawn(`${process.env.HOME}/.aztec/current/bin/aztec`,
        ['start', '--txe', '--port', String(TXE_PORT)],
        { detached: true, stdio: 'ignore' }).unref();

  for (let i = 0; i < 60; i++) {
    const now = txePids();
    // A NEW pid on the port, not merely something answering: the whole bug
    // above was an old process answering for a new one that never started.
    if (now.length && !now.some((pid) => before.includes(pid))) {
      try {
        execSync(`curl -s --max-time 2 http://127.0.0.1:${TXE_PORT}`, { stdio: 'ignore' });
        return true;
      } catch { /* listening but not ready yet */ }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Run the suite as a CHILD, awaited — not `execSync`.
 *
 * This is what makes the signal handlers below work at all. `execSync` blocks
 * node's single thread for the whole ~60s run, and a queued SIGTERM handler
 * cannot run while the thread is blocked: the handler added for exactly this
 * purpose was unreachable in practice, and a `pkill -f mutate.mjs` still left
 * the mutated file on disk. Awaiting a spawned child keeps the loop free, so
 * the signal is delivered the moment it arrives.
 */
function runNargo(t) {
  return new Promise((resolve) => {
    const oracle = t.txe ? ['--oracle-resolver', 'http://127.0.0.1:8081'] : [];
    const child = spawn(NARGO, ['test', '--package', t.pkg, ...oracle],
                        { cwd: t.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    CHILD = child;
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } },
                             20 * 60_000);
    child.on('close', (code) => { clearTimeout(timer); CHILD = null; resolve({ code, out }); });
    child.on('error', (e) => { clearTimeout(timer); CHILD = null; resolve({ code: -1, out: String(e) }); });
  });
}

/**
 * A mutation run against an already-failing suite measures nothing. Prove the
 * baseline is green before touching anything, and abort loudly if it is not.
 */
async function baselineIsGreen(t) {
  const { code, out } = await runNargo(t);
  return code === 0 && /tests? passed/.test(out) && !/tests? failed/.test(out);
}

async function runTests(t) {
  const { code, out } = await runNargo(t);
  if (code === 0) return 'passed';   // suite green WITH the mutation => survived
  // ORDER MATTERS. A mutant that does not COMPILE is not a killed mutant — it
  // is no evidence at all, and counting it as a kill overstates coverage.
  // Test failures are reported by nargo as "N tests failed" / "Failed
  // assertion"; anything else carrying a compiler diagnostic is invalid.
  if (/\d+ tests? failed|Failed assertion/i.test(out)) return 'killed';
  if (/error(\[|:)|Aborting|could not compile|expected .* but found/i.test(out)) return 'invalid';
  return 'error';
}

recoverFromPreviousRun();

const arg = process.argv[2];
if (!arg || arg === '--help') {
  console.log('usage: node scripts/audit/mutate.mjs <target|--list|--all>');
  console.log('targets:', Object.keys(TARGETS).join(', '));
  process.exit(arg ? 0 : 1);
}

const names = arg === '--all' || arg === '--list' ? Object.keys(TARGETS) : [arg];
for (const name of names) {
  const t = TARGETS[name];
  if (!t) { console.error(`unknown target: ${name}`); process.exit(1); }
  if (!existsSync(t.src)) { console.error(`missing source: ${t.src}`); process.exit(1); }
  const muts = mutationsFor(t.src);
  if (arg === '--list') { console.log(`${name}: ${muts.length} assert(s)`); continue; }

  const limit = Number(process.env.LIMIT ?? muts.length);
  const chosen = muts.slice(0, limit);
  console.log(`\n${name}: mutating ${chosen.length} of ${muts.length} assert(s) in ${basename(t.src)}`);

  if (t.txe && !await restartTxe()) {
    console.error(`  ABORT: could not start a fresh TXE on port ${TXE_PORT}.`);
    console.error('  Every mutant would run against a degraded or absent TXE and score as');
    console.error('  KILLED for environmental reasons — a silently inflated coverage number,');
    console.error('  which is worse than no number.');
    process.exit(2);
  }
  if (!await baselineIsGreen(t)) {
    console.error(`  ABORT: ${name}'s test suite is RED before any mutation.`);
    console.error('  Mutation verdicts against a failing suite are meaningless — fix the');
    console.error('  suite (or the environment) first. For TXE targets, a restart usually does it.');
    process.exit(2);
  }

  // Keyed by TARGET, not by basename. Four of the five targets are called
  // `main.nr`, so `/tmp/mutate-main.nr.bak` was one shared file: sweeping two
  // of them in sequence had each clobber the other's backup, and a restore —
  // including the crash recovery above — could write one Noir package's source
  // over another's.
  const backup = `/tmp/mutate-${name.replace(/[^a-z0-9]+/gi, '_')}.bak`;
  copyFileSync(t.src, backup);

  // RESTORE ON SIGNAL, not only on normal exit.
  //
  // The finally below does not run when node is killed. A `pkill -f mutate.mjs`
  // — which is the obvious way to stop a two-hour sweep — therefore left the
  // MUTATED source on disk, and it was committed four times before a routine
  // `git status` caught it. The assertion left neutered was the binding of a
  // player's move proof to their committed hand: with it gone, a player can
  // play cards they never staked.
  //
  // A tool that edits security-critical source in place must put restoring it
  // ahead of everything else, including its own exit code.
  writeFileSync(MARKER, JSON.stringify(
    { src: t.src, backup, pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
  DIRTY.set(t.src, backup);
  const survivors = [];
  const invalid = [];
  try {
    for (const [n, mut] of chosen.entries()) {
      const lines = readFileSync(backup, 'utf8').split('\n');
      lines[mut.line] = `${mut.indent}assert(true);`;
      // Blank the rest of the span rather than deleting, so every later line
      // keeps its number and a survivor's location stays quotable.
      for (let k = mut.line + 1; k <= mut.endLine; k++) lines[k] = '';
      writeFileSync(t.src, lines.join('\n'));
      // Fresh TXE per mutant: see restartTxe(). Without it a degraded TXE turns
      // every later mutant into a false kill.
      if (t.txe && !await restartTxe()) {
        throw new Error(`could not restart TXE before mutant ${n + 1}; aborting rather than `
          + 'scoring the rest against a dead one');
      }
      const verdict = await runTests(t);
      if (verdict === 'passed') {
        survivors.push(mut);
        console.log(`  SURVIVED  ${t.src}:${mut.line + 1}  ${mut.original.slice(0, 78)}`);
      } else if (verdict === 'invalid') {
        invalid.push(mut);
        console.log(`  invalid   ${t.src}:${mut.line + 1}  (did not compile — no evidence)`);
      } else {
        process.stdout.write(`  [${n + 1}/${chosen.length}] ${verdict}      \r`);
      }
    }
  } finally {
    copyFileSync(backup, t.src);   // always restore, including on Ctrl-C paths
    DIRTY.delete(t.src);
    try { unlinkSync(MARKER); } catch { /* already gone */ }
  }

  // Snapshot the result so the register can be checked against it in CI. F7
  // was that the register's statuses were my judgement; a committed snapshot
  // plus scripts/audit/register.test.ts makes them a measurement that drift
  // cannot quietly undo.
  if (process.env.MUTATION_JSON) {
    const out = process.env.MUTATION_JSON;
    let all = {};
    try { all = JSON.parse(readFileSync(out, 'utf8')); } catch { /* first run */ }
    all[name] = {
      measuredAt: new Date().toISOString().slice(0, 10),
      asserts: chosen.length,
      invalid: invalid.length,
      survivors: survivors.map(m => ({
        line: m.line + 1,
        // The MESSAGE is the stable key — line numbers move on every edit.
        message: (m.original.match(/"([^"]+)"/) || [null, null])[1],
        source: m.original.slice(0, 120),
      })),
    };
    writeFileSync(out, JSON.stringify(all, null, 2) + '\n');
    console.log(`  snapshot -> ${out}`);
  }

  const evaluated = chosen.length - invalid.length;
  console.log(`\n${name}: ${survivors.length} survivor(s) of ${evaluated} evaluated` +
              (invalid.length ? ` (${invalid.length} invalid, not counted either way)` : ''));
  if (survivors.length) {
    console.log('  Survivors are assertions no test UNIQUELY depends on. Each is either');
    console.log('  genuinely untested (a hole) or redundantly enforced (fine). Triage each;');
    console.log('  do not report the count as a defect count.');
  }
}
