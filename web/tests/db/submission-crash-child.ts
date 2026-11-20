// Run by submission-crash.test.ts as a separate process, then killed with SIGKILL at one step of
// Submit: a real crash between the Postgres side and the Firestore side. The field database is the
// file-backed stand-in both processes share (tests/submissions/field-fake.ts); at the named call the
// child writes a marker file and never returns, before that call changes anything. `fence` and
// `markSubmitted` name the two draft syncs of an attempt (its fence, and its marker after the decision).
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
const crash = () => {
  writeFileSync(CRASH_MARKER, CRASH_AT);
  return new Promise<never>(() => {});
};
// The fence and the marker are the job's draft sync (src/lib/jobs/sync-job.ts): the fence the
// attempt's first sync, the marker the sync after its decision. A gate is used once.
if (CRASH_AT === 'fence') field.gate.sync = crash;
else if (CRASH_AT === 'markSubmitted') {
  field.gate.sync = async () => {
    field.gate.sync = crash;
  };
} else field.gate[CRASH_AT as keyof FenceStore] = crash;

const { db } = openDatabase({ APP_ENV: 'test', DATABASE_URL: CRASH_DATABASE_URL });
const service = submissionsService(db, field, { windowMs: Number(CRASH_WINDOW_MS), fenceMarginMs: 200 });
await service.submit(JSON.parse(CRASH_CALLER) as JobCaller, CRASH_JOB, JSON.parse(CRASH_BODY));
