import { createHash, randomBytes } from 'node:crypto';
import { LINK_TOKEN_HEADER } from './header';

// A link token (S5a-11b): 32 random bytes from the server, as 43 URL-safe base64 characters. It is
// shown once, to the technician who makes the link, and never stored: the database keeps only its
// SHA-256. It travels in this header, never in a query string or a path, so no server or proxy log
// records it; the page that sends it reads it from the address's fragment (/sign#token), which a
// browser never sends to a server.

export { LINK_TOKEN_HEADER };

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function newLinkToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isLinkToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

export function linkTokenSha256(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The SHA-256 of the request's link token, or null when it has none of the right shape. */
export function linkTokenHashOf(request: Request): string | null {
  const token = request.headers.get(LINK_TOKEN_HEADER);
  return isLinkToken(token) ? linkTokenSha256(token) : null;
}
