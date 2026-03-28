/**
 * Copies the locally-installed Azguard extension to a temp directory
 * for Playwright to load as an unpacked extension.
 *
 * Azguard Chrome Web Store ID: pliilpflcmabdiapdeihifihkbdfnbmn
 */

import { cpSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';

const AZGUARD_EXTENSION_ID = 'pliilpflcmabdiapdeihifihkbdfnbmn';

/** Find the installed Azguard extension directory */
function findAzguardExtension(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE || '';

  // macOS Chrome path
  const macDir = join(home, 'Library/Application Support/Google/Chrome/Default/Extensions', AZGUARD_EXTENSION_ID);
  // Linux Chrome path
  const linuxDir = join(home, '.config/google-chrome/Default/Extensions', AZGUARD_EXTENSION_ID);

  for (const dir of [macDir, linuxDir]) {
    if (existsSync(dir)) {
      const versions = readdirSync(dir).filter(f => !f.startsWith('.'));
      if (versions.length > 0) {
        // Pick the latest version
        versions.sort();
        return join(dir, versions[versions.length - 1]);
      }
    }
  }
  return null;
}

/** Copy extension to temp dir for Playwright, returns path to unpacked extension */
export function getAzguardExtensionPath(): string {
  const installed = findAzguardExtension();
  if (!installed) {
    throw new Error(
      'Azguard extension not found. Install it from: ' +
      'https://chromewebstore.google.com/detail/azguard-wallet/' + AZGUARD_EXTENSION_ID
    );
  }

  const dest = resolve(tmpdir(), 'azguard-extension-playwright');
  cpSync(installed, dest, { recursive: true, force: true });
  console.log(`[Azguard] Extension copied to ${dest}`);
  return dest;
}

/** Azguard extension URLs */
export const AZGUARD_URLS = {
  popup: `chrome-extension://${AZGUARD_EXTENSION_ID}/src/popup/index.html`,
  setup: `chrome-extension://${AZGUARD_EXTENSION_ID}/src/setup/index.html`,
};
