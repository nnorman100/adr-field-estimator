import { migrateFromConfig } from './client';

// The migration command shared by `npm run db:migrate` (cli.ts) and the Cloud Run migration job
// (job.ts). Logs file ids only, never the URL or a token; returns the process exit code.
export async function runMigrationCommand(
  env: Record<string, string | undefined>,
  directory?: string,
): Promise<number> {
  try {
    const result = await migrateFromConfig(env, directory);
    const line =
      result.applied.length === 0 ? 'migrations: none pending' : `migrations: applied ${result.applied.join(' ')}`;
    console.log(line);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'migration failed');
    return 1;
  }
}
