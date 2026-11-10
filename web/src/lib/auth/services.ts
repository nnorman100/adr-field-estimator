import { openDatabase } from '@/db/client';
import type { Database } from '@/db/tenant';
import { parseIdentityConfig } from '@/lib/config';
import { databaseDirectory } from './directory';
import { firebaseTokenVerifier } from './firebase';
import type { IdentityDirectory, TokenVerifier } from './identity';

export type IdentityServices = { verifier: TokenVerifier; directory: IdentityDirectory };

let services: IdentityServices | null = null;
let database: Database | null = null;

// The server's one database handle, opened on first use and shared by every route.
export function serverDatabase(): Database {
  database ??= openDatabase(process.env).db;
  return database;
}

// Built from the checked server configuration on the first request that checks a sign-in, then
// reused. A missing or invalid setting throws, and that request fails closed.
export function identityServices(): IdentityServices {
  if (!services) {
    const config = parseIdentityConfig(process.env);
    services = { verifier: firebaseTokenVerifier(config), directory: databaseDirectory(serverDatabase()) };
  }
  return services;
}
