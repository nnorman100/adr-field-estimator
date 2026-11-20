// Owner-run, read-only check before migration 0016_job_drafts (security audit F1, step 5; firstmate
// ruling 2026-11-18). 0016 stops itself, before its fill, on a job in status draft whose current draft
// has a committed submission in Postgres. A draft can also be submitted in the field database alone,
// for example when Postgres is restored to just before Submit committed (docs/plans/S8/S8-3.md),
// and a SQL migration cannot read Firestore. This command checks that half: for each job in status
// draft, exported from Postgres by the owner, it reads the job's current draft in Firestore and lists
// every job whose draft is `submitted`. Which job keeps a draft and how a stuck job moves on stay the
// owner's decisions, made before 0016 runs (docs/runbook/migrations.md, "Before 0016_job_drafts").
//
//   npm run platform:check-draft-states -- --project dryscope --database dryscope-field-test < draft-jobs.csv
//
// The input is the CSV the runbook's query writes: company id, job id, current draft id, one job per
// line. It runs with the person's own Google credentials (`gcloud auth application-default login`),
// reads only, and prints company and job ids and counts, never field data. It exits 1 when any job
// is stuck, so 0016 waits.
import { pathToFileURL } from 'node:url';
import { parseTargetArgs } from './target-args';

export type CheckOptions = { project: string; database: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseCheckArgs(argv: string[]): CheckOptions {
  return parseTargetArgs(argv);
}

export type DraftJob = { companyId: string; jobId: string; draftId: string };

// The runbook query's CSV: three uuids per line. Blank lines are skipped; anything else stops the
// check, so a truncated or wrong export is never read as "no stuck jobs".
export function parseDraftJobs(text: string): DraftJob[] {
  const jobs: DraftJob[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const fields = line.split(',');
    if (fields.length !== 3 || !fields.every((field) => UUID.test(field))) {
      throw new Error(`line ${index + 1} is not "company id,job id,current draft id"`);
    }
    const [companyId, jobId, draftId] = fields as [string, string, string];
    jobs.push({ companyId, jobId, draftId });
  }
  return jobs;
}

// The `state` of each draft, by "company/draft", or undefined for a draft that is not there.
export type DraftStateReader = (drafts: { companyId: string; draftId: string }[]) => Promise<Map<string, unknown>>;

export type CheckResult = { checked: number; stuck: DraftJob[]; missing: number };

export async function checkDraftStates(jobs: DraftJob[], read: DraftStateReader, log: (line: string) => void): Promise<CheckResult> {
  const states = jobs.length === 0 ? new Map<string, unknown>() : await read(jobs.map(({ companyId, draftId }) => ({ companyId, draftId })));
  const stuck: DraftJob[] = [];
  let missing = 0;
  for (const job of jobs) {
    const state = states.get(`${job.companyId}/${job.draftId}`);
    if (state === undefined) missing++;
    else if (state === 'submitted') {
      stuck.push(job);
      log(`stuck: ${job.companyId}/${job.jobId} is in status draft on a submitted draft`);
    }
  }
  log(`checked ${jobs.length} jobs in status draft: ${stuck.length} on a submitted draft, ${missing} with no draft in the field database.`);
  log(stuck.length === 0 ? 'nothing stops 0016 here.' : 'the owner settles these jobs before 0016 runs.');
  return { checked: jobs.length, stuck, missing };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const options = parseCheckArgs(process.argv.slice(2));
  const jobs = parseDraftJobs(await readStdin());
  const { initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const db = getFirestore(initializeApp({ projectId: options.project }, 'dryscope-check-draft-states'), options.database);
  const read: DraftStateReader = async (drafts) => {
    const states = new Map<string, unknown>();
    // getAll reads up to 100 documents per call here, and reads only.
    for (let start = 0; start < drafts.length; start += 100) {
      const refs = drafts.slice(start, start + 100).map(({ companyId, draftId }) => db.collection('companies').doc(companyId).collection('drafts').doc(draftId));
      for (const snapshot of await db.getAll(...refs)) {
        if (snapshot.exists) states.set(`${snapshot.ref.parent.parent!.id}/${snapshot.id}`, snapshot.get('state'));
      }
    }
    return states;
  };
  const result = await checkDraftStates(jobs, read, (line) => console.log(line));
  if (result.stuck.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Fixed text and our own messages only: the SDK's message may quote a path.
    console.error(error instanceof Error && !/firestore|grpc/i.test(error.message) ? error.message : 'checking the drafts failed');
    process.exit(1);
  });
}
