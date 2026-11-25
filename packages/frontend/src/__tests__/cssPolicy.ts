/**
 * Read a stylesheet's `pointer-events` policy, for tests that pin which
 * elements take clicks. jsdom does no layout or hit-testing, so a click on an
 * element that `pointer-events: none` hides from the pointer still "works" in
 * a component test — the declared policy is what can be checked.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A stylesheet under `src/`, read from disk (vitest runs with cwd = packages/frontend). */
export function readStylesheet(pathFromSrc: string): string {
  return readFileSync(join(process.cwd(), 'src', pathFromSrc), 'utf8');
}

/** Map every selector → its declared `pointer-events` value (comments stripped,
 *  grouped selectors expanded, last declaration wins). */
export function pointerEventsBySelector(css: string): Record<string, string> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const map: Record<string, string> = {};
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(stripped))) {
    const pe = m[2].match(/pointer-events\s*:\s*([a-z-]+)/);
    if (!pe) continue;
    for (const sel of m[1].split(',')) map[sel.trim()] = pe[1];
  }
  return map;
}
