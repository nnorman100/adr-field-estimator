import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '@/db/client';
import { applyMigrations, migrationsDirectory } from '@/db/migrate';
import { withCompany } from '@/db/tenant';
import { databaseDirectory } from '@/lib/auth/directory';
import {
  ACCESS_TTL_MS,
  enqueueAccessProjection,
  projectActor,
  renewAccess,
  runAccessProjection,
  type AccessStore,
} from '@/lib/projection';
import { AccessStoreError } from '@/lib/projection/store';
import { key, memoryStore } from '../projection/memory-store';
import { accessStoreContract } from '../projection/store-contract';
import { emptyDiscardDatabase, startDisposablePostgres, type DisposablePostgres } from './postgres-harness';
import { unprotectedRelations } from './row-security-guard';

// The access projection outbox (S3-12) against Postgres, as the app's runtime role on a server set
// up like a fresh Cloud SQL instance (see row-level-security.test.ts). The Firestore side is the
// in-memory store, held to the same contract as the real one; tests/emu/access-projection.test.ts
// runs the real store against the Firestore emulator and its rules.
const MIGRATOR = 'dryscope_migrator_ci';
const API_USER = 'dryscope-api-ci@dryscope.iam';
const OTHER_USER = 'dryscope_other_ci';
const INSUFFICIENT_PRIVILEGE = '42501';
const INVALID_PARAMETER = '22023';

const migratorPassword = randomBytes(16).toString('hex');
const apiPassword = randomBytes(16).toString('hex');
const otherPassword = randomBytes(16).toString('hex');
const webDir = fileURLToPath(new URL('../..', import.meta.url));

let server: DisposablePostgres;
let admin: postgres.Sql;
let api: postgres.Sql;
let handle: ReturnType<typeof openDatabase>;
// A second pool, so a worker can run while a change holds the first one's connection.
let worker: ReturnType<typeof openDatabase>;

type Seed = { a: string; b: string; ownerA: string; estimatorA: string; estimatorB: string };
let seed: Seed;

function urlAs(user: string, password: string): string {
  const url = new URL(server.databaseUrl);
  url.username = user;
  url.password = password;
  return url.toString();
}

function connect(user: string, password: string): postgres.Sql {
  return postgres(urlAs(user, password), { max: 1, connect_timeout: 10, onnotice: () => {} });
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const found = error as { code?: string; cause?: { code?: string } };
    return found.code ?? found.cause?.code;
  }
  return undefined;
}

async function seedCompanies(): Promise<Seed> {
  await admin`INSERT INTO auth_tenants (id, kind) VALUES ('tenant-a', 'company'), ('tenant-b', 'company')`;
  const company = async (tenant: string) => {
    const [row] = await admin<{ id: string }[]>`
      INSERT INTO companies (name, sign_in_slug, auth_tenant_id)
      VALUES (${`Company ${tenant}`}, ${tenant}, ${tenant}) RETURNING id
    `;
    return row!.id;
  };
  const member = async (companyId: string, tenant: string, uid: string, role: string) => {
    const [row] = await admin<{ id: string }[]>`
      INSERT INTO actors (company_id, auth_tenant_id, uid, email)
      VALUES (${companyId}, ${tenant}, ${uid}, ${`${uid}@example.test`}) RETURNING id
    `;
    await admin`INSERT INTO memberships (company_id, actor_id, role) VALUES (${companyId}, ${row!.id}, ${role})`;
    return row!.id;
  };
  const a = await company('tenant-a');
  const b = await company('tenant-b');
  return {
    a,
    b,
    ownerA: await member(a, 'tenant-a', 'owner-a', 'owner'),
    estimatorA: await member(a, 'tenant-a', 'estimator-a', 'estimator'),
    // The same uid in another tenant is another person.
    estimatorB: await member(b, 'tenant-b', 'estimator-a', 'estimator'),
  };
}

beforeAll(async () => {
  server = await startDisposablePostgres({ APP_ENV: 'test' });
  admin = postgres(server.databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  await admin.unsafe(`CREATE ROLE ${MIGRATOR} LOGIN CREATEROLE PASSWORD '${migratorPassword}'`);
  await admin.unsafe(`GRANT CREATE ON DATABASE "${server.databaseName}" TO ${MIGRATOR}`);
  await admin.unsafe(`CREATE ROLE "${API_USER}" LOGIN PASSWORD '${apiPassword}'`);
  await admin.unsafe(`CREATE ROLE ${OTHER_USER} LOGIN PASSWORD '${otherPassword}'`);
});

afterAll(async () => {
  await worker?.close();
  await handle?.close();
  await api?.end({ timeout: 5 });
  await admin?.end({ timeout: 5 });
  await server?.stop();
});

beforeEach(async () => {
  await worker?.close();
  await handle?.close();
  await api?.end({ timeout: 5 });
  await emptyDiscardDatabase(server.databaseUrl);
  await admin.unsafe('GRANT USAGE ON SCHEMA public TO PUBLIC');
  await admin.unsafe(`GRANT CREATE ON SCHEMA public TO ${MIGRATOR}`);
  await applyMigrations(urlAs(MIGRATOR, migratorPassword), migrationsDirectory);
  seed = await seedCompanies();
  api = connect(API_USER, apiPassword);
  handle = openDatabase({ APP_ENV: 'test', DATABASE_URL: urlAs(API_USER, apiPassword) });
  worker = openDatabase({ APP_ENV: 'test', DATABASE_URL: urlAs(API_USER, apiPassword) });
});

// A membership change as later team code makes it: the change and its outbox row in one
// transaction of that company.
async function setMembership(companyId: string, actorId: string, change: { status?: string; role?: string }) {
  await withCompany(handle.db, companyId, async (tx) => {
    if (change.status) {
      await tx.execute(sql`UPDATE memberships SET status = ${change.status} WHERE actor_id = ${actorId}::uuid`);
    }
    if (change.role) {
      await tx.execute(sql`UPDATE memberships SET role = ${change.role} WHERE actor_id = ${actorId}::uuid`);
    }
    await enqueueAccessProjection(tx, companyId, actorId);
  });
}

async function enqueue(companyId: string, actorId: string) {
  await withCompany(handle.db, companyId, (tx) => enqueueAccessProjection(tx, companyId, actorId));
}

type OutboxRow = {
  id: string;
  company_id: string;
  actor_id: string;
  attempts: number;
  processed: boolean;
  due: boolean;
  last_error_code: string | null;
};

// Every outbox row, read as the superuser (it is not bound by the policies).
async function outbox(): Promise<OutboxRow[]> {
  return admin<OutboxRow[]>`
    SELECT id::text, company_id::text, actor_id::text, attempts, processed_at IS NOT NULL AS processed,
           available_at <= now() AS due, last_error_code
    FROM access_projection_outbox ORDER BY id
  `;
}

// The back-off has passed.
async function backOffPassed() {
  await admin`UPDATE access_projection_outbox SET available_at = now() WHERE processed_at IS NULL`;
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

// Ends the database session holding an actor's projection lock, as a dropped connection or a
// restarted server would, and waits until the lock is free.
async function dropLockHolder() {
  const held = () => admin<{ pid: number }[]>`
    SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = ${0x5312}
  `;
  const holders = await held();
  expect(holders).toHaveLength(1);
  await admin`SELECT pg_terminate_backend(${holders[0]!.pid})`;
  const deadline = Date.now() + 10_000;
  while ((await held()).length > 0) {
    if (Date.now() > deadline) throw new Error('the lock was never released');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function verifiedAs(tenant: string, uid: string) {
  return {
    async verify() {
      return { tenant, uid, emailVerified: true };
    },
    async verifyNotRevoked() {
      return { tenant, uid, emailVerified: true };
    },
  };
}

const bearer = new Request('http://localhost/api/me', { headers: { Authorization: 'Bearer a.b.c' } });

accessStoreContract(
  'in-memory',
  () => {
    const store = memoryStore();
    return {
      store,
      async record(companyId, uid) {
        return store.records.get(key(companyId, uid)) ?? null;
      },
      async header(companyId) {
        return store.headers.get(companyId) ?? null;
      },
    };
  },
  () => crypto.randomUUID(),
);

describe('access projection outbox (S3-12)', () => {
  it('writes the access record of each waiting member from the committed membership', async () => {
    const store = memoryStore();
    await enqueue(seed.a, seed.ownerA);
    await enqueue(seed.a, seed.estimatorA);
    await enqueue(seed.b, seed.estimatorB);
    const before = Date.now();
    expect(await runAccessProjection(worker.db, store)).toMatchObject({ granted: 3, failed: 0 });

    expect(store.headers.get(seed.a)).toEqual({ authTenantId: 'tenant-a' });
    expect(store.headers.get(seed.b)).toEqual({ authTenantId: 'tenant-b' });
    expect(store.records.get(key(seed.a, 'owner-a'))?.role).toBe('owner');
    expect(store.records.get(key(seed.a, 'estimator-a'))?.role).toBe('estimator');
    expect(store.records.get(key(seed.b, 'estimator-a'))?.role).toBe('estimator');
    const expiresAt = store.records.get(key(seed.a, 'owner-a'))!.expiresAt.getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + ACCESS_TTL_MS);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + ACCESS_TTL_MS);
    expect((await outbox()).every((row) => row.processed && row.attempts === 1 && !row.last_error_code)).toBe(true);
  });

  it('never writes a grant before its SQL change commits', async () => {
    const store = memoryStore();
    const [newActor] = await admin<{ id: string }[]>`
      INSERT INTO actors (company_id, auth_tenant_id, uid, email)
      VALUES (${seed.a}, 'tenant-a', 'joining-a', 'joining-a@example.test') RETURNING id
    `;
    const inserted = deferred();
    const commit = deferred();
    const change = withCompany(handle.db, seed.a, async (tx) => {
      await tx.execute(sql`INSERT INTO memberships (company_id, actor_id, role) VALUES (${seed.a}::uuid, ${newActor!.id}::uuid, 'estimator')`);
      await enqueueAccessProjection(tx, seed.a, newActor!.id);
      inserted.release();
      await commit.promise;
    });
    await inserted.promise;

    // The change is written but not committed: no run sees its row or its membership.
    expect(await runAccessProjection(worker.db, store)).toMatchObject({ granted: 0, removed: 0 });
    expect(await projectActor(worker.db, store, seed.a, newActor!.id)).toBe('nothing_due');
    expect(store.records.size).toBe(0);
    expect(store.writes).toBe(0);

    commit.release();
    await change;
    expect(await runAccessProjection(worker.db, store)).toMatchObject({ granted: 1 });
    expect(store.records.get(key(seed.a, 'joining-a'))?.role).toBe('estimator');
  });

  it('writes nothing for a change that rolls back', async () => {
    const store = memoryStore();
    await expect(
      withCompany(handle.db, seed.a, async (tx) => {
        await tx.execute(sql`UPDATE memberships SET role = 'office' WHERE actor_id = ${seed.estimatorA}::uuid`);
        await enqueueAccessProjection(tx, seed.a, seed.estimatorA);
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    expect(await runAccessProjection(worker.db, store)).toMatchObject({ granted: 0, removed: 0 });
    expect(await outbox()).toEqual([]);
    expect(store.writes).toBe(0);
  });

  it('running the outbox twice changes nothing', async () => {
    const store = memoryStore();
    await enqueue(seed.a, seed.ownerA);
    await setMembership(seed.a, seed.estimatorA, { status: 'disabled' });
    await enqueue(seed.b, seed.estimatorB);
    await runAccessProjection(worker.db, store);
    const rows = await outbox();
    const records = new Map(store.records);
    const writes = store.writes;

    expect(await runAccessProjection(worker.db, store)).toEqual({ granted: 0, removed: 0, busy: 0, nothing_due: 0, failed: 0 });
    expect(await outbox()).toEqual(rows);
    expect(store.records).toEqual(records);
    expect(store.writes).toBe(writes);
  });

  it('several rows of one actor cause one write', async () => {
    const store = memoryStore();
    await setMembership(seed.a, seed.estimatorA, { role: 'office' });
    await setMembership(seed.a, seed.estimatorA, { role: 'estimator' });
    await setMembership(seed.a, seed.estimatorA, { role: 'office' });
    expect(await runAccessProjection(worker.db, store)).toMatchObject({ granted: 1 });
    expect(store.writes).toBe(1);
    expect(store.records.get(key(seed.a, 'estimator-a'))?.role).toBe('office');
    expect((await outbox()).every((row) => row.processed)).toBe(true);
  });

  describe('a crash between the SQL commit and the Firestore write', () => {
    // Starts the worker in its own process and kills it while its store call is in progress.
    async function crashDuringStoreCall(companyId: string, actorId: string): Promise<Record<string, unknown>> {
      const dir = mkdtempSync(join(tmpdir(), 'dryscope-crash-'));
      const marker = join(dir, 'store-call.json');
      try {
        const child = spawn('npx', ['tsx', 'tests/db/projection-crash-child.ts'], {
          cwd: webDir,
          env: {
            ...process.env,
            DATABASE_URL: '',
            CRASH_DATABASE_URL: urlAs(API_USER, apiPassword),
            CRASH_COMPANY: companyId,
            CRASH_ACTOR: actorId,
            CRASH_MARKER: marker,
          },
          stdio: 'ignore',
          detached: true,
        });
        const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
        const deadline = Date.now() + 25_000;
        while (!existsSync(marker) || readFileSync(marker, 'utf8') === '') {
          if (Date.now() > deadline) throw new Error('the worker process never reached its store call');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        // SIGKILL to the whole process group (npx, tsx and node): no clean-up code runs.
        process.kill(-child.pid!, 'SIGKILL');
        await exited;
        // The server notices the dropped connection and rolls the worker's transaction back.
        const deadlineRollback = Date.now() + 10_000;
        while ((await admin`SELECT 1 FROM pg_stat_activity WHERE usename = ${API_USER} AND state LIKE 'idle in transaction%'`).length > 0) {
          if (Date.now() > deadlineRollback) throw new Error('the killed worker still holds a transaction');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return JSON.parse(readFileSync(marker, 'utf8')) as Record<string, unknown>;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('is repaired by the next run when a run never started after the commit', async () => {
      await setMembership(seed.a, seed.estimatorA, { role: 'office' });
      // The process that committed the change stopped here. A new process starts later.
      const store = memoryStore();
      expect(await runAccessProjection(worker.db, store)).toMatchObject({ granted: 1 });
      expect(store.records.get(key(seed.a, 'estimator-a'))?.role).toBe('office');
    });

    it('is repaired by the next run when the worker dies during the grant', async () => {
      await setMembership(seed.a, seed.estimatorA, { role: 'office' });
      const call = await crashDuringStoreCall(seed.a, seed.estimatorA);
      expect(call).toMatchObject({ kind: 'grant', companyId: seed.a, uid: 'estimator-a', role: 'office' });

      // Nothing was marked done or recorded as failed: the row waits, due now.
      expect(await outbox()).toEqual([
        expect.objectContaining({ actor_id: seed.estimatorA, processed: false, due: true, attempts: 0, last_error_code: null }),
      ]);
      const store = memoryStore();
      expect(await runAccessProjection(worker.db, store)).toMatchObject({ granted: 1, failed: 0 });
      expect(store.records.get(key(seed.a, 'estimator-a'))?.role).toBe('office');
      expect((await outbox())[0]).toMatchObject({ processed: true, attempts: 1 });
    });

    it('is repaired by the next run when the worker dies during the removal', async () => {
      const store = memoryStore();
      await enqueue(seed.a, seed.estimatorA);
      await runAccessProjection(worker.db, store);
      await setMembership(seed.a, seed.estimatorA, { status: 'disabled' });

      const call = await crashDuringStoreCall(seed.a, seed.estimatorA);
      expect(call).toMatchObject({ kind: 'remove', companyId: seed.a, uid: 'estimator-a' });
      expect((await outbox()).filter((row) => !row.processed)).toHaveLength(1);
      // The record may or may not have been removed before the crash; the next run removes it.
      expect(store.records.has(key(seed.a, 'estimator-a'))).toBe(true);
      expect(await runAccessProjection(worker.db, store)).toMatchObject({ removed: 1, failed: 0 });
      expect(store.records.has(key(seed.a, 'estimator-a'))).toBe(false);
      expect((await outbox()).every((row) => row.processed)).toBe(true);
    });
  });

  it('waits after a failed write with a fixed error code, then repairs it', async () => {
    const failing: AccessStore = {
      async grant() {
        throw new Error('quota exceeded for owner-a@example.test');
      },
      async remove() {},
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await enqueue(seed.a, seed.ownerA);
    expect(await runAccessProjection(worker.db, failing)).toMatchObject({ failed: 1 });
    expect(await outbox()).toEqual([
      expect.objectContaining({ processed: false, due: false, attempts: 1, last_error_code: 'store_failed' }),
    ]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain('owner-a');
    errors.mockRestore();

    // Before the back-off ends, a run leaves it alone.
    const store = memoryStore();
    expect(await runAccessProjection(worker.db, store)).toMatchObject({ granted: 0 });
    await backOffPassed();
    expect(await runAccessProjection(worker.db, store)).toMatchObject({ granted: 1 });
    expect((await outbox())[0]).toMatchObject({ processed: true, attempts: 2, last_error_code: null });
  });

  it('a newer change also settles a row still waiting out its back-off, with one write', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing: AccessStore = {
      async grant() {
        throw new Error('unavailable');
      },
      async remove() {},
    };
    await enqueue(seed.a, seed.estimatorA);
    await runAccessProjection(worker.db, failing);
    errors.mockRestore();
    expect((await outbox())[0]).toMatchObject({ processed: false, due: false });

    await setMembership(seed.a, seed.estimatorA, { role: 'office' });
    const store = memoryStore();
    expect(await runAccessProjection(worker.db, store)).toMatchObject({ granted: 1 });
    expect(store.writes).toBe(1);
    expect(store.records.get(key(seed.a, 'estimator-a'))?.role).toBe('office');
    // Both rows are done: the current state covers what each asked for.
    expect((await outbox()).every((row) => row.processed)).toBe(true);
  });

  it('holds the actor until its store call settles, however long that takes', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const started = deferred();
    const finish = deferred();
    const slow: AccessStore = {
      async grant() {
        started.release();
        await finish.promise;
        throw new Error('unavailable');
      },
      async remove() {},
    };
    await enqueue(seed.a, seed.ownerA);
    let settled = false;
    const run = projectActor(worker.db, slow, seed.a, seed.ownerA).finally(() => {
      settled = true;
    });
    await started.promise;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    // Meanwhile no other run takes the actor.
    expect(await renewAccess(handle.db, memoryStore(), { companyId: seed.a, actorId: seed.ownerA })).toBe('busy');

    finish.release();
    expect(await run).toBe('failed');
    expect((await outbox())[0]).toMatchObject({ processed: false, last_error_code: 'store_failed' });
    errors.mockRestore();
  });

  describe('removing a member', () => {
    it('blocks server access first, before the Firestore record is removed', async () => {
      const store = memoryStore();
      await enqueue(seed.a, seed.estimatorA);
      await runAccessProjection(worker.db, store);
      const { resolveIdentity, IdentityRefusal } = await import('@/lib/auth/identity');
      const directory = databaseDirectory(handle.db);
      await expect(resolveIdentity(bearer, verifiedAs('tenant-a', 'estimator-a'), directory)).resolves.toMatchObject({
        role: 'estimator',
      });

      await setMembership(seed.a, seed.estimatorA, { status: 'disabled' });
      // No run yet: the record is still in Firestore, but the server already refuses the member.
      expect(store.records.has(key(seed.a, 'estimator-a'))).toBe(true);
      await expect(resolveIdentity(bearer, verifiedAs('tenant-a', 'estimator-a'), directory)).rejects.toEqual(
        new IdentityRefusal('member_disabled'),
      );

      expect(await runAccessProjection(worker.db, store)).toMatchObject({ removed: 1 });
      expect(store.records.has(key(seed.a, 'estimator-a'))).toBe(false);
      // The other company's person with the same uid keeps nothing of A and loses nothing.
      expect(store.records.has(key(seed.b, 'estimator-a'))).toBe(false);
    });

    it('is reported complete only after the record is confirmed gone', async () => {
      const store = memoryStore();
      await enqueue(seed.a, seed.estimatorA);
      await runAccessProjection(worker.db, store);
      await setMembership(seed.a, seed.estimatorA, { status: 'disabled' });

      // A store whose delete does not take: the read-back still finds the record.
      const stuck: AccessStore = {
        grant: store.grant,
        async remove() {
          throw new AccessStoreError('record_still_present');
        },
      };
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await runAccessProjection(worker.db, stuck)).toMatchObject({ removed: 0, failed: 1 });
      errors.mockRestore();
      const waiting = (await outbox()).filter((row) => !row.processed);
      expect(waiting).toEqual([expect.objectContaining({ last_error_code: 'record_still_present' })]);

      await backOffPassed();
      expect(await runAccessProjection(worker.db, store)).toMatchObject({ removed: 1 });
      expect((await outbox()).every((row) => row.processed)).toBe(true);
      expect(store.records.has(key(seed.a, 'estimator-a'))).toBe(false);
    });

    it('a slow grant still in progress cannot land after a later removal', async () => {
      const inner = memoryStore();
      const started = deferred();
      const finish = deferred();
      const slowGrant: AccessStore = {
        async grant(grant) {
          started.release();
          await finish.promise;
          await inner.grant(grant);
        },
        remove: inner.remove,
      };
      await enqueue(seed.a, seed.estimatorA);
      const first = projectActor(worker.db, slowGrant, seed.a, seed.estimatorA);
      await started.promise;

      // While the grant is in flight, the member is disabled and a second run starts.
      await setMembership(seed.a, seed.estimatorA, { status: 'disabled' });
      const other = openDatabase({ APP_ENV: 'test', DATABASE_URL: urlAs(API_USER, apiPassword) });
      try {
        const second = projectActor(other.db, inner, seed.a, seed.estimatorA);
        // The request path skips an actor another run holds.
        expect(await renewAccess(handle.db, inner, { companyId: seed.a, actorId: seed.estimatorA })).toBe('busy');
        await new Promise((resolve) => setTimeout(resolve, 300));
        finish.release();
        expect(await first).toBe('granted');
        expect(await second).toBe('removed');
      } finally {
        await other.close();
      }
      expect(inner.records.has(key(seed.a, 'estimator-a'))).toBe(false);
      expect((await outbox()).every((row) => row.processed)).toBe(true);
    });

    describe('when a run loses its lock while its write is on the way', () => {
      // The first run uses its own pool, whose session is ended while its store call waits.
      let lost: ReturnType<typeof openDatabase>;
      beforeEach(() => {
        lost = openDatabase({ APP_ENV: 'test', DATABASE_URL: urlAs(API_USER, apiPassword) });
      });
      afterEach(async () => {
        await lost.close();
      });

      function heldUntil(inner: AccessStore, finish: Promise<void>, started: () => void): AccessStore {
        return {
          async grant(grant) {
            started();
            await finish;
            await inner.grant(grant);
          },
          async remove(companyId, uid, version) {
            started();
            await finish;
            await inner.remove(companyId, uid, version);
          },
        };
      }

      it('a grant that lands after a later removal is refused, and the record stays gone', async () => {
        const inner = memoryStore();
        const started = deferred();
        const finish = deferred();
        await enqueue(seed.a, seed.estimatorA);
        const first = projectActor(lost.db, heldUntil(inner, finish.promise, started.release), seed.a, seed.estimatorA);
        await started.promise;

        await setMembership(seed.a, seed.estimatorA, { status: 'disabled' });
        await dropLockHolder();
        expect(await projectActor(worker.db, inner, seed.a, seed.estimatorA)).toBe('removed');
        expect((await outbox()).every((row) => row.processed)).toBe(true);

        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        finish.release();
        expect(await first).toBe('failed');
        errors.mockRestore();
        expect(inner.records.has(key(seed.a, 'estimator-a'))).toBe(false);
        expect((await outbox()).every((row) => row.processed)).toBe(true);
      });

      it('a removal that lands after a later grant is refused, and renewal can trust the grant', async () => {
        const inner = memoryStore();
        await enqueue(seed.a, seed.estimatorA);
        await runAccessProjection(worker.db, inner);
        const started = deferred();
        const finish = deferred();
        await setMembership(seed.a, seed.estimatorA, { status: 'disabled' });
        const first = projectActor(lost.db, heldUntil(inner, finish.promise, started.release), seed.a, seed.estimatorA);
        await started.promise;

        await setMembership(seed.a, seed.estimatorA, { status: 'active' });
        await dropLockHolder();
        expect(await projectActor(worker.db, inner, seed.a, seed.estimatorA)).toBe('granted');

        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        finish.release();
        expect(await first).toBe('failed');
        errors.mockRestore();
        expect(inner.records.get(key(seed.a, 'estimator-a'))?.role).toBe('estimator');
        // The processed grant is the record Firestore holds, so renewal is right to skip it.
        expect(await renewAccess(handle.db, inner, { companyId: seed.a, actorId: seed.estimatorA })).toBe('current');
        expect(inner.records.has(key(seed.a, 'estimator-a'))).toBe(true);
      });
    });
  });

  it('removes the records of a company that is no longer active', async () => {
    const store = memoryStore();
    await enqueue(seed.a, seed.ownerA);
    await enqueue(seed.a, seed.estimatorA);
    await runAccessProjection(worker.db, store);
    // A platform operator action (S3-9) suspends the company and queues its members.
    await admin`UPDATE companies SET status = 'suspended' WHERE id = ${seed.a}`;
    await enqueue(seed.a, seed.ownerA);
    await enqueue(seed.a, seed.estimatorA);
    expect(await runAccessProjection(worker.db, store)).toMatchObject({ removed: 2 });
    expect([...store.records.keys()].filter((name) => name.startsWith(seed.a))).toEqual([]);
  });

  describe('renewal while the member uses the app', () => {
    it('writes the record on first use, then not again until it is due', async () => {
      const store = memoryStore();
      const member = { companyId: seed.a, actorId: seed.estimatorA };
      expect(await renewAccess(handle.db, store, member)).toBe('granted');
      const first = store.records.get(key(seed.a, 'estimator-a'))!.expiresAt;
      expect(await renewAccess(handle.db, store, member)).toBe('current');
      expect(await outbox()).toHaveLength(1);

      // A day later the record is written again with a later expiry.
      await admin`UPDATE access_projection_outbox SET processed_at = now() - interval '25 hours'`;
      const later = new Date(Date.now() + 60 * 60 * 1000);
      expect(await renewAccess(handle.db, store, member, { now: () => later })).toBe('granted');
      expect(store.records.get(key(seed.a, 'estimator-a'))!.expiresAt.getTime()).toBeGreaterThan(first.getTime());
      expect(await outbox()).toHaveLength(2);
    });

    it('does not renew a member who stops using the app, so the record runs out', async () => {
      const store = memoryStore();
      await renewAccess(handle.db, store, { companyId: seed.a, actorId: seed.estimatorA });
      expect(await runAccessProjection(worker.db, store)).toMatchObject({ granted: 0 });
      // Nothing but use renews it: the expiry stays at most ACCESS_TTL_MS after the last write.
      expect(store.records.get(key(seed.a, 'estimator-a'))!.expiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + ACCESS_TTL_MS,
      );
    });

    it('does not count a write the store refused as stale as written', async () => {
      const store = memoryStore();
      const member = { companyId: seed.a, actorId: seed.estimatorA };
      // The store already holds a newer decision than this run's.
      store.versions.set(key(seed.a, 'estimator-a'), Number.MAX_SAFE_INTEGER);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await renewAccess(handle.db, store, member)).toBe('failed');
      expect(await outbox()).toEqual([
        expect.objectContaining({ processed: false, attempts: 1, last_error_code: 'stale_decision' }),
      ]);
      expect(store.records.size).toBe(0);

      // After the back-off the next use tries the write again instead of treating it as current.
      await backOffPassed();
      expect(await renewAccess(handle.db, store, member)).toBe('failed');
      expect((await outbox())[0]).toMatchObject({ processed: false, attempts: 2 });
      errors.mockRestore();
    });

    it('stays in its own company', async () => {
      const store = memoryStore();
      // An actor id of company B named with company A finds nothing in A and cannot queue a row.
      expect(await errorCode(renewAccess(handle.db, store, { companyId: seed.a, actorId: seed.estimatorB }))).toBe('23503');
      expect(await outbox()).toEqual([]);
      expect(store.writes).toBe(0);
    });
  });

  describe('migration 0005', () => {
    it('lets the runtime find which companies have work due, and nothing else', async () => {
      await enqueue(seed.a, seed.ownerA);
      await enqueue(seed.b, seed.estimatorB);
      const due = await api<{ id: string }[]>`SELECT access_projection_due_companies(10)::text AS id`;
      expect(due.map((row) => row.id).sort()).toEqual([seed.a, seed.b].sort());
      expect(await api`SELECT access_projection_due_companies(1)`).toHaveLength(1);

      // Outside the function the runtime still sees no outbox row without a company, even with
      // the function's setting turned on.
      expect(await api`SELECT * FROM access_projection_outbox`).toHaveLength(0);
      await api.begin(async (tx) => {
        await tx`SELECT set_config('app.projection_scan', 'on', true)`;
        expect(await tx`SELECT * FROM access_projection_outbox`).toHaveLength(0);
      });
      expect(await api`SELECT current_setting('app.projection_scan', true) AS v`).toEqual([{ v: '' }]);
    });

    it('leaves out rows that are done or not yet due', async () => {
      const store = memoryStore();
      await enqueue(seed.a, seed.ownerA);
      await runAccessProjection(worker.db, store);
      await enqueue(seed.b, seed.estimatorB);
      await admin`UPDATE access_projection_outbox SET available_at = now() + interval '1 hour' WHERE company_id = ${seed.b}`;
      expect(await api`SELECT access_projection_due_companies(10)`).toEqual([]);
    });

    it('refuses everyone but the runtime, and the owner reads nothing through it', async () => {
      await enqueue(seed.a, seed.ownerA);
      const other = connect(OTHER_USER, otherPassword);
      const migrator = connect(MIGRATOR, migratorPassword);
      try {
        expect(await errorCode(other`SELECT access_projection_due_companies(10)`)).toBe(INSUFFICIENT_PRIVILEGE);
        expect(await errorCode(other`SELECT * FROM access_projection_outbox`)).toBe(INSUFFICIENT_PRIVILEGE);
        // The owner signed in as itself: the policy's session check matches nothing.
        expect(await migrator`SELECT access_projection_due_companies(10)`).toEqual([]);
        await migrator.begin(async (tx) => {
          await tx`SELECT set_config('app.projection_scan', 'on', true)`;
          expect(await tx`SELECT * FROM access_projection_outbox`).toHaveLength(0);
        });
        // The policy is for reading only; the owner still cannot change a row.
        expect(await migrator`UPDATE access_projection_outbox SET attempts = 9 RETURNING id`).toHaveLength(0);
      } finally {
        await other.end({ timeout: 5 });
        await migrator.end({ timeout: 5 });
      }
    });

    it('refuses a size outside 1 to 100', async () => {
      expect(await errorCode(api`SELECT access_projection_due_companies(0)`)).toBe(INVALID_PARAMETER);
      expect(await errorCode(api`SELECT access_projection_due_companies(101)`)).toBe(INVALID_PARAMETER);
      expect(await api`SELECT access_projection_due_companies(NULL)`).toEqual([]);
    });

    it('leaves every table protected', async () => {
      expect(await unprotectedRelations(admin)).toEqual([]);
    });
  });
});
