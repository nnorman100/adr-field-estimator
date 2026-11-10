import { z } from 'zod';

// Typed server configuration. Every variable the app reads is declared here. src/instrumentation.ts
// checks it when the server starts, so an invalid value stops the app with a message that names the
// variable and never repeats the value. APP_ENV is required. DATABASE_URL is optional until a
// database command runs, and FIREBASE_PROJECT_ID until a route checks a sign-in; neither has a
// default. No secrets belong in this file.
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

// A Google Cloud project id: 6-30 lowercase letters, digits and hyphens, starting with a letter.
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

// host:port of a loopback emulator, as the Firebase CLI writes it.
function isLoopbackHost(value: string): boolean {
  if (!/^[\w.:[\]-]{1,100}:\d{1,5}$/.test(value)) return false;
  try {
    const { hostname } = new URL(`http://${value}`);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

const schema = z
  .object({
  APP_ENV: z.enum(['local', 'test', 'live'], {
    error: 'APP_ENV must be one of local, test or live',
  }),
  // Optional so the shell can boot before a database is wired. When present it must already be a
  // postgres URL; the message stays fixed so a secret in the value is never echoed.
  DATABASE_URL: z
    .string()
    .refine(isPostgresUrl, { message: 'DATABASE_URL must be a postgres URL' })
    .optional(),
  // The Firebase project whose sign-in tokens the server accepts (their audience).
  FIREBASE_PROJECT_ID: z
    .string()
    .regex(PROJECT_ID, { message: 'FIREBASE_PROJECT_ID must be a Google Cloud project id' })
    .optional(),
  // firebase-admin reads this variable itself and then accepts unsigned tokens, so it is allowed
  // only on a developer machine, only for a demo- project, and only on a loopback address.
  FIREBASE_AUTH_EMULATOR_HOST: z
    .string()
    .refine(isLoopbackHost, { message: 'FIREBASE_AUTH_EMULATOR_HOST must be a loopback host:port' })
    .optional(),
  })
  .superRefine((env, ctx) => {
    if (env.FIREBASE_AUTH_EMULATOR_HOST === undefined) return;
    if (env.APP_ENV !== 'local') {
      ctx.addIssue({
        code: 'custom',
        path: ['FIREBASE_AUTH_EMULATOR_HOST'],
        message: 'FIREBASE_AUTH_EMULATOR_HOST is allowed only when APP_ENV is local',
      });
    }
    if (!env.FIREBASE_PROJECT_ID?.startsWith('demo-')) {
      ctx.addIssue({
        code: 'custom',
        path: ['FIREBASE_AUTH_EMULATOR_HOST'],
        message: 'FIREBASE_AUTH_EMULATOR_HOST needs a FIREBASE_PROJECT_ID starting with demo-',
      });
    }
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

function checked(env: Record<string, string | undefined>) {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Only variable names and messages are reported, never the values.
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  return result.data;
}

export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const data = checked(env);
  return { appEnv: data.APP_ENV, databaseUrl: data.DATABASE_URL ?? null };
}

export type IdentityConfig = {
  appEnv: AppConfig['appEnv'];
  projectId: string;
  authEmulatorHost: string | null;
};

// What sign-in checks need. Called when a route first checks a sign-in, so the shell still boots
// without FIREBASE_PROJECT_ID; a route that needs it then fails closed.
export function parseIdentityConfig(env: Record<string, string | undefined>): IdentityConfig {
  const data = checked(env);
  if (!data.FIREBASE_PROJECT_ID) {
    throw new ConfigError(['FIREBASE_PROJECT_ID: FIREBASE_PROJECT_ID is required to check a sign-in']);
  }
  return {
    appEnv: data.APP_ENV,
    projectId: data.FIREBASE_PROJECT_ID,
    authEmulatorHost: data.FIREBASE_AUTH_EMULATOR_HOST ?? null,
  };
}
