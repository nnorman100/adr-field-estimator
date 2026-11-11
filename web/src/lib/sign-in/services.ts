import { parseLocalSignInFixture } from '@/lib/config';
import { noSignInDirectory, type SignInDirectory } from './directory';
import { localSignInDirectory } from './local-directory';

// The server's address lookup: the local emulator stand-in when the configuration allows it,
// otherwise none until S3-13b adds the database lookup. An invalid setting throws, so the page or
// route fails closed.
export function signInDirectory(): SignInDirectory {
  const fixture = parseLocalSignInFixture(process.env);
  return fixture ? localSignInDirectory(fixture) : noSignInDirectory;
}
