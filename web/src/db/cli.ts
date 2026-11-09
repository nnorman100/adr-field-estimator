import { migrateFromConfig } from './client';

// Operator entry for the numbered ledger. Logs file ids only, never the connection string.
try {
  const result = await migrateFromConfig(process.env);
  const line =
    result.applied.length === 0 ? 'migrations: none pending' : `migrations: applied ${result.applied.join(' ')}`;
  console.log(line);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'migration failed');
  process.exit(1);
}
