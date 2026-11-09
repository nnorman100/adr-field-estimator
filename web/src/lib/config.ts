import { z } from 'zod';

// Typed server configuration. Every variable the app reads is declared here. src/instrumentation.ts
// checks it when the server starts, so an invalid value stops the app with a message that names the
// variable and never repeats the value. APP_ENV is required. DATABASE_URL is optional until a
// database command runs, and has no default. No secrets belong in this file.
function isPostgresUrl(value: string): boolean {
  if (value.length === 0 || value.length > 2000 || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    const protocolOk = url.protocol === 'postgres:' || url.protocol === 'postgresql:';
    return protocolOk && url.hostname.length > 0 && url.pathname.length > 1;
  } catch {
    return false;
  }
}

const schema = z.object({
  APP_ENV: z.enum(['local', 'test', 'live'], {
    error: 'APP_ENV must be one of local, test or live',
  }),
  // Optional so the shell can boot before a database is wired. When present it must already be a
  // postgres URL; the message stays fixed so a secret in the value is never echoed.
  DATABASE_URL: z
    .string()
    .refine(isPostgresUrl, { message: 'DATABASE_URL must be a postgres URL' })
    .optional(),
});

export type AppConfig = {
  appEnv: z.infer<typeof schema>['APP_ENV'];
  databaseUrl: string | null;
};

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Only variable names and messages are reported, never the values.
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  return { appEnv: result.data.APP_ENV, databaseUrl: result.data.DATABASE_URL ?? null };
}
