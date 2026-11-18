import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { transactionSpan } from '../lib/telemetry/spans';
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
  return transactionSpan(() =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.company_id', ${companyId.toLowerCase()}, true)`);
      return run(tx);
    }),
  );
}

// A transaction that stays open on purpose while it waits on Firestore or Identity Platform (the
// Submit fence, a new draft made under its job's lock, the operator's second-step reset after its
// audit row) is not ended by the connection's 30 s idle limit (db/client.ts) mid-call: for this
// transaction only, it may sit idle as long as a request may run (Cloud Run's 300 s).
export async function holdAcrossOutsideCall(tx: CompanyTransaction): Promise<void> {
  await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '300s'`);
}

export class OperatorContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorContextError';
  }
}

export type OperatorContext = {
  // The company the operator acts on, set for this transaction as withCompany would set it, so the
  // company's own rows (actors, memberships, invitations, outbox) are reachable too.
  companyId?: string;
  // A read-only transaction: any write in it fails.
  readOnly?: boolean;
};

// Runs a platform operator's work in one transaction. It sets app.operator_id for that transaction
// only, so migration 0006's operator policies apply, and refuses before running anything unless the
// database confirms an active operator (app_operator_active). The operator id must come from the
// verified operator sign-in (platform_operator in 0006), never from the request.
export async function withOperator<T>(
  db: Database,
  operatorId: string,
  run: (tx: CompanyTransaction) => Promise<T>,
  context: OperatorContext = {},
): Promise<T> {
  if (typeof operatorId !== 'string' || !UUID.test(operatorId)) {
    throw new OperatorContextError('withOperator needs an operator id that is a uuid');
  }
  const { companyId } = context;
  if (companyId !== undefined && (typeof companyId !== 'string' || !UUID.test(companyId))) {
    throw new CompanyContextError('withOperator needs a company id that is a uuid');
  }
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`SELECT set_config('app.operator_id', ${operatorId.toLowerCase()}, true)`);
      if (companyId !== undefined) {
        await tx.execute(sql`SELECT set_config('app.company_id', ${companyId.toLowerCase()}, true)`);
      }
      const [row] = (await tx.execute(sql`SELECT app_operator_active() AS active`)) as unknown as { active: boolean }[];
      if (row?.active !== true) throw new OperatorContextError('not an active platform operator');
      return run(tx);
    },
    context.readOnly === true ? { accessMode: 'read only' } : undefined,
  );
}
