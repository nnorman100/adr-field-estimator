import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

// The per-address limit of the link routes (docs/ACCESS.md, "Homeowner signing link"): at most 120
// requests a minute from one client address across every link route, per server instance, checked
// before the token is looked up. An address belongs to no company, so the count is held in memory,
// as the error intake's is (src/lib/client-error-intake.ts), and never in a table: only a hash of
// the address under a key made when the instance starts, never logged. Cloud Run appends the address
// it saw as the LAST X-Forwarded-For entry; anything before it is the caller's own claim, so only the
// last is read. The real ceiling is 120 times the number of instances running.

export const LINK_REQUESTS_PER_ADDRESS_PER_MINUTE = 120;
const MAX_ADDRESSES = 5000;
const WINDOW_MS = 60_000;

const key = randomBytes(32);
const addresses = new Map<string, { start: number; used: number }>();

function addressKey(headers: Headers): string | null {
  const last = headers.get('x-forwarded-for')?.split(',').pop()?.trim() ?? '';
  if (isIP(last) === 0) return null;
  return createHash('sha256').update(key).update(last).digest('hex');
}

/** Takes one request from the caller's share; false when the share for this minute is used up. */
export function takeLinkRequest(headers: Headers, now: number = Date.now()): boolean {
  const found = addressKey(headers);
  // No usable address (never on Cloud Run): the per-link limits still hold.
  if (found === null) return true;
  let entry = addresses.get(found);
  if (!entry || now - entry.start >= WINDOW_MS) {
    if (!entry && addresses.size >= MAX_ADDRESSES) {
      for (const [k, e] of addresses) if (now - e.start >= WINDOW_MS) addresses.delete(k);
      // Still full of live addresses: drop the oldest, so the table stays bounded.
      if (addresses.size >= MAX_ADDRESSES) addresses.delete(addresses.keys().next().value as string);
    }
    entry = { start: now, used: 0 };
    addresses.set(found, entry);
  }
  if (entry.used >= LINK_REQUESTS_PER_ADDRESS_PER_MINUTE) return false;
  entry.used += 1;
  return true;
}

/** For tests: forget every address. */
export function resetLinkRequestLimits(): void {
  addresses.clear();
}

/** For the test that proves the table stays bounded. */
export function linkAddressTableSize(): number {
  return addresses.size;
}
