import { runMigrationCommand } from './command';

function loadLocalEnv(): void {
  try {
    process.loadEnvFile('.env.local');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

// Operator entry for the numbered ledger. Reads .env.local in the working directory when it
// exists; variables already set in the environment win. Logs file ids only, never the URL.
try {
  loadLocalEnv();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'migration failed');
  process.exit(1);
}
process.exitCode = await runMigrationCommand(process.env);
