// Builds the test page (harness/page.ts) into one script, once per Playwright worker. The page
// is bundled here and served by the lane rather than added to the app: S6-1 adds no screen.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type { StaticFile } from './lane';

const entry = fileURLToPath(new URL('./harness/page.ts', import.meta.url));
// The second page (S6-3) drives the app's own field client code: src/lib/field-db.ts and the rest.
const fieldEntry = fileURLToPath(new URL('./harness/field.ts', import.meta.url));
const tsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url));

const PAGE = `<!doctype html><meta charset="utf-8"><title>offline harness</title><script src="/__harness/page.js"></script><body>offline harness</body>`;
const FIELD_PAGE = `<!doctype html><meta charset="utf-8"><title>field harness</title><script src="/__harness/field.js"></script><body>field harness</body>`;

let built: Promise<Record<string, StaticFile>> | undefined;

export function harnessFiles(): Promise<Record<string, StaticFile>> {
  built ??= build({
    entryPoints: { page: entry, field: fieldEntry },
    outdir: 'out',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    tsconfig,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
  }).then((result) => {
    const script = (name: string) => {
      const file = result.outputFiles.find((output) => output.path.endsWith(`/out/${name}.js`));
      if (!file) throw new Error(`the harness bundle has no ${name}.js`);
      return { type: 'text/javascript; charset=utf-8', body: Buffer.from(file.contents) };
    };
    return {
      '/__harness/': { type: 'text/html; charset=utf-8', body: PAGE },
      '/__harness/page.js': script('page'),
      '/__harness/field/': { type: 'text/html; charset=utf-8', body: FIELD_PAGE },
      '/__harness/field.js': script('field'),
    };
  });
  return built;
}
