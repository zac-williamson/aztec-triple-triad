/**
 * systemd unit files, checked for keys in the wrong section.
 *
 * systemd does not fail on a misplaced key. It logs
 *   Unknown key 'X' in section [Service], ignoring
 * at every daemon-reload and carries on with the key silently absent — and
 * `systemctl cat` still shows it, so the unit file reads correct while the
 * running service is not. That has now bitten twice: OnFailure= in [Service]
 * meant the health alert never fired for weeks, and StartLimit* in [Service]
 * meant the bot had no restart rate-limit at all. Both keys sit next to
 * options that DO belong in [Service], which is exactly why they get put there.
 *
 * This is the check that reading the file cannot give you.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const DEPLOY_DIR = join(import.meta.dirname ?? __dirname, '..', 'deploy');

/** Keys systemd only ever parses in [Unit], however much they look like [Service] options. */
const UNIT_ONLY = [
  'OnFailure', 'OnSuccess',
  'StartLimitIntervalSec', 'StartLimitInterval', 'StartLimitBurst', 'StartLimitAction',
  'Requires', 'Wants', 'After', 'Before', 'BindsTo', 'PartOf', 'Conflicts',
  'Description', 'Documentation', 'RefuseManualStart', 'RefuseManualStop',
];

/** Keys systemd only ever parses in [Service]. */
const SERVICE_ONLY = [
  'ExecStart', 'ExecStop', 'ExecReload', 'ExecStartPre', 'ExecStartPost',
  'Restart', 'RestartSec', 'Type', 'User', 'Group', 'WorkingDirectory',
  'EnvironmentFile', 'Environment', 'MemoryMax', 'CPUWeight', 'TimeoutStartSec',
];

/** Every non-comment `Key=` in the file, tagged with the section it sits in. */
function keysBySection(text: string): Array<{ section: string; key: string; line: number }> {
  const out: Array<{ section: string; key: string; line: number }> = [];
  let section = '';
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith('#') || line.startsWith(';') || line === '') return;
    const header = line.match(/^\[(\w+)\]$/);
    if (header) { section = header[1]; return; }
    const kv = line.match(/^([A-Za-z][A-Za-z0-9]*)=/);
    if (kv) out.push({ section, key: kv[1], line: i + 1 });
  });
  return out;
}

const units = readdirSync(DEPLOY_DIR).filter(f => f.endsWith('.service') || f.endsWith('.timer'));

describe('systemd units', () => {
  it('finds the units to check (a rename must not silently empty this suite)', () => {
    expect(units.length).toBeGreaterThan(0);
    expect(units).toContain('triad-bot.service');
    expect(units).toContain('triad-backend.service');
    expect(units).toContain('triad-health.service');
  });

  units.forEach(file => {
    describe(file, () => {
      const entries = keysBySection(readFileSync(join(DEPLOY_DIR, file), 'utf8'));

      it('puts every [Unit]-only key in [Unit]', () => {
        const misplaced = entries.filter(e => UNIT_ONLY.includes(e.key) && e.section !== 'Unit');
        expect(misplaced.map(m => `${m.key} in [${m.section}] at line ${m.line}`)).toEqual([]);
      });

      it('puts every [Service]-only key in [Service]', () => {
        const misplaced = entries.filter(e => SERVICE_ONLY.includes(e.key) && e.section !== 'Service');
        expect(misplaced.map(m => `${m.key} in [${m.section}] at line ${m.line}`)).toEqual([]);
      });

      it('declares a section before its first key', () => {
        const orphans = entries.filter(e => e.section === '');
        expect(orphans.map(o => `${o.key} at line ${o.line}`)).toEqual([]);
      });
    });
  });

  it('rate-limits the bot restarts it asks for — Restart=always without a limit spins forever', () => {
    const text = readFileSync(join(DEPLOY_DIR, 'triad-bot.service'), 'utf8');
    const entries = keysBySection(text);
    expect(entries.find(e => e.key === 'Restart')?.section).toBe('Service');
    expect(entries.find(e => e.key === 'StartLimitBurst')?.section).toBe('Unit');
    expect(entries.find(e => e.key === 'StartLimitIntervalSec')?.section).toBe('Unit');
  });
});
