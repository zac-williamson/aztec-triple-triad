/**
 * Probe which Chromium launch configuration yields a working WebGL2 context.
 * Run once per environment; the winning args go into playwright.config.ts.
 */
import { chromium } from '@playwright/test';

const candidates: { label: string; headless: boolean; args: string[] }[] = [
  { label: 'headless default', headless: true, args: [] },
  { label: 'headless --use-angle=metal', headless: true, args: ['--use-angle=metal'] },
  { label: 'headless --use-angle=gl', headless: true, args: ['--use-angle=gl'] },
  { label: 'headless swiftshader-gl', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  { label: 'headed default', headless: false, args: [] },
];

for (const candidate of candidates) {
  try {
    const browser = await chromium.launch({ headless: candidate.headless, args: candidate.args });
    const page = await browser.newPage();
    const result = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
      if (!gl) return { ok: false as const };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        ok: true as const,
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string : 'unknown',
      };
    });
    console.log(`${candidate.label}: ${result.ok ? `OK — ${result.renderer}` : 'NO CONTEXT'}`);
    await browser.close();
  } catch (err) {
    console.log(`${candidate.label}: LAUNCH FAILED — ${(err as Error).message.split('\n')[0]}`);
  }
}
