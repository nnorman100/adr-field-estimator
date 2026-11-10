#!/usr/bin/env node
// Bundles the migration job (src/db/job.ts) and its dependencies into one file and copies the
// numbered ledger beside it:
//
//   node scripts/build-migrate.mjs <dir>    ->  <dir>/migrate.mjs and <dir>/migrations/*.sql
//
// build-image.sh runs it (as `npm run build:migrate -- <dir>`) into the image's /app tree, and the
// Cloud Run migration job starts it there with `node migrate.mjs` (infra/dryscope/app/migrate_job.tf).
// The bundle needs nothing from node_modules at run time, so the image's traced Next.js output
// does not have to carry the migrator's dependencies.
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const web = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2];
if (!out || process.argv.length > 3) {
  console.error('usage: build-migrate.mjs <output directory>');
  process.exit(2);
}
const dir = resolve(out);

await build({
  entryPoints: [join(web, 'src/db/job.ts')],
  outfile: join(dir, 'migrate.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  tsconfig: join(web, 'tsconfig.json'),
  legalComments: 'none',
  logLevel: 'warning',
  // Some dependencies still call require() for Node built-ins; give the ES module one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});

// Exactly the shipped .sql files, replacing whatever a traced build may have put there.
const ledger = join(dir, 'migrations');
if (existsSync(ledger)) {
  for (const name of readdirSync(ledger)) {
    if (!readdirSync(join(web, 'migrations')).includes(name)) {
      console.error(`build-migrate: ${ledger} holds ${name}, which web/migrations does not`);
      process.exit(1);
    }
  }
}
cpSync(join(web, 'migrations'), ledger, {
  recursive: true,
  filter: (source) => source === join(web, 'migrations') || source.endsWith('.sql'),
});
