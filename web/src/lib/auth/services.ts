import { openDatabase } from '@/db/client';
import type { Database } from '@/db/tenant';
import { parseIdentityConfig, parseLocalSignInFixture } from '@/lib/config';
import { localIdentityDirectory, localOperatorDirectory, withLocalSecondStep } from '@/lib/sign-in/local-directory';
import { databaseDirectory, databaseOperators } from './directory';
import { firebaseTokenVerifier } from './firebase';
import type { IdentityDirectory, OperatorDirectory, TokenVerifier } from './identity';

export type IdentityServices = { verifier: TokenVerifier; directory: IdentityDirectory };

let services: IdentityServices | null = null;
let database: Database | null = null;

// The server's one database handle, opened on first use and shared by every route.
export function serverDatabase(): Database {
  database ??= openDatabase(process.env).db;
  return database;
}

// Built from the checked server configuration on the first request that checks a sign-in, then
// reused. A missing or invalid setting throws, and that request fails closed. On a developer
// machine beside the Auth emulator, LOCAL_SIGN_IN_FIXTURE stands in for the database
// (src/lib/sign-in/local-directory.ts); the configuration refuses it anywhere else.
export function identityServices(): IdentityServices {
  if (!services) {
    const config = parseIdentityConfig(process.env);
    const fixture = parseLocalSignInFixture(process.env);
    const directory = fixture ? localIdentityDirectory(fixture) : databaseDirectory(serverDatabase());
    const verifier = firebaseTokenVerifier(config);
    services = { verifier: fixture ? withLocalSecondStep(verifier, fixture) : verifier, directory };
  }
  return services;
}

export type OperatorServices = { verifier: TokenVerifier; operators: OperatorDirectory };

let operatorServicesCache: OperatorServices | null = null;

// The same verifier as member routes, with the operator lookup instead of the company lookup. The
// local sign-in records file stands in for the operators table as it does for the company tables.
export function operatorServices(): OperatorServices {
  if (!operatorServicesCache) {
    const fixture = parseLocalSignInFixture(process.env);
    operatorServicesCache = {
      verifier: identityServices().verifier,
      operators: fixture ? localOperatorDirectory(fixture) : databaseOperators(serverDatabase()),
    };
  }
  return operatorServicesCache;
}
