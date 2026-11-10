import { openDatabase } from '@/db/client';
import { parseIdentityConfig } from '@/lib/config';
import { databaseDirectory } from './directory';
import { firebaseTokenVerifier } from './firebase';
import type { IdentityDirectory, TokenVerifier } from './identity';

export type IdentityServices = { verifier: TokenVerifier; directory: IdentityDirectory };

let services: IdentityServices | null = null;

// Built from the checked server configuration on the first request that checks a sign-in, then
// reused. A missing or invalid setting throws, and that request fails closed.
export function identityServices(): IdentityServices {
  if (!services) {
    const config = parseIdentityConfig(process.env);
    const { db } = openDatabase(process.env);
    services = { verifier: firebaseTokenVerifier(config), directory: databaseDirectory(db) };
  }
  return services;
}
