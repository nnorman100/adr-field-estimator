import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { schema } from './schema';

export type Database = PostgresJsDatabase<typeof schema>;
export type CompanyTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CompanyContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanyContextError';
  }
}

// Runs every business query for one company. It opens a transaction and sets app.company_id for
// that transaction only, so the row-level security policies in migration 0003 show and accept
// that company's rows and nothing else. The setting ends with the transaction, so a pooled
// connection used next for another company, or for no company, carries nothing over.
//
// The company id must come from the verified sign-in, never from a URL, header or body.
export async function withCompany<T>(
  db: Database,
  companyId: string,
  run: (tx: CompanyTransaction) => Promise<T>,
): Promise<T> {
  if (typeof companyId !== 'string' || !UUID.test(companyId)) {
    throw new CompanyContextError('withCompany needs a company id that is a uuid');
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.company_id', ${companyId.toLowerCase()}, true)`);
    return run(tx);
  });
}
