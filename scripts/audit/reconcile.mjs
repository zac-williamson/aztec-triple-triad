/**
 * Reconcile the invariant register against mutation results.
 *
 * F7 in the audit: the register claimed VERIFIED for properties nothing tested,
 * because a status was my judgement rather than a measurement. Judgement will
 * drift again — so the register's statuses are derived here instead of asserted.
 *
 *   node scripts/audit/reconcile.mjs <mutation-log> [...]
 *
 * Reports three things, and the third is the one that found a real gap:
 *   1. invariants whose enforcing assertion SURVIVED -> must be UNVERIFIED
 *   2. invariants claimed VERIFIED in the register that appear in (1)
 *   3. surviving assertions mapped to NO invariant -> the register may be
 *      incomplete, which is how the cancel path (L5/L6) surfaced
 *
 * Deliberately reports rather than rewrites. A tool that edits the register
 * would make it agree with the tool by construction, which is not the same as
 * being true, and this audit has already been bitten by tooling that failed
 * toward the flattering answer.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname ?? __dirname, '..', '..');
const REGISTER = join(ROOT, 'docs/plan/AUDIT_INVARIANTS.md');
const MAP = JSON.parse(readFileSync(join(ROOT, 'scripts/audit/invariant-map.json'), 'utf8')).map;

const logs = process.argv.slice(2);
if (!logs.length) {
  console.error('usage: node scripts/audit/reconcile.mjs <mutation-log> [...]');
  process.exit(1);
}

/** `SURVIVED  path:123  assert(cond, "message");` -> the message. */
function survivingMessages(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.includes('SURVIVED')) continue;
    const m = line.match(/"([^"]+)"/);
    out.push({ raw: line.trim(), message: m ? m[1] : null });
  }
  return out;
}

const survivors = logs.flatMap(f => {
  if (!existsSync(f)) { console.error(`missing log: ${f}`); process.exit(1); }
  return survivingMessages(readFileSync(f, 'utf8'));
});

const broken = new Set();     // invariants with a surviving assertion
const unmapped = [];          // survivors matching no invariant
for (const s of survivors) {
  if (s.message && MAP[s.message]) broken.add(MAP[s.message]);
  else unmapped.push(s);
}

// Statuses currently claimed in the register: `| A5 | ... | `VERIFIED` | ...`
const register = readFileSync(REGISTER, 'utf8');
const claimed = new Map();
for (const m of register.matchAll(/^\|\s*([A-Z]\d+)\s*\|[^|]*\|\s*`([A-Z-]+)`\s*\|/gm)) {
  claimed.set(m[1], m[2]);
}

console.log(`survivors read: ${survivors.length}   invariants affected: ${broken.size}\n`);

const overclaimed = [...broken].filter(id => ['VERIFIED', 'MUTATION-COVERED'].includes(claimed.get(id)));
if (overclaimed.length) {
  console.log('OVERCLAIMED — register says verified, mutation says untested:');
  for (const id of overclaimed.sort()) {
    console.log(`  ${id}  register: ${claimed.get(id)}  ->  should be UNVERIFIED`);
  }
} else {
  console.log('No invariant is claimed verified while its assertion survives.');
}

console.log(`\nInvariants with at least one surviving assertion (${broken.size}):`);
console.log('  ' + [...broken].sort().join(' '));

if (unmapped.length) {
  const msgs = [...new Set(unmapped.map(u => u.message).filter(Boolean))];
  console.log(`\nUNMAPPED survivors (${msgs.length} distinct) — the register may be missing a property:`);
  for (const m of msgs) console.log(`  "${m}"`);
  const noMsg = unmapped.filter(u => !u.message).length;
  if (noMsg) console.log(`  (${noMsg} multi-line assertion(s) whose message the log truncated)`);
}
