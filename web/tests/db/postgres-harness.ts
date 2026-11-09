import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, chmod, access, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { constants } from 'node:fs';
import { promisify } from 'node:util';
import postgres from 'postgres';

const exec = promisify(execFile);
const DISCARD_NAME = /^dryscope_discard_[a-f0-9]{16}$/;

export type DisposablePostgres = {
  databaseUrl: string;
  databaseName: string;
  stop: () => Promise<void>;
};

// Live is never a place for a throwaway database. An external URL must be loopback and
// opted in, so a Cloud SQL proxy on localhost is not wiped by accident.
export function assertHarnessAllowed(env: Record<string, string | undefined>): void {
  if (env.APP_ENV === 'live') {
    throw new Error('Refusing to start a disposable database when APP_ENV is live');
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) return;
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a postgres URL');
  }
  const host = url.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error('Refusing to create a throwaway database on a non-loopback host');
  }
  if (env.DRYSCOPE_DISPOSABLE_DATABASE !== '1') {
    throw new Error('Set DRYSCOPE_DISPOSABLE_DATABASE=1 to create a throwaway database from DATABASE_URL');
  }
}

export function quoteDiscardName(name: string): string {
  if (!DISCARD_NAME.test(name)) {
    throw new Error('Refusing to touch a database outside the throwaway name pattern');
  }
  return `"${name}"`;
}

async function run(
  command: string,
  args: string[],
  options?: { asPostgres?: boolean; timeoutMs?: number },
): Promise<string> {
  const asRoot = (process.getuid?.() ?? 0) === 0;
  const useRunuser = options?.asPostgres === true && asRoot;
  const file = useRunuser ? 'runuser' : command;
  const fileArgs = useRunuser ? ['-u', 'postgres', '--', command, ...args] : args;
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: [process.env.PATH, '/usr/local/sbin', '/usr/sbin', '/usr/bin', '/bin'].filter(Boolean).join(':'),
      LANG: 'C',
      LC_ALL: 'C',
    };
    delete env.DATABASE_URL;
    const { stdout } = await exec(file, fileArgs, {
      timeout: options?.timeoutMs ?? 40_000,
      env,
    });
    return stdout;
  } catch (error) {
    const detail =
      error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr
        : error instanceof Error
          ? error.message
          : 'command failed';
    throw new Error(detail.slice(-800).replace(/postgres(?:ql)?:\/\/\S+/gi, '[database]'));
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address !== 'string') resolve(address.port);
        else reject(new Error('Could not allocate a local port'));
      });
    });
  });
}

async function postgres16Bin(): Promise<string> {
  const bundled = '/usr/lib/postgresql/16/bin';
  try {
    await access(join(bundled, 'initdb'), constants.X_OK);
    return bundled;
  } catch {
    // Fall through to PATH.
  }
  const { stdout } = await exec('which', ['initdb'], { timeout: 5_000 });
  const initdb = stdout.trim();
  const version = await exec(initdb, ['--version'], { timeout: 5_000 });
  if (!/PostgreSQL\) 16\./.test(version.stdout)) {
    throw new Error(`Found ${version.stdout.trim()} and need PostgreSQL 16`);
  }
  return dirname(initdb);
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await exec('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function waitForQuery(databaseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'not ready';
  while (Date.now() < deadline) {
    const sql = postgres(databaseUrl, { max: 1, connect_timeout: 2, onnotice: () => {} });
    try {
      await sql`SELECT 1`;
      await sql.end({ timeout: 2 });
      return;
    } catch (error) {
      last = error instanceof Error ? error.message : 'not ready';
      await sql.end({ timeout: 1 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(
    `PostgreSQL did not accept queries within ${timeoutMs} ms: ${last.replace(/postgres(?:ql)?:\/\/\S+/gi, '[database]')}`,
  );
}

async function startDockerPostgres(): Promise<{ databaseUrl: string; stop: () => Promise<void> }> {
  const name = `dryscope-pg-${process.pid}-${randomBytes(4).toString('hex')}`;
  await run(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '-e',
      'POSTGRES_USER=dryscope',
      '-e',
      'POSTGRES_PASSWORD=dryscope',
      '-e',
      'POSTGRES_DB=dryscope',
      '-p',
      '127.0.0.1::5432',
      'postgres:16',
    ],
    { timeoutMs: 90_000 },
  );
  const stop = async () => {
    await run('docker', ['rm', '-f', name], { timeoutMs: 20_000 }).catch(() => {});
  };
  try {
    const mapped = await run('docker', ['port', name, '5432'], { timeoutMs: 10_000 });
    const port = /(\d+)\s*$/.exec(mapped.trim())?.[1];
    if (!port) throw new Error('Docker did not publish a Postgres port');
    const databaseUrl = `postgres://dryscope:dryscope@127.0.0.1:${port}/dryscope`;
    await waitForQuery(databaseUrl, 30_000);
    return { databaseUrl, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function startPgCtlPostgres(): Promise<{ databaseUrl: string; stop: () => Promise<void> }> {
  const binDir = await postgres16Bin();
  const dataDir = await mkdtemp(join(tmpdir(), 'dryscope-pg-'));
  const port = await freePort();
  const asRoot = (process.getuid?.() ?? 0) === 0;
  if (asRoot) {
    await run('chown', ['postgres:postgres', dataDir]);
    await run('chmod', ['700', dataDir]);
  } else {
    await chmod(dataDir, 0o700);
  }
  const stop = async () => {
    await run(join(binDir, 'pg_ctl'), ['-D', dataDir, '-m', 'immediate', 'stop'], {
      asPostgres: asRoot,
      timeoutMs: 20_000,
    }).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  };
  try {
    await run(
      join(binDir, 'initdb'),
      [
        '-D',
        dataDir,
        '-U',
        'dryscope',
        '--auth-local=trust',
        '--auth-host=trust',
        '--encoding=UTF8',
        '--no-locale',
        '--no-sync',
        '--no-instructions',
      ],
      { asPostgres: asRoot, timeoutMs: 40_000 },
    );
    try {
      await run(
        join(binDir, 'pg_ctl'),
        [
          '-D',
          dataDir,
          '-l',
          join(dataDir, 'server.log'),
          '-w',
          '-t',
          '30',
          'start',
          '-o',
          `-c listen_addresses=127.0.0.1 -c port=${port} -c unix_socket_directories=${dataDir}`,
        ],
        { asPostgres: asRoot, timeoutMs: 40_000 },
      );
    } catch (error) {
      const log = await readFile(join(dataDir, 'server.log'), 'utf8').catch(() => '');
      const tail = log.slice(-500).replace(/postgres(?:ql)?:\/\/\S+/gi, '[database]');
      throw new Error(`${error instanceof Error ? error.message : 'pg_ctl failed'}\n${tail}`);
    }
    // initdb creates the postgres database, not one named after the superuser.
    const databaseUrl = `postgres://dryscope@127.0.0.1:${port}/postgres`;
    await waitForQuery(databaseUrl, 15_000);
    return { databaseUrl, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function startOwnedServer(): Promise<{ databaseUrl: string; stop: () => Promise<void> }> {
  const errors: string[] = [];
  if (await dockerAvailable()) {
    try {
      return await startDockerPostgres();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'docker failed');
    }
  }
  try {
    return await startPgCtlPostgres();
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'local PostgreSQL failed');
  }
  throw new Error(
    `Could not start a throwaway PostgreSQL 16 within the time limit. ${errors.join(' ')} Install Docker or PostgreSQL 16, or set DATABASE_URL to a loopback throwaway database and DRYSCOPE_DISPOSABLE_DATABASE=1.`,
  );
}

function databaseUrlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function createDiscardDatabase(adminUrl: string): Promise<{
  databaseName: string;
  databaseUrl: string;
  drop: () => Promise<void>;
}> {
  const databaseName = `dryscope_discard_${randomBytes(8).toString('hex')}`;
  const sql = postgres(adminUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    await sql.unsafe(`CREATE DATABASE ${quoteDiscardName(databaseName)}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
  return {
    databaseName,
    databaseUrl: databaseUrlFor(adminUrl, databaseName),
    drop: async () => {
      const admin = postgres(adminUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteDiscardName(databaseName)} WITH (FORCE)`);
      } finally {
        await admin.end({ timeout: 5 });
      }
    },
  };
}

export async function startDisposablePostgres(
  env: Record<string, string | undefined> = process.env,
): Promise<DisposablePostgres> {
  assertHarnessAllowed(env);
  const owned = env.DATABASE_URL ? null : await startOwnedServer();
  const adminUrl = env.DATABASE_URL ?? owned?.databaseUrl;
  if (!adminUrl) throw new Error('No disposable Postgres is available');
  try {
    const discard = await createDiscardDatabase(adminUrl);
    return {
      databaseUrl: discard.databaseUrl,
      databaseName: discard.databaseName,
      stop: async () => {
        await discard.drop().catch(() => {});
        await owned?.stop();
      },
    };
  } catch (error) {
    await owned?.stop();
    throw error;
  }
}

export async function emptyDiscardDatabase(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const rows = await sql<{ name: string }[]>`SELECT current_database() AS name`;
    quoteDiscardName(rows[0]?.name ?? '');
    await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await sql.unsafe('CREATE SCHEMA public');
  } finally {
    await sql.end({ timeout: 5 });
  }
}
