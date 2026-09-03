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
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join, basename } from 'path';

const NARGO = `${process.env.HOME}/.aztec/current/internal-bin/nargo`;

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
  // Track whether we are inside a #[test] function: mutating a test's own
  // assertion proves nothing about the code, and it inflates the survivor count
  // with noise. (game_move:1581 was exactly that.)
  let inTest = false;
  lines.forEach((line, i) => {
    if (/^\s*#\[test/.test(line)) { inTest = true; return; }
    // A top-level `fn` with no #[test] above it ends the test body.
    if (/^(pub )?fn /.test(line)) inTest = false;
    if (inTest) return;
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    const m = line.match(/^(\s*)assert\((.+)$/);
    if (!m) return;
    out.push({ line: i, original: line, mutated: `${m[1]}assert(true);` });
  });
  return out;
}

function runTests(t) {
  try {
    const oracle = t.txe ? ' --oracle-resolver http://127.0.0.1:8081' : '';
    execSync(`${NARGO} test --package ${t.pkg}${oracle}`, {
      cwd: t.cwd, stdio: 'pipe', timeout: 20 * 60_000,
    });
    return 'passed';            // suite green WITH the mutation => survived
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '');
    if (/tests? failed|Failed assertion|error:/i.test(out)) return 'killed';
    return 'error';             // did not compile or ran out of time
  }
}

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

  const backup = `/tmp/mutate-${basename(t.src)}.bak`;
  copyFileSync(t.src, backup);
  const survivors = [];
  try {
    for (const [n, mut] of chosen.entries()) {
      const lines = readFileSync(backup, 'utf8').split('\n');
      lines[mut.line] = mut.mutated;
      writeFileSync(t.src, lines.join('\n'));
      const verdict = runTests(t);
      if (verdict === 'passed') {
        survivors.push(mut);
        console.log(`  SURVIVED  ${t.src}:${mut.line + 1}  ${mut.original.trim().slice(0, 78)}`);
      } else {
        process.stdout.write(`  [${n + 1}/${chosen.length}] ${verdict}\r`);
      }
    }
  } finally {
    copyFileSync(backup, t.src);   // always restore, including on Ctrl-C paths
  }

  console.log(`\n${name}: ${survivors.length} survivor(s) of ${chosen.length}`);
  if (survivors.length) {
    console.log('  Survivors are assertions no test UNIQUELY depends on. Each is either');
    console.log('  genuinely untested (a hole) or redundantly enforced (fine). Triage each;');
    console.log('  do not report the count as a defect count.');
  }
}
