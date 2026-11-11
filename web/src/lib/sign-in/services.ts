import { serverDatabase } from '@/lib/auth/services';
import { parseLocalSignInFixture } from '@/lib/config';
import type { SignInDirectory } from './directory';
import { databaseSignInDirectory } from './database-directory';
import { localSignInDirectory } from './local-directory';

// The server's address lookup: the local emulator stand-in when the configuration allows it,
// otherwise the database (migration 0007). An invalid setting or a missing database configuration
// throws, so the page or route fails closed. Built on the first question, so a malformed address,
// which signInPageFor never passes on, opens nothing.
export function signInDirectory(): SignInDirectory {
  return {
    pageFor(address) {
      const fixture = parseLocalSignInFixture(process.env);
      return (fixture ? localSignInDirectory(fixture) : databaseSignInDirectory(serverDatabase())).pageFor(address);
    },
  };
}
