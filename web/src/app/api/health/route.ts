import { parseConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

// Liveness and config check for the platform and for CI. Reports no secrets or user data. A built
// image also reports its commit, so the release smoke check can prove which code a revision runs.
export function GET() {
  const { appEnv, commit } = parseConfig(process.env);
  return Response.json(commit ? { status: 'ok', env: appEnv, commit } : { status: 'ok', env: appEnv });
}
