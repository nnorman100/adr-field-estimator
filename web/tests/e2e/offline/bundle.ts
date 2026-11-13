// Builds the test page (harness/page.ts) into one script, once per Playwright worker. The page
// is bundled here and served by the lane rather than added to the app: S6-1 adds no screen.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type { StaticFile } from './lane';

const entry = fileURLToPath(new URL('./harness/page.ts', import.meta.url));
const tsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url));

const PAGE = `<!doctype html><meta charset="utf-8"><title>offline harness</title><script src="/__harness/page.js"></script><body>offline harness</body>`;

let built: Promise<Record<string, StaticFile>> | undefined;

export function harnessFiles(): Promise<Record<string, StaticFile>> {
  built ??= build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    tsconfig,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
  }).then((result) => ({
    '/__harness/': { type: 'text/html; charset=utf-8', body: PAGE },
    '/__harness/page.js': { type: 'text/javascript; charset=utf-8', body: Buffer.from(result.outputFiles[0]!.contents) },
  }));
  return built;
}
