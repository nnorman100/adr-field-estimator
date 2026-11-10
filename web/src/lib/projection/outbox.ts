import { sql } from 'drizzle-orm';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import type { Role } from '@/lib/access';
import { AccessStoreError, type AccessStore } from './store';

// The access projection outbox (S3-12). A membership change commits an outbox row in the same
// transaction (enqueueAccessProjection), so nothing is projected before the change commits. A run
// then brings each waiting actor's Firestore access record in line with what Postgres holds now:
//
// - It reads the current committed state, never what the row asked for, so a run that repeats or
//   arrives late writes the right thing, and a second run with nothing waiting writes nothing.
// - Server access needs no projection to stop: the sign-in check reads the membership in Postgres
//   (web/src/lib/auth/identity.ts), so a disabled member is refused from the moment it commits.
//   Removing the Firestore record follows, and its rows are marked done only after the store has
//   read the record back as gone.
// - One actor is handled under a transaction-scoped advisory lock, held until its store call has
//   settled and its rows are marked done, so two runs cannot interleave one actor's writes. A run
//   never stops waiting for a store call it started.
// - Each decision carries a version: the id of its Postgres transaction, assigned under the lock.
//   Transaction ids only grow, and the next run takes the lock only after this transaction ends, so
//   a later decision always has a higher version. The store refuses a decision older than the one
//   it holds (store.ts), so if the lock is lost anyway (the session dies while a write is on its
//   way), the late write can neither bring back a removed record nor remove a newer grant.
// - If anything fails, the transaction rolls back, the rows stay waiting with a back-off, and the
//   next run repairs them. A crash anywhere leaves the same state.
//
// Every query runs inside withCompany under the 0003 policies. Only finding the companies with
// work waiting crosses companies, through access_projection_due_companies (migration 0005), which
// returns company ids and nothing else.

// How long an access record works, and when an active member's record is renewed. Removal is an
// active delete; the expiry only bounds a record the outbox could not remove. It is long enough
// that a phone offline for several days can still sync its queued field work.
export const ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

// pg_advisory_xact_lock(int, int) keys do not overlap single-bigint keys (the migration runner's
// lock), and this fixed first key keeps them apart from any later two-key lock.
const LOCK_NAMESPACE = 0x5312;

const MAX_BACKOFF_SECONDS = 3600;

export type ProjectionOptions = {
  // The clock that sets expiresAt; tests move it.
  now?: () => Date;
};

export type ActorOutcome = 'granted' | 'removed' | 'busy' | 'nothing_due' | 'failed';
export type RunSummary = Record<ActorOutcome, number>;

type Target =
  | { kind: 'grant'; authTenantId: string; uid: string; role: Role }
  | { kind: 'remove'; uid: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: string, name: string): string {
  if (!UUID.test(value)) throw new TypeError(`${name} must be a uuid`);
  return value.toLowerCase();
}

function rows<T>(result: unknown): T[] {
  return result as T[];
}

// Call inside the transaction that changes the actor's membership (or the company's status), after
// withCompany has set that company.
export async function enqueueAccessProjection(tx: CompanyTransaction, companyId: string, actorId: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO access_projection_outbox (company_id, actor_id)
    VALUES (${uuid(companyId, 'companyId')}::uuid, ${uuid(actorId, 'actorId')}::uuid)
  `);
}

// What the actor's access record should be now: a grant only for an active membership in an active
// company that has a sign-in tenant; otherwise no record.
async function targetFor(tx: CompanyTransaction, companyId: string, actorId: string): Promise<Target> {
  const [state] = rows<{ uid: string; status: string; auth_tenant_id: string | null; role: Role | null }>(
    await tx.execute(sql`
      SELECT a.uid, c.status, c.auth_tenant_id, m.role
      FROM actors a
      JOIN companies c ON c.id = a.company_id
      LEFT JOIN memberships m
        ON m.company_id = a.company_id AND m.actor_id = a.id AND m.status = 'active'
      WHERE a.company_id = ${companyId}::uuid AND a.id = ${actorId}::uuid
    `),
  );
  // The outbox row's foreign key keeps the actor; a missing one means this company cannot see it.
  if (!state) throw new ProjectionError('actor_not_found');
  if (state.status === 'active' && state.auth_tenant_id && state.role) {
    return { kind: 'grant', authTenantId: state.auth_tenant_id, uid: state.uid, role: state.role };
  }
  return { kind: 'remove', uid: state.uid };
}

export class ProjectionError extends Error {
  constructor(readonly code: 'actor_not_found' | 'version_out_of_range') {
    super(`Access projection failed: ${code}`);
    this.name = 'ProjectionError';
  }
}

// This transaction's id. pg_current_xact_id is a 64-bit counter that never wraps; in practice it
// stays far below 2^53, so it fits a Firestore integer and a JavaScript number exactly.
async function decisionVersion(tx: CompanyTransaction): Promise<number> {
  const [row] = rows<{ version: string }>(await tx.execute(sql`SELECT pg_current_xact_id()::text AS version`));
  const version = Number(row?.version);
  if (!Number.isSafeInteger(version)) throw new ProjectionError('version_out_of_range');
  return version;
}

const LOCK_NOT_AVAILABLE = '55P03';

function lockTimedOut(error: unknown): boolean {
  const found = error as { code?: string; cause?: { code?: string } } | null;
  return (found?.code ?? found?.cause?.code) === LOCK_NOT_AVAILABLE;
}

// A fixed code for the outbox row; never the error's text, which can quote ids or credentials.
function errorCode(error: unknown): string {
  if (error instanceof ProjectionError || error instanceof AccessStoreError) return error.code;
  return 'store_failed';
}

// Brings one actor's record in line. `wait` false skips an actor another run holds (the request
// path); true waits for it (the outbox run), and reports it busy if it is still held after the lock
// timeout, so one actor whose write is slow does not stop the rest of a run.
export async function projectActor(
  db: Database,
  store: AccessStore,
  companyId: string,
  actorId: string,
  { wait = true, now = () => new Date() }: ProjectionOptions & { wait?: boolean } = {},
): Promise<ActorOutcome> {
  companyId = uuid(companyId, 'companyId');
  actorId = uuid(actorId, 'actorId');
  let claimed: string[] = [];
  try {
    return await withCompany(db, companyId, async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '15s'`);
      if (wait) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}::int, hashtext(${actorId}))`);
      } else {
        const [lock] = rows<{ held: boolean }>(
          await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${LOCK_NAMESPACE}::int, hashtext(${actorId})) AS held`),
        );
        if (!lock?.held) return 'busy';
      }

      // Every waiting row of the actor is claimed together, so duplicates cause one write; the run
      // starts only when at least one of them is due.
      const waiting = rows<{ id: string; due: boolean }>(
        await tx.execute(sql`
          SELECT id::text AS id, available_at <= now() AS due
          FROM access_projection_outbox
          WHERE company_id = ${companyId}::uuid AND actor_id = ${actorId}::uuid AND processed_at IS NULL
          ORDER BY id
          FOR UPDATE
        `),
      );
      if (!waiting.some((row) => row.due)) return 'nothing_due';
      claimed = waiting.map((row) => row.id);

      // Read after the lock and the claim: a change committed after this read leaves a new row,
      // which the next run handles once this one lets go of the actor.
      const target = await targetFor(tx, companyId, actorId);
      const version = await decisionVersion(tx);
      if (target.kind === 'grant') {
        const expiresAt = new Date(now().getTime() + ACCESS_TTL_MS);
        await store.grant({
          companyId,
          authTenantId: target.authTenantId,
          uid: target.uid,
          role: target.role,
          expiresAt,
          version,
        });
      } else {
        await store.remove(companyId, target.uid, version);
      }

      await tx.execute(sql`
        UPDATE access_projection_outbox
        SET processed_at = now(), attempts = attempts + 1, last_error_code = NULL
        WHERE company_id = ${companyId}::uuid AND id = ANY(${`{${claimed.join(',')}}`}::bigint[])
      `);
      return target.kind === 'grant' ? 'granted' : 'removed';
    });
  } catch (error) {
    if (claimed.length === 0) {
      if (lockTimedOut(error)) return 'busy';
      throw error;
    }
    // The rows stay waiting; the next run after the back-off tries again.
    const code = errorCode(error);
    console.error('access projection failed', code);
    await withCompany(db, companyId, async (tx) => {
      await tx.execute(sql`
        UPDATE access_projection_outbox
        SET attempts = attempts + 1,
            last_error_code = ${code},
            available_at = now() + make_interval(secs => least(${MAX_BACKOFF_SECONDS}, 30 * power(2, least(attempts, 12))))
        WHERE company_id = ${companyId}::uuid AND processed_at IS NULL
          AND id = ANY(${`{${claimed.join(',')}}`}::bigint[])
      `);
    });
    return 'failed';
  }
}

function emptySummary(): RunSummary {
  return { granted: 0, removed: 0, busy: 0, nothing_due: 0, failed: 0 };
}

// One company's actors with a row due now.
async function dueActors(db: Database, companyId: string, limit: number): Promise<string[]> {
  return withCompany(db, companyId, async (tx) => {
    const found = rows<{ actor_id: string }>(
      await tx.execute(sql`
        SELECT actor_id::text AS actor_id
        FROM access_projection_outbox
        WHERE company_id = ${companyId}::uuid AND processed_at IS NULL AND available_at <= now()
        GROUP BY actor_id
        ORDER BY min(id)
        LIMIT ${limit}
      `),
    );
    return found.map((row) => row.actor_id);
  });
}

// One outbox run across every company: what a scheduled job or a repair calls. Each company's
// work runs inside its own withCompany transactions.
export async function runAccessProjection(
  db: Database,
  store: AccessStore,
  { maxCompanies = 50, maxActorsPerCompany = 200, ...options }: ProjectionOptions & {
    maxCompanies?: number;
    maxActorsPerCompany?: number;
  } = {},
): Promise<RunSummary> {
  const companies = await db.transaction(async (tx) => {
    const found = rows<{ id: string }>(
      await tx.execute(sql`SELECT access_projection_due_companies(${maxCompanies}::int)::text AS id`),
    );
    return found.map((row) => row.id);
  });
  const summary = emptySummary();
  for (const companyId of companies) {
    for (const actorId of await dueActors(db, companyId, maxActorsPerCompany)) {
      summary[await projectActor(db, store, companyId, actorId, options)] += 1;
    }
  }
  return summary;
}
