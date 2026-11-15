import { sql } from 'drizzle-orm';
import type { Database } from '@/db/tenant';
import { LinkError } from './errors';

// The one read before a company is known (migration 0014, on the 0004 pattern): a token's SHA-256
// to the company of its link, or null. Read-only, so a refused request writes nothing here.
export async function linkCompany(db: Database, kind: 'signing' | 'document', tokenSha256: string): Promise<string | null> {
  return db.transaction(
    async (tx) => {
      const rows = (await tx.execute(
        kind === 'signing'
          ? sql`SELECT signing_link_company(${tokenSha256})::text AS id`
          : sql`SELECT document_link_company(${tokenSha256})::text AS id`,
      )) as unknown as { id: string | null }[];
      return rows[0]?.id ?? null;
    },
    { accessMode: 'read only' },
  );
}

// Requests one link may answer a minute (reads, signature sending and signing together), counted in
// the link's own row, beside the per-address limit of the route (address-limit.ts).
export const LINK_REQUESTS_PER_MINUTE = 60;

/** Refuses a request over the link's limit for this minute. */
export function overLinkLimit(count: number | undefined): void {
  if (count === undefined) throw new LinkError('link_unavailable');
  if (count > LINK_REQUESTS_PER_MINUTE) throw new LinkError('too_many_requests');
}

// The counter's next values, from the database's clock: a new minute starts the count again.
export const nextWindowStart = (start: unknown) => sql`CASE WHEN ${start} <= now() - interval '1 minute' THEN now() ELSE ${start} END`;
export const nextReadCount = (start: unknown, count: unknown) => sql`CASE WHEN ${start} <= now() - interval '1 minute' THEN 1 ELSE ${count} + 1 END`;
