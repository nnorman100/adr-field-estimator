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
