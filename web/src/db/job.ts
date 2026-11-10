import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrationCommand } from './command';

// Entry of the Cloud Run migration job (infra/dryscope/app/migrate_job.tf), which the release
// workflow runs before a new revision takes traffic. scripts/build-migrate.mjs bundles this file
// into the web image as /app/migrate.mjs, with web/migrations copied beside it to /app/migrations,
// so the job applies the same ledger as `npm run db:migrate`. It is not meant to run unbundled.
// Settings come from the job only (APP_ENV and the SQL_* settings); no .env file is read.
const ledger = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
process.exitCode = await runMigrationCommand(process.env, ledger);
