import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { manifestDigest, type FieldManifest } from '@/lib/field/canonical';
import { fakeField, fileBacking, type FakeField } from '../submissions/field-fake';
import { flow } from './submission-flow';
import type { FakeClaims, Harness } from './team-harness';

// S5a-8: a crash after the intent row, after the fence and after the commit each end in exactly one
// outcome (one record and a `submitted` draft, or an aborted row and an `editing` draft), by killing
// the process that runs Submit (SIGKILL to its process group, so no clean-up code runs), as the
// S3-12 tests do. The killed process and this test share the field database through the
// file-backed stand-in; the next request or the worker then finishes the work.
const live = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/jobs/services', () => ({ jobsServices: () => live.harness!.jobs }));
vi.mock('@/lib/photos/services', () => ({ photosServices: () => live.harness!.photos }));

const jobsRoute = await import('@/app/api/jobs/route');
const photoRoute = await import('@/app/api/jobs/[jobId]/photos/[photoId]/route');
const { submissionsService } = await import('@/lib/submissions/service');
const { runSubmissionRepair } = await import('@/lib/submissions/repair');
const { runDraftSyncRepair } = await import('@/lib/jobs/sync-repair');
const { params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;
let dir: string;
let field: FakeField;

const ESTIMATOR_A: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a' };
const WINDOW_MS = 4000;
const webDir = fileURLToPath(new URL('../..', import.meta.url));

const f = flow(() => h, {
  createJob: jobsRoute.POST,
  putPhoto: photoRoute.PUT,
  submit: () => {
    throw new Error('not used');
  },
  nextDraft: () => {
    throw new Error('not used');
  },
  request,
  params,
});

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  rmSync(dir ?? '/nonexistent', { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), 'dryscope-submit-crash-'));
  field = fakeField(fileBacking(join(dir, 'field.json')));
});

afterAll(async () => {
  rmSync(dir ?? '/nonexistent', { recursive: true, force: true });
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

// A job ready to submit, its draft in the shared file.
async function ready(): Promise<{ jobId: string; draftId: string; manifest: FieldManifest; body: { id: string; draftId: string; digest: string } }> {
  const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
  field.put(h.seed.a, draftId, manifest, 'estimator-a');
  return { jobId, draftId, manifest, body: { id: randomUUID(), draftId, digest: await manifestDigest(manifest) } };
}

// Runs Submit in its own process and kills it at the named call.
async function crashAt(at: 'fence' | 'read' | 'markSubmitted', jobId: string, body: object): Promise<void> {
  const marker = join(dir, 'reached');
  rmSync(marker, { force: true });
  const caller = { companyId: h.seed.a, actorId: h.seed.estimatorA.actor, uid: 'estimator-a', role: 'estimator', capabilities: ['jobs_read', 'scope', 'photos'] };
  const child = spawn('npx', ['tsx', 'tests/db/submission-crash-child.ts'], {
    cwd: webDir,
    env: {
      ...process.env,
      DATABASE_URL: '',
      CRASH_DATABASE_URL: h.apiUrl,
      CRASH_CALLER: JSON.stringify(caller),
      CRASH_JOB: jobId,
      CRASH_BODY: JSON.stringify(body),
      CRASH_FIELD: join(dir, 'field.json'),
      CRASH_AT: at,
      CRASH_MARKER: marker,
      CRASH_WINDOW_MS: String(WINDOW_MS),
    },
    stdio: 'ignore',
    detached: true,
  });
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  const deadline = Date.now() + 25_000;
  while (!existsSync(marker) || readFileSync(marker, 'utf8') !== at) {
    if (Date.now() > deadline) throw new Error(`the Submit process never reached ${at}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  process.kill(-child.pid!, 'SIGKILL');
  await exited;
  const user = new URL(h.apiUrl).username;
  const rollback = Date.now() + 10_000;
  while ((await h.admin`SELECT 1 FROM pg_stat_activity WHERE usename = ${user} AND datname = current_database() AND state LIKE 'idle in transaction%'`).length > 0) {
    if (Date.now() > rollback) throw new Error('the killed process still holds a transaction');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const rows = (jobId: string) => f.submissions(jobId);
const expire = () => new Promise((resolve) => setTimeout(resolve, WINDOW_MS + 200));
const repair = () => runSubmissionRepair(h.handle.db, field, { markerGraceSeconds: 0 });

// Exactly one outcome: a committed record and a submitted draft, or an aborted row and an editing draft.
async function outcome(jobId: string, draftId: string): Promise<'committed' | 'aborted'> {
  const found = await rows(jobId);
  expect(found.filter((row) => row.status === 'pending')).toEqual([]);
  expect(found.every((row) => row.marker_state === 'done')).toBe(true);
  const committed = found.filter((row) => row.status === 'committed');
  const draft = field.draft(h.seed.a, draftId);
  if (committed.length === 1) {
    expect(draft).toMatchObject({ state: 'submitted', fence: { submissionId: committed[0]!.id, epoch: committed[0]!.epoch } });
    expect((await f.job(jobId)).status).toBe('submitted');
    return 'committed';
  }
  expect(committed).toEqual([]);
  expect(draft).toMatchObject({ state: 'editing', fence: null });
  expect((await f.job(jobId)).status).toBe('draft');
  return 'aborted';
}

describe('a crash during Submit', () => {
  it('after the intent row: the worker aborts the row after its expiry and the draft stays editing', async () => {
    const { jobId, draftId, body } = await ready();
    await crashAt('fence', jobId, body);
    expect(await rows(jobId)).toEqual([expect.objectContaining({ status: 'pending', marker_state: 'pending' })]);
    expect(field.draft(h.seed.a, draftId)?.state).toBe('editing');
    expect(await repair()).toEqual({ aborted: 0, marked: 0, failed: 0 });
    await expire();
    expect(await repair()).toEqual({ aborted: 1, marked: 1, failed: 0 });
    expect(await outcome(jobId, draftId)).toBe('aborted');
  });

  // A Submit deciding (its row pending) and its draft lost: the draft sync's repair pass makes no draft
  // while that attempt could still record it, and the worker's abort makes it, editing.
  it('after the intent row, with the draft lost: no draft is made while the attempt is pending, and the abort makes it editing', async () => {
    const { jobId, draftId, body } = await ready();
    await crashAt('fence', jobId, body);
    field.remove(h.seed.a, draftId);
    expect(await runDraftSyncRepair(h.handle.db, field, { graceSeconds: 0 })).toEqual({ synced: 0, failed: 1 });
    expect(field.draft(h.seed.a, draftId)).toBeNull();
    await expire();
    expect(await repair()).toEqual({ aborted: 1, marked: 1, failed: 0 });
    expect(field.draft(h.seed.a, draftId)).toMatchObject({ jobId, state: 'editing', fence: null });
    expect(await rows(jobId)).toEqual([expect.objectContaining({ status: 'aborted', marker_state: 'done' })]);
  });

  it('after the fence: the worker aborts the row after its expiry and releases the draft', async () => {
    const { jobId, draftId, body } = await ready();
    await crashAt('read', jobId, body);
    const [pending] = await rows(jobId);
    expect(pending).toMatchObject({ status: 'pending' });
    expect(field.draft(h.seed.a, draftId)).toMatchObject({ state: 'submitting', fence: { submissionId: body.id, epoch: pending!.epoch } });
    await expire();
    expect(await repair()).toEqual({ aborted: 1, marked: 1, failed: 0 });
    expect(await outcome(jobId, draftId)).toBe('aborted');
  });

  it('after the fence: the phone’s retry of the same request records it once', async () => {
    const { jobId, draftId, body } = await ready();
    await crashAt('read', jobId, body);
    const service = submissionsService(h.handle.db, field, { windowMs: WINDOW_MS, fenceMarginMs: 200 });
    const caller = { companyId: h.seed.a, actorId: h.seed.estimatorA.actor, uid: 'estimator-a', role: 'estimator' as const, capabilities: ['jobs_read', 'scope', 'photos'] as never };
    expect(await service.submit(caller, jobId, body)).toMatchObject({ created: true, submission: { id: body.id } });
    expect(await outcome(jobId, draftId)).toBe('committed');
    await expire();
    expect(await repair()).toEqual({ aborted: 0, marked: 0, failed: 0 });
    expect(await outcome(jobId, draftId)).toBe('committed');
  });

  it('after the commit: the worker writes the submitted marker', async () => {
    const { jobId, draftId, body } = await ready();
    await crashAt('markSubmitted', jobId, body);
    expect(await rows(jobId)).toEqual([expect.objectContaining({ status: 'committed', marker_state: 'pending' })]);
    expect(field.draft(h.seed.a, draftId)?.state).toBe('submitting');
    expect(await repair()).toEqual({ aborted: 0, marked: 1, failed: 0 });
    expect(await outcome(jobId, draftId)).toBe('committed');
  });
});
