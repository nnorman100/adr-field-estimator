import { checkDatabase } from '@/db/client';
import { parseConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

// Liveness and config check for the platform and for CI. Reports no secrets or user data. A built
// image also reports its commit, so the release smoke check can prove which code a revision runs.
// When a database is configured it must answer this service's login, so a revision that cannot
// reach Postgres answers 503 and the release never moves traffic to it.
export async function GET() {
  const config = parseConfig(process.env);
  const identity = config.commit ? { env: config.appEnv, commit: config.commit } : { env: config.appEnv };
  if (config.cloudSql || config.databaseUrl) {
    try {
      await checkDatabase(config);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      console.error(`health: database check failed (${typeof code === 'string' ? code : 'error'})`);
      return Response.json(
        { status: 'unavailable', ...identity },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      );
    }
  }
  return Response.json({ status: 'ok', ...identity });
}
