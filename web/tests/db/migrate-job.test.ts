import { execFile } from 'node:child_process';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { emptyDiscardDatabase, startDisposablePostgres, type DisposablePostgres } from './postgres-harness';

// The Cloud Run migration job runs `node migrate.mjs` in the image's /app tree
// (infra/dryscope/app/migrate_job.tf). web/scripts/build-migrate.mjs bundles it there with the
// ledger beside it; build-image.sh calls it through `npm run build:migrate`. This runs the bundle
// exactly that way, outside web/, with no node_modules next to it.
const exec = promisify(execFile);
const webRoot = fileURLToPath(new URL('../..', import.meta.url));

let disposable: DisposablePostgres;
let app: string;

beforeAll(async () => {
  disposable = await startDisposablePostgres();
  app = await mkdtemp(join(tmpdir(), 'dryscope-job-'));
  await exec('npm', ['run', '--silent', 'build:migrate', '--', app], { cwd: webRoot, timeout: 60_000 });
});

afterAll(async () => {
  await disposable?.stop();
  if (app) await rm(app, { recursive: true, force: true });
});

beforeEach(async () => {
  await emptyDiscardDatabase(disposable.databaseUrl);
});

// Only the given settings plus PATH: nothing from this machine's environment leaks in.
const only = (settings: Record<string, string>) =>
  ({ PATH: process.env.PATH ?? '', ...settings }) as unknown as NodeJS.ProcessEnv;

function runJob() {
  return exec(process.execPath, ['migrate.mjs'], {
    cwd: app,
    timeout: 30_000,
    env: only({ APP_ENV: 'test', DATABASE_URL: disposable.databaseUrl }),
  });
}

describe('migration job bundle', () => {
  it('carries the shipped ledger beside one self-contained entry', async () => {
    expect((await readdir(join(app, 'migrations'))).sort()).toEqual(
      (await readdir(join(webRoot, 'migrations'))).sort(),
    );
    await access(join(app, 'migrate.mjs'));
    await expect(access(join(app, 'node_modules'))).rejects.toThrow();
  });

  it('applies every pending migration, then none on a second run', async () => {
    const first = await runJob();
    expect(first.stdout).toMatch(/^migrations: applied 0001_foundation 0002_identity/);
    const sql = postgres(disposable.databaseUrl, { max: 1, onnotice: () => {} });
    try {
      const ledger = await sql<{ id: string }[]>`SELECT id FROM migration_ledger ORDER BY id`;
      const shipped = (await readdir(join(webRoot, 'migrations'))).map((f) => f.replace(/\.sql$/, ''));
      expect(ledger.map((row) => row.id)).toEqual(shipped.sort());
    } finally {
      await sql.end({ timeout: 5 });
    }
    const second = await runJob();
    expect(second.stdout.trim()).toBe('migrations: none pending');
  });

  it('exits non-zero without a database setting and does not echo the environment', async () => {
    const run = exec(process.execPath, ['migrate.mjs'], {
      cwd: app,
      timeout: 30_000,
      env: only({ APP_ENV: 'test' }),
    });
    await expect(run).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/DATABASE_URL/) });
  });
});
