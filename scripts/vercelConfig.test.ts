/**
 * The site has one origin: https://www.aztec-arena.com.
 *
 * Vercel also serves every production build at the project's default domain,
 * aztec-arena.vercel.app. A player who landed there got a broken game: the relay
 * accepts only the origins in its ALLOWED_ORIGINS, and its log shows it
 * rejecting that one (21 November 2026). Allowing it would not help either: the
 * wallet's keys and PXE live in the origin's own storage, so one person on two
 * origins is two accounts with two collections. So the default domain redirects
 * to the real one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname ?? __dirname, '..');

interface Redirect {
  source: string;
  destination: string;
  permanent?: boolean;
  has?: { type: string; value: string }[];
}

describe('vercel.json', () => {
  it('sends the Vercel default domain to the one real origin, path and all', () => {
    const config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
    const redirect = ((config.redirects ?? []) as Redirect[]).find(r =>
      (r.has ?? []).some(h => h.type === 'host' && h.value === 'aztec-arena.vercel.app'),
    );
    expect(redirect, 'aztec-arena.vercel.app is not redirected').toBeDefined();
    expect(redirect).toMatchObject({
      source: '/:path*',
      destination: 'https://www.aztec-arena.com/:path*',
      permanent: true,
    });
  });
});
