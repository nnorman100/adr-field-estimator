import { z } from 'zod';

// Typed server configuration. Every variable the app needs is declared here. src/instrumentation.ts
// checks it when the server starts, so a missing or invalid one stops the app with a message naming
// it and a bad deploy fails loudly at start rather than behaving oddly later. No defaults for
// deployment-specific values; no secrets here.
const schema = z.object({
  APP_ENV: z.enum(['local', 'test', 'live'], {
    error: 'APP_ENV must be one of local, test or live',
  }),
});

export type AppConfig = { appEnv: z.infer<typeof schema>['APP_ENV'] };

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
  return { appEnv: result.data.APP_ENV };
}
