import { publicRoute } from '@/lib/auth';
import { parseConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

// Liveness and config check for the platform and for CI. Reports no secrets or user data.
export const GET = publicRoute(() => {
  const { appEnv } = parseConfig(process.env);
  return Response.json({ status: 'ok', env: appEnv });
});
