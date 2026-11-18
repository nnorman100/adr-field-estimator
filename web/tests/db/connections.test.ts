import { sql as dsql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDatabase, openDatabase } from '@/db/client';
import { parseConfig } from '@/lib/config';
import { startDisposablePostgres, type DisposablePostgres } from './postgres-harness';

// How many connections one instance's pools open (web/src/db/client.ts). Each test reads the
// server's own view, pg_stat_activity and pg_locks, from a connection of its own.

let server: DisposablePostgres;
let observer: ReturnType<typeof postgres>;

beforeAll(async () => {
  server = await startDisposablePostgres();
  observer = postgres(server.databaseUrl, { max: 1, onnotice: () => {}, connection: { application_name: 'observer' } });
});

afterAll(async () => {
  await observer?.end({ timeout: 5 });
  await server?.stop();
});

const env = () => ({ APP_ENV: 'test', DATABASE_URL: server.databaseUrl });

// Resolves once `count` callers have arrived, so each caller knows the others are open too. Fails
// every caller after `ms` instead, naming how many arrived: a pool too small to open them all at
// once never lets the last one in.
function meeting(count: number, ms: number) {
  let arrived = 0;
  let release!: () => void;
  let fail!: (error: Error) => void;
  const everyone = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  everyone.catch(() => {});
  const timer = setTimeout(() => fail(new Error(`only ${arrived} of ${count} transactions were open at once`)), ms);
  return async () => {
    arrived += 1;
    if (arrived === count) {
      clearTimeout(timer);
      release();
    }
    await everyone;
  };
}

const appConnections = async () => {
  const [row] = await observer<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = ${server.databaseName} AND application_name = 'dryscope-web'
  `;
  return row?.n;
};

describe('the main pool', () => {
  it('lets two requests hold transactions at the same moment on one instance', async () => {
    const handle = openDatabase(env());
    try {
      const allOpen = meeting(2, 5_000);
      const allRead = meeting(2, 5_000);
      // Each request takes its own advisory lock inside its transaction and keeps the transaction
      // open until the other has taken its lock too, and then until both have read the locks. Both
      // locks are held at once, by two different server processes.
      const request = (key: number) =>
        handle.db.transaction(async (tx) => {
          await tx.execute(dsql`SELECT pg_advisory_xact_lock(${key})`);
          await allOpen();
          const held = (await tx.execute(dsql`
            SELECT count(DISTINCT pid)::int AS holders, count(*)::int AS locks FROM pg_locks
            WHERE locktype = 'advisory' AND granted AND objid IN (8201, 8202)
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          `)) as unknown as { holders: number; locks: number }[];
          await allRead();
          return held[0];
        });

      const both = await Promise.all([request(8201), request(8202)]);
      expect(both).toEqual([
        { holders: 2, locks: 2 },
        { holders: 2, locks: 2 },
      ]);
    } finally {
      await handle.close();
    }
  });
});

describe('the health probe', () => {
  it('opens one connection, however many health checks run at once', async () => {
    const config = parseConfig(env());
    expect(await appConnections()).toBe(0);
    await Promise.all(Array.from({ length: 12 }, () => checkDatabase(config)));
    expect(await appConnections()).toBe(1);
  });
});

// Security audit F5: a transaction held open across an outside call, or a slow statement, must not
// hold the main pool for every other caller. Each connection carries the server's time limits, and
// a caller that cannot get a connection is refused instead of waiting without end.
describe('the time limits on app connections', () => {
  const codeOf = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (error) {
      const found = error as { code?: string; cause?: { code?: string } };
      return found.code ?? found.cause?.code ?? 'failed';
    }
    return 'answered';
  };
  const timed = async (work: Promise<unknown>) => {
    const started = Date.now();
    const code = await codeOf(work);
    return { code, ms: Date.now() - started };
  };
  const until = async (check: () => Promise<boolean>, ms: number) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('the condition did not hold in time');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  it('sets the statement, lock and idle-in-transaction limits on every connection', async () => {
    const handle = openDatabase(env());
    try {
      const rows = (await handle.db.execute(dsql`
        SELECT current_setting('statement_timeout') AS statement,
               current_setting('lock_timeout') AS lock,
               current_setting('idle_in_transaction_session_timeout') AS idle
      `)) as unknown as Record<string, string>[];
      expect(rows[0]).toEqual({ statement: '30s', lock: '10s', idle: '30s' });
    } finally {
      await handle.close();
    }
  });

  it('refuses a caller the full pool cannot serve, ends what is held and serves callers again', { timeout: 90_000 }, async () => {
    await observer`CREATE TABLE limit_rows (id int PRIMARY KEY, note text)`;
    await observer`INSERT INTO limit_rows VALUES (1, 'kept')`;
    const handle = openDatabase(env());
    const other = openDatabase(env());
    try {
      // Every main pool connection is taken: two transactions lock a row each and then wait on an
      // outside call that never answers, and one runs a statement longer than the limit.
      let answer!: () => void;
      const outside = new Promise<void>((resolve) => (answer = resolve));
      const holder = (id: number) =>
        handle.db.transaction(async (tx) => {
          await tx.execute(dsql`INSERT INTO limit_rows VALUES (${id + 10}, 'uncommitted')`);
          await tx.execute(dsql`SELECT 1 FROM limit_rows WHERE id = ${id} FOR UPDATE`);
          await outside;
          await tx.execute(dsql`SELECT 1`);
        });
      await observer`INSERT INTO limit_rows VALUES (2, 'kept')`;
      const held = [timed(holder(1)), timed(holder(2))];
      const slow = timed(handle.db.transaction((tx) => tx.execute(dsql`SELECT pg_sleep(60)`)));
      const busy = async () => {
        const [row] = await observer<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = ${server.databaseName} AND application_name = 'dryscope-web' AND state <> 'idle'
        `;
        return row?.n ?? 0;
      };
      await until(async () => (await busy()) === 3, 10_000);

      // A fourth caller on the same instance (a transaction, as every company read is) is refused
      // once the queue limit passes, and a caller of another pool waiting for a held row lock is
      // refused once the lock limit passes.
      const [queued, locked] = await Promise.all([
        timed(handle.db.transaction((tx) => tx.execute(dsql`SELECT 1`))),
        timed(other.db.transaction((tx) => tx.execute(dsql`SELECT 1 FROM limit_rows WHERE id = 1 FOR UPDATE`))),
      ]);
      expect(queued.code).toBe('QUEUE_TIMEOUT');
      expect(queued.ms).toBeGreaterThanOrEqual(9_500);
      expect(queued.ms).toBeLessThan(20_000);
      expect(locked.code).toBe('55P03');
      expect(locked.ms).toBeGreaterThanOrEqual(9_500);
      expect(locked.ms).toBeLessThan(20_000);

      // The server cancels the slow statement and ends the idle transactions; their writes are
      // gone and their row locks released. Then the outside call answers, too late.
      const statement = await slow;
      expect(statement.code).toBe('57014');
      expect(statement.ms).toBeLessThan(45_000);
      await until(async () => (await busy()) === 0, 45_000);
      answer();
      for (const result of await Promise.all(held)) expect(result.code).not.toBe('answered');
      expect(await observer`SELECT id FROM limit_rows WHERE note = 'uncommitted'`).toHaveLength(0);
      expect(await observer.begin((tx) => tx`SELECT id FROM limit_rows WHERE id IN (1, 2) FOR UPDATE NOWAIT`)).toHaveLength(2);

      // The pool serves callers again.
      expect(await codeOf(handle.db.execute(dsql`SELECT 1`))).toBe('answered');
    } finally {
      await other.close();
      await handle.close();
    }
  });
});
