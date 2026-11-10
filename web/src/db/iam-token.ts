import { z } from 'zod';

// Access token for Cloud SQL IAM database authentication on Cloud Run. Without a Cloud SQL
// connector, the client passes this short-lived token as the password when a connection logs in
// (https://cloud.google.com/sql/docs/postgres/iam-logins). It comes from the metadata server as
// the service's own account, is cached until shortly before it expires, and is never logged.
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

// Refresh this long before expiry, so a token is never handed out in its last minutes.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function createTokenSource(fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
  let cached: { token: string; expiresAt: number } | null = null;
  return async function accessToken(): Promise<string> {
    if (cached && now() < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;
    const res = await fetchImpl(METADATA_TOKEN_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`metadata server refused the access token request: ${res.status}`);
    const parsed = tokenSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new Error('metadata server returned an unexpected token response');
    cached = { token: parsed.data.access_token, expiresAt: now() + parsed.data.expires_in * 1000 };
    return cached.token;
  };
}
