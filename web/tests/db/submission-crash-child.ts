// Run by submission-crash.test.ts as a separate process, then killed with SIGKILL at one step of
// Submit: a real crash between the Postgres side and the Firestore side. The field database is the
// file-backed stand-in both processes share (tests/submissions/field-fake.ts); at the named call the
// child writes a marker file and never returns, before that call changes anything.
import { writeFileSync } from 'node:fs';
import { openDatabase } from '@/db/client';
import type { JobCaller } from '@/lib/jobs/access';
import type { FenceStore } from '@/lib/submissions/fence';
import { submissionsService } from '@/lib/submissions/service';
import { fakeField, fileBacking } from '../submissions/field-fake';

const { CRASH_DATABASE_URL, CRASH_CALLER, CRASH_JOB, CRASH_BODY, CRASH_FIELD, CRASH_AT, CRASH_MARKER, CRASH_WINDOW_MS } = process.env;
if (!CRASH_DATABASE_URL || !CRASH_CALLER || !CRASH_JOB || !CRASH_BODY || !CRASH_FIELD || !CRASH_AT || !CRASH_MARKER || !CRASH_WINDOW_MS) {
  process.exit(2);
}

const field = fakeField(fileBacking(CRASH_FIELD));
field.gate[CRASH_AT as keyof FenceStore] = () => {
  writeFileSync(CRASH_MARKER, CRASH_AT);
  return new Promise<never>(() => {});
};

const { db } = openDatabase({ APP_ENV: 'test', DATABASE_URL: CRASH_DATABASE_URL });
const service = submissionsService(db, field, { windowMs: Number(CRASH_WINDOW_MS), fenceMarginMs: 200 });
await service.submit(JSON.parse(CRASH_CALLER) as JobCaller, CRASH_JOB, JSON.parse(CRASH_BODY));
